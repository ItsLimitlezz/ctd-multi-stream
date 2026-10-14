// Route tests for the config API (platforms, accounts, destinations, settings) using Fastify
// inject, a fake auth hook (header x-test-role) and in-memory fakes of AppServices.

import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import type { ConnectPoll, PlatformAppStatus, SettingsResponse } from '../../../../shared/api.js';
import type { Account, Destination, PlatformInfo, TlsStatus } from '../../../../shared/types.js';
import { EventBus } from '../../events.js';
import { DriverError, type DriverContext, type PlatformDriver } from '../../platforms/types.js';
import type {
  AccountsRepo,
  AppServices,
  AuditRepo,
  BrowserManager,
  DestinationsRepo,
  Orchestrator,
  ScopedSecrets,
  SecretsRepo,
  SettingsRepo,
} from '../../services.js';
import { sendError } from '../guards.js';
import accountRoutes from './accounts.js';
import destinationRoutes from './destinations.js';
import platformRoutes from './platforms.js';
import settingsRoutes from './settings.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const BASE_URL = 'https://203.0.113.7';

function createFakeRepos() {
  let seq = 0;
  const nextId = (p: string) => `${p}${++seq}`;
  const now = () => new Date().toISOString();

  const accountMap = new Map<string, Account>();
  const accounts: AccountsRepo = {
    list: () => [...accountMap.values()],
    get: (id) => accountMap.get(id) ?? null,
    create(input) {
      const a: Account = { id: nextId('acc'), status: 'error', statusMessage: null, createdAt: now(), updatedAt: now(), ...input };
      accountMap.set(a.id, a);
      return a;
    },
    update(id, patch) {
      const a = accountMap.get(id);
      if (!a) throw new Error('no such account');
      const u = { ...a, ...patch, updatedAt: now() };
      accountMap.set(id, u);
      return u;
    },
    delete: (id) => void accountMap.delete(id),
  };

  const destMap = new Map<string, Destination>();
  const destinations: DestinationsRepo = {
    list: () => [...destMap.values()],
    get: (id) => destMap.get(id) ?? null,
    create(input) {
      const d: Destination = { id: nextId('dst'), hasStreamKey: false, createdAt: now(), updatedAt: now(), ...input };
      destMap.set(d.id, d);
      return d;
    },
    update(id, patch) {
      const d = destMap.get(id);
      if (!d) throw new Error('no such destination');
      const u = { ...d, ...patch, updatedAt: now() };
      destMap.set(id, u);
      return u;
    },
    delete: (id) => void destMap.delete(id),
    detachAccount(accountId) {
      for (const d of destMap.values()) if (d.accountId === accountId) destMap.set(d.id, { ...d, accountId: null });
    },
  };

  const settingsMap = new Map<string, unknown>();
  const settings: SettingsRepo = {
    get: <T>(key: string, fallback: T) => (settingsMap.has(key) ? (settingsMap.get(key) as T) : fallback),
    set: (key, value) => void settingsMap.set(key, structuredClone(value)),
    delete: (key) => void settingsMap.delete(key),
  };

  const secretStore = new Map<string, Map<string, string>>();
  const scoped = (scope: string): ScopedSecrets => {
    const m = () => {
      let s = secretStore.get(scope);
      if (!s) secretStore.set(scope, (s = new Map()));
      return s;
    };
    return {
      get: async (k) => m().get(k) ?? null,
      set: async (k, v) => void m().set(k, v),
      delete: async (k) => void m().delete(k),
      getJson: async <T>(k: string) => {
        const v = m().get(k);
        return v === undefined ? null : (JSON.parse(v) as T);
      },
      setJson: async (k, v) => void m().set(k, JSON.stringify(v)),
    };
  };
  const secrets: SecretsRepo = { scoped, deleteScope: (scope) => void secretStore.delete(scope) };

  const auditEntries: { action: string; detail: string | null; username: string | null }[] = [];
  const audit: AuditRepo = {
    log: (e) => void auditEntries.push({ action: e.action, detail: e.detail ?? null, username: e.username }),
    list: () => [],
  };

  return { accounts, destinations, settings, secrets, audit, secretStore, settingsMap, auditEntries };
}

const notUsed = async (): Promise<never> => {
  throw new Error('not used in these tests');
};

function baseInfo(over: Partial<PlatformInfo> & Pick<PlatformInfo, 'id' | 'name' | 'connectMethod'>): PlatformInfo {
  return {
    feeds: ['landscape'],
    defaultFeed: 'landscape',
    accountFields: [],
    destinationFields: [],
    developerApp: null,
    titleSupport: 'none',
    chatSupport: 'none',
    keyPerSession: false,
    experimental: false,
    ...over,
  };
}

const devApp = {
  consoleUrl: 'https://dev.example.com',
  instructions: 'Create an app',
  fields: [
    { key: 'clientId', label: 'Client ID', type: 'text' as const, required: true },
    { key: 'clientSecret', label: 'Client secret', type: 'secret' as const, required: true },
  ],
};

/** Device-code platform: first poll pending, second connected. */
function makeTwitch(): PlatformDriver {
  let polls = 0;
  return {
    info: baseInfo({
      id: 'twitch',
      name: 'Twitch',
      connectMethod: 'device-code',
      feeds: ['landscape', 'vertical'],
      developerApp: devApp,
      destinationFields: [
        {
          key: 'mode',
          label: 'Mode',
          type: 'select',
          default: 'copy',
          options: [
            { value: 'copy', label: 'Copy' },
            { value: 'multitrack', label: 'Dual Format' },
          ],
        },
      ],
    }),
    async startConnect() {
      polls = 0;
      return { method: 'device-code', userCode: 'ABCD-EFGH', verificationUri: 'https://twitch.tv/activate', expiresIn: 600, interval: 5 };
    },
    async pollConnect(_account, ctx) {
      polls += 1;
      if (polls < 2) return { status: 'pending' };
      await ctx.accountSecrets?.setJson('oauth', { accessToken: 'tok-secret' });
      await ctx.updateAccount({ status: 'connected', label: 'streamer_tv' });
      return { status: 'connected', account: {} as Account };
    },
    async checkAccount() {
      throw new DriverError('Twitch login expired', 'needs-login');
    },
    prepare: notUsed,
  };
}

