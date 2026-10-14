// TikTok driver. TikTok has no public API for going LIVE with a stream key, so the driver runs
// TikTok LIVE Producer (https://livecenter.tiktok.com/producer) in the account's browser:
// set the title, save the LIVE settings, read the new server URL + stream key, push the vertical
// feed, click "Go LIVE", scrape comments and click "End LIVE". It never changes the LIVE topic.
// Stream Guard: TikTok also ends LIVEs (copyright / Community Guidelines) and issues a new key
// per LIVE, so the driver watches the producer page (health.ts) and opts into the runner's
// automatic recovery (PreparedLive.recovery), which builds a fresh LIVE with prepare().
// UI assumptions and sources: selectors.ts.

import type { ConnectPoll, ConnectStart } from '../../../../shared/api.js';
import type { Account, PlatformInfo } from '../../../../shared/types.js';
import { abortable, requireLoggedIn, scrapeChat, withTimeout } from '../../browser/helpers.js';
import {
  DriverError,
  type ChatMessageInput,
  type DriverContext,
  type LiveHealthEvent,
  type PlatformDriver,
  type PreparedLive,
} from '../types.js';
import {
  createHealthTracker,
  createViewerReporter,
  HEALTH_POLL_MS,
  VIEWER_GRACE_MS,
  VIEWERS_HOLD_MS,
  VIEWERS_REPORT_MS,
  watchProducerHealth,
} from './health.js';
import {
  detectState,
  dismissEndedNotices,
  endLive,
  goLive,
  gotoPage,
  hasSessionCookie,
  isDashboard,
  isLiveOnPage,
  loadProducer,
  readIngest,
  readUsername,
  setupLive,
  tryReadIngest,
  type Ingest,
  type ProducerState,
  type ProducerTiming,
} from './producer.js';
import { CHAT_EXTRACT, CHAT_ITEM_SELECTOR, TITLE_MAX, URLS } from './selectors.js';
import {
  accountUsername,
  autoRecoverEnabled,
  DEFAULT_GO_LIVE_TIMEOUT_SEC,
  DEFAULT_TAKEDOWN_CONFIRM_SEC,
  errorText,
  goLiveTimeoutSec,
  hostOf,
  isUnder,
  joinRtmpUrl,
  MAX_GO_LIVE_TIMEOUT_SEC,
  MAX_TAKEDOWN_CONFIRM_SEC,
  MAX_ZERO_VIEWER_SEC,
  MIN_GO_LIVE_TIMEOUT_SEC,
  MIN_TAKEDOWN_CONFIRM_SEC,
  parseOptionalBoolean,
  parseOptionalNumber,
  RECOVERY_MAX_ATTEMPTS,
  sameHost,
  takedownConfirmSec,
  watchUrlFor,
  zeroViewerSec,
} from './util.js';

export interface TiktokDriverOptions {
  urls: { producer: string; login: string; home: string; cookies: string[] };
  timing: ProducerTiming & {
    minGoLiveTimeoutSec: number;
    /** Stream Guard poll interval for health(). */
    healthPollMs: number;
    /** Viewer-rule grace after going LIVE. */
    healthGraceMs: number;
    /** Viewer count reported on every change and at least this often. */
    viewersReportMs: number;
    /** An unreadable viewer count shorter than this keeps the last known count. */
    viewersHoldMs: number;
  };
}

export interface TiktokDriverOverrides {
  urls?: Partial<TiktokDriverOptions['urls']>;
  timing?: Partial<TiktokDriverOptions['timing']>;
}

const DEFAULT_OPTIONS: TiktokDriverOptions = {
  urls: URLS,
  timing: {
    detectMs: 30_000,
    stepMs: 20_000,
    endMs: 20_000,
    settleMs: 2_000,
    typingDelayMs: [40, 120],
    minGoLiveTimeoutSec: MIN_GO_LIVE_TIMEOUT_SEC,
    healthPollMs: HEALTH_POLL_MS,
    healthGraceMs: VIEWER_GRACE_MS,
    viewersReportMs: VIEWERS_REPORT_MS,
    viewersHoldMs: VIEWERS_HOLD_MS,
  },
};

