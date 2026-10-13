import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../../shared/types.js';
import { EventBus } from '../events.js';
import type { ChatMessageInput } from '../platforms/types.js';
import type { ChatHub, ScopedSecrets } from '../services.js';
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
function staticSource(messages: ChatMessageInput[]) {
  return async function* (signal: AbortSignal): AsyncGenerator<ChatMessageInput> {
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
