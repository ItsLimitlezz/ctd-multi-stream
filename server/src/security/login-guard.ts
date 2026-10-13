// Brute-force protection for login/setup: per-account lockout, per-IP failure window,
// and the @fastify/rate-limit route config used on credential endpoints.

import type { FastifyReply, FastifyRequest } from 'fastify';
import fastifyRateLimit, { type RateLimitOptions } from '@fastify/rate-limit';
import { sendError } from '../http/guards.js';
import type { User } from '../../../shared/types.js';
import type { UserRecord, UsersRepo } from '../services.js';

/** Failures (within ACCOUNT_LOCK_MS) that lock one account for one client address. */
export const MAX_ACCOUNT_FAILURES = 5;
/** Consecutive failures from all addresses together that lock the account for addresses it never logged in from. */
export const MAX_ACCOUNT_FAILURES_TOTAL = 50;
export const ACCOUNT_LOCK_MS = 15 * 60_000;
/** How long an address that logged in successfully may still get past an account-wide lock. */
export const KNOWN_ADDRESS_MS = 30 * 24 * 3600_000;
export const IP_MAX_FAILURES = 20;
export const IP_WINDOW_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// Account-wide lockout (state lives in the users table)
// ---------------------------------------------------------------------------

/** Milliseconds until the account unlocks; 0 when not locked. */
export function lockRemainingMs(user: Pick<UserRecord, 'lockedUntil'>, now = Date.now()): number {
  if (!user.lockedUntil) return 0;
  const until = Date.parse(user.lockedUntil);
  return Number.isFinite(until) && until > now ? until - now : 0;
}

export function minutesRemaining(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60_000));
}

type LockState = Pick<UserRecord, 'failedLogins' | 'lockedUntil'>;

/** The lock state after one more failure, or null while already locked (a lock is never extended). */
function nextFailureState(state: LockState, now: number): LockState | null {
  if (lockRemainingMs(state, now) > 0) return null;
  const failures = state.failedLogins + 1;
  if (failures >= MAX_ACCOUNT_FAILURES_TOTAL) return { failedLogins: 0, lockedUntil: new Date(now + ACCOUNT_LOCK_MS).toISOString() };
  return { failedLogins: failures, lockedUntil: state.lockedUntil };
}

/**
 * Count a failed attempt against the account-wide total. Returns the lock expiry (ISO) when
 * this failure locked the account. Does nothing while the account is already locked. The
 * counter restarts after a lock so there are fresh tries once it expires.
 */
export function recordAccountFailure(users: UsersRepo, userId: string, now = Date.now()): string | null {
  const fresh = users.get(userId); // re-read: other attempts may have run while we hashed
  if (!fresh) return null;
  const next = nextFailureState(fresh, now);
  if (!next) return null;
  users.update(userId, next);
  return next.lockedUntil !== fresh.lockedUntil ? next.lockedUntil : null;
}

/** Successful login: clear failures/lock and stamp lastLoginAt. */
export function recordAccountSuccess(users: UsersRepo, userId: string, now = Date.now()): User {
  return users.update(userId, { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date(now).toISOString() });
}

// ---------------------------------------------------------------------------
// Login lockout: per (account, client address) lock, the account-wide lock above,
// and in-flight reservations so concurrent attempts can't outrun either limit.
// ---------------------------------------------------------------------------

/**
 * What a login attempt targets: a real account, or a username that doesn't exist. Unknown
 * usernames are tracked in memory exactly like accounts, so a 423 never confirms that a
 * username exists.
 */
export interface LoginTarget {
  key: string;
  userId: string | null;
}

export function loginTarget(user: Pick<UserRecord, 'id'> | null, username: string): LoginTarget {
  if (user) return { key: `u:${user.id}`, userId: user.id };
  // Fold ASCII case only, like the users table's COLLATE NOCASE username lookup.
  return { key: `n:${username.replace(/[A-Z]/g, (c) => c.toLowerCase())}`, userId: null };
}

/** `ok: false` with lockMs 0 means "too many attempts already in flight", not locked. */
export type LoginReservation = { ok: true; release: () => void } | { ok: false; lockMs: number };

interface PairState {
  fails: number[];
  lockedUntil: number;
  inFlight: number;
}

const KNOWN_ADDRESSES_PER_USER = 20;

export class LoginLockout {
  private readonly pairs = new Map<string, PairState>();
  private readonly inFlight = new Map<string, number>();
  private readonly ghosts = new Map<string, LockState>();
  private readonly known = new Map<string, Map<string, number>>();

