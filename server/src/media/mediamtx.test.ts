import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedState } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import { EventBus } from '../events.js';
import type { MediaServer } from '../services.js';
import type { MtxPath } from './feed-state.js';
import { createMediaServer, type MediaServerDeps } from './mediamtx.js';
import { captureLogger, fakeSpawn, flush, memorySecrets, type FakeChild } from './test-helpers.js';

let tmp: string;
let servers: MediaServer[] = [];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ctd-media-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.map((s) => s.stop()));
  servers = [];
  await fs.rm(tmp, { recursive: true, force: true });
});

/** A fake MediaMTX control API backed by a mutable path list. */
function fakeApi() {
  const paths: MtxPath[] = [
    { name: 'live/landscape', online: false, tracks2: [], inboundBytes: 0, source: null },
    { name: 'live/vertical', online: false, tracks2: [], inboundBytes: 0, source: null },
  ];
  const requests: { method: string; url: string }[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ method: init?.method ?? 'GET', url });
    if (url.includes('/v3/paths/list')) return new Response(JSON.stringify({ itemCount: paths.length, pageCount: 1, items: paths }));
    if (url.includes('/kick/')) return new Response(null, { status: 200 });
    return new Response('not found', { status: 404 });
  });
  const set = (name: string, patch: Partial<MtxPath>) => Object.assign(paths.find((p) => p.name === name)!, patch);
  return { fetch: fetchFn as unknown as typeof fetch, requests, set };
}

