// End-to-end auth flows through Fastify (inject): setup, sessions, CSRF, lockout, TOTP,
// user management and rate limits. Uses only this module's code plus fakes.

import crypto from 'node:crypto';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import pino, { type Logger } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { CSRF_HEADER, SESSION_COOKIE, type MeResponse, type TotpSetupResponse } from '../../../shared/api.js';
import type { AuditEntry, User } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import { openDatabase } from '../db/database.js';
import { createRepos } from '../db/repos.js';
import { createSecretBox } from '../security/secretbox.js';
import { announceSetupCodeIfNeeded } from '../security/setup-code.js';
import { base32Decode, totp } from '../security/totp.js';
import type { AppServices, Repos } from '../services.js';
import authPlugin from './auth-plugin.js';
import { requireUser, sendError } from './guards.js';
import auditRoutes from './routes/audit.js';
import authRoutes from './routes/auth.js';
import setupRoutes from './routes/setup.js';
import userRoutes from './routes/users.js';

const ADMIN_PW = 'admin-password-123';

interface TestApp {
  app: FastifyInstance;
  repos: Repos;
  setupCode: string;
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

let ipCounter = 0;
/** A fresh client address per call, so per-IP limits don't interfere between steps. */
function freshIp(): string {
  ipCounter++;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

async function buildTestApp(tlsMode: AppConfig['tlsMode'] = 'self-signed'): Promise<TestApp> {
  const secretBox = createSecretBox(crypto.randomBytes(32));
  const repos = createRepos(openDatabase(':memory:'), secretBox);
  const config = { tlsMode, version: 'test' } as AppConfig;
  const services = { config, log: pino({ level: 'silent' }), repos, secretBox } as unknown as AppServices;

  let setupCode = '';
  const fakeLog = {
    warn: (obj: { setupCode?: string }) => {
      setupCode = obj.setupCode ?? '';
    },
  } as unknown as Logger;
  announceSetupCodeIfNeeded(repos, fakeLog);

  const app = Fastify();
  apps.push(app);
  // Same mapping as http/app.ts.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return sendError(reply, 400, err.issues.map((i) => i.message).join('; '), 'invalid');
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return sendError(reply, e.statusCode, e.message ?? 'Bad request');
    return sendError(reply, 500, 'Internal error');
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(authPlugin, { services });
  await app.register(setupRoutes, { services });
  await app.register(authRoutes, { services });
  await app.register(userRoutes, { services });
  await app.register(auditRoutes, { services });
  // Stand-ins for other modules' routes.
  app.post('/api/echo', { preHandler: requireUser }, async () => ({ ok: true }));
  app.get('/api/ws', async () => ({ ok: true }));
  app.get('/overlay/ws', async () => ({ ok: true }));
  await app.ready();
  return { app, repos, setupCode };
}

interface Session {
  token: string;
  csrf: string;
  user: User;
}

function cookieOf(res: LightMyRequestResponse) {
  return res.cookies.find((c) => c.name === SESSION_COOKIE);
}

function toSession(res: LightMyRequestResponse): Session {
  expect(res.statusCode, res.body).toBe(200);
  const me = res.json<MeResponse>();
  const token = cookieOf(res)?.value;
  expect(token).toBeTruthy();
  return { token: token!, csrf: me.csrfToken, user: me.user };
}

function setup(t: TestApp, username = 'admin', password = ADMIN_PW) {
  return t.app.inject({
    method: 'POST',
    url: '/api/setup',
    remoteAddress: freshIp(),
    payload: { setupCode: t.setupCode, username, password },
  });
}

function login(t: TestApp, body: { username: string; password: string; totp?: string }, ip = freshIp()) {
  return t.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: ip, payload: body });
}

/** Authenticated request with session cookie + CSRF header. */
function call(t: TestApp, s: Session, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) {
  return t.app.inject({
    method,
    url,
    remoteAddress: freshIp(),
    cookies: { [SESSION_COOKIE]: s.token },
    headers: { [CSRF_HEADER]: s.csrf },
    ...(payload ? { payload } : {}),
  });
}

