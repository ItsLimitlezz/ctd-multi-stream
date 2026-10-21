// Plain-HTTP listener: answers ACME HTTP-01 challenges and redirects everything else to HTTPS —
// except LAN clients asking for the external API, the OBS dock or the overlay, which are handed to
// the app (LanHandler) so apps on the same network need no certificate.

import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { Logger } from 'pino';
import type { LanHandler } from '../services.js';
import { canonicalIp, classifyIp, type IpClass } from './public-ip.js';

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

// ---------------------------------------------------------------------------
// LAN handoff
// ---------------------------------------------------------------------------

/** Remote addresses that count as "same network". */
const LAN_CLASSES: ReadonlySet<IpClass> = new Set<IpClass>(['private', 'loopback', 'cgnat', 'ula', 'link-local']);

/**
 * Whether the TCP peer is on a private network. Only the socket's address counts: never
 * X-Forwarded-For (anyone can send it). Behind Docker's port mapping on Linux the peer is the client
 * (iptables DNAT). Where a NAT/proxy hop replaces the client address with a private one (Docker
 * Desktop, rootless Docker/Podman, docker-proxy carrying IPv6 into an IPv4-only network, tunnels
 * from a VPS), internet clients look private too: those installs set LAN_HTTP=off or
 * LAN_HTTP_CIDRS (lanClientPolicy).
 */
export function isLanClient(remoteAddress: string | undefined): boolean {
  return !!remoteAddress && LAN_CLASSES.has(classifyIp(remoteAddress));
}

/** `off` disables the LAN plain-HTTP handoff (everything redirects to HTTPS); default `on`. */
export const LAN_HTTP_ENV = 'LAN_HTTP';
/** Comma-separated CIDRs (or single addresses): only peers in them count as LAN (replaces the private ranges). */
export const LAN_HTTP_CIDRS_ENV = 'LAN_HTTP_CIDRS';

export interface LanClientPolicy {
  /** Whether any client can get plain HTTP for /api/v1, /dock and /overlay. */
  enabled: boolean;
  isLanClient(remoteAddress: string | undefined): boolean;
  /** For the startup log. */
  description: string;
  /** Configuration problems (logged at startup). */
  warnings: string[];
}

const OFF_VALUES = new Set(['off', 'false', '0', 'no', 'disabled']);
const ON_VALUES = new Set(['', 'on', 'true', '1', 'yes', 'auto', 'enabled']);

function parseCidr(entry: string): { address: string; prefix: number; type: 'ipv4' | 'ipv6' } | null {
  const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(entry);
  const canonical = m?.[1] ? canonicalIp(m[1]) : null;
  if (!m || !canonical) return null;
  const max = canonical.type === 'ipv4' ? 32 : 128;
  const prefix = m[2] === undefined ? max : Number(m[2]);
  return prefix >= 0 && prefix <= max ? { address: canonical.ip, prefix, type: canonical.type } : null;
}

