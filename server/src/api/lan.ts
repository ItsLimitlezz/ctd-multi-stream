// Plain-HTTP access from the LAN to /api/v1, /dock and /overlay/* (docs/API.md §1).
//
// The TLS module's HTTP listener (HTTP_PORT, normally a redirect to HTTPS) hands requests from
// private addresses for those paths to Fastify through the handler built here (see
// TlsManager.setLanHandler). Those requests reach Fastify over a plain socket while the app-wide
// security headers assume HTTPS, so `lanHttpPlugin` drops the HTTPS-only parts for them.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { RouteOptions } from '../http/guards.js';
import type { LanHandler } from '../services.js';

export function createLanHandler(app: Pick<FastifyInstance, 'routing' | 'server'>): LanHandler {
  return {
    request(req: IncomingMessage, res: ServerResponse) {
      app.routing(req, res);
    },
    upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      // @fastify/websocket listens for 'upgrade' on the app server and routes it through Fastify.
      app.server.emit('upgrade', req, socket, head);
    },
  };
}

/** Remove `upgrade-insecure-requests` from a CSP header value. */
export function stripUpgradeInsecure(csp: string): string {
  return csp
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.length > 0 && d.toLowerCase() !== 'upgrade-insecure-requests')
    .join('; ');
}

const plugin: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  if (services.config.tlsMode === 'off') return; // the app itself is HTTP: nothing assumes HTTPS
  app.addHook('onRequest', async (req, reply) => {
    if ((req.raw.socket as { encrypted?: boolean } | undefined)?.encrypted === true) return;
    // Plain HTTP (LAN handoff): helmet already set its headers on the raw response.
    const raw = reply.raw;
    const csp = raw.getHeader('content-security-policy');
    if (typeof csp === 'string') raw.setHeader('content-security-policy', stripUpgradeInsecure(csp));
    raw.removeHeader('strict-transport-security');
  });
};

/** Register after @fastify/helmet (its onRequest hook must run first). */
export const lanHttpPlugin = fp(plugin, { name: 'ctd-lan-http', fastify: '5.x' });
