// Fixtures for the external API tests (excluded from the build).

import crypto from 'node:crypto';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import type { ApiScope, Destination, DestinationPhase, DestinationState, PlatformId, PlatformInfo, SessionState } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import { openDatabase } from '../db/database.js';
import { createRepos } from '../db/repos.js';
import { EventBus } from '../events.js';
import authPlugin from '../http/auth-plugin.js';
import { sendError } from '../http/guards.js';
import tokenRoutes from '../http/routes/tokens.js';
import { createSecretBox } from '../security/secretbox.js';
import type { AppServices, Repos, TlsManager } from '../services.js';
import dockRoutes from './dock.js';
import { EventHub } from './event-hub.js';
import { lanHttpPlugin } from './lan.js';
import v1Routes, { API_PREFIX } from './v1.js';

export function dest(id: string, over: Partial<Destination> = {}): Destination {
  return {
    id,
    platform: 'twitch',
    accountId: null,
    name: id.toUpperCase(),
    feed: 'landscape',
    enabled: true,
    options: {},
    ingestUrl: null,
    hasStreamKey: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

export function dstate(id: string, phase: DestinationPhase, over: Partial<DestinationState> = {}): DestinationState {
  return {
    destinationId: id,
    phase,
    message: null,
    stats: null,
    watchUrl: null,
    retries: 0,
    since: '2026-10-17T03:00:09.000Z',
    recoveries: 0,
    lastRecovery: null,
    ...over,
  };
}

export function session(over: Partial<SessionState> = {}): SessionState {
  return {
    status: 'live',
    sessionId: 's1',
    startedAt: '2026-10-17T03:00:04.000Z',
    title: 'DPRTMNT Saturday',
    autoGoLive: true,
    testMode: false,
    feeds: [
      { feed: 'landscape', online: true, since: '2026-10-17T02:59:58Z', video: { codec: 'H264', width: 1920, height: 1080 }, audio: null, bitrateKbps: 6012 },
      { feed: 'vertical', online: false, since: null, video: null, audio: null, bitrateKbps: null },
    ],
    destinations: [],
    ...over,
  };
}

export const silentLog = pino({ level: 'silent' });

/** Platforms with/without test mode, by id. */
export function platformInfo(platform: PlatformId): PlatformInfo {
  return { id: platform, name: platform[0]!.toUpperCase() + platform.slice(1), testMode: { supported: platform !== 'kick', description: '' } } as PlatformInfo;
}

export interface TestApi {
  app: FastifyInstance;
  services: AppServices;
  repos: Repos;
  bus: EventBus;
  hub: EventHub;
  /** Mutable orchestrator state returned by services.orchestrator.state(). */
  state: { current: SessionState };
  token(scopes?: ApiScope[], name?: string): string;
  close(): Promise<void>;
}

export async function createTestApi(opts: { tlsMode?: AppConfig['tlsMode']; heartbeatMs?: number; now?: () => number } = {}): Promise<TestApi> {
  const secretBox = createSecretBox(crypto.randomBytes(32));
  const db = openDatabase(':memory:');
  const repos = createRepos(db, secretBox);
  const bus = new EventBus();
  const state = { current: session({ status: 'offline', startedAt: null }) };
  const config = { tlsMode: opts.tlsMode ?? 'self-signed', version: '9.9.9', webPort: 8443, httpPort: 8080 } as AppConfig;
  const tls = {
    mode: config.tlsMode,
    status: () => ({ fingerprint256: 'AA:BB', mode: config.tlsMode }),
  } as unknown as TlsManager;
  const services = {
    config,
    log: silentLog,
    bus,
    repos,
    secretBox,
    tls,
    orchestrator: { state: () => state.current },
    platforms: { get: (p: PlatformId) => ({ info: platformInfo(p) }), all: () => [] },
    publicBaseUrl: () => 'https://203.0.113.7',
  } as unknown as AppServices;

  const hub = new EventHub({
    bus,
    log: silentLog,
    state: () => state.current,
    destinations: () => repos.destinations.list(),
    destination: (id) => repos.destinations.get(id),
    platformInfo,
    ...(opts.now ? { now: opts.now } : {}),
  });

  const app = Fastify();
  app.setNotFoundHandler((_req, reply) => sendError(reply, 404, 'Not found', 'not_found'));
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.tlsMode === 'off' ? null : [],
      },
    },
    hsts: config.tlsMode === 'off' ? false : { maxAge: 15552000, includeSubDomains: false },
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(websocket);
  await app.register(lanHttpPlugin, { services });
  await app.register(authPlugin, { services });
  await app.register(tokenRoutes, { services });
  await app.register(v1Routes, { services, hub, prefix: API_PREFIX, ...(opts.heartbeatMs ? { heartbeatMs: opts.heartbeatMs } : {}), ...(opts.now ? { now: opts.now } : {}) });
  await app.register(dockRoutes, { services });
  await app.ready();

  let closed = false;
  return {
    app,
    services,
    repos,
    bus,
    hub,
    state,
    token(scopes = ['chat:read', 'status:read'], name = 'test') {
      return repos.apiTokens.create({ name, scopes, createdBy: 'admin' }).secret;
    },
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
      hub.close();
      db.close();
    },
  };
}
