// Session + go-live orchestrator (docs/ARCHITECTURE.md §4).
//
// Owns the SessionState: one DestinationRunner per enabled destination while a session runs.
// Session-level operations (start/stop/destination edits) are serialized on one queue; each
// runner serializes its own steps. Runner teardown (push stop + end()) happens outside the
// session queue but is chained per destination, so a restarted runner never races the old one.

import { createHash, randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import {
  FEEDS,
  type Destination,
  type DestinationPhase,
  type DestinationState,
  type Feed,
  type FeedState,
  type SessionState,
  type SessionStatus,
  type TitleResult,
} from '../../../shared/types.js';
import type { AppServices, Orchestrator } from '../services.js';
import { awaitBounded, errorMessage, SerialQueue, stableStringify, textLength } from './async-utils.js';
import {
  DEFAULT_TIMINGS,
  DestinationRunner,
  type OrchestratorTimings,
  type RunnerHost,
  type StatePatch,
} from './destination-runner.js';

export { DEFAULT_TIMINGS, type OrchestratorTimings } from './destination-runner.js';

export const MAX_TITLE_LENGTH = 140;
const DEFAULT_GRACE_SEC = 15;

export interface OrchestratorOptions {
  timings?: Partial<OrchestratorTimings>;
}

/** Error carrying an HTTP status, mapped by the app error handler. */
function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function nowIso(): string {
  return new Date().toISOString();
}

function offlinePhase(dest: Destination): DestinationPhase {
  return dest.enabled ? 'idle' : 'disabled';
}

const RESET: StatePatch = { message: null, stats: null, watchUrl: null, retries: 0 };

/** A runner teardown started under the session lock, awaited after releasing it. */
type Teardown = { done: Promise<void> } | null;

function stopNotice(reason: string, graceSec: number): string {
  switch (reason) {
    case 'manual':
      return 'Session stopped';
    case 'obs-disconnected':
      return `Session ended: no feed from OBS for ${graceSec} s`;
    case 'shutdown':
      return 'Session stopped: server shutting down';
    default:
      return `Session stopped (${reason})`;
  }
}

export function createOrchestrator(services: AppServices, opts: OrchestratorOptions = {}): Orchestrator {
  return new SessionOrchestrator(services, { ...DEFAULT_TIMINGS, ...opts.timings });
}

class SessionOrchestrator implements Orchestrator {
  private readonly lock = new SerialQueue();
  private readonly lifetime = new AbortController();
  private readonly host: RunnerHost;
  private readonly log: Logger;

  private loaded = false;
  private status: SessionStatus = 'offline';
  private sessionId: string | null = null;
  private startedAt: string | null = null;
  private title = '';
  private autoGoLive = true;

  private readonly feeds = new Map<Feed, FeedState>();
  private readonly states = new Map<string, DestinationState>();
  private readonly runners = new Map<string, DestinationRunner>();
  /** Latest teardown per destination; a new runner for the id waits for it. */
  private readonly cleanups = new Map<string, Promise<void>>();
  /** Removed via destinationRemoved() but possibly still in the repo for a moment. */
  private readonly removed = new Set<string>();

  private obsGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribers: (() => void)[] = [];
  private shuttingDown = false;
  /** A feed came online while a stop was tearing down; auto go-live re-checks once it finishes. */
  private feedReturnedWhileStopping = false;

  constructor(
    private readonly services: AppServices,
    private readonly timings: OrchestratorTimings,
  ) {
    // services.orchestrator is assigned after construction: only read services lazily.
    this.log = services.log.child({ mod: 'orchestrator' });
    this.host = {
      services,
      timings,
      log: this.log,
      title: () => this.title,
      feedOnline: (feed) => this.feeds.get(feed)?.online === true,
      graceMs: () => this.graceSec() * 1000,
      endTimeoutMs: () => (this.shuttingDown ? timings.shutdownEndTimeoutMs : timings.endTimeoutMs),
      update: (id, patch) => this.update(id, patch),
      notice: (level, message) => this.services.bus.emit('notice', { level, message }),
    };
  }

  // ---------------------------------------------------------------------------
  // Orchestrator interface
  // ---------------------------------------------------------------------------

  async init(): Promise<void> {
    if (this.unsubscribers.length > 0) return;
    this.ensureLoaded();
    for (const f of this.mediaFeeds()) this.feeds.set(f.feed, f);
    const { bus } = this.services;
    this.unsubscribers.push(
      bus.on('feed', (f) => this.onFeed(f)),
      bus.on('push', (ev) => this.runners.get(ev.id)?.pushEvent(ev)),
    );
    if (this.autoGoLive && this.anyFeedOnline()) await this.start('auto');
  }

  state(): SessionState {
    this.ensureLoaded();
    const list = this.reconcile();
    const listed = new Set(list.map((d) => d.id));
    const destinations: DestinationState[] = [];
    for (const d of list) {
      const st = this.states.get(d.id);
      if (st) destinations.push(st);
    }
    for (const [id, st] of this.states) if (!listed.has(id)) destinations.push(st);
    return {
      status: this.status,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      title: this.title,
      autoGoLive: this.autoGoLive,
      feeds: FEEDS.map((f) => this.feeds.get(f) ?? offlineFeed(f)),
      destinations,
    };
  }

  start(trigger: 'auto' | 'manual'): Promise<void> {
    return this.lock.run(() => {
      this.ensureLoaded();
      if (this.status !== 'offline' || this.shuttingDown) return;
      this.sessionId = randomUUID();
      this.startedAt = nowIso();
      this.status = 'starting';
      this.log.info({ sessionId: this.sessionId, trigger }, 'session starting');
      this.emitSession();

      for (const dest of this.reconcile()) {
        if (dest.enabled) this.launchRunner(dest);
        else this.update(dest.id, { ...RESET, phase: 'disabled' });
      }
      this.status = 'live';
      this.emitSession();
    });
  }

  stop(reason = 'manual'): Promise<void> {
    return this.stopSession(reason);
  }

  /**
   * @param expectSessionId set by the OBS grace timer: skip the stop when that session already
   *   ended, or when a feed came back while this stop waited for the lock.
   */
  private stopSession(reason: string, expectSessionId?: string | null): Promise<void> {
    return this.lock.run(async () => {
      if (this.status === 'offline') return;
      if (expectSessionId !== undefined && (this.sessionId !== expectSessionId || this.anyFeedOnline())) return;
      this.clearObsGrace();
      this.feedReturnedWhileStopping = false;
      this.status = 'stopping';
      this.log.info({ sessionId: this.sessionId, reason }, 'session stopping');
      this.emitSession();

      const pending = [...this.runners.keys()].map((id) => this.retireRunner(id));
      await Promise.all([...pending, ...this.cleanups.values()]);

      this.status = 'offline';
      this.sessionId = null;
      this.startedAt = null;
      for (const dest of this.reconcile()) this.update(dest.id, { ...RESET, phase: offlinePhase(dest) });
      this.emitSession();
      this.services.bus.emit('notice', { level: 'info', message: stopNotice(reason, this.graceSec()) });

      // OBS (re)started streaming during the teardown: that offline->online transition was ignored
      // while 'stopping', and no other one will come, so honour auto go-live now. This applies to a
      // manual stop too: it is a genuine new OBS start (a feed that simply stays online through a
      // manual stop records nothing and stays offline). start() is queued behind this task, never awaited.
      const feedReturned = this.feedReturnedWhileStopping;
      this.feedReturnedWhileStopping = false;
      if (feedReturned && reason !== 'shutdown') this.maybeAutoStart();
    });
  }

  async setTitle(title: string): Promise<TitleResult[]> {
    this.ensureLoaded();
    const next = title.trim();
    if (textLength(next) > MAX_TITLE_LENGTH) {
      throw httpError(400, `Title must be at most ${MAX_TITLE_LENGTH} characters`);
    }
    this.services.repos.settings.set('session.title', next);
    this.title = next;
    this.emitSession();

    const list = this.listDestinations();
    if (this.status === 'live' || this.status === 'starting') {
      return Promise.all(
        list.map(
          (d) =>
            this.runners.get(d.id)?.setTitle(next) ??
            Promise.resolve(skipped(d.id, d.enabled ? 'Not live yet; the new title is used when it goes live' : 'Destination is disabled')),
        ),
      );
    }
    return Promise.all(list.map((d) => this.setTitleOffline(d, next)));
  }

  setAutoGoLive(value: boolean): void {
    this.ensureLoaded();
    this.services.repos.settings.set('session.autoGoLive', value);
    this.autoGoLive = value;
    this.emitSession();
    if (value) this.maybeAutoStart();
  }

  // The three methods below do their bookkeeping under the session lock but wait for the runner
  // teardown (push stop + end(), up to ~30 s) outside it, so a Stop click is never stuck behind it.
  // The teardown is returned wrapped in an object: a bare promise would be adopted by the lock.

  async destinationChanged(id: string): Promise<void> {
    const teardown = await this.lock.run(async (): Promise<Teardown> => {
      this.ensureLoaded();
      const dest = this.getDestination(id);
      if (!dest) return this.removeLocked(id);
      this.removed.delete(id);

      const isNew = !this.states.has(id);
      if (isNew) this.states.set(id, blankState(id, offlinePhase(dest)));

      if (this.status !== 'live') {
        this.update(id, { phase: offlinePhase(dest) });
        if (isNew) this.emitSession();
        return null;
      }
      if (isNew) this.emitSession();

      const runner = this.runners.get(id);
      if (!dest.enabled) {
        if (runner) return { done: this.retireRunner(id) };
        this.update(id, { ...RESET, phase: 'disabled' });
        return null;
      }
      if (!runner) {
        this.launchRunner(dest);
        return null;
      }
      const [before, after] = await Promise.all([runner.fingerprint, this.fingerprint(dest)]);
      if (before === after) return null;
      this.log.info({ destinationId: id }, 'destination config changed; restarting it');
      const done = this.retireRunner(id);
      this.launchRunner(dest);
      return { done };
    });
    await teardown?.done;
  }

  async destinationRemoved(id: string): Promise<void> {
    const teardown = await this.lock.run(() => this.removeLocked(id));
    await teardown.done;
  }

  async retryDestination(id: string): Promise<void> {
    const teardown = await this.lock.run((): Teardown => {
      if (this.status !== 'live') return null;
      const dest = this.getDestination(id);
      if (!dest || !dest.enabled) return null;
      this.log.info({ destinationId: id }, 'retrying destination');
      const done = this.retireRunner(id);
      this.launchRunner(dest);
      return { done };
    });
    await teardown?.done;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.clearObsGrace();
    await this.stop('shutdown');
    this.lifetime.abort();
  }

  // ---------------------------------------------------------------------------
  // Feeds
  // ---------------------------------------------------------------------------

  private onFeed(feed: FeedState): void {
    const prev = this.feeds.get(feed.feed);
    this.feeds.set(feed.feed, feed);
    if (prev?.online === feed.online) return; // stats-only update; the UI gets 'feed' events directly
    this.emitSession();
    for (const runner of this.runners.values()) runner.feedsChanged();

    if (feed.online) {
      this.clearObsGrace();
      if (this.status === 'stopping') this.feedReturnedWhileStopping = true;
      this.maybeAutoStart();
    } else if (!this.anyFeedOnline() && (this.status === 'live' || this.status === 'starting')) {
      this.armObsGrace();
    }
  }

  private maybeAutoStart(): void {
    if (!this.autoGoLive || this.status !== 'offline' || this.shuttingDown || !this.anyFeedOnline()) return;
    this.start('auto').catch((err: unknown) => this.log.error({ error: errorMessage(err) }, 'auto go-live failed'));
  }

  /** OBS stopped (every feed offline): end the session unless a feed returns within the grace period. */
  private armObsGrace(): void {
    if (this.obsGraceTimer) return;
    const sessionId = this.sessionId;
    this.obsGraceTimer = setTimeout(() => {
      this.obsGraceTimer = null;
      if (this.sessionId !== sessionId || this.anyFeedOnline()) return;
      // Re-checked under the lock: a feed may return while an earlier task still holds it.
      this.stopSession('obs-disconnected', sessionId).catch((err: unknown) =>
        this.log.error({ error: errorMessage(err) }, 'stopping after OBS disconnect failed'),
      );
    }, this.graceSec() * 1000);
  }

  private clearObsGrace(): void {
    if (this.obsGraceTimer) clearTimeout(this.obsGraceTimer);
    this.obsGraceTimer = null;
  }

  private anyFeedOnline(): boolean {
    for (const f of this.feeds.values()) if (f.online) return true;
    return false;
  }

  private mediaFeeds(): FeedState[] {
    try {
      return this.services.media.feeds();
    } catch (err) {
      this.log.warn({ error: errorMessage(err) }, 'reading feed state failed');
      return [];
    }
  }

  private graceSec(): number {
    const value = Number(this.services.appSettings().disconnectGraceSec);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_GRACE_SEC;
  }

  // ---------------------------------------------------------------------------
  // Runners
  // ---------------------------------------------------------------------------

  private launchRunner(dest: Destination): void {
    const after = this.cleanups.get(dest.id) ?? Promise.resolve();
    if (!this.states.has(dest.id)) this.states.set(dest.id, blankState(dest.id, 'idle'));
    const runner = new DestinationRunner(this.host, dest, this.fingerprint(dest), after);
    this.runners.set(dest.id, runner);
    runner.start();
  }

  /** Detach the destination's runner and tear it down. Resolves when the teardown is done. */
  private retireRunner(id: string): Promise<void> {
    const runner = this.runners.get(id);
    if (!runner) return this.cleanups.get(id) ?? Promise.resolve();
    this.runners.delete(id);
    const done = runner.stop().then(() => {
      if (this.cleanups.get(id) === done) this.cleanups.delete(id);
      // No successor took over: settle on a resting phase.
      if (!this.runners.has(id) && this.states.has(id)) {
        const dest = this.getDestination(id);
        const phase: DestinationPhase = !dest || !dest.enabled ? 'disabled' : 'idle';
        this.update(id, { ...RESET, phase });
      }
    });
    this.cleanups.set(id, done);
    return done;
  }

  private removeLocked(id: string): { done: Promise<void> } {
    const done = this.retireRunner(id);
    this.removed.add(id);
    if (this.states.delete(id)) this.emitSession();
    return { done };
  }

  /** Detects config edits that need a runner restart (including a replaced stream key). */
  private async fingerprint(dest: Destination): Promise<string> {
    let keyHash = '';
    if (dest.hasStreamKey) {
      try {
        const key = await this.services.repos.secrets.scoped(`destination:${dest.id}`).get('streamKey');
        keyHash = key ? createHash('sha256').update(key).digest('hex') : '';
      } catch (err) {
        this.log.warn({ destinationId: dest.id, error: errorMessage(err) }, 'reading stream key for fingerprint failed');
      }
    }
    return stableStringify([dest.platform, dest.accountId, dest.feed, dest.options, dest.ingestUrl, dest.hasStreamKey, keyHash]);
  }

  // ---------------------------------------------------------------------------
  // Title
  // ---------------------------------------------------------------------------

  private async setTitleOffline(dest: Destination, title: string): Promise<TitleResult> {
    if (!dest.enabled) return skipped(dest.id, 'Destination is disabled');
    let driver;
    try {
      driver = this.services.platforms.get(dest.platform);
    } catch (err) {
      return { destinationId: dest.id, ok: false, error: errorMessage(err) };
    }
    const setOffline = driver.setTitleOffline?.bind(driver);
    if (!setOffline) return skipped(dest.id, 'Applied when the stream goes live');
    try {
      await awaitBounded(
        async (signal) => {
          const ctx = await this.services.driverContext({
            platform: dest.platform,
            accountId: dest.accountId,
            destinationId: dest.id,
            signal,
          });
          const account = dest.accountId ? this.services.repos.accounts.get(dest.accountId) : null;
          await setOffline(dest, account, title, ctx);
        },
        { ms: this.timings.titleTimeoutMs, signal: this.lifetime.signal, what: 'Updating the title' },
      );
      return { destinationId: dest.id, ok: true };
    } catch (err) {
      this.log.warn({ destinationId: dest.id, error: errorMessage(err) }, 'offline title update failed');
      return { destinationId: dest.id, ok: false, error: errorMessage(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const { settings } = this.services.repos;
    const title = settings.get<unknown>('session.title', '');
    this.title = typeof title === 'string' ? title : '';
    this.autoGoLive = settings.get<unknown>('session.autoGoLive', true) !== false;
    for (const f of this.mediaFeeds()) this.feeds.set(f.feed, f);
  }

  private listDestinations(): Destination[] {
    try {
      return this.services.repos.destinations.list();
    } catch (err) {
      this.log.error({ error: errorMessage(err) }, 'listing destinations failed');
      return [];
    }
  }

  private getDestination(id: string): Destination | null {
    try {
      return this.services.repos.destinations.get(id);
    } catch (err) {
      this.log.error({ destinationId: id, error: errorMessage(err) }, 'reading destination failed');
      return null;
    }
  }

  /** Align destination states with the repo; returns the repo list (minus removed ids). */
  private reconcile(): Destination[] {
    const all = this.listDestinations();
    if (this.removed.size > 0) {
      const repoIds = new Set(all.map((d) => d.id));
      for (const id of this.removed) if (!repoIds.has(id)) this.removed.delete(id);
    }
    const list = all.filter((d) => !this.removed.has(d.id));

    const resting = this.status === 'offline';
    for (const d of list) {
      const st = this.states.get(d.id);
      if (!st) {
        this.states.set(d.id, blankState(d.id, resting ? offlinePhase(d) : d.enabled ? 'idle' : 'disabled'));
      } else if (resting && !this.runners.has(d.id) && (st.phase === 'idle' || st.phase === 'disabled')) {
        const phase = offlinePhase(d);
        if (st.phase !== phase) this.states.set(d.id, { ...st, phase, since: nowIso() });
      }
    }
    const listed = new Set(list.map((d) => d.id));
    for (const id of [...this.states.keys()]) {
      if (!listed.has(id) && !this.runners.has(id)) this.states.delete(id);
    }
    return list;
  }

  private update(id: string, patch: StatePatch): void {
    const cur = this.states.get(id);
    if (!cur) return;
    const next: DestinationState = { ...cur, ...patch };
    if (patch.phase && patch.phase !== cur.phase) next.since = nowIso();
    if (
      next.phase === cur.phase &&
      next.message === cur.message &&
      next.stats === cur.stats &&
      next.watchUrl === cur.watchUrl &&
      next.retries === cur.retries
    ) {
      return;
    }
    this.states.set(id, next);
    this.services.bus.emit('destination', next);
  }

  private emitSession(): void {
    this.services.bus.emit('session', this.state());
  }
}

function blankState(id: string, phase: DestinationPhase): DestinationState {
  return { destinationId: id, phase, message: null, stats: null, watchUrl: null, retries: 0, since: nowIso() };
}

function skipped(destinationId: string, reason: string): TitleResult {
  return { destinationId, ok: true, skipped: true, error: reason };
}

function offlineFeed(feed: Feed): FeedState {
  return { feed, online: false, since: null, video: null, audio: null, bitrateKbps: null };
}
