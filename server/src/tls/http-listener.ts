// Plain-HTTP listener: answers ACME HTTP-01 challenges and redirects everything else to HTTPS.

import http from 'node:http';
import net from 'node:net';
import type { Logger } from 'pino';

/** token -> key authorization, filled while an ACME order is being validated. */
export type ChallengeStore = Map<string, string>;

export const CHALLENGE_PREFIX = '/.well-known/acme-challenge/';
const TOKEN_RE = /^[A-Za-z0-9_-]{1,256}$/;
const HOSTNAME_RE = /^[A-Za-z0-9.-]{1,253}$/;
const PATH_RE = /^\/[\x21-\x7e]*$/; // printable ASCII, no spaces or control characters

export interface HttpRouteResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Host header -> host without port. IPv6 stays bracketed. Returns null for anything that
 * isn't a plain hostname/IPv4 or a bracketed IPv6 literal (never reflect unvalidated input).
 */
export function parseHostHeader(value: string | undefined): string | null {
  if (!value) return null;
  const host = value.trim();
  const v6 = /^\[([0-9A-Fa-f:.]+)\](?::(\d{1,5}))?$/.exec(host);
  if (v6) return v6[1] && net.isIPv6(v6[1]) ? `[${v6[1].toLowerCase()}]` : null;
  const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(host);
  const name = m?.[1];
  if (!name || !HOSTNAME_RE.test(name) || name.startsWith('.') || name.includes('..')) return null;
  return name.toLowerCase();
}

/** Path + query of the request target (origin-form or absolute-form), or null when unsafe. */
function requestPath(url: string): string | null {
  let target = url;
  if (!target.startsWith('/')) {
    try {
      const u = new URL(target);
      target = `${u.pathname}${u.search}`;
    } catch {
      return null;
    }
  }
  return PATH_RE.test(target) ? target : null;
}

function text(status: number, body: string, extra: Record<string, string> = {}): HttpRouteResult {
  return {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    },
    body,
  };
}

/** Pure request router (tested directly). */
export function routeHttpRequest(
  req: { method: string | undefined; url: string | undefined; host: string | undefined },
  opts: { publicPort: number; challenges: ReadonlyMap<string, string> },
): HttpRouteResult {
  const url = req.url ?? '/';
  const pathOnly = url.split('?')[0] ?? url;

  if (pathOnly.startsWith(CHALLENGE_PREFIX)) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'Method not allowed', { allow: 'GET, HEAD' });
    const token = pathOnly.slice(CHALLENGE_PREFIX.length);
    const keyAuth = TOKEN_RE.test(token) ? opts.challenges.get(token) : undefined;
    return keyAuth ? text(200, keyAuth) : text(404, 'Not found');
  }

  const host = parseHostHeader(req.host);
  const target = requestPath(url);
  if (!host || !target) return text(400, 'Bad request');
  const port = opts.publicPort === 443 ? '' : `:${opts.publicPort}`;
  return text(301, 'Moved permanently', { location: `https://${host}${port}${target}` });
}

export interface HttpListener {
  /** Resolves with the bound port once listening. */
  listen(): Promise<number>;
  close(): Promise<void>;
}

export function createHttpListener(opts: {
  port: number;
  host?: string;
  publicPort: number;
  challenges: ReadonlyMap<string, string>;
  log: Logger;
}): HttpListener {
  const server = http.createServer(
    { requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 5_000, maxHeaderSize: 16 * 1024 },
    (req, res) => {
      const result = routeHttpRequest(
        { method: req.method, url: req.url, host: req.headers.host },
        { publicPort: opts.publicPort, challenges: opts.challenges },
      );
      if (req.url?.startsWith(CHALLENGE_PREFIX)) {
        opts.log.info({ status: result.status }, 'ACME HTTP-01 challenge request');
      }
      res.writeHead(result.status, { ...result.headers, 'content-length': Buffer.byteLength(result.body) });
      res.end(req.method === 'HEAD' ? undefined : result.body);
    },
  );
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  let listening = false;
  return {
    listen() {
      return new Promise<number>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once('error', onError);
        server.listen({ port: opts.port, host: opts.host ?? '0.0.0.0' }, () => {
          server.off('error', onError);
          server.on('error', (err) => opts.log.error({ err }, 'HTTP listener error'));
          listening = true;
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : opts.port);
        });
      });
    },
    close() {
      if (!listening) return Promise.resolve();
      listening = false;
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
