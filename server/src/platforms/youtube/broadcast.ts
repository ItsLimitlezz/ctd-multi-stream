// Broadcast lifecycle: reusable ingest stream per destination, one broadcast per live (auto start,
// no auto stop: the app ends it), title updates, confirmation that YouTube started it, and
// ending/cleanup.
// https://developers.google.com/youtube/v3/live/docs/liveBroadcasts
// https://developers.google.com/youtube/v3/live/docs/liveStreams

import type { Logger } from 'pino';
import type { Feed } from '../../../../shared/types.js';
import type { ScopedSecrets } from '../../services.js';
import { DriverError } from '../types.js';
import { YouTubeApiError, type LiveBroadcast, type LiveStream, type YouTubeClient } from './api.js';
import type { YouTubeOptions } from './info.js';

/** destinationSecrets keys. */
export const LIVE_STREAM_KEY = 'liveStreamId';
/** The broadcast of the current/last live, so a crashed session's broadcast is cleaned up next time. */
export const BROADCAST_KEY = 'broadcastId';
/**
 * Broadcasts of earlier lives that couldn't be ended yet (JSON list of ids, oldest first). Kept
 * apart from BROADCAST_KEY, which the next live's broadcast overwrites; every prepare() retries them.
 */
export const LEFTOVER_BROADCASTS_KEY = 'leftoverBroadcastIds';

/** Shift for a scheduledStartTime YouTube rejected (it must not be in the past). */
const FUTURE_START_MS = 60_000;

export interface ConfirmTimings {
  pollMs: number;
  /** After this long without auto start, ask YouTube to go live explicitly. */
  autoStartGraceMs: number;
  /** Give up waiting (keep streaming) after this long. Below the orchestrator's 180 s confirm bound. */
  maxMs: number;
}

export const DEFAULT_CONFIRM_TIMINGS: ConfirmTimings = { pollMs: 5_000, autoStartGraceMs: 45_000, maxMs: 150_000 };

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

/** `<rtmps address>/<stream name>` with exactly one slash; prefers RTMPS. Null when incomplete. */
export function ingestUrl(stream: LiveStream): string | null {
  const info = stream.cdn?.ingestionInfo;
  const base = (info?.rtmpsIngestionAddress || info?.ingestionAddress || '').trim().replace(/\/+$/, '');
  const name = (info?.streamName ?? '').trim().replace(/^\/+/, '');
  return base && name ? `${base}/${name}` : null;
}

