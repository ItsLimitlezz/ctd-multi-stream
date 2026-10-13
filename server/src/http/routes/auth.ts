// Login / logout / me, password change and optional TOTP 2FA.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { MeResponse, TotpSetupResponse } from '../../../../shared/api.js';
import type { UserRecord } from '../../services.js';
import {
  ACCOUNT_LOCK_MS,
  IpFailureLimiter,
  LoginLockout,
  MAX_ACCOUNT_FAILURES,
  MAX_ACCOUNT_FAILURES_TOTAL,
  credentialRateLimit,
  loginTarget,
  minutesRemaining,
  rateLimitErrorHandler,
  type LoginTarget,
} from '../../security/login-guard.js';
import {
  PASSWORD_MAX,
  hashPassword,
  needsRehash,
  passwordSchema,
  verifyDummyPassword,
  verifyPassword,
  warmUpDummyHash,
} from '../../security/passwords.js';
import { forgetTotpUser, generateTotpSecret, otpauthUrl, totpQrSvg, verifyTotp } from '../../security/totp.js';
import { beginSession, clearSessionCookie, cookieSecure, sessionToken, setSessionCookie } from '../auth-plugin.js';
import { audit, clientIp, requireUser, sendError, type RouteOptions } from '../guards.js';

const anyPassword = z.string().min(1).max(PASSWORD_MAX);

const LoginBody = z.object({
  username: z.string().min(1).max(64),
  password: anyPassword,
  totp: z.string().max(16).optional(),
});
const ChangePasswordBody = z.object({ currentPassword: anyPassword, newPassword: passwordSchema });
const TotpEnableBody = z.object({ code: z.string().min(1).max(16) });
const TotpDisableBody = z.object({ password: anyPassword });

const INVALID_LOGIN = 'Invalid username or password';

function lockedReply(reply: FastifyReply, ms: number): FastifyReply {
  const min = minutesRemaining(ms);
  reply.header('retry-after', String(Math.ceil(ms / 1000)));
  return sendError(
    reply,
    423,
    `Account locked after too many failed logins. Try again in ${min} minute${min === 1 ? '' : 's'}.`,
    'locked',
  );
}

function invalidLogin(reply: FastifyReply): FastifyReply {
  return sendError(reply, 401, INVALID_LOGIN, 'invalid_credentials');
}

const authRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  const { repos, secretBox } = services;
  const log = services.log.child({ mod: 'auth' });
  const secure = cookieSecure(services.config);
  const ipFailures = new IpFailureLimiter();
  const lockout = new LoginLockout(repos.users);
  app.setErrorHandler(rateLimitErrorHandler);
  warmUpDummyHash();

  /** Audit with an explicit actor (login happens before req.user exists). */
  const auditAs = (req: FastifyRequest, actor: { id: string | null; username: string | null }, action: string, detail?: string) =>
    repos.audit.log({ userId: actor.id, username: actor.username, action, detail: detail ?? null, ip: clientIp(req) });

  /** The logged-in user's full record, or a 401 reply. */
  const self = (req: FastifyRequest, reply: FastifyReply): UserRecord | null => {
    const user = req.user ? repos.users.get(req.user.id) : null;
    if (!user) sendError(reply, 401, 'Not logged in', 'unauthenticated');
    return user;
  };

  /**
   * Count a failed credential check; replies 423 if this client is now locked out of the
   * account (just now or already). Known and unknown usernames take exactly the same path.
   */
  const failAttempt = (
    req: FastifyRequest,
    reply: FastifyReply,
    ip: string,
    target: LoginTarget,
    actor: { id: string | null; username: string },
    detail: string,
  ): FastifyReply | null => {
    ipFailures.recordFailure(ip);
    auditAs(req, actor, 'auth.login_failed', detail);
    const { lockMs, locked } = lockout.recordFailure(target, ip);
    if (locked && target.userId) {
      const lockMin = ACCOUNT_LOCK_MS / 60_000;
      auditAs(
        req,
        actor,
        'auth.locked',
        locked === 'address'
          ? `locked for ${lockMin} minutes from this address after ${MAX_ACCOUNT_FAILURES} failed attempts`
          : `locked for ${lockMin} minutes from new addresses after ${MAX_ACCOUNT_FAILURES_TOTAL} failed attempts`,
      );
      log.warn({ username: actor.username, ip, scope: locked }, 'account locked after repeated failed logins');
    }
    return lockMs > 0 ? lockedReply(reply, lockMs) : null;
  };

  app.post('/api/auth/login', { config: { rateLimit: credentialRateLimit } }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const ip = clientIp(req) ?? 'unknown';
    const retryAfter = ipFailures.retryAfterSec(ip);
    if (retryAfter > 0) {
      reply.header('retry-after', String(retryAfter));
      const min = minutesRemaining(retryAfter * 1000);
      return sendError(reply, 429, `Too many failed logins from your address. Try again in ${min} min.`, 'rate_limited');
    }

    const body = LoginBody.parse(req.body);
    const user = repos.users.getByUsername(body.username);
    const target = loginTarget(user, body.username);
    // Claim the attempt before hashing so concurrent requests can't get past the lockout.
    const slot = lockout.reserve(target, ip);
    if (!slot.ok) {
      if (slot.lockMs > 0) return lockedReply(reply, slot.lockMs);
      reply.header('retry-after', '1');
      return sendError(reply, 429, 'Too many login attempts at once. Try again in a moment.', 'rate_limited');
    }
    try {
      // Unknown users still pay for a hash so response time doesn't reveal which usernames exist.
      const passwordOk = user ? await verifyPassword(body.password, user.passwordHash) : await verifyDummyPassword(body.password);
      if (!user) return failAttempt(req, reply, ip, target, { id: null, username: body.username }, 'unknown user') ?? invalidLogin(reply);
      if (!passwordOk) return failAttempt(req, reply, ip, target, user, 'wrong password') ?? invalidLogin(reply);

      // Re-read after the await: a parallel attempt may have locked or changed the account.
      const fresh = repos.users.get(user.id);
      if (!fresh) return invalidLogin(reply);
      // Locked meanwhile: count and answer it exactly like a wrong password, so the reply
      // doesn't reveal that this guess was right.
      if (lockout.lockMs(target, ip) > 0) return failAttempt(req, reply, ip, target, fresh, 'account locked') ?? invalidLogin(reply);

      if (fresh.totpEnabled) {
        const code = body.totp?.trim();
        if (!code) return sendError(reply, 401, 'Enter the 6-digit code from your authenticator app', 'totp_required');
        let secret: string | null = null;
        try {
          secret = fresh.totpSecret ? secretBox.decrypt(fresh.totpSecret) : null;
        } catch (err) {
          log.error({ err, username: fresh.username }, 'cannot decrypt TOTP secret (master key changed?)');
        }
        if (!secret || !verifyTotp(fresh.id, secret, code)) {
          return (
            failAttempt(req, reply, ip, target, fresh, 'invalid two-factor code') ??
            sendError(reply, 401, 'Invalid two-factor code', 'totp_required')
          );
        }
      }

      if (needsRehash(fresh.passwordHash)) {
        try {
          repos.users.update(fresh.id, { passwordHash: await hashPassword(body.password) });
        } catch (err) {
          log.warn({ err }, 'password rehash failed');
        }
      }

      const me = lockout.recordSuccess(fresh.id, ip);
      const session = beginSession(services, req, reply, me.id);
      auditAs(req, me, 'auth.login');
      const res: MeResponse = { user: me, csrfToken: session.csrfToken };
      return res;
    } finally {
      slot.release();
    }
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = sessionToken(req);
    if (token) repos.authSessions.delete(token);
    if (req.user) audit(services, req, 'auth.logout');
    clearSessionCookie(reply, secure);
    return {};
  });

  app.get('/api/auth/me', { preHandler: requireUser }, async (req, reply) => {
    const token = sessionToken(req);
    if (!req.user || !req.authSession || !token) return sendError(reply, 401, 'Not logged in', 'unauthenticated');
    reply.header('cache-control', 'no-store');
    // Re-issue the cookie so its lifetime follows the sliding server-side expiry.
    setSessionCookie(reply, token, secure, (Date.parse(req.authSession.expiresAt) - Date.now()) / 1000);
    const res: MeResponse = { user: req.user, csrfToken: req.authSession.csrfToken };
    return res;
  });

  app.post('/api/auth/password', { preHandler: requireUser, config: { rateLimit: credentialRateLimit } }, async (req, reply) => {
    const body = ChangePasswordBody.parse(req.body);
    const user = self(req, reply);
    if (!user) return reply;
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      audit(services, req, 'auth.password_change_failed');
      return sendError(reply, 400, 'Current password is incorrect', 'invalid_password');
    }
    repos.users.update(user.id, { passwordHash: await hashPassword(body.newPassword) });
    // Sign out every other device; keep this one.
    repos.authSessions.deleteForUser(user.id, sessionToken(req) ?? undefined);
    audit(services, req, 'auth.password_changed');
    return {};
  });

  app.post('/api/auth/totp/setup', { preHandler: requireUser }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const user = self(req, reply);
    if (!user) return reply;
    if (user.totpEnabled) {
      return sendError(reply, 409, 'Two-factor authentication is already on. Turn it off first to use a new authenticator.', 'totp_enabled');
    }
    const secret = generateTotpSecret();
    repos.users.update(user.id, { totpPendingSecret: secretBox.encrypt(secret) });
    const url = otpauthUrl(user.username, secret);
    const res: TotpSetupResponse = { secret, otpauthUrl: url, qrSvg: await totpQrSvg(url) };
    return res;
  });

  app.post('/api/auth/totp/enable', { preHandler: requireUser, config: { rateLimit: credentialRateLimit } }, async (req, reply) => {
    const { code } = TotpEnableBody.parse(req.body);
    const user = self(req, reply);
    if (!user) return reply;
    if (user.totpEnabled) return sendError(reply, 409, 'Two-factor authentication is already on', 'totp_enabled');
    if (!user.totpPendingSecret) return sendError(reply, 400, 'Start two-factor setup first', 'totp_not_pending');
    const secret = secretBox.decrypt(user.totpPendingSecret);
    if (!verifyTotp(user.id, secret, code)) {
      return sendError(reply, 400, 'Invalid code. Check that the time on your phone is correct and try again.', 'invalid_code');
    }
    repos.users.update(user.id, { totpSecret: user.totpPendingSecret, totpPendingSecret: null, totpEnabled: true });
    audit(services, req, 'auth.totp_enabled');
    return {};
  });

  app.post('/api/auth/totp/disable', { preHandler: requireUser, config: { rateLimit: credentialRateLimit } }, async (req, reply) => {
    const { password } = TotpDisableBody.parse(req.body);
    const user = self(req, reply);
    if (!user) return reply;
    if (!(await verifyPassword(password, user.passwordHash))) {
      return sendError(reply, 400, 'Password is incorrect', 'invalid_password');
    }
    repos.users.update(user.id, { totpEnabled: false, totpSecret: null, totpPendingSecret: null });
    forgetTotpUser(user.id);
    if (user.totpEnabled) audit(services, req, 'auth.totp_disabled');
    return {};
  });
};

export default authRoutes;
