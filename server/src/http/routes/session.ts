import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { TitleResponse } from '../../../../shared/api.js';
import { textLength } from '../../orchestrator/async-utils.js';
import { MAX_TITLE_LENGTH } from '../../orchestrator/orchestrator.js';
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

const sessionRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  // services.orchestrator is wired after the services object is built: always read it lazily.
  const orchestrator = () => services.orchestrator;

  app.get('/api/session', { preHandler: requireUser }, async () => orchestrator().state());

  app.post('/api/session/start', { preHandler: requireUser }, async (req) => {
    await orchestrator().start('manual');
    audit(services, req, 'session.start');
    return orchestrator().state();
  });

  app.post('/api/session/stop', { preHandler: requireUser }, async (req) => {
    await orchestrator().stop('manual');
    audit(services, req, 'session.stop');
    return orchestrator().state();
  });

  app.put('/api/session/title', { preHandler: requireUser }, async (req, reply) => {
    const parsed = TitleBody.safeParse(req.body);
    if (!parsed.success) return sendError(reply, 400, issues(parsed.error), 'invalid');
    const results = await orchestrator().setTitle(parsed.data.title);
    audit(services, req, 'session.title', parsed.data.title);
    const body: TitleResponse = { title: orchestrator().state().title, results };
    return body;
  });

  app.put('/api/session/auto', { preHandler: requireUser }, async (req, reply) => {
    const parsed = AutoBody.safeParse(req.body);
    if (!parsed.success) return sendError(reply, 400, issues(parsed.error), 'invalid');
    orchestrator().setAutoGoLive(parsed.data.autoGoLive);
    audit(services, req, 'session.auto', parsed.data.autoGoLive ? 'on' : 'off');
    return orchestrator().state();
  });

  // Test mode: private/test setting per platform, the rest skipped. Only while no session runs.
  app.put('/api/session/test-mode', { preHandler: requireUser }, async (req, reply) => {
    const parsed = TestModeBody.safeParse(req.body);
    if (!parsed.success) return sendError(reply, 400, issues(parsed.error), 'invalid');
    try {
      orchestrator().setTestMode(parsed.data.testMode);
    } catch (err) {
      const e = err as { statusCode?: unknown; code?: unknown; message?: unknown };
      if (e.statusCode === 409) {
        const message = typeof e.message === 'string' && e.message ? e.message : 'A session is running';
        return sendError(reply, 409, message, typeof e.code === 'string' ? e.code : 'session_live');
      }
      throw err;
    }
    audit(services, req, 'session.test_mode', parsed.data.testMode ? 'on' : 'off');
    return orchestrator().state();
  });
};

export default sessionRoutes;
