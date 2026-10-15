// Chat REST routes + the token-protected OBS chat overlay (/overlay/*).
//
// Chat is per profile: `?profile=` (default: the default profile) on recent/overlay/rotate. Each
// profile has its own overlay token, and the public overlay (/overlay/chat?token=…, /overlay/ws)
// serves only the chat of the token's profile. The default profile keeps its pre-profiles token,
// so an overlay URL already pasted into OBS keeps working.

import { createHash } from 'node:crypto';
import type {} from '@fastify/rate-limit'; // route `config.rateLimit` typings
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { OverlayInfo, WsServerMessage } from '../../../../shared/api.js';
import { DEFAULT_PROFILE_ID } from '../../../../shared/types.js';
import { OVERLAY_CSS, OVERLAY_HTML, OVERLAY_JS } from '../../chat/overlay-assets.js';
import { safeErrorMessage } from '../../chat/redact.js';
import type { AppServices } from '../../services.js';
import { audit, requireAdmin, requireUser, sendError, type RouteOptions } from '../guards.js';
import { installErrorHandler, profileFromQuery } from '../validation.js';

export const OVERLAY_HISTORY = 50;
export const OVERLAY_PING_MS = 30_000;
/** Close code for a missing/invalid/rotated overlay token. The overlay script stops reconnecting on it. */
export const WS_CLOSE_UNAUTHORIZED = 4401;
const MAX_TOKEN_LENGTH = 256;
/** A client this far behind is not reading; drop it instead of buffering without bound. */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const OVERLAY_RATE_LIMIT = { max: 60, timeWindow: '1 minute' };

const RecentQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

interface StaticAsset {
  body: string;
  type: string;
  etag: string;
}

