import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTimeout } from '../../browser/helpers.js';
import { DriverError, type ChatMessageInput } from '../types.js';
import { commentToChat, liveComments, parseGraphTime, type LiveCommentsOptions } from './comments.js';
import { GraphClient } from './graph.js';
import { SseParser, type SseEvent } from './sse.js';
import { graphErr, json, stubFetch } from './test-utils.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const STREAM = [
  '﻿: ping\r\n',
  '\r\n',
  'data: {"id":"c1","message":"Hello 👋","created_time":"2026-10-11T18:04:05+0000","from":{"id":"1","name":"Ana"}}\r\n',
  '\r\n',
  'event: comment\n',
  'id: 42\n',
  'data: {"id":"c2",\n',
  'data: "message":"line two"}\n',
  '\n',
  ': ping\r',
  '\r',
  'data:{"id":"c3","message":"no from"}\r',
  '\r',
  'retry: 1000\n',
  'data: incomplete event is dropped at the end',
].join('');

const EXPECTED: SseEvent[] = [
  {
    event: 'message',
    data: '{"id":"c1","message":"Hello 👋","created_time":"2026-10-11T18:04:05+0000","from":{"id":"1","name":"Ana"}}',
    id: null,
  },
  { event: 'comment', data: '{"id":"c2",\n"message":"line two"}', id: '42' },
  { event: 'message', data: '{"id":"c3","message":"no from"}', id: '42' },
];

function parseChunks(chunks: string[]): SseEvent[] {
  const p = new SseParser();
  const out: SseEvent[] = [];
  for (const c of chunks) out.push(...p.push(c));
  out.push(...p.end());
  return out;
}

describe('SseParser', () => {
  it('parses a whole stream', () => {
    expect(parseChunks([STREAM])).toEqual(EXPECTED);
  });

  it('gives the same events for every two-chunk split (incl. inside CRLF and multi-byte text)', () => {
    for (let i = 0; i <= STREAM.length; i++) {
      expect(parseChunks([STREAM.slice(0, i), STREAM.slice(i)])).toEqual(EXPECTED);
    }
  });

  it('handles one character at a time', () => {
    expect(parseChunks([...STREAM])).toEqual(EXPECTED);
  });
});

describe('comment parsing', () => {
  it('converts Graph comments to chat messages', () => {
    expect(parseGraphTime('2026-10-11T18:04:05+0000')).toBe('2026-10-11T18:04:05.000Z');
    expect(parseGraphTime('nope')).toBeUndefined();
    expect(commentToChat({ id: 'c1', message: ' hi ', created_time: '2026-10-11T18:04:05+0000', from: { id: '9', name: 'Ana' } })).toEqual({
      id: 'c1',
      author: { name: 'Ana' },
      text: 'hi',
      ts: '2026-10-11T18:04:05.000Z',
    });
    expect(commentToChat({ id: 'c2', message: 'anon' })).toEqual({ id: 'c2', author: { name: 'Facebook user' }, text: 'anon' });
    expect(commentToChat({ id: 'c3', message: '   ', from: { name: 'X' } })).toBeNull();
  });
});

