import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TitleResponse } from '../../../../shared/api.js';
import { DEFAULT_PROFILE_ID } from '../../../../shared/types.js';
import { textLength } from '../../orchestrator/async-utils.js';
import { MAX_TITLE_LENGTH } from '../../orchestrator/orchestrator.js';
import { isUnknownProfileError, profileParam } from '../../orchestrator/registry.js';
import type { AppServices, Orchestrator } from '../../services.js';
import { audit, requireUser, sendError, type RouteOptions } from '../guards.js';

const TitleBody = z.object({
  title: z
    .string()
    .max(4 * MAX_TITLE_LENGTH)
    .transform((s) => s.trim())
    .refine((s) => textLength(s) <= MAX_TITLE_LENGTH, `must be at most ${MAX_TITLE_LENGTH} characters`),
});

const AutoBody = z.object({ autoGoLive: z.boolean() });
const TestModeBody = z.object({ testMode: z.boolean() });

function issues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
}

/**
 * The orchestrator of the profile asked for with `?profile=<id>` (default profile when omitted).
 * Sends 400 'invalid' / 404 'unknown_profile' and returns null when there is none.
 */
async function orchestratorFor(services: AppServices, req: FastifyRequest, reply: FastifyReply): Promise<Orchestrator | null> {
  const profileId = profileParam(req.query);
  if (profileId === null) {
    await sendError(reply, 400, 'profile: must be a profile id', 'invalid');
    return null;
  }
  try {
    // services.orchestrators is wired after the services object is built: always read it lazily.
    return services.orchestrators.get(profileId);
  } catch (err) {
    if (!isUnknownProfileError(err)) throw err;
    await sendError(reply, 404, 'Unknown profile', 'unknown_profile');
    return null;
  }
}

/** Audit detail naming the profile for every profile but the default one (whose entries stay as before). */
function auditDetail(services: AppServices, orch: Orchestrator, detail: string | null): string | null {
  if (orch.profileId === DEFAULT_PROFILE_ID) return detail;
  let name = orch.profileId;
  try {
    name = services.repos.profiles.get(orch.profileId)?.name ?? name;
  } catch {
    // keep the id
  }
  return detail === null ? `profile: ${name}` : `profile: ${name}; ${detail}`;
}

/** Go live / stop / title / auto go-live / test mode, per profile (`?profile=<id>`, see shared/api.ts). */
const sessionRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  app.get('/api/session', { preHandler: requireUser }, async (req, reply) => {
    const orch = await orchestratorFor(services, req, reply);
    if (!orch) return reply;
    return orch.state();
  });

  app.post('/api/session/start', { preHandler: requireUser }, async (req, reply) => {
    const orch = await orchestratorFor(services, req, reply);
    if (!orch) return reply;
    await orch.start('manual');
    audit(services, req, 'session.start', auditDetail(services, orch, null));
    return orch.state();
  });

  app.post('/api/session/stop', { preHandler: requireUser }, async (req, reply) => {
    const orch = await orchestratorFor(services, req, reply);
    if (!orch) return reply;
    await orch.stop('manual');
    audit(services, req, 'session.stop', auditDetail(services, orch, null));
    return orch.state();
  });

  app.put('/api/session/title', { preHandler: requireUser }, async (req, reply) => {
    const orch = await orchestratorFor(services, req, reply);
    if (!orch) return reply;
    const parsed = TitleBody.safeParse(req.body);
    if (!parsed.success) return sendError(reply, 400, issues(parsed.error), 'invalid');
    const results = await orch.setTitle(parsed.data.title);
    audit(services, req, 'session.title', auditDetail(services, orch, parsed.data.title));
    const body: TitleResponse = { title: orch.state().title, results };
    return body;
  });

  app.put('/api/session/auto', { preHandler: requireUser }, async (req, reply) => {
    const orch = await orchestratorFor(services, req, reply);
    if (!orch) return reply;
    const parsed = AutoBody.safeParse(req.body);
    if (!parsed.success) return sendError(reply, 400, issues(parsed.error), 'invalid');
    orch.setAutoGoLive(parsed.data.autoGoLive);
    audit(services, req, 'session.auto', auditDetail(services, orch, parsed.data.autoGoLive ? 'on' : 'off'));
    return orch.state();
  });

  // Test mode: private/test setting per platform, the rest skipped. Only while no session runs.
  app.put('/api/session/test-mode', { preHandler: requireUser }, async (req, reply) => {
    const orch = await orchestratorFor(services, req, reply);
    if (!orch) return reply;
    const parsed = TestModeBody.safeParse(req.body);
    if (!parsed.success) return sendError(reply, 400, issues(parsed.error), 'invalid');
    try {
      orch.setTestMode(parsed.data.testMode);
    } catch (err) {
      const e = err as { statusCode?: unknown; code?: unknown; message?: unknown };
      if (e.statusCode === 409) {
        const message = typeof e.message === 'string' && e.message ? e.message : 'A session is running';
        return sendError(reply, 409, message, typeof e.code === 'string' ? e.code : 'session_live');
      }
      throw err;
    }
    audit(services, req, 'session.test_mode', auditDetail(services, orch, parsed.data.testMode ? 'on' : 'off'));
    return orch.state();
  });
};

export default sessionRoutes;
