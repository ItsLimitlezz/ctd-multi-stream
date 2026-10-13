import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../../../shared/api.js';
import type { Role } from '../../../shared/types.js';
import type { AppServices, AuthSessionRecord } from '../services.js';
import { sessionRevalidator } from './auth-plugin.js';

function fixture(opts: { withPeek?: boolean } = {}) {
  const sessions = new Map<string, string>([['tok', 'u1']]);
  const users = new Map<string, Role>([['u1', 'admin']]);
  const lookup = (token: string) => (sessions.has(token) ? ({ id: 'hash', userId: sessions.get(token) } as AuthSessionRecord) : null);
  const peek = vi.fn(lookup);
  const touch = vi.fn(lookup);
  const services = {
    repos: {
      authSessions: { touch, ...(opts.withPeek === false ? {} : { peek }) },
      users: { get: (id: string) => (users.has(id) ? { id, role: users.get(id) } : null) },
    },
  } as unknown as Pick<AppServices, 'repos'>;
  const req = (cookie: string | null, userId: string | null) =>
    ({ cookies: cookie ? { [SESSION_COOKIE]: cookie } : {}, user: userId ? { id: userId } : null }) as unknown as FastifyRequest;
  return { sessions, users, peek, touch, services, req };
}

describe('sessionRevalidator', () => {
  it('stays valid until the session is deleted, without sliding its expiry', () => {
    const fx = fixture();
    const check = sessionRevalidator(fx.services, fx.req('tok', 'u1'));
    expect(check()).toBe(true);
    expect(fx.peek).toHaveBeenCalledWith('tok');
    expect(fx.touch).not.toHaveBeenCalled();
    fx.sessions.delete('tok'); // logout, password change, CLI reset, expiry
    expect(check()).toBe(false);
  });

  it('fails for a deleted user, a session of another user and (admin) a demoted user', () => {
    const fx = fixture();
    const anyUser = sessionRevalidator(fx.services, fx.req('tok', 'u1'));
    const adminOnly = sessionRevalidator(fx.services, fx.req('tok', 'u1'), { admin: true });
    expect(adminOnly()).toBe(true);
    fx.users.set('u1', 'operator');
    expect(adminOnly()).toBe(false);
    expect(anyUser()).toBe(true);
    fx.users.delete('u1');
    expect(anyUser()).toBe(false);

    fx.sessions.set('tok', 'u2');
    fx.users.set('u1', 'admin');
    expect(sessionRevalidator(fx.services, fx.req('tok', 'u1'))()).toBe(false);
  });

  it('fails without a session cookie and falls back to touch() when the repo has no peek()', () => {
    const fx = fixture({ withPeek: false });
    expect(sessionRevalidator(fx.services, fx.req(null, 'u1'))()).toBe(false);
    expect(sessionRevalidator(fx.services, fx.req('tok', 'u1'))()).toBe(true);
    expect(fx.touch).toHaveBeenCalledWith('tok');
  });
});
