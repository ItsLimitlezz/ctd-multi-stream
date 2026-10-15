// Account routes vs. a running live: delete ordering and the browser-login guard.

import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, DestinationPhase, PlatformInfo } from '../../../../shared/types.js';
import { EventBus } from '../../events.js';
import type { PlatformDriver } from '../../platforms/types.js';
import type { AppServices } from '../../services.js';
import accountRoutes from './accounts.js';

const ACCOUNT: Account = {
  id: 'acc1',
  profileId: 'default',
  platform: 'tiktok',
  label: 'TikTok',
  status: 'connected',
  statusMessage: null,
  options: {},
  createdAt: '',
  updatedAt: '',
};

function driver(connectMethod: PlatformInfo['connectMethod']): PlatformDriver {
  return {
    info: { id: 'tiktok', name: 'TikTok', connectMethod, accountFields: [] } as unknown as PlatformInfo,
    startConnect: vi.fn(async () => ({ method: 'browser', startUrl: 'https://www.tiktok.com/login' })),
    completeConnect: vi.fn(async () => ({ status: 'connected' as const })),
  } as unknown as PlatformDriver;
}

function setup(connectMethod: PlatformInfo['connectMethod'] = 'browser') {
  const order: string[] = [];
  let phase: DestinationPhase = 'idle';
  const accounts = new Map<string, Account>([[ACCOUNT.id, { ...ACCOUNT }]]);
  const dests = new Map<string, { id: string; profileId: string; accountId: string | null }>([
    ['d1', { id: 'd1', profileId: 'default', accountId: 'acc1' }],
    ['d2', { id: 'd2', profileId: 'default', accountId: 'acc1' }],
    ['d3', { id: 'd3', profileId: 'default', accountId: 'other' }],
  ]);
  const drv = driver(connectMethod);
  const step = (name: string) => async () => {
    order.push(name);
  };
  // The default profile's engine (every account/destination here belongs to it).
  const orchestrator = {
    profileId: 'default',
    state: () => ({ profileId: 'default', destinations: [{ destinationId: 'd1', profileId: 'default', phase }] }),
    destinationChanged: vi.fn(async (id: string) => {
      order.push(`changed:${id}:start`);
      // The retired runner's end() runs here, while the session and tokens still exist.
      await new Promise((r) => setTimeout(r, 20));
      if (id === 'd2') throw new Error('end failed');
      order.push(`changed:${id}:done`);
    }),
  };
  const services = {
    log: pino({ level: 'silent' }),
    bus: new EventBus(),
    repos: {
      accounts: {
        get: (id: string) => accounts.get(id) ?? null,
        update: (id: string, patch: Partial<Account>) => {
          const next = { ...accounts.get(id)!, ...patch };
          accounts.set(id, next);
          return next;
        },
        delete: (id: string) => {
          order.push('accounts.delete');
          accounts.delete(id);
        },
      },
      destinations: {
        list: () => [...dests.values()],
        get: (id: string) => dests.get(id) ?? null,
        detachAccount: (id: string) => {
          order.push('detach');
          for (const d of dests.values()) if (d.accountId === id) d.accountId = null;
        },
      },
      secrets: { deleteScope: (scope: string) => order.push(`deleteScope:${scope}`) },
      audit: { log: () => {} },
    },
    platforms: { get: () => drv, all: () => [drv] },
    orchestrators: {
      get: (id: string) => {
        if (id !== 'default') throw Object.assign(new Error('Profile not found'), { statusCode: 404, code: 'unknown_profile' });
        return orchestrator;
      },
      all: () => [orchestrator],
    },
    browser: { close: vi.fn(step('browser.close')), clear: vi.fn(step('browser.clear')) },
    driverContext: async () => ({}),
  } as unknown as AppServices;
  return { services, order, accounts, drv, setPhase: (p: DestinationPhase) => (phase = p) };
}

let app: FastifyInstance;

async function build(services: AppServices) {
  app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('authSession', null);
  app.addHook('onRequest', async (req) => {
    req.user = { id: 'u1', username: 'admin', role: 'admin', totpEnabled: false, createdAt: '', lastLoginAt: null };
  });
  await app.register(accountRoutes, { services });
  await app.ready();
}

afterEach(async () => {
  await app?.close();
});

describe('DELETE /api/accounts/:id ordering', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(async () => {
    fx = setup();
    await build(fx.services);
  });

  it('retires the live runners before wiping the browser session and tokens', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/accounts/acc1' });
    expect(res.statusCode).toBe(200);
    const at = (name: string) => fx.order.indexOf(name);
    expect(at('detach')).toBe(0);
    for (const later of ['browser.close', 'browser.clear', 'deleteScope:account:acc1', 'deleteScope:browser:acc1', 'accounts.delete']) {
      expect(at(later), later).toBeGreaterThan(at('changed:d1:done'));
      expect(at(later), later).toBeGreaterThan(at('changed:d2:start'));
    }
    expect(at('browser.clear')).toBeGreaterThan(at('browser.close'));
    // Runners are retired in parallel, and one failing doesn't stop the cleanup.
    expect(at('changed:d2:start')).toBeLessThan(at('changed:d1:done'));
    expect(fx.order).not.toContain('changed:d3:start');
    expect(fx.accounts.has('acc1')).toBe(false);
  });
});

describe('browser login while the account is live', () => {
  it('refuses connect and complete with 409 before marking the account pending', async () => {
    const fx = setup();
    await build(fx.services);
    fx.setPhase('live');
    const start = await app.inject({ method: 'POST', url: '/api/accounts/acc1/connect', payload: {} });
    expect(start.statusCode).toBe(409);
    expect(start.json()).toMatchObject({ code: 'account_live' });
    expect(fx.drv.startConnect).not.toHaveBeenCalled();
    expect(fx.accounts.get('acc1')?.status).toBe('connected');

    const complete = await app.inject({ method: 'POST', url: '/api/accounts/acc1/connect/complete', payload: {} });
    expect(complete.statusCode).toBe(409);
    expect(fx.drv.completeConnect).not.toHaveBeenCalled();

    fx.setPhase('error'); // the runner gave up: logging in again is allowed
    const again = await app.inject({ method: 'POST', url: '/api/accounts/acc1/connect', payload: {} });
    expect(again.statusCode).toBe(200);
    expect(fx.accounts.get('acc1')?.status).toBe('pending');
  });

  it('does not block non-browser (OAuth/device) reconnects', async () => {
    const fx = setup('device-code');
    await build(fx.services);
    fx.setPhase('live');
    const res = await app.inject({ method: 'POST', url: '/api/accounts/acc1/connect', payload: {} });
    expect(res.statusCode).toBe(200);
  });
});
