// Stream Guard for TikTok: watches the LIVE Producer page a running LIVE uses and reports when
// TikTok ended the LIVE (copyright / Community Guidelines interruption, LIVE removed, the dashboard
// dropping out of the live state, or — opt-in — 0 viewers for too long). The runner then starts a
// fresh LIVE (PreparedLive.recovery). It also reports the current viewer count (`viewers`) on every
// change and at least every 30 s, null when it can't be read. Notice wording and the viewer stat:
// selectors.ts.
//
// Split in two: pure trackers (decisions, unit-tested with a fake clock) and the page sampler.

import type { Logger } from 'pino';
import type { Page } from 'playwright';
import type { LiveHealthEvent } from '../types.js';
import { detectState, gotoPage, isDashboard, liveStateOnPage } from './producer.js';
import { healthScanScript, TEXT, type HealthScan } from './selectors.js';
import { errorText, isLoginUrl, isUnder, parseViewerCount, sleep } from './util.js';

/** Stream Guard polls every 2 s. */
export const HEALTH_POLL_MS = 2000;
/** Stream Guard's GRACE_PERIOD_SECONDS: the viewer rule waits this long after going LIVE. */
export const VIEWER_GRACE_MS = 60_000;
/** The viewer count is reported on every change and at least this often. */
export const VIEWERS_REPORT_MS = 30_000;
/** A count unreadable for less than this keeps the last known count (a re-render, a flaky read). */
export const VIEWERS_HOLD_MS = 6_000;
/** Polls in a row without "End LIVE" (and no notice) before the LIVE counts as gone. */
const LIVE_LOSS_POLLS = 2;
/** Polls in a row of an unrecognizable page before warning. */
const UNKNOWN_WARN_POLLS = 5;
/** Polls in a row with an unreadable viewer count (rule enabled) before warning. */
const VIEWERS_WARN_POLLS = 3;
/** Polls in a row away from LIVE Producer before navigating back (the user may be browsing in the viewer). */
const AWAY_POLLS = 2;
const REASON_MAX = 160;

export const LIVE_GONE_REASON = 'LIVE Producer no longer shows the LIVE';
export const LOGGED_OUT_WARNING =
  "TikTok logged out in the app's browser: takedowns can't be detected. Log in again from Accounts.";
export const CANT_SEE_WARNING = "Can't see the LIVE in TikTok LIVE Producer: takedowns can't be detected right now.";
export const VIEWERS_UNAVAILABLE_WARNING = "TikTok's viewer count can't be read: the 0-viewer rule is paused.";

// ---------------------------------------------------------------------------
// Classification + tracker (pure)
// ---------------------------------------------------------------------------

export type NoticeKind = 'ended' | 'violation' | 'connection';

/**
 * What a notice on the producer page means:
 * - 'ended': TikTok ended/removed/suspended the LIVE, or interrupted/paused it without blaming the
 *   connection (a bare "Your LIVE was interrupted", or one with policy/copyright wording).
 * - 'violation': policy/copyright wording only (a warning while the LIVE still runs).
 * - 'connection': encoder/network trouble (e.g. OBS dropped out, "LIVE paused. Waiting for your
 *   stream"): never a takedown by itself. A push that stays down while OBS is up is the runner's
 *   push-down rule (takedownConfirmSec), not this notice.
 */
export function classifyNotice(text: string): NoticeKind | null {
  const violation = TEXT.liveViolation.test(text);
  const connection = TEXT.connectionIssue.test(text);
  if (TEXT.liveEnded.test(text)) return 'ended';
  if (TEXT.liveInterrupted.test(text)) {
    // Interrupted/paused while TikTok waits for the feed or points at the encoder/network: not a takedown.
    const feed = connection || TEXT.noStream.test(text) || TEXT.checkEncoder.test(text);
    return feed && !violation ? 'connection' : 'ended';
  }
  if (violation) return 'violation';
  if (connection) return 'connection';
  return null;
}

export interface Notice {
  text: string;
  /** Shown in a dialog / toast / alert banner (not static page text). */
  overlay: boolean;
  kind: NoticeKind;
}

export type PageLiveState = 'live' | 'not-live' | 'logged-out' | 'unknown';

export interface HealthSample {
  state: PageLiveState;
  notices: Notice[];
  /** Current viewers, or null when unreadable. */
  viewers: number | null;
}

export interface HealthTrackerOptions {
  /** 0 viewers this long ⇒ ended. 0 = rule off. */
  zeroViewerMs: number;
  /** Viewer rule grace after going LIVE. */
  graceMs: number;
  /** When the LIVE started (epoch ms). */
  liveSince: number;
}

function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > REASON_MAX ? `${t.slice(0, REASON_MAX - 1).trimEnd()}…` : t;
}

