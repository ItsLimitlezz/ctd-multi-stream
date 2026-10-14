// Viewer count for a Facebook Page live (the driver's health() watcher; it only ever reports
// viewers — Page lives are not recovered automatically, so it never yields `ended`).
//
// GET /{live-video-id}?fields=live_views — "the current number of live views" on the LiveVideo
// node, readable with the Page token (pages_read_engagement).
//   https://developers.facebook.com/docs/graph-api/reference/live-video/

import type { Logger } from 'pino';
import { DriverError, type LiveHealthEvent } from '../types.js';
import { GraphApiError, type GraphClient } from './graph.js';

export interface LiveViewsTimings {
  pollMs: number;
  /** Wait after a problem the user must fix (expired token, missing permission). */
  pauseMs: number;
  /** Wait after Facebook's rate limit. */
  rateLimitWaitMs: number;
  /** Consecutive transient failures before the count is reported unknown (null). */
  failuresBeforeUnknown: number;
}

export const DEFAULT_LIVE_VIEWS_TIMINGS: LiveViewsTimings = {
  pollMs: 30_000,
  pauseMs: 5 * 60_000,
  rateLimitWaitMs: 5 * 60_000,
  failuresBeforeUnknown: 2,
};

export interface LiveViewsOptions {
  graph: GraphClient;
  liveVideoId: string;
  /** Page access token. */
  token: string;
  log: Logger;
  timings?: Partial<LiveViewsTimings>;
}

/** `live_views` → a count, or null when absent/malformed. */
export function parseLiveViews(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^\d{1,15}$/.test(value.trim())) return Number(value.trim());
  return null;
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001]);

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function classify(err: unknown, t: LiveViewsTimings): { waitMs: number; unknownNow: boolean } {
  if (err instanceof GraphApiError && ((err.graphCode !== null && RATE_LIMIT_CODES.has(err.graphCode)) || err.httpStatus === 429)) {
    return { waitMs: t.rateLimitWaitMs, unknownNow: true };
  }
  if (err instanceof DriverError && (err.code === 'needs-login' || err.code === 'misconfigured')) {
    return { waitMs: t.pauseMs, unknownNow: true };
  }
  return { waitMs: t.pollMs, unknownNow: false };
}

/**
 * Reports the live video's viewer count: the first read, then every change. A single transient
 * failure keeps the last count; repeated failures, a rate limit or a token/permission problem
 * report null. Runs until `signal` aborts and never throws.
 */
export async function* watchLiveViews(opts: LiveViewsOptions, signal: AbortSignal): AsyncGenerator<LiveHealthEvent> {
  const t: LiveViewsTimings = { ...DEFAULT_LIVE_VIEWS_TIMINGS, ...opts.timings };
  let last: number | null | undefined;
  let failures = 0;
  while (!signal.aborted) {
    let next: number | null | undefined;
    let waitMs = t.pollMs;
    try {
      const res = await opts.graph.get<{ live_views?: unknown }>(opts.liveVideoId, opts.token, { fields: 'live_views' }, signal);
      next = parseLiveViews(res?.live_views);
      failures = 0;
    } catch (err) {
      if (signal.aborted) return;
      failures += 1;
      const c = classify(err, t);
      waitMs = c.waitMs;
      if (c.unknownNow || failures >= t.failuresBeforeUnknown) next = null;
      if (failures === 1 || c.unknownNow) {
        opts.log.warn({ liveVideoId: opts.liveVideoId, error: errText(err), retryInMs: waitMs }, 'reading the Facebook viewer count failed');
      }
    }
    if (next !== undefined && next !== last) {
      last = next;
      yield { type: 'viewers', count: next };
    }
    if (!(await sleep(waitMs, signal))) return;
  }
}

/** Resolves true after `ms`, false as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
