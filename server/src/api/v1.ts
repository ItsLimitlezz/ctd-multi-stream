// External API v1 (docs/API.md): read-only, bearer-token auth, problem+json errors, SSE events.
//
// Registered under the /api/v1 prefix. It never uses the session cookie and never sets one; the
// global auth plugin only CSRF-checks unsafe methods, and everything here is GET (+ CORS preflight).

import type { ServerResponse } from 'node:http';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiScope, ApiTokenInfo } from '../../../shared/types.js';
import type { RouteOptions } from '../http/guards.js';
import { eventHubFor, type EventHub } from './event-hub.js';
import { resolveTypes } from './filters.js';
import { ConcurrencyLimiter, SlidingWindowLimiter, presentedToken, sendProblem } from './http.js';
import { openApiDocument } from './openapi.js';
import type { ApiEventType, Envelope } from './types.js';
import { parseUlid } from './ulid.js';

export const API_PREFIX = '/api/v1';
export const RATE_LIMIT_PER_MINUTE = 600;
export const MAX_STREAMS_PER_TOKEN = 5;
export const HEARTBEAT_MS = 15_000;
export const SSE_RETRY_MS = 3000;
export const CHAT_DEFAULT_LIMIT = 200;
export const CHAT_MAX_LIMIT = 500;
/** A stream client this far behind on live events isn't reading; drop it (it resumes with Last-Event-ID). */
export const MAX_STREAM_BUFFER_BYTES = 1024 * 1024;
/** A gracefully ended stream (revoked token, shutdown) whose end can't be flushed is destroyed after this. */
const STREAM_END_GRACE_MS = 5000;

export interface V1Options extends RouteOptions {
  /** Defaults to eventHubFor(services). */
  hub?: EventHub;
  now?: () => number;
  heartbeatMs?: number;
}

interface Auth {
  token: ApiTokenInfo;
  secret: string;
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'Retry-After, WWW-Authenticate',
};

export function sseFrame(env: Envelope): string {
  return `id: ${env.id}\nevent: ${env.type}\ndata: ${JSON.stringify(env)}\n\n`;
}

function query(req: FastifyRequest): Record<string, unknown> {
  const q = req.query;
  return q && typeof q === 'object' ? (q as Record<string, unknown>) : {};
}

function parseLimit(raw: unknown): number | null {
  if (raw === undefined || raw === '') return CHAT_DEFAULT_LIMIT;
  if (typeof raw !== 'string' || !/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= CHAT_MAX_LIMIT ? n : null;
}

/** undefined = absent, null = present but not a ULID. */
function parseCursor(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === '') return undefined;
  return parseUlid(raw);
}