async function setup(opts: { bin?: string; secrets?: Record<string, string>; deps?: MediaServerDeps } = {}) {
  let bin = opts.bin;
  if (bin === undefined) {
    bin = path.join(tmp, process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');
    await fs.writeFile(bin, '');
    await fs.chmod(bin, 0o755);
  }
  const config = { dataDir: tmp, rtmpPort: 1935, mediamtxApiPort: 9997, mediamtxBin: bin } as AppConfig;
  const bus = new EventBus();
  const feedEvents: FeedState[] = [];
  bus.on('feed', (s) => feedEvents.push(s));
  const secrets = memorySecrets(opts.secrets);
  const sp = fakeSpawn();
  const api = fakeApi();
  const cap = captureLogger();
  const server = createMediaServer(
    { config, bus, log: cap.log, secrets },
    { spawn: sp.spawn, fetch: api.fetch, readyTimeoutMs: 0, pollIntervalMs: 10, ...opts.deps },
  );
  servers.push(server);
  const configPath = path.join(tmp, 'mediamtx', 'mediamtx.yml');
  const authUrl = async () => {
    const yml = await fs.readFile(configPath, 'utf8');
    const port = /authHTTPAddress: "http:\/\/127\.0\.0\.1:(\d+)\/auth"/.exec(yml)?.[1];
    return `http://127.0.0.1:${port}/auth`;
  };
  const child = (): FakeChild => sp.last()!.child;
  return { server, config, bus, feedEvents, secrets, sp, api, logs: cap.text, configPath, authUrl, child };
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function postAuth(url: string, body: Record<string, unknown>): Promise<number> {
  const res = await fetch(url, { method: 'POST', body: JSON.stringify({ user: '', password: '', ip: '192.168.1.9', protocol: 'rtmp', id: null, query: '', ...body }) });
  return res.status;
}

describe('MediaServer', () => {
  it('generates keys, writes the config and spawns MediaMTX', async () => {
    const { server, secrets, sp, configPath, authUrl } = await setup();
    await server.start();

    for (const k of ['landscape', 'vertical', 'internalReader']) expect(secrets.data.get(k)).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(await server.ingestKeys()).toEqual({ landscape: secrets.data.get('landscape'), vertical: secrets.data.get('vertical') });
    expect(server.appName).toBe('live');

    const yml = await fs.readFile(configPath, 'utf8');
    expect(yml).toContain('rtmpAddress: ":1935"');
    expect(yml).toContain('apiAddress: "127.0.0.1:9997"');

    expect(sp.calls).toHaveLength(1);
    expect(sp.calls[0]?.args).toEqual([configPath]);
    expect(sp.calls[0]?.options.cwd).toBe(path.dirname(configPath));

    const url = await authUrl();
    const key = secrets.data.get('landscape');
    expect(await postAuth(url, { action: 'publish', path: 'live/landscape', query: `key=${key}` })).toBe(200);
    expect(await postAuth(url, { action: 'publish', path: 'live/landscape', query: 'key=wrong' })).toBe(401);
    expect(await postAuth(url, { action: 'publish', path: 'live/other', query: `key=${key}` })).toBe(401);
    const pass = secrets.data.get('internalReader');
    expect(await postAuth(url, { action: 'read', path: 'live/landscape', ip: '127.0.0.1', user: 'internal', password: pass })).toBe(200);
    expect(await postAuth(url, { action: 'read', path: 'live/landscape', ip: '192.168.1.9', user: 'internal', password: pass })).toBe(401);

    expect(server.readUrl('vertical')).toBe(`rtmp://127.0.0.1:1935/live/vertical?user=internal&pass=${pass}`);
  });

  it('keeps stored keys across restarts', async () => {
    const stored = { landscape: 'AAAAAAAAAAAAAAAAAAAAAAAA', vertical: 'BBBBBBBBBBBBBBBBBBBBBBBB', internalReader: 'CCCCCCCCCCCCCCCCCCCCCCCC' };
    const { server, secrets } = await setup({ secrets: stored });
    await server.start();
    expect(Object.fromEntries(secrets.data)).toEqual(stored);
  });

  it('polls the control API and emits feed events', async () => {
    const { server, api, feedEvents } = await setup();
    await server.start();
    expect(server.feeds().map((f) => f.online)).toEqual([false, false]);

    api.set('live/landscape', {
      online: true,
      onlineTime: '2026-10-11T17:00:00Z',
      inboundBytes: 1000,
      tracks2: [{ codec: 'H264', codecProps: { width: 1280, height: 720 } }, { codec: 'MPEG-4 Audio', codecProps: { sampleRate: 48000, channelCount: 2 } }],
    });
    await waitFor(() => feedEvents.some((e) => e.online));
    expect(feedEvents[0]).toMatchObject({ feed: 'landscape', online: true, since: '2026-10-11T17:00:00.000Z', video: { codec: 'h264', width: 1280, height: 720 } });
    expect(server.feed('landscape').online).toBe(true);
    expect(server.feed('vertical').online).toBe(false);

    api.set('live/landscape', { online: false });
    await waitFor(() => feedEvents.at(-1)?.online === false);
    expect(feedEvents.filter((e) => e.feed === 'vertical')).toHaveLength(0); // never changed
  });

  it('restarts MediaMTX with backoff after an unexpected exit and keeps feeds offline meanwhile', async () => {
    vi.useFakeTimers();
    const { server, sp, child, logs } = await setup({ deps: { pollIntervalMs: 1000 } });
    await server.start();

    child().stdout.write('2026/10/11 17:00:00 ERR [RTMP] listen tcp :1935: bind: address already in use\n');
    await flush();
    child().exit(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(sp.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sp.calls).toHaveLength(2);

    child().exit(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(sp.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sp.calls).toHaveLength(3);

    expect(logs()).toContain('address already in use');
    expect(logs()).toContain('MediaMTX exited unexpectedly');
  });

  it('logs a clear error and stays offline when the binary is missing', async () => {
    const { server, sp, logs } = await setup({ bin: path.join(tmp, 'nope', 'mediamtx') });
    await expect(server.start()).resolves.toBeUndefined();
    expect(sp.calls).toHaveLength(0);
    expect(logs()).toContain('MediaMTX not found at');
    expect(logs()).toContain('npm run setup-tools');
    expect(server.feeds().every((f) => !f.online)).toBe(true);
  });

  it('does not restart when spawning fails with ENOENT', async () => {
    vi.useFakeTimers();
    const { server, sp, child, logs } = await setup({ bin: 'mediamtx-not-on-path' });
    await server.start();
    child().failToSpawn('ENOENT');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sp.calls).toHaveLength(1);
    expect(logs()).toContain('MediaMTX not found at mediamtx-not-on-path');
  });

  it('rotates a key, kicks the current publisher and only accepts the new key', async () => {
    const { server, api, secrets } = await setup();
    await server.start();
    const old = secrets.data.get('landscape')!;
    api.set('live/landscape', { online: true, source: { type: 'rtmpConn', id: 'conn-1' } });

    const next = await server.rotateIngestKey('landscape');
    expect(next).not.toBe(old);
    expect(next).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(secrets.data.get('landscape')).toBe(next);
    expect((await server.ingestKeys()).landscape).toBe(next);
    expect(api.requests).toContainEqual({ method: 'POST', url: 'http://127.0.0.1:9997/v3/rtmp/conns/kick/conn-1' });

    const req = { user: '', password: '', ip: '192.168.1.9', action: 'publish', path: 'live/landscape', protocol: 'rtmp', id: null } as const;
    expect(server.authorize({ ...req, query: `key=${old}` })).toBe(false);
    expect(server.authorize({ ...req, query: `key=${next}` })).toBe(true);
  });

  it('stop() terminates MediaMTX, closes the auth endpoint and marks feeds offline', async () => {
    const { server, api, child, authUrl, feedEvents } = await setup();
    await server.start();
    api.set('live/vertical', { online: true, tracks2: [{ codec: 'H264' }] });
    await waitFor(() => feedEvents.some((e) => e.feed === 'vertical' && e.online));

    const proc = child();
    const url = await authUrl();
    await server.stop();
    expect(proc.signals).toHaveLength(1);
    expect(feedEvents.at(-1)).toMatchObject({ feed: 'vertical', online: false });
    await expect(fetch(url, { method: 'POST', body: '{}' })).rejects.toThrow();
    expect(() => server.readUrl('landscape')).not.toThrow(); // keys stay cached
  });

  it('forwards MediaMTX log lines without secrets', async () => {
    const { server, child, logs } = await setup();
    await server.start();
    child().stdout.write('2026/10/11 17:00:00 INF [RTMP] [conn 192.168.1.9:5000] opened rtmp://192.168.1.2/live/landscape?key=TOPSECRETKEY9\n');
    child().stderr.write('2026/10/11 17:00:01 WAR [RTMP] query key=TOPSECRETKEY9&pass=hunter22 rejected\n');
    await flush();
    expect(logs()).toContain('mediamtx: INF [RTMP] [conn 192.168.1.9:5000] opened rtmp://192.168.1.2');
    expect(logs()).not.toContain('TOPSECRETKEY9');
    expect(logs()).not.toContain('hunter22');
  });

  it('readUrl() before start() throws', async () => {
    const { server } = await setup();
    expect(() => server.readUrl('landscape')).toThrow(/not started/);
  });
});
