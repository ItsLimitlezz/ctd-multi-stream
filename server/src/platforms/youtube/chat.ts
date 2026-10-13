// YouTube live chat (read-only).
//
// Primary: `liveChatMessages.streamList`, the server-streaming method, over plain HTTPS
// (REST mapping `GET youtube.googleapis.com/youtube/v3/liveChat/messages/stream`, found in the
// discovery document). Google's REST transcoding sends a server stream as one long-lived JSON
// array whose elements are LiveChatMessageListResponse pages; one connection costs one call of
// quota instead of one per poll.
//   https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList
//   https://developers.google.com/youtube/v3/live/streaming-live-chat
// Fallback (endpoint unavailable or unparseable): poll `liveChatMessages.list` honoring
// pollingIntervalMillis, never faster than every 8 s, slower when the chat is quiet or when
// several YouTube chats share the developer app's daily quota.
//   https://developers.google.com/youtube/v3/live/docs/liveChatMessages/list

import type { Logger } from 'pino';
import { DriverError, type ChatMessageInput } from '../types.js';
import {
  apiError,
  QUOTA_REASONS,
  RATE_REASONS,
  YouTubeApiError,
  type LiveChatMessage,
  type LiveChatPage,
  type YouTubeClient,
} from './api.js';

export interface ChatTimings {
  /** Minimum gap between chat requests (polls or stream connections). */
  minGapMs: number;
  /** Poll gap reached after a run of empty polls (before multiplying by the number of pollers). */
  quietGapMs: number;
  /** Reconnect a stream that delivered nothing for this long. */
  streamIdleMs: number;
  quotaWaitMs: number;
  rateLimitWaitMs: number;
  /** Pause after a problem the user must fix (login, chat turned off). */
  pauseMs: number;
  /** Clock-skew tolerance when skipping messages older than the live. */
  skewMs: number;
}

export const DEFAULT_CHAT_TIMINGS: ChatTimings = {
  minGapMs: 8_000,
  quietGapMs: 20_000,
  streamIdleMs: 90_000,
  quotaWaitMs: 15 * 60_000,
  rateLimitWaitMs: 30_000,
  pauseMs: 5 * 60_000,
  skewMs: 30_000,
};

/** Consecutive streaming failures (without data) before we poll instead, for this live. */
const STREAM_FAILURES_BEFORE_POLLING = 3;
/** Statuses meaning the streaming REST endpoint (or the request shape) isn't usable. */
const STREAM_UNAVAILABLE = [400, 404, 405, 406, 415, 501];
const MAX_PENDING_CHARS = 4 * 1024 * 1024;

export interface ChatSourceDeps {
  client: YouTubeClient;
  /** snippet.liveChatId of the broadcast; null when the broadcast has no chat. */
  liveChatId: (signal: AbortSignal) => Promise<string | null>;
  /** Epoch ms when the live was prepared: older messages are backlog and skipped. */
  since: number;
  log: Logger;
  timings?: Partial<ChatTimings>;
}

/** Survives source restarts by the ChatHub, so a restart resumes instead of replaying. */
interface ChatState {
  mode: 'stream' | 'poll';
  liveChatId: string | null;
  pageToken: string | null;
  lastRequestAt: number;
  nextGapMs: number;
  emptyPolls: number;
  streamFailures: number;
  /** The streaming endpoint has delivered at least one page for this live. */
  streamWorks: boolean;
  lastSeenMs: number;
}

/** Chats currently polling: they share one developer-app quota, so each polls proportionally slower. */
const pollers = new Set<ChatState>();

class ChatEnded extends Error {}
class StreamUnusable extends Error {}