async function adminApp(): Promise<TestApp & { admin: Session }> {
  const t = await buildTestApp();
  const admin = toSession(await setup(t));
  return { ...t, admin };
}

describe('first-run setup', () => {
  it('requires the setup code, creates the admin and logs them in', async () => {
    const t = await buildTestApp();
    expect(t.setupCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect((await t.app.inject({ url: '/api/setup/status' })).json()).toEqual({ needsSetup: true });

    const wrong = await t.app.inject({
      method: 'POST',
      url: '/api/setup',
      remoteAddress: freshIp(),
      payload: { setupCode: 'AAAA-BBBB-CCCC', username: 'admin', password: ADMIN_PW },
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toMatchObject({ code: 'invalid_setup_code' });

    const weak = await setup(t, 'admin', 'short');
    expect(weak.statusCode).toBe(400);
    const badName = await setup(t, 'a b', ADMIN_PW);
    expect(badName.statusCode).toBe(400);
    expect(t.repos.users.count()).toBe(0);

    const ok = await setup(t);
    const s = toSession(ok);
    expect(s.user).toMatchObject({ username: 'admin', role: 'admin', totpEnabled: false });
    expect(s.user.lastLoginAt).not.toBeNull();
    expect(ok.json()).not.toHaveProperty('user.passwordHash');
    const c = cookieOf(ok)!;
    expect(c).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/', secure: true, maxAge: 30 * 24 * 3600 });

    expect((await t.app.inject({ url: '/api/setup/status' })).json()).toEqual({ needsSetup: false });
    const again = await setup(t, 'admin2');
    expect(again.statusCode).toBe(409);
    expect(t.repos.audit.list({ limit: 10 }).map((e) => e.action)).toContain('setup.complete');
  });

  it('omits the Secure cookie flag when TLS is off', async () => {
    const t = await buildTestApp('off');
    const res = await setup(t);
    expect(res.statusCode).toBe(200);
    expect(cookieOf(res)?.secure).toBeUndefined();
  });
});

describe('sessions and CSRF', () => {
  it('me -> CSRF rejection -> logout -> stale cookie', async () => {
    const t = await adminApp();
    const { admin } = t;

    const me = await t.app.inject({ url: '/api/auth/me', cookies: { [SESSION_COOKIE]: admin.token } });
    expect(me.statusCode).toBe(200);
    expect(me.json<MeResponse>()).toEqual({ user: admin.user, csrfToken: admin.csrf });
    expect(me.headers['cache-control']).toBe('no-store');
    expect(cookieOf(me)?.value).toBe(admin.token); // cookie refreshed

    const anon = await t.app.inject({ url: '/api/auth/me' });
    expect(anon.statusCode).toBe(401);
    expect(anon.json()).toMatchObject({ code: 'unauthenticated' });

    // State-changing requests need the CSRF header when a session exists.
    for (const headers of [{}, { [CSRF_HEADER]: 'wrong' }, { [CSRF_HEADER]: '' }]) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        cookies: { [SESSION_COOKIE]: admin.token },
        headers,
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'csrf' });
    }
    const echoNoCsrf = await t.app.inject({ method: 'POST', url: '/api/echo', cookies: { [SESSION_COOKIE]: admin.token } });
    expect(echoNoCsrf.statusCode).toBe(403);
    expect((await call(t, admin, 'POST', '/api/echo', {})).json()).toEqual({ ok: true });
    // Without a session the CSRF check is skipped and the route guard answers 401.
    expect((await t.app.inject({ method: 'POST', url: '/api/echo' })).statusCode).toBe(401);

    const out = await call(t, admin, 'POST', '/api/auth/logout', {});
    expect(out.statusCode).toBe(200);
    expect(cookieOf(out)?.maxAge).toBe(0);
    expect(t.repos.audit.list({ limit: 5 }).map((e) => e.action)).toContain('auth.logout');

    const stale = await t.app.inject({ url: '/api/auth/me', cookies: { [SESSION_COOKIE]: admin.token } });
    expect(stale.statusCode).toBe(401);
    expect(cookieOf(stale)?.value).toBe(''); // told to drop the dead cookie
  });

  it('login replaces the session the browser came with', async () => {
    const t = await adminApp();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: freshIp(),
      cookies: { [SESSION_COOKIE]: t.admin.token },
      payload: { username: 'ADMIN', password: ADMIN_PW }, // usernames are case-insensitive
    });
    const s = toSession(res);
    expect(s.token).not.toBe(t.admin.token);
    expect(t.repos.authSessions.touch(t.admin.token)).toBeNull();
    expect(t.repos.authSessions.touch(s.token)).not.toBeNull();
  });

  it('checks the Origin of /api WebSocket upgrades', async () => {
    const t = await buildTestApp();
    const ws = (url: string, host: string, origin?: string) =>
      t.app.inject({
        url,
        headers: { host, upgrade: 'websocket', connection: 'Upgrade', ...(origin ? { origin } : {}) },
      });
    expect((await ws('/api/ws', 'stream.example:8443', 'https://evil.example')).statusCode).toBe(403);
    expect((await ws('/api/ws', 'stream.example:8443', 'https://stream.example')).statusCode).toBe(403);
    expect((await ws('/api/ws', 'stream.example:8443')).json()).toMatchObject({ code: 'origin' });
    expect((await ws('/api/ws', 'stream.example:8443', 'null')).statusCode).toBe(403);
    expect((await ws('/api/ws', 'stream.example:8443', 'https://stream.example:8443')).statusCode).toBe(200);
    expect((await ws('/api/ws', 'stream.example', 'https://stream.example')).statusCode).toBe(200);
    expect((await ws('/api/ws', 'stream.example:443', 'https://stream.example')).statusCode).toBe(200);
    expect((await ws('/api/ws', '[2001:db8::1]:8443', 'https://[2001:db8::1]:8443')).statusCode).toBe(200);
    // Non-API paths (OBS overlay, token-authenticated) are not origin-checked.
    expect((await ws('/overlay/ws', 'stream.example:8443', 'https://evil.example')).statusCode).toBe(200);
  });
});