const v1Plugin: FastifyPluginAsync<V1Options> = async (app, opts) => {
  const { services } = opts;
  const log = services.log.child({ mod: 'api-v1' });
  const now = opts.now ?? Date.now;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  let hubInstance = opts.hub ?? null;
  const hub = (): EventHub => (hubInstance ??= eventHubFor(services));
  const limiter = new SlidingWindowLimiter(RATE_LIMIT_PER_MINUTE, 60_000, now);
  const streamSlots = new ConcurrencyLimiter(MAX_STREAMS_PER_TOKEN);
  const auths = new WeakMap<FastifyRequest, Auth>();
  const openStreams = new Set<() => void>();

  // ---- every response under /api/v1 ----

  app.addHook('onRequest', async (_req, reply) => {
    reply.headers(CORS_HEADERS);
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    // Bearer-only API: never set (or clear) the web UI's session cookie from here.
    reply.removeHeader('set-cookie');
    reply.raw.removeHeader('set-cookie');
    return payload;
  });
  app.setNotFoundHandler((req, reply) => {
    reply.headers(CORS_HEADERS);
    return sendProblem(reply, 404, 'not_found', `No such endpoint: ${req.method} ${req.url.split('?')[0] ?? ''}`);
  });
  app.setErrorHandler((err, req, reply) => {
    const e = err as { statusCode?: number; message?: string };
    reply.headers(CORS_HEADERS);
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return sendProblem(reply, e.statusCode === 429 ? 429 : 400, e.statusCode === 429 ? 'rate_limited' : 'invalid', e.message ?? 'Bad request');
    }
    req.log.error({ err }, 'api v1 request failed');
    return sendProblem(reply, 500, 'internal', 'Internal error');
  });
  app.addHook('preClose', async () => {
    for (const close of [...openStreams]) close();
  });

  // CORS preflight (browsers send one before a request with an Authorization header).
  const preflight = async (req: FastifyRequest, reply: FastifyReply) => {
    reply
      .headers(CORS_HEADERS)
      .header('access-control-allow-methods', 'GET, OPTIONS')
      .header('access-control-allow-headers', 'Authorization, Last-Event-ID, Cache-Control, Content-Type')
      .header('access-control-max-age', '600');
    if (req.headers['access-control-request-private-network'] === 'true') reply.header('access-control-allow-private-network', 'true');
    return reply.code(204).send();
  };
  app.options('/', preflight);
  app.options('/*', preflight);

  // ---- auth ----

  /** preHandler: valid token, under the rate limit, with `scope` (when given). */
  function requireToken(scope: ApiScope | null, allowQuery = false) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const secret = presentedToken(req, allowQuery);
      if (!secret) {
        return sendProblem(
          reply,
          401,
          'unauthenticated',
          secret === null
            ? 'Send a token: Authorization: Bearer ctd_pat_… (create one in Settings → API).'
            : 'Malformed Authorization header; expected: Bearer ctd_pat_…',
        );
      }
      const token = services.repos.apiTokens.verify(secret);
      if (!token) return sendProblem(reply, 401, 'unauthenticated', 'Unknown or revoked token. Create a new one in Settings → API.');
      const rate = limiter.hit(token.id);
      if (!rate.ok) {
        reply.header('retry-after', String(rate.retryAfterSec));
        return sendProblem(reply, 429, 'rate_limited', `Over ${RATE_LIMIT_PER_MINUTE} requests per minute for this token. Retry in ${rate.retryAfterSec} s.`);
      }
      if (scope && !token.scopes.includes(scope)) {
        return sendProblem(reply, 403, 'missing_scope', `This token needs the ${scope} scope. Create a token with it in Settings → API.`);
      }
      auths.set(req, { token, secret });
    };
  }

  const authOf = (req: FastifyRequest): Auth => {
    const auth = auths.get(req);
    if (!auth) throw new Error('route without requireToken');
    return auth;
  };

  // ---- routes ----

  app.get('/openapi.json', async (_req, reply) => {
    return reply.header('cache-control', 'no-cache').send(openApiDocument(services.config.version));
  });

  app.get('/', { preHandler: requireToken(null) }, async (req, reply) => {
    const { token } = authOf(req);
    return reply.header('cache-control', 'no-store').send({
      name: 'ctd-multi-stream',
      version: services.config.version,
      apiVersion: 1,
      token: { name: token.name, scopes: token.scopes },
    });
  });

  app.get('/status', { preHandler: requireToken('status:read') }, async (_req, reply) => {
    return reply.header('cache-control', 'no-store').send(hub().status());
  });

  app.get('/chat', { preHandler: requireToken('chat:read') }, async (req, reply) => {
    const q = query(req);
    const limit = parseLimit(q.limit);
    if (limit === null) return sendProblem(reply, 400, 'invalid', `limit must be an integer from 1 to ${CHAT_MAX_LIMIT}`);
    const after = parseCursor(q.after);
    if (after === null) return sendProblem(reply, 400, 'invalid', 'after must be an envelope id (ULID)');
    return reply.header('cache-control', 'no-store').send(hub().chat(limit, after));
  });

  app.get('/events/poll', { preHandler: requireToken(null) }, async (req, reply) => {
    const { token } = authOf(req);
    const q = query(req);
    const filter = resolveTypes(q.types, token.scopes);
    if (!filter.ok) return sendProblem(reply, filter.status, filter.code, filter.detail);
    const after = parseCursor(q.after);
    if (after === null) return sendProblem(reply, 400, 'invalid', 'after must be an envelope id (ULID)');
    reply.header('cache-control', 'no-store');
    const h = hub();
    if (after === undefined) return reply.send({ items: [], next: h.cursor(), reset: false });
    const replay = h.since(after, filter.types);
    if (replay.reset) return reply.send({ items: [], next: h.cursor(), reset: true });
    const items = replay.items.filter((e) => filter.types.has(e.type));
    // The last scanned envelope, matching or not: the next poll doesn't rescan what the filter skipped.
    const next = replay.items.at(-1)?.id ?? after;
    return reply.send({ items, next, reset: false });
  });

  // No automatic HEAD route: a HEAD "stream" would hold a stream slot without ever sending anything.
  app.get('/events', { preHandler: requireToken(null, true), exposeHeadRoute: false }, async (req, reply) => {
    const { token, secret } = authOf(req);
    const q = query(req);
    const filter = resolveTypes(q.types, token.scopes);
    if (!filter.ok) return sendProblem(reply, filter.status, filter.code, filter.detail);
    const header = req.headers['last-event-id'];
    const cursor = parseCursor(typeof header === 'string' && header.trim() ? header : q.cursor);
    if (cursor === null) return sendProblem(reply, 400, 'invalid', 'Last-Event-ID / cursor must be an envelope id (ULID)');
    if (!streamSlots.acquire(token.id)) {
      reply.header('retry-after', '30');
      return sendProblem(reply, 429, 'rate_limited', `At most ${MAX_STREAMS_PER_TOKEN} event streams per token are open at once.`);
    }

    reply.hijack();
    const res: ServerResponse = reply.raw;

    let closed = false;
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    /**
     * Release everything this stream holds (slot, hub subscription, heartbeat). `abort` destroys the
     * response right away (slow or broken client: frees the queued data and the socket); otherwise
     * it ends gracefully, and is destroyed anyway if that end can't be flushed within a few seconds
     * (a client that stopped reading would otherwise pin the socket and its buffer forever).
     */
    const close = (abort = false) => {
      if (closed) {
        if (abort && !res.destroyed) res.destroy();
        return;
      }
      closed = true;
      openStreams.delete(end);
      unsubscribe?.();
      unsubscribe = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      streamSlots.release(token.id);
      if (abort) {
        res.destroy();
        return;
      }
      if (res.destroyed) return;
      if (!res.writableEnded) res.end();
      const force = setTimeout(() => res.destroy(), STREAM_END_GRACE_MS);
      force.unref?.();
      res.once('close', () => clearTimeout(force));
    };
    const end = () => close(false);
    openStreams.add(end);
    res.on('close', end);
    res.on('error', () => close(true));
    // Gone before the listeners above existed: its 'close' has already fired.
    if (res.destroyed || req.raw.socket?.destroyed) {
      close(true);
      return;
    }

    try {
      res.removeHeader('set-cookie');
      res.writeHead(200, {
        ...CORS_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      req.raw.socket?.setNoDelay?.(true);

      // The initial replay/snapshot is written in one tick while Node corks the socket, so all of it
      // sits in user space for a moment however fast the client is; it is bounded by the hub buffer
      // (2000 envelopes), so it doesn't count against the slow-client limit. Live writes may queue
      // MAX_STREAM_BUFFER_BYTES on top of what is left of it; after the first 'drain', the plain limit.
      let allowance = Number.POSITIVE_INFINITY;
      const write = (chunk: string) => {
        if (closed || res.writableEnded || res.destroyed) return;
        const ok = res.write(chunk);
        if (!ok && res.writableLength > allowance + MAX_STREAM_BUFFER_BYTES) {
          log.debug({ tokenId: token.id, buffered: res.writableLength }, 'event stream client too slow; dropping it');
          close(true);
        }
      };
      const types: ReadonlySet<ApiEventType> = filter.types;
      const send = (env: Envelope) => {
        if (types.has(env.type)) write(sseFrame(env));
      };

      write(`retry: ${SSE_RETRY_MS}\n\n`);
      const h = hub();
      // Replay (or snapshot) and subscribe in the same tick: no event can slip in between.
      let initial: Envelope[];
      if (cursor === undefined) {
        initial = h.snapshot();
      } else {
        const replay = h.since(cursor, types);
        initial = replay.reset ? [h.resetEnvelope(), ...h.snapshot()] : replay.items;
      }
      for (const env of initial) {
        if (closed) break;
        send(env);
      }
      // Closed meanwhile (socket error): set nothing up that close() would no longer release.
      if (closed) return;
      allowance = res.writableLength;
      if (allowance > 0) {
        res.once('drain', () => {
          allowance = 0;
        });
      }
      unsubscribe = h.subscribe(send);

      const timer = setInterval(() => {
        if (closed) {
          clearInterval(timer);
          return;
        }
        // Revoked tokens lose their open streams here (within one heartbeat).
        let valid: boolean;
        try {
          valid = services.repos.apiTokens.verify(secret)?.id === token.id;
        } catch {
          valid = true; // transient DB error: check again next time
        }
        if (!valid) {
          close();
          return;
        }
        write(': ping\n\n');
      }, heartbeatMs);
      timer.unref?.();
      heartbeat = timer;
    } catch (err) {
      // Never leave a hijacked stream open but silent: drop it so the client reconnects.
      log.warn({ tokenId: token.id, error: (err as Error).message }, 'event stream failed');
      close(true);
    }
  });
};

export default v1Plugin;