/** Who gets the LAN plain-HTTP handoff, from LAN_HTTP / LAN_HTTP_CIDRS. */
export function lanClientPolicy(env: Record<string, string | undefined>): LanClientPolicy {
  const warnings: string[] = [];
  const mode = (env[LAN_HTTP_ENV] ?? '').trim().toLowerCase();
  if (OFF_VALUES.has(mode)) return { enabled: false, isLanClient: () => false, description: `off (${LAN_HTTP_ENV}=off)`, warnings };
  if (!ON_VALUES.has(mode)) warnings.push(`${LAN_HTTP_ENV}="${mode.slice(0, 32)}" is not on or off; treating it as on.`);

  const entries = (env[LAN_HTTP_CIDRS_ENV] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (entries.length === 0) {
    return { enabled: true, isLanClient, description: 'private, loopback, CGNAT, ULA and link-local peers', warnings };
  }
  const list = new net.BlockList();
  const valid: string[] = [];
  for (const entry of entries) {
    const cidr = parseCidr(entry);
    if (!cidr) {
      warnings.push(`${LAN_HTTP_CIDRS_ENV}: "${entry.slice(0, 64)}" is not an address or CIDR; ignored.`);
      continue;
    }
    list.addSubnet(cidr.address, cidr.prefix, cidr.type);
    valid.push(`${cidr.address}/${cidr.prefix}`);
  }
  if (valid.length === 0) {
    warnings.push(`${LAN_HTTP_CIDRS_ENV} has no valid entry; LAN plain HTTP is off.`);
    return { enabled: false, isLanClient: () => false, description: `off (no valid ${LAN_HTTP_CIDRS_ENV})`, warnings };
  }
  return {
    enabled: true,
    isLanClient: (remoteAddress) => {
      const canonical = remoteAddress ? canonicalIp(remoteAddress) : null;
      return !!canonical && list.check(canonical.ip, canonical.type);
    },
    description: `peers in ${valid.join(', ')}`,
    warnings,
  };
}

const SAFE_PATH_RE = /^\/[A-Za-z0-9/._~!$&'()*+,;=:@%-]*$/;

/** Path part of an origin-form target, or null when it could be ambiguous (dot segments, encoded separators). */
function lanPath(url: string | undefined): string | null {
  if (!url || !url.startsWith('/')) return null;
  const path = url.split('?')[0] ?? '';
  if (!SAFE_PATH_RE.test(path)) return null;
  if (/%(?:2e|2f|5c|00)/i.test(path)) return null;
  if (path.split('/').some((seg) => seg === '.' || seg === '..')) return null;
  return path;
}

/** Paths LAN clients may use over plain HTTP: /api/v1, /api/v1/*, /dock, /dock/*, /overlay/*. */
export function isLanPath(url: string | undefined): boolean {
  const path = lanPath(url);
  if (path === null) return false;
  return path === '/api/v1' || path.startsWith('/api/v1/') || path === '/dock' || path.startsWith('/dock/') || path.startsWith('/overlay/');
}

/** WebSocket upgrades LAN clients may make over plain HTTP: the chat overlay feed and the OBS socket relay. */
export function isLanUpgradePath(url: string | undefined): boolean {
  const path = lanPath(url);
  return path === '/overlay/ws' || path === '/api/v1/obs/socket';
}

export interface HttpListener {
  /** Resolves with the bound port once listening. */
  listen(): Promise<number>;
  close(): Promise<void>;
}

function rawResponse(result: HttpRouteResult): string {
  const lines = [`HTTP/1.1 ${result.status} ${http.STATUS_CODES[result.status] ?? ''}`];
  for (const [k, v] of Object.entries({ ...result.headers, 'content-length': String(Buffer.byteLength(result.body)), connection: 'close' })) {
    lines.push(`${k}: ${v}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n${result.body}`;
}

export function createHttpListener(opts: {
  port: number;
  host?: string;
  publicPort: number;
  challenges: ReadonlyMap<string, string>;
  log: Logger;
  /** Current LAN handler (read per request, so it can be set before or after listen()). */
  lanHandler?: () => LanHandler | null;
  /** Classifies the TCP peer address (tests); default isLanClient. */
  isLanClient?: (remoteAddress: string | undefined) => boolean;
}): HttpListener {
  const lanClient = opts.isLanClient ?? isLanClient;
  const route = (req: http.IncomingMessage) =>
    routeHttpRequest({ method: req.method, url: req.url, host: req.headers.host }, { publicPort: opts.publicPort, challenges: opts.challenges });

  const server = http.createServer(
    { requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 5_000, maxHeaderSize: 16 * 1024 },
    (req, res) => {
      const isChallenge = req.url?.startsWith(CHALLENGE_PREFIX) === true;
      const lan = isChallenge ? null : (opts.lanHandler?.() ?? null);
      if (lan && lanClient(req.socket.remoteAddress) && isLanPath(req.url)) {
        try {
          lan.request(req, res);
        } catch (err) {
          opts.log.error({ err }, 'LAN request handoff failed');
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Internal error');
        }
        return;
      }
      const result = route(req);
      if (isChallenge) {
        opts.log.info({ status: result.status }, 'ACME HTTP-01 challenge request');
      }
      res.writeHead(result.status, { ...result.headers, 'content-length': Buffer.byteLength(result.body) });
      res.end(req.method === 'HEAD' ? undefined : result.body);
    },
  );
  // With an 'upgrade' listener Node stops treating upgrade requests as plain requests, so anything
  // not handed off gets the same answer a plain request would (redirect / challenge / 400).
  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const lan = opts.lanHandler?.() ?? null;
    if (lan && lanClient(req.socket.remoteAddress) && isLanUpgradePath(req.url)) {
      try {
        lan.upgrade(req, socket, head);
      } catch (err) {
        opts.log.error({ err }, 'LAN upgrade handoff failed');
        socket.destroy();
      }
      return;
    }
    socket.on('error', () => socket.destroy());
    if (socket.writable) socket.end(rawResponse(route(req)));
    else socket.destroy();
  });
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