/** SSE response whose body errors when the request signal aborts (like a real fetch). */
function sseResponse(chunks: string[], signal: AbortSignal | null | undefined, opts: { keepOpen?: boolean } = {}): Response {
  const enc = new TextEncoder();
  const bytes = chunks.map((c) => enc.encode(c));
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
    async pull(controller) {
      const next = bytes[i++];
      if (next) controller.enqueue(next);
      else if (!opts.keepOpen) controller.close();
      else await new Promise(() => {}); // never sends again
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

function options(over: Partial<LiveCommentsOptions> = {}): LiveCommentsOptions {
  return {
    graph: new GraphClient({ host: 'https://graph.test', appSecret: 'sek' }),
    liveVideoId: '5555',
    token: 'PAGE-TOKEN',
    log: pino({ level: 'silent' }),
    streamingHost: 'https://stream.test',
    pollMs: 20,
    ...over,
  };
}

async function collect(iter: AsyncIterable<ChatMessageInput>, n: number, ms = 3000): Promise<ChatMessageInput[]> {
  const it = iter[Symbol.asyncIterator]();
  const out: ChatMessageInput[] = [];
  while (out.length < n) {
    const r = await withTimeout(it.next(), ms, 'no message');
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

describe('liveComments', () => {
  it('streams comments over SSE with chunks split anywhere and ends with the stream', async () => {
    // Split bytes inside JSON, inside the emoji (UTF-8 multi-byte) and between CR and LF.
    const raw = new TextEncoder().encode(STREAM);
    const pieces: Uint8Array[] = [];
    for (let i = 0; i < raw.length; i += 7) pieces.push(raw.slice(i, i + 7));
    const calls = stubFetch(() => {
      let i = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          const p = pieces[i++];
          if (p) c.enqueue(p);
          else c.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const ac = new AbortController();
    const msgs = await collect(liveComments(options(), ac.signal), 10);
    expect(msgs).toEqual([
      { id: 'c1', author: { name: 'Ana' }, text: 'Hello 👋', ts: '2026-10-11T18:04:05.000Z' },
      { id: 'c2', author: { name: 'Facebook user' }, text: 'line two' },
      { id: 'c3', author: { name: 'Facebook user' }, text: 'no from' },
    ]);
    expect(calls).toHaveLength(1);
    const url = calls[0]!.url;
    expect(`${url.origin}${url.pathname}`).toBe('https://stream.test/5555/live_comments');
    expect(url.searchParams.get('access_token')).toBe('PAGE-TOKEN');
    expect(url.searchParams.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('comment_rate')).toBe('ten_per_second');
    expect(url.searchParams.get('fields')).toBe('id,from{id,name},message,created_time');
  });

  it('stops promptly when aborted', async () => {
    stubFetch((_call, init) => sseResponse(['data: {"id":"a","message":"first"}\n\n'], init?.signal, { keepOpen: true }));
    const ac = new AbortController();
    const it = liveComments(options(), ac.signal)[Symbol.asyncIterator]();
    expect((await withTimeout(it.next(), 2000, 'no message')).value).toMatchObject({ text: 'first' });
    const pending = it.next();
    setTimeout(() => ac.abort(), 50);
    expect((await withTimeout(pending, 2000, 'did not stop')).done).toBe(true);
  });

  it('reconnects (ends) when the stream stalls', async () => {
    stubFetch((_call, init) => sseResponse([': ping\n'], init?.signal, { keepOpen: true }));
    const ac = new AbortController();
    const it = liveComments(options({ idleMs: 100 }), ac.signal)[Symbol.asyncIterator]();
    expect((await withTimeout(it.next(), 2000, 'did not end')).done).toBe(true);
  });

  it('falls back to polling when the stream is refused, yielding new comments in order', async () => {
    let poll = 0;
    const calls = stubFetch((call) => {
      if (call.url.host === 'stream.test') return graphErr(400, 100, 'Unsupported get request');
      poll += 1;
      const data =
        poll === 1
          ? [
              { id: 'b', message: 'second', from: { name: 'B' } },
              { id: 'a', message: 'first', from: { name: 'A' } },
            ]
          : poll === 2
            ? graphErr(500, 2, 'temporary')
            : [
                { id: 'c', message: 'third' },
                { id: 'b', message: 'second', from: { name: 'B' } },
              ];
      return data instanceof Response ? data : json(200, { data });
    });
    const ac = new AbortController();
    const msgs = await collect(liveComments(options(), ac.signal), 3);
    ac.abort();
    expect(msgs.map((m) => `${m.author.name}:${m.text}`)).toEqual(['A:first', 'B:second', 'Facebook user:third']);
    const pollCall = calls.find((c) => c.url.host === 'graph.test')!;
    expect(pollCall.url.pathname).toBe('/v26.0/5555/comments');
    expect(pollCall.url.searchParams.get('order')).toBe('reverse_chronological');
  });

  it('throws needs-login for an invalid token', async () => {
    stubFetch(() => graphErr(400, 190, 'Error validating access token'));
    const err = await liveComments(options(), new AbortController().signal)
      [Symbol.asyncIterator]()
      .next()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('needs-login');
  });

  it('throws on a fatal error payload inside the stream', async () => {
    stubFetch((_call, init) => sseResponse(['data: {"error":{"message":"Permissions error","code":200}}\n\n'], init?.signal));
    const err = await liveComments(options(), new AbortController().signal)
      [Symbol.asyncIterator]()
      .next()
      .catch((e: unknown) => e);
    expect((err as DriverError).code).toBe('misconfigured');
  });
});
