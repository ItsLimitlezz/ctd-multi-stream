import Fastify, { type FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TitleResponse } from '../../../../shared/api.js';
import type { SessionState, TitleResult, User } from '../../../../shared/types.js';
import { EventBus } from '../../events.js';
import { unknownProfileError } from '../../orchestrator/registry.js';
import { testModeLockedError } from '../../orchestrator/test-mode.js';
import type { AppServices, Orchestrator } from '../../services.js';
import sessionRoutes from './session.js';

function fakeOrchestrator(profileId = 'default') {
  const state: SessionState = {
    profileId,
    status: 'offline',
    sessionId: null,
    startedAt: null,
    title: '',
    autoGoLive: true,
    feeds: [],
    destinations: [],
  };
  const results: TitleResult[] = [{ destinationId: 'd1', ok: true }];
  const orch = {
    profileId,
    init: vi.fn(async () => {}),
    state: vi.fn(() => ({ ...state })),
    start: vi.fn(async () => {
      state.status = 'live';
    }),
    stop: vi.fn(async () => {
      state.status = 'offline';
    }),
    setTitle: vi.fn(async (t: string) => {
      state.title = t.trim();
      return results;
    }),
    setAutoGoLive: vi.fn((v: boolean) => {
      state.autoGoLive = v;
    }),
    setTestMode: vi.fn((v: boolean) => {
      if (state.status !== 'offline') throw testModeLockedError();
      state.testMode = v;
    }),
    destinationChanged: vi.fn(async () => {}),
    destinationRemoved: vi.fn(async () => {}),
    retryDestination: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  } satisfies Orchestrator;
  return orch;
}

const USER: User = {
  id: 'u1',
  username: 'alice',
  role: 'operator',
  totpEnabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
};

let app: FastifyInstance | null = null;

async function build() {
  const orchestrator = fakeOrchestrator();
  const club = fakeOrchestrator('club');
  const byId = new Map<string, Orchestrator>([
    ['default', orchestrator],
    ['club', club],
  ]);
  const audits: { action: string; detail?: string | null; userId: string | null }[] = [];
  const services = {
    log: pino({ level: 'silent' }),
    bus: new EventBus(),
    orchestrators: {
      get: (id: string) => {
        const o = byId.get(id);
        if (!o) throw unknownProfileError();
        return o;
      },
    },
    repos: {
      audit: { log: (e: (typeof audits)[number]) => void audits.push(e) },
      profiles: { get: (id: string) => (id === 'club' ? { id, name: 'DPRTMNT' } : null) },
    },
  } as unknown as AppServices;

  const instance = Fastify();
  instance.decorateRequest('user', null);
  instance.decorateRequest('authSession', null);
  // Stand-in for the auth plugin: header `x-test-user: 1` logs the request in.
  instance.addHook('onRequest', async (req) => {
    req.user = req.headers['x-test-user'] ? USER : null;
  });
  await instance.register(sessionRoutes, { services });
  await instance.ready();
  app = instance;
  return { app: instance, orchestrator, club, audits };
}

afterEach(async () => {
  await app?.close();
  app = null;
});

const auth = { 'x-test-user': '1' };

