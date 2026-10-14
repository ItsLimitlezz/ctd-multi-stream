import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WsServerMessage } from '@shared/api';
import type { Account, ChatMessage, DestinationState, FeedState, SessionState } from '@shared/types';
import {
  CHAT_LIMIT,
  initialLiveState,
  LiveConnection,
  LiveStore,
  mergeChat,
  parseServerMessage,
  reconnectDelay,
  reduceLive,
  type SocketLike,
} from './live-store';

const feed = (f: 'landscape' | 'vertical', online = false): FeedState => ({
  feed: f,
  online,
  since: null,
  video: null,
  audio: null,
  bitrateKbps: null,
});

const session = (over: Partial<SessionState> = {}): SessionState => ({
  status: 'offline',
  sessionId: null,
  startedAt: null,
  title: 'Hello',
  autoGoLive: true,
  feeds: [feed('landscape'), feed('vertical')],
  destinations: [],
  ...over,
});

const destState = (id: string, phase: DestinationState['phase'] = 'idle'): DestinationState => ({
  destinationId: id,
  phase,
  message: null,
  stats: null,
  watchUrl: null,
  retries: 0,
  since: '2026-10-11T10:00:00.000Z',
  recoveries: 0,
  lastRecovery: null,
});

let seq = 0;
const chat = (id: string, ts = `2026-10-11T10:00:${String(seq++ % 60).padStart(2, '0')}.000Z`): ChatMessage => ({
  id,
  platform: 'twitch',
  destinationId: 'd1',
  author: { name: 'viewer' },
  text: `msg ${id}`,
  ts,
  kind: 'message',
});

const account = (id: string): Account => ({
  id,
  platform: 'twitch',
  label: 'Main',
  status: 'connected',
  statusMessage: null,
  options: {},
  createdAt: '2026-10-11T10:00:00.000Z',
  updatedAt: '2026-10-11T10:00:00.000Z',
});

describe('parseServerMessage', () => {
  it('accepts known message types', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'session', session: session() }))?.type).toBe('session');
    expect(parseServerMessage(JSON.stringify({ type: 'destinations-changed' }))?.type).toBe('destinations-changed');
    expect(parseServerMessage(JSON.stringify({ type: 'notice', level: 'warn', message: 'x' }))?.type).toBe('notice');
  });

  it('rejects malformed or unknown frames', () => {
    expect(parseServerMessage('not json')).toBeNull();
    expect(parseServerMessage(42)).toBeNull();
    expect(parseServerMessage(JSON.stringify([1, 2]))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'nope' }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'hello', session: session() }))).toBeNull(); // chat missing
    expect(parseServerMessage(JSON.stringify({ type: 'chat', message: 'text' }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'notice', level: 'info' }))).toBeNull();
  });
});

describe('mergeChat', () => {
  it('appends new messages and ignores duplicates', () => {
    const a = chat('a');
    const b = chat('b');
    const list = mergeChat([a], [a, b]);
    expect(list.map((m) => m.id)).toEqual(['a', 'b']);
    expect(mergeChat(list, [b])).toBe(list); // unchanged reference when nothing new
  });

  it('keeps chronological order when older history arrives', () => {
    const late = chat('late', '2026-10-11T10:05:00.000Z');
    const early = chat('early', '2026-10-11T10:01:00.000Z');
    expect(mergeChat([late], [early]).map((m) => m.id)).toEqual(['early', 'late']);
  });

  it('caps the list, dropping the oldest', () => {
    const many = Array.from({ length: CHAT_LIMIT + 20 }, (_, i) => chat(`m${i}`, new Date(Date.UTC(2026, 9, 11, 10, 0, i)).toISOString()));
    const list = mergeChat([], many);
    expect(list).toHaveLength(CHAT_LIMIT);
    expect(list[0]?.id).toBe('m20');
    expect(list[list.length - 1]?.id).toBe(`m${CHAT_LIMIT + 19}`);
  });
});

