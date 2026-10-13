// Loopback HTTP endpoint MediaMTX calls for every publish/read (`authMethod: http`).
// 2xx = allow, anything else = deny. Payload format (v1.21.2):
// https://github.com/bluenviron/mediamtx/blob/v1.21.2/docs/2-features/06-authentication.md#external-http-server

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { MediaMtxAuthRequest } from '../services.js';

export const AUTH_PATH = '/auth';
const MAX_BODY_BYTES = 16 * 1024;
const DENY_LOG_INTERVAL_MS = 60_000;

const ACTIONS = ['publish', 'read', 'playback', 'api', 'metrics', 'pprof'] as const;

const str = z.string().catch('');
const AuthBodySchema = z.object({
  user: str,
  password: str,
  ip: str,
  action: z.enum(ACTIONS).nullable().catch(null),
  path: str,
  protocol: str,
  id: z.string().nullable().catch(null),
  query: str,
});

/** Parse MediaMTX's JSON body; null when the body is unusable (unknown action, not an object...). */
export function parseAuthBody(raw: string): MediaMtxAuthRequest | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const body = AuthBodySchema.parse(json);
  if (!body.action) return null;
  return { ...body, action: body.action };
}

export interface AuthServer {
  readonly port: number;
  close(): Promise<void>;
}

export interface AuthServerOptions {
  authorize: (req: MediaMtxAuthRequest) => boolean;
  log: Logger;
  /** Default 0 = pick a free port (read it from `port` before writing the MediaMTX config). */
  port?: number;
}

export async function startAuthServer({ authorize, log, port = 0 }: AuthServerOptions): Promise<AuthServer> {
  const lastDenyLog = new Map<string, number>();

  const logDenied = (req: MediaMtxAuthRequest) => {
    // Never log query/password: they carry the keys. Throttle so a misconfigured OBS can't flood logs.
    const sig = `${req.action}|${req.path}|${req.ip}`;
    const now = Date.now();
    if (now - (lastDenyLog.get(sig) ?? 0) < DENY_LOG_INTERVAL_MS) return;
    if (lastDenyLog.size > 1000) lastDenyLog.clear();
    lastDenyLog.set(sig, now);
    log.warn({ action: req.action, path: req.path, ip: req.ip, protocol: req.protocol }, 'Rejected media %s request', req.action);
  };

  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? '').split('?')[0];
    if (req.method !== 'POST' || pathname !== AUTH_PATH) {
      res.writeHead(404, { connection: 'close' }).end();
      req.resume();
      return;
    }
    const tooLarge = () => {
      res.writeHead(413, { connection: 'close' });
      res.end(() => req.destroy());
    };
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
      tooLarge();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        tooLarge();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => {
      rejected = true;
    });
    req.on('end', () => {
      if (rejected) return;
      const parsed = parseAuthBody(Buffer.concat(chunks).toString('utf8'));
      if (!parsed) {
        res.writeHead(400).end();
        return;
      }
      let allowed = false;
      try {
        allowed = authorize(parsed);
      } catch (err) {
        log.error({ err }, 'media auth check failed');
      }
      if (!allowed) logDenied(parsed);
      res.writeHead(allowed ? 200 : 401).end();
    });
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.on('clientError', (_err, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', (err) => log.error({ err }, 'media auth server error'));

  const actualPort = (server.address() as AddressInfo).port;
  let closed: Promise<void> | null = null;
  return {
    port: actualPort,
    close() {
      closed ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closed;
    },
  };
}