function staticAsset(body: string, type: string): StaticAsset {
  return { body, type, etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"` };
}

const ASSETS = {
  js: staticAsset(OVERLAY_JS, 'text/javascript; charset=utf-8'),
  css: staticAsset(OVERLAY_CSS, 'text/css; charset=utf-8'),
};

function sendAsset(req: FastifyRequest, reply: FastifyReply, asset: StaticAsset): FastifyReply {
  reply.header('Cache-Control', 'no-cache').header('ETag', asset.etag).type(asset.type);
  if (req.headers['if-none-match'] === asset.etag) return reply.code(304).send();
  return reply.send(asset.body);
}

function queryToken(req: FastifyRequest): string | null {
  const token = (req.query as Record<string, unknown> | undefined)?.token;
  return typeof token === 'string' && token.length > 0 && token.length <= MAX_TOKEN_LENGTH ? token : null;
}

/** Profile of a presented overlay token, or null (missing/unknown/rotated token). */
async function overlayProfile(services: AppServices, token: string | null): Promise<string | null> {
  if (token === null) return null;
  return services.chat.profileForOverlayToken(token);
}

function overlayUrl(services: AppServices, token: string): OverlayInfo {
  const base = services.publicBaseUrl().replace(/\/+$/, '');
  return { url: `${base}/overlay/chat?token=${encodeURIComponent(token)}` };
}

const chatRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  const log = services.log.child({ mod: 'chat-routes' });
  installErrorHandler(app); // `?profile=` errors: 400 invalid / 404 unknown_profile
  /** Open overlay sockets and the profile each one shows (closed when that profile's token is rotated). */
  const overlaySockets = new Map<WebSocket, { token: string; profileId: string }>();

  /** Close every overlay socket whose token no longer belongs to its profile (rotated/deleted). */
  function recheckOverlaySockets(): void {
    for (const [socket, { token, profileId }] of overlaySockets) {
      overlayProfile(services, token).then(
        (current) => {
          if (current !== profileId) socket.close(WS_CLOSE_UNAUTHORIZED, 'Token rotated');
        },
        () => {},
      );
    }
  }
  // A deleted profile's overlays stop at once (its token is deleted with it).
  const offProfiles = services.bus.on('profiles-changed', recheckOverlaySockets);
  app.addHook('onClose', async () => offProfiles());

  // ---- authenticated API ----

  app.get('/api/chat/recent', { preHandler: requireUser }, async (req, reply) => {
    const parsed = RecentQuery.safeParse(req.query ?? {});
    if (!parsed.success) return sendError(reply, 400, 'limit must be an integer between 1 and 500', 'invalid');
    return services.chat.recent(parsed.data.limit, profileFromQuery(services, req.query));
  });

  app.get('/api/chat/overlay', { preHandler: requireAdmin }, async (req, reply) => {
    const profileId = profileFromQuery(services, req.query);
    const info = overlayUrl(services, await services.chat.overlayToken(profileId));
    return reply.header('Cache-Control', 'no-store').send(info);
  });

  app.post('/api/chat/overlay/rotate', { preHandler: requireAdmin }, async (req, reply) => {
    const profileId = profileFromQuery(services, req.query);
    const token = await services.chat.rotateOverlayToken(profileId);
    audit(services, req, 'chat.overlay_rotate', profileId === DEFAULT_PROFILE_ID ? null : `profile=${profileId}`);
    for (const [socket, info] of overlaySockets) {
      if (info.profileId !== profileId) continue;
      socket.close(WS_CLOSE_UNAUTHORIZED, 'Token rotated');
      overlaySockets.delete(socket);
    }
    return reply.header('Cache-Control', 'no-store').send(overlayUrl(services, token));
  });

  // ---- public, token-protected overlay ----

  app.get('/overlay/chat', { config: { rateLimit: OVERLAY_RATE_LIMIT } }, async (req, reply) => {
    // Same 404 as any unknown path, so the endpoint can't be probed for valid tokens.
    if ((await overlayProfile(services, queryToken(req))) === null) return sendError(reply, 404, 'Not found', 'not_found');
    return reply
      .header('Cache-Control', 'no-store')
      .header('X-Robots-Tag', 'noindex, nofollow')
      .type('text/html; charset=utf-8')
      .send(OVERLAY_HTML);
  });

  app.get('/overlay/chat.js', async (req, reply) => sendAsset(req, reply, ASSETS.js));
  app.get('/overlay/chat.css', async (req, reply) => sendAsset(req, reply, ASSETS.css));

  app.get('/overlay/ws', { websocket: true, config: { rateLimit: OVERLAY_RATE_LIMIT } }, async (socket, req) => {
    const token = queryToken(req);
    let profileId: string | null;
    try {
      profileId = await overlayProfile(services, token);
    } catch (err) {
      log.error({ reason: safeErrorMessage(err) }, 'overlay token lookup failed');
      socket.close(1011, 'Server error');
      return;
    }
    if (profileId === null || token === null) {
      socket.close(WS_CLOSE_UNAUTHORIZED, 'Unauthorized');
      return;
    }
    if (socket.readyState !== socket.OPEN) return; // client left while we checked
    const profile = profileId;

    const send = (msg: WsServerMessage): void => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        socket.terminate();
        return;
      }
      socket.send(JSON.stringify(msg));
    };

    // Only the token's profile: another profile's chat never reaches this overlay.
    for (const message of services.chat.recent(OVERLAY_HISTORY, profile)) send({ type: 'chat', message });
    const unsubscribe = services.bus.on('chat', (message) => {
      if ((message.profileId ?? DEFAULT_PROFILE_ID) === profile) send({ type: 'chat', message });
    });
    overlaySockets.set(socket, { token, profileId: profile });

    // Heartbeat: drop dead connections, and re-check the token in case it was rotated elsewhere.
    let alive = true;
    socket.on('pong', () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      try {
        socket.ping();
      } catch {
        socket.terminate();
        return;
      }
      overlayProfile(services, token).then(
        (current) => {
          if (current !== profile) socket.close(WS_CLOSE_UNAUTHORIZED, 'Token rotated');
        },
        () => {},
      );
    }, OVERLAY_PING_MS);

    socket.on('message', () => {}); // read-only feed; ignore client data
    socket.once('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      overlaySockets.delete(socket);
    });
  });
};

export default chatRoutes;
