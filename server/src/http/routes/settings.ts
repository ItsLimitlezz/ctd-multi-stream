// App settings (public base URL, ingest host, disconnect grace) + TLS status and version.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppSettings, SettingsResponse } from '../../../../shared/api.js';
import type { AppServices } from '../../services.js';
import { audit, requireAdmin, type RouteOptions } from '../guards.js';
import { installErrorHandler, isRecord, normalizeIngestHost, normalizePublicBaseUrl } from '../validation.js';

const SETTINGS_KEY = 'app';

const putBody = z.strictObject({
  publicBaseUrl: z.string().max(2048).optional(),
  ingestHost: z.string().max(300).optional(),
  disconnectGraceSec: z.number().int().min(0).max(600).optional(),
});

function settingsResponse(services: AppServices): SettingsResponse {
  return { settings: services.appSettings(), tls: services.tls.status(), version: services.config.version };
}

const settingsRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  installErrorHandler(app);

  app.get('/api/settings', { preHandler: requireAdmin }, async () => settingsResponse(services));

  app.put('/api/settings', { preHandler: requireAdmin }, async (req) => {
    const body = putBody.parse(req.body ?? {});
    const changes: Partial<AppSettings> = {};
    if (body.publicBaseUrl !== undefined) changes.publicBaseUrl = normalizePublicBaseUrl(body.publicBaseUrl);
    if (body.ingestHost !== undefined) changes.ingestHost = normalizeIngestHost(body.ingestHost);
    if (body.disconnectGraceSec !== undefined) changes.disconnectGraceSec = body.disconnectGraceSec;

    const before = services.appSettings();
    const changedKeys = (Object.keys(changes) as (keyof AppSettings)[]).filter((k) => changes[k] !== before[k]);
    if (Object.keys(changes).length > 0) {
      const stored = services.repos.settings.get<unknown>(SETTINGS_KEY, {});
      services.repos.settings.set(SETTINGS_KEY, { ...(isRecord(stored) ? stored : {}), ...changes });
    }
    if (changedKeys.length > 0) audit(services, req, 'settings.update', changedKeys.join(', '));
    return settingsResponse(services);
  });
};

export default settingsRoutes;