describe('login protection', () => {
  it('gives the same error for unknown users and wrong passwords, then locks after 5 failures', async () => {
    const t = await adminApp();

    const unknown = await login(t, { username: 'nobody', password: 'whatever-password' });
    const wrong = await login(t, { username: 'admin', password: 'wrong-password-1' });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
    expect(wrong.json()).toEqual({ error: 'Invalid username or password', code: 'invalid_credentials' });

    const ok = toSession(await login(t, { username: 'admin', password: ADMIN_PW }));
    expect(ok.user.lastLoginAt).not.toBeNull();
    expect(t.repos.users.get(ok.user.id)?.failedLogins).toBe(0); // reset on success

    const attacker = '198.51.100.10';
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await login(t, { username: 'admin', password: `nope-nope-${i}` }, attacker)).statusCode);
    expect(statuses).toEqual([401, 401, 401, 401, 423]);

    // The right password from the locked-out address gets the same reply as a wrong one.
    const locked = await login(t, { username: 'admin', password: ADMIN_PW }, attacker);
    const lockedWrong = await login(t, { username: 'admin', password: 'nope-nope-x' }, attacker);
    expect(locked.statusCode).toBe(423);
    expect(locked.json()).toMatchObject({ code: 'locked' });
    expect(locked.json<{ error: string }>().error).toMatch(/15 minutes/);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(lockedWrong.statusCode).toBe(423);
    expect(lockedWrong.json()).toEqual(locked.json());

    // Another address (the account owner) can still log in.
    toSession(await login(t, { username: 'admin', password: ADMIN_PW }));

    const actions = t.repos.audit.list({ limit: 50 });
    const failed = actions.filter((e) => e.action === 'auth.login_failed');
    expect(failed.map((e) => e.username)).toContain('nobody');
    expect(failed.filter((e) => e.username === 'admin')).toHaveLength(6);
    expect(actions.map((e) => e.action)).toContain('auth.locked');
  });

  it('locks unknown usernames exactly like real ones, so 423 does not reveal which exist', async () => {
    const t = await adminApp();
    const ipReal = '198.51.100.20';
    const ipGhost = '198.51.100.21';
    const real: LightMyRequestResponse[] = [];
    const ghost: LightMyRequestResponse[] = [];
    for (let i = 0; i < 6; i++) {
      real.push(await login(t, { username: 'admin', password: `wrong-password-${i}` }, ipReal));
      ghost.push(await login(t, { username: 'nobody', password: `wrong-password-${i}` }, ipGhost));
    }
    expect(real.map((r) => r.statusCode)).toEqual([401, 401, 401, 401, 423, 423]);
    for (let i = 0; i < 6; i++) {
      expect(ghost[i]!.statusCode).toBe(real[i]!.statusCode);
      expect(ghost[i]!.json()).toEqual(real[i]!.json());
      // Same Retry-After (allowing for the clock ticking between the two requests).
      expect(ghost[i]!.headers['retry-after'] === undefined).toBe(real[i]!.headers['retry-after'] === undefined);
      expect(Math.abs(Number(ghost[i]!.headers['retry-after'] ?? 0) - Number(real[i]!.headers['retry-after'] ?? 0))).toBeLessThanOrEqual(1);
    }
    // Case variants of an unknown name share its lock, like real usernames do.
    expect((await login(t, { username: 'NOBODY', password: 'wrong-password-x' }, ipGhost)).statusCode).toBe(423);
  });

  it('a concurrent burst gets no more guesses than sequential attempts', async () => {
    const t = await adminApp();
    const ip = '198.51.100.30';
    const burst = await Promise.all(
      Array.from({ length: 8 }, (_, i) => login(t, { username: 'admin', password: `burst-wrong-${i}` }, ip)),
    );
    const statuses = burst.map((r) => r.statusCode);
    // Five guesses are checked (the fifth locks); the rest are refused before hashing.
    expect(statuses.filter((s) => s === 401)).toHaveLength(4);
    expect(statuses.every((s) => s === 401 || s === 423 || s === 429)).toBe(true);
    const evaluated = t.repos.audit.list({ limit: 50 }).filter((e) => e.action === 'auth.login_failed' && e.username === 'admin');
    expect(evaluated).toHaveLength(5);

    // Afterwards the right and a wrong password are indistinguishable from this address.
    const right = await login(t, { username: 'admin', password: ADMIN_PW }, ip);
    const wrong = await login(t, { username: 'admin', password: 'burst-wrong-x' }, ip);
    expect(right.statusCode).toBe(423);
    expect(right.json()).toEqual(wrong.json());
    expect(Math.abs(Number(right.headers['retry-after']) - Number(wrong.headers['retry-after']))).toBeLessThanOrEqual(1);
  });

  it('an account-wide lock keeps out new addresses but not ones the account logged in from', async () => {
    const t = await adminApp();
    const home = '198.51.100.40';
    toSession(await login(t, { username: 'admin', password: ADMIN_PW }, home));
    // Simulate many failures spread over many addresses.
    t.repos.users.update(t.admin.user.id, { failedLogins: 49 });
    expect((await login(t, { username: 'admin', password: 'wrong-password-z' })).statusCode).toBe(423);
    expect(t.repos.users.get(t.admin.user.id)?.lockedUntil).not.toBeNull();
    expect((await login(t, { username: 'admin', password: ADMIN_PW })).statusCode).toBe(423);
    toSession(await login(t, { username: 'admin', password: ADMIN_PW }, home));
    expect(t.repos.users.get(t.admin.user.id)).toMatchObject({ failedLogins: 0, lockedUntil: null });
    // An admin-style reset clears the lock too.
    t.repos.users.update(t.admin.user.id, { failedLogins: 49 });
    expect((await login(t, { username: 'admin', password: 'wrong-password-z' })).statusCode).toBe(423);
    t.repos.users.update(t.admin.user.id, { lockedUntil: null });
    toSession(await login(t, { username: 'admin', password: ADMIN_PW }));
  });

  it('rate-limits credential routes per IP with code rate_limited', async () => {
    const t = await buildTestApp();
    const ip = '192.0.2.77';
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: ip, payload: {} });
      statuses.push(res.statusCode);
      if (i === 10) {
        expect(res.json()).toMatchObject({ code: 'rate_limited' });
        expect(res.headers['retry-after']).toBeDefined();
      }
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Other addresses and other routes are unaffected.
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '192.0.2.78', payload: {} })).statusCode).toBe(400);
    expect((await t.app.inject({ url: '/api/setup/status', remoteAddress: ip })).statusCode).toBe(200);
  });
});