/** The destination's reusable liveStream (created on first use or when the stored one is gone). */
export async function ensureStream(
  client: YouTubeClient,
  secrets: ScopedSecrets,
  feed: Feed,
  channelId: string | null,
  log: Logger,
  signal: AbortSignal,
): Promise<{ id: string; url: string }> {
  const storedId = await secrets.get(LIVE_STREAM_KEY);
  if (storedId) {
    let stream: LiveStream | null = null;
    try {
      stream = await client.getStream(storedId, signal);
    } catch (err) {
      if (!(err instanceof YouTubeApiError && err.status === 404)) throw err;
    }
    const sameChannel = !channelId || !stream?.snippet?.channelId || stream.snippet.channelId === channelId;
    const url = stream && sameChannel ? ingestUrl(stream) : null;
    if (stream && url) return { id: stream.id, url };
    log.info('stored YouTube stream is gone or belongs to another channel; creating a new one');
  }
  const created = await client.insertStream(`CTD ${feed}`, signal);
  const url = ingestUrl(created);
  if (!created.id || !url) throw new DriverError('YouTube created the stream without an ingest address. Try again.', 'platform-error');
  await secrets.set(LIVE_STREAM_KEY, created.id);
  log.info({ streamId: created.id }, 'created YouTube stream');
  return { id: created.id, url };
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

/** liveBroadcasts.insert body. Never sets categoryId. */
export function broadcastBody(title: string, opts: YouTubeOptions, start: Date): Record<string, unknown> {
  return {
    snippet: { title, scheduledStartTime: start.toISOString() },
    status: { privacyStatus: opts.privacy, selfDeclaredMadeForKids: opts.madeForKids },
    contentDetails: {
      // Auto start needs the monitor stream off (otherwise the broadcast must pass through "testing").
      enableAutoStart: true,
      // No auto stop: YouTube would complete the broadcast about a minute after the video stops,
      // e.g. during the feed-offline grace period or relay retries, and a completed broadcast can't
      // go live again. end() completes it, and the next prepare() ends a crashed session's leftover.
      enableAutoStop: false,
      latencyPreference: opts.latency,
      enableDvr: true,
      monitorStream: { enableMonitorStream: false },
    },
  };
}

/**
 * Insert the broadcast and bind it to the stream. `onCreated` runs right after the insert (to
 * remember the id for cleanup). Deletes the broadcast again if binding fails.
 */
export async function createBroadcast(
  client: YouTubeClient,
  title: string,
  opts: YouTubeOptions,
  streamId: string,
  log: Logger,
  signal: AbortSignal,
  onCreated?: (broadcastId: string) => Promise<void>,
): Promise<LiveBroadcast> {
  let broadcast: LiveBroadcast;
  try {
    broadcast = await client.insertBroadcast(broadcastBody(title, opts, new Date()), signal);
  } catch (err) {
    if (!(err instanceof YouTubeApiError && err.has('invalidScheduledStartTime'))) throw err;
    broadcast = await client.insertBroadcast(broadcastBody(title, opts, new Date(Date.now() + FUTURE_START_MS)), signal);
  }
  if (!broadcast?.id) throw new DriverError('YouTube did not return the new broadcast. Try again.', 'platform-error');
  try {
    await onCreated?.(broadcast.id);
    await client.bind(broadcast.id, streamId, signal);
  } catch (err) {
    await client.deleteBroadcast(broadcast.id).catch((e: unknown) => {
      log.warn({ broadcastId: broadcast.id, error: errText(e) }, 'deleting the unbound YouTube broadcast failed');
    });
    throw err;
  }
  return broadcast;
}

/**
 * Change only the title. A part=snippet update clears omitted mutable fields, so the current
 * values (description, schedule, and categoryId when present) are sent back unchanged.
 */
export async function setBroadcastTitle(client: YouTubeClient, broadcastId: string, title: string, signal?: AbortSignal): Promise<void> {
  const current = await client.getBroadcast(broadcastId, 'snippet', signal);
  if (!current?.snippet) throw new DriverError('The YouTube broadcast no longer exists', 'platform-error');
  const s = current.snippet;
  if (s.title === title) return;
  const snippet = (start: string) => ({
    title,
    scheduledStartTime: start,
    ...(s.description !== undefined ? { description: s.description } : {}),
    ...(s.scheduledEndTime !== undefined ? { scheduledEndTime: s.scheduledEndTime } : {}),
    ...(s.categoryId !== undefined ? { categoryId: s.categoryId } : {}),
  });
  try {
    await client.updateSnippet(broadcastId, snippet(s.scheduledStartTime ?? new Date().toISOString()), signal);
  } catch (err) {
    if (!(err instanceof YouTubeApiError && err.has('invalidScheduledStartTime'))) throw err;
    // Some broadcasts refuse their own (past) schedule; the schedule is meaningless once live.
    await client.updateSnippet(broadcastId, snippet(new Date(Date.now() + FUTURE_START_MS).toISOString()), signal);
  }
}

export interface FinishTimings {
  pollMs: number;
  /** How long to wait for a starting broadcast to reach "live" so it can be completed. Below end's 30 s bound. */
  waitMs: number;
}

export const DEFAULT_FINISH_TIMINGS: FinishTimings = { pollMs: 2_000, waitMs: 20_000 };

/** True when the broadcast is complete (or gone); false when YouTube refuses the transition now. */
async function transitionToComplete(client: YouTubeClient, broadcastId: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await client.transition(broadcastId, 'complete', signal);
    return true;
  } catch (err) {
    if (!(err instanceof YouTubeApiError)) throw err;
    if (err.status === 404 || err.has('liveBroadcastNotFound', 'redundantTransition')) return true;
    if (!err.has('invalidTransition')) throw err;
    return false;
  }
}

/**
 * End a broadcast. Already complete / missing is fine. A broadcast that never went live can't be
 * transitioned to complete: delete it so it doesn't linger as an upcoming (auto-start!) broadcast.
 * A broadcast that is still starting is given `waitMs` to reach "live" and is then completed (there
 * is no auto stop). If it doesn't get there, this throws and the caller keeps the broadcast id so
 * the next prepare() ends it.
 */