export function createChatSource(deps: ChatSourceDeps): (signal: AbortSignal) => AsyncIterable<ChatMessageInput> {
  const t: ChatTimings = { ...DEFAULT_CHAT_TIMINGS, ...deps.timings };
  const state: ChatState = {
    mode: 'stream',
    liveChatId: null,
    pageToken: null,
    lastRequestAt: 0,
    nextGapMs: t.minGapMs,
    emptyPolls: 0,
    streamFailures: 0,
    streamWorks: false,
    lastSeenMs: 0,
  };
  return (signal) => runChat(deps, t, state, signal);
}

async function* runChat(
  deps: ChatSourceDeps,
  t: ChatTimings,
  state: ChatState,
  signal: AbortSignal,
): AsyncGenerator<ChatMessageInput> {
  state.liveChatId ??= await deps.liveChatId(signal);
  const liveChatId = state.liveChatId;
  if (!liveChatId) {
    deps.log.info('YouTube broadcast has no live chat');
    await untilAborted(signal);
    return;
  }
  try {
    while (!signal.aborted) {
      try {
        if (state.mode === 'stream') {
          yield* streamOnce(deps, t, state, liveChatId, signal);
        } else {
          pollers.add(state);
          yield* pollOnce(deps, t, state, liveChatId, signal);
        }
      } catch (err) {
        if (signal.aborted) return;
        const next = recover(err, deps.log, t, state);
        if (next === 'ended') {
          pollers.delete(state);
          await untilAborted(signal);
          return;
        }
        await sleep(next, signal);
      }
    }
  } finally {
    pollers.delete(state);
  }
}

/** Decide what to do after a failed request: wait (ms), stop for good, or rethrow (ChatHub backoff). */
function recover(err: unknown, log: Logger, t: ChatTimings, state: ChatState): number | 'ended' {
  if (err instanceof ChatEnded) {
    log.info('YouTube live chat ended');
    return 'ended';
  }
  if (err instanceof YouTubeApiError) {
    if (err.has('liveChatEnded')) {
      log.info('YouTube live chat ended');
      return 'ended';
    }
    if (err.has('liveChatDisabled', 'forbidden')) {
      // Chat turned off in YouTube Studio (it may be turned back on) or not readable by this account.
      log.info({ retryInMs: t.pauseMs }, 'YouTube live chat is turned off or not readable; checking again later');
      return t.pauseMs;
    }
    if (err.has(...QUOTA_REASONS)) {
      log.warn({ retryInMs: t.quotaWaitMs }, 'YouTube API daily quota used up; chat paused');
      return t.quotaWaitMs;
    }
    if (err.has(...RATE_REASONS)) {
      state.nextGapMs = Math.min(state.nextGapMs * 2, 5 * t.quietGapMs);
      log.warn({ retryInMs: t.rateLimitWaitMs }, 'YouTube chat rate-limited; slowing down');
      return t.rateLimitWaitMs;
    }
    if (state.mode === 'stream' && STREAM_UNAVAILABLE.includes(err.status) && !err.has('liveChatNotFound')) {
      // Never worked: the REST mapping isn't available. Worked before: maybe a stale page token.
      if (!state.streamWorks) return switchToPolling(state, log, `HTTP ${err.status}`);
      state.pageToken = null;
      state.streamFailures += 1;
      return state.streamFailures >= STREAM_FAILURES_BEFORE_POLLING ? switchToPolling(state, log, `HTTP ${err.status}`) : 0;
    }
  }
  if (err instanceof DriverError && ['needs-login', 'not-connected', 'misconfigured'].includes(err.code)) {
    log.warn({ error: err.message, retryInMs: t.pauseMs }, 'YouTube chat paused');
    return t.pauseMs;
  }
  if (state.mode === 'stream' && !(err instanceof YouTubeApiError)) {
    // Wire-format or connection problems specific to the streaming endpoint.
    state.streamFailures += 1;
    if (err instanceof StreamUnusable || state.streamFailures >= STREAM_FAILURES_BEFORE_POLLING) {
      return switchToPolling(state, log, err instanceof Error ? err.message : 'stream failed');
    }
  }
  throw err;
}

