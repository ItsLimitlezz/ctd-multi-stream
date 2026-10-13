// OBS setup info: RTMP server URL + per-feed stream keys [admin].

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IngestInfo } from '../../../../shared/api.js';
import { FEEDS } from '../../../../shared/types.js';
import type { AppServices } from '../../services.js';
import { audit, requireAdmin, type RouteOptions } from '../guards.js';

const RotateSchema = z.object({ feed: z.enum(['landscape', 'vertical']) });

/** Host for the OBS server URL: the ingestHost setting, else the host the browser used. */
export function ingestHost(setting: string, requestHostname: string): string {
  let host = setting.trim();
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname;
    } catch {
      // keep as typed
    }
  }
  host = host.replace(/\/.*$/, '');
  if (!host) host = requestHostname;
  // Strip a port from "host:port" (but not from a bare IPv6 address), then bracket IPv6.
  if (!host.startsWith('[') && /^[^:]+:\d+$/.test(host)) host = host.slice(0, host.lastIndexOf(':'));
  if (host.startsWith('[')) host = host.slice(0, host.indexOf(']') + 1);
  else if (host.includes(':')) host = `[${host}]`;
  return host || 'localhost';
}

export async function buildIngestInfo(services: AppServices, req: FastifyRequest): Promise<IngestInfo> {
  const { media, config } = services;
  const keys = await media.ingestKeys();
  const serverUrl = `rtmp://${ingestHost(services.appSettings().ingestHost, req.hostname)}:${config.rtmpPort}/${media.appName}`;
  return {
    serverUrl,
    feeds: FEEDS.map((feed) => {
      const streamKey = `${feed}?key=${keys[feed]}`;
      return { feed, streamKey, fullUrl: `${serverUrl}/${streamKey}` };
    }),
  };
}

const ingestRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  app.get('/api/ingest', { preHandler: requireAdmin }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return buildIngestInfo(services, req);
  });

  app.post('/api/ingest/rotate', { preHandler: requireAdmin }, async (req, reply) => {
    const { feed } = RotateSchema.parse(req.body ?? {});
    await services.media.rotateIngestKey(feed);
    audit(services, req, 'ingest.rotate', feed);
    reply.header('cache-control', 'no-store');
    return buildIngestInfo(services, req);
  });
};

export default ingestRoutes;