export async function finishBroadcast(
  client: YouTubeClient,
  broadcastId: string,
  signal?: AbortSignal,
  t: FinishTimings = DEFAULT_FINISH_TIMINGS,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (await transitionToComplete(client, broadcastId, signal)) return;
    const current = await client.getBroadcast(broadcastId, 'status', signal);
    const status = current?.status?.lifeCycleStatus;
    if (!current || status === 'complete' || status === 'revoked') return;
    if (status === 'created' || status === 'ready') {
      try {
        await client.deleteBroadcast(broadcastId, signal);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      return;
    }
    const waiting = status === 'liveStarting' || status === 'live';
    if (!waiting || Date.now() - started >= t.waitMs) {
      throw new DriverError(
        `Couldn't end the YouTube broadcast yet (status: ${status ?? 'unknown'}). ` +
          'End it in YouTube Studio, or the app ends it before the next live.',
        'platform-error',
      );
    }
    await delay(t.pollMs, signal);
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof YouTubeApiError && (err.status === 404 || err.has('liveBroadcastNotFound'));
}

/** What a broadcast that couldn't be ended means for the next live on the destination's stream. */
export interface LeftoverCheck {
  /**
   * gone: deleted, complete or revoked (forget it). idle: still there but it can't show the next
   * live (bound to another stream, not set up, or another channel's): retry ending it later.
   * on-air: live, starting or testing on the destination's stream (or its state is unclear): the
   * next live would show on it too.
   */
  state: 'gone' | 'idle' | 'on-air';
  status?: string;
}

/**
 * Check a leftover broadcast that finishBroadcast() couldn't end. `streamId` is the destination's
 * stored liveStream (null: a new one will be created, which no leftover is bound to). An upcoming
 * ("ready") broadcast on that stream has auto start, so it is deleted rather than left to start
 * with the next live. Throws when YouTube can't be asked (the caller fails closed).
 */
export async function checkLeftover(
  client: YouTubeClient,
  broadcastId: string,
  streamId: string | null,
  signal?: AbortSignal,
): Promise<LeftoverCheck> {
  let current: LiveBroadcast | null;
  try {
    current = await client.getBroadcast(broadcastId, 'status,contentDetails', signal);
  } catch (err) {
    if (isNotFound(err)) return { state: 'gone' };
    // Not readable by this account (e.g. it was switched to another channel, which then gets its
    // own stream from ensureStream): it can't show the next live.
    if (err instanceof YouTubeApiError && err.status === 403 && err.has('forbidden')) return { state: 'idle' };
    throw err;
  }
  const status = current?.status?.lifeCycleStatus;
  if (!current || status === 'complete' || status === 'revoked') return { state: 'gone', status };
  const bound = current.contentDetails?.boundStreamId;
  // An unknown binding counts as the destination's stream.
  const onOurStream = streamId !== null && (!bound || bound === streamId);
  if (!onOurStream || status === 'created') return { state: 'idle', status };
  if (status === 'ready') {
    try {
      await client.deleteBroadcast(broadcastId, signal);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    return { state: 'gone', status };
  }
  // live, liveStarting, testing, testStarting, or a state we don't know: assume it shows the stream.
  return { state: 'on-air', status };
}

/**
 * Wait until YouTube reports the broadcast live (auto start). If it hasn't started after a grace
 * period, ask for the transition explicitly. Gives up quietly (streaming continues) at `maxMs`.
 */
export async function confirmLive(
  client: YouTubeClient,
  broadcastId: string,
  log: Logger,
  signal: AbortSignal,
  t: ConfirmTimings = DEFAULT_CONFIRM_TIMINGS,
): Promise<void> {
  const started = Date.now();
  let transitionTried = false;
  for (;;) {
    signal.throwIfAborted();
    let current: LiveBroadcast | null | undefined;
    try {
      current = await client.getBroadcast(broadcastId, 'status', signal);
    } catch (err) {
      if (signal.aborted) throw err;
      log.warn({ broadcastId, error: errText(err) }, 'reading the YouTube broadcast status failed');
    }
    if (current === null) throw new DriverError('The YouTube broadcast was deleted', 'platform-error');
    const status = current?.status?.lifeCycleStatus;
    if (status === 'live') return;
    if (status === 'complete' || status === 'revoked') {
      throw new DriverError(`YouTube ended the broadcast before it started (${status})`, 'platform-error');
    }
    const elapsed = Date.now() - started;
    if (!transitionTried && elapsed >= t.autoStartGraceMs && status === 'ready') {
      transitionTried = true;
      try {
        await client.transition(broadcastId, 'live', signal);
      } catch (err) {
        // errorStreamInactive: YouTube isn't receiving video yet; redundantTransition: it's starting.
        log.info({ broadcastId, error: errText(err) }, 'explicit YouTube go-live not accepted yet');
      }
    }
    if (elapsed >= t.maxMs) {
      log.warn({ broadcastId, status }, 'YouTube has not started the broadcast yet; streaming continues');
      return;
    }
    await delay(t.pollMs, signal);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
