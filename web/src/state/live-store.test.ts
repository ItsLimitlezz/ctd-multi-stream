import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WsServerMessage } from '@shared/api';
import type { Account, ChatMessage, DestinationState, FeedState, SessionState } from '@shared/types';
import type { ChatModeration } from '@shared/types';
import {
  applyModeration,
  CHAT_LIMIT,
  HELLO_CHAT_LIMIT,
  initialLiveState,
  LiveConnection,
  LiveStore,
  mergeChat,
  messageFromUser,
  parseServerMessage,
  reconcileChat,
  reconnectDelay,
  reduceLive,
  rememberRemoved,
  type LiveState,
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

describe('chat moderation', () => {
  const TS = '2026-10-11T10:00:00.000Z';
  const line = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
    id,
    platform: 'twitch',
    destinationId: 'd1',
    author: { name: 'Viewer' },
    text: id,
    ts: TS,
    kind: 'message',
    ...over,
  });
  const withChat = (chat: ChatMessage[]): LiveState => ({ ...initialLiveState, chat });
  const moderate = (s: LiveState, moderation: ChatModeration) => reduceLive(s, { type: 'chat-moderation', moderation });
  const ids = (s: LiveState) => s.chat.map((m) => m.id);

  it('parses chat-moderation frames and rejects malformed ones', () => {
    const moderation: ChatModeration = { kind: 'cleared', platform: 'kick', destinationId: 'k1', ts: TS };
    expect(parseServerMessage(JSON.stringify({ type: 'chat-moderation', moderation }))).toEqual({ type: 'chat-moderation', moderation });
    expect(parseServerMessage(JSON.stringify({ type: 'chat-moderation' }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'chat-moderation', moderation: { kind: 'cleared' } }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'chat-moderation', moderation: { destinationId: 'k1' } }))).toBeNull();
  });

  it('message-deleted removes one message by hub id, platform id or the derived id', () => {
    const s = withChat([
      line('twitch:a'),
      line('h2', { platformMessageId: 'b' }),
      line('twitch:c'),
      line('h4', { platformMessageId: 'b', destinationId: 'd2' }), // same platform id, other channel
    ]);
    const byHubId = moderate(s, { kind: 'message-deleted', platform: 'twitch', destinationId: 'd1', ts: TS, messageId: 'twitch:a', platformMessageId: 'a' });
    expect(ids(byHubId)).toEqual(['h2', 'twitch:c', 'h4']);
    const byPlatformId = moderate(s, { kind: 'message-deleted', platform: 'twitch', destinationId: 'd1', ts: TS, messageId: null, platformMessageId: 'b' });
    expect(ids(byPlatformId)).toEqual(['twitch:a', 'twitch:c', 'h4']);
    const derived = moderate(s, { kind: 'message-deleted', platform: 'twitch', destinationId: 'd1', ts: TS, messageId: null, platformMessageId: 'c' });
    expect(ids(derived)).toEqual(['twitch:a', 'h2', 'h4']);
  });

  it('user-cleared removes that user in that destination: ids win, else name or login (any case)', () => {
    const s = withChat([
      line('1', { author: { name: 'Ann', id: 'u1', login: 'ann_tv' } }),
      line('2', { author: { name: 'Bob', id: 'u2' } }),
      line('3', { author: { name: 'Ann_TV' } }), // no id: matched by name
      line('4', { author: { name: 'Someone', login: 'ANN_TV' } }), // matched by login
      line('5', { author: { name: 'Ann', id: 'u9' } }), // another user with the same display name
      line('6', { author: { name: 'Ann', id: 'u1' }, destinationId: 'd2' }), // other destination
      line('7', { author: { name: 'Ann', id: 'u1' }, platform: 'kick' }), // same destination id, other platform (defensive)
      line('8', { kind: 'event', author: { name: 'Ann', id: 'u1' }, alert: { kind: 'follow', user: { name: 'Ann' } } }),
    ]);
    const out = moderate(s, { kind: 'user-cleared', platform: 'twitch', destinationId: 'd1', ts: TS, userId: 'u1', userName: 'ann_tv' });
    expect(ids(out)).toEqual(['2', '5', '6', '7']);
    // Name only (browser chat has no user ids).
    const byName = moderate(s, { kind: 'user-cleared', platform: 'twitch', destinationId: 'd1', ts: TS, userId: null, userName: 'BOB' });
    expect(ids(byName)).not.toContain('2');
    expect(byName.chat).toHaveLength(7);
    // An id alone never matches messages that have no author id.
    const idOnly = moderate(s, { kind: 'user-cleared', platform: 'twitch', destinationId: 'd1', ts: TS, userId: 'u3', userName: null });
    expect(idOnly).toBe(s);
  });

  it('messageFromUser follows the server rule', () => {
    expect(messageFromUser({ author: { name: 'Ann', id: 'u1' } }, 'u1', null)).toBe(true);
    expect(messageFromUser({ author: { name: 'Ann', id: 'u1' } }, 'u2', 'Ann')).toBe(false);
    expect(messageFromUser({ author: { name: 'Ann' } }, 'u2', 'ann')).toBe(true);
    expect(messageFromUser({ author: { name: 'Ann' } }, null, null)).toBe(false);
  });

  it("cleared removes one destination's chat only", () => {
    const s = withChat([line('1'), line('2', { destinationId: 'd2' }), line('3')]);
    expect(ids(moderate(s, { kind: 'cleared', platform: 'twitch', destinationId: 'd1', ts: TS }))).toEqual(['2']);
    expect(moderate(s, { kind: 'cleared', platform: 'twitch', destinationId: 'nope', ts: TS })).toBe(s);
    // Unknown kinds from a newer server are ignored.
    expect(moderate(s, { kind: 'mystery', platform: 'twitch', destinationId: 'd1', ts: TS } as unknown as ChatModeration)).toBe(s);
  });

  it('removed messages never come back with a later history merge', () => {
    let s = withChat([line('twitch:a'), line('twitch:b')]);
    s = moderate(s, { kind: 'message-deleted', platform: 'twitch', destinationId: 'd1', ts: TS, messageId: 'twitch:a', platformMessageId: 'a' });
    // A deletion for a message not received yet is remembered too.
    s = moderate(s, { kind: 'message-deleted', platform: 'twitch', destinationId: 'd1', ts: TS, messageId: null, platformMessageId: 'z' });
    s = reduceLive(s, { type: 'hello', session: session(), chat: [line('twitch:a'), line('twitch:b'), line('twitch:z'), line('twitch:new')] });
    expect(ids(s)).toEqual(['twitch:b', 'twitch:new']);
    s = reduceLive(s, { type: 'chat', message: line('twitch:a') });
    expect(ids(s)).toEqual(['twitch:b', 'twitch:new']);

    const store = new LiveStore();
    store.dispatch({ type: 'chat', message: line('x1') });
    store.dispatch({ type: 'chat-moderation', moderation: { kind: 'cleared', platform: 'twitch', destinationId: 'd1', ts: TS } });
    store.mergeChat([line('x1'), line('x2')]); // REST snapshot taken before the clear
    expect(store.getState().chat.map((m) => m.id)).toEqual(['x2']);
  });

  describe('a reconnect hello reconciles chat with the server buffer', () => {
    const BASE = Date.UTC(2026, 9, 11, 10, 0, 0);
    const at = (id: string, destinationId: string, sec: number): ChatMessage =>
      line(id, { destinationId, ts: new Date(BASE + sec * 1000).toISOString() });
    const hello = (s: LiveState, chat: ChatMessage[]) => reduceLive(s, { type: 'hello', session: session(), chat });

    it('drops messages missing from a snapshot that is the whole buffer (moderated while away)', () => {
      let s = hello(initialLiveState, [at('A', 'd1', 1), at('B', 'd1', 2), at('C', 'd1', 3)]);
      expect(ids(s)).toEqual(['A', 'B', 'C']);
      // B was deleted while the socket was down; D arrived.
      s = hello(s, [at('A', 'd1', 1), at('C', 'd1', 3), at('D', 'd1', 4)]);
      expect(ids(s)).toEqual(['A', 'C', 'D']);
    });

    it("an empty snapshot after a 'cleared' (or a server restart) empties the chat", () => {
      let s = hello(initialLiveState, [at('A', 'd1', 1), at('B', 'd2', 2)]);
      s = hello(s, []);
      expect(s.chat).toEqual([]);
      // Not remembered as moderated: a platform that delivers them again after a restart shows them.
      s = reduceLive(s, { type: 'chat', message: at('A', 'd1', 1) });
      expect(ids(s)).toEqual(['A']);
    });

    it('a full snapshot only drops messages that are clearly inside its window', () => {
      const snapshot: ChatMessage[] = [];
      // Window start: a delayed YouTube batch (d1) with older timestamps, then Kick (d2), then more d1.
      for (let i = 0; i < 10; i++) snapshot.push(at(`y${i}`, 'd1', 100 + i));
      for (let i = 0; i < 95; i++) snapshot.push(at(`k${i}`, 'd2', 160 + i));
      for (let i = 0; i < 95; i++) snapshot.push(at(`s${i}`, 'd1', 300 + i));
      expect(snapshot).toHaveLength(HELLO_CHAT_LIMIT);

      const held = [
        at('old', 'd1', 0), // fell out of the window: kept
        at('w', 'd2', 150), // arrived before the window but newer than its first (YouTube) messages: kept
        at('mod', 'd1', 500), // inside the window, missing: deleted while away
        at('c-old', 'd3', 50), // d3 has nothing in the window: older than its start, kept
        at('c-new', 'd3', 400), // ... newer than its start: the channel was cleared while away
        at('y0', 'd1', 100),
      ];
      let s = hello(initialLiveState, held);
      expect(s.chat).toHaveLength(held.length);
      s = hello(s, snapshot);
      const out = ids(s);
      expect(out).toEqual(expect.arrayContaining(['old', 'w', 'c-old', ...snapshot.map((m) => m.id)]));
      expect(out).not.toContain('mod');
      expect(out).not.toContain('c-new');
      expect(out).toHaveLength(HELLO_CHAT_LIMIT + 3);
      expect(out.slice(0, 3)).toEqual(['old', 'c-old', 'y0']); // still in time order
      // The removed-id memory is only for moderation we actually saw.
      expect(s.removedChat.size).toBe(0);
    });

    it('keeps the same array when the snapshot changes nothing; removed ids stay out', () => {
      const chat = [at('A', 'd1', 1), at('B', 'd1', 2)];
      expect(reconcileChat(chat, [at('A', 'd1', 1), at('B', 'd1', 2)])).toBe(chat);
      expect(reconcileChat(chat, [at('A', 'd1', 1), at('B', 'd1', 2), at('X', 'd1', 3)], CHAT_LIMIT, new Set(['X']))).toBe(chat);
      // Messages whose time can't be read are never dropped from a full snapshot's window.
      const full = Array.from({ length: HELLO_CHAT_LIMIT }, (_, i) => at(`f${i}`, 'd1', 10 + i));
      const odd = line('odd', { ts: 'not a date' });
      expect(ids({ ...initialLiveState, chat: reconcileChat([odd], full) })).toContain('odd');
    });
  });

  it('applyModeration returns the same array when nothing matched; the removed-id memory is bounded', () => {
    const chat = [line('1')];
    expect(applyModeration(chat, { kind: 'cleared', platform: 'twitch', destinationId: 'other', ts: TS })).toEqual({ chat, removedIds: [] });
    const removed = rememberRemoved(new Set(['a', 'b']), ['c', 'd'], 3);
    expect([...removed]).toEqual(['b', 'c', 'd']);
    const same = new Set(['a']);
    expect(rememberRemoved(same, [])).toBe(same);
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
