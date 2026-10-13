// TikTok driver. TikTok has no public API for going LIVE with a stream key, so the driver runs
// TikTok LIVE Producer (https://livecenter.tiktok.com/producer) in the account's browser:
// set the title, save the LIVE settings, read the new server URL + stream key, push the vertical
// feed, click "Go LIVE", scrape comments and click "End LIVE". It never changes the LIVE topic.
// UI assumptions and sources: selectors.ts.

import type { ConnectPoll, ConnectStart } from '../../../../shared/api.js';
import type { Account, PlatformInfo } from '../../../../shared/types.js';
import { abortable, requireLoggedIn, scrapeChat, withTimeout } from '../../browser/helpers.js';
import { DriverError, type ChatMessageInput, type DriverContext, type PlatformDriver, type PreparedLive } from '../types.js';
import {
  detectState,
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
  DEFAULT_GO_LIVE_TIMEOUT_SEC,
  errorText,
  goLiveTimeoutSec,
  hostOf,
  isUnder,
  joinRtmpUrl,
  MAX_GO_LIVE_TIMEOUT_SEC,
  MIN_GO_LIVE_TIMEOUT_SEC,
  parseOptionalNumber,
  sameHost,
  watchUrlFor,
} from './util.js';

export interface TiktokDriverOptions {
  urls: { producer: string; login: string; home: string; cookies: string[] };
  timing: ProducerTiming & { minGoLiveTimeoutSec: number };
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
  },
};

/** Upper bound for end(): the orchestrator gives it 30 s. */
const END_BUDGET_MS = 25_000;

const NOT_ELIGIBLE = "This TikTok account doesn't have LIVE stream key access yet (TikTok requires ~1,000 followers)";
const NOT_ELIGIBLE_UNSURE =
  `${NOT_ELIGIBLE}, or TikTok LIVE Producer looks different than expected. ` +
  'Open LIVE Producer in the browser view (Accounts) to check.';

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
    'The app never changes the LIVE topic: if TikTok requires one and none is selected, pick it once yourself in LIVE Producer.',
};

export function createTiktokDriver(overrides: TiktokDriverOverrides = {}): PlatformDriver {
  const urls = { ...DEFAULT_OPTIONS.urls, ...overrides.urls };
  const timing = { ...DEFAULT_OPTIONS.timing, ...overrides.timing };

  /**
   * accountId → destinationId of the LIVE using that account's (single) producer page, from
   * prepare() until end(). While set, account checks must not navigate the page and another
   * destination can't use the account (it would drive, or end, this destination's LIVE).
   */
  const owners = new Map<string, string>();

  function claim(accountId: string, destinationId: string): void {
    const owner = owners.get(accountId);
    if (owner && owner !== destinationId) {
      throw new DriverError(
        'This TikTok account is already used by another destination. Use one TikTok destination per account.',
        'misconfigured',
      );
    }
    owners.set(accountId, destinationId);
  }

  function release(accountId: string, destinationId: string): void {
    if (owners.get(accountId) === destinationId) owners.delete(accountId);
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

  async function confirmLive(ctx: DriverContext, accountId: string, sec: number, signal: AbortSignal): Promise<void> {
    const page = await abortable(ctx.browser.page(accountId), signal);
    if (!isUnder(page.url(), urls.producer) && !(await isDashboard(page))) {
      // The page was navigated away (e.g. in the browser view): the prepared LIVE is still there.
      await gotoPage(page, urls.producer, signal);
      await detectState(page, timing.detectMs, signal);
    }
    await goLive(page, sec * 1000, timing, signal, ctx.log);
    ctx.log.info('TikTok LIVE started');
    await saveSession(ctx, accountId);
  }

  async function endOnProducer(ctx: DriverContext, accountId: string): Promise<void> {
    const page = await ctx.browser.page(accountId);
    if (!isUnder(page.url(), urls.producer) && !(await isLiveOnPage(page))) {
      const signal = AbortSignal.timeout(timing.endMs);
      await gotoPage(page, urls.producer, signal);
      await detectState(page, Math.min(timing.detectMs, 15_000), signal);
    }
    if ((await endLive(page, timing.endMs)) === 'ended') {
      ctx.log.info('TikTok LIVE ended');
      await saveSession(ctx, accountId);
    }
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
      return problems;
    },

    async prepare(dest, account, title, ctx): Promise<PreparedLive> {
      if (!account) throw new DriverError('Choose a connected TikTok account for this destination', 'not-connected');
      const { signal, log } = ctx;
      const accountId = account.id;
      // Before touching the page: another destination's LIVE (or its key) must never be reused or ended.
      claim(accountId, dest.id);

      let ingest: Ingest | null = null;
      try {
        const context = await abortable(ctx.browser.context(accountId), signal);
        if (!(await hasSessionCookie(context, urls.cookies))) {
          throw new DriverError('TikTok session expired — log in again from Accounts', 'needs-login');
        }
        const page = await abortable(ctx.browser.page(accountId), signal);
        let state = await openProducer(page, signal);

        if (state === 'live') {
          // A LIVE is already running (e.g. the app restarted mid-stream): reuse it when its key is readable.
          ingest = await tryReadIngest(page, 5000, signal, log);
          if (ingest) {
            log.info('A TikTok LIVE is already running; reusing it (its title is kept)');
          } else {
            log.warn('Ending a TikTok LIVE left over from an earlier session');
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
        release(accountId, dest.id);
        throw err;
      }
      await saveSession(ctx, accountId);
      log.info({ server: hostOf(ingest.serverUrl) }, 'TikTok LIVE prepared');

      const goLiveSec = goLiveTimeoutSec(dest, timing.minGoLiveTimeoutSec);
      let ending: Promise<void> | null = null;
      return {
        push: { url: joinRtmpUrl(ingest.serverUrl, ingest.streamKey), mode: 'copy', feeds: ['vertical'] },
        watchUrl: watchUrlFor(accountUsername(account)),
        confirm: (s) => confirmLive(ctx, accountId, goLiveSec, s),
        end: () =>
          (ending ??= withTimeout(endOnProducer(ctx, accountId), END_BUDGET_MS, 'Ending the TikTok LIVE timed out').finally(() =>
            release(accountId, dest.id),
          )),
        chat: (s) => producerChat(ctx, accountId, s),
      };
    },
  };
}

export const tiktokDriver: PlatformDriver = createTiktokDriver();