/** OAuth paste-back platform with a required stream key and a defaulted server URL. */
function makeKick(seen: { pastedUrl?: string; ctx?: DriverContext }): PlatformDriver {
  return {
    info: baseInfo({
      id: 'kick',
      name: 'Kick',
      connectMethod: 'oauth-paste',
      developerApp: devApp,
      destinationFields: [
        { key: 'server', label: 'Server URL', type: 'url', target: 'ingestUrl', default: 'rtmps://ingest.kick.example/app' },
        { key: 'key', label: 'Stream key', type: 'secret', target: 'streamKey', required: true },
      ],
    }),
    async startConnect(account, ctx) {
      return {
        method: 'oauth-paste',
        authorizeUrl: `https://kick.example/oauth?state=${account.id}.rnd`,
        redirectUri: `${ctx.publicBaseUrl}/oauth/callback/kick`,
        instructions: 'Authorize',
      };
    },
    async completeConnect(_account, input, ctx) {
      seen.pastedUrl = input.pastedUrl;
      seen.ctx = ctx;
      const code = input.pastedUrl ? new URL(input.pastedUrl).searchParams.get('code') : null;
      if (code === 'good') {
        await ctx.updateAccount({ status: 'connected' });
        return { status: 'connected', account: {} as Account };
      }
      if (code === 'throw') throw new DriverError('Kick rejected the code', 'platform-error');
      if (code === 'crash') throw new Error('socket hang up');
      return { status: 'error', message: 'Invalid authorization code' };
    },
    prepare: notUsed,
  };
}

/** Browser platform with account options; check succeeds and renames the account. */
function makeFacebook(): PlatformDriver {
  return {
    info: baseInfo({
      id: 'facebook',
      name: 'Facebook',
      connectMethod: 'browser',
      accountFields: [
        {
          key: 'mode',
          label: 'Type',
          type: 'select',
          required: true,
          default: 'page',
          options: [
            { value: 'page', label: 'Page' },
            { value: 'profile', label: 'Profile' },
          ],
        },
        { key: 'pageId', label: 'Page ID', type: 'text' },
      ],
    }),
    async checkAccount() {
      return { status: 'connected', label: '  My Page  ' };
    },
    prepare: notUsed,
  };
}

/** Custom RTMP: no account, required server URL, optional stream key, typed options. */
function makeCustom(): PlatformDriver {
  return {
    info: baseInfo({
      id: 'custom',
      name: 'Custom RTMP',
      connectMethod: 'none',
      feeds: ['landscape', 'vertical'],
      destinationFields: [
        { key: 'url', label: 'Server URL', type: 'url', target: 'ingestUrl', required: true },
        { key: 'key', label: 'Stream key', type: 'secret', target: 'streamKey' },
        { key: 'bitrate', label: 'Bitrate', type: 'number', default: 6000 },
        { key: 'lowLatency', label: 'Low latency', type: 'boolean' },
      ],
    }),
    prepare: notUsed,
  };
}

/** Browser platform with a 'links' option (Instagram allows one link per live; rotated per live). */
function makeInstagram(): PlatformDriver {
  return {
    info: baseInfo({
      id: 'instagram',
      name: 'Instagram',
      connectMethod: 'browser',
      feeds: ['vertical'],
      defaultFeed: 'vertical',
      keyPerSession: true,
      destinationFields: [
        { key: 'autoRecover', label: 'Auto-recover', type: 'boolean', default: true },
        { key: 'links', label: 'Links', type: 'links' },
        {
          key: 'linkMode',
          label: 'Link mode',
          type: 'select',
          default: 'rotate',
          options: [
            { value: 'off', label: "Don't add a link" },
            { value: 'rotate', label: 'Rotate' },
            { value: 'first', label: 'First' },
          ],
        },
      ],
    }),
    prepare: notUsed,
  };
}

const tlsStatus: TlsStatus = {
  mode: 'self-signed',
  source: 'self-signed',
  subject: '203.0.113.7',
  notAfter: null,
  fingerprint256: 'AA:BB',
  publicIp: '203.0.113.7',
  lastError: null,
  nextRenewalAt: null,
};

function createFakeServices() {
  const repos = createFakeRepos();
  const bus = new EventBus();
  const log = pino({ level: 'silent' });
  const kickSeen: { pastedUrl?: string; ctx?: DriverContext } = {};
  const drivers = [makeTwitch(), makeKick(kickSeen), makeFacebook(), makeCustom(), makeInstagram()];

  const orchestrator = {
    destinationChanged: vi.fn(async (_id: string) => {}),
    destinationRemoved: vi.fn(async (_id: string) => {}),
    retryDestination: vi.fn(async (_id: string) => {}),
  };
  const browser = {
    close: vi.fn(async (_id: string, _opts?: { save?: boolean }) => {}),
    clear: vi.fn(async (_id: string) => {}),
  };

  const appSettings = () => ({ publicBaseUrl: '', ingestHost: '', disconnectGraceSec: 15, ...repos.settings.get('app', {}) });

  const driverContext: AppServices['driverContext'] = async ({ platform, accountId, destinationId, signal }) => {
    const app = await repos.secrets.scoped(`app:${platform}`).getJson<Record<string, string>>('values');
    return {
      log,
      accountSecrets: accountId ? repos.secrets.scoped(`account:${accountId}`) : null,
      destinationSecrets: destinationId ? repos.secrets.scoped(`destination:${destinationId}`) : null,
      app,
      browser: browser as unknown as BrowserManager,
      publicBaseUrl: BASE_URL,
      signal: signal ?? new AbortController().signal,
      async updateAccount(patch) {
        if (!accountId) return;
        bus.emit('account', repos.accounts.update(accountId, patch));
      },
    };
  };

  const services = {
    config: { version: '1.2.3' },
    log,
    bus,
    repos: { ...repos, users: {}, authSessions: {} },
    platforms: {
      get: (id: string) => {
        const d = drivers.find((x) => x.info.id === id);
        if (!d) throw new Error(`Unknown platform: ${id}`);
        return d;
      },
      all: () => drivers,
    },
    orchestrator: orchestrator as unknown as Orchestrator,
    browser: browser as unknown as BrowserManager,
    tls: { status: () => tlsStatus },
    appSettings,
    publicBaseUrl: () => BASE_URL,
    driverContext,
  } as unknown as AppServices;

  return { services, repos, bus, orchestrator, browser, kickSeen };
}

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