  constructor(
    private readonly users: UsersRepo,
    private readonly maxTracked = 10_000,
  ) {}

  /**
   * Milliseconds until this client may try this account again; 0 when allowed. The account-wide
   * lock doesn't apply to addresses the account recently logged in from, so a stranger can't
   * keep the owner out; the per-address lock still applies to everyone.
   */
  lockMs(target: LoginTarget, ip: string, now = Date.now()): number {
    const pair = this.pairs.get(pairKey(target, ip));
    const pairMs = pair && pair.lockedUntil > now ? pair.lockedUntil - now : 0;
    const accountMs = this.isKnown(target, ip, now) ? 0 : lockRemainingMs(this.accountState(target), now);
    return Math.max(pairMs, accountMs);
  }

  /**
   * Claim an attempt before the password is hashed. In-flight attempts count as failures for
   * the limits, so a burst of concurrent requests gets no more guesses than sequential ones.
   * Always call release() when the attempt finishes.
   */
  reserve(target: LoginTarget, ip: string, now = Date.now()): LoginReservation {
    const lockMs = this.lockMs(target, ip, now);
    if (lockMs > 0) return { ok: false, lockMs };
    const key = pairKey(target, ip);
    const pair = this.pair(key, now);
    const accountInFlight = this.inFlight.get(target.key) ?? 0;
    const pairFull = pair.fails.length + pair.inFlight >= MAX_ACCOUNT_FAILURES;
    const accountFull =
      !this.isKnown(target, ip, now) && this.accountState(target).failedLogins + accountInFlight >= MAX_ACCOUNT_FAILURES_TOTAL;
    if (pairFull || accountFull) {
      this.dropIfIdle(key, pair, now);
      return { ok: false, lockMs: 0 };
    }
    pair.inFlight++;
    this.inFlight.set(target.key, accountInFlight + 1);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        pair.inFlight--;
        const left = (this.inFlight.get(target.key) ?? 1) - 1;
        if (left > 0) this.inFlight.set(target.key, left);
        else this.inFlight.delete(target.key);
        this.dropIfIdle(key, pair, Date.now());
      },
    };
  }

  /**
   * Count a failed attempt. Returns this client's lock time afterwards and which lock, if any,
   * this failure just started.
   */
  recordFailure(target: LoginTarget, ip: string, now = Date.now()): { lockMs: number; locked: 'address' | 'account' | null } {
    const key = pairKey(target, ip);
    const pair = this.pair(key, now);
    let locked: 'address' | 'account' | null = null;
    if (pair.lockedUntil <= now) {
      pair.fails.push(now);
      if (pair.fails.length >= MAX_ACCOUNT_FAILURES) {
        pair.fails = [];
        pair.lockedUntil = now + ACCOUNT_LOCK_MS;
        locked = 'address';
      }
    }
    this.pairs.delete(key); // re-insert so Map order is least-recently-failed first
    this.pairs.set(key, pair);
    const accountLocked = target.userId ? recordAccountFailure(this.users, target.userId, now) !== null : this.ghostFailure(target.key, now);
    if (accountLocked) locked = 'account';
    this.evict();
    return { lockMs: this.lockMs(target, ip, now), locked };
  }

  /** Successful login: clear this address's failures, remember it, and clear the account's lock. */
  recordSuccess(userId: string, ip: string, now = Date.now()): User {
    const pair = this.pairs.get(pairKey({ key: `u:${userId}`, userId }, ip));
    if (pair) {
      pair.fails = [];
      pair.lockedUntil = 0;
    }
    const addresses = this.known.get(userId) ?? new Map<string, number>();
    const addr = keyFor(ip);
    addresses.delete(addr);
    addresses.set(addr, now);
    for (const old of addresses.keys()) {
      if (addresses.size <= KNOWN_ADDRESSES_PER_USER) break;
      addresses.delete(old);
    }
    this.known.set(userId, addresses);
    return recordAccountSuccess(this.users, userId, now);
  }

  private isKnown(target: LoginTarget, ip: string, now: number): boolean {
    if (!target.userId) return false;
    const at = this.known.get(target.userId)?.get(keyFor(ip));
    return at !== undefined && now - at < KNOWN_ADDRESS_MS;
  }

  private accountState(target: LoginTarget): LockState {
    const state = target.userId ? this.users.get(target.userId) : this.ghosts.get(target.key);
    return state ?? { failedLogins: 0, lockedUntil: null };
  }

  /** Same bookkeeping as recordAccountFailure, kept in memory for usernames that don't exist. */
  private ghostFailure(key: string, now: number): boolean {
    const state = this.ghosts.get(key) ?? { failedLogins: 0, lockedUntil: null };
    const next = nextFailureState(state, now);
    if (!next) return false;
    this.ghosts.delete(key);
    this.ghosts.set(key, next);
    return next.lockedUntil !== state.lockedUntil;
  }

  private pair(key: string, now: number): PairState {
    let pair = this.pairs.get(key);
    if (!pair) {
      pair = { fails: [], lockedUntil: 0, inFlight: 0 };
      this.pairs.set(key, pair);
    }
    const cutoff = now - ACCOUNT_LOCK_MS;
    if (pair.fails.some((t) => t <= cutoff)) pair.fails = pair.fails.filter((t) => t > cutoff);
    return pair;
  }

  private dropIfIdle(key: string, pair: PairState, now: number): void {
    if (pair.inFlight === 0 && pair.fails.length === 0 && pair.lockedUntil <= now && this.pairs.get(key) === pair) {
      this.pairs.delete(key);
    }
  }

  private evict(): void {
    // Least recently failed first; never drop an entry with attempts in flight.
    for (const [key, pair] of this.pairs) {
      if (this.pairs.size <= this.maxTracked) break;
      if (pair.inFlight === 0) this.pairs.delete(key);
    }
    for (const key of this.ghosts.keys()) {
      if (this.ghosts.size <= this.maxTracked) break;
      this.ghosts.delete(key);
    }
  }
}

