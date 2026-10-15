// /api/v1/events over a real socket, read with fetch streaming (like the dock and API.md's example).

import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROFILE_ID, type ChatMessage } from '../../../shared/types.js';
import { createTestApi, dstate, session, type TestApi } from './test-helpers.js';
import type { Envelope } from './types.js';
import { MAX_STREAMS_PER_TOKEN } from './v1.js';

interface Frame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
  retry?: string;
}

interface Stream {
  status: number;
  headers: Headers;
  frames: Frame[];
  envelopes: () => Envelope[];
  ended: Promise<void>;
  waitFor(pred: (frames: Frame[]) => boolean, ms?: number): Promise<void>;
  close(): void;
  body: unknown;
}

let t: TestApi;
let base: string;
let token: string;
const streams: Stream[] = [];

beforeEach(async () => {
  t = await createTestApi({ heartbeatMs: 150 });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = t.app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  token = t.token();
});

afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  await t.close();
});

function parseFrame(raw: string): Frame {
  const f: Frame = {};
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) f.comment = line.slice(1).trim();
    else if (line.startsWith('id: ')) f.id = line.slice(4);
    else if (line.startsWith('event: ')) f.event = line.slice(7);
    else if (line.startsWith('data: ')) f.data = (f.data ? `${f.data}\n` : '') + line.slice(6);
    else if (line.startsWith('retry: ')) f.retry = line.slice(7);
  }
  return f;
}

