// Live health watcher (Stream Guard's backup signals), read from the producer page the driver keeps
// open for chat and ending:
// - a "live ended / removed / violates / copyright" notice → `ended` immediately (hard signal);
// - the producer drops out of the live state ("End live video" gone and the setup / "Go live" UI
//   back, or no live UI at all for a while) → `ended`;
// - Public lives with zeroViewerSec > 0: a readable count of 0 for that long → `ended`, only after
//   a 60 s grace from going live (Stream Guard's GRACE_PERIOD_SECONDS); unreadable → never fires;
// - logged out → `warning` (never `ended`: a recovery would only hit the login page);
// - softer notices ("will be removed if you continue", "interrupted") → `warning`, `ok` when gone.
// The runner's push-down rule is the primary signal; this only adds what Instagram shows.
// It also reports the viewer count (`viewers`) on every change and at least every 30 s, null when
// it can't be read (ViewerReporter) — for every audience, also with the 0-viewer rule off.

import type { Logger } from 'pino';
import type { Page } from 'playwright';
import { humanPause } from '../../browser/helpers.js';
import type { LiveHealthEvent } from '../types.js';
import { checkpointError, hasSessionCookie, isLoginUrl, visibleNow, type FlowConfig } from './flow.js';
import { HEALTH_PROBE_ARGS, HEALTH_PROBE_SOURCE, sel } from './selectors.js';
import { parseViewerCount, type Audience } from './util.js';

export interface HealthTimings {
  /** Stream Guard's POLL_INTERVAL_SECONDS. */
  pollMs: number;
  /** Viewer count reported on every change and at least this often. */
  viewersReportMs: number;
  /** A count unreadable for less than this keeps the last known count (re-renders, a flaky read). */
  viewersHoldMs: number;
  /** Viewer rule is ignored this long after going live (Stream Guard's GRACE_PERIOD_SECONDS). */
  graceMs: number;
  /** "End live video" gone and the setup / "Go live" UI shown this long ⇒ ended. */
  setupBackMs: number;
  /** "End live video" gone (no recognizable state) this long ⇒ ended. */
  liveLostMs: number;
  /** Viewer count unreadable this long (after the grace, viewer rule on) ⇒ one warning. */
  viewerUnavailableMs: number;
}

export const DEFAULT_HEALTH_TIMINGS: HealthTimings = {
  pollMs: 2_000,
  viewersReportMs: 30_000,
  viewersHoldMs: 6_000,
  graceMs: 60_000,
  setupBackMs: 3_000,
  liveLostMs: 20_000,
  viewerUnavailableMs: 20_000,
};

/** One read of the producer page. */
export interface HealthSnapshot {
  closed: boolean;
  loggedOut: boolean;
  /** Text of an "ended / removed" notice. */
  endedText: string | null;
  /** Text of a softer notice ("will be removed", "interrupted"). */
  warningText: string | null;
  /** "End live video" is visible. */
  live: boolean;
  /** The setup / "Go live" UI is visible. */
  setup: boolean;
  /** Viewer count, null when unreadable. */
  viewers: number | null;
}

export const SESSION_EXPIRED_WARNING =
  "Instagram session expired — log in again from Accounts. Takedowns can't be detected on Instagram's side until then.";
export const PAGE_CLOSED_WARNING = "The Instagram page was closed — takedowns can't be detected on Instagram's side.";
export const VIEWERS_UNAVAILABLE_WARNING = 'Viewer count unavailable — the 0-viewer takedown rule is paused.';

/** Per-live state shared by every health() run of that live. */
export interface LiveMarks {
  /** When the live went live (ms, monitor clock); null = not known (health start is used). */
  liveAt: number | null;
  /** "End live video" was seen during this live (makes the live-state-loss rule trustworthy). */
  sawLive: boolean;
}

export interface MonitorConfig {
  audience: Audience;
  zeroViewerSec: number;
  timings: HealthTimings;
  /** Go-live time used for the grace when marks.liveAt is null. */
  startedAt: number;
  marks: LiveMarks;
  /** A standing warning from elsewhere (e.g. the link couldn't be added). */
  extraWarning?: () => string | null;
}

