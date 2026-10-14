import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER, SESSION_COOKIE, type ApiTokensResponse, type CreateApiTokenResponse } from '../../../../shared/api.js';
import type { Role } from '../../../../shared/types.js';
import { createTestApi, type TestApi } from '../../api/test-helpers.js';
import { MAX_API_TOKENS } from './tokens.js';

let t: TestApi;

beforeEach(async () => {
  t = await createTestApi();
});
afterEach(async () => {
  await t.close();
});

function login(role: Role = 'admin', username = role) {
  const user = t.repos.users.create({ username, passwordHash: 'x', role });
  const { record, token } = t.repos.authSessions.create(user.id, { ip: null, userAgent: null });
  return { cookie: `${SESSION_COOKIE}=${token}`, csrf: record.csrfToken };
}

type Session = ReturnType<typeof login>;

function call(s: Session | null, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, opts: { csrf?: boolean; host?: string } = {}) {
  const headers: Record<string, string> = { host: opts.host ?? '192.168.1.20:30443' };
  if (s) headers.cookie = s.cookie;
  if (s && opts.csrf !== false) headers[CSRF_HEADER] = s.csrf;
  return t.app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
}

describe('/api/tokens', () => {
  it('is admin only', async () => {
    expect((await call(null, 'GET', '/api/tokens')).statusCode).toBe(401);
    const op = login('operator');
    expect((await call(op, 'GET', '/api/tokens')).statusCode).toBe(403);
    expect((await call(op, 'POST', '/api/tokens', { name: 'x', scopes: ['chat:read'] })).statusCode).toBe(403);
    expect(t.repos.apiTokens.list()).toEqual([]);
  });

  it('lists tokens (never secrets) with the access info', async () => {
    const admin = login();
    const res = await call(admin, 'GET', '/api/tokens');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.json<ApiTokensResponse>();
    expect(body).toEqual({
      tokens: [],
      access: {
        baseUrl: 'https://203.0.113.7/api/v1',
        lanBaseUrl: 'http://192.168.1.20:30080/api/v1', // TrueNAS: HTTPS 30443 -> HTTP 30080
        tlsFingerprint256: 'AA:BB',
        openApiUrl: 'https://203.0.113.7/api/v1/openapi.json',
      },
    });
  });

  it('creates a token: secret shown once, works on /api/v1, audited without the secret', async () => {
    const admin = login();
    const res = await call(admin, 'POST', '/api/tokens', { name: '  CTD Overlay  ', scopes: ['status:read', 'chat:read', 'chat:read'] });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { token, secret } = res.json<CreateApiTokenResponse>();
    expect(secret).toMatch(/^ctd_pat_[A-Za-z0-9_-]{43}$/);
    expect(token).toMatchObject({ name: 'CTD Overlay', scopes: ['chat:read', 'status:read'], prefix: secret.slice(0, 12), createdBy: 'admin', lastUsedAt: null });

    const list = (await call(admin, 'GET', '/api/tokens')).json<ApiTokensResponse>();
    expect(list.tokens).toEqual([token]);
    expect(JSON.stringify(list)).not.toContain(secret.slice(12));

    const me = await t.app.inject({ method: 'GET', url: '/api/v1/', headers: { authorization: `Bearer ${secret}` } });
    expect(me.json()).toMatchObject({ token: { name: 'CTD Overlay' } });

    const audit = t.repos.audit.list({ limit: 10 });
    expect(audit[0]).toMatchObject({ action: 'api_token.create', username: 'admin' });
    expect(JSON.stringify(audit)).not.toContain(secret.slice(12));
  });

  it('requires the CSRF header like every other state-changing request', async () => {
    const admin = login();
    const res = await call(admin, 'POST', '/api/tokens', { name: 'x', scopes: ['chat:read'] }, { csrf: false });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'csrf' });
    expect(t.repos.apiTokens.list()).toEqual([]);
  });

  it.each([
    [{ name: '', scopes: ['chat:read'] }],
    [{ name: '   ', scopes: ['chat:read'] }],
    [{ name: 'x'.repeat(61), scopes: ['chat:read'] }],
    [{ name: 'ok', scopes: [] }],
    [{ name: 'ok', scopes: ['admin'] }],
    [{ name: 'ok' }],
    [{ name: 'ok', scopes: ['chat:read'], extra: 1 }],
    [{ name: 'bad\u0000name', scopes: ['chat:read'] }],
    [{ name: 42, scopes: ['chat:read'] }],
  ])('rejects %j', async (payload) => {
    const res = await call(login(), 'POST', '/api/tokens', payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid' });
  });

  it('accepts a 60-character name', async () => {
    const res = await call(login(), 'POST', '/api/tokens', { name: 'n'.repeat(60), scopes: ['chat:read'] });
    expect(res.statusCode).toBe(200);
  });

  it(`caps the number of tokens at ${MAX_API_TOKENS}`, async () => {
    for (let i = 0; i < MAX_API_TOKENS; i++) t.repos.apiTokens.create({ name: `t${i}`, scopes: ['chat:read'], createdBy: null });
    const res = await call(login(), 'POST', '/api/tokens', { name: 'one more', scopes: ['chat:read'] });
    expect(res.statusCode).toBe(409);
  });

  it('revokes a token (immediately unusable) and audits it', async () => {
    const admin = login();
    const { token, secret } = (await call(admin, 'POST', '/api/tokens', { name: 'OBS', scopes: ['status:read'] })).json<CreateApiTokenResponse>();
    expect((await call(admin, 'DELETE', '/api/tokens/missing')).statusCode).toBe(404);
    expect((await call(admin, 'DELETE', `/api/tokens/${token.id}`, undefined, { csrf: false })).statusCode).toBe(403);
    const res = await call(admin, 'DELETE', `/api/tokens/${token.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    expect(t.repos.apiTokens.list()).toEqual([]);
    const v1 = await t.app.inject({ method: 'GET', url: '/api/v1/status', headers: { authorization: `Bearer ${secret}` } });
    expect(v1.statusCode).toBe(401);
    expect(t.repos.audit.list({ limit: 1 })[0]).toMatchObject({ action: 'api_token.delete' });
  });
});