/** Upper bound for end(): the orchestrator gives it 30 s. */
const END_BUDGET_MS = 25_000;

const NOT_ELIGIBLE = "This TikTok account doesn't have LIVE stream key access yet (TikTok requires ~1,000 followers)";
const NOT_ELIGIBLE_UNSURE =
  `${NOT_ELIGIBLE}, or TikTok LIVE Producer looks different than expected. ` +
  'Open LIVE Producer in the browser view (Accounts) to check.';

const TEST_MODE_SKIPPED = 'TikTok has no test mode — skipped while testing';

const CONNECT_INSTRUCTIONS = [
  '1. Log in to TikTok in the browser view below, the same way you normally do (including any code or puzzle TikTok asks for).',
  '2. Wait until your TikTok feed shows, then click "I\'m logged in".',
  'The app saves the browser session encrypted; it never sees or stores your password.',
].join('\n');

export const TIKTOK_INFO: PlatformInfo = {
  id: 'tiktok',
  name: 'TikTok',
  feeds: ['vertical'],
  defaultFeed: 'vertical',
  connectMethod: 'browser',
  accountFields: [],
  destinationFields: [
    {
      key: 'goLiveTimeoutSec',
      label: 'Go-live timeout (seconds)',
      type: 'number',
      target: 'option',
      default: DEFAULT_GO_LIVE_TIMEOUT_SEC,
      help: `How long to wait for TikTok to receive the video before clicking "Go LIVE" (${MIN_GO_LIVE_TIMEOUT_SEC}–${MAX_GO_LIVE_TIMEOUT_SEC} s).`,
    },
    {
      key: 'autoRecover',
      label: 'Auto-recover when TikTok ends the LIVE',
      type: 'boolean',
      target: 'option',
      default: true,
      help:
        'Automatically start a new LIVE when TikTok ends this one (e.g. a copyright or Community Guidelines interruption). ' +
        'Viewers have to rejoin the new LIVE.',
    },
    {
      key: 'takedownConfirmSec',
      label: 'Takedown confirmation (seconds)',
      type: 'number',
      target: 'option',
      default: DEFAULT_TAKEDOWN_CONFIRM_SEC,
      help:
        `Push to TikTok down this long while OBS is still streaming ⇒ treat it as a takedown ` +
        `(${MIN_TAKEDOWN_CONFIRM_SEC}–${MAX_TAKEDOWN_CONFIRM_SEC} s).`,
    },
    {
      key: 'zeroViewerSec',
      label: '0-viewer takedown (seconds)',
      type: 'number',
      target: 'option',
      default: 0,
      help:
        `0 viewers this long ⇒ treat it as a takedown and start a new LIVE (needs auto-recover; checked after the first ` +
        `${VIEWER_GRACE_MS / 1000} s of a LIVE; 0 = off, max ${MAX_ZERO_VIEWER_SEC} s). ` +
        'Leave 0 if your streams sometimes really have no viewers.',
    },
  ],
  developerApp: null,
  titleSupport: 'browser',
  chatSupport: 'browser',
  keyPerSession: true,
  experimental: true,
  notes:
    'Needs TikTok LIVE stream key access (LIVE Producer): TikTok reportedly requires about 1,000 followers, age 18+ ' +
    'and an account in good standing, and availability varies by region. A new stream key is created for every stream. ' +
    `The title (max ${TITLE_MAX} characters) is set before going LIVE and can't be changed during the LIVE. ` +
    'The app never changes the LIVE topic: if TikTok requires one and none is selected, pick it once yourself in LIVE Producer. ' +
    'When TikTok ends a LIVE (e.g. for copyright or Community Guidelines), the app can start a new one automatically; ' +
    'viewers have to rejoin it.',
  testMode: { supported: false, description: TEST_MODE_SKIPPED },
};

