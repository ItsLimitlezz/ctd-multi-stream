// Viewer count for a YouTube live (the driver's health() watcher; it only ever reports viewers —
// YouTube lives are not recoverable, so it never yields `ended`).
//
// videos.list?part=liveStreamingDetails&id=<broadcast id> (the broadcast id is the video id):
// `liveStreamingDetails.concurrentViewers` is absent before the live starts, after it ends and when
// the channel hides the count → null. One call = 1 quota unit; at one call per minute that is
// 60 units per hour per YouTube destination, from the same daily quota as chat.
//   https://developers.google.com/youtube/v3/docs/videos/list
//   https://developers.google.com/youtube/v3/docs/videos#liveStreamingDetails.concurrentViewers

import type { Logger } from 'pino';
import { DriverError, type LiveHealthEvent } from '../types.js';
import { QUOTA_REASONS, RATE_REASONS, YouTubeApiError, type Uint64, type YouTubeClient } from './api.js';

export interface ViewerTimings {
  /** Gap between reads (YouTube asks for ≥ 60 s; each read costs quota). */
  pollMs: number;
  /** Wait after the daily quota ran out. */
  quotaWaitMs: number;
  /** Wait after a problem the user must fix (login, developer app). */
  pauseMs: number;
  /** Consecutive transient failures before the count is reported unknown (null). */
  failuresBeforeUnknown: number;
}

export const DEFAULT_VIEWER_TIMINGS: ViewerTimings = {
  pollMs: 60_000,
  quotaWaitMs: 15 * 60_000,
  pauseMs: 5 * 60_000,
  failuresBeforeUnknown: 2,
};

/** concurrentViewers (a uint64, usually a JSON string) → a count, or null when absent/malformed. */
export function parseConcurrentViewers(value: Uint64 | null | undefined): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** How long to wait after a failed read, and whether the count is unknown right away. */
function classify(err: unknown, t: ViewerTimings): { waitMs: number; unknownNow: boolean } {
  if (err instanceof YouTubeApiError && err.has(...QUOTA_REASONS)) return { waitMs: t.quotaWaitMs, unknownNow: true };
  if (err instanceof YouTubeApiError && err.has(...RATE_REASONS)) return { waitMs: t.pollMs * 2, unknownNow: false };
  if (err instanceof DriverError && ['needs-login', 'not-connected', 'misconfigured'].includes(err.code)) {
    return { waitMs: t.pauseMs, unknownNow: true };
  }
  return { waitMs: t.pollMs, unknownNow: false };
}

/**
 * Health watcher that reports the broadcast's viewer count: the first read, then every change.
 * A single transient failure keeps the last count; repeated failures, an exhausted quota or a
 * login problem report null. Runs until `signal` aborts and never throws.
 */
export function watchViewers(
  client: YouTubeClient,
  videoId: string,
  log: Logger,
  timings: Partial<ViewerTimings> = {},
): (signal: AbortSignal) => AsyncGenerator<LiveHealthEvent> {
  const t: ViewerTimings = { ...DEFAULT_VIEWER_TIMINGS, ...timings };
  return async function* viewers(signal) {
    /** Last reported count; undefined = nothing reported yet in this run. */
    let last: number | null | undefined;
    let failures = 0;
    while (!signal.aborted) {
      let next: number | null | undefined;
      let waitMs = t.pollMs;
      try {
        const video = await client.getVideoLiveDetails(videoId, signal);
        next = parseConcurrentViewers(video?.liveStreamingDetails?.concurrentViewers);
        failures = 0;
      } catch (err) {
        if (signal.aborted) return;
        failures += 1;
        const c = classify(err, t);
        waitMs = c.waitMs;
        if (c.unknownNow || failures >= t.failuresBeforeUnknown) next = null;
        if (failures === 1 || c.unknownNow) log.warn({ videoId, error: errText(err), retryInMs: waitMs }, 'reading the YouTube viewer count failed');
      }
      if (next !== undefined && next !== last) {
        last = next;
        yield { type: 'viewers', count: next };
      }
      await sleep(waitMs, signal);
    }
  };
}

/** Sleep that ends early (without throwing) when the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