function switchToPolling(state: ChatState, log: Logger, reason: string): number {
  log.info({ reason }, 'YouTube streaming chat unavailable; polling instead');
  state.mode = 'poll';
  state.pageToken = null; // stream page tokens are not guaranteed to work with list
  return 0;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

async function* streamOnce(
  deps: ChatSourceDeps,
  t: ChatTimings,
  state: ChatState,
  liveChatId: string,
  signal: AbortSignal,
): AsyncGenerator<ChatMessageInput> {
  await sleep(state.lastRequestAt + t.minGapMs - Date.now(), signal);
  if (signal.aborted) return;
  state.lastRequestAt = Date.now();
  const floor = backlogFloor(deps, t, state);

  let pages = 0;
  let idle = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const ctl = new AbortController();
  // Aborting the request errors the body; cancelling the reader also settles a pending read().
  const stop = (): void => {
    ctl.abort();
    reader?.cancel().catch(() => {});
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      idle = true;
      stop();
    }, t.streamIdleMs);
  };
  signal.addEventListener('abort', stop, { once: true });

  try {
    arm();
    const res = await deps.client.openChatStream(liveChatId, state.pageToken, ctl.signal);
    const type = res.headers.get('content-type') ?? '';
    if (!res.body || /text\/html/i.test(type)) throw new StreamUnusable(`unexpected response (${type || 'no body'})`);
    const parser: ValueParser = /event-stream/i.test(type) ? new SseJsonParser() : new JsonStreamParser();
    const decoder = new TextDecoder();
    reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) return;
      if (idle) break;
      const values = done ? [...parser.push(decoder.decode()), ...parser.end()] : parser.push(decoder.decode(value, { stream: true }));
      for (const page of values) {
        pages += 1;
        state.streamFailures = 0;
        state.streamWorks = true;
        yield* pageMessages(page, floor, state);
      }
      if (done) break;
      arm();
    }
  } catch (err) {
    if (signal.aborted) return;
    if (!idle) throw err;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    stop(); // close the connection if it is still open
  }
  // Until the endpoint has delivered at least once, silence counts as a failure (e.g. a
  // non-incremental response). Afterwards an idle or closed stream just reconnects from the page token.
  if (pages === 0 && !state.streamWorks) throw new Error(idle ? 'chat stream sent no data' : 'chat stream closed without data');
  if (idle) deps.log.debug('YouTube chat stream idle; reconnecting');
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

async function* pollOnce(
  deps: ChatSourceDeps,
  t: ChatTimings,
  state: ChatState,
  liveChatId: string,
  signal: AbortSignal,
): AsyncGenerator<ChatMessageInput> {
  await sleep(state.lastRequestAt + state.nextGapMs - Date.now(), signal);
  if (signal.aborted) return;
  state.lastRequestAt = Date.now();
  const floor = backlogFloor(deps, t, state);
  const page = await deps.client.listChat(liveChatId, state.pageToken, signal);
  let count = 0;
  for (const msg of pageMessages(page ?? {}, floor, state)) {
    count += 1;
    yield msg;
  }
  state.emptyPolls = count > 0 ? 0 : state.emptyPolls + 1;
  state.nextGapMs = pollGapMs(page?.pollingIntervalMillis, state.emptyPolls, pollers.size, t);
}

/**
 * Gap before the next poll: pollingIntervalMillis but at least `minGapMs`, stretched up to
 * `quietGapMs` while the chat is quiet, times the number of chats sharing the quota.
 */