describe('reduceLive', () => {
  it('hello sets session and chat; only reconnects bump versions', () => {
    const hello: WsServerMessage = { type: 'hello', session: session(), chat: [chat('a')] };
    const s1 = reduceLive(initialLiveState, hello);
    expect(s1.session?.title).toBe('Hello');
    expect(s1.chat).toHaveLength(1);
    expect(s1.connections).toBe(1);
    expect(s1.destinationsVersion).toBe(0);
    expect(s1.accountsVersion).toBe(0);
    const s2 = reduceLive(s1, { type: 'hello', session: session({ title: 'Again' }), chat: [chat('a'), chat('b')] });
    expect(s2.connections).toBe(2);
    expect(s2.destinationsVersion).toBe(1);
    expect(s2.accountsVersion).toBe(1);
    expect(s2.chat.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('merges feed and destination updates into the session', () => {
    let s = reduceLive(initialLiveState, { type: 'session', session: session({ destinations: [destState('d1')] }) });
    s = reduceLive(s, { type: 'feed', feed: feed('vertical', true) });
    expect(s.session?.feeds.find((f) => f.feed === 'vertical')?.online).toBe(true);
    expect(s.session?.feeds).toHaveLength(2);
    s = reduceLive(s, { type: 'destination', state: destState('d1', 'live') });
    s = reduceLive(s, { type: 'destination', state: destState('d2', 'preparing') });
    expect(s.session?.destinations.map((d) => [d.destinationId, d.phase])).toEqual([
      ['d1', 'live'],
      ['d2', 'preparing'],
    ]);
  });

  it('ignores feed/destination updates before the first session snapshot', () => {
    expect(reduceLive(initialLiveState, { type: 'feed', feed: feed('landscape', true) })).toBe(initialLiveState);
    expect(reduceLive(initialLiveState, { type: 'destination', state: destState('d1') })).toBe(initialLiveState);
  });

  it('tracks accounts and version counters', () => {
    let s = reduceLive(initialLiveState, { type: 'account', account: account('a1') });
    expect(s.accounts.a1?.label).toBe('Main');
    expect(s.accountsVersion).toBe(1);
    s = reduceLive(s, { type: 'destinations-changed' });
    expect(s.destinationsVersion).toBe(1);
    expect(reduceLive(s, { type: 'notice', level: 'info', message: 'hi' })).toBe(s);
  });

  it('appends chat messages', () => {
    const s = reduceLive(initialLiveState, { type: 'chat', message: chat('x') });
    expect(s.chat.map((m) => m.id)).toEqual(['x']);
    expect(reduceLive(s, { type: 'chat', message: chat('x') })).toBe(s);
  });
});

describe('LiveStore', () => {
  it('notifies subscribers and event listeners', () => {
    const store = new LiveStore();
    const changed = vi.fn();
    const events: string[] = [];
    store.subscribe(changed);
    store.onEvent((m) => events.push(m.type));
    store.dispatch({ type: 'notice', level: 'info', message: 'x' });
    expect(changed).not.toHaveBeenCalled(); // state unchanged
    store.dispatch({ type: 'destinations-changed' });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['notice', 'destinations-changed']);
  });

  it('seedSession only fills an empty session; patchSession merges', () => {
    const store = new LiveStore();
    store.seedSession(session({ title: 'rest' }));
    store.seedSession(session({ title: 'second' }));
    expect(store.getState().session?.title).toBe('rest');
    store.patchSession({ title: 'patched' });
    expect(store.getState().session?.title).toBe('patched');
    store.setConnected(true);
    expect(store.getState().connected).toBe(true);
    store.reset();
    expect(store.getState()).toBe(initialLiveState);
  });
});

// ---------------------------------------------------------------------------
// LiveConnection
// ---------------------------------------------------------------------------

class FakeSocket implements SocketLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  close(): void {
    this.closed = true;
  }
  receive(msg: unknown): void {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }
  serverClose(): void {
    this.onerror?.({});
    this.onclose?.({});
  }
}

describe('reconnectDelay', () => {
  it('backs off from 1 s to 15 s', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(reconnectDelay)).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });
});

describe('LiveConnection', () => {
  let sockets: FakeSocket[];
  const hello = { type: 'hello', session: session(), chat: [] };

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make(checkAuth?: () => Promise<boolean>) {
    const messages: WsServerMessage[] = [];
    const states: boolean[] = [];
    const conn = new LiveConnection({
      url: () => 'ws://test/api/ws',
      onMessage: (m) => messages.push(m),
      onConnectedChange: (c) => states.push(c),
      checkAuth,
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
    });
    return { conn, messages, states };
  }

  const last = () => sockets[sockets.length - 1] as FakeSocket;

  it('connects, reports hello, and reconnects after a drop', () => {
    const { conn, messages, states } = make();
    conn.start();
    expect(sockets).toHaveLength(1);
    expect(last().url).toBe('ws://test/api/ws');
    last().receive(hello);
    last().receive('garbage');
    expect(messages.map((m) => m.type)).toEqual(['hello']);
    expect(states).toEqual([true]);

    last().serverClose();
    expect(states).toEqual([true, false]);
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    conn.stop();
  });

  it('backs off while the server keeps failing and resets after hello', () => {
    const { conn } = make();
    conn.start();
    last().serverClose(); // attempt 0 -> 1 s
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    last().serverClose(); // attempt 1 -> 2 s
    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    last().receive(hello);
    last().serverClose(); // reset -> 1 s again
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(4);
    conn.stop();
  });

  it('checks auth before retrying when the upgrade never succeeded', async () => {
    const checkAuth = vi.fn(async () => false);
    const { conn } = make(checkAuth);
    conn.start();
    last().serverClose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(checkAuth).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1); // stopped: logged out
  });

  it('reconnects after a successful auth check', async () => {
    const checkAuth = vi.fn(async () => true);
    const { conn } = make(checkAuth);
    conn.start();
    last().serverClose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(checkAuth).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    // A drop after hello reconnects without an auth check.
    last().receive(hello);
    last().serverClose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(checkAuth).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(3);
    conn.stop();
  });

  it('stop() closes the socket and cancels pending reconnects', () => {
    const { conn, states } = make();
    conn.start();
    last().receive(hello);
    const first = last();
    conn.stop();
    expect(first.closed).toBe(true);
    expect(states).toEqual([true, false]);
    first.serverClose(); // late close event from the old socket is ignored
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('kick() reconnects immediately while waiting', () => {
    const { conn } = make();
    conn.start();
    last().serverClose();
    last().serverClose(); // ignored (already closed)
    expect(sockets).toHaveLength(1);
    conn.kick();
    expect(sockets).toHaveLength(2);
    conn.kick(); // connected attempt in flight: no-op
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(2);
    conn.stop();
  });
});
