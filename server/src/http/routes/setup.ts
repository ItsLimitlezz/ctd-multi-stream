// First-run setup: create the admin account with the one-time code from the logs.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { MeResponse, SetupStatusResponse } from '../../../../shared/api.js';
import { credentialRateLimit, rateLimitErrorHandler } from '../../security/login-guard.js';
import { hashPassword, passwordSchema, usernameSchema } from '../../security/passwords.js';
import { clearSetupCode, verifySetupCode } from '../../security/setup-code.js';
import { beginSession } from '../auth-plugin.js';
import { clientIp, sendError, type RouteOptions } from '../guards.js';

const SetupBody = z.object({
  setupCode: z.string().min(1).max(64),
  username: usernameSchema,
  password: passwordSchema,
});

const setupRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  const { repos } = services;
  const log = services.log.child({ mod: 'setup' });
  app.setErrorHandler(rateLimitErrorHandler);

  app.get('/api/setup/status', async (): Promise<SetupStatusResponse> => ({ needsSetup: repos.users.count() === 0 }));

  app.post('/api/setup', { config: { rateLimit: credentialRateLimit } }, async (req, reply) => {
    if (repos.users.count() > 0) return sendError(reply, 409, 'Setup is already complete', 'already_setup');
    const body = SetupBody.parse(req.body);

    if (!verifySetupCode(body.setupCode)) {
      log.warn({ ip: clientIp(req) }, 'setup attempt with a wrong setup code');
      return sendError(reply, 403, 'Invalid setup code. Check the server logs for the current code.', 'invalid_setup_code');
    }

    const passwordHash = await hashPassword(body.password);
    // Re-check after the await: two setup requests may have raced past the first check.
    if (repos.users.count() > 0) return sendError(reply, 409, 'Setup is already complete', 'already_setup');

    const created = repos.users.create({ username: body.username, passwordHash, role: 'admin' });
    clearSetupCode();
    const user = repos.users.update(created.id, { lastLoginAt: new Date().toISOString() });
    const session = beginSession(services, req, reply, user.id);
    repos.audit.log({ userId: user.id, username: user.username, action: 'setup.complete', ip: clientIp(req) });
    log.info({ username: user.username }, 'setup complete: admin account created');

    const res: MeResponse = { user, csrfToken: session.csrfToken };
    return res;
  });
};

export default setupRoutes;