type Role = 'admin' | 'operator' | null;

async function buildTestApp(services: AppServices): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Same mapping as the app-level handler in http/app.ts.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return sendError(reply, 400, err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 'invalid');
    }
    if (err instanceof DriverError) return sendError(reply, 400, err.message, err.code);
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return sendError(reply, e.statusCode, e.message ?? 'Bad request');
    return sendError(reply, 500, 'Internal error');
  });
  await app.register(cookie);
  app.decorateRequest('user', null);
  app.decorateRequest('authSession', null);
  // Fake auth: the real auth plugin is another module.
  app.addHook('onRequest', async (req) => {
    const role = req.headers['x-test-role'];
    req.user =
      role === 'admin' || role === 'operator'
        ? { id: `user-${role}`, username: role, role, totpEnabled: false, createdAt: '', lastLoginAt: null }
        : null;
  });
  for (const routes of [platformRoutes, accountRoutes, destinationRoutes, settingsRoutes]) {
    await app.register(routes, { services });
  }
  await app.ready();
  return app;
}

let fx: ReturnType<typeof createFakeServices>;
let app: FastifyInstance;

beforeEach(async () => {
  fx = createFakeServices();
  app = await buildTestApp(fx.services);
});

afterEach(async () => {
  await app.close();
});

function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, role: Role = 'admin', payload?: unknown) {
  const headers: Record<string, string> = {};
  if (role) headers['x-test-role'] = role;
  return app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

async function createAccount(platform: string, extra: object = {}): Promise<Account> {
  const res = await call('POST', '/api/accounts', 'admin', { platform, ...extra });
  expect(res.statusCode).toBe(201);
  return res.json<Account>();
}

async function createDestination(body: object): Promise<Destination> {
  const res = await call('POST', '/api/destinations', 'admin', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json<Destination>();
}

// ---------------------------------------------------------------------------
// Platforms + developer apps
// ---------------------------------------------------------------------------

describe('platforms', () => {
  it('lists platform info for any user, not for anonymous', async () => {
    const res = await call('GET', '/api/platforms', 'operator');
    expect(res.statusCode).toBe(200);
    expect(res.json<PlatformInfo[]>().map((p) => p.id)).toEqual(['twitch', 'kick', 'facebook', 'custom', 'instagram']);
    expect((await call('GET', '/api/platforms', null)).statusCode).toBe(401);
  });

  it('platform apps are admin only', async () => {
    expect((await call('GET', '/api/platform-apps', 'operator')).statusCode).toBe(403);
    expect((await call('PUT', '/api/platform-apps/kick', 'operator', { values: {} })).statusCode).toBe(403);
  });

  it('reports status for platforms with a developer app only', async () => {
    const res = await call('GET', '/api/platform-apps');
    expect(res.statusCode).toBe(200);
    const list = res.json<PlatformAppStatus[]>();
    expect(list.map((s) => s.platform)).toEqual(['twitch', 'kick']);
    expect(list[0]).toEqual({ platform: 'twitch', configured: false, values: {}, secretsSet: { clientSecret: false }, redirectUri: null });
    expect(list[1]?.redirectUri).toBe(`${BASE_URL}/oauth/callback/kick`);
  });

  it('saves values, hides secrets and keeps a secret when submitted empty', async () => {
    let res = await call('PUT', '/api/platform-apps/kick', 'admin', { values: { clientId: ' id-1 ', clientSecret: 'shh-secret' } });
    expect(res.statusCode).toBe(200);
    expect(res.json<PlatformAppStatus>()).toMatchObject({
      platform: 'kick',
      configured: true,
      values: { clientId: 'id-1' },
      secretsSet: { clientSecret: true },
    });
    expect(res.body).not.toContain('shh-secret');

    res = await call('PUT', '/api/platform-apps/kick', 'admin', { values: { clientId: 'id-2', clientSecret: '' } });
    expect(res.json<PlatformAppStatus>()).toMatchObject({ configured: true, values: { clientId: 'id-2' } });
    const stored = await fx.repos.secrets.scoped('app:kick').getJson<Record<string, string>>('values');
    expect(stored).toEqual({ clientId: 'id-2', clientSecret: 'shh-secret' });

    // Clearing a non-secret field makes it unconfigured; the driver context sees the stored values.
    res = await call('PUT', '/api/platform-apps/kick', 'admin', { values: { clientId: '' } });
    expect(res.json<PlatformAppStatus>()).toMatchObject({ configured: false, values: {}, secretsSet: { clientSecret: true } });

    const auditDetails = fx.repos.auditEntries.filter((e) => e.action === 'platform-app.update').map((e) => e.detail);
    expect(auditDetails).toEqual(['kick: clientId, clientSecret', 'kick: clientId', 'kick: clientId']);
    expect(JSON.stringify(fx.repos.auditEntries)).not.toContain('shh-secret');
  });

  it('rejects unknown fields, unknown platforms and platforms without an app', async () => {
    expect((await call('PUT', '/api/platform-apps/kick', 'admin', { values: { nope: 'x' } })).statusCode).toBe(400);
    expect((await call('PUT', '/api/platform-apps/kick', 'admin', { values: { clientId: 5 } })).statusCode).toBe(400);
    expect((await call('PUT', '/api/platform-apps/myspace', 'admin', { values: {} })).statusCode).toBe(400);
    const res = await call('PUT', '/api/platform-apps/custom', 'admin', { values: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found' });
  });
});

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

describe('accounts', () => {
  it('is admin only', async () => {
    expect((await call('GET', '/api/accounts', 'operator')).statusCode).toBe(403);
    expect((await call('POST', '/api/accounts', 'operator', { platform: 'twitch' })).statusCode).toBe(403);
    expect((await call('GET', '/api/accounts', null)).statusCode).toBe(401);
  });

  it('creates pending accounts with default label and options', async () => {
    const events: Account[] = [];
    fx.bus.on('account', (a) => events.push(a));
    const account = await createAccount('facebook');
    expect(account).toMatchObject({ platform: 'facebook', label: 'Facebook', status: 'pending', options: { mode: 'page' } });
    expect(events).toHaveLength(1);
    expect(fx.repos.auditEntries.at(-1)).toMatchObject({ action: 'account.create', username: 'admin' });

    const named = await createAccount('facebook', { label: '  Fan page ', options: { mode: 'profile', pageId: 123 } });
    expect(named).toMatchObject({ label: 'Fan page', options: { mode: 'profile', pageId: '123' } });

    const list = await call('GET', '/api/accounts');
    expect(list.json<Account[]>()).toHaveLength(2);
  });

  it('validates account creation', async () => {
    const bad = async (body: object) => (await call('POST', '/api/accounts', 'admin', body)).statusCode;
    expect(await bad({ platform: 'custom' })).toBe(400); // connectMethod 'none'
    expect(await bad({ platform: 'nope' })).toBe(400);
    expect(await bad({ platform: 'facebook', options: { mode: 'group' } })).toBe(400);
    expect(await bad({ platform: 'facebook', options: { other: 1 } })).toBe(400);
    expect(await bad({ platform: 'facebook', label: 'x'.repeat(101) })).toBe(400);
  });

  it('updates label and merges options', async () => {
    const account = await createAccount('facebook', { options: { pageId: 'p1' } });
    let res = await call('PATCH', `/api/accounts/${account.id}`, 'admin', { label: 'Renamed', options: { mode: 'profile' } });
    expect(res.statusCode).toBe(200);
    expect(res.json<Account>()).toMatchObject({ label: 'Renamed', options: { mode: 'profile', pageId: 'p1' } });

    res = await call('PATCH', `/api/accounts/${account.id}`, 'admin', { options: { pageId: null } });
    expect(res.json<Account>().options).toEqual({ mode: 'profile' });
    expect((await call('PATCH', `/api/accounts/${account.id}`, 'admin', { options: { mode: 'x' } })).statusCode).toBe(400);
    expect((await call('PATCH', '/api/accounts/missing', 'admin', { label: 'x' })).statusCode).toBe(404);
  });

  it('runs the device-code flow', async () => {
    const account = await createAccount('twitch');
    fx.repos.accounts.update(account.id, { status: 'error', statusMessage: 'old' });

    let res = await call('POST', `/api/accounts/${account.id}/connect`, 'admin', {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ method: 'device-code', userCode: 'ABCD-EFGH' });
    expect(fx.repos.accounts.get(account.id)).toMatchObject({ status: 'pending', statusMessage: null });

    res = await call('POST', `/api/accounts/${account.id}/connect/poll`, 'admin', {});
    expect(res.json<ConnectPoll>()).toEqual({ status: 'pending' });

    res = await call('POST', `/api/accounts/${account.id}/connect/poll`, 'admin', {});
    const poll = res.json<ConnectPoll>();
    expect(poll.status).toBe('connected');
    if (poll.status === 'connected') expect(poll.account).toMatchObject({ id: account.id, status: 'connected', label: 'streamer_tv' });
    expect(res.body).not.toContain('tok-secret');
    expect(fx.repos.auditEntries.at(-1)).toMatchObject({ action: 'account.connect' });
  });

  it('returns 400 when the driver has no such connect step', async () => {
    const account = await createAccount('facebook');
    const res = await call('POST', `/api/accounts/${account.id}/connect`, 'admin', {});
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'unsupported' });
    expect((await call('POST', `/api/accounts/${account.id}/connect/poll`, 'admin', {})).statusCode).toBe(400);
    expect((await call('POST', '/api/accounts/missing/connect', 'admin', {})).statusCode).toBe(404);
  });

  it('completes an oauth-paste connection and records failures', async () => {
    const account = await createAccount('kick');
    let res = await call('POST', `/api/accounts/${account.id}/connect`, 'admin', {});
    expect(res.json()).toMatchObject({ method: 'oauth-paste', redirectUri: `${BASE_URL}/oauth/callback/kick` });

    res = await call('POST', `/api/accounts/${account.id}/connect/complete`, 'admin', {
      pastedUrl: `${BASE_URL}/oauth/callback/kick?code=bad&state=${account.id}.r`,
    });
    expect(res.json<ConnectPoll>()).toEqual({ status: 'error', message: 'Invalid authorization code' });
    expect(fx.repos.accounts.get(account.id)).toMatchObject({ status: 'error', statusMessage: 'Invalid authorization code' });

    res = await call('POST', `/api/accounts/${account.id}/connect/complete`, 'admin', {
      pastedUrl: ` ${BASE_URL}/oauth/callback/kick?code=good&state=${account.id}.r `,
    });
    expect(res.json<ConnectPoll>()).toMatchObject({ status: 'connected', account: { id: account.id, status: 'connected' } });

    res = await call('POST', `/api/accounts/${account.id}/connect/complete`, 'admin', {
      pastedUrl: `${BASE_URL}/oauth/callback/kick?code=throw`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'Kick rejected the code', code: 'platform-error' });
  });

  it('checks accounts and records driver errors', async () => {
    const fb = await createAccount('facebook');
    let res = await call('POST', `/api/accounts/${fb.id}/check`, 'admin', {});
    expect(res.statusCode).toBe(200);
    expect(res.json<Account>()).toMatchObject({ status: 'connected', label: 'My Page', statusMessage: null });

    const tw = await createAccount('twitch');
    res = await call('POST', `/api/accounts/${tw.id}/check`, 'admin', {});
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'needs-login' });
    expect(fx.repos.accounts.get(tw.id)).toMatchObject({ status: 'needs-login', statusMessage: 'Twitch login expired' });

    const kick = await createAccount('kick');
    expect((await call('POST', `/api/accounts/${kick.id}/check`, 'admin', {})).json()).toMatchObject({ code: 'unsupported' });
  });

  it('deletes an account with its secrets, browser session and destination links', async () => {
    const account = await createAccount('kick');
    await fx.repos.secrets.scoped(`account:${account.id}`).setJson('oauth', { accessToken: 't' });
    await fx.repos.secrets.scoped(`browser:${account.id}`).set('storageState', '{}');
    const dest = await createDestination({ platform: 'kick', accountId: account.id, name: 'Kick', feed: 'landscape', streamKey: 'k1' });
    fx.orchestrator.destinationChanged.mockClear();
    fx.browser.close.mockRejectedValueOnce(new Error('browser crashed'));
    let changedEvents = 0;
    fx.bus.on('destinations-changed', () => changedEvents++);

    const res = await call('DELETE', `/api/accounts/${account.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    expect(fx.browser.close).toHaveBeenCalledWith(account.id, { save: false });
    expect(fx.browser.clear).toHaveBeenCalledWith(account.id);
    expect(fx.repos.secretStore.has(`account:${account.id}`)).toBe(false);
    expect(fx.repos.secretStore.has(`browser:${account.id}`)).toBe(false);
    expect(fx.repos.accounts.get(account.id)).toBeNull();
    expect(fx.repos.destinations.get(dest.id)?.accountId).toBeNull();
    expect(fx.orchestrator.destinationChanged).toHaveBeenCalledWith(dest.id);
    expect(changedEvents).toBe(1);
    expect(fx.repos.auditEntries.at(-1)).toMatchObject({ action: 'account.delete' });
    expect((await call('DELETE', `/api/accounts/${account.id}`)).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// OAuth redirect landing
// ---------------------------------------------------------------------------

describe('GET /oauth/callback/:platform', () => {
  async function landing(url: string, role: Role, headers: Record<string, string> = {}) {
    return app.inject({ method: 'GET', url, headers: { ...headers, ...(role ? { 'x-test-role': role } : {}) } });
  }
  const errorOf = (location: string) => new URL(location, 'http://x').searchParams.get('error');

  it('sends anonymous users to /login', async () => {
    const res = await landing('/oauth/callback/kick?code=good&state=acc1.r', null);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('bounces cross-site arrivals once so the SameSite=Strict cookie is sent', async () => {
    const res = await landing(`/oauth/callback/kick?code=a'b&state=acc1.r`, null, { 'sec-fetch-site': 'cross-site' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('content="0;url=/oauth/callback/kick?code=a%27b&#38;state=acc1.r"');
    // Second, same-origin attempt without a session goes to the login page.
    const again = await landing('/oauth/callback/kick?code=a&state=acc1.r', null, { 'sec-fetch-site': 'same-origin' });
    expect(again.headers.location).toBe('/login');
  });

  it('completes the connection and redirects to the accounts page', async () => {
    const account = await createAccount('kick');
    const path = `/oauth/callback/kick?code=good&state=${account.id}.rnd123`;
    const res = await landing(path, 'admin');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/accounts?connected=${account.id}`);
    expect(fx.kickSeen.pastedUrl).toBe(`${BASE_URL}${path}`);
    expect(fx.repos.accounts.get(account.id)?.status).toBe('connected');
    expect(fx.repos.auditEntries.at(-1)).toMatchObject({ action: 'account.connect' });
  });

  it('redirects with an error for bad state, wrong platform, operators and denials', async () => {
    const kick = await createAccount('kick');
    const fb = await createAccount('facebook');
    const cases: [string, Role, RegExp][] = [
      ['/oauth/callback/kick?code=good&state=garbage', 'admin', /invalid or expired/],
      ['/oauth/callback/kick?code=good', 'admin', /invalid or expired/],
      ['/oauth/callback/kick?code=good&state=missing.r', 'admin', /invalid or expired/],
      [`/oauth/callback/kick?code=good&state=${fb.id}.r`, 'admin', /invalid or expired/],
      [`/oauth/callback/twitch?code=good&state=${kick.id}.r`, 'admin', /invalid or expired/],
      [`/oauth/callback/nope?code=good&state=${kick.id}.r`, 'admin', /invalid or expired/],
      [`/oauth/callback/kick?code=good&state=${kick.id}.r`, 'operator', /Only admins/],
      [`/oauth/callback/kick?error=access_denied&error_description=User%20denied&state=${kick.id}.r`, 'admin', /User denied/],
      [`/oauth/callback/kick?code=bad&state=${kick.id}.r`, 'admin', /Invalid authorization code/],
      [`/oauth/callback/kick?code=throw&state=${kick.id}.r`, 'admin', /Kick rejected the code/],
      [`/oauth/callback/kick?code=crash&state=${kick.id}.r`, 'admin', /failed/],
      [`/oauth/callback/facebook?code=good&state=${fb.id}.r`, 'admin', /cannot be connected this way/], // not oauth-paste
    ];
    for (const [url, role, message] of cases) {
      const res = await landing(url, role);
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location, url).toMatch(/^\/accounts\?error=/);
      expect(errorOf(String(res.headers.location)), url).toMatch(message);
      expect(String(res.headers.location)).not.toContain('socket hang up');
    }
    expect(fx.repos.accounts.get(kick.id)?.status).not.toBe('connected');
  });
});

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

describe('destinations', () => {
  it('creates a destination, stores the key encrypted and never returns it', async () => {
    let changedEvents = 0;
    fx.bus.on('destinations-changed', () => changedEvents++);
    const dest = await createDestination({
      platform: 'custom',
      name: '  Backup  ',
      feed: 'vertical',
      ingestUrl: ' rtmps://live.example.com/app ',
      streamKey: ' sk_live_SECRET ',
      options: { bitrate: '4500', lowLatency: 'true' },
    });
    expect(dest).toMatchObject({
      platform: 'custom',
      name: 'Backup',
      feed: 'vertical',
      enabled: true,
      accountId: null,
      ingestUrl: 'rtmps://live.example.com/app',
      hasStreamKey: true,
      options: { bitrate: 4500, lowLatency: true },
    });
    expect(await fx.repos.secrets.scoped(`destination:${dest.id}`).get('streamKey')).toBe('sk_live_SECRET');
    expect(fx.orchestrator.destinationChanged).toHaveBeenCalledWith(dest.id);
    expect(changedEvents).toBe(1);
    expect(fx.repos.auditEntries.at(-1)).toMatchObject({ action: 'destination.create' });
    expect(JSON.stringify(fx.repos.auditEntries)).not.toContain('SECRET');

    const list = await call('GET', '/api/destinations', 'operator');
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain('SECRET');
    expect(list.json<Destination[]>()[0]).not.toHaveProperty('streamKey');
  });

  it('applies field defaults', async () => {
    const dest = await createDestination({ platform: 'kick', name: 'Kick', feed: 'landscape', streamKey: 'k' });
    expect(dest.ingestUrl).toBe('rtmps://ingest.kick.example/app');
    const custom = await createDestination({ platform: 'custom', name: 'C', feed: 'landscape', ingestUrl: 'rtmp://h/app' });
    expect(custom).toMatchObject({ hasStreamKey: false, options: { bitrate: 6000 } });
    const tw = await createDestination({ platform: 'twitch', name: 'T', feed: 'vertical', enabled: false });
    expect(tw).toMatchObject({ enabled: false, options: { mode: 'copy' } });
  });

  it('validates creation', async () => {
    const fbAccount = await createAccount('facebook');
    const ok = { platform: 'custom', name: 'C', feed: 'landscape', ingestUrl: 'rtmp://h/app' };
    const cases: [object, RegExp][] = [
      [{ ...ok, ingestUrl: 'http://h/app' }, /rtmp/],
      [{ ...ok, ingestUrl: `rtmp://h/${'a'.repeat(2050)}` }, /2048/],
      [{ ...ok, ingestUrl: null }, /Server URL is required/],
      [{ ...ok, name: '   ' }, /Name is required/],
      [{ ...ok, feed: 'square' }, /feed/],
      [{ ...ok, options: { bogus: 1 } }, /Unknown option/],
      [{ ...ok, options: { key: 'smuggled' } }, /Unknown option: key/], // streamKey-target field not allowed in options
      [{ ...ok, options: { bitrate: 'fast' } }, /Bitrate must be a number/],
      [{ ...ok, streamKey: 'has space' }, /spaces/],
      [{ platform: 'kick', name: 'K', feed: 'landscape' }, /Stream key is required/],
      [{ platform: 'kick', name: 'K', feed: 'vertical', streamKey: 'k' }, /does not accept the vertical feed/],
      [{ platform: 'kick', name: 'K', feed: 'landscape', streamKey: 'k', accountId: fbAccount.id }, /not a Kick account/],
      [{ platform: 'kick', name: 'K', feed: 'landscape', streamKey: 'k', accountId: 'missing' }, /Account not found/],
      [{ platform: 'twitch', name: 'T', feed: 'landscape', streamKey: 'k' }, /do not take a stream key/],
      [{ platform: 'twitch', name: 'T', feed: 'landscape', ingestUrl: 'rtmp://h/a' }, /do not take a server URL/],
    ];
    for (const [body, message] of cases) {
      const res = await call('POST', '/api/destinations', 'admin', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json<{ error: string }>().error, JSON.stringify(body)).toMatch(message);
    }
    expect(fx.repos.destinations.list()).toHaveLength(0);
    expect(fx.orchestrator.destinationChanged).not.toHaveBeenCalled();
  });

  it('accepts an account of the same platform', async () => {
    const account = await createAccount('kick');
    const dest = await createDestination({ platform: 'kick', name: 'K', feed: 'landscape', streamKey: 'k', accountId: account.id });
    expect(dest.accountId).toBe(account.id);
  });

  it('patches with stream key keep / replace / clear semantics', async () => {
    const dest = await createDestination({ platform: 'custom', name: 'C', feed: 'landscape', ingestUrl: 'rtmp://h/app', streamKey: 'k1' });
    const keyOf = () => fx.repos.secrets.scoped(`destination:${dest.id}`).get('streamKey');
    fx.orchestrator.destinationChanged.mockClear();

    let res = await call('PATCH', `/api/destinations/${dest.id}`, 'admin', { name: 'Renamed', feed: 'vertical' });
    expect(res.statusCode).toBe(200);
    expect(res.json<Destination>()).toMatchObject({ name: 'Renamed', feed: 'vertical', hasStreamKey: true });
    expect(await keyOf()).toBe('k1');
    expect(fx.orchestrator.destinationChanged).toHaveBeenCalledWith(dest.id);

    res = await call('PATCH', `/api/destinations/${dest.id}`, 'admin', { streamKey: 'k2', options: { lowLatency: false } });
    expect(res.json<Destination>()).toMatchObject({ hasStreamKey: true, options: { bitrate: 6000, lowLatency: false } });
    expect(res.body).not.toContain('k2');
    expect(await keyOf()).toBe('k2');
    expect(fx.repos.auditEntries.at(-1)?.detail).toContain('fields=options,streamKey');
    expect(fx.repos.auditEntries.at(-1)?.detail).not.toContain('k2');

    res = await call('PATCH', `/api/destinations/${dest.id}`, 'admin', { streamKey: '' });
    expect(res.json<Destination>().hasStreamKey).toBe(false);
    expect(await keyOf()).toBeNull();

    res = await call('PATCH', `/api/destinations/${dest.id}`, 'admin', { streamKey: 'k3' });
    res = await call('PATCH', `/api/destinations/${dest.id}`, 'admin', { streamKey: null });
    expect(res.json<Destination>().hasStreamKey).toBe(false);
  });

  it('validates patches', async () => {
    const kickDest = await createDestination({ platform: 'kick', name: 'K', feed: 'landscape', streamKey: 'k1' });
    const fb = await createAccount('facebook');
    const cases: [object, RegExp][] = [
      [{ streamKey: null }, /Stream key is required/],
      [{ streamKey: '' }, /Stream key is required/],
      [{ feed: 'vertical' }, /does not accept/],
      [{ accountId: fb.id }, /not a Kick account/],
      [{ ingestUrl: 'https://nope' }, /rtmp/],
      [{ name: '' }, /Name is required/],
    ];
    for (const [body, message] of cases) {
      const res = await call('PATCH', `/api/destinations/${kickDest.id}`, 'admin', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json<{ error: string }>().error).toMatch(message);
    }
    expect(await fx.repos.secrets.scoped(`destination:${kickDest.id}`).get('streamKey')).toBe('k1');

    // Clearing the server URL falls back to the field default; accountId '' detaches.
    const res = await call('PATCH', `/api/destinations/${kickDest.id}`, 'admin', { ingestUrl: '', accountId: '' });
    expect(res.json<Destination>()).toMatchObject({ ingestUrl: 'rtmps://ingest.kick.example/app', accountId: null });
    expect((await call('PATCH', '/api/destinations/missing', 'admin', { name: 'x' })).statusCode).toBe(404);
  });

  it('deletes a destination and its secrets', async () => {
    const dest = await createDestination({ platform: 'custom', name: 'C', feed: 'landscape', ingestUrl: 'rtmp://h/app', streamKey: 'k1' });
    let changedEvents = 0;
    fx.bus.on('destinations-changed', () => changedEvents++);
    const res = await call('DELETE', `/api/destinations/${dest.id}`);
    expect(res.statusCode).toBe(200);
    expect(fx.orchestrator.destinationRemoved).toHaveBeenCalledWith(dest.id);
    expect(fx.repos.secretStore.has(`destination:${dest.id}`)).toBe(false);
    expect(fx.repos.destinations.get(dest.id)).toBeNull();
    expect(changedEvents).toBe(1);
    expect(fx.repos.auditEntries.at(-1)).toMatchObject({ action: 'destination.delete' });
    expect((await call('DELETE', `/api/destinations/${dest.id}`)).statusCode).toBe(404);
  });

  it('lets operators toggle and retry but not edit', async () => {
    const dest = await createDestination({ platform: 'custom', name: 'C', feed: 'landscape', ingestUrl: 'rtmp://h/app' });
    fx.orchestrator.destinationChanged.mockClear();

    let res = await call('PUT', `/api/destinations/${dest.id}/enabled`, 'operator', { enabled: false });
    expect(res.statusCode).toBe(200);
    expect(res.json<Destination>().enabled).toBe(false);
    expect(fx.orchestrator.destinationChanged).toHaveBeenCalledWith(dest.id);
    expect(fx.repos.auditEntries.at(-1)).toMatchObject({ action: 'destination.disable', username: 'operator' });
    expect((await call('PUT', `/api/destinations/${dest.id}/enabled`, 'operator', { enabled: 'no' })).statusCode).toBe(400);

    res = await call('POST', `/api/destinations/${dest.id}/retry`, 'operator', {});
    expect(res.statusCode).toBe(200);
    expect(fx.orchestrator.retryDestination).toHaveBeenCalledWith(dest.id);

    expect((await call('PATCH', `/api/destinations/${dest.id}`, 'operator', { name: 'x' })).statusCode).toBe(403);
    expect((await call('DELETE', `/api/destinations/${dest.id}`, 'operator')).statusCode).toBe(403);
    expect((await call('POST', '/api/destinations', 'operator', { platform: 'custom' })).statusCode).toBe(403);
    expect((await call('PUT', `/api/destinations/${dest.id}/enabled`, null, { enabled: true })).statusCode).toBe(401);
    expect((await call('POST', '/api/destinations/missing/retry', 'operator', {})).statusCode).toBe(404);
  });

  describe("'links' options", () => {
    const KICK = { title: 'Kick - Live Stream', url: 'https://kick.com/dprtmnttoronto' };
    const TWITCH = { title: 'Twitch - Live Stream', url: 'https://www.twitch.tv/dprtmnttoronto' };
    const ig = { platform: 'instagram', name: 'DPRTMNT', feed: 'vertical' };

    it('stores the list as an array and returns it unchanged', async () => {
      const created = await createDestination({
        ...ig,
        options: { links: [{ title: ' Kick - Live Stream ', url: KICK.url, index: 1 }, TWITCH], linkMode: 'rotate' },
      });
      expect(created.options).toEqual({ autoRecover: true, links: [KICK, TWITCH], linkMode: 'rotate' });
      expect(fx.repos.destinations.get(created.id)?.options.links).toEqual([KICK, TWITCH]);

      const list = await call('GET', '/api/destinations', 'operator');
      expect(list.statusCode).toBe(200);
      expect(list.json<Destination[]>().find((d) => d.id === created.id)?.options.links).toEqual([KICK, TWITCH]);

      // Missing → [] on create.
      const plain = await createDestination({ ...ig, name: 'Plain' });
      expect(plain.options.links).toEqual([]);
    });

    it('patches keep the list unless it is submitted', async () => {
      const dest = await createDestination({ ...ig, options: { links: [KICK, TWITCH] } });
      let res = await call('PATCH', `/api/destinations/${dest.id}`, 'admin', { options: { linkMode: 'first' } });
      expect(res.statusCode).toBe(200);
      expect(res.json<Destination>().options).toEqual({ autoRecover: true, links: [KICK, TWITCH], linkMode: 'first' });

      res = await call('PATCH', `/api/destinations/${dest.id}`, 'admin', { options: { links: [TWITCH, KICK] } });
      expect(res.json<Destination>().options.links).toEqual([TWITCH, KICK]);
      expect(fx.orchestrator.destinationChanged).toHaveBeenLastCalledWith(dest.id);

      res = await call('PATCH', `/api/destinations/${dest.id}`, 'admin', { options: { links: [] } });
      expect(res.json<Destination>().options.links).toEqual([]);
    });

    it('rejects invalid lists with a field-labelled message', async () => {
      const tooMany = Array.from({ length: 21 }, (_, i) => ({ title: `Link ${i}`, url: `https://example.com/${i}` }));
      const cases: [unknown, RegExp][] = [
        [tooMany, /^Links can have at most 20 links$/],
        [[{ title: 'Kick', url: 'kick.com/dprtmnttoronto' }], /^Links: link 1 URL must be a full http:\/\/ or https:\/\/ address$/],
        [[KICK, { title: 'Click me', url: 'javascript:alert(1)' }], /^Links: link 2 URL must be/],
        [[{ title: '   ', url: KICK.url }], /^Links: link 1 needs a title$/],
        [[{ title: 'x'.repeat(101), url: KICK.url }], /^Links: link 1 title must be at most 100 characters$/],
        ['https://kick.com/dprtmnttoronto', /^Links must be a list of links$/],
      ];
      for (const [links, message] of cases) {
        const res = await call('POST', '/api/destinations', 'admin', { ...ig, options: { links } });
        expect(res.statusCode, JSON.stringify(links).slice(0, 80)).toBe(400);
        expect(res.json<{ error: string }>().error).toMatch(message);
      }
      expect(fx.repos.destinations.list()).toHaveLength(0);

      const dest = await createDestination({ ...ig, options: { links: [KICK] } });
      const res = await call('PATCH', `/api/destinations/${dest.id}`, 'admin', {
        options: { links: [{ title: 'Bad', url: 'javascript:void(0)' }] },
      });
      expect(res.statusCode).toBe(400);
      expect(fx.repos.destinations.get(dest.id)?.options.links).toEqual([KICK]);
    });
  });

  it('does not fail the request when the orchestrator throws', async () => {
    fx.orchestrator.destinationChanged.mockRejectedValueOnce(new Error('boom'));
    const dest = await createDestination({ platform: 'custom', name: 'C', feed: 'landscape', ingestUrl: 'rtmp://h/app' });
    expect(fx.repos.destinations.get(dest.id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('settings', () => {
  it('returns settings, TLS status and version to admins only', async () => {
    const res = await call('GET', '/api/settings');
    expect(res.statusCode).toBe(200);
    expect(res.json<SettingsResponse>()).toEqual({
      settings: { publicBaseUrl: '', ingestHost: '', disconnectGraceSec: 15 },
      tls: tlsStatus,
      version: '1.2.3',
    });
    expect((await call('GET', '/api/settings', 'operator')).statusCode).toBe(403);
    expect((await call('PUT', '/api/settings', 'operator', { ingestHost: 'x' })).statusCode).toBe(403);
  });

  it('normalizes, merges and audits changed keys', async () => {
    fx.repos.settings.set('app', { disconnectGraceSec: 30 });
    const res = await call('PUT', '/api/settings', 'admin', {
      publicBaseUrl: 'https://stream.example.com/',
      ingestHost: '[2001:db8::5]',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<SettingsResponse>().settings).toEqual({
      publicBaseUrl: 'https://stream.example.com',
      ingestHost: '2001:db8::5',
      disconnectGraceSec: 30,
    });
    expect(fx.repos.settingsMap.get('app')).toEqual({
      disconnectGraceSec: 30,
      publicBaseUrl: 'https://stream.example.com',
      ingestHost: '2001:db8::5',
    });
    expect(fx.repos.auditEntries.at(-1)).toMatchObject({ action: 'settings.update', detail: 'publicBaseUrl, ingestHost' });

    // Unchanged values are not audited again.
    const count = fx.repos.auditEntries.length;
    const same = await call('PUT', '/api/settings', 'admin', { disconnectGraceSec: 30, ingestHost: '2001:db8::5' });
    expect(same.statusCode).toBe(200);
    expect(fx.repos.auditEntries).toHaveLength(count);

    await call('PUT', '/api/settings', 'admin', { publicBaseUrl: '', disconnectGraceSec: 0 });
    expect(fx.repos.settingsMap.get('app')).toMatchObject({ publicBaseUrl: '', disconnectGraceSec: 0 });
  });

  it('rejects invalid settings', async () => {
    const bad = [
      { publicBaseUrl: 'ftp://example.com' },
      { publicBaseUrl: 'example.com' },
      { ingestHost: 'rtmp://nas.lan' },
      { ingestHost: 'nas.lan:1935' },
      { disconnectGraceSec: 601 },
      { disconnectGraceSec: -1 },
      { disconnectGraceSec: 1.5 },
      { disconnectGraceSec: '10' },
      { unknown: true },
    ];
    for (const body of bad) {
      const res = await call('PUT', '/api/settings', 'admin', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(fx.repos.settingsMap.has('app')).toBe(false);
  });
});
