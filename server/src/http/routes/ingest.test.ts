import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import type { IngestInfo } from '../../../../shared/api.js';
import type { User } from '../../../../shared/types.js';
import type { AppServices } from '../../services.js';
import ingestRoutes, { ingestHost } from './ingest.js';

const admin: User = { id: 'u1', username: 'admin', role: 'admin', totpEnabled: false, createdAt: '', lastLoginAt: null };

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function build(opts: { user?: User | null; ingestHostSetting?: string } = {}) {
  const keys = { landscape: 'LandKey000000000000000000', vertical: 'VertKey000000000000000000' };
  const media = {
    appName: 'live',
    ingestKeys: vi.fn(async () => ({ ...keys })),
    rotateIngestKey: vi.fn(async (feed: 'landscape' | 'vertical') => {
      keys[feed] = 'RotatedKey00000000000000';
      return keys[feed];
    }),
  };
  const auditLog = vi.fn();
  const services = {
    config: { rtmpPort: 1935 },
    media,
    repos: { audit: { log: auditLog } },
    appSettings: () => ({ publicBaseUrl: '', ingestHost: opts.ingestHostSetting ?? '', disconnectGraceSec: 15 }),
  } as unknown as AppServices;

  const user = opts.user === undefined ? admin : opts.user;
  app = Fastify();
  app.decorateRequest('user', null);
  app.decorateRequest('authSession', null);
  app.addHook('onRequest', async (req) => {
    req.user = user;
  });
  app.setErrorHandler((err, _req, reply) => reply.code(err instanceof ZodError ? 400 : 500).send({ error: String(err) }));
  await app.register(ingestRoutes, { services });
  return { app, media, auditLog };
}

describe('ingestHost', () => {
  it('prefers the setting, else the request host, and normalizes it', () => {
    expect(ingestHost('', '192.168.1.20')).toBe('192.168.1.20');
    expect(ingestHost('  nas.lan  ', '192.168.1.20')).toBe('nas.lan');
    expect(ingestHost('rtmp://nas.lan:1935/live', 'x')).toBe('nas.lan');
    expect(ingestHost('nas.lan:1935', 'x')).toBe('nas.lan');
    expect(ingestHost('', '[::1]')).toBe('[::1]');
    expect(ingestHost('fe80::1', 'x')).toBe('[fe80::1]');
    expect(ingestHost('', '')).toBe('localhost');
  });
});

describe('ingest routes', () => {
  it('GET /api/ingest returns the OBS server URL and per-feed keys', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/api/ingest', headers: { host: '192.168.1.20:8443' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json<IngestInfo>()).toEqual({
      serverUrl: 'rtmp://192.168.1.20:1935/live',
      feeds: [
        { feed: 'landscape', streamKey: 'landscape?key=LandKey000000000000000000', fullUrl: 'rtmp://192.168.1.20:1935/live/landscape?key=LandKey000000000000000000' },
        { feed: 'vertical', streamKey: 'vertical?key=VertKey000000000000000000', fullUrl: 'rtmp://192.168.1.20:1935/live/vertical?key=VertKey000000000000000000' },
      ],
    });
  });

  it('uses the ingestHost setting when set', async () => {
    const { app } = await build({ ingestHostSetting: 'nas.lan' });
    const res = await app.inject({ method: 'GET', url: '/api/ingest', headers: { host: 'public.example.com' } });
    expect(res.json<IngestInfo>().serverUrl).toBe('rtmp://nas.lan:1935/live');
  });

  it('POST /api/ingest/rotate rotates one feed and audits it', async () => {
    const { app, media, auditLog } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/ingest/rotate', payload: { feed: 'vertical' }, headers: { host: 'nas.lan' } });
    expect(res.statusCode).toBe(200);
    expect(media.rotateIngestKey).toHaveBeenCalledWith('vertical');
    expect(res.json<IngestInfo>().feeds[1]?.streamKey).toBe('vertical?key=RotatedKey00000000000000');
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', action: 'ingest.rotate', detail: 'vertical' }));
    expect(JSON.stringify(auditLog.mock.calls)).not.toContain('RotatedKey');
  });

  it('validates the feed', async () => {
    const { app, media } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/ingest/rotate', payload: { feed: 'square' } });
    expect(res.statusCode).toBe(400);
    expect(media.rotateIngestKey).not.toHaveBeenCalled();
  });

  it('is admin-only', async () => {
    const operator: User = { ...admin, role: 'operator' };
    expect((await (await build({ user: operator })).app.inject({ method: 'GET', url: '/api/ingest' })).statusCode).toBe(403);
    await app?.close();
    const anon = await build({ user: null });
    expect((await anon.app.inject({ method: 'GET', url: '/api/ingest' })).statusCode).toBe(401);
    expect((await anon.app.inject({ method: 'POST', url: '/api/ingest/rotate', payload: { feed: 'vertical' } })).statusCode).toBe(401);
    expect(anon.media.rotateIngestKey).not.toHaveBeenCalled();
  });
});