/**
 * Turns page samples into LiveHealthEvents. Rules (in order):
 * 1. An "ended" notice in a dialog/toast/banner ⇒ ended now (hard signal, no grace).
 * 2. The page shows a non-live state: ended now when it also shows an ended/violation notice,
 *    else after 2 polls in a row. An unrecognizable page with an "ended" text counts the same way.
 * 3. Viewer rule (zeroViewerMs > 0): only while live, only after the grace; the count must be
 *    readable and 0 on every poll for zeroViewerMs. Unreadable resets the streak (never fires).
 * 4. Otherwise at most one `warning` at a time (logged out > violation notice > connection notice >
 *    page unrecognizable > viewer count unreadable), and `ok` when it clears.
 * After `ended` the tracker is done and returns nothing more.
 */
export function createHealthTracker(opts: HealthTrackerOptions) {
  let lossPolls = 0;
  let unknownPolls = 0;
  let unreadablePolls = 0;
  let zeroSince: number | null = null;
  let warning: string | null = null;
  let done = false;

  function ended(reason: string): LiveHealthEvent[] {
    done = true;
    return [{ type: 'ended', reason: clip(reason) || LIVE_GONE_REASON }];
  }

  return {
    get done() {
      return done;
    },
    next(sample: HealthSample, now: number): LiveHealthEvent[] {
      if (done) return [];
      // Overlay notices first; among equals the longest text (a dialog's sentence beats its "LIVE ended" heading).
      const longest = (list: Notice[]) =>
        list.reduce<Notice | undefined>((a, b) => (a && a.text.length >= b.text.length ? a : b), undefined);
      const find = (kind: NoticeKind, overlayOnly: boolean) =>
        longest(sample.notices.filter((n) => n.kind === kind && n.overlay)) ??
        (overlayOnly ? undefined : longest(sample.notices.filter((n) => n.kind === kind)));
      const endedOverlay = find('ended', true);
      const endedAny = find('ended', false);
      const violation = find('violation', false);
      const connectionOverlay = find('connection', true);

      if (endedOverlay) return ended(endedOverlay.text);

      switch (sample.state) {
        case 'not-live': {
          unknownPolls = 0;
          const notice = endedAny ?? violation;
          if (notice) return ended(notice.text);
          lossPolls += 1;
          if (lossPolls >= LIVE_LOSS_POLLS) return ended(LIVE_GONE_REASON);
          break;
        }
        case 'unknown':
          unknownPolls += 1;
          if (endedAny) {
            lossPolls += 1;
            if (lossPolls >= LIVE_LOSS_POLLS) return ended(endedAny.text);
          }
          break;
        case 'live':
          lossPolls = 0;
          unknownPolls = 0;
          break;
        case 'logged-out':
          unknownPolls = 0;
          break;
      }

      let viewersUnavailable = false;
      if (opts.zeroViewerMs > 0 && sample.state === 'live') {
        if (now - opts.liveSince < opts.graceMs) {
          zeroSince = null;
          unreadablePolls = 0;
        } else if (sample.viewers === null) {
          zeroSince = null;
          unreadablePolls += 1;
          viewersUnavailable = unreadablePolls >= VIEWERS_WARN_POLLS;
        } else {
          unreadablePolls = 0;
          if (sample.viewers > 0) {
            zeroSince = null;
          } else {
            zeroSince ??= now;
            if (now - zeroSince >= opts.zeroViewerMs) return ended(`0 viewers for ${Math.round(opts.zeroViewerMs / 1000)} s`);
          }
        }
      } else if (sample.state !== 'live') {
        zeroSince = null;
      }

      const live = sample.state === 'live';
      const violationOverlay = violation?.overlay ? violation : undefined;
      const desired =
        sample.state === 'logged-out'
          ? LOGGED_OUT_WARNING
          : live && violationOverlay
            ? `TikTok warning: ${clip(violationOverlay.text)}`
            : live && connectionOverlay
              ? `TikTok: ${clip(connectionOverlay.text)}`
              : sample.state === 'unknown' && unknownPolls >= UNKNOWN_WARN_POLLS
                ? CANT_SEE_WARNING
                : viewersUnavailable
                  ? VIEWERS_UNAVAILABLE_WARNING
                  : null;
      if (desired === warning) return [];
      warning = desired;
      return [desired ? { type: 'warning', message: desired } : { type: 'ok' }];
    },
  };
}

export type ViewersEvent = Extract<LiveHealthEvent, { type: 'viewers' }>;

/**
 * Turns viewer-count reads (null = unreadable) into `viewers` events: the first read, every change,
 * and the same count again after `reportMs` (so a dashboard that reconnects catches up). A count
 * unreadable for less than `holdMs` keeps the last known count (a re-render must not flash
 * "unknown"); after that it's reported as null. Never invents a 0.
 */
