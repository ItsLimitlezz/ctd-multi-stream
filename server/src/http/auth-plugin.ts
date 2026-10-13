// App-wide authentication: session cookie -> req.user, CSRF check for state-changing
// /api requests, Origin check for /api WebSocket upgrades, periodic session purge.

import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { CSRF_HEADER, SESSION_COOKIE } from '../../../shared/api.js';
import { SESSION_IDLE_MS } from '../db/sessions-repo.js';
import { publicUser } from '../db/users-repo.js';
import type { AppConfig } from '../config.js';
import type { AppServices, AuthSessionRecord } from '../services.js';
import { clientIp, sendError, type RouteOptions } from './guards.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Routes that create a session (no session/CSRF token exists yet). */
const CSRF_EXEMPT = new Set(['POST /api/auth/login', 'POST /api/setup']);
const PURGE_INTERVAL_MS = 3600_000;

export function cookieSecure(config: Pick<AppConfig, 'tlsMode'>): boolean {
  return config.tlsMode !== 'off';
}

/** Set the session cookie. Max-Age defaults to the 30-day sliding window. */
export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean, maxAgeSec?: number): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure,
    maxAge: Math.max(0, Math.floor(maxAgeSec ?? SESSION_IDLE_MS / 1000)),
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/', secure });
}

/** The raw session token from the request cookie, if any. */
export function sessionToken(req: FastifyRequest): string | null {
  const token = req.cookies?.[SESSION_COOKIE];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * Log `userId` in: drop the session the browser came with (no fixation, no orphans),
 * create a new one and set its cookie. Returns the record (for its csrfToken).
 */
export function beginSession(services: AppServices, req: FastifyRequest, reply: FastifyReply, userId: string): AuthSessionRecord {
  const previous = sessionToken(req);
  if (previous) services.repos.authSessions.delete(previous);
  const ua = req.headers['user-agent'];
  const { record, token } = services.repos.authSessions.create(userId, {
    ip: clientIp(req),
    userAgent: typeof ua === 'string' ? ua : null,
  });
  setSessionCookie(reply, token, cookieSecure(services.config));
  return record;
}

/** How often long-lived connections (WebSockets) re-check the session they were opened with. */
export const SESSION_RECHECK_MS = 30_000;
/** WebSocket close code for "your session ended" (logout, revoked, expired, demoted, deleted). */
export const WS_SESSION_ENDED = 4401;

/**
 * Re-validation for a long-lived connection: captures the request's session token and user at
 * upgrade time and returns a check that is false once the session is gone or expired (logout,
 * password change, CLI reset, expiry), the user was deleted, or (`admin`) is no longer an admin.
 * Never slides the session's idle expiry when the repo offers a read-only lookup (`peek`).
 */
export function sessionRevalidator(
  services: Pick<AppServices, 'repos'>,
  req: FastifyRequest,
  opts: { admin?: boolean } = {},
): () => boolean {
  const token = sessionToken(req);
  const userId = req.user?.id ?? null;
  return () => {
    if (!token || !userId) return false;
    const sessions = services.repos.authSessions;
    const session = sessions.peek ? sessions.peek(token) : sessions.touch(token);
    if (!session || session.userId !== userId) return false;
    const user = services.repos.users.get(userId);
    if (!user) return false;
    return !opts.admin || user.role === 'admin';
  };
}

/** Constant-time string comparison (hashing first makes the lengths equal). */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requestPath(req: FastifyRequest): string {
  const url = req.raw.url ?? req.url;
  const q = url.indexOf('?');
  return q < 0 ? url : url.slice(0, q);
}

function isApiRequest(req: FastifyRequest, path: string): boolean {
  return path.startsWith('/api/') || (req.routeOptions.url ?? '').startsWith('/api/');
}

function isWebSocketUpgrade(req: FastifyRequest): boolean {
  const upgrade = req.headers.upgrade;
  return typeof upgrade === 'string' && upgrade.toLowerCase() === 'websocket';
}

function stripDefaultPort(host: string, scheme: string): string {
  const h = host.toLowerCase();
  if ((scheme === 'https' || scheme === 'wss') && h.endsWith(':443')) return h.slice(0, -4);
  if ((scheme === 'http' || scheme === 'ws') && h.endsWith(':80')) return h.slice(0, -3);
  return h;
}

/** Cross-site WebSocket hijacking guard: the Origin's host must be the host the client connected to. */
export function originMatchesHost(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host || origin === 'null') return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const scheme = url.protocol.replace(/:$/, '');
  return stripDefaultPort(url.host, scheme) === stripDefaultPort(host, scheme);
}

const authPlugin: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  const { repos, config } = services;
  const log = services.log.child({ mod: 'auth' });
  const secure = cookieSecure(config);

  app.decorateRequest('user', null);
  app.decorateRequest('authSession', null);

  app.addHook('onRequest', async (req, reply) => {
    const path = requestPath(req);
    const api = isApiRequest(req, path);

    if (api && isWebSocketUpgrade(req) && !originMatchesHost(req.headers.origin, req.host)) {
      return sendError(reply, 403, 'WebSocket origin not allowed', 'origin');
    }

    const token = sessionToken(req);
    if (token) {
      const session = repos.authSessions.touch(token);
      const user = session ? repos.users.get(session.userId) : null;
      if (session && user) {
        req.user = publicUser(user);
        req.authSession = session;
      } else {
        if (session) repos.authSessions.delete(token);
        clearSessionCookie(reply, secure); // stale cookie: tell the browser to drop it
      }
    }

    if (api && req.authSession && !SAFE_METHODS.has(req.method) && !CSRF_EXEMPT.has(`${req.method} ${path}`)) {
      const header = req.headers[CSRF_HEADER];
      if (typeof header !== 'string' || !safeEqual(header, req.authSession.csrfToken)) {
        return sendError(reply, 403, 'Invalid or missing CSRF token', 'csrf');
      }
    }
  });

  const purge = () => {
    try {
      repos.authSessions.purgeExpired();
    } catch (err) {
      log.warn({ err }, 'session purge failed');
    }
  };
  const timer = setInterval(purge, PURGE_INTERVAL_MS);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
  });
};

export default fp(authPlugin, { name: 'ctd-auth', fastify: '5.x' });
