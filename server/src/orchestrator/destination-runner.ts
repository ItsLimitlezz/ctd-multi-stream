// One runner per destination per session: waits for its feed(s), prepares the live with the
// platform driver, starts the FFmpeg push, confirms ("Go Live"), attaches chat, and ends the live.
//
// All state changes run on a per-runner serial queue, so feed events, push events and timers
// never interleave. Long driver calls (prepare, confirm) run outside the queue and post their
// result back into it; stop() aborts them, so it never waits for a slow platform.

import type { Logger } from 'pino';
import type {
  Destination,
  DestinationPhase,
  DestinationState,
  Feed,
  TitleResult,
} from '../../../shared/types.js';
import type { PushEvent, PushStatus } from '../events.js';
import { DriverError, type PlatformDriver, type PreparedLive, type PushPlan } from '../platforms/types.js';
import type { AppServices } from '../services.js';
import { awaitBounded, errorMessage, SerialQueue } from './async-utils.js';

export interface OrchestratorTimings {
  prepareTimeoutMs: number;
  confirmTimeoutMs: number;
  endTimeoutMs: number;
  /**
   * end() budget once the server is shutting down. Push stop (<= ~7 s) + this + the browser
   * session save must fit in main.ts's force-exit deadline (itself under Docker's 30 s stop grace).
   */
  shutdownEndTimeoutMs: number;
  titleTimeoutMs: number;
  /** Delays between prepare attempts for retryable errors; when exhausted → error. */
  prepareBackoffMs: readonly number[];
}

export const DEFAULT_TIMINGS: OrchestratorTimings = {
  prepareTimeoutMs: 120_000,
  confirmTimeoutMs: 180_000,
  endTimeoutMs: 30_000,
  shutdownEndTimeoutMs: 15_000,
  titleTimeoutMs: 30_000,
  prepareBackoffMs: [5_000, 15_000, 30_000, 60_000, 60_000],
};

/** Driver error codes the user has to fix: no automatic retry. */
const FATAL_CODES = new Set<string>(['needs-login', 'not-connected', 'misconfigured', 'not-eligible']);

export type StatePatch = Partial<Omit<DestinationState, 'destinationId' | 'since'>>;

/** What a runner needs from the orchestrator. */
export interface RunnerHost {
  services: AppServices;
  log: Logger;
  timings: OrchestratorTimings;
  title(): string;
  feedOnline(feed: Feed): boolean;
  graceMs(): number;
  /** Current end() budget (shorter while the server shuts down). */
  endTimeoutMs(): number;
  update(id: string, patch: StatePatch): void;
  notice(level: 'info' | 'warn' | 'error', message: string): void;
}

function isFatal(err: unknown): boolean {
  if (err instanceof DriverError) return FATAL_CODES.has(err.code);
  // Tolerate a DriverError from a duplicated module instance.
  const e = err as { name?: unknown; code?: unknown } | null;
  return !!e && e.name === 'DriverError' && typeof e.code === 'string' && FATAL_CODES.has(e.code);
}