export function createViewerReporter(reportMs = VIEWERS_REPORT_MS, holdMs = VIEWERS_HOLD_MS) {
  /** Last reported count; undefined = nothing reported yet. */
  let last: number | null | undefined;
  let lastAt = 0;
  let unreadableSince: number | null = null;
  return {
    next(count: number | null, now: number): ViewersEvent | null {
      let value = count;
      if (count === null) {
        unreadableSince ??= now;
        if (typeof last === 'number' && now - unreadableSince < holdMs) value = last;
      } else {
        unreadableSince = null;
      }
      if (value === last && now - lastAt < reportMs) return null;
      last = value;
      lastAt = now;
      return { type: 'viewers', count: value };
    },
  };
}

/** The count to report for a sample: only while the dashboard isn't plainly out of the LIVE. */
export function sampleViewers(sample: HealthSample): number | null {
  return sample.state === 'live' || sample.state === 'unknown' ? sample.viewers : null;
}

// ---------------------------------------------------------------------------
// Page sampling + watch loop
// ---------------------------------------------------------------------------

const EMPTY_SCAN: HealthScan = { notices: [], viewers: null };

async function scanPage(page: Page, signal: AbortSignal): Promise<HealthScan> {
  try {
    const scan = (await page.evaluate(healthScanScript())) as HealthScan | null;
    return scan ?? EMPTY_SCAN;
  } catch {
    signal.throwIfAborted();
    return EMPTY_SCAN; // navigating / re-rendering
  }
}

/** One look at the producer page. */
export async function sampleProducer(page: Page, signal: AbortSignal): Promise<HealthSample> {
  const state = await liveStateOnPage(page);
  if (state === 'logged-out') return { state, notices: [], viewers: null };
  const scan = await scanPage(page, signal);
  const notices: Notice[] = [];
  for (const n of scan.notices) {
    const kind = classifyNotice(n.text);
    if (kind) notices.push({ text: n.text, overlay: n.overlay, kind });
  }
  return { state, notices, viewers: parseViewerCount(scan.viewers) };
}

export interface WatchHealthOptions {
  /** The account's (single) browser page; may return a fresh page when the old one was closed. */
  getPage: () => Promise<Page>;
  producerUrl: string;
  pollMs: number;
  detectMs: number;
  tracker: ReturnType<typeof createHealthTracker>;
  /** Viewer count reporting (`viewers` events); omitted = none. */
  viewers?: ReturnType<typeof createViewerReporter>;
  /** False once another LIVE took over the page (this watcher must stop). */
  isCurrent: () => boolean;
  log: Logger;
  now?: () => number;
}

/**
 * Poll the producer page until `signal` aborts, yielding the tracker's events, then the viewer
 * count when it is due; returns right after yielding `ended`. Errors never escape: an unreadable
 * page is an 'unknown' sample. When the page left LIVE Producer (closed, or navigated elsewhere
 * for a few polls) it is brought back, so a takedown is still noticed.
 */
export async function* watchProducerHealth(opts: WatchHealthOptions, signal: AbortSignal): AsyncGenerator<LiveHealthEvent> {
  const now = opts.now ?? Date.now;
  let awayPolls = 0;
  while (!signal.aborted && opts.isCurrent()) {
    let sample: HealthSample;
    try {
      const page = await opts.getPage();
      signal.throwIfAborted();
      const url = page.url();
      if (isLoginUrl(url)) {
        sample = { state: 'logged-out', notices: [], viewers: null };
      } else if (!isUnder(url, opts.producerUrl) && !(await isDashboard(page))) {
        awayPolls += 1;
        if (url === 'about:blank' || awayPolls >= AWAY_POLLS) {
          awayPolls = 0;
          opts.log.info('TikTok LIVE Producer was not open; reopening it to watch the LIVE');
          await gotoPage(page, opts.producerUrl, signal);
          await detectState(page, opts.detectMs, signal);
          sample = await sampleProducer(page, signal);
        } else {
          sample = { state: 'unknown', notices: [], viewers: null };
        }
      } else {
        awayPolls = 0;
        sample = await sampleProducer(page, signal);
      }
    } catch (err) {
      if (signal.aborted) return;
      opts.log.debug({ err: errorText(err).split('\n', 1)[0]?.slice(0, 200) }, 'TikTok health check failed');
      sample = { state: 'unknown', notices: [], viewers: null };
    }
    if (signal.aborted || !opts.isCurrent()) return;
    const t = now();
    for (const event of opts.tracker.next(sample, t)) {
      yield event;
      if (event.type === 'ended') return;
    }
    const viewers = opts.viewers?.next(sampleViewers(sample), t);
    if (viewers && !signal.aborted) yield viewers;
    try {
      await sleep(opts.pollMs, signal);
    } catch {
      return; // aborted
    }
  }
}