function shortNotice(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 160 ? `${t.slice(0, 157)}…` : t;
}

/** Pure decision logic: snapshots in, health events out (unit-tested with a fake clock). */
export class HealthMonitor {
  private notLiveSince: number | null = null;
  private zeroSince: number | null = null;
  private unreadableSince: number | null = null;
  private current: string | null = null;
  private done = false;

  constructor(private readonly cfg: MonitorConfig) {}

  /** Events for one snapshot taken at `now`. After an `ended` the monitor yields nothing more. */
  step(s: HealthSnapshot, now: number): LiveHealthEvent[] {
    if (this.done) return [];
    let warning: string | null = null;
    if (s.closed) {
      warning = PAGE_CLOSED_WARNING;
      this.resetTimers();
    } else if (s.loggedOut) {
      warning = SESSION_EXPIRED_WARNING;
      this.resetTimers();
    } else {
      const ended = this.endedReason(s, now);
      if (ended) {
        this.done = true;
        return [{ type: 'ended', reason: ended }];
      }
      const viewerWarning = this.viewerWarning(s, now);
      warning = s.warningText ? `Instagram: "${shortNotice(s.warningText)}"` : viewerWarning;
    }
    warning ??= this.cfg.extraWarning?.() ?? null;
    if (warning === this.current) return [];
    this.current = warning;
    return [warning ? { type: 'warning', message: warning } : { type: 'ok' }];
  }

  private resetTimers(): void {
    this.notLiveSince = null;
    this.zeroSince = null;
    this.unreadableSince = null;
  }

  private viewerRuleOn(): boolean {
    return this.cfg.audience === 'public' && this.cfg.zeroViewerSec > 0;
  }

  private endedReason(s: HealthSnapshot, now: number): string | null {
    if (s.endedText) return shortNotice(s.endedText);

    const { timings, marks } = this.cfg;
    if (s.live) {
      marks.sawLive = true;
      this.notLiveSince = null;
    } else if (marks.sawLive) {
      this.notLiveSince ??= now;
      const gone = now - this.notLiveSince;
      if (s.setup && gone >= timings.setupBackMs) return 'the Instagram producer is back at the setup screen';
      if (gone >= timings.liveLostMs) {
        return `the Instagram producer left the live (no "End live video" for ${Math.round(gone / 1000)} s)`;
      }
    }

    if (!this.viewerRuleOn()) return null;
    const liveAt = marks.liveAt ?? this.cfg.startedAt;
    if (now - liveAt < timings.graceMs) {
      this.zeroSince = null;
      this.unreadableSince = null;
      return null;
    }
    if (s.viewers === null) {
      this.zeroSince = null;
      this.unreadableSince ??= now;
      return null;
    }
    this.unreadableSince = null;
    if (s.viewers !== 0) {
      this.zeroSince = null;
      return null;
    }
    this.zeroSince ??= now;
    return now - this.zeroSince >= this.cfg.zeroViewerSec * 1000 ? `0 viewers for ${this.cfg.zeroViewerSec} s` : null;
  }

  private viewerWarning(s: HealthSnapshot, now: number): string | null {
    if (!this.viewerRuleOn() || s.viewers !== null || this.unreadableSince === null) return null;
    return now - this.unreadableSince >= this.cfg.timings.viewerUnavailableMs ? VIEWERS_UNAVAILABLE_WARNING : null;
  }
}

export type ViewersEvent = Extract<LiveHealthEvent, { type: 'viewers' }>;

/**
 * Pure: turns viewer-count reads (null = unreadable) into `viewers` events — the first read, every
 * change, and the same count again after `reportMs` (so a restarted dashboard catches up). A count
 * that is unreadable for less than `holdMs` keeps the last known count (a re-render or a flaky
 * read must not flash "unknown"); after that it's reported as null. Never invents a 0.
 */
