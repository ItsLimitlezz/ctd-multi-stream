import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { createRepos } from '../db/repos.js';
import {
  ACCOUNT_LOCK_MS,
  IpFailureLimiter,
  LoginLockout,
  MAX_ACCOUNT_FAILURES,
  MAX_ACCOUNT_FAILURES_TOTAL,
  lockRemainingMs,
  loginTarget,
  minutesRemaining,
  recordAccountFailure,
  recordAccountSuccess,
} from './login-guard.js';
import { createSecretBox } from './secretbox.js';

describe('IpFailureLimiter', () => {
  it('blocks after 20 failures in 15 minutes and slides the window', () => {
    const lim = new IpFailureLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 19; i++) lim.recordFailure('203.0.113.5', t0 + i * 1000);
    expect(lim.retryAfterSec('203.0.113.5', t0 + 20_000)).toBe(0);
    lim.recordFailure('203.0.113.5', t0 + 20_000);
    const retry = lim.retryAfterSec('203.0.113.5', t0 + 20_000);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(15 * 60);
    // Other IPs are unaffected.
    expect(lim.retryAfterSec('203.0.113.6', t0 + 20_000)).toBe(0);
    // Once the oldest failure leaves the window, one more attempt is allowed.
    expect(lim.retryAfterSec('203.0.113.5', t0 + 15 * 60_000 + 1)).toBe(0);
  });

  it('groups IPv6 addresses by /64 and IPv4-mapped addresses with IPv4', () => {
    const lim = new IpFailureLimiter(2, 60_000);
    lim.recordFailure('2001:db8:1:2::1', 0);
    lim.recordFailure('2001:db8:1:2::ffff', 1);
    expect(lim.retryAfterSec('2001:db8:1:2:abcd::9', 2)).toBeGreaterThan(0);
    expect(lim.retryAfterSec('2001:db8:1:3::1', 2)).toBe(0);
    lim.recordFailure('::ffff:198.51.100.7', 0);
    lim.recordFailure('198.51.100.7', 1);
    expect(lim.retryAfterSec('198.51.100.7', 2)).toBeGreaterThan(0);
  });

  it('bounds memory', () => {
    const lim = new IpFailureLimiter(20, 60_000, 100);
    for (let i = 0; i < 500; i++) lim.recordFailure(`10.0.${i >> 8}.${i & 255}`, i);
    expect(lim.size).toBeLessThanOrEqual(100);
  });
});

describe('account lockout', () => {
  const repos = createRepos(openDatabase(':memory:'), createSecretBox(crypto.randomBytes(32)));

  it('locks after MAX_ACCOUNT_FAILURES_TOTAL consecutive failures, never extends a lock, and resets on success', () => {
    const user = repos.users.create({ username: 'locky', passwordHash: 'x', role: 'operator' });
    const now = Date.now();
    for (let i = 1; i < MAX_ACCOUNT_FAILURES_TOTAL; i++) {
      expect(recordAccountFailure(repos.users, user.id, now)).toBeNull();
      expect(repos.users.get(user.id)?.failedLogins).toBe(i);
    }
    const until = recordAccountFailure(repos.users, user.id, now);
    expect(until).toBe(new Date(now + ACCOUNT_LOCK_MS).toISOString());
    const locked = repos.users.get(user.id);
    expect(locked?.failedLogins).toBe(0);
    expect(lockRemainingMs(locked!, now)).toBe(ACCOUNT_LOCK_MS);
    expect(minutesRemaining(lockRemainingMs(locked!, now))).toBe(15);
    expect(lockRemainingMs(locked!, now + ACCOUNT_LOCK_MS)).toBe(0);
    // Failures while locked (e.g. attempts that were already hashing) change nothing.
    expect(recordAccountFailure(repos.users, user.id, now + 60_000)).toBeNull();
    expect(repos.users.get(user.id)).toMatchObject({ failedLogins: 0, lockedUntil: until });

    const me = recordAccountSuccess(repos.users, user.id, now);
    expect(me.lastLoginAt).toBe(new Date(now).toISOString());
    const after = repos.users.get(user.id);
    expect(after?.failedLogins).toBe(0);
    expect(after?.lockedUntil).toBeNull();
  });

  it('ignores unknown users and garbage lock values', () => {
    expect(recordAccountFailure(repos.users, 'missing')).toBeNull();
    expect(lockRemainingMs({ lockedUntil: null })).toBe(0);
    expect(lockRemainingMs({ lockedUntil: 'not a date' })).toBe(0);
  });
});

