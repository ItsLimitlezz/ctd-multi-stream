// Tests for scripts/healthcheck.mjs (Docker HEALTHCHECK).
// Run: npx vitest run scripts   (part of the root config's "server" project, so `npm test` runs it too)

import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';
import { afterEach, describe, expect, it } from 'vitest';
import { checkHealth, healthcheckTarget } from './healthcheck.mjs';

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'healthcheck.mjs');

/** @type {Array<http.Server>} */
const servers = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise((resolve) => {
          s.closeAllConnections?.();
          s.close(() => resolve(undefined));
        }),
    ),
  );
});

/** @param {http.Server} server */
async function listen(server) {
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return addr.port;
}

/** @param {http.RequestListener} handler */
const httpServer = (handler) => listen(http.createServer(handler));

/** @param {http.RequestListener} handler */
async function httpsServer(handler) {
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'ctd-test.invalid' }], {
    keyType: 'ec',
    algorithm: 'sha256',
  });
  return listen(https.createServer({ key: pems.private, cert: pems.cert }, handler));
}

/** @type {http.RequestListener} */
const healthy = (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: '0.1.0' }));
  } else {
    res.writeHead(404).end();
  }
};

/** Run the script as Docker would. */
function runScript(/** @type {Record<string, string>} */ env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('healthcheckTarget', () => {
  it('defaults to https on 127.0.0.1:8443', () => {
    expect(healthcheckTarget({})).toEqual({ host: '127.0.0.1', port: 8443, tls: true });
  });

  it('follows WEB_PORT and TLS_MODE', () => {
    expect(healthcheckTarget({ WEB_PORT: '9443', TLS_MODE: 'letsencrypt' })).toEqual({
      host: '127.0.0.1',
      port: 9443,
      tls: true,
    });
    expect(healthcheckTarget({ WEB_PORT: ' 8080 ', TLS_MODE: 'off' }).tls).toBe(false);
    expect(healthcheckTarget({ TLS_MODE: 'OFF' }).tls).toBe(false);
    expect(healthcheckTarget({ TLS_MODE: 'self-signed' }).tls).toBe(true);
  });

  it('falls back to 8443 for invalid ports', () => {
    for (const WEB_PORT of ['', 'abc', '0', '70000', '-1', '80.5']) {
      expect(healthcheckTarget({ WEB_PORT }).port).toBe(8443);
    }
  });
});

describe('checkHealth', () => {
  it('is healthy for 200 {"ok":true} over http', async () => {
    const port = await httpServer(healthy);
    expect(await checkHealth({ host: '127.0.0.1', port, tls: false })).toEqual({ ok: true, reason: 'ok' });
  });

  it('is healthy over https with a self-signed certificate', async () => {
    const port = await httpsServer(healthy);
    expect(await checkHealth({ host: '127.0.0.1', port, tls: true })).toEqual({ ok: true, reason: 'ok' });
  });

  it('only skips certificate checks for its own request', async () => {
    const port = await httpsServer(healthy);
    await checkHealth({ host: '127.0.0.1', port, tls: true });
    const err = await new Promise((resolve) => {
      https.get({ host: '127.0.0.1', port, path: '/healthz', agent: false }, () => resolve(null)).on('error', resolve);
    });
    expect(err).toBeInstanceOf(Error);
  });

  it('is unhealthy for non-200 responses', async () => {
    const port = await httpServer((_req, res) => res.writeHead(503).end('{"ok":false}'));
    expect(await checkHealth({ host: '127.0.0.1', port, tls: false })).toEqual({ ok: false, reason: 'HTTP 503' });
  });

  it('is unhealthy when the body is not the health JSON (e.g. the SPA index.html)', async () => {
    const html = await httpServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<html>'));
    expect((await checkHealth({ host: '127.0.0.1', port: html, tls: false })).ok).toBe(false);
    const notOk = await httpServer((_req, res) => res.writeHead(200).end('{"ok":false}'));
    expect((await checkHealth({ host: '127.0.0.1', port: notOk, tls: false })).ok).toBe(false);
  });

  it('times out when the server never answers', async () => {
    const port = await httpServer(() => {
      /* never respond */
    });
    const started = Date.now();
    const result = await checkHealth({ host: '127.0.0.1', port, tls: false, timeoutMs: 300 });
    expect(result).toEqual({ ok: false, reason: 'timed out after 300 ms' });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('is unhealthy when nothing listens', async () => {
    const port = await httpServer(healthy);
    await new Promise((resolve) => servers.pop()?.close(() => resolve(undefined)));
    expect((await checkHealth({ host: '127.0.0.1', port, tls: false })).ok).toBe(false);
  });

  it('is unhealthy when the scheme does not match (https probe against plain http)', async () => {
    const port = await httpServer(healthy);
    expect((await checkHealth({ host: '127.0.0.1', port, tls: true, timeoutMs: 2000 })).ok).toBe(false);
  });

  it('never rejects on invalid options', async () => {
    expect((await checkHealth({ host: '127.0.0.1', port: 99999, tls: false })).ok).toBe(false);
  });
});

describe('CLI', () => {
  it('exits 0 when healthy', async () => {
    const port = await httpServer(healthy);
    const { code, stderr } = await runScript({ WEB_PORT: String(port), TLS_MODE: 'off' });
    expect(code).toBe(0);
    expect(stderr).toBe('');
  });

  it('exits 0 over https when TLS is on', async () => {
    const port = await httpsServer(healthy);
    const { code } = await runScript({ WEB_PORT: String(port), TLS_MODE: 'auto' });
    expect(code).toBe(0);
  });

  it('exits 1 with a reason when unhealthy', async () => {
    const port = await httpServer((_req, res) => res.writeHead(500).end());
    const { code, stderr } = await runScript({ WEB_PORT: String(port), TLS_MODE: 'off' });
    expect(code).toBe(1);
    expect(stderr).toContain(`unhealthy: http://127.0.0.1:${port}/healthz: HTTP 500`);
  });
});