describe('session routes', () => {
  it('require a logged-in user', async () => {
    const { app } = await build();
    for (const [method, url] of [
      ['GET', '/api/session'],
      ['POST', '/api/session/start'],
      ['POST', '/api/session/stop'],
      ['PUT', '/api/session/title'],
      ['PUT', '/api/session/auto'],
      ['PUT', '/api/session/test-mode'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('GET /api/session returns the state', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/api/session', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json<SessionState>().status).toBe('offline');
  });

  it('start and stop call the orchestrator and audit', async () => {
    const { app, orchestrator, audits } = await build();
    const started = await app.inject({ method: 'POST', url: '/api/session/start', headers: auth });
    expect(started.statusCode).toBe(200);
    expect(started.json<SessionState>().status).toBe('live');
    expect(orchestrator.start).toHaveBeenCalledWith('manual');

    const stopped = await app.inject({ method: 'POST', url: '/api/session/stop', headers: auth });
    expect(stopped.json<SessionState>().status).toBe('offline');
    expect(orchestrator.stop).toHaveBeenCalledWith('manual');
    expect(audits.map((a) => a.action)).toEqual(['session.start', 'session.stop']);
    expect(audits[0]?.userId).toBe('u1');
  });

  it('PUT /api/session/title validates, trims and returns results', async () => {
    const { app, orchestrator, audits } = await build();
    const tooLong = await app.inject({ method: 'PUT', url: '/api/session/title', headers: auth, payload: { title: 'x'.repeat(141) } });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json<{ code: string }>().code).toBe('invalid');
    const missing = await app.inject({ method: 'PUT', url: '/api/session/title', headers: auth, payload: {} });
    expect(missing.statusCode).toBe(400);
    expect(orchestrator.setTitle).not.toHaveBeenCalled();

    // 140 emoji = 280 UTF-16 units, still 140 characters.
    const emoji = await app.inject({ method: 'PUT', url: '/api/session/title', headers: auth, payload: { title: '😀'.repeat(140) } });
    expect(emoji.statusCode).toBe(200);

    const ok = await app.inject({ method: 'PUT', url: '/api/session/title', headers: auth, payload: { title: '  Friday stream  ' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<TitleResponse>()).toEqual({ title: 'Friday stream', results: [{ destinationId: 'd1', ok: true }] });
    expect(orchestrator.setTitle).toHaveBeenLastCalledWith('Friday stream');
    expect(audits.at(-1)).toMatchObject({ action: 'session.title', detail: 'Friday stream' });
  });

  it('PUT /api/session/auto toggles auto go-live', async () => {
    const { app, orchestrator, audits } = await build();
    const bad = await app.inject({ method: 'PUT', url: '/api/session/auto', headers: auth, payload: { autoGoLive: 'yes' } });
    expect(bad.statusCode).toBe(400);
    const res = await app.inject({ method: 'PUT', url: '/api/session/auto', headers: auth, payload: { autoGoLive: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json<SessionState>().autoGoLive).toBe(false);
    expect(orchestrator.setAutoGoLive).toHaveBeenCalledWith(false);
    expect(audits.at(-1)).toMatchObject({ action: 'session.auto', detail: 'off' });
  });

  it('PUT /api/session/test-mode validates, toggles, audits and returns the state', async () => {
    const { app, orchestrator, audits } = await build();
    for (const payload of [{}, { testMode: 'yes' }, { testMode: 1 }]) {
      const bad = await app.inject({ method: 'PUT', url: '/api/session/test-mode', headers: auth, payload });
      expect(bad.statusCode).toBe(400);
      expect(bad.json<{ code: string }>().code).toBe('invalid');
    }
    expect(orchestrator.setTestMode).not.toHaveBeenCalled();

    const on = await app.inject({ method: 'PUT', url: '/api/session/test-mode', headers: auth, payload: { testMode: true } });
    expect(on.statusCode).toBe(200);
    expect(on.json<SessionState>().testMode).toBe(true);
    expect(orchestrator.setTestMode).toHaveBeenCalledWith(true);
    expect(audits.at(-1)).toMatchObject({ action: 'session.test_mode', detail: 'on', userId: 'u1' });

    const off = await app.inject({ method: 'PUT', url: '/api/session/test-mode', headers: auth, payload: { testMode: false } });
    expect(off.json<SessionState>().testMode).toBe(false);
    expect(audits.at(-1)).toMatchObject({ action: 'session.test_mode', detail: 'off' });
  });

  it('PUT /api/session/test-mode answers 409 session_live while a session runs (no audit)', async () => {
    const { app, audits } = await build();
    await app.inject({ method: 'POST', url: '/api/session/start', headers: auth });
    const before = audits.length;
    const res = await app.inject({ method: 'PUT', url: '/api/session/test-mode', headers: auth, payload: { testMode: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: expect.stringContaining('End the stream first'), code: 'session_live' });
    expect(audits).toHaveLength(before);
  });

  it('every route acts on the ?profile= orchestrator (default profile when omitted)', async () => {
    const { app, orchestrator, club, audits } = await build();
    const started = await app.inject({ method: 'POST', url: '/api/session/start?profile=club', headers: auth });
    expect(started.statusCode).toBe(200);
    expect(started.json<SessionState>()).toMatchObject({ profileId: 'club', status: 'live' });
    expect(club.start).toHaveBeenCalledWith('manual');
    expect(orchestrator.start).not.toHaveBeenCalled();
    expect(audits.at(-1)).toMatchObject({ action: 'session.start', detail: 'profile: DPRTMNT' });

    const got = await app.inject({ method: 'GET', url: '/api/session?profile=club', headers: auth });
    expect(got.json<SessionState>()).toMatchObject({ profileId: 'club', status: 'live' });
    const main = await app.inject({ method: 'GET', url: '/api/session', headers: auth });
    expect(main.json<SessionState>()).toMatchObject({ profileId: 'default', status: 'offline' });
    const explicit = await app.inject({ method: 'GET', url: '/api/session?profile=default', headers: auth });
    expect(explicit.json<SessionState>().profileId).toBe('default');

    const title = await app.inject({ method: 'PUT', url: '/api/session/title?profile=club', headers: auth, payload: { title: 'Club night' } });
    expect(title.json<TitleResponse>().title).toBe('Club night');
    expect(club.setTitle).toHaveBeenCalledWith('Club night');
    expect(orchestrator.setTitle).not.toHaveBeenCalled();
    expect(audits.at(-1)).toMatchObject({ action: 'session.title', detail: 'profile: DPRTMNT; Club night' });

    await app.inject({ method: 'PUT', url: '/api/session/auto?profile=club', headers: auth, payload: { autoGoLive: false } });
    expect(club.setAutoGoLive).toHaveBeenCalledWith(false);
    // Club is live: test mode is locked there, but the default profile is offline and can switch.
    const locked = await app.inject({ method: 'PUT', url: '/api/session/test-mode?profile=club', headers: auth, payload: { testMode: true } });
    expect(locked.statusCode).toBe(409);
    const ok = await app.inject({ method: 'PUT', url: '/api/session/test-mode', headers: auth, payload: { testMode: true } });
    expect(ok.statusCode).toBe(200);
    expect(orchestrator.setTestMode).toHaveBeenCalledWith(true);

    const stopped = await app.inject({ method: 'POST', url: '/api/session/stop?profile=club', headers: auth });
    expect(stopped.json<SessionState>().status).toBe('offline');
    expect(club.stop).toHaveBeenCalledWith('manual');
    expect(orchestrator.stop).not.toHaveBeenCalled();
  });

  it('answers 404 unknown_profile / 400 invalid for a bad ?profile= on every route', async () => {
    const { app, orchestrator, audits } = await build();
    for (const [method, url, payload] of [
      ['GET', '/api/session', undefined],
      ['POST', '/api/session/start', undefined],
      ['POST', '/api/session/stop', undefined],
      ['PUT', '/api/session/title', { title: 'x' }],
      ['PUT', '/api/session/auto', { autoGoLive: true }],
      ['PUT', '/api/session/test-mode', { testMode: true }],
    ] as const) {
      const unknown = await app.inject({ method, url: `${url}?profile=nope`, headers: auth, ...(payload ? { payload } : {}) });
      expect(unknown.statusCode, `${method} ${url}`).toBe(404);
      expect(unknown.json()).toEqual({ error: 'Unknown profile', code: 'unknown_profile' });
      const repeated = await app.inject({ method, url: `${url}?profile=a&profile=b`, headers: auth, ...(payload ? { payload } : {}) });
      expect(repeated.statusCode, `${method} ${url}`).toBe(400);
      expect(repeated.json<{ code: string }>().code).toBe('invalid');
    }
    expect(orchestrator.start).not.toHaveBeenCalled();
    expect(orchestrator.setTitle).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
  });

  it('PUT /api/session/test-mode passes other orchestrator failures to the error handler', async () => {
    const { app, orchestrator } = await build();
    orchestrator.setTestMode.mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });
    const res = await app.inject({ method: 'PUT', url: '/api/session/test-mode', headers: auth, payload: { testMode: true } });
    expect(res.statusCode).toBe(500);
  });
});
