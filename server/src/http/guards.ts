import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiError } from '../../../shared/api.js';
import type { User } from '../../../shared/types.js';
import type { AppServices, AuthSessionRecord } from '../services.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth plugin from the session cookie. */
    user: User | null;
    authSession: AuthSessionRecord | null;
  }
}

/** Options every route plugin receives. */
export interface RouteOptions {
  services: AppServices;
}

export function sendError(reply: FastifyReply, status: number, error: string, code?: string): FastifyReply {
  const body: ApiError = code ? { error, code } : { error };
  return reply.code(status).send(body);
}

/** preHandler: any logged-in user. */
export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) {
    await sendError(reply, 401, 'Not logged in', 'unauthenticated');
  }
}

/** preHandler: admin only. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) {
    await sendError(reply, 401, 'Not logged in', 'unauthenticated');
    return;
  }
  if (req.user.role !== 'admin') {
    await sendError(reply, 403, 'Admin only', 'forbidden');
  }
}

/** Client IP (respects TRUST_PROXY via Fastify's trustProxy setting). */
export function clientIp(req: FastifyRequest): string | null {
  return req.ip ?? null;
}

/** Write an audit entry for the current request's user. */
export function audit(services: AppServices, req: FastifyRequest, action: string, detail?: string | null): void {
  services.repos.audit.log({
    userId: req.user?.id ?? null,
    username: req.user?.username ?? null,
    action,
    detail: detail ?? null,
    ip: clientIp(req),
  });
}
