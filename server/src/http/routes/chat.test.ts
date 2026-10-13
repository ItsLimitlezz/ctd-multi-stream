import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { WsServerMessage } from '../../../../shared/api.js';
import type { ChatMessage, Role, User } from '../../../../shared/types.js';
import { EventBus } from '../../events.js';
import type { AppServices, ChatHub } from '../../services.js';
import chatRoutes, { OVERLAY_HISTORY, OVERLAY_PING_MS, WS_CLOSE_UNAUTHORIZED } from './chat.js';

function message(i: number): ChatMessage {
  return {
    id: `twitch:${i}`,
    platform: 'twitch',
    destinationId: 'd1',
    author: { name: `viewer${i}` },
    text: `hello ${i}`,
    ts: '2026-10-11T12:00:00.000Z',
    kind: 'message',
  };
}

function fakeHub(messages: ChatMessage[]) {
  let token = 'A'.repeat(43);
  let n = 0;
  return {
    recent: vi.fn((limit = 200) => messages.slice(-Math.min(limit, 500))),
    overlayToken: vi.fn(async () => token),
    rotateOverlayToken: vi.fn(async () => {
      token = `${String(++n).padStart(3, '0')}${'B'.repeat(40)}`;
      return token;
    }),
    attach: vi.fn(),
  };
}

let app: FastifyInstance;
let bus: EventBus;
let hub: ReturnType<typeof fakeHub>;
let auditLog: ReturnType<typeof vi.fn>;

async function build(opts: { rateLimit?: boolean } = {}): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(websocket);
  if (opts.rateLimit) await instance.register(rateLimit, { global: false });

  // Tiny fake auth: the x-test-role header decides who is logged in.
  instance.decorateRequest('user', null);
  instance.decorateRequest('authSession', null);
  instance.addHook('onRequest', async (req) => {
    const role = req.headers['x-test-role'];
    req.user =
      role === 'admin' || role === 'operator'
        ? ({ id: 'u1', username: 'alice', role: role as Role, totpEnabled: false, createdAt: '', lastLoginAt: null } satisfies User)
        : null;
  });

  const services = {
    log: pino({ level: 'silent' }),
    bus,
    chat: hub as unknown as ChatHub,
    repos: { audit: { log: auditLog } },
    publicBaseUrl: () => 'https://203.0.113.7/',
  } as unknown as AppServices;
  await instance.register(chatRoutes, { services });
  await instance.ready();
  return instance;
}

beforeEach(async () => {
  bus = new EventBus();
  hub = fakeHub(Array.from({ length: 80 }, (_, i) => message(i)));
  auditLog = vi.fn();
  app = await build();
});

afterEach(async () => {
  await app.close();
});

describe('GET /api/chat/recent', () => {
  it('requires a logged-in user', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chat/recent' });
    expect(res.statusCode).toBe(401);
  });

  it('returns recent messages (default 200, custom limit)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chat/recent', headers: { 'x-test-role': 'operator' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(80);
    expect(hub.recent).toHaveBeenLastCalledWith(200);

    const five = await app.inject({ method: 'GET', url: '/api/chat/recent?limit=5', headers: { 'x-test-role': 'operator' } });
    expect(five.json().map((m: ChatMessage) => m.id)).toEqual(['twitch:75', 'twitch:76', 'twitch:77', 'twitch:78', 'twitch:79']);
  });

  it.each(['0', '501', 'abc', '1.5'])('rejects limit=%s', async (limit) => {
    const res = await app.inject({ method: 'GET', url: `/api/chat/recent?limit=${limit}`, headers: { 'x-test-role': 'admin' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid' });
  });
});

describe('overlay info + rotate', () => {
  it('GET /api/chat/overlay is admin only', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/chat/overlay' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: '/api/chat/overlay', headers: { 'x-test-role': 'operator' } })).statusCode,
    ).toBe(403);

    const res = await app.inject({ method: 'GET', url: '/api/chat/overlay', headers: { 'x-test-role': 'admin' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ url: `https://203.0.113.7/overlay/chat?token=${'A'.repeat(43)}` });
  });

  it('POST /api/chat/overlay/rotate is admin only, returns the new URL and audits', async () => {
    const denied = await app.inject({ method: 'POST', url: '/api/chat/overlay/rotate', headers: { 'x-test-role': 'operator' } });
    expect(denied.statusCode).toBe(403);
    expect(hub.rotateOverlayToken).not.toHaveBeenCalled();

    const res = await app.inject({ method: 'POST', url: '/api/chat/overlay/rotate', headers: { 'x-test-role': 'admin' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: `https://203.0.113.7/overlay/chat?token=001${'B'.repeat(40)}` });
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'chat.overlay_rotate', userId: 'u1' }));
  });
});