/**
 * One prepared LIVE on an account's producer page. Identity matters: a newer LIVE on the same
 * account (a recovery) supersedes it, after which its end()/health()/chat must not touch the page.
 */
interface LiveRef {
  destinationId: string;
  /** When "Go LIVE" succeeded (epoch ms); the viewer-rule grace counts from here. */
  liveSince: number | null;
  /** health() saw TikTok end this LIVE. */
  takenDown: boolean;
}

export function createTiktokDriver(overrides: TiktokDriverOverrides = {}): PlatformDriver {
  const urls = { ...DEFAULT_OPTIONS.urls, ...overrides.urls };
  const timing = { ...DEFAULT_OPTIONS.timing, ...overrides.timing };

  /**
   * accountId → the LIVE using that account's (single) producer page, from prepare() until end().
   * While set, account checks must not navigate the page and another destination can't use the
   * account (it would drive, or end, this destination's LIVE). The same destination may claim it
   * again (a takedown recovery): the new LIVE supersedes the old one.
   */
  const owners = new Map<string, LiveRef>();
  /**
   * Accounts whose last LIVE was ended — by TikTok (health saw a takedown) or by us (end() was called,
   * e.g. by a recovery after the push died). A LIVE the next prepare() finds still running is that
   * stale LIVE: end it and create a fresh one, never reuse its key. (Reuse is only for a LIVE this
   * process never ended, e.g. after an app restart mid-stream.)
   */
  const staleLive = new Map<string, 'takedown' | 'ended'>();
  /** accountId → end() still working on the producer page; prepare() waits for it before touching the page. */
  const pendingEnds = new Map<string, Promise<void>>();

  function claim(accountId: string, live: LiveRef): void {
    const owner = owners.get(accountId);
    if (owner && owner.destinationId !== live.destinationId) {
      throw new DriverError(
        'This TikTok account is already used by another destination. Use one TikTok destination per account.',
        'misconfigured',
      );
    }
    owners.set(accountId, live);
  }

  function release(accountId: string, live: LiveRef): void {
    if (owners.get(accountId) === live) owners.delete(accountId);
  }

  /** A newer LIVE on this account took over the page. */
  function superseded(accountId: string, live: LiveRef): boolean {
    const owner = owners.get(accountId);
    return owner !== undefined && owner !== live;
  }

  async function saveSession(ctx: DriverContext, accountId: string): Promise<void> {
    await ctx.browser.save(accountId).catch((err: unknown) => {
      ctx.log.warn({ err: errorText(err).slice(0, 200) }, 'saving the TikTok browser session failed');
    });
  }

  /** Load LIVE Producer and turn "logged out" / "not eligible" into DriverErrors. */
  async function openProducer(page: Parameters<typeof loadProducer>[0], signal: AbortSignal): Promise<ProducerState> {
    const state = await loadProducer(page, urls.producer, timing, signal, { navigate: true });
    await requireLoggedIn(page, async () => state !== 'login', 'TikTok');
    if (state === 'ineligible') throw new DriverError(NOT_ELIGIBLE, 'not-eligible');
    if (state === 'unknown') throw new DriverError(NOT_ELIGIBLE_UNSURE, 'not-eligible');
    return state;
  }

  async function confirmLive(ctx: DriverContext, accountId: string, live: LiveRef, sec: number, signal: AbortSignal): Promise<void> {
    if (superseded(accountId, live)) throw new DriverError('This TikTok LIVE was replaced by a newer one', 'platform-error');
    const page = await abortable(ctx.browser.page(accountId), signal);
    if (!isUnder(page.url(), urls.producer) && !(await isDashboard(page))) {
      // The page was navigated away (e.g. in the browser view): the prepared LIVE is still there.
      await gotoPage(page, urls.producer, signal);
      await detectState(page, timing.detectMs, signal);
    }
    await goLive(page, sec * 1000, timing, signal, ctx.log);
    live.liveSince = Date.now();
    ctx.log.info('TikTok LIVE started');
    await saveSession(ctx, accountId);
  }

  async function endOnProducer(ctx: DriverContext, accountId: string, live: LiveRef, signal: AbortSignal): Promise<void> {
    const page = await abortable(ctx.browser.page(accountId), signal);
    if (!isUnder(page.url(), urls.producer) && !(await isLiveOnPage(page))) {
      await gotoPage(page, urls.producer, signal);
      await detectState(page, Math.min(timing.detectMs, 15_000), signal);
    }
    // After a takedown TikTok may still show its "LIVE ended" dialog over the dashboard.
    if (live.takenDown) await dismissEndedNotices(page, signal);
    if ((await endLive(page, timing.endMs, signal)) === 'ended') {
      ctx.log.info('TikTok LIVE ended');
      await saveSession(ctx, accountId);
    }
  }

  /**
   * end() of one LIVE: at most END_BUDGET_MS, a no-op once a newer LIVE took over the page, and
   * never a failure when TikTok had already ended the LIVE itself (takedown).
   */
  function endPrepared(ctx: DriverContext, accountId: string, live: LiveRef): Promise<void> {
    if (superseded(accountId, live)) return Promise.resolve();
    if (!staleLive.has(accountId)) staleLive.set(accountId, 'ended');
    const budget = AbortSignal.timeout(END_BUDGET_MS);
    const run = endOnProducer(ctx, accountId, live, budget)
      .catch((err: unknown) => {
        if (live.takenDown) {
          const msg = errorText(err).split('\n', 1)[0]?.slice(0, 200);
          ctx.log.warn({ err: msg }, 'TikTok had already ended the LIVE; ignoring the End LIVE failure');
          return;
        }
        if (budget.aborted) throw new DriverError('Ending the TikTok LIVE timed out', 'timeout');
        throw err;
      })
      .finally(() => {
        release(accountId, live);
        if (pendingEnds.get(accountId) === tracked) pendingEnds.delete(accountId);
      });
    const tracked: Promise<void> = run.catch(() => {});
    pendingEnds.set(accountId, tracked);
    return withTimeout(run, END_BUDGET_MS + 2000, 'Ending the TikTok LIVE timed out');
  }

  function liveHealth(ctx: DriverContext, accountId: string, live: LiveRef, zeroViewerMs: number, signal: AbortSignal) {
    const tracker = createHealthTracker({
      zeroViewerMs,
      graceMs: timing.healthGraceMs,
      liveSince: live.liveSince ?? Date.now(),
    });
    const events = watchProducerHealth(
      {
        getPage: () => abortable(ctx.browser.page(accountId), signal),
        producerUrl: urls.producer,
        pollMs: timing.healthPollMs,
        detectMs: Math.min(timing.detectMs, 15_000),
        tracker,
        viewers: createViewerReporter(timing.viewersReportMs, timing.viewersHoldMs),
        isCurrent: () => !superseded(accountId, live) && !live.takenDown,
        log: ctx.log,
      },
      signal,
    );
    return (async function* (): AsyncGenerator<LiveHealthEvent> {
      for await (const event of events) {
        if (event.type === 'ended') {
          live.takenDown = true;
          staleLive.set(accountId, 'takedown');
          ctx.log.warn({ reason: event.reason }, 'TikTok ended the LIVE');
        } else if (event.type === 'warning') {
          ctx.log.info({ message: event.message }, 'TikTok LIVE health warning');
        }
        yield event;
      }
    })();
  }

  async function* producerChat(ctx: DriverContext, accountId: string, signal: AbortSignal): AsyncGenerator<ChatMessageInput> {
    let page;
    try {
      page = await abortable(ctx.browser.page(accountId), signal);
      // A fresh page (the old one was closed): reopen the producer, which shows the comments.
      if (page.url() === 'about:blank') await gotoPage(page, urls.producer, signal);
    } catch (err) {
      if (signal.aborted) return;
      throw err;
    }
    yield* scrapeChat(page, { itemSelector: CHAT_ITEM_SELECTOR, extract: CHAT_EXTRACT, pollMs: 1000 }, signal);
  }

  return {
    info: TIKTOK_INFO,

    async startConnect(account: Account): Promise<ConnectStart> {
      // The login view uses the same page as the LIVE. Not 'misconfigured': the UI reads that as a missing developer app.
      if (owners.has(account.id)) {
        throw new DriverError('This TikTok account is live right now. Stop the live before logging in again.', 'platform-error');
      }
      return { method: 'browser', startUrl: urls.login, instructions: CONNECT_INSTRUCTIONS };
    },

    async completeConnect(account: Account, _input, ctx): Promise<ConnectPoll> {
      const context = await abortable(ctx.browser.context(account.id), ctx.signal);
      if (!(await hasSessionCookie(context, urls.cookies))) {
        // Clicked "I'm logged in" too early: the login is still in progress.
        return { status: 'pending', message: 'TikTok isn\'t logged in yet. Log in in the browser view, then click "I\'m logged in".' };
      }
      // Live right now: don't touch the producer page.
      if (owners.has(account.id)) return { status: 'connected', account: { ...account, status: 'connected', statusMessage: null } };
      const page = await abortable(ctx.browser.page(account.id), ctx.signal);
      let username = isUnder(page.url(), urls.home) ? await readUsername(page) : null;
      if (!username) {
        try {
          await gotoPage(page, urls.home, ctx.signal);
          username = await readUsername(page);
        } catch (err) {
          ctx.signal.throwIfAborted();
          ctx.log.warn({ err: errorText(err).slice(0, 200) }, 'could not read the TikTok username');
        }
      }
      await saveSession(ctx, account.id);
      const patch = {
        label: username ? `@${username}` : account.label,
        status: 'connected' as const,
        statusMessage: null,
        options: username ? { ...account.options, username } : account.options,
      };
      await ctx.updateAccount(patch);
      return { status: 'connected', account: { ...account, ...patch } };
    },

    async checkAccount(account, ctx) {
      const context = await abortable(ctx.browser.context(account.id), ctx.signal);
      if (!(await hasSessionCookie(context, urls.cookies))) {
        return { status: 'needs-login', message: 'Not logged in to TikTok. Connect the account again.' };
      }
      // A destination is using the producer page (preparing, going live or live): cookie check only.
      const username = accountUsername(account);
      const label = username ? { label: `@${username}` } : {};
      if (owners.has(account.id)) return { status: 'connected', ...label };
      const page = await abortable(ctx.browser.page(account.id), ctx.signal);
      // Never reload a producer page that is running a LIVE right now.
      const navigate = !(sameHost(page.url(), urls.producer) && (await isLiveOnPage(page)));
      const state = await loadProducer(page, urls.producer, timing, ctx.signal, { navigate });
      switch (state) {
        case 'login':
          return { status: 'needs-login', message: 'TikTok session expired — log in again from Accounts' };
        case 'ineligible':
          return { status: 'error', message: "Logged in, but this account doesn't have LIVE stream key access", ...label };
        case 'unknown':
          return {
            status: 'error',
            message:
              "Logged in, but TikTok LIVE Producer didn't show the stream key controls: this account probably doesn't have LIVE stream key access",
            ...label,
          };
        default:
          await saveSession(ctx, account.id);
          return { status: 'connected', ...label };
      }
    },

    async validateDestination(dest) {
      const problems: string[] = [];
      if (dest.feed !== 'vertical') problems.push('TikTok only accepts the vertical feed');
      if (Number.isNaN(parseOptionalNumber(dest.options.goLiveTimeoutSec))) problems.push('Go-live timeout must be a number of seconds');
      if (parseOptionalBoolean(dest.options.autoRecover) === 'invalid') problems.push('Auto-recover must be on or off');
      if (Number.isNaN(parseOptionalNumber(dest.options.takedownConfirmSec))) {
        problems.push('Takedown confirmation must be a number of seconds');
      }
      if (Number.isNaN(parseOptionalNumber(dest.options.zeroViewerSec))) problems.push('0-viewer takedown must be a number of seconds');
      return problems;
    },

    async prepare(dest, account, title, ctx): Promise<PreparedLive> {
      // The orchestrator skips TikTok in test mode; never create a public LIVE if a destination gets here anyway.
      if (ctx.testMode) throw new DriverError(TEST_MODE_SKIPPED, 'not-eligible');
      if (!account) throw new DriverError('Choose a connected TikTok account for this destination', 'not-connected');
      const { signal, log } = ctx;
      const accountId = account.id;
      const live: LiveRef = { destinationId: dest.id, liveSince: null, takenDown: false };
      // Before touching the page: another destination's LIVE (or its key) must never be reused or ended.
      claim(accountId, live);

      let ingest: Ingest | null = null;
      try {
        // A previous LIVE's end() (e.g. the one TikTok just killed) may still be using the page.
        const pendingEnd = pendingEnds.get(accountId);
        if (pendingEnd) await abortable(pendingEnd, signal);

        const context = await abortable(ctx.browser.context(accountId), signal);
        if (!(await hasSessionCookie(context, urls.cookies))) {
          throw new DriverError('TikTok session expired — log in again from Accounts', 'needs-login');
        }
        const page = await abortable(ctx.browser.page(accountId), signal);
        let state = await openProducer(page, signal);

        if (state === 'live') {
          // A LIVE is already running. After a takedown (or an end() that didn't take) it is the stale
          // LIVE: never reuse it. Otherwise (e.g. the app restarted mid-stream) reuse it when its key is readable.
          const stale = staleLive.get(accountId);
          ingest = stale ? null : await tryReadIngest(page, 5000, signal, log);
          if (ingest) {
            log.info('A TikTok LIVE is already running; reusing it (its title is kept)');
          } else {
            log.warn(
              stale === 'takedown'
                ? 'Ending the TikTok LIVE that TikTok interrupted'
                : stale === 'ended'
                  ? 'Ending the previous TikTok LIVE (still shown as running)'
                  : 'Ending a TikTok LIVE left over from an earlier session',
            );
            await endLive(page, timing.endMs, signal);
            state = await openProducer(page, signal);
            if (state === 'live') {
              throw new DriverError('A TikTok LIVE is still running and could not be ended. End it in TikTok LIVE Producer, then retry.');
            }
          }
        }
        if (!ingest) {
          await setupLive(page, state, title, timing, signal, log);
          ingest = await readIngest(page, timing.stepMs, signal, log);
        }
      } catch (err) {
        release(accountId, live);
        throw err;
      }
      staleLive.delete(accountId);
      await saveSession(ctx, accountId);
      log.info({ server: hostOf(ingest.serverUrl) }, 'TikTok LIVE prepared');

      const goLiveSec = goLiveTimeoutSec(dest, timing.minGoLiveTimeoutSec);
      const autoRecover = autoRecoverEnabled(dest);
      // The 0-viewer rule starts a new LIVE, so it only applies with auto-recover.
      const zeroViewerMs = autoRecover ? zeroViewerSec(dest) * 1000 : 0;
      let ending: Promise<void> | null = null;
      const prepared: PreparedLive = {
        push: { url: joinRtmpUrl(ingest.serverUrl, ingest.streamKey), mode: 'copy', feeds: ['vertical'] },
        watchUrl: watchUrlFor(accountUsername(account)),
        confirm: (s) => confirmLive(ctx, accountId, live, goLiveSec, s),
        end: () => (ending ??= endPrepared(ctx, accountId, live)),
        chat: (s) => producerChat(ctx, accountId, s),
        health: (s) => liveHealth(ctx, accountId, live, zeroViewerMs, s),
      };
      if (autoRecover) {
        prepared.recovery = { pushDownConfirmMs: takedownConfirmSec(dest) * 1000, maxAttempts: RECOVERY_MAX_ATTEMPTS };
      }
      return prepared;
    },
  };
}

export const tiktokDriver: PlatformDriver = createTiktokDriver();