export class ViewerReporter {
  /** Last reported count; undefined = nothing reported yet. */
  private last: number | null | undefined = undefined;
  private lastAt = 0;
  private unreadableSince: number | null = null;

  constructor(
    private readonly reportMs: number,
    private readonly holdMs: number,
  ) {}

  step(count: number | null, now: number): ViewersEvent | null {
    let value = count;
    if (count === null) {
      this.unreadableSince ??= now;
      if (typeof this.last === 'number' && now - this.unreadableSince < this.holdMs) value = this.last;
    } else {
      this.unreadableSince = null;
    }
    if (value === this.last && now - this.lastAt < this.reportMs) return null;
    this.last = value;
    this.lastAt = now;
    return { type: 'viewers', count: value };
  }
}

const PROBE_EXPRESSION = `(${HEALTH_PROBE_SOURCE})(${JSON.stringify(HEALTH_PROBE_ARGS)})`;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Read the producer page once (never throws; a navigating page reads as "nothing visible"). */
export async function probeHealth(page: Page, cfg: FlowConfig): Promise<HealthSnapshot> {
  const closed: HealthSnapshot = {
    closed: true,
    loggedOut: false,
    endedText: null,
    warningText: null,
    live: false,
    setup: false,
    viewers: null,
  };
  if (page.isClosed()) return closed;
  const url = page.url();
  const hasCookie = await hasSessionCookie(page.context(), cfg.baseUrl).catch(() => true);
  const loggedOut = !hasCookie || isLoginUrl(url) || checkpointError(url) !== null;
  const scan = (await page.evaluate(PROBE_EXPRESSION).catch(() => null)) as {
    ended?: unknown;
    warning?: unknown;
    viewers?: unknown;
  } | null;
  const live = (await visibleNow(sel.endLiveButton(page))) !== null;
  // Not the stream key: the producer may keep showing it during the live.
  const setup = !live && ((await visibleNow(sel.goLiveButton(page))) !== null || (await visibleNow(sel.nextButton(page))) !== null);
  if (page.isClosed()) return closed;
  return {
    closed: false,
    loggedOut,
    endedText: text(scan?.ended),
    warningText: text(scan?.warning),
    live,
    setup,
    viewers: parseViewerCount(text(scan?.viewers)),
  };
}

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

export interface WatchOptions {
  cfg: FlowConfig;
  monitor: HealthMonitor;
  /** Viewer count reporting (`viewers` events); omitted = none. */
  viewers?: ViewerReporter;
  pollMs: number;
  now: () => number;
  /** False once a newer live owns the page: stop reading it (and stay quiet until aborted). */
  isCurrent: () => boolean;
  log: Logger;
}

/**
 * Polls the page every `pollMs` and yields the monitor's events (then the viewer count, when it is
 * due) until `signal` aborts. After an `ended` it stays open (quiet) until aborted, so the runner
 * never sees an early end.
 */
export async function* watchHealth(page: Page, signal: AbortSignal, opts: WatchOptions): AsyncGenerator<LiveHealthEvent> {
  while (!signal.aborted) {
    if (!opts.isCurrent()) {
      await untilAborted(signal);
      return;
    }
    const snapshot = await probeHealth(page, opts.cfg);
    if (signal.aborted || !opts.isCurrent()) continue;
    const now = opts.now();
    for (const ev of opts.monitor.step(snapshot, now)) {
      if (ev.type === 'ended') opts.log.warn({ reason: ev.reason }, 'Instagram ended the live');
      else if (ev.type === 'warning') opts.log.info({ message: ev.message }, 'Instagram live warning');
      yield ev;
      if (ev.type === 'ended') {
        await untilAborted(signal);
        return;
      }
    }
    const viewers = opts.viewers?.step(snapshot.viewers, now);
    if (viewers && !signal.aborted) yield viewers;
    try {
      await humanPause(opts.pollMs, opts.pollMs, signal);
    } catch {
      return; // aborted
    }
  }
}