describe('LoginLockout', () => {
  const repos = createRepos(openDatabase(':memory:'), createSecretBox(crypto.randomBytes(32)));
  let n = 0;
  const newUser = () => repos.users.create({ username: `lock${++n}`, passwordHash: 'x', role: 'operator' });
  const A = '203.0.113.1';
  const B = '203.0.113.2';

  it('locks one address at a time and lets other addresses in', () => {
    const lockout = new LoginLockout(repos.users);
    const user = newUser();
    const target = loginTarget(user, user.username);
    const now = Date.now();
    for (let i = 1; i < MAX_ACCOUNT_FAILURES; i++) expect(lockout.recordFailure(target, A, now)).toEqual({ lockMs: 0, locked: null });
    expect(lockout.recordFailure(target, A, now)).toEqual({ lockMs: ACCOUNT_LOCK_MS, locked: 'address' });
    expect(lockout.reserve(target, A, now)).toEqual({ ok: false, lockMs: ACCOUNT_LOCK_MS });
    expect(lockout.lockMs(target, B, now)).toBe(0);
    expect(lockout.reserve(target, B, now).ok).toBe(true);
    expect(lockout.lockMs(target, A, now + ACCOUNT_LOCK_MS)).toBe(0);
  });

  it('counts in-flight attempts so a concurrent burst gets no extra guesses', () => {
    const lockout = new LoginLockout(repos.users);
    const user = newUser();
    const target = loginTarget(user, user.username);
    const now = Date.now();
    lockout.recordFailure(target, A, now);
    const slots = Array.from({ length: MAX_ACCOUNT_FAILURES + 3 }, () => lockout.reserve(target, A, now));
    expect(slots.filter((s) => s.ok)).toHaveLength(MAX_ACCOUNT_FAILURES - 1);
    expect(slots.filter((s) => !s.ok)).toEqual(Array(4).fill({ ok: false, lockMs: 0 }));
    for (const s of slots) if (s.ok) s.release();
    // Released without failing (e.g. correct password): the slots are free again.
    expect(lockout.reserve(target, A, now).ok).toBe(true);
  });

  it('applies the account-wide lock to new addresses only, and clears it on success', () => {
    const lockout = new LoginLockout(repos.users);
    const user = newUser();
    const target = loginTarget(user, user.username);
    const now = Date.now();
    lockout.recordSuccess(user.id, A, now);
    repos.users.update(user.id, { failedLogins: MAX_ACCOUNT_FAILURES_TOTAL - 1 });
    expect(lockout.recordFailure(target, B, now)).toEqual({ lockMs: ACCOUNT_LOCK_MS, locked: 'account' });
    expect(lockout.lockMs(target, '198.51.100.9', now)).toBe(ACCOUNT_LOCK_MS);
    expect(lockout.lockMs(target, A, now)).toBe(0);
    expect(lockout.reserve(target, A, now).ok).toBe(true);
    lockout.recordSuccess(user.id, A, now);
    expect(repos.users.get(user.id)).toMatchObject({ failedLogins: 0, lockedUntil: null });
    expect(lockout.lockMs(target, B, now)).toBe(0);
  });

  it('treats unknown usernames exactly like real accounts', () => {
    const lockout = new LoginLockout(repos.users);
    const user = newUser();
    const real = loginTarget(user, user.username);
    const ghost = loginTarget(null, 'Nobody-Here');
    expect(loginTarget(null, 'NOBODY-HERE')).toEqual(ghost);
    const now = Date.now();
    // Spread over addresses so only the account-wide total locks.
    for (let i = 0; i < MAX_ACCOUNT_FAILURES_TOTAL; i++) {
      const ip = `10.1.${i >> 8}.${i & 255}`;
      expect(lockout.recordFailure(ghost, ip, now)).toEqual(lockout.recordFailure(real, ip, now));
    }
    for (const ip of [A, B]) {
      expect(lockout.lockMs(ghost, ip, now)).toBe(ACCOUNT_LOCK_MS);
      expect(lockout.reserve(ghost, ip, now)).toEqual(lockout.reserve(real, ip, now));
    }
  });

  it('bounds memory', () => {
    const lockout = new LoginLockout(repos.users, 50);
    const now = Date.now();
    for (let i = 0; i < 500; i++) lockout.recordFailure(loginTarget(null, `ghost${i}`), `10.2.${i >> 8}.${i & 255}`, now);
    const internals = lockout as unknown as { pairs: Map<string, unknown>; ghosts: Map<string, unknown> };
    expect(internals.pairs.size).toBeLessThanOrEqual(50);
    expect(internals.ghosts.size).toBeLessThanOrEqual(50);
  });
});
