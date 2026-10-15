// Hub admin (Settings → API) [admin]: pending app pairings ("connect to CTD Multi-Stream", approved
// here by choosing the profile + scopes) and the connected apps registry. The app side of pairing
// and registration lives in the external API (server/src/api, docs/API.md §9).

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ApiTokenInfo, ConnectedApp, PairingRequest } from '../../../../shared/types.js';
import { audit, requireAdmin, sendError, type RouteOptions } from '../guards.js';
import { installErrorHandler, truncate } from '../validation.js';
import { CONTROL_RE, MAX_API_TOKENS, profileLabel, scopesSchema, tokenNameSchema, tokenProfileSchema, uniqueScopes } from './tokens.js';

const IdParams = z.object({ id: z.string().min(1).max(128) });

/** ApprovePairingRequest. `profileId` is required (null = every profile) so access is never widened by omission. */
const ApproveBody = z.strictObject({
  name: tokenNameSchema.optional(),
  scopes: scopesSchema,
  profileId: tokenProfileSchema,
});

/** Response of POST /api/pairings/:id/approve: the app collects the secret itself, so it is never in here. */
export interface ApprovePairingResponse {
  token: ApiTokenInfo;
}

function issues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
}

/** App names come from unauthenticated pairing requests / app registrations: quote and bound them. */
function appLabel(name: string): string {
  return JSON.stringify(truncate(name, 100));
}

const pairingRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  const { repos } = services;
  installErrorHandler(app);

  // services.pairings / services.apps are wired by main.ts: always read them lazily.
  const findPairing = (id: string): PairingRequest | null => services.pairings.list().find((p) => p.id === id) ?? null;

  // ---- pairings ----

  app.get('/api/pairings', { preHandler: requireAdmin }, async (_req, reply): Promise<PairingRequest[]> => {
    reply.header('cache-control', 'no-store');
    return services.pairings.list();
  });

  app.post('/api/pairings/:id/approve', { preHandler: requireAdmin }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 400, 'Invalid pairing id', 'invalid');
    const body = ApproveBody.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, issues(body.error), 'invalid');
    const { name, scopes, profileId } = body.data;
    if (name !== undefined && CONTROL_RE.test(name)) return sendError(reply, 400, 'name: control characters are not allowed', 'invalid');

    const pairing = findPairing(params.data.id);
    if (!pairing) return sendError(reply, 404, 'This connection request is gone (it expired or was answered)', 'not_found');
    if (profileId !== null && !repos.profiles.get(profileId)) return sendError(reply, 404, 'Profile not found', 'unknown_profile');
    if (repos.apiTokens.list().length >= MAX_API_TOKENS) {
      return sendError(reply, 409, `At most ${MAX_API_TOKENS} tokens; revoke unused ones first`, 'limit');
    }

    const token = services.pairings.approve(pairing.id, {
      ...(name !== undefined ? { name } : {}),
      scopes: uniqueScopes(scopes),
      profileId,
      approvedBy: req.user?.username ?? null,
    });
    // The secret stays with the pairing service until the app collects it: never logged or audited.
    audit(
      services,
      req,
      'pairing.approve',
      `${appLabel(pairing.appName)} (${pairing.kind}) code=${pairing.code} ${profileLabel(services, token.profileId ?? null)} ` +
        `scopes=${token.scopes.join(', ')} token=${token.prefix}…`,
    );
    const response: ApprovePairingResponse = { token };
    return reply.header('cache-control', 'no-store').send(response);
  });

  app.post('/api/pairings/:id/deny', { preHandler: requireAdmin }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 400, 'Invalid pairing id', 'invalid');
    const pairing = findPairing(params.data.id);
    if (!pairing) return sendError(reply, 404, 'This connection request is gone (it expired or was answered)', 'not_found');
    services.pairings.deny(pairing.id);
    audit(services, req, 'pairing.deny', `${appLabel(pairing.appName)} (${pairing.kind}) code=${pairing.code}`);
    return {};
  });

  // ---- connected apps ----

  app.get('/api/apps', { preHandler: requireAdmin }, async (_req, reply): Promise<ConnectedApp[]> => {
    reply.header('cache-control', 'no-store');
    return services.apps.list();
  });

  app.delete('/api/apps/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const params = IdParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 400, 'Invalid app id', 'invalid');
    const connected = services.apps.get(params.data.id);
    if (!connected) return sendError(reply, 404, 'App not found', 'not_found');
    services.apps.remove(connected.id);
    // Its token keeps working (revoke it under API tokens to cut the app off); the app may register again.
    audit(services, req, 'app.remove', `${appLabel(connected.name)} id=${connected.id} kind=${connected.kind}`);
    return {};
  });
};

export default pairingRoutes;