describe('TOTP', () => {
  it('setup -> enable -> login requires code -> replay rejected -> disable', async () => {
    const t = await adminApp();
    const { admin } = t;

    // Enabling needs a pending secret first.
    expect((await call(t, admin, 'POST', '/api/auth/totp/enable', { code: '123456' })).json()).toMatchObject({
      code: 'totp_not_pending',
    });

    const setupRes = await call(t, admin, 'POST', '/api/auth/totp/setup', {});
    expect(setupRes.statusCode).toBe(200);
    const totpSetup = setupRes.json<TotpSetupResponse>();
    expect(totpSetup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(totpSetup.otpauthUrl).toBe(
      `otpauth://totp/CTD%20Multi-Stream:admin?secret=${totpSetup.secret}&issuer=CTD%20Multi-Stream`,
    );
    expect(totpSetup.qrSvg).toContain('<svg');
    const rec = t.repos.users.get(admin.user.id)!;
    expect(rec.totpPendingSecret).toMatch(/^v1:/); // encrypted at rest
    expect(rec.totpEnabled).toBe(false);

    const key = base32Decode(totpSetup.secret);
    const code = (offsetSteps = 0) => totp(key, Date.now() + offsetSteps * 30_000);

    const bad = await call(t, admin, 'POST', '/api/auth/totp/enable', { code: code() === '000000' ? '111111' : '000000' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'invalid_code' });

    // Capture the code once: logins below take a while (Argon2), so a 30 s step boundary may pass.
    const enableCode = code();
    expect((await call(t, admin, 'POST', '/api/auth/totp/enable', { code: enableCode })).statusCode).toBe(200);
    const enabled = t.repos.users.get(admin.user.id)!;
    expect(enabled).toMatchObject({ totpEnabled: true, totpPendingSecret: null });
    expect(enabled.totpSecret).toMatch(/^v1:/);
    expect((await call(t, admin, 'GET', '/api/auth/me')).json<MeResponse>().user.totpEnabled).toBe(true);
    expect((await call(t, admin, 'POST', '/api/auth/totp/setup', {})).statusCode).toBe(409);

    // Wrong password: generic error, no hint that TOTP is on.
    expect((await login(t, { username: 'admin', password: 'wrong-password-x' })).json()).toMatchObject({
      code: 'invalid_credentials',
    });
    // Right password, no code.
    const need = await login(t, { username: 'admin', password: ADMIN_PW });
    expect(need.statusCode).toBe(401);
    expect(need.json()).toMatchObject({ code: 'totp_required' });
    expect(cookieOf(need)).toBeUndefined();
    // Right password, wrong code.
    const wrongCode = await login(t, { username: 'admin', password: ADMIN_PW, totp: '99999x' });
    expect(wrongCode.statusCode).toBe(401);
    expect(wrongCode.json()).toMatchObject({ code: 'totp_required', error: 'Invalid two-factor code' });
    // Replaying the code used to enable is rejected; the next step's code works.
    expect((await login(t, { username: 'admin', password: ADMIN_PW, totp: enableCode })).statusCode).toBe(401);
    const next = code(1);
    const s = toSession(await login(t, { username: 'admin', password: ADMIN_PW, totp: next }));
    expect((await login(t, { username: 'admin', password: ADMIN_PW, totp: next })).statusCode).toBe(401);

    // Disable requires the password.
    const noPw = await call(t, s, 'POST', '/api/auth/totp/disable', { password: 'wrong-password-y' });
    expect(noPw.statusCode).toBe(400);
    expect(noPw.json()).toMatchObject({ code: 'invalid_password' });
    expect((await call(t, s, 'POST', '/api/auth/totp/disable', { password: ADMIN_PW })).statusCode).toBe(200);
    expect(t.repos.users.get(admin.user.id)).toMatchObject({ totpEnabled: false, totpSecret: null });
    toSession(await login(t, { username: 'admin', password: ADMIN_PW }));

    const actions = t.repos.audit.list({ limit: 100 }).map((e) => e.action);
    expect(actions).toContain('auth.totp_enabled');
    expect(actions).toContain('auth.totp_disabled');
  });
});

describe('password change', () => {
  it('verifies the current password and signs out other sessions', async () => {
    const t = await adminApp();
    const other = toSession(await login(t, { username: 'admin', password: ADMIN_PW }));

    const wrong = await call(t, t.admin, 'POST', '/api/auth/password', {
      currentPassword: 'not-my-password',
      newPassword: 'brand-new-password',
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toMatchObject({ code: 'invalid_password' });

    const weak = await call(t, t.admin, 'POST', '/api/auth/password', { currentPassword: ADMIN_PW, newPassword: 'short' });
    expect(weak.statusCode).toBe(400);

    const ok = await call(t, t.admin, 'POST', '/api/auth/password', {
      currentPassword: ADMIN_PW,
      newPassword: 'brand-new-password',
    });
    expect(ok.statusCode).toBe(200);
    expect((await call(t, t.admin, 'GET', '/api/auth/me')).statusCode).toBe(200);
    expect((await call(t, other, 'GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await login(t, { username: 'admin', password: ADMIN_PW })).statusCode).toBe(401);
    toSession(await login(t, { username: 'admin', password: 'brand-new-password' }));
  });
});

describe('user management', () => {
  it('admin-only CRUD with last-admin and self-delete protection', async () => {
    const t = await adminApp();
    const { admin } = t;

    const created = await call(t, admin, 'POST', '/api/users', { username: 'oper', password: 'operator-pass-1', role: 'operator' });
    expect(created.statusCode).toBe(200);
    const op = created.json<User>();
    expect(op).toMatchObject({ username: 'oper', role: 'operator' });
    expect(created.json()).not.toHaveProperty('passwordHash');

    const dup = await call(t, admin, 'POST', '/api/users', { username: 'OPER', password: 'operator-pass-1', role: 'admin' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ code: 'username_taken' });
    expect((await call(t, admin, 'POST', '/api/users', { username: 'x', password: 'short', role: 'boss' })).statusCode).toBe(400);

    // Operators can't manage users or read the audit log.
    const opSession = toSession(await login(t, { username: 'oper', password: 'operator-pass-1' }));
    for (const [method, url] of [
      ['GET', '/api/users'],
      ['GET', '/api/audit'],
    ] as const) {
      const res = await call(t, opSession, method, url);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'forbidden' });
    }
    expect((await call(t, opSession, 'DELETE', `/api/users/${admin.user.id}`)).statusCode).toBe(403);
    expect((await t.app.inject({ url: '/api/users' })).statusCode).toBe(401);

    const list = await call(t, admin, 'GET', '/api/users');
    expect(list.json<User[]>().map((u) => u.username)).toEqual(['admin', 'oper']);

    // Last admin can't be demoted or delete themselves.
    const demoteSelf = await call(t, admin, 'PATCH', `/api/users/${admin.user.id}`, { role: 'operator' });
    expect(demoteSelf.statusCode).toBe(409);
    expect(demoteSelf.json()).toMatchObject({ code: 'last_admin' });
    const deleteSelf = await call(t, admin, 'DELETE', `/api/users/${admin.user.id}`);
    expect(deleteSelf.statusCode).toBe(400);
    expect(deleteSelf.json()).toMatchObject({ code: 'cannot_delete_self' });

    // Password reset by an admin signs the user out and clears a lockout.
    t.repos.users.update(op.id, { lockedUntil: new Date(Date.now() + 600_000).toISOString(), failedLogins: 3 });
    const reset = await call(t, admin, 'PATCH', `/api/users/${op.id}`, { password: 'operator-pass-2' });
    expect(reset.statusCode).toBe(200);
    expect(t.repos.users.get(op.id)).toMatchObject({ lockedUntil: null, failedLogins: 0 });
    expect((await call(t, opSession, 'GET', '/api/auth/me')).statusCode).toBe(401);
    toSession(await login(t, { username: 'oper', password: 'operator-pass-2' }));

    // Promote op to admin; now the first admin can be demoted, and op can delete them.
    const promoted = await call(t, admin, 'PATCH', `/api/users/${op.id}`, { role: 'admin' });
    expect(promoted.json<User>().role).toBe('admin');
    const op2 = toSession(await login(t, { username: 'oper', password: 'operator-pass-2' }));
    expect((await call(t, op2, 'PATCH', `/api/users/${admin.user.id}`, { role: 'operator' })).json<User>().role).toBe('operator');
    // The demoted admin's next request already sees the new role.
    expect((await call(t, admin, 'GET', '/api/users')).statusCode).toBe(403);
    expect((await call(t, op2, 'DELETE', `/api/users/${admin.user.id}`)).statusCode).toBe(200);
    expect((await call(t, admin, 'GET', '/api/auth/me')).statusCode).toBe(401); // sessions gone with the user
    expect((await call(t, op2, 'PATCH', `/api/users/${op.id}`, { role: 'operator' })).json()).toMatchObject({ code: 'last_admin' });

    expect((await call(t, op2, 'PATCH', '/api/users/does-not-exist', { role: 'admin' })).statusCode).toBe(404);
    expect((await call(t, op2, 'DELETE', '/api/users/does-not-exist')).statusCode).toBe(404);

    const audit = (await call(t, op2, 'GET', '/api/audit?limit=200')).json<AuditEntry[]>();
    const actions = audit.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['user.create', 'user.update', 'user.delete', 'auth.login']));
    const update = audit.find((e) => e.action === 'user.update' && e.detail?.includes('password'));
    expect(update?.detail).toBe('oper: password reset');
    expect(update?.username).toBe('admin');
  });

  it('pages and validates the audit log query', async () => {
    const t = await adminApp();
    for (let i = 0; i < 5; i++) t.repos.audit.log({ userId: null, username: null, action: `test.${i}` });
    const first = (await call(t, t.admin, 'GET', '/api/audit?limit=2')).json<AuditEntry[]>();
    expect(first.map((e) => e.action)).toEqual(['test.4', 'test.3']);
    const next = (await call(t, t.admin, 'GET', `/api/audit?limit=2&before=${first[1]!.id}`)).json<AuditEntry[]>();
    expect(next.map((e) => e.action)).toEqual(['test.2', 'test.1']);
    expect((await call(t, t.admin, 'GET', '/api/audit?limit=1000')).statusCode).toBe(400);
    expect((await call(t, t.admin, 'GET', '/api/audit?before=abc')).statusCode).toBe(400);
    expect((await call(t, t.admin, 'GET', '/api/audit')).json<AuditEntry[]>().length).toBeGreaterThan(5);
  });
});