describe('GET /overlay/chat', () => {
  it('404s without a token or with a wrong one', async () => {
    for (const url of ['/overlay/chat', '/overlay/chat?token=', `/overlay/chat?token=${'A'.repeat(42)}`, '/overlay/chat?token=x&token=y']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toEqual({ error: 'Not found', code: 'not_found' });
    }
  });

  it('serves the overlay page with a valid token (no auth needed)', async () => {
    const res = await app.inject({ method: 'GET', url: `/overlay/chat?token=${'A'.repeat(43)}&fade=30&max=10` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('<script src="chat.js" defer></script>');
  });

  it('stops accepting the old token after rotation', async () => {
    await app.inject({ method: 'POST', url: '/api/chat/overlay/rotate', headers: { 'x-test-role': 'admin' } });
    expect((await app.inject({ method: 'GET', url: `/overlay/chat?token=${'A'.repeat(43)}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/overlay/chat?token=001${'B'.repeat(40)}` })).statusCode).toBe(200);
  });

  it('is rate limited when the rate-limit plugin is registered', async () => {
    const limited = await build({ rateLimit: true });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 61; i++) codes.push((await limited.inject({ method: 'GET', url: '/overlay/chat?token=nope' })).statusCode);
      expect(codes.slice(0, 60).every((c) => c === 404)).toBe(true);
      expect(codes[60]).toBe(429);
    } finally {
      await limited.close();
    }
  });
});

describe('overlay static assets', () => {
  it('serves chat.js and chat.css without a token, with ETag revalidation', async () => {
    const js = await app.inject({ method: 'GET', url: '/overlay/chat.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/^text\/javascript/);
    expect(js.body).toContain('new WebSocket');
    const etag = js.headers.etag as string;
    expect(etag).toMatch(/^"[\w-]+"$/);

    const again = await app.inject({ method: 'GET', url: '/overlay/chat.js', headers: { 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');

    const css = await app.inject({ method: 'GET', url: '/overlay/chat.css' });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toMatch(/^text\/css/);
  });
});

// ---- websocket ----

interface WsResult {
  ws: WebSocket;
  messages: WsServerMessage[];
  closed: Promise<number>;
}

async function connect(path: string): Promise<WsResult> {
  const messages: WsServerMessage[] = [];
  let resolveClosed!: (code: number) => void;
  const closed = new Promise<number>((r) => (resolveClosed = r));
  const ws = (await app.injectWS(path, {}, {
    onInit(socket) {
      socket.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString()) as WsServerMessage));
      socket.on('close', (code: number) => resolveClosed(code));
    },
  })) as unknown as WebSocket;
  return { ws, messages, closed };
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('WS /overlay/ws', () => {
  it('closes with 4401 for a missing or bad token', async () => {
    expect(await (await connect('/overlay/ws')).closed).toBe(WS_CLOSE_UNAUTHORIZED);
    expect(await (await connect('/overlay/ws?token=wrong')).closed).toBe(WS_CLOSE_UNAUTHORIZED);
  });

  it('sends the last 50 messages, then live chat events', async () => {
    const { ws, messages } = await connect(`/overlay/ws?token=${'A'.repeat(43)}`);
    await until(() => messages.length === OVERLAY_HISTORY);
    expect(hub.recent).toHaveBeenLastCalledWith(OVERLAY_HISTORY);
    expect(messages[0]).toEqual({ type: 'chat', message: message(30) });
    expect(messages.at(-1)).toEqual({ type: 'chat', message: message(79) });

    bus.emit('chat', message(1000));
    await until(() => messages.length === OVERLAY_HISTORY + 1);
    expect(messages.at(-1)).toEqual({ type: 'chat', message: message(1000) });

    // Unsubscribes on close.
    ws.close();
    await until(() => ws.readyState === ws.CLOSED);
    await new Promise((r) => setTimeout(r, 20));
    bus.emit('chat', message(1001));
    await new Promise((r) => setTimeout(r, 20));
    expect(messages).toHaveLength(OVERLAY_HISTORY + 1);
  });

  it('disconnects open overlays with 4401 when the token is rotated', async () => {
    const { messages, closed } = await connect(`/overlay/ws?token=${'A'.repeat(43)}`);
    await until(() => messages.length === OVERLAY_HISTORY);
    await app.inject({ method: 'POST', url: '/api/chat/overlay/rotate', headers: { 'x-test-role': 'admin' } });
    expect(await closed).toBe(WS_CLOSE_UNAUTHORIZED);
  });

  it('re-checks the token on each heartbeat (rotation outside the route)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { messages, closed } = await connect(`/overlay/ws?token=${'A'.repeat(43)}`);
      await until(() => messages.length === OVERLAY_HISTORY);
      await hub.rotateOverlayToken(); // directly on the hub, so the route can't close sockets itself
      await vi.advanceTimersByTimeAsync(OVERLAY_PING_MS);
      expect(await closed).toBe(WS_CLOSE_UNAUTHORIZED);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a plain GET to the websocket route is a 404', async () => {
    const res = await app.inject({ method: 'GET', url: `/overlay/ws?token=${'A'.repeat(43)}` });
    expect(res.statusCode).toBe(404);
  });
});
