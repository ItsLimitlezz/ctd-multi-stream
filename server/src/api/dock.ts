// GET /dock, /dock/dock.js, /dock/dock.css — the OBS Custom Browser Dock (see dock-assets.ts).
// No auth here: the page is static and authenticates its /api/v1 calls with the token from the
// URL fragment.

import { createHash } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteOptions } from '../http/guards.js';
import { DOCK_CSS, DOCK_HTML, DOCK_JS } from './dock-assets.js';

/**
 * Set on every dock response (overrides the app-wide policy): only same-origin scripts, styles and
 * API calls; emote images from https. No upgrade-insecure-requests: on the LAN the dock is served
 * over plain HTTP and must call the API over that same origin.
 */
export const DOCK_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' https: data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

interface Asset {
  body: string;
  type: string;
  etag: string;
}

function asset(body: string, type: string): Asset {
  return { body, type, etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"` };
}

const ASSETS = {
  html: asset(DOCK_HTML, 'text/html; charset=utf-8'),
  js: asset(DOCK_JS, 'text/javascript; charset=utf-8'),
  css: asset(DOCK_CSS, 'text/css; charset=utf-8'),
};

function send(req: FastifyRequest, reply: FastifyReply, a: Asset): FastifyReply {
  reply
    .header('content-security-policy', DOCK_CSP)
    .header('cache-control', 'no-cache')
    .header('x-robots-tag', 'noindex, nofollow')
    .header('referrer-policy', 'no-referrer')
    .header('etag', a.etag)
    .type(a.type);
  if (req.headers['if-none-match'] === a.etag) return reply.code(304).send();
  return reply.send(a.body);
}

const dockRoutes: FastifyPluginAsync<RouteOptions> = async (app) => {
  app.get('/dock', async (req, reply) => send(req, reply, ASSETS.html));
  app.get('/dock/', async (req, reply) => send(req, reply, ASSETS.html));
  app.get('/dock/dock.js', async (req, reply) => send(req, reply, ASSETS.js));
  app.get('/dock/dock.css', async (req, reply) => send(req, reply, ASSETS.css));
};

export default dockRoutes;
