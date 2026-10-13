// Live comments for Page lives: Server-Sent Events from streaming-graph.facebook.com, with a
// fallback to polling GET /{live-video-id}/comments when the stream is unavailable.
//
// Docs: https://developers.facebook.com/docs/live-video-api/interact-with-viewers
//   SSE:  GET https://streaming-graph.facebook.com/{live-video-id}/live_comments?access_token=...
//         (`: ping` keep-alives; `data:` lines carry {id, created_time, from{id,name}, message}).
//   Poll: GET /{live-video-id}/comments (reverse-chronological polling is the documented best practice).
// `comment_rate` / `fields` follow the live_comments reference (ten_per_second is one of its rates,
// one_per_two_seconds would drop messages in a busy chat).
// `from` is omitted when Meta withholds the commenter's identity (privacy) → "Facebook user".

import type { Logger } from 'pino';
import type { ChatMessageInput } from '../types.js';
import { DriverError } from '../types.js';
import { graphError, type GraphClient, STREAMING_GRAPH_HOST } from './graph.js';
import { SseParser } from './sse.js';

export const ANONYMOUS_AUTHOR = 'Facebook user';
const COMMENT_FIELDS = 'id,from{id,name},message,created_time';
const MAX_SEEN = 2000;

export interface GraphComment {
  id?: string;
  message?: string;
  created_time?: string;
  from?: { id?: string; name?: string } | null;
}

/** Graph timestamps look like 2026-10-11T18:04:05+0000; return ISO 8601 or undefined. */
export function parseGraphTime(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const d = new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function commentToChat(c: GraphComment): ChatMessageInput | null {
  const text = typeof c.message === 'string' ? c.message.trim() : '';
  if (!text) return null; // stickers / GIF-only comments have no message
  const name = typeof c.from?.name === 'string' && c.from.name.trim() ? c.from.name.trim() : ANONYMOUS_AUTHOR;
  const msg: ChatMessageInput = { author: { name }, text };
  if (typeof c.id === 'string' && c.id) msg.id = c.id;
  const ts = parseGraphTime(c.created_time);
  if (ts) msg.ts = ts;
  return msg;
}

export interface LiveCommentsOptions {
  graph: GraphClient;
  liveVideoId: string;
  /** Page access token. */
  token: string;
  log: Logger;
  streamingHost?: string;
  /** Polling fallback interval (default 4 s). */
  pollMs?: number;
  /** Reconnect when the SSE stream sends nothing (not even a ping) for this long (default 90 s). */
  idleMs?: number;
}

/**
 * Yields new comments until `signal` aborts. Ends (so the ChatHub reconnects with backoff) when the
 * SSE stream closes; switches to polling for this run when the stream can't be opened.
 * Throws DriverError('needs-login'/'misconfigured') for token/permission problems.
 */
export async function* liveComments(opts: LiveCommentsOptions, signal: AbortSignal): AsyncGenerator<ChatMessageInput> {
  const outcome = yield* streamComments(opts, signal);
  if (outcome === 'unavailable' && !signal.aborted) {
    opts.log.info({ liveVideoId: opts.liveVideoId }, 'Facebook live comment stream unavailable; polling comments instead');
    yield* pollComments(opts, signal);
  }
}

type StreamOutcome = 'ended' | 'unavailable';

function isFatal(err: DriverError): boolean {
  return err.code === 'needs-login' || err.code === 'misconfigured';
}

async function* streamComments(opts: LiveCommentsOptions, signal: AbortSignal): AsyncGenerator<ChatMessageInput, StreamOutcome> {
  const host = (opts.streamingHost ?? STREAMING_GRAPH_HOST).replace(/\/+$/, '');
  const url = new URL(`${host}/${encodeURIComponent(opts.liveVideoId)}/live_comments`);
  for (const [k, v] of Object.entries(opts.graph.authParams(opts.token))) url.searchParams.set(k, v);
  url.searchParams.set('comment_rate', 'ten_per_second');
  url.searchParams.set('fields', COMMENT_FIELDS);

  const idleMs = opts.idleMs ?? 90_000;
  const idle = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(new Error('idle')), idleMs);
  };
  arm();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  try {
    let res: Response;
    try {
      res = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: AbortSignal.any([signal, idle.signal]) });
    } catch (err) {
      if (signal.aborted) return 'ended';
      opts.log.warn({ error: err instanceof Error ? err.message : String(err) }, 'opening the Facebook comment stream failed');
      return 'unavailable';
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const mapped = graphError(res.status, body);
      if (isFatal(mapped)) throw mapped;
      opts.log.warn({ status: res.status, error: mapped.message }, 'Facebook comment stream refused');
      return 'unavailable';
    }
    const type = res.headers.get('content-type') ?? '';
    if (!res.body || !/text\/event-stream/i.test(type)) {
      await res.body?.cancel().catch(() => {});
      opts.log.warn({ contentType: type }, 'Facebook comment stream returned an unexpected response');
      return 'unavailable';
    }

    const stream = res.body.getReader();
    reader = stream;
    const parser = new SseParser();
    const decoder = new TextDecoder();
    for (;;) {
      let chunk: Awaited<ReturnType<typeof stream.read>>;
      try {
        chunk = await stream.read();
      } catch (err) {
        if (signal.aborted) return 'ended';
        const reason = idle.signal.aborted ? 'stalled' : err instanceof Error ? err.message : String(err);
        opts.log.info({ reason }, 'Facebook comment stream interrupted; reconnecting');
        return 'ended';
      }
      if (chunk.done) {
        parser.end();
        return 'ended';
      }
      arm();
      for (const ev of parser.push(decoder.decode(chunk.value, { stream: true }))) {
        const msg = parseStreamData(ev.data, opts.log);
        if (msg) yield msg;
      }
    }
  } finally {
    clearTimeout(timer);
    if (reader) await reader.cancel().catch(() => {});
  }
}

/** One SSE `data:` payload → chat message. Error payloads throw when fatal, else are logged. */
function parseStreamData(data: string, log: Logger): ChatMessageInput | null {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;
  if ('error' in json) {
    const mapped = graphError(200, data);
    if (isFatal(mapped)) throw mapped;
    log.warn({ error: mapped.message }, 'Facebook comment stream reported an error');
    return null;
  }
  return commentToChat(json as GraphComment);
}

async function* pollComments(opts: LiveCommentsOptions, signal: AbortSignal): AsyncGenerator<ChatMessageInput> {
  const baseMs = opts.pollMs ?? 4000;
  const seen = new Set<string>();
  let delayMs = baseMs;
  while (!signal.aborted) {
    try {
      const res = await opts.graph.get<{ data?: GraphComment[] }>(
        `${opts.liveVideoId}/comments`,
        opts.token,
        { fields: COMMENT_FIELDS, order: 'reverse_chronological', limit: '50' },
        signal,
      );
      const fresh = (res?.data ?? []).filter((c) => typeof c.id === 'string' && !seen.has(c.id)).reverse();
      for (const c of fresh) {
        seen.add(c.id!);
        if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value!);
        const msg = commentToChat(c);
        if (msg) yield msg;
        if (signal.aborted) return;
      }
      delayMs = baseMs;
    } catch (err) {
      if (signal.aborted) return;
      if (err instanceof DriverError && isFatal(err)) throw err;
      delayMs = Math.min(delayMs * 2, 60_000);
      opts.log.warn({ error: err instanceof Error ? err.message : String(err), retryInMs: delayMs }, 'polling Facebook comments failed');
    }
    if (!(await sleep(delayMs, signal))) return;
  }
}

/** Resolves true after `ms`, false as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(t);
      resolve(false);
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