export function pollGapMs(pollingIntervalMillis: number | undefined, emptyPolls: number, activePollers: number, t: ChatTimings): number {
  const suggested = typeof pollingIntervalMillis === 'number' && Number.isFinite(pollingIntervalMillis) ? pollingIntervalMillis : 0;
  const base = Math.max(t.minGapMs, suggested);
  const quiet = Math.min(Math.max(base, t.quietGapMs), base + emptyPolls * (t.minGapMs / 4));
  return Math.round(quiet * Math.max(1, activePollers));
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Messages older than this are skipped. Without a page token the API replays recent history. */
function backlogFloor(deps: ChatSourceDeps, t: ChatTimings, state: ChatState): number {
  const since = deps.since - t.skewMs;
  return state.pageToken === null ? Math.max(since, state.lastSeenMs) : since;
}

function* pageMessages(value: unknown, floor: number, state: ChatState): Generator<ChatMessageInput> {
  if (!value || typeof value !== 'object') return;
  const raw = value as LiveChatPage & { error?: { code?: unknown } };
  if (raw.error) {
    // An error sent inside the stream (REST transcoding of a gRPC status).
    const status = typeof raw.error.code === 'number' ? raw.error.code : 500;
    throw apiError(status, JSON.stringify(raw), 'reading chat');
  }
  if (typeof raw.nextPageToken === 'string' && raw.nextPageToken) state.pageToken = raw.nextPageToken;
  for (const item of Array.isArray(raw.items) ? raw.items : []) {
    if (item?.snippet?.type === 'chatEndedEvent') throw new ChatEnded();
    const ms = Date.parse(item?.snippet?.publishedAt ?? '');
    if (Number.isFinite(ms)) {
      if (ms < floor) continue;
      state.lastSeenMs = Math.max(state.lastSeenMs, ms);
    }
    const msg = toChatMessage(item);
    if (msg) yield msg;
  }
}

function badgesOf(a: NonNullable<LiveChatMessage['authorDetails']>): string[] {
  const badges: string[] = [];
  if (a.isChatOwner) badges.push('owner');
  if (a.isChatModerator) badges.push('moderator');
  if (a.isChatSponsor) badges.push('member');
  if (a.isVerified) badges.push('verified');
  return badges;
}

function withComment(head: string, comment: string | undefined): string {
  const c = comment?.trim();
  return c ? `${head}: ${c}` : head;
}

function textOf(s: NonNullable<LiveChatMessage['snippet']>): { text: string; kind: 'message' | 'event' } | null {
  const event = (text: string) => ({ text, kind: 'event' as const });
  switch (s.type) {
    case 'textMessageEvent': {
      const text = s.textMessageDetails?.messageText ?? s.displayMessage;
      return text ? { text, kind: 'message' } : null;
    }
    case 'superChatEvent': {
      const d = s.superChatDetails;
      return event(withComment(`Super Chat ${d?.amountDisplayString ?? ''}`.trim(), d?.userComment));
    }
    case 'superStickerEvent': {
      const d = s.superStickerDetails;
      return event(withComment(`Super Sticker ${d?.amountDisplayString ?? ''}`.trim(), d?.superStickerMetadata?.altText));
    }
    case 'newSponsorEvent': {
      const d = s.newSponsorDetails;
      const level = d?.memberLevelName?.trim();
      return event(d?.isUpgrade ? `Upgraded membership${level ? ` to ${level}` : ''}` : `New member${level ? ` (${level})` : ''}`);
    }
    case 'memberMilestoneChatEvent': {
      const d = s.memberMilestoneChatDetails;
      const months = d?.memberMonth;
      return event(withComment(months ? `Member for ${months} months` : 'Membership milestone', d?.userComment));
    }
    case 'membershipGiftingEvent': {
      const n = s.membershipGiftingDetails?.giftMembershipsCount ?? 1;
      return event(`Gifted ${n} membership${n === 1 ? '' : 's'}`);
    }
    case 'giftEvent': {
      const g = s.giftEventDetails?.giftMetadata;
      const combo = g?.comboCount ?? 1;
      return event(`Sent ${g?.giftName ?? g?.altText ?? 'a gift'}${combo > 1 ? ` ×${combo}` : ''}`);
    }
    default:
      // Tombstones, bans, polls, members-only mode changes, per-recipient gift receipts.
      return null;
  }
}

/** Map one liveChatMessage to a ChatMessageInput (null for types we don't show). */
export function toChatMessage(item: LiveChatMessage | null | undefined): ChatMessageInput | null {
  const s = item?.snippet;
  if (!item?.id || !s) return null;
  const content = textOf(s);
  if (!content) return null;
  const a = item.authorDetails ?? {};
  const author: ChatMessageInput['author'] = { name: a.displayName?.trim() || 'YouTube user' };
  if (a.profileImageUrl) author.avatarUrl = a.profileImageUrl;
  const badges = badgesOf(a);
  if (badges.length > 0) author.badges = badges;
  const msg: ChatMessageInput = { id: item.id, author, text: content.text, kind: content.kind };
  if (s.publishedAt) msg.ts = s.publishedAt;
  return msg;
}

// ---------------------------------------------------------------------------
// Incremental parsers for the streamed body
// ---------------------------------------------------------------------------

interface ValueParser {
  push(text: string): unknown[];
  /** Call once the body ended; returns any final values. */
  end(): unknown[];
}

const SEPARATORS = new Set([' ', '\t', '\n', '\r', ',', '[', ']', ')', '}', "'"]);

/**
 * Splits a streamed JSON array of objects (`[{...}\n,{...}]`) into values as each one completes.
 * Also accepts a single object or concatenated objects, and ignores an XSSI prefix (`)]}'`).
 */
export class JsonStreamParser implements ValueParser {
  private buf = '';
  private pos = 0;
  private start = -1;
  private depth = 0;
  private inString = false;
  private escaped = false;

  push(text: string): unknown[] {
    this.buf += text;
    const out: unknown[] = [];
    for (; this.pos < this.buf.length; this.pos++) {
      const ch = this.buf[this.pos];
      if (this.start < 0) {
        if (ch === '{') {
          this.start = this.pos;
          this.depth = 1;
        } else if (!SEPARATORS.has(ch ?? '')) {
          throw new Error('Unexpected data in chat stream');
        }
        continue;
      }
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (ch === '\\') this.escaped = true;
        else if (ch === '"') this.inString = false;
      } else if (ch === '"') {
        this.inString = true;
      } else if (ch === '{' || ch === '[') {
        this.depth += 1;
      } else if (ch === '}' || ch === ']') {
        this.depth -= 1;
        if (this.depth === 0) {
          out.push(JSON.parse(this.buf.slice(this.start, this.pos + 1)));
          this.start = -1;
        }
      }
    }
    const keepFrom = this.start < 0 ? this.pos : this.start;
    this.buf = this.buf.slice(keepFrom);
    this.pos -= keepFrom;
    if (this.start >= 0) this.start = 0;
    if (this.buf.length > MAX_PENDING_CHARS) throw new Error('Chat stream message too large');
    return out;
  }

  end(): unknown[] {
    if (this.start >= 0) throw new Error('Chat stream ended in the middle of a message');
    return [];
  }
}

/** Server-sent events whose `data:` payloads are JSON (in case Google answers with text/event-stream). */
export class SseJsonParser implements ValueParser {
  private buf = '';
  private data: string[] = [];

  push(text: string): unknown[] {
    this.buf += text;
    const out: unknown[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      if (line === '') this.dispatch(out);
      else if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
    }
    if (this.buf.length > MAX_PENDING_CHARS) throw new Error('Chat stream message too large');
    return out;
  }

  end(): unknown[] {
    const out: unknown[] = [];
    if (this.buf.startsWith('data:')) this.data.push(this.buf.slice(5).replace(/^ /, ''));
    this.buf = '';
    this.dispatch(out);
    return out;
  }

  private dispatch(out: unknown[]): void {
    if (this.data.length === 0) return;
    const payload = this.data.join('\n');
    this.data = [];
    if (payload.trim()) out.push(JSON.parse(payload));
  }
}

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

/** Sleep that ends early (without throwing) when the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}
