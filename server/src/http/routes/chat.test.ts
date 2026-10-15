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

function message(i: number, profileId?: string): ChatMessage {
  return {
    id: `twitch:${i}`,
    platform: 'twitch',
    destinationId: profileId === 'club' ? 'd9' : 'd1',
    ...(profileId ? { profileId } : {}),
    author: { name: `viewer${i}` },
    text: `hello ${i}`,
    ts: '2026-10-11T12:00:00.000Z',
    kind: 'message',
  };
}

const CLUB_TOKEN = 'C'.repeat(43);

/** Two profiles: the default one (token 'AAA…') and 'club' (token 'CCC…'). */
function fakeHub(messages: ChatMessage[], clubMessages: ChatMessage[] = []) {
  const tokens: Record<string, string> = { default: 'A'.repeat(43), club: CLUB_TOKEN };
  let n = 0;
  return {
    tokens,
    recent: vi.fn((limit = 200, profileId = 'default') =>
      (profileId === 'default' ? messages : profileId === 'club' ? clubMessages : []).slice(-Math.min(limit, 500)),
    ),
    overlayToken: vi.fn(async (profileId = 'default') => tokens[profileId]!),
    rotateOverlayToken: vi.fn(async (profileId = 'default') => {
      tokens[profileId] = `${String(++n).padStart(3, '0')}${(profileId === 'club' ? 'D' : 'B').repeat(40)}`;
      return tokens[profileId];
    }),
    profileForOverlayToken: vi.fn(async (token: string) => Object.entries(tokens).find(([, t]) => t === token)?.[0] ?? null),
    attach: vi.fn(),
  };
}

const profilesRepo = {
  get: (id: string) => (id === 'default' || id === 'club' ? { id, name: id, slug: id, color: null, createdAt: '', updatedAt: '' } : null),
};

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
    repos: { audit: { log: auditLog }, profiles: profilesRepo },
    publicBaseUrl: () => 'https://203.0.113.7/',
  } as unknown as AppServices;
  await instance.register(chatRoutes, { services });
  await instance.ready();
  return instance;
}

beforeEach(async () => {
  bus = new EventBus();
  hub = fakeHub(
    Array.from({ length: 80 }, (_, i) => message(i)),
    [message(500, 'club'), message(501, 'club')],
  );
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
    expect(hub.recent).toHaveBeenLastCalledWith(200, 'default');

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
    expect(hub.recent).toHaveBeenLastCalledWith(OVERLAY_HISTORY, 'default');
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

// ---- profiles ----

describe('profiles', () => {
  const as = (role: Role) => ({ 'x-test-role': role });

  it('GET /api/chat/recent?profile= returns that profile only; unknown → 404, malformed → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chat/recent?profile=club&limit=10', headers: as('operator') });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((m: ChatMessage) => m.id)).toEqual(['twitch:500', 'twitch:501']);
    expect(hub.recent).toHaveBeenLastCalledWith(10, 'club');

    const ghost = await app.inject({ method: 'GET', url: '/api/chat/recent?profile=ghost', headers: as('operator') });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json()).toMatchObject({ code: 'unknown_profile' });
    const twice = await app.inject({ method: 'GET', url: '/api/chat/recent?profile=club&profile=default', headers: as('operator') });
    expect(twice.statusCode).toBe(400);
  });

  it('overlay info + rotate per profile; the default URL stays the same', async () => {
    const club = await app.inject({ method: 'GET', url: '/api/chat/overlay?profile=club', headers: as('admin') });
    expect(club.json()).toEqual({ url: `https://203.0.113.7/overlay/chat?token=${CLUB_TOKEN}` });
    expect(hub.overlayToken).toHaveBeenLastCalledWith('club');

    const rotated = await app.inject({ method: 'POST', url: '/api/chat/overlay/rotate?profile=club', headers: as('admin') });
    expect(rotated.json()).toEqual({ url: `https://203.0.113.7/overlay/chat?token=001${'D'.repeat(40)}` });
    expect(auditLog).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'chat.overlay_rotate', detail: 'profile=club' }));

    const main = await app.inject({ method: 'GET', url: '/api/chat/overlay', headers: as('admin') });
    expect(main.json()).toEqual({ url: `https://203.0.113.7/overlay/chat?token=${'A'.repeat(43)}` });
    expect((await app.inject({ method: 'GET', url: '/api/chat/overlay?profile=ghost', headers: as('admin') })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/chat/overlay/rotate?profile=ghost', headers: as('admin') })).statusCode).toBe(404);
    expect(hub.rotateOverlayToken).toHaveBeenCalledTimes(1);
  });

  it("serves each profile's overlay page with its own token", async () => {
    expect((await app.inject({ method: 'GET', url: `/overlay/chat?token=${CLUB_TOKEN}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/overlay/chat?token=${'A'.repeat(43)}` })).statusCode).toBe(200);
  });

  it("an overlay socket gets only its token's profile chat (history and live)", async () => {
    const main = await connect(`/overlay/ws?token=${'A'.repeat(43)}`);
    const club = await connect(`/overlay/ws?token=${CLUB_TOKEN}`);
    await until(() => main.messages.length === OVERLAY_HISTORY && club.messages.length === 2);
    expect(club.messages).toEqual([
      { type: 'chat', message: message(500, 'club') },
      { type: 'chat', message: message(501, 'club') },
    ]);

    bus.emit('chat', message(900, 'club'));
    bus.emit('chat', message(901, 'default'));
    bus.emit('chat', message(902)); // no profile (older emitters): the default profile
    await until(() => club.messages.length === 3 && main.messages.length === OVERLAY_HISTORY + 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(club.messages.at(-1)).toEqual({ type: 'chat', message: message(900, 'club') });
    expect(main.messages.slice(-2)).toEqual([
      { type: 'chat', message: message(901, 'default') },
      { type: 'chat', message: message(902) },
    ]);
    expect(club.messages).toHaveLength(3);
  });

  it("rotating one profile's token disconnects only that profile's overlays", async () => {
    const main = await connect(`/overlay/ws?token=${'A'.repeat(43)}`);
    const club = await connect(`/overlay/ws?token=${CLUB_TOKEN}`);
    await until(() => main.messages.length === OVERLAY_HISTORY && club.messages.length === 2);
    await app.inject({ method: 'POST', url: '/api/chat/overlay/rotate?profile=club', headers: as('admin') });
    expect(await club.closed).toBe(WS_CLOSE_UNAUTHORIZED);
    expect(main.ws.readyState).toBe(main.ws.OPEN);
    bus.emit('chat', message(950));
    await until(() => main.messages.length === OVERLAY_HISTORY + 1);
  });

  it("a deleted profile's overlays close as soon as profiles change", async () => {
    const club = await connect(`/overlay/ws?token=${CLUB_TOKEN}`);
    const main = await connect(`/overlay/ws?token=${'A'.repeat(43)}`);
    await until(() => club.messages.length === 2 && main.messages.length === OVERLAY_HISTORY);
    delete hub.tokens.club; // the profile route deleted its secret scope
    bus.emit('profiles-changed');
    expect(await club.closed).toBe(WS_CLOSE_UNAUTHORIZED);
    await new Promise((r) => setTimeout(r, 20));
    expect(main.ws.readyState).toBe(main.ws.OPEN);
  });
});
