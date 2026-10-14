// Viewer-count watcher for PreparedLive.health(): polls the platform politely and only ever reports
// viewers (Twitch lives are not recovered by the runner, so this never yields 'ended').

import type { Logger } from 'pino';
import type { LiveHealthEvent } from '../types.js';

export const VIEWERS_POLL_MS = 30_000;

export interface PollViewersOptions {
  intervalMs?: number;
  log?: Logger;
  /** For log lines, e.g. { destinationId }. */
  logContext?: Record<string, unknown>;
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = (): void => {
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

/**
 * Yield `{ type: 'viewers', count }` after every read, every `intervalMs` (30 s), until `signal`
 * aborts. `read` returns null when the count is unknown (stream not listed yet). One failed read
 * keeps the last count (nothing is yielded); from the second failure in a row the count is null.
 * Never throws for a failed read, so the runner doesn't restart it.
 */
export async function* pollViewers(
  read: (signal: AbortSignal) => Promise<number | null>,
  signal: AbortSignal,
  opts: PollViewersOptions = {},
): AsyncGenerator<LiveHealthEvent, void, undefined> {
  const intervalMs = opts.intervalMs ?? VIEWERS_POLL_MS;
  let failures = 0;
  while (!signal.aborted) {
    let count: number | null | undefined;
    try {
      count = await read(signal);
      if (failures > 0) opts.log?.info({ ...opts.logContext }, 'viewer count readable again');
      failures = 0;
    } catch (err) {
      if (signal.aborted) return;
      failures += 1;
      if (failures === 1) {
        opts.log?.warn({ ...opts.logContext, error: err instanceof Error ? err.message : String(err) }, 'reading the viewer count failed');
      }
      count = failures >= 2 ? null : undefined;
    }
    if (signal.aborted) return;
    if (count !== undefined) yield { type: 'viewers', count };
    if (!(await sleep(intervalMs, signal))) return;
  }
}
