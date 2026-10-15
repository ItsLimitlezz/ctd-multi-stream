import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatModeration, Profile } from '../../../shared/types.js';
import { EventBus } from '../events.js';
import type { ChatMessageInput, ChatSourceItem } from '../platforms/types.js';
import type { ChatHub, ScopedSecrets, SecretsRepo } from '../services.js';
import { BACKOFF_MAX_MS, DEDUPE_SIZE, RING_SIZE, createChatHub } from './chat-hub.js';

// ---- fakes ----

function fakeLogger() {
  const log = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  };
  log.child.mockReturnValue(log);
  return log;
}

function fakeSecrets(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const secrets = {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    delete: vi.fn(async (k: string) => {
      store.delete(k);
    }),
    getJson: vi.fn(async () => null),
    setJson: vi.fn(async () => {}),
  };
  return secrets;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function msg(id: string, text = `text ${id}`): ChatMessageInput {
  return { id, author: { name: 'viewer' }, text, ts: '2026-10-11T12:00:00.000Z' };
}

/** Source that yields the given messages, then stays open until aborted. */
function staticSource(messages: ChatSourceItem[]) {
  return async function* (signal: AbortSignal): AsyncGenerator<ChatSourceItem> {
    yield* messages;
    await waitForAbort(signal);
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

let bus: EventBus;
let log: ReturnType<typeof fakeLogger>;
let secrets: ReturnType<typeof fakeSecrets>;
let hub: ChatHub;
let emitted: ChatMessage[];
let parent: AbortController;

beforeEach(() => {
  vi.useFakeTimers();
  bus = new EventBus();
  log = fakeLogger();
  secrets = fakeSecrets();
  hub = createChatHub({ bus, log: log as unknown as Logger, secrets: secrets as unknown as ScopedSecrets });
  emitted = [];
  bus.on('chat', (m) => emitted.push(m));
  parent = new AbortController();
});

afterEach(() => {
  parent.abort();
  vi.useRealTimers();
});

describe('attach', () => {
  it('normalizes yielded messages, emits them and stores them', async () => {
    hub.attach('dest-1', 'twitch', staticSource([msg('1'), msg('2')]), parent.signal);
    await flush();
    expect(emitted.map((m) => m.id)).toEqual(['twitch:1', 'twitch:2']);
    expect(emitted[0]).toMatchObject({ platform: 'twitch', destinationId: 'dest-1', kind: 'message' });
    expect(hub.recent()).toEqual(emitted);
  });

  it('keeps the structured alert of an event line (bus and ring buffer)', async () => {
    const resub: ChatMessageInput = {
      id: 'n1',
      kind: 'event',
      author: { name: 'DJFan', id: '144552210' },
      text: 'subscribed for 12 months: a year of DPRTMNT!',
      alert: {
        kind: 'subscription',
        user: { id: '144552210', name: 'DJFan' },
        amount: { unit: 'months', value: 12 },
        tier: '1000',
        message: { text: 'a year of DPRTMNT!' },
      },
    };
    hub.attach('dest-1', 'twitch', staticSource([resub]), parent.signal);
    await flush();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.alert).toEqual(resub.alert);
    expect(hub.recent()[0]?.alert).toEqual(resub.alert);
  });

  it('restarts a failing source with exponential backoff capped at 30 s', async () => {
    let calls = 0;
    // eslint-disable-next-line require-yield
    const source = async function* (): AsyncGenerator<ChatMessageInput> {
      calls++;
      throw new Error('boom');
    };
    hub.attach('d', 'kick', source, parent.signal);
    await flush();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2); // after 1 s
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(3); // after 2 s
    await vi.advanceTimersByTimeAsync(4000);
    expect(calls).toBe(4); // after 4 s
    await vi.advanceTimersByTimeAsync(8000 + 16000);
    expect(calls).toBe(6);
    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS - 1);
    expect(calls).toBe(6); // capped: 30 s, not 32 s
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(7);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ destinationId: 'd', platform: 'kick', reason: 'Error: boom', retryInMs: 1000 }),
      expect.any(String),
    );
  });

  it('also restarts a source that ends on its own', async () => {
    let calls = 0;
    const source = async function* (): AsyncGenerator<ChatMessageInput> {
      calls++;
      yield msg(`m${calls}`);
    };
    hub.attach('d', 'x', source, parent.signal);
    await flush();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    expect(emitted.map((m) => m.id)).toEqual(['x:m1', 'x:m2']);
  });

  it('resets the backoff after 60 s of healthy streaming', async () => {
    let calls = 0;
    const source = async function* (): AsyncGenerator<ChatMessageInput> {
      calls++;
      if (calls === 4) {
        yield msg('healthy');
        await new Promise((r) => setTimeout(r, 61_000));
      }
      throw new Error('drop');
    };
    hub.attach('d', 'youtube', source, parent.signal);
    await flush(); // t=0 call 1
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000); // calls 2, 3, 4 (t=7 s)
    expect(calls).toBe(4);
    await vi.advanceTimersByTimeAsync(61_000); // call 4 fails at t=68 s
    expect(calls).toBe(4);
    await vi.advanceTimersByTimeAsync(1000); // reset to 1 s instead of 8 s
    expect(calls).toBe(5);
  });

  it('stops on abort: no more restarts, the source sees its signal aborted', async () => {
    let calls = 0;
    let seen: AbortSignal | undefined;
    const source = async function* (signal: AbortSignal): AsyncGenerator<ChatMessageInput> {
      calls++;
      seen = signal;
      throw new Error('boom');
    };
    hub.attach('d', 'twitch', source, parent.signal);
    await flush();
    parent.abort();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toBe(1);
    expect(seen?.aborted).toBe(true);
  });

  it('stops promptly even when the source ignores its signal, and asks it to clean up', async () => {
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const stuck: AsyncIterable<ChatMessageInput> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<ChatMessageInput>>(() => {}),
        return: returned,
      }),
    };
    hub.attach('d', 'tiktok', () => stuck, parent.signal);
    await flush();
    parent.abort();
    await flush();
    expect(returned).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('re-attaching the same destination replaces the previous attachment', async () => {
    const signals: AbortSignal[] = [];
    const make = (id: string) =>
      async function* (signal: AbortSignal): AsyncGenerator<ChatMessageInput> {
        signals.push(signal);
        yield msg(id);
        await waitForAbort(signal);
        yield msg(`${id}-late`); // must never be delivered
      };
    hub.attach('d', 'twitch', make('first'), parent.signal);
    await flush();
    hub.attach('d', 'twitch', make('second'), parent.signal);
    await flush();
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(emitted.map((m) => m.id)).toEqual(['twitch:first', 'twitch:second']);

    // Other destinations are independent.
    hub.attach('other', 'kick', make('k'), parent.signal);
    await flush();
    expect(signals[1]?.aborted).toBe(false);

    parent.abort();
    await flush();
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it('ignores an already-aborted signal', async () => {
    const source = vi.fn(staticSource([msg('1')]));
    parent.abort();
    hub.attach('d', 'twitch', source, parent.signal);
    await flush();
    expect(source).not.toHaveBeenCalled();
  });

  it('a throwing chat listener does not restart the source', async () => {
    bus.on('chat', () => {
      throw new Error('listener bug');
    });
    let calls = 0;
    const source = async function* (signal: AbortSignal): AsyncGenerator<ChatMessageInput> {
      calls++;
      yield msg('1');
      yield msg('2');
      await waitForAbort(signal);
    };
    hub.attach('d', 'twitch', source, parent.signal);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(1);
    expect(hub.recent().map((m) => m.id)).toEqual(['twitch:1', 'twitch:2']);
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it('never logs secrets from source errors', async () => {
    // eslint-disable-next-line require-yield
    const source = async function* (): AsyncGenerator<ChatMessageInput> {
      throw new Error('connect wss://chat.example.com/socket?token=SUPERSECRET failed');
    };
    hub.attach('d', 'kick', source, parent.signal);
    await flush();
    const logged = JSON.stringify([log.warn.mock.calls, log.error.mock.calls, log.info.mock.calls]);
    expect(logged).toContain('wss://chat.example.com');
    expect(logged).not.toContain('SUPERSECRET');
  });
});

describe('dedupe and ring buffer', () => {
  it('drops duplicate ids across sources and destinations', async () => {
    hub.attach('a', 'youtube', staticSource([msg('1'), msg('1'), msg('2')]), parent.signal);
    hub.attach('b', 'youtube', staticSource([msg('2'), msg('3')]), parent.signal);
    hub.attach('c', 'twitch', staticSource([msg('1')]), parent.signal); // different platform → different id
    await flush();
    // Sources run concurrently, so only the set (and each id once) is deterministic.
    expect(emitted.map((m) => m.id).sort()).toEqual(['twitch:1', 'youtube:1', 'youtube:2', 'youtube:3']);
  });

  it('remembers only the last 2000 ids', async () => {
    const many = Array.from({ length: DEDUPE_SIZE + 1 }, (_, i) => msg(String(i)));
    hub.attach('a', 'kick', staticSource([...many, msg('0'), msg(String(DEDUPE_SIZE))]), parent.signal);
    await flush();
    // id 0 was forgotten → accepted again; the newest id is still remembered → dropped.
    expect(emitted).toHaveLength(DEDUPE_SIZE + 2);
    expect(emitted.at(-1)?.id).toBe('kick:0');
  });

  it('keeps the last 500 messages; recent() is oldest first and capped', async () => {
    const many = Array.from({ length: 620 }, (_, i) => msg(String(i)));
    hub.attach('a', 'twitch', staticSource(many), parent.signal);
    await flush();
    expect(emitted).toHaveLength(620);

    const all = hub.recent(10_000);
    expect(all).toHaveLength(RING_SIZE);
    expect(all[0]?.id).toBe('twitch:120');
    expect(all.at(-1)?.id).toBe('twitch:619');

    expect(hub.recent()).toHaveLength(200);
    expect(hub.recent()[0]?.id).toBe('twitch:420');
    expect(hub.recent(3).map((m) => m.id)).toEqual(['twitch:617', 'twitch:618', 'twitch:619']);
    expect(hub.recent(0)).toEqual([]);
    expect(hub.recent(-5)).toEqual([]);
    expect(hub.recent(Number.NaN)).toHaveLength(200);
  });
});

describe('moderation', () => {
  let moderations: ChatModeration[];
  beforeEach(() => {
    moderations = [];
    bus.on('chat-moderation', (m) => moderations.push(m));
  });

  function user(id: string, name: string, extra: Partial<ChatMessageInput> = {}): ChatMessageInput {
    return { id, author: { name, id: `uid-${name}`, login: name.toLowerCase() }, text: `from ${name} ${id}`, ...extra };
  }

  it('message-deleted removes the message from the buffer and reports the hub id', async () => {
    hub.attach(
      'd1',
      'twitch',
      staticSource([user('m1', 'Ann'), user('m2', 'Bob'), { kind: 'message-deleted', platformMessageId: 'm1' }]),
      parent.signal,
    );
    await flush();
    expect(hub.recent().map((m) => m.id)).toEqual(['twitch:m2']);
    expect(moderations).toEqual([
      { kind: 'message-deleted', platform: 'twitch', destinationId: 'd1', profileId: 'default', ts: expect.any(String), messageId: 'twitch:m1', platformMessageId: 'm1' },
    ]);
  });

  it('uses the explicit platformMessageId when the driver gives one, and the derived id for unknown messages', async () => {
    hub.attach(
      'd1',
      'youtube',
      staticSource([
        user('LCC.abc', 'Ann', { platformMessageId: 'raw-1' }),
        { kind: 'message-deleted', platformMessageId: 'raw-1' },
        { kind: 'message-deleted', platformMessageId: 'never-seen' },
        { kind: 'message-deleted', platformMessageId: '' },
      ]),
      parent.signal,
    );
    await flush();
    expect(hub.recent()).toEqual([]);
    // Never null (docs/API.md): an unknown message gets the id it would have had.
    expect(moderations.map((m) => (m.kind === 'message-deleted' ? m.messageId : m.kind))).toEqual(['youtube:LCC.abc', 'youtube:never-seen']);
  });

  it('remembers the hub id of a deleted message that already left the ring buffer', async () => {
    const many = Array.from({ length: RING_SIZE + 5 }, (_, i) => user(`m${i}`, 'Ann'));
    hub.attach('d1', 'kick', staticSource([...many, { kind: 'message-deleted', platformMessageId: 'm0' }]), parent.signal);
    await flush();
    expect(hub.recent(RING_SIZE)).toHaveLength(RING_SIZE);
    expect(moderations[0]).toMatchObject({ kind: 'message-deleted', messageId: 'kick:m0', platformMessageId: 'm0' });
  });

  it('only affects the destination the moderation came from', async () => {
    hub.attach('a', 'twitch', staticSource([user('1', 'Ann'), user('2', 'Bob')]), parent.signal);
    await flush();
    hub.attach('b', 'twitch', staticSource([user('3', 'Ann'), { kind: 'user-cleared', userId: 'uid-Ann' }, { kind: 'message-deleted', platformMessageId: '2' }]), parent.signal);
    await flush();
    expect(hub.recent().map((m) => m.id)).toEqual(['twitch:1', 'twitch:2']);
    expect(moderations).toEqual([
      { kind: 'user-cleared', platform: 'twitch', destinationId: 'b', profileId: 'default', ts: expect.any(String), userId: 'uid-Ann', userName: null },
      { kind: 'message-deleted', platform: 'twitch', destinationId: 'b', profileId: 'default', ts: expect.any(String), messageId: 'twitch:2', platformMessageId: '2' },
    ]);
  });

  it('user-cleared matches the author id, or the name/login (case-insensitive) when there is no id', async () => {
    hub.attach(
      'd',
      'kick',
      staticSource([
        user('1', 'Ann'),
        user('2', 'Bob'),
        { id: '3', author: { name: 'Carl' }, text: 'no id' },
        { id: '4', author: { name: 'Dee', login: 'dee_login' }, text: 'login only' },
        { kind: 'user-cleared', userId: 'uid-Ann' },
        { kind: 'user-cleared', userName: 'CARL' },
        { kind: 'user-cleared', userName: 'DEE_LOGIN' },
        { kind: 'user-cleared' }, // nothing to match: ignored
      ]),
      parent.signal,
    );
    await flush();
    expect(hub.recent().map((m) => m.id)).toEqual(['kick:2']);
    expect(moderations.map((m) => (m.kind === 'user-cleared' ? [m.userId, m.userName] : null))).toEqual([
      ['uid-Ann', null],
      [null, 'CARL'],
      [null, 'DEE_LOGIN'],
    ]);
  });

  it('an id mismatch is not overridden by a matching name', async () => {
    hub.attach('d', 'twitch', staticSource([user('1', 'Ann'), { kind: 'user-cleared', userId: 'someone-else', userName: 'ann' }]), parent.signal);
    await flush();
    expect(hub.recent().map((m) => m.id)).toEqual(['twitch:1']);
  });

  it('cleared removes the whole chat of that destination', async () => {
    hub.attach('a', 'twitch', staticSource([user('1', 'Ann')]), parent.signal);
    hub.attach('b', 'youtube', staticSource([user('2', 'Bob'), user('3', 'Cy'), { kind: 'cleared' }]), parent.signal);
    await flush();
    expect(hub.recent().map((m) => m.id)).toEqual(['twitch:1']);
    expect(moderations).toEqual([{ kind: 'cleared', platform: 'youtube', destinationId: 'b', profileId: 'default', ts: expect.any(String) }]);
  });

  it('a deleted message is not re-added when the source replays it', async () => {
    hub.attach('d', 'twitch', staticSource([user('1', 'Ann'), { kind: 'message-deleted', platformMessageId: '1' }, user('1', 'Ann')]), parent.signal);
    await flush();
    expect(hub.recent()).toEqual([]);
    expect(emitted).toHaveLength(1);
  });

  it('keeps the new optional message fields', async () => {
    hub.attach(
      'd',
      'twitch',
      staticSource([
        {
          id: 'x',
          platformMessageId: 'x',
          author: { name: 'DJFan', id: '144552210', login: 'djfan', badges: ['subscriber/12'] },
          text: 'hi Kappa',
          fragments: [
            { type: 'text', text: 'hi ' },
            { type: 'emote', text: 'Kappa', image: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0' },
          ],
          action: true,
          highlighted: true,
          reply: { messageId: 'parent', userName: 'Ann', text: 'hello' },
        },
      ]),
      parent.signal,
    );
    await flush();
    expect(emitted[0]).toMatchObject({
      platformMessageId: 'x',
      author: { id: '144552210', login: 'djfan' },
      fragments: [{ type: 'text', text: 'hi ' }, { type: 'emote', text: 'Kappa' }],
      action: true,
      highlighted: true,
      reply: { messageId: 'parent', userName: 'Ann', text: 'hello' },
    });
  });
});

describe('overlay token', () => {
  it('creates, persists and caches a token', async () => {
    const t1 = await hub.overlayToken();
    expect(t1).toMatch(/^[\w-]{43}$/);
    expect(secrets.store.get('overlayToken')).toBe(t1);
    expect(await hub.overlayToken()).toBe(t1);
    expect(secrets.get).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(t1);
  });

  it('reuses a stored token (survives restarts)', async () => {
    const stored = 'S'.repeat(43);
    const s = fakeSecrets({ overlayToken: stored });
    const h = createChatHub({ bus, log: log as unknown as Logger, secrets: s as unknown as ScopedSecrets });
    expect(await h.overlayToken()).toBe(stored);
    expect(s.set).not.toHaveBeenCalled();
  });

  it('concurrent first calls agree on one token', async () => {
    const [a, b, c] = await Promise.all([hub.overlayToken(), hub.overlayToken(), hub.overlayToken()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(secrets.set).toHaveBeenCalledTimes(1);
  });

  it('rotate replaces and persists the token', async () => {
    const t1 = await hub.overlayToken();
    const t2 = await hub.rotateOverlayToken();
    expect(t2).not.toBe(t1);
    expect(secrets.store.get('overlayToken')).toBe(t2);
    expect(await hub.overlayToken()).toBe(t2);

    // A new hub (process restart) reads the rotated token.
    const h = createChatHub({ bus, log: log as unknown as Logger, secrets: secrets as unknown as ScopedSecrets });
    expect(await h.overlayToken()).toBe(t2);
  });

  it('a rotate racing the first read wins', async () => {
    const first = hub.overlayToken();
    const rotated = hub.rotateOverlayToken();
    await first;
    expect(await hub.overlayToken()).toBe(await rotated);
    expect(secrets.store.get('overlayToken')).toBe(await rotated);
  });

  it('does not cache a failed read', async () => {
    secrets.get.mockRejectedValueOnce(new Error('db locked'));
    await expect(hub.overlayToken()).rejects.toThrow('db locked');
    expect(await hub.overlayToken()).toMatch(/^[\w-]{43}$/);
  });
});

// ---- profiles ----

const DPRTMNT = 'p-dprtmnt';

function fakeSecretsRepo(initial: Record<string, Record<string, string>> = {}) {
  const scopes = new Map(Object.entries(initial).map(([scope, values]) => [scope, new Map(Object.entries(values))]));
  const scoped = (scope: string): ScopedSecrets => {
    const m = () => {
      let s = scopes.get(scope);
      if (!s) scopes.set(scope, (s = new Map()));
      return s;
    };
    return {
      get: async (k) => m().get(k) ?? null,
      set: async (k, v) => void m().set(k, v),
      delete: async (k) => void m().delete(k),
      getJson: async () => null,
      setJson: async () => {},
    };
  };
  const repo: SecretsRepo = { scoped: vi.fn(scoped), deleteScope: (scope) => void scopes.delete(scope) };
  return { repo, scopes };
}

function fakeProfiles(ids: string[]) {
  const list = new Set(ids);
  const profile = (id: string): Profile => ({ id, name: id, slug: id, color: null, createdAt: '', updatedAt: '' });
  return {
    ids: list,
    repo: {
      list: () => [...list].map(profile),
      get: (id: string) => (list.has(id) ? profile(id) : null),
    },
  };
}

describe('profiles: chat', () => {
  it('stamps the profile on messages and moderation (default profile when attach gets none)', async () => {
    const moderations: ChatModeration[] = [];
    bus.on('chat-moderation', (m) => moderations.push(m));
    hub.attach('d-main', 'twitch', staticSource([msg('1')]), parent.signal);
    hub.attach('d-club', 'kick', staticSource([msg('2'), { kind: 'cleared' }]), parent.signal, DPRTMNT);
    await flush();
    expect(emitted.find((m) => m.destinationId === 'd-main')).toMatchObject({ id: 'twitch:1', profileId: 'default' });
    expect(emitted.find((m) => m.destinationId === 'd-club')).toMatchObject({ id: 'kick:2', profileId: DPRTMNT });
    // The profile sits right after the destination (readable JSON for API clients).
    expect(Object.keys(emitted[0]!).slice(0, 4)).toEqual(['id', 'platform', 'destinationId', 'profileId']);
    expect(moderations).toEqual([{ kind: 'cleared', platform: 'kick', destinationId: 'd-club', profileId: DPRTMNT, ts: expect.any(String) }]);
  });

  it('keeps a separate ring buffer per profile', async () => {
    hub.attach('a', 'twitch', staticSource([msg('1'), msg('2')]), parent.signal);
    hub.attach('b', 'youtube', staticSource([msg('3')]), parent.signal, DPRTMNT);
    await flush();
    expect(hub.recent().map((m) => m.id)).toEqual(['twitch:1', 'twitch:2']);
    expect(hub.recent(200, 'default').map((m) => m.id)).toEqual(['twitch:1', 'twitch:2']);
    expect(hub.recent(200, DPRTMNT).map((m) => m.id)).toEqual(['youtube:3']);
    expect(hub.recent(200, 'nobody')).toEqual([]);

    // A busy profile never pushes another profile's chat out of its buffer.
    const flood = Array.from({ length: RING_SIZE + 10 }, (_, i) => msg(`f${i}`));
    hub.attach('c', 'kick', staticSource(flood), parent.signal, DPRTMNT);
    await flush();
    expect(hub.recent(RING_SIZE, DPRTMNT)).toHaveLength(RING_SIZE);
    expect(hub.recent(RING_SIZE).map((m) => m.id)).toEqual(['twitch:1', 'twitch:2']);
  });

  it('de-duplicates per profile', async () => {
    hub.attach('a', 'twitch', staticSource([msg('1'), msg('1')]), parent.signal);
    hub.attach('b', 'twitch', staticSource([msg('1'), msg('1')]), parent.signal, DPRTMNT);
    await flush();
    expect(emitted.map((m) => `${m.profileId}/${m.id}`).sort()).toEqual(['default/twitch:1', `${DPRTMNT}/twitch:1`]);
  });
});

describe('profiles: overlay tokens', () => {
  const EXISTING = 'E'.repeat(43); // the token in an OBS browser source from before profiles

  function build(opts: { profiles?: string[]; scopes?: Record<string, Record<string, string>> } = {}) {
    const secretsRepo = fakeSecretsRepo(opts.scopes ?? { chat: { overlayToken: EXISTING } });
    const profiles = fakeProfiles(opts.profiles ?? ['default', DPRTMNT]);
    const h = createChatHub({ bus, log: log as unknown as Logger, secrets: secretsRepo.repo, profiles: profiles.repo });
    return { h, secretsRepo, profiles };
  }

  it("keeps the default profile's existing token in the legacy 'chat' scope", async () => {
    const { h, secretsRepo } = build();
    expect(await h.overlayToken()).toBe(EXISTING);
    expect(await h.overlayToken('default')).toBe(EXISTING);
    expect(await h.profileForOverlayToken(EXISTING)).toBe('default');
    expect(secretsRepo.scopes.get('chat')?.get('overlayToken')).toBe(EXISTING);
  });

  it("gives every other profile its own token in scope 'chat:<id>'", async () => {
    const { h, secretsRepo } = build();
    const club = await h.overlayToken(DPRTMNT);
    expect(club).toMatch(/^[\w-]{43}$/);
    expect(club).not.toBe(EXISTING);
    expect(secretsRepo.scopes.get(`chat:${DPRTMNT}`)?.get('overlayToken')).toBe(club);
    expect(await h.profileForOverlayToken(club)).toBe(DPRTMNT);
    expect(await h.profileForOverlayToken(EXISTING)).toBe('default');
    expect(await h.profileForOverlayToken('nope')).toBeNull();
    expect(await h.profileForOverlayToken('')).toBeNull();
  });

  it('rotating one profile leaves the others alone', async () => {
    const { h } = build();
    const club = await h.overlayToken(DPRTMNT);
    const rotated = await h.rotateOverlayToken(DPRTMNT);
    expect(rotated).not.toBe(club);
    expect(await h.profileForOverlayToken(club)).toBeNull();
    expect(await h.profileForOverlayToken(rotated)).toBe(DPRTMNT);
    expect(await h.overlayToken()).toBe(EXISTING);
  });

  it("finds every profile's token after a restart (without anyone opening the overlay page first)", async () => {
    const first = build();
    const club = await first.h.overlayToken(DPRTMNT);
    const restarted = createChatHub({
      bus: new EventBus(),
      log: log as unknown as Logger,
      secrets: first.secretsRepo.repo,
      profiles: first.profiles.repo,
    });
    expect(await restarted.profileForOverlayToken(club)).toBe(DPRTMNT);
    expect(await restarted.profileForOverlayToken(EXISTING)).toBe('default');
  });

  it('refuses tokens for unknown profiles', async () => {
    const { h, secretsRepo } = build();
    await expect(h.overlayToken('ghost')).rejects.toMatchObject({ statusCode: 404, code: 'unknown_profile' });
    await expect(h.rotateOverlayToken('ghost')).rejects.toMatchObject({ code: 'unknown_profile' });
    expect(secretsRepo.scopes.has('chat:ghost')).toBe(false);
  });

  it("forgets a deleted profile's token and chat", async () => {
    const { h, secretsRepo, profiles } = build();
    const club = await h.overlayToken(DPRTMNT);
    h.attach('b', 'twitch', staticSource([msg('1')]), parent.signal, DPRTMNT);
    await flush();
    expect(h.recent(200, DPRTMNT)).toHaveLength(1);

    // What DELETE /api/profiles/:id does: drop its secret scopes, the row, then announce it.
    secretsRepo.repo.deleteScope(`chat:${DPRTMNT}`);
    profiles.ids.delete(DPRTMNT);
    bus.emit('profiles-changed');
    expect(await h.profileForOverlayToken(club)).toBeNull();
    expect(h.recent(200, DPRTMNT)).toEqual([]);
    expect(await h.profileForOverlayToken(EXISTING)).toBe('default');
  });

  it('never logs a token', async () => {
    const { h } = build();
    const club = await h.overlayToken(DPRTMNT);
    const rotated = await h.rotateOverlayToken(DPRTMNT);
    const logged = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.debug.mock.calls]);
    expect(logged).not.toContain(club);
    expect(logged).not.toContain(rotated);
    expect(logged).not.toContain(EXISTING);
  });

  it("with only the legacy 'chat' scope: the default profile persists, others stay in memory (with a warning)", async () => {
    const club = await hub.overlayToken(DPRTMNT);
    expect(await hub.profileForOverlayToken(club)).toBe(DPRTMNT);
    expect(secrets.store.size).toBe(0); // nothing of DPRTMNT's in the default profile's scope
    expect(log.warn).toHaveBeenCalledTimes(1);
    const main = await hub.overlayToken();
    expect(secrets.store.get('overlayToken')).toBe(main);
    expect(await hub.profileForOverlayToken(main)).toBe('default');
  });
});
