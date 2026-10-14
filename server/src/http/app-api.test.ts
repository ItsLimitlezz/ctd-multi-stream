// buildApp wiring of the external API: /api/v1 (bearer), /api/tokens, /dock, and the 404 split.

import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROBLEM_TYPE } from '../api/http.js';
import { session, silentLog } from '../api/test-helpers.js';
import type { AppConfig } from '../config.js';
import { openDatabase } from '../db/database.js';
import { createRepos } from '../db/repos.js';
import { EventBus } from '../events.js';
import { createPlatformRegistry } from '../platforms/registry.js';
import { createSecretBox } from '../security/secretbox.js';
import type { AppServices, Repos } from '../services.js';
import { buildApp } from './app.js';

let app: FastifyInstance;
let repos: Repos;
let bus: EventBus;

beforeAll(async () => {
  const secretBox = createSecretBox(crypto.randomBytes(32));
  repos = createRepos(openDatabase(':memory:'), secretBox);
  bus = new EventBus();
  const config = { tlsMode: 'off', version: '1.2.3', webPort: 8443, httpPort: 8080, trustProxy: false, rtmpPort: 1935 } as AppConfig;
  const services = {
    config,
    log: silentLog,
    bus,
    repos,
    secretBox,
    tls: { mode: 'off', status: () => ({ fingerprint256: null }) },
    orchestrator: { state: () => session({ status: 'offline', startedAt: null }) },
    chat: { recent: () => [], overlayToken: vi.fn(async () => 'T'.repeat(43)), rotateOverlayToken: vi.fn(), attach: vi.fn() },
    platforms: createPlatformRegistry(),
    media: { feeds: () => [], ingestKeys: async () => ({}), appName: 'live' },
    browser: {},
    pushes: {},
    appSettings: () => ({ publicBaseUrl: '', ingestHost: '', disconnectGraceSec: 15 }),
    publicBaseUrl: () => 'http://localhost:8443',
  } as unknown as AppServices;
  app = await buildApp(services, null);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('buildApp + external API', () => {
  it('serves /api/v1 with bearer tokens and problem+json errors', async () => {
    const { secret } = repos.apiTokens.create({ name: 'it', scopes: ['status:read', 'chat:read'], createdBy: null });
    const me = await app.inject({ method: 'GET', url: '/api/v1/', headers: { authorization: `Bearer ${secret}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ name: 'ctd-multi-stream', version: '1.2.3', apiVersion: 1 });
    const status = await app.inject({ method: 'GET', url: '/api/v1/status', headers: { authorization: `Bearer ${secret}` } });
    expect(status.statusCode).toBe(200);
    bus.emit('notice', { level: 'info', message: 'hello' });
    const poll = await app.inject({ method: 'GET', url: '/api/v1/events/poll?after=00000000000000000000000000', headers: { authorization: `Bearer ${secret}` } });
    expect(poll.json()).toMatchObject({ reset: true });

    const denied = await app.inject({ method: 'GET', url: '/api/v1/status' });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(denied.json()).toMatchObject({ type: PROBLEM_TYPE, code: 'unauthenticated' });
  });

  it('keeps the app 404 outside /api/v1 and problem+json inside it', async () => {
    const v1 = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(v1.statusCode).toBe(404);
    expect(v1.json()).toMatchObject({ code: 'not_found', type: PROBLEM_TYPE });
    const other = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(other.statusCode).toBe(404);
    expect(other.json()).toEqual({ error: 'Not found', code: 'not_found' });
  });

  it('serves the OBS dock and the admin token routes', async () => {
    const dock = await app.inject({ method: 'GET', url: '/dock' });
    expect(dock.statusCode).toBe(200);
    expect(dock.headers['content-security-policy']).toMatch(/script-src 'self'/);
    expect((await app.inject({ method: 'GET', url: '/api/tokens' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).statusCode).toBe(200);
  });
});
