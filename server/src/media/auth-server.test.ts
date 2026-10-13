import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaMtxAuthRequest } from '../services.js';
import { parseAuthBody, startAuthServer, type AuthServer } from './auth-server.js';
import { captureLogger } from './test-helpers.js';

const body = {
  user: '',
  password: '',
  token: '',
  ip: '192.168.1.5',
  action: 'publish',
  path: 'live/landscape',
  protocol: 'rtmp',
  id: '7c8e5f3a-0000-4000-8000-000000000000',
  query: 'key=secretkey123',
  userAgent: 'obs',
};

describe('parseAuthBody', () => {
  it('maps the MediaMTX payload', () => {
    expect(parseAuthBody(JSON.stringify(body))).toEqual({
      user: '',
      password: '',
      ip: '192.168.1.5',
      action: 'publish',
      path: 'live/landscape',
      protocol: 'rtmp',
      id: body.id,
      query: 'key=secretkey123',
    });
  });

  it('tolerates missing fields but rejects unknown actions and non-objects', () => {
    expect(parseAuthBody('{"action":"read"}')).toMatchObject({ action: 'read', user: '', query: '', id: null });
    expect(parseAuthBody('{"action":"delete"}')).toBeNull();
    expect(parseAuthBody('[]')).toBeNull();
    expect(parseAuthBody('nope')).toBeNull();
  });
});

describe('startAuthServer', () => {
  let server: AuthServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  async function start(authorize: (r: MediaMtxAuthRequest) => boolean) {
    const cap = captureLogger();
    server = await startAuthServer({ authorize, log: cap.log });
    return { url: `http://127.0.0.1:${server.port}`, logs: cap.text };
  }

  it('answers 200 / 401 from the decision function', async () => {
    const decide = vi.fn((r: MediaMtxAuthRequest) => r.query === 'key=secretkey123');
    const { url, logs } = await start(decide);
    expect(server?.port).toBeGreaterThan(0);

    const ok = await fetch(`${url}/auth`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    expect(ok.status).toBe(200);
    const denied = await fetch(`${url}/auth`, { method: 'POST', body: JSON.stringify({ ...body, query: 'key=wrong' }) });
    expect(denied.status).toBe(401);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(logs()).toContain('Rejected media publish request');
    expect(logs()).not.toContain('wrong');
  });

  it('rejects bad JSON, other routes and oversized bodies', async () => {
    const decide = vi.fn(() => true);
    const { url } = await start(decide);
    expect((await fetch(`${url}/auth`, { method: 'POST', body: '{not json' })).status).toBe(400);
    expect((await fetch(`${url}/auth`, { method: 'GET' })).status).toBe(404);
    expect((await fetch(`${url}/other`, { method: 'POST', body: '{}' })).status).toBe(404);
    const big = JSON.stringify({ ...body, query: 'x'.repeat(20_000) });
    expect((await fetch(`${url}/auth`, { method: 'POST', body: big })).status).toBe(413);
    expect(decide).not.toHaveBeenCalled();
  });

  it('denies when the decision function throws', async () => {
    const { url } = await start(() => {
      throw new Error('boom');
    });
    expect((await fetch(`${url}/auth`, { method: 'POST', body: JSON.stringify(body) })).status).toBe(401);
  });

  it('only listens on loopback and stops on close()', async () => {
    const { url } = await start(() => true);
    await server?.close();
    await expect(fetch(`${url}/auth`, { method: 'POST', body: '{}' })).rejects.toThrow();
  });
});
