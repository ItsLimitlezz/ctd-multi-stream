// Audit log (admin only), newest first, paged by id.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AuditResponse } from '../../../../shared/api.js';
import { requireAdmin, type RouteOptions } from '../guards.js';

const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.number().int().positive().optional(),
});

const auditRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  app.get('/api/audit', { preHandler: requireAdmin }, async (req): Promise<AuditResponse> => {
    const q = AuditQuery.parse(req.query ?? {});
    return services.repos.audit.list(q.before === undefined ? { limit: q.limit } : { limit: q.limit, before: q.before });
  });
};

export default auditRoutes;
