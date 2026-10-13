// User management (admin only).

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { User } from '../../../../shared/types.js';
import { hashPassword, passwordSchema, usernameSchema } from '../../security/passwords.js';
import { forgetTotpUser } from '../../security/totp.js';
import { sessionToken } from '../auth-plugin.js';
import { audit, requireAdmin, sendError, type RouteOptions } from '../guards.js';

const RoleSchema = z.enum(['admin', 'operator']);
const CreateUserBody = z.object({ username: usernameSchema, password: passwordSchema, role: RoleSchema });
const UpdateUserBody = z.object({
  role: RoleSchema.optional(),
  password: passwordSchema.optional(),
  resetTotp: z.boolean().optional(),
});
const IdParams = z.object({ id: z.string().min(1).max(64) });

const userRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  const { repos } = services;
  const adminCount = () => repos.users.list().filter((u) => u.role === 'admin').length;

  app.get('/api/users', { preHandler: requireAdmin }, async (): Promise<User[]> => repos.users.list());

  app.post('/api/users', { preHandler: requireAdmin }, async (req, reply) => {
    const body = CreateUserBody.parse(req.body);
    if (repos.users.getByUsername(body.username)) return sendError(reply, 409, 'Username already exists', 'username_taken');
    const passwordHash = await hashPassword(body.password);
    // create() throws a 409 ConflictError if the name was taken while we hashed.
    const user = repos.users.create({ username: body.username, passwordHash, role: body.role });
    audit(services, req, 'user.create', `${user.username} (${user.role})`);
    return user;
  });

  app.patch('/api/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = UpdateUserBody.parse(req.body ?? {});
    if (!repos.users.get(id)) return sendError(reply, 404, 'User not found', 'not_found');

    // Hash first; everything after this await runs synchronously, so the checks below can't race.
    const passwordHash = body.password ? await hashPassword(body.password) : undefined;
    const target = repos.users.get(id);
    if (!target) return sendError(reply, 404, 'User not found', 'not_found');

    const changes: string[] = [];
    const roleChanged = body.role !== undefined && body.role !== target.role;
    if (roleChanged) {
      if (target.role === 'admin' && adminCount() <= 1) {
        return sendError(reply, 409, 'Cannot demote the last admin', 'last_admin');
      }
      changes.push(`role ${target.role} -> ${body.role}`);
    }
    if (passwordHash) changes.push('password reset');
    const resetTotp = body.resetTotp === true && (target.totpEnabled || target.totpPendingSecret !== null);
    if (resetTotp) changes.push('2FA reset');

    const updated = repos.users.update(id, {
      role: roleChanged ? body.role : undefined,
      // An admin reset also clears a lockout.
      ...(passwordHash ? { passwordHash, failedLogins: 0, lockedUntil: null } : {}),
      ...(resetTotp ? { totpEnabled: false, totpSecret: null, totpPendingSecret: null } : {}),
    });
    if (resetTotp) forgetTotpUser(id);
    if (passwordHash) {
      // Sign the user out everywhere (keep the admin's own session when resetting themselves).
      const keep = id === req.user?.id ? (sessionToken(req) ?? undefined) : undefined;
      repos.authSessions.deleteForUser(id, keep);
    }
    if (changes.length > 0) audit(services, req, 'user.update', `${target.username}: ${changes.join(', ')}`);
    return updated;
  });

  app.delete('/api/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    if (id === req.user?.id) return sendError(reply, 400, 'You cannot delete your own account', 'cannot_delete_self');
    const target = repos.users.get(id);
    if (!target) return sendError(reply, 404, 'User not found', 'not_found');
    if (target.role === 'admin' && adminCount() <= 1) {
      return sendError(reply, 409, 'Cannot delete the last admin', 'last_admin');
    }
    repos.authSessions.deleteForUser(id);
    repos.users.delete(id);
    forgetTotpUser(id);
    audit(services, req, 'user.delete', target.username);
    return {};
  });
};

export default userRoutes;
