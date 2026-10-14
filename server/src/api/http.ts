// HTTP plumbing for /api/v1: RFC 9457 problem details, bearer tokens, per-token limits.

import type { FastifyReply, FastifyRequest } from 'fastify';

export const PROBLEM_TYPE = 'https://github.com/ItsLimitlezz/ctd-multi-stream/blob/main/docs/API.md#errors';
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export type ProblemCode = 'unauthenticated' | 'missing_scope' | 'invalid' | 'rate_limited' | 'not_found' | 'internal';

const TITLES: Record<ProblemCode, string> = {
  unauthenticated: 'Unauthenticated',
  missing_scope: 'Missing scope',
  invalid: 'Invalid request',
  rate_limited: 'Rate limited',
  not_found: 'Not found',
  internal: 'Internal error',
};

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: ProblemCode;
}

export function problem(status: number, code: ProblemCode, detail: string): Problem {
  return { type: PROBLEM_TYPE, title: TITLES[code], status, detail, code };
}

export function sendProblem(reply: FastifyReply, status: number, code: ProblemCode, detail: string): FastifyReply {
  if (status === 401) reply.header('WWW-Authenticate', 'Bearer realm="ctd-multi-stream"');
  return reply.code(status).type(PROBLEM_CONTENT_TYPE).send(problem(status, code, detail));
}

/** Longest secret we bother hashing (real ones are 51 characters). */
const MAX_TOKEN_LENGTH = 256;

/**
 * The presented token: `Authorization: Bearer <token>`, or (only where allowed) `?access_token=`.
 * Returns '' when a credential was sent but is malformed, null when none was sent.
 */
export function presentedToken(req: FastifyRequest, allowQuery: boolean): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.length > 0) {
    const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
    return m?.[1] && m[1].length <= MAX_TOKEN_LENGTH ? m[1] : '';
  }
  if (allowQuery) {
    const q = (req.query as Record<string, unknown> | undefined)?.access_token;
    if (typeof q === 'string' && q.length > 0) return q.length <= MAX_TOKEN_LENGTH ? q : '';
    if (q !== undefined) return '';
  }
  return null;
}

/** In-memory sliding-window limiter: at most `limit` hits per `windowMs` per key. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit; when over the limit returns the seconds until one is allowed again. */
  hit(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const now = this.now();
    this.sweep(now);
    const since = now - this.windowMs;
    let list = this.hits.get(key);
    if (!list) {
      list = [];
      this.hits.set(key, list);
    }
    let drop = 0;
    while (drop < list.length && (list[drop] ?? 0) <= since) drop++;
    if (drop > 0) list.splice(0, drop);
    if (list.length >= this.limit) {
      const oldest = list[0] ?? now;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)) };
    }
    list.push(now);
    return { ok: true };
  }

  /** Forget keys idle for a whole window (bounded memory). */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, list] of this.hits) if ((list.at(-1) ?? 0) <= now - this.windowMs) this.hits.delete(key);
  }

  get size(): number {
    return this.hits.size;
  }
}

/** Counts open streams per key. */
export class ConcurrencyLimiter {
  private readonly open = new Map<string, number>();

  constructor(readonly max: number) {}

  acquire(key: string): boolean {
    const n = this.open.get(key) ?? 0;
    if (n >= this.max) return false;
    this.open.set(key, n + 1);
    return true;
  }

  release(key: string): void {
    const n = (this.open.get(key) ?? 0) - 1;
    if (n > 0) this.open.set(key, n);
    else this.open.delete(key);
  }

  count(key: string): number {
    return this.open.get(key) ?? 0;
  }
}