async function open(path: string, headers: Record<string, string> = {}): Promise<Stream> {
  const controller = new AbortController();
  const res = await fetch(`${base}${path}`, { headers, signal: controller.signal });
  const frames: Frame[] = [];
  let buf = '';
  const ended = (async () => {
    if (!res.ok || !res.body) return;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += value;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          frames.push(parseFrame(buf.slice(0, i)));
          buf = buf.slice(i + 2);
        }
      }
    } catch {
      // aborted
    }
  })();
  const stream: Stream = {
    status: res.status,
    headers: res.headers,
    frames,
    envelopes: () => frames.filter((f) => f.data).map((f) => JSON.parse(f.data!) as Envelope),
    ended,
    body: res.ok ? null : await res.json(),
    async waitFor(pred, ms = 3000) {
      const start = Date.now();
      while (!pred(frames)) {
        if (Date.now() - start > ms) throw new Error(`timed out; frames: ${JSON.stringify(frames)}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    close: () => controller.abort(),
  };
  streams.push(stream);
  return stream;
}

const auth = () => ({ authorization: `Bearer ${token}` });
const dataFrames = (frames: Frame[]) => frames.filter((f) => f.data);

function chat(i: number): ChatMessage {
  return { id: `twitch:${i}`, platform: 'twitch', destinationId: 'd1', author: { name: 'v' }, text: `hi ${i}`, ts: new Date().toISOString(), kind: 'message' };
}

describe('GET /api/v1/events (SSE)', () => {
  it('frames: retry once, then a snapshot (stream.status + destination.status each), then live events', async () => {
    const a = t.repos.destinations.create({ profileId: DEFAULT_PROFILE_ID, platform: 'twitch', accountId: null, name: 'Twitch', feed: 'landscape', enabled: true, options: {}, ingestUrl: null });
    const b = t.repos.destinations.create({ profileId: DEFAULT_PROFILE_ID, platform: 'kick', accountId: null, name: 'Kick', feed: 'landscape', enabled: true, options: {}, ingestUrl: null });
    t.state.current = session({ destinations: [dstate(a.id, 'live'), dstate(b.id, 'retrying')] });

    const s = await open('/api/v1/events', auth());
    expect(s.status).toBe(200);
    expect(s.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(s.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(s.headers.get('access-control-allow-origin')).toBe('*');
    expect(s.headers.get('set-cookie')).toBeNull();

    await s.waitFor((f) => dataFrames(f).length >= 3);
    expect(s.frames[0]).toEqual({ retry: '3000' });
    const snapshot = dataFrames(s.frames);
    expect(snapshot.map((f) => f.event)).toEqual(['stream.status', 'destination.status', 'destination.status']);
    for (const f of snapshot) {
      const env = JSON.parse(f.data!) as Envelope;
      expect(env.id).toBe(f.id);
      expect(env.type).toBe(f.event);
    }
    expect(JSON.parse(snapshot[2]!.data!).data).toMatchObject({ id: b.id, name: 'Kick', phase: 'retrying', down: true });

    t.bus.emit('chat', chat(1));
    await s.waitFor((f) => f.some((x) => x.event === 'chat.message'));
    const msg = s.envelopes().find((e) => e.type === 'chat.message')!;
    expect(msg.data).toMatchObject({ id: 'twitch:1', text: 'hi 1' });
    expect(s.frames.filter((f) => f.retry)).toHaveLength(1);
  });

  it('resumes after Last-Event-ID (or ?cursor=) without a snapshot', async () => {
    t.bus.emit('notice', { level: 'info', message: 'n1' });
    t.bus.emit('notice', { level: 'info', message: 'n2' });
    t.bus.emit('notice', { level: 'info', message: 'n3' });
    const first = t.hub.since(t.hub.floor).items[0]!.id;

    const s = await open('/api/v1/events', { ...auth(), 'last-event-id': first });
    await s.waitFor((f) => dataFrames(f).length >= 2);
    expect(s.envelopes().map((e) => (e.data as { message: string }).message)).toEqual(['n2', 'n3']);
    t.bus.emit('notice', { level: 'info', message: 'n4' });
    await s.waitFor((f) => dataFrames(f).length >= 3);
    expect(s.envelopes().map((e) => e.type)).toEqual(['system.notice', 'system.notice', 'system.notice']);

    const c = await open(`/api/v1/events?cursor=${first}`, auth());
    await c.waitFor((f) => dataFrames(f).length >= 3);
    expect(c.envelopes().map((e) => (e.data as { message: string }).message)).toEqual(['n2', 'n3', 'n4']);
  });

  it('sends system.reset first when the cursor is older than the buffer, then the snapshot', async () => {
    const s = await open('/api/v1/events', { ...auth(), 'last-event-id': '00000000000000000000000000' });
    await s.waitFor((f) => dataFrames(f).length >= 2);
    const envs = s.envelopes();
    expect(envs[0]).toMatchObject({ type: 'system.reset', data: {}, src: { connection: 'core', platform: 'core' } });
    expect(envs[1]!.type).toBe('stream.status');
  });

  it('rejects a malformed cursor', async () => {
    const s = await open('/api/v1/events', { ...auth(), 'last-event-id': 'not-a-ulid' });
    expect(s.status).toBe(400);
    expect(s.body).toMatchObject({ code: 'invalid' });
  });

  it('filters by types and scopes; accepts ?access_token=', async () => {
    const s = await open(`/api/v1/events?types=chat.*&access_token=${token}`);
    expect(s.status).toBe(200);
    t.bus.emit('notice', { level: 'info', message: 'filtered out' });
    t.bus.emit('chat', chat(2));
    await s.waitFor((f) => dataFrames(f).length >= 1);
    expect(s.envelopes().map((e) => e.type)).toEqual(['chat.message']);

    const statusOnly = t.token(['status:read']);
    const denied = await open('/api/v1/events?types=chat.message', { authorization: `Bearer ${statusOnly}` });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'missing_scope' });
    const unauth = await open('/api/v1/events');
    expect(unauth.status).toBe(401);
  });

  it(`allows at most ${MAX_STREAMS_PER_TOKEN} concurrent streams per token`, async () => {
    const open5 = await Promise.all(Array.from({ length: MAX_STREAMS_PER_TOKEN }, () => open('/api/v1/events', auth())));
    expect(open5.every((s) => s.status === 200)).toBe(true);
    const sixth = await open('/api/v1/events', auth());
    expect(sixth.status).toBe(429);
    expect(sixth.body).toMatchObject({ code: 'rate_limited' });
    expect(sixth.headers.get('retry-after')).toBe('30');
    // Another token has its own slots.
    const other = await open('/api/v1/events', { authorization: `Bearer ${t.token()}` });
    expect(other.status).toBe(200);

    open5[0]!.close();
    await new Promise((r) => setTimeout(r, 100));
    const again = await open('/api/v1/events', auth());
    expect(again.status).toBe(200);
  });

  it('sends `: ping` heartbeats and closes the stream once the token is revoked', async () => {
    const s = await open('/api/v1/events', auth());
    await s.waitFor((f) => f.some((x) => x.comment === 'ping'));
    t.repos.apiTokens.delete(t.repos.apiTokens.list()[0]!.id);
    await Promise.race([s.ended, new Promise((_, reject) => setTimeout(() => reject(new Error('stream not closed')), 2000))]);
  });

  it('app.close() ends open streams', async () => {
    const s = await open('/api/v1/events', auth());
    await s.waitFor((f) => f.length >= 1);
    await t.close();
    await Promise.race([s.ended, new Promise((_, reject) => setTimeout(() => reject(new Error('stream not closed')), 2000))]);
  });
});

describe('GET /api/v1/events (profiles)', () => {
  const twoProfiles = () => {
    const club = t.addProfile('DPRTMNT');
    const a = t.repos.destinations.create({ profileId: DEFAULT_PROFILE_ID, platform: 'twitch', accountId: null, name: 'Main', feed: 'landscape', enabled: true, options: {}, ingestUrl: null });
    const b = t.repos.destinations.create({ profileId: club.id, platform: 'twitch', accountId: null, name: 'Club', feed: 'landscape', enabled: true, options: {}, ingestUrl: null });
    return { club, a, b };
  };
  const chatIds = (s: Stream) => s.envelopes().filter((e) => e.type === 'chat.message').map((e) => (e.data as { id: string }).id);

  it('a token limited to a profile streams only that profile (snapshot and live events)', async () => {
    const { club, a, b } = twoProfiles();
    const limited = t.token(['chat:read', 'status:read'], 'club dock', club.id);
    const s = await open('/api/v1/events', { authorization: `Bearer ${limited}` });
    await s.waitFor((f) => dataFrames(f).length >= 2);
    expect(s.envelopes().map((e) => [e.type, e.src.profile, e.src.connection])).toEqual([
      ['stream.status', club.id, 'core'],
      ['destination.status', club.id, b.id],
    ]);
    t.bus.emit('chat', { ...chat(1), destinationId: a.id, profileId: DEFAULT_PROFILE_ID });
    t.bus.emit('chat', { ...chat(2), destinationId: b.id, profileId: club.id });
    t.bus.emit('notice', { level: 'info', message: 'for everyone' });
    await s.waitFor((f) => f.some((x) => x.event === 'system.notice'));
    expect(chatIds(s)).toEqual(['twitch:2']);

    const forbidden = await open(`/api/v1/events?profile=${DEFAULT_PROFILE_ID}`, { authorization: `Bearer ${limited}` });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toMatchObject({ code: 'profile_forbidden' });
  });

  it('an every-profile token (e.g. from before v1.2) streams the default profile without ?profile=, as before profiles existed', async () => {
    const { club, a, b } = twoProfiles();
    const old = await open('/api/v1/events', auth());
    await old.waitFor((f) => dataFrames(f).length >= 2);
    expect(old.envelopes().map((e) => [e.type, e.src.profile, e.src.connection])).toEqual([
      ['stream.status', DEFAULT_PROFILE_ID, 'core'],
      ['destination.status', DEFAULT_PROFILE_ID, a.id],
    ]);
    t.bus.emit('chat', { ...chat(1), destinationId: a.id, profileId: DEFAULT_PROFILE_ID });
    t.bus.emit('chat', { ...chat(2), destinationId: b.id, profileId: club.id });
    t.bus.emit('notice', { level: 'info', message: 'for everyone' });
    await old.waitFor((f) => f.some((x) => x.event === 'system.notice'));
    expect(chatIds(old)).toEqual(['twitch:1']);
  });

  it('an every-profile token streams every profile with ?profile=* (or all), or one with ?profile=<id>', async () => {
    const { club, a, b } = twoProfiles();
    const every = await open('/api/v1/events?profile=*', auth());
    const everyAlias = await open('/api/v1/events?profile=all', auth());
    const one = await open(`/api/v1/events?profile=${club.id}`, auth());
    await every.waitFor((f) => dataFrames(f).length >= 4);
    await everyAlias.waitFor((f) => dataFrames(f).length >= 4);
    await one.waitFor((f) => dataFrames(f).length >= 2);
    expect(every.envelopes().filter((e) => e.type === 'stream.status').map((e) => e.src.profile)).toEqual([DEFAULT_PROFILE_ID, club.id]);
    expect(everyAlias.envelopes().filter((e) => e.type === 'stream.status').map((e) => e.src.profile)).toEqual([DEFAULT_PROFILE_ID, club.id]);
    expect(one.envelopes().map((e) => e.src.profile)).toEqual([club.id, club.id]);

    t.bus.emit('chat', { ...chat(1), destinationId: a.id, profileId: DEFAULT_PROFILE_ID });
    t.bus.emit('chat', { ...chat(2), destinationId: b.id, profileId: club.id });
    await every.waitFor((f) => f.filter((x) => x.event === 'chat.message').length >= 2);
    await one.waitFor((f) => f.some((x) => x.event === 'chat.message'));
    expect(chatIds(every)).toEqual(['twitch:1', 'twitch:2']);
    expect(chatIds(one)).toEqual(['twitch:2']);

    // A token limited to a profile: `*` is everything it can see, i.e. its own profile.
    const limited = t.token(['chat:read', 'status:read'], 'club dock', club.id);
    const own = await open('/api/v1/events?profile=*', { authorization: `Bearer ${limited}` });
    await own.waitFor((f) => dataFrames(f).length >= 2);
    expect(own.envelopes().map((e) => e.src.profile)).toEqual([club.id, club.id]);

    const unknown = await open('/api/v1/events?profile=nope', auth());
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'unknown_profile' });
  });
});

describe('GET /api/v1/events (backlog, slow and departed clients)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function until(pred: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
    const start = Date.now();
    while (!(await pred())) {
      if (Date.now() - start > ms) throw new Error('condition not met in time');
      await sleep(10);
    }
  }
  const connections = () => new Promise<number>((resolve, reject) => t.app.server.getConnections((err, n) => (err ? reject(err) : resolve(n))));
  /** About 1.3 KB per chat.message frame. */
  const bigChat = (i: number): ChatMessage => ({ ...chat(i), text: `${'x'.repeat(600)} ${i}` });

  it('replays a backlog over 1 MB completely on one connection, then keeps streaming', async () => {
    const cursor = t.hub.cursor();
    for (let i = 0; i < 1990; i++) t.bus.emit('chat', bigChat(i));
    const s = await open('/api/v1/events?types=chat.*', { ...auth(), 'last-event-id': cursor });
    await s.waitFor((f) => dataFrames(f).length >= 1990, 15_000);
    const bytes = dataFrames(s.frames).reduce((n, f) => n + f.data!.length, 0);
    expect(bytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(s.envelopes().map((e) => (e.data as { id: string }).id)).toEqual(Array.from({ length: 1990 }, (_, i) => `twitch:${i}`));

    t.bus.emit('chat', bigChat(5000));
    await s.waitFor((f) => dataFrames(f).length >= 1991);
    expect(t.hub.listenerCount()).toBe(1);
  });

  it('releases the hub subscription and the heartbeat once the client is gone', async () => {
    const verify = vi.spyOn(t.repos.apiTokens, 'verify');
    const cursor = t.hub.cursor();
    for (let i = 0; i < 1990; i++) t.bus.emit('chat', bigChat(i));
    const s = await open('/api/v1/events', { ...auth(), 'last-event-id': cursor });
    await s.waitFor((f) => f.some((x) => x.comment === 'ping'), 15_000);
    expect(t.hub.listenerCount()).toBe(1);
    s.close();
    await until(() => t.hub.listenerCount() === 0);
    await until(async () => (await connections()) === 0);
    const calls = verify.mock.calls.length;
    await sleep(600); // four heartbeat periods
    expect(verify.mock.calls.length).toBe(calls);
  });

  it('drops a client that stops reading: the socket is destroyed and the slot freed', async () => {
    const addr = t.app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const sock = net.connect(port, '127.0.0.1');
    sock.on('error', () => {});
    await new Promise<void>((resolve) => sock.once('connect', () => resolve()));
    sock.pause(); // never read
    sock.write(`GET /api/v1/events?types=chat.* HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\n\r\n`);
    await until(() => t.hub.listenerCount() === 1);
    try {
      // Flood live chat until the server gives up on it (kernel buffers absorb the first few MB).
      for (let i = 0; i < 400 && t.hub.listenerCount() > 0; i++) {
        for (let j = 0; j < 100; j++) t.bus.emit('chat', bigChat(i * 100 + j));
        await sleep(2);
      }
      expect(t.hub.listenerCount()).toBe(0);
      await until(async () => (await connections()) === 0);
      // Its slot is free again: the token can open all MAX_STREAMS_PER_TOKEN streams.
      const all = await Promise.all(Array.from({ length: MAX_STREAMS_PER_TOKEN }, () => open('/api/v1/events', auth())));
      expect(all.map((s) => s.status)).toEqual(Array(MAX_STREAMS_PER_TOKEN).fill(200));
    } finally {
      sock.destroy();
    }
  });

  it('a filtered stream resumes without a reset when only events it skips left the buffer', async () => {
    t.bus.emit('chat', chat(1));
    const afterChat = t.hub.cursor();
    for (let i = 0; i < 2100; i++) t.bus.emit('notice', { level: 'info', message: `n${i}` });

    const filtered = await open('/api/v1/events?types=chat.*', { ...auth(), 'last-event-id': afterChat });
    t.bus.emit('chat', chat(2));
    await filtered.waitFor((f) => dataFrames(f).length >= 1);
    expect(filtered.envelopes().map((e) => (e.data as { id?: string }).id)).toEqual(['twitch:2']);

    const chatOnlyToken = t.token(['chat:read']); // scopes filter the same way
    const scoped = await open('/api/v1/events', { authorization: `Bearer ${chatOnlyToken}`, 'last-event-id': afterChat });
    t.bus.emit('chat', chat(3));
    await scoped.waitFor((f) => dataFrames(f).length >= 2);
    expect(scoped.envelopes().map((e) => (e.data as { id?: string }).id)).toEqual(['twitch:2', 'twitch:3']); // replay, then live

    const unfiltered = await open('/api/v1/events', { ...auth(), 'last-event-id': afterChat });
    await unfiltered.waitFor((f) => dataFrames(f).length >= 1);
    expect(unfiltered.envelopes()[0]!.type).toBe('system.reset');
  });
});