function secs(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

export class DestinationRunner {
  readonly id: string;
  private readonly ctl = new AbortController();
  private readonly queue: SerialQueue;
  private driver: PlatformDriver | null = null;
  private required: Feed[] = [];

  private prepared: PreparedLive | null = null;
  private preparing = false;
  private prepareTask: Promise<void> = Promise.resolve();
  private attempts = 0;

  private pushActive = false;
  private pushStatus: PushStatus | null = null;

  private confirmState: 'none' | 'running' | 'done' = 'none';
  private confirmCtl: AbortController | null = null;
  private confirmTask: Promise<void> = Promise.resolve();

  private chatCtl: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private failed = false;
  private halted = false;
  private finished = false;
  private stopping: Promise<void> | null = null;

  /**
   * @param fingerprint config fingerprint, compared by the orchestrator to detect edits.
   * @param after a previous runner's cleanup for the same destination; nothing runs before it settles
   *              (the push supervisor is keyed by destination id).
   */
  constructor(
    private readonly host: RunnerHost,
    readonly dest: Destination,
    readonly fingerprint: Promise<string>,
    after: Promise<void> = Promise.resolve(),
  ) {
    this.id = dest.id;
    this.queue = new SerialQueue(after);
  }

  // ---------------------------------------------------------------------------
  // Inputs
  // ---------------------------------------------------------------------------

  start(): void {
    void this.enqueue(() => {
      if (this.halted) return;
      try {
        this.driver = this.host.services.platforms.get(this.dest.platform);
        this.required = this.driver.requiredFeeds?.(this.dest) ?? [this.dest.feed];
      } catch (err) {
        this.fail(errorMessage(err));
        return;
      }
      this.set({ message: null, stats: null, watchUrl: null, retries: 0 });
      return this.evaluate();
    });
  }

  feedsChanged(): void {
    void this.enqueue(() => this.evaluate());
  }

  pushEvent(ev: PushEvent): void {
    void this.enqueue(() => this.onPush(ev));
  }

  /** Abort everything, stop the push and end the live. Idempotent; never rejects. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.halted = true;
    this.clearTimers();
    this.ctl.abort();
    this.confirmCtl?.abort();
    this.stopping = (async () => {
      await this.enqueue(() => this.cleanup());
      // Aborted prepare/confirm settle right away; wait for their (no-op or orphan-ending) handlers.
      await Promise.all([this.prepareTask, this.confirmTask]);
      this.finished = true;
    })();
    return this.stopping;
  }

  /** Live title change. Not prepared yet → skipped (prepare uses the new title). */
  async setTitle(title: string): Promise<TitleResult> {
    const prepared = this.prepared;
    if (this.halted || !prepared) {
      return { destinationId: this.id, ok: true, skipped: true, error: 'Not live yet; the new title is used when it goes live' };
    }
    if (!prepared.setTitle) {
      return { destinationId: this.id, ok: true, skipped: true, error: "This platform can't change the title while live" };
    }
    try {
      await awaitBounded((signal) => prepared.setTitle!(title, signal), {
        ms: this.host.timings.titleTimeoutMs,
        signal: this.ctl.signal,
        what: 'Updating the title',
      });
      return { destinationId: this.id, ok: true };
    } catch (err) {
      return { destinationId: this.id, ok: false, error: errorMessage(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // State machine (runs on the queue)
  // ---------------------------------------------------------------------------

  private async evaluate(): Promise<void> {
    if (this.halted || this.failed || !this.driver) return;
    if (this.requiredOnline()) {
      this.clearGrace();
      if (this.prepared) await this.resume(this.prepared);
      else if (!this.preparing && !this.retryTimer) this.launchPrepare(this.driver);
      return;
    }
    // A required feed is offline.
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.prepared) await this.pause();
    else if (!this.preparing) this.set({ phase: 'waiting-for-feed', message: this.waitingMessage(), stats: null });
  }

  /** Feed(s) online with a prepared live: (re)start the push, or go live when there is none. */
  private async resume(prepared: PreparedLive): Promise<void> {
    if (!prepared.push) {
      this.goLive(prepared);
      return;
    }
    if (!this.pushActive) await this.startPush(prepared.push);
  }

  /** Feed went offline: stop the push, keep the prepared live for the grace period. */
  private async pause(): Promise<void> {
    if (this.pushActive) await this.stopPush();
    const graceMs = this.host.graceMs();
    if (!this.graceTimer) {
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        void this.enqueue(() => this.expireGrace());
      }, graceMs);
    }
    this.set({
      phase: 'waiting-for-feed',
      message: `Feed offline: waiting up to ${secs(graceMs)} for it to return`,
      stats: null,
    });
  }

  /** The feed did not come back in time: end this live; a fresh prepare happens when it returns. */
  private async expireGrace(): Promise<void> {
    if (this.halted || this.failed || !this.prepared) return;
    if (this.requiredOnline()) return this.evaluate();
    this.host.log.info({ destinationId: this.id }, 'feed did not return in time; ending live');
    this.set({ phase: 'ending', message: null });
    await this.endLive();
    if (this.halted) return;
    this.set({
      phase: 'waiting-for-feed',
      message: `${this.waitingMessage()}; a new live will be prepared when it returns`,
      watchUrl: null,
      stats: null,
    });
  }

  private launchPrepare(driver: PlatformDriver): void {
    this.preparing = true;
    const title = this.host.title();
    this.set({ phase: 'preparing', message: null, stats: null });
    this.prepareTask = awaitBounded((signal) => this.prepareOnce(driver, title, signal), {
      ms: this.host.timings.prepareTimeoutMs,
      signal: this.ctl.signal,
      what: 'Preparing the live',
      onLate: (late) => void this.callEnd(late, 'late prepare result'),
    }).then(
      (prepared) => this.enqueue(() => this.onPrepared(prepared, title)),
      (err: unknown) => this.enqueue(() => this.onPrepareFailed(err)),
    );
  }

  private async prepareOnce(driver: PlatformDriver, title: string, signal: AbortSignal): Promise<PreparedLive> {
    const { services } = this.host;
    const dest = services.repos.destinations.get(this.id) ?? this.dest;
    const ctx = await services.driverContext({
      platform: dest.platform,
      accountId: dest.accountId,
      destinationId: dest.id,
      signal,
    });
    const account = dest.accountId ? services.repos.accounts.get(dest.accountId) : null;
    if (driver.validateDestination) {
      const problems = await driver.validateDestination(dest, account, ctx);
      if (problems.length > 0) throw new DriverError(problems.join('; '), 'misconfigured');
    }
    signal.throwIfAborted();
    return driver.prepare(dest, account, title, ctx);
  }

  private async onPrepared(prepared: PreparedLive, usedTitle: string): Promise<void> {
    this.preparing = false;
    if (this.halted) {
      // stop() raced with a just-finished prepare: the live exists on the platform, end it.
      await this.callEnd(prepared, 'prepared after stop');
      return;
    }
    this.prepared = prepared;
    this.attempts = 0;
    this.confirmState = 'none';
    this.set({ watchUrl: prepared.watchUrl ?? null, message: null, retries: 0 });

    // The title changed while preparing: apply the current one.
    const current = this.host.title();
    if (current !== usedTitle && prepared.setTitle) {
      void this.setTitle(current).then((r) => {
        if (!r.ok) this.host.log.warn({ destinationId: this.id, error: r.error }, 'title update after prepare failed');
      });
    }

    if (this.requiredOnline()) await this.resume(prepared);
    else await this.pause();
  }

  private onPrepareFailed(err: unknown): void {
    this.preparing = false;
    if (this.halted) return;
    const message = errorMessage(err);
    const backoff = this.host.timings.prepareBackoffMs;
    if (isFatal(err) || this.attempts >= backoff.length) {
      this.host.log.warn({ destinationId: this.id, attempts: this.attempts + 1, error: message }, 'prepare failed');
      this.fail(message);
      return;
    }
    const delay = backoff[this.attempts] ?? 60_000;
    this.attempts += 1;
    this.host.log.warn({ destinationId: this.id, attempt: this.attempts, error: message }, 'prepare failed; retrying');
    this.set({ phase: 'retrying', message: `${message} (retrying in ${secs(delay)})`, retries: this.attempts, stats: null });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.enqueue(() => this.evaluate());
    }, delay);
  }

  private async startPush(plan: PushPlan): Promise<void> {
    this.pushStatus = null;
    this.pushActive = true;
    this.set({ phase: 'connecting', message: null, stats: null });
    try {
      this.host.services.pushes.start(this.id, plan);
    } catch (err) {
      await this.failLive(`Couldn't start the relay: ${errorMessage(err)}`);
    }
  }

  private async onPush(ev: PushEvent): Promise<void> {
    const prepared = this.prepared;
    if (this.halted || this.failed || !this.pushActive || !prepared) return;
    switch (ev.status) {
      case 'running': {
        this.pushStatus = 'running';
        if (this.confirmState === 'none' && prepared.confirm) this.launchConfirm(prepared);
        if (this.confirmState === 'running') {
          this.set({ phase: 'confirming', message: null, ...(ev.stats ? { stats: ev.stats } : {}) });
        } else {
          this.goLive(prepared, ev.stats);
        }
        return;
      }
      case 'retrying':
        this.pushStatus = 'retrying';
        this.set({ phase: 'retrying', message: ev.message ?? 'Relay reconnecting', retries: ev.attempt, stats: null });
        return;
      case 'failed':
        this.pushStatus = 'failed';
        await this.failLive(ev.message ? `Relay failed: ${ev.message}` : 'Relay failed');
        return;
      default:
        // 'starting' / 'stopped' carry no new information for us.
        return;
    }
  }

  private launchConfirm(prepared: PreparedLive): void {
    const ctl = new AbortController();
    this.confirmState = 'running';
    this.confirmCtl = ctl;
    this.confirmTask = awaitBounded((signal) => prepared.confirm!(signal), {
      ms: this.host.timings.confirmTimeoutMs,
      signal: ctl.signal,
      what: 'Going live',
    }).then(
      () => this.enqueue(() => this.onConfirmed(ctl, prepared)),
      (err: unknown) => this.enqueue(() => this.onConfirmFailed(ctl, err)),
    );
  }

  private onConfirmed(ctl: AbortController, prepared: PreparedLive): void {
    if (this.confirmCtl !== ctl) return; // superseded (live ended or runner stopped)
    this.confirmCtl = null;
    this.confirmState = 'done';
    if (this.halted) return;
    if (this.pushActive && this.pushStatus === 'running') this.goLive(prepared);
  }

  private async onConfirmFailed(ctl: AbortController, err: unknown): Promise<void> {
    if (this.confirmCtl !== ctl) return;
    this.confirmCtl = null;
    this.confirmState = 'none';
    if (this.halted) return;
    await this.failLive(`Couldn't go live: ${errorMessage(err)}`);
  }

  private goLive(prepared: PreparedLive, stats?: DestinationState['stats']): void {
    this.set({
      phase: 'live',
      message: null,
      watchUrl: prepared.watchUrl ?? null,
      ...(stats ? { stats } : {}),
    });
    if (prepared.chat && !this.chatCtl) {
      const chatCtl = new AbortController();
      this.chatCtl = chatCtl;
      try {
        this.host.services.chat.attach(this.id, this.dest.platform, (s) => prepared.chat!(s), chatCtl.signal);
      } catch (err) {
        this.host.log.warn({ destinationId: this.id, error: errorMessage(err) }, 'chat attach failed');
      }
    }
  }

  /** Stop the push, end the live, mark the destination as failed (no automatic retry). */
  private async failLive(message: string): Promise<void> {
    await this.endLive();
    if (this.halted) return;
    this.fail(message);
  }

  private fail(message: string): void {
    this.failed = true;
    this.set({ phase: 'error', message, stats: null });
    this.host.notice('error', `${this.dest.name}: ${message}`);
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  private async cleanup(): Promise<void> {
    this.clearTimers();
    if (this.pushActive || this.prepared) this.set({ phase: 'ending', message: null });
    await this.endLive();
  }

  /** Detach chat, abort confirm, stop the push and call prepared.end(). Idempotent. */
  private async endLive(): Promise<void> {
    this.clearGrace();
    this.chatCtl?.abort();
    this.chatCtl = null;
    this.confirmCtl?.abort();
    this.confirmCtl = null;
    this.confirmState = 'none';
    if (this.pushActive) await this.stopPush();
    const prepared = this.prepared;
    this.prepared = null;
    if (prepared) await this.callEnd(prepared, 'end');
  }

  private async stopPush(): Promise<void> {
    this.pushActive = false;
    this.pushStatus = null;
    try {
      await this.host.services.pushes.stop(this.id);
    } catch (err) {
      this.host.log.warn({ destinationId: this.id, error: errorMessage(err) }, 'stopping the relay failed');
    }
  }

  /** Call prepared.end() with a timeout; errors are logged, never thrown. */
  private async callEnd(prepared: PreparedLive, why: string): Promise<void> {
    if (!prepared.end) return;
    try {
      await awaitBounded((signal) => prepared.end!(signal), { ms: this.host.endTimeoutMs(), what: 'Ending the live' });
    } catch (err) {
      this.host.log.warn({ destinationId: this.id, why, error: errorMessage(err) }, 'ending the live failed');
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private enqueue(task: () => void | Promise<void>): Promise<void> {
    return this.queue.run(task).catch((err: unknown) => {
      this.host.log.error({ destinationId: this.id, error: errorMessage(err) }, 'destination runner step failed');
    });
  }

  private requiredOnline(): boolean {
    return this.required.every((f) => this.host.feedOnline(f));
  }

  private waitingMessage(): string {
    const missing = this.required.filter((f) => !this.host.feedOnline(f));
    const feeds = (missing.length > 0 ? missing : this.required).join(' + ');
    return `Waiting for the ${feeds} feed from OBS`;
  }

  private clearGrace(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private clearTimers(): void {
    this.clearGrace();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private set(patch: StatePatch & { phase?: DestinationPhase }): void {
    if (this.finished) return;
    this.host.update(this.id, patch);
  }
}
