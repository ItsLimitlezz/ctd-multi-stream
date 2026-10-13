#!/usr/bin/env node
// Container health check (Docker HEALTHCHECK): GET /healthz on the local web port.
// Exit 0 = healthy, 1 = unhealthy. Plain Node, no dependencies.
//
// The web UI serves HTTPS unless TLS_MODE=off. Its certificate is issued for the public IP / domain
// (or self-signed), never for 127.0.0.1, so certificate verification is disabled for this single
// loopback request only.

import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Where to probe, derived from the same env vars the server reads (server/src/config.ts).
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ host: string; port: number; tls: boolean }}
 */
export function healthcheckTarget(env = process.env) {
  const raw = (env.WEB_PORT ?? '').trim();
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return {
    host: '127.0.0.1',
    port: port > 0 && port < 65536 ? port : 8443,
    tls: (env.TLS_MODE ?? 'auto').trim().toLowerCase() !== 'off',
  };
}

/**
 * Probe /healthz once: healthy = HTTP 200 with a JSON body `{ "ok": true, ... }`. Never rejects.
 * @param {{ host: string; port: number; tls: boolean; timeoutMs?: number }} target
 * @returns {Promise<{ ok: boolean; reason: string }>}
 */
export function checkHealth({ host, port, tls, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    /** @type {http.ClientRequest | undefined} */
    let req;
    let settled = false;

    const finish = (/** @type {boolean} */ ok, /** @type {string} */ reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req?.destroy();
      resolve({ ok, reason });
    };

    // Hard deadline for the whole exchange (connect + TLS + response), not just socket idle time.
    const deadline = setTimeout(() => finish(false, `timed out after ${timeoutMs} ms`), timeoutMs);

    const onResponse = (/** @type {http.IncomingMessage} */ res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) return finish(false, 'response body too large');
        chunks.push(chunk);
      });
      res.on('error', (err) => finish(false, `response error: ${err.message}`));
      res.on('end', () => {
        if (res.statusCode !== 200) return finish(false, `HTTP ${res.statusCode}`);
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          finish(body?.ok === true, body?.ok === true ? 'ok' : 'unexpected /healthz body');
        } catch {
          finish(false, '/healthz did not return JSON');
        }
      });
    };

    try {
      const options = {
        host,
        port,
        path: '/healthz',
        method: 'GET',
        agent: false,
        headers: { accept: 'application/json' },
      };
      req = tls
        ? https.request({ ...options, rejectUnauthorized: false }, onResponse)
        : http.request(options, onResponse);
      req.on('error', (err) => finish(false, err.message || String(err)));
      req.end();
    } catch (err) {
      finish(false, err instanceof Error ? err.message : String(err));
    }
  });
}

async function main() {
  const target = healthcheckTarget();
  const { ok, reason } = await checkHealth(target);
  if (!ok) {
    const scheme = target.tls ? 'https' : 'http';
    process.stderr.write(`unhealthy: ${scheme}://${target.host}:${target.port}/healthz: ${reason}\n`);
  }
  process.exit(ok ? 0 : 1);
}

const entry = process.argv[1];
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`unhealthy: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
