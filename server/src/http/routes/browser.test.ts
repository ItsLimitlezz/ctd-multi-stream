import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { SESSION_COOKIE, type BrowserServerMessage } from '../../../../shared/api.js';
import type { Account, DestinationState, Role, User } from '../../../../shared/types.js';
import type { AppServices, BrowserManager } from '../../services.js';
import browserRoutes, { viewerTimings } from './browser.js';

const account: Account = {
  id: 'acc1',
  profileId: 'default',
  platform: 'instagram',
  label: 'IG',
  status: 'connected',
  statusMessage: null,
  options: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const clubAccount: Account = { ...account, id: 'acc2', profileId: 'club', label: 'IG DPRTMNT' };

interface Calls {
  viewerPage: { accountId: string; url?: string }[];
  close: { accountId: string; save?: boolean }[];
  save: string[];
  audit: { action: string; detail?: string | null }[];
}

async function waitUntil(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface Client {
  ws: WebSocket;
  messages: BrowserServerMessage[];
  closed: { code: number | null };
}

/** Real WebSocket client (listeners attached before the upgrade, so no early message is missed). */
async function connect(baseUrl: string, path: string, headers: Record<string, string>): Promise<Client> {
  const messages: BrowserServerMessage[] = [];
  const closed = { code: null as number | null };
  const ws = new WebSocket(`${baseUrl}${path}`, { headers });
  ws.on('message', (data) => messages.push(JSON.parse(String(data)) as BrowserServerMessage));
  ws.on('close', (code) => (closed.code = code));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, messages, closed };
}

describe.skipIf(!!process.env.CI_NO_BROWSER)('browser routes', () => {
  let chromiumBrowser: Browser;
  let context: BrowserContext;
  let page: Page;
  let app: FastifyInstance;
  let calls: Calls;
  let failOpen = false;
  /** Phase of destination d1 (linked to acc1) in the default profile's orchestrator state. */
  let livePhase: DestinationState['phase'] = 'idle';
  /** Phase of destination d2 (linked to clubAccount) in the 'club' profile's orchestrator state. */
  let clubPhase: DestinationState['phase'] = 'idle';
  /** Sessions the fake auth repo knows (token -> user id) and the user's role. */
  const sessions = new Map<string, string>();
  let userRole: Role | null = 'admin';
  let wsBase = '';

  beforeAll(async () => {
    chromiumBrowser = await chromium.launch({ headless: true });
    context = await chromiumBrowser.newContext({ viewport: { width: 800, height: 600 } });
    page = await context.newPage();
    await page.setContent('<input id="a">');

    const browserManager: Partial<BrowserManager> = {
      async viewerPage(accountId, url) {
        calls.viewerPage.push({ accountId, url });
        if (failOpen) throw new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://nope.invalid/x?token=1');
        return page;
      },
      async close(accountId, opts) {
        calls.close.push({ accountId, save: opts?.save });
      },
      async save(accountId) {
        calls.save.push(accountId);
      },
      async checkViewerUrl(url) {
        return url.hostname === '192.168.1.1' ? 'This address points to a private (LAN) address' : null;
      },
    };
    // One engine per profile: d1 (linked to acc1) runs in the default profile, d2 (clubAccount) in 'club'.
    const defaultOrchestrator = {
      profileId: 'default',
      state: () => ({ profileId: 'default', destinations: [{ destinationId: 'd1', profileId: 'default', phase: livePhase }] }),
    };
    const clubOrchestrator = {
      profileId: 'club',
      state: () => ({ profileId: 'club', destinations: [{ destinationId: 'd2', profileId: 'club', phase: clubPhase }] }),
    };
    const accounts = new Map([account, clubAccount].map((a) => [a.id, a]));
    const destinations = new Map([
      ['d1', { id: 'd1', profileId: 'default', accountId: account.id }],
      ['d2', { id: 'd2', profileId: 'club', accountId: clubAccount.id }],
    ]);
    const services = {
      log: pino({ level: 'silent' }),
      repos: {
        accounts: { get: (id: string) => accounts.get(id) ?? null },
        destinations: { get: (id: string) => destinations.get(id) ?? null },
        authSessions: {
          peek: (token: string) => (sessions.has(token) ? { id: 'h', userId: sessions.get(token) } : null),
        },
        users: { get: (id: string) => (id === 'u1' && userRole ? { id, role: userRole } : null) },
        audit: { log: (e: { action: string; detail?: string | null }) => calls.audit.push(e) },
      },
      browser: browserManager,
      orchestrators: {
        get: (id: string) => {
          if (id === 'default') return defaultOrchestrator;
          if (id === 'club') return clubOrchestrator;
          throw Object.assign(new Error('Profile not found'), { statusCode: 404, code: 'unknown_profile' });
        },
        all: () => [defaultOrchestrator, clubOrchestrator],
      },
    } as unknown as AppServices;

    app = Fastify();
    await app.register(cookie);
    await app.register(websocket);
    app.decorateRequest('user', null);
    app.decorateRequest('authSession', null);
    app.addHook('onRequest', async (req) => {
      const role = req.headers['x-test-role'] as Role | undefined;
      const user: User | null = role
        ? { id: 'u1', username: 'admin', role, totpEnabled: false, createdAt: '', lastLoginAt: null }
        : null;
      req.user = user;
    });
    await app.register(browserRoutes, { services });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    wsBase = address.replace(/^http/, 'ws');
  }, 60_000);

  beforeEach(() => {
    calls = { viewerPage: [], close: [], save: [], audit: [] };
    failOpen = false;
    livePhase = 'idle';
    clubPhase = 'idle';
    sessions.clear();
    userRole = 'admin';
  });

  afterAll(async () => {
    await app?.close();
    await chromiumBrowser?.close();
  });

  const admin = { 'x-test-role': 'admin' };

  it('requires an admin', async () => {
    const anon = await app.inject({ method: 'POST', url: '/api/browser/acc1/open', payload: {} });
    expect(anon.statusCode).toBe(401);
    const op = await app.inject({ method: 'POST', url: '/api/browser/acc1/open', payload: {}, headers: { 'x-test-role': 'operator' } });
    expect(op.statusCode).toBe(403);
    await expect(connect(wsBase, '/api/browser/acc1/ws', { 'x-test-role': 'operator' })).rejects.toThrow('403');
    await expect(connect(wsBase, '/api/browser/acc1/ws', {})).rejects.toThrow('401');
    expect(calls.viewerPage).toHaveLength(0);
  });

  it('opens the viewer page with a validated url and audits the domain only', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/browser/acc1/open',
      headers: admin,
      payload: { url: 'https://www.instagram.com/accounts/login/?next=%2Fsecret' },
    });
    expect(res.statusCode).toBe(200);
    expect(calls.viewerPage).toEqual([{ accountId: 'acc1', url: 'https://www.instagram.com/accounts/login/?next=%2Fsecret' }]);
    expect(calls.audit).toEqual([{ userId: 'u1', username: 'admin', action: 'browser.open', detail: 'instagram:acc1 https://www.instagram.com', ip: '127.0.0.1' }]);

    const noUrl = await app.inject({ method: 'POST', url: '/api/browser/acc1/open', headers: admin, payload: {} });
    expect(noUrl.statusCode).toBe(200);
    expect(calls.viewerPage[1]).toEqual({ accountId: 'acc1', url: undefined });
  });

  it('rejects unknown accounts, non-http urls and reports navigation errors', async () => {
    const missing = await app.inject({ method: 'POST', url: '/api/browser/nope/open', headers: admin, payload: {} });
    expect(missing.statusCode).toBe(404);
    const js = await app.inject({ method: 'POST', url: '/api/browser/acc1/open', headers: admin, payload: { url: 'javascript:alert(1)' } });
    expect(js.statusCode).toBe(400);
    const file = await app.inject({ method: 'POST', url: '/api/browser/acc1/open', headers: admin, payload: { url: 'file:///etc/passwd' } });
    expect(file.statusCode).toBe(400);
    expect(calls.viewerPage).toHaveLength(0);

    failOpen = true;
    const failed = await app.inject({ method: 'POST', url: '/api/browser/acc1/open', headers: admin, payload: { url: 'https://nope.invalid/x' } });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({ error: 'Could not load the page (net::ERR_NAME_NOT_RESOLVED)', code: 'browser_error' });
    expect(calls.audit).toHaveLength(0);
  });

  it('closes with the requested save flag', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/browser/acc1/close', headers: admin, payload: {} });
    expect(bad.statusCode).toBe(400);
    const res = await app.inject({ method: 'POST', url: '/api/browser/acc1/close', headers: admin, payload: { save: true } });
    expect(res.statusCode).toBe(200);
    expect(calls.close).toEqual([{ accountId: 'acc1', save: true }]);
    expect(calls.audit[0]?.action).toBe('browser.close');
  });

  it('streams the page over WebSocket, relays input, replaces old viewers and saves on close', async () => {
    const c1 = await connect(wsBase, '/api/browser/acc1/ws', admin);
    await waitUntil(() => c1.messages.some((m) => m.type === 'frame'));
    expect(c1.messages.find((m) => m.type === 'frame')).toMatchObject({ width: 800, height: 600 });

    // Invalid messages are ignored; valid ones are applied.
    c1.ws.send('not json');
    c1.ws.send(JSON.stringify({ type: 'evil', code: 'x' }));
    await page.focus('#a');
    c1.ws.send(JSON.stringify({ type: 'type', text: 'via ws' }));
    await expect.poll(() => page.inputValue('#a')).toBe('via ws');

    // A second viewer for the same account replaces the first (without saving).
    const c2 = await connect(wsBase, '/api/browser/acc1/ws', admin);
    await waitUntil(() => c1.closed.code !== null);
    expect(c1.closed.code).toBe(4000);
    await waitUntil(() => c2.messages.some((m) => m.type === 'frame' || m.type === 'url'));
    expect(calls.save).toHaveLength(0);

    c2.ws.close();
    await waitUntil(() => calls.save.length === 1);
    expect(calls.save).toEqual(['acc1']);
  });

  it('closing the browser ends the viewer without saving', async () => {
    const c = await connect(wsBase, '/api/browser/acc1/ws', admin);
    await waitUntil(() => c.messages.length > 0);
    const res = await app.inject({ method: 'POST', url: '/api/browser/acc1/close', headers: admin, payload: { save: false } });
    expect(res.statusCode).toBe(200);
    await waitUntil(() => c.closed.code !== null);
    expect(c.closed.code).toBe(1000);
    expect(calls.close).toEqual([{ accountId: 'acc1', save: false }]);
    expect(calls.save).toHaveLength(0);
  });

  it('refuses LAN/loopback hosts up front', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/browser/acc1/open', headers: admin, payload: { url: 'http://192.168.1.1/admin' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'blocked_host' });
    expect(calls.viewerPage).toHaveLength(0);
  });

  it('does not take over or close the browser of an account that is live', async () => {
    livePhase = 'live';
    const nav = await app.inject({ method: 'POST', url: '/api/browser/acc1/open', headers: admin, payload: { url: 'https://www.tiktok.com/' } });
    expect(nav.statusCode).toBe(409);
    expect(nav.json()).toMatchObject({ code: 'account_live' });
    expect(calls.viewerPage).toHaveLength(0);

    // Looking at the current page (to step in during the live) stays possible.
    const look = await app.inject({ method: 'POST', url: '/api/browser/acc1/open', headers: admin, payload: {} });
    expect(look.statusCode).toBe(200);
    expect(calls.viewerPage).toEqual([{ accountId: 'acc1', url: undefined }]);

    // Closing the dialog ends the viewer and saves when asked, but keeps the live's context open.
    const c = await connect(wsBase, '/api/browser/acc1/ws', admin);
    await waitUntil(() => c.messages.length > 0);
    const closed = await app.inject({ method: 'POST', url: '/api/browser/acc1/close', headers: admin, payload: { save: true } });
    expect(closed.statusCode).toBe(200);
    await waitUntil(() => c.closed.code !== null);
    expect(c.closed.code).toBe(1000);
    expect(calls.close).toEqual([]);
    expect(calls.save).toEqual(['acc1']);

    livePhase = 'error'; // a failed runner no longer holds the page
    await app.inject({ method: 'POST', url: '/api/browser/acc1/close', headers: admin, payload: { save: false } });
    expect(calls.close).toEqual([{ accountId: 'acc1', save: false }]);
  });

  it("checks the live of the account's own profile, independently of other profiles", async () => {
    clubPhase = 'live'; // DPRTMNT is live; the default profile is not
    const club = await app.inject({ method: 'POST', url: '/api/browser/acc2/open', headers: admin, payload: { url: 'https://www.instagram.com/' } });
    expect(club.statusCode).toBe(409);
    expect(club.json()).toMatchObject({ code: 'account_live' });
    const main = await app.inject({ method: 'POST', url: '/api/browser/acc1/open', headers: admin, payload: { url: 'https://www.instagram.com/' } });
    expect(main.statusCode).toBe(200);
    expect(calls.viewerPage).toEqual([{ accountId: 'acc1', url: 'https://www.instagram.com/' }]);

    // Closing the live club account's dialog keeps its context; the idle one closes normally.
    await app.inject({ method: 'POST', url: '/api/browser/acc2/close', headers: admin, payload: { save: false } });
    await app.inject({ method: 'POST', url: '/api/browser/acc1/close', headers: admin, payload: { save: false } });
    expect(calls.close).toEqual([{ accountId: 'acc1', save: false }]);
  });

  it('ends the viewer with 4401 once the admin session is revoked or demoted', async () => {
    const previous = viewerTimings.sessionRecheckMs;
    viewerTimings.sessionRecheckMs = 50;
    try {
      sessions.set('tok-1', 'u1');
      const withCookie = { ...admin, cookie: `${SESSION_COOKIE}=tok-1` };

      // Logout / password change elsewhere: the session row disappears.
      const a = await connect(wsBase, '/api/browser/acc1/ws', withCookie);
      await waitUntil(() => a.messages.length > 0);
      await new Promise((r) => setTimeout(r, 150));
      expect(a.closed.code).toBeNull(); // still valid: stays open
      sessions.delete('tok-1');
      await waitUntil(() => a.closed.code !== null);
      expect(a.closed.code).toBe(4401);
      await waitUntil(() => calls.save.length === 1); // the viewer's session is still saved

      // Demotion to operator.
      sessions.set('tok-1', 'u1');
      const b = await connect(wsBase, '/api/browser/acc1/ws', withCookie);
      await waitUntil(() => b.messages.length > 0);
      userRole = 'operator';
      await waitUntil(() => b.closed.code !== null);
      expect(b.closed.code).toBe(4401);

      // User deleted.
      userRole = 'admin';
      const d = await connect(wsBase, '/api/browser/acc1/ws', withCookie);
      await waitUntil(() => d.messages.length > 0);
      userRole = null;
      await waitUntil(() => d.closed.code !== null);
      expect(d.closed.code).toBe(4401);
    } finally {
      viewerTimings.sessionRecheckMs = previous;
    }
  });

  it('rejects a websocket for an unknown account', async () => {
    const c = await connect(wsBase, '/api/browser/missing/ws', admin);
    await waitUntil(() => c.closed.code !== null);
    expect(c.closed.code).toBe(4404);
    expect(c.messages).toEqual([{ type: 'error', message: 'Account not found' }]);
  });
});
