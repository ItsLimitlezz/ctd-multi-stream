import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { WsServerMessage } from '../../../../shared/api.js';
import type { Account, ChatMessage, ChatModeration, SessionState, User } from '../../../../shared/types.js';
import { EventBus } from '../../events.js';
import type { AppServices } from '../../services.js';
import wsRoutes, { WS_MAX_BUFFERED_BYTES, WsHub, type HubSocket } from './ws.js';

const SESSION: SessionState = {
  status: 'offline',
  sessionId: null,
  startedAt: null,
  title: 'Hello',
  autoGoLive: true,
  feeds: [],
  destinations: [],
};

const CHAT: ChatMessage = {
  id: 'm1',
  platform: 'twitch',
  destinationId: 'd1',
  author: { name: 'viewer' },
  text: 'hi',
  ts: '2026-01-01T00:00:00.000Z',
  kind: 'message',
};

const MODERATION: ChatModeration = {
  kind: 'message-deleted',
  platform: 'twitch',
  destinationId: 'd1',
  ts: '2026-01-01T00:00:01.000Z',
  messageId: 'twitch:1',
  platformMessageId: '1',
};

const ACCOUNT: Account = {
  id: 'a1',
  platform: 'twitch',
  label: 'dprtmnt',
  status: 'connected',
  statusMessage: null,
  options: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const USER: User = {
  id: 'u1',
  username: 'alice',
  role: 'operator',
  totpEnabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
};

class FakeSocket implements HubSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: WsServerMessage[] = [];
  pings = 0;
  terminated = false;
  private readonly listeners = new Map<string, (() => void)[]>();
  send(data: string): void {
    this.sent.push(JSON.parse(data) as WsServerMessage);
  }
  ping(): void {
    this.pings += 1;
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.fire('close');
  }
  on(event: 'pong' | 'close', listener: () => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  fire(event: 'pong' | 'close'): void {
    for (const l of this.listeners.get(event) ?? []) l();
  }
}

const silent = pino({ level: 'silent' });
const hello: WsServerMessage = { type: 'hello', session: SESSION, chat: [] };

describe('WsHub', () => {
  it('sends hello first, then forwards every bus event type', () => {
    const bus = new EventBus();
    const hub = new WsHub(bus, silent);
    const s = new FakeSocket();
    hub.add(s, hello);
    bus.emit('session', SESSION);
    bus.emit('feed', { feed: 'landscape', online: true, since: null, video: null, audio: null, bitrateKbps: 5000 });
    bus.emit('destination', { destinationId: 'd1', phase: 'live', message: null, stats: null, watchUrl: null, retries: 0, since: 'x', recoveries: 0, lastRecovery: null });
    bus.emit('chat', CHAT);
    bus.emit('chat-moderation', MODERATION);
    bus.emit('account', ACCOUNT);
    bus.emit('destinations-changed');
    bus.emit('notice', { level: 'warn', message: 'careful' });
    bus.emit('push', { id: 'd1', status: 'running', message: null, stats: null, attempt: 0 }); // internal: not forwarded
    expect(s.sent.map((m) => m.type)).toEqual([
      'hello',
      'session',
      'feed',
      'destination',
      'chat',
      'chat-moderation',
      'account',
      'destinations-changed',
      'notice',
    ]);
    // Moderation goes out unchanged, so the dashboard removes deleted / banned / cleared chat.
    expect(s.sent[5]).toEqual({ type: 'chat-moderation', moderation: MODERATION });
    expect(s.sent.at(-1)).toEqual({ type: 'notice', level: 'warn', message: 'careful' });
    hub.close();
    // Closed: no more forwarding.
    bus.emit('chat-moderation', MODERATION);
    expect(s.sent.filter((m) => m.type === 'chat-moderation')).toHaveLength(1);
  });

  it('terminates clients that miss a pong', () => {
    const hub = new WsHub(new EventBus(), silent);
    const good = new FakeSocket();
    const dead = new FakeSocket();
    hub.add(good, hello);
    hub.add(dead, hello);
    hub.heartbeat();
    expect(good.pings).toBe(1);
    expect(dead.pings).toBe(1);
    good.fire('pong');
    hub.heartbeat();
    expect(good.terminated).toBe(false);
    expect(good.pings).toBe(2);
    expect(dead.terminated).toBe(true);
    expect(hub.size).toBe(1);
    hub.close();
  });

  it('skips slow clients and drops closed ones', () => {
    const bus = new EventBus();
    const hub = new WsHub(bus, silent);
    const slow = new FakeSocket();
    const gone = new FakeSocket();
    hub.add(slow, hello);
    hub.add(gone, hello);
    slow.bufferedAmount = WS_MAX_BUFFERED_BYTES + 1;
    gone.fire('close');
    bus.emit('destinations-changed');
    expect(slow.sent.map((m) => m.type)).toEqual(['hello']);
    expect(gone.sent.map((m) => m.type)).toEqual(['hello']);
    expect(hub.size).toBe(1);
    slow.bufferedAmount = 0;
    bus.emit('destinations-changed');
    expect(slow.sent.map((m) => m.type)).toEqual(['hello', 'destinations-changed']);
    hub.close();
  });

  it('closes sockets whose session was revoked with 4401 on the next heartbeat', () => {
    class ClosableSocket extends FakeSocket {
      closedWith: number | null = null;
      close(code?: number): void {
        this.closedWith = code ?? null;
        this.readyState = 3;
        this.fire('close');
      }
    }
    const bus = new EventBus();
    const hub = new WsHub(bus, silent);
    let valid = true;
    const s = new ClosableSocket();
    const legacy = new FakeSocket(); // no close(): terminated instead
    const unchecked = new ClosableSocket(); // no validator: never closed for it
    const flaky = new ClosableSocket(); // validator throws (DB hiccup): kept
    hub.add(s, hello, () => valid);
    hub.add(legacy, hello, () => valid);
    hub.add(unchecked, hello);
    hub.add(flaky, hello, () => {
      throw new Error('db busy');
    });
    hub.heartbeat();
    expect(s.closedWith).toBeNull();
    for (const sock of [s, legacy, unchecked, flaky]) sock.fire('pong');

    valid = false;
    hub.heartbeat();
    expect(s.closedWith).toBe(4401);
    expect(legacy.terminated).toBe(true);
    expect(unchecked.closedWith).toBeNull();
    expect(flaky.closedWith).toBeNull();
    expect(hub.size).toBe(2);
    bus.emit('destinations-changed');
    expect(s.sent.map((m) => m.type)).toEqual(['hello']);
    hub.close();
  });

  it('close() unsubscribes from the bus and terminates sockets', () => {
    const bus = new EventBus();
    const hub = new WsHub(bus, silent);
    const s = new FakeSocket();
    hub.add(s, hello);
    hub.close();
    expect(s.terminated).toBe(true);
    bus.emit('destinations-changed');
    expect(s.sent).toHaveLength(1);
  });
});

describe('GET /api/ws', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function build() {
    const bus = new EventBus();
    const services = {
      log: silent,
      bus,
      orchestrator: { state: () => SESSION },
      chat: { recent: (limit: number) => (limit >= 1 ? [CHAT] : []) },
    } as unknown as AppServices;
    const instance = Fastify();
    instance.decorateRequest('user', null);
    instance.decorateRequest('authSession', null);
    instance.addHook('onRequest', async (req) => {
      req.user = req.headers['x-test-user'] ? USER : null;
    });
    await instance.register(websocket);
    await instance.register(wsRoutes, { services });
    await instance.ready();
    app = instance;
    return { app: instance, bus };
  }

  it('rejects anonymous upgrades', async () => {
    const { app } = await build();
    await expect(app.injectWS('/api/ws')).rejects.toThrow('401');
  });

  it('sends hello with session + recent chat, then live events', async () => {
    const { app, bus } = await build();
    const received: WsServerMessage[] = [];
    let notify: (() => void) | null = null;
    const ws = await app.injectWS(
      '/api/ws',
      { headers: { 'x-test-user': '1' } },
      {
        onInit: (client) =>
          client.on('message', (data: Buffer) => {
            received.push(JSON.parse(data.toString()) as WsServerMessage);
            notify?.();
          }),
      },
    );
    const waitFor = async (n: number) => {
      while (received.length < n) await new Promise<void>((r) => (notify = r));
    };

    await waitFor(1);
    expect(received[0]).toEqual({ type: 'hello', session: SESSION, chat: [CHAT] });

    ws.send('ignored by the server');
    bus.emit('notice', { level: 'info', message: 'Session stopped' });
    await waitFor(2);
    expect(received[1]).toEqual({ type: 'notice', level: 'info', message: 'Session stopped' });

    ws.terminate();
  });
});