function pairKey(target: LoginTarget, ip: string): string {
  return `${target.key}\n${keyFor(ip)}`;
}

// ---------------------------------------------------------------------------
// Per-IP sliding window of failures (in memory)
// ---------------------------------------------------------------------------

export class IpFailureLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max = IP_MAX_FAILURES,
    private readonly windowMs = IP_WINDOW_MS,
    private readonly maxTracked = 10_000,
  ) {}

  /** Seconds until this IP may try again; 0 when allowed. */
  retryAfterSec(ip: string, now = Date.now()): number {
    const list = this.recent(keyFor(ip), now);
    if (list.length < this.max) return 0;
    const oldest = list[list.length - this.max] ?? now;
    return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
  }

  recordFailure(ip: string, now = Date.now()): void {
    const key = keyFor(ip);
    const list = this.recent(key, now);
    list.push(now);
    if (list.length > this.max) list.splice(0, list.length - this.max);
    this.hits.delete(key); // re-insert so Map order is least-recently-failed first
    this.hits.set(key, list);
    this.evict(now);
  }

  get size(): number {
    return this.hits.size;
  }

  private recent(key: string, now: number): number[] {
    const list = this.hits.get(key);
    if (!list) return [];
    const cutoff = now - this.windowMs;
    const fresh = list.filter((t) => t > cutoff);
    if (fresh.length === 0) this.hits.delete(key);
    else if (fresh.length !== list.length) this.hits.set(key, fresh);
    return fresh;
  }

  private evict(now: number): void {
    if (this.hits.size <= this.maxTracked) return;
    const cutoff = now - this.windowMs;
    for (const [key, list] of this.hits) {
      if ((list[list.length - 1] ?? 0) <= cutoff) this.hits.delete(key);
    }
    // Still too many: drop the least recently active entries.
    for (const key of this.hits.keys()) {
      if (this.hits.size <= this.maxTracked) break;
      this.hits.delete(key);
    }
  }
}

/** Group IPv6 clients by /64 (one host usually owns a whole /64), like @fastify/rate-limit. */
function keyFor(ip: string): string {
  try {
    return fastifyRateLimit.normalizeIP(ip, 64);
  } catch {
    return ip.toLowerCase();
  }
}

// ---------------------------------------------------------------------------
// @fastify/rate-limit config for credential routes (plugin registered with global: false)
// ---------------------------------------------------------------------------

export class RateLimitedError extends Error {
  readonly statusCode = 429;
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

/** Route `config.rateLimit` for login/setup and other password-checking routes: 10 requests/min per IP. */
export const credentialRateLimit: RateLimitOptions = {
  max: 10,
  timeWindow: 60_000,
  errorResponseBuilder: (_req, ctx) => new RateLimitedError(`Too many attempts. Try again in ${ctx.after}.`),
};

/**
 * Scoped error handler for route plugins using credentialRateLimit: answers rate-limit
 * errors with code 'rate_limited' and re-throws everything else to the app's handler.
 */
export function rateLimitErrorHandler(err: Error, _req: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (err instanceof RateLimitedError) return sendError(reply, 429, err.message, 'rate_limited');
  throw err;
}
