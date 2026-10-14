// External API tokens (Settings → API) [admin]. The API itself lives under /api/v1 (server/src/api).

import fs from 'node:fs';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiTokensResponse, CreateApiTokenResponse } from '../../../../shared/api.js';
import { API_SCOPES, type ApiScope } from '../../../../shared/types.js';
import { LAN_HTTP_HOST_ENV, LAN_HTTP_PORT_ENV, LAN_HTTP_PORT_SETTING, accessInfo, localIPv4Addresses, parsePortOverride } from '../../api/access.js';
import type { AppServices } from '../../services.js';
import { lanClientPolicy } from '../../tls/http-listener.js';
import { audit, requireAdmin, sendError, type RouteOptions } from '../guards.js';

export const MAX_API_TOKENS = 100;
export const TOKEN_NAME_MAX = 60;

const CreateBody = z.strictObject({
  name: z.string().trim().min(1, 'name is required').max(TOKEN_NAME_MAX, `name: at most ${TOKEN_NAME_MAX} characters`),
  scopes: z
    .array(z.enum(API_SCOPES as [ApiScope, ...ApiScope[]]))
    .min(1, 'pick at least one scope')
    .max(10),
});
const IdParams = z.object({ id: z.string().min(1).max(64) });

// C0/C1 controls and bidi overrides don't belong in a label shown in the UI and the audit log.
const CONTROL_RE = /[\u{0}-\u{1F}\u{7F}-\u{9F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u;

let containerCache: boolean | null = null;
/** Docker (/.dockerenv) or Podman (/run/.containerenv): this machine's addresses aren't the LAN's. */
function inContainer(): boolean {
  if (containerCache === null) {
    try {
      containerCache = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
    } catch {
      containerCache = false;
    }
  }
  return containerCache;
}

function access(services: AppServices, req: FastifyRequest) {
  const { config } = services;
  return accessInfo({
    publicBaseUrl: services.publicBaseUrl(),
    fingerprint256: services.tls.status().fingerprint256,
    lan: {
      hostHeader: req.headers.host,
      secure: (req.raw.socket as { encrypted?: boolean } | undefined)?.encrypted === true,
      tlsMode: config.tlsMode,
      webPort: config.webPort,
      httpPort: config.httpPort,
      lanHttpPortOverride: parsePortOverride(process.env[LAN_HTTP_PORT_ENV], services.repos.settings.get<unknown>(LAN_HTTP_PORT_SETTING, null)),
      lanHttpHostOverride: process.env[LAN_HTTP_HOST_ENV] ?? null,
      lanHttpEnabled: lanClientPolicy(process.env).enabled,
      inContainer: inContainer(),
      localAddresses: localIPv4Addresses(),
    },
  });
}

const tokenRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  const { repos } = services;

  app.get('/api/tokens', { preHandler: requireAdmin }, async (req, reply): Promise<ApiTokensResponse> => {
    reply.header('cache-control', 'no-store');
    return { tokens: repos.apiTokens.list(), access: access(services, req) };
  });

  app.post('/api/tokens', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return sendError(reply, 400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 'invalid');
    }
    const { name, scopes } = parsed.data;
    if (CONTROL_RE.test(name)) return sendError(reply, 400, 'name: control characters are not allowed', 'invalid');
    if (repos.apiTokens.list().length >= MAX_API_TOKENS) {
      return sendError(reply, 409, `At most ${MAX_API_TOKENS} tokens; revoke unused ones first`, 'limit');
    }
    const unique = API_SCOPES.filter((s) => scopes.includes(s));
    const created = repos.apiTokens.create({ name, scopes: unique, createdBy: req.user?.username ?? null });
    // Never log or audit the secret itself.
    audit(services, req, 'api_token.create', `${created.token.name} (${created.token.scopes.join(', ')}) ${created.token.prefix}…`);
    const body: CreateApiTokenResponse = { token: created.token, secret: created.secret };
    return reply.header('cache-control', 'no-store').send(body);
  });

  app.delete('/api/tokens/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = IdParams.safeParse(req.params);
    if (!parsed.success) return sendError(reply, 400, 'Invalid token id', 'invalid');
    const token = repos.apiTokens.list().find((t) => t.id === parsed.data.id);
    if (!token) return sendError(reply, 404, 'Token not found', 'not_found');
    // Requests with it fail from now on; its open event streams close at their next heartbeat (≤ 15 s).
    repos.apiTokens.delete(token.id);
    audit(services, req, 'api_token.delete', `${token.name} ${token.prefix}…`);
    return {};
  });
};

export default tokenRoutes;
