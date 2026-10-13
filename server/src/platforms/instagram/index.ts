// Instagram driver: browser automation of instagram.com's desktop live flow (Live Producer).
// Instagram has no public live API; every live gets a new stream URL + key, the title is set when
// the live is created, and "Go live" is clicked once Instagram shows our preview.
// Flow details and sources: selectors.ts.

import type { Logger } from 'pino';
import type { Page } from 'playwright';
import type { ConnectPoll, ConnectStart } from '../../../../shared/api.js';
import type { Account, Destination, PlatformInfo } from '../../../../shared/types.js';
import { requireLoggedIn } from '../../browser/helpers.js';
import { DriverError, type DriverContext, type PlatformDriver, type PreparedLive } from '../types.js';
import { DEFAULT_CHAT_TIMINGS, instagramChat, type ChatTimings } from './chat.js';
import {
  checkpointError,
  DEFAULT_TIMEOUTS,
  dismissInterstitials,
  endLive,
  fillSetup,
  goLive,
  hasSessionCookie,
  isLoggedIn,
  openLiveSetup,
  readStreamDetails,
  readUsername,
  type FlowConfig,
  type FlowTimeouts,
  type StreamDetails,
} from './flow.js';
import { IG_ORIGIN, LOGIN_PATH } from './selectors.js';
import {
  DEFAULT_GO_LIVE_TIMEOUT_SEC,
  joinStreamUrl,
  MAX_GO_LIVE_TIMEOUT_SEC,
  MIN_GO_LIVE_TIMEOUT_SEC,
  optionProblems,
  readOptions,
  shortError,
  type InstagramOptions,
} from './util.js';

export const instagramInfo: PlatformInfo = {
  id: 'instagram',
  name: 'Instagram',
  feeds: ['vertical'],
  defaultFeed: 'vertical',
  connectMethod: 'browser',
  accountFields: [],
  destinationFields: [
    {
      key: 'audience',
      label: 'Audience',
      type: 'select',
      target: 'option',
      default: 'public',
      options: [
        { value: 'public', label: 'Public' },
        { value: 'practice', label: 'Practice (only you)' },
      ],
      help: 'Practice = only you can see it — use it to test',
    },
    {
      key: 'goLiveTimeoutSec',
      label: 'Go-live timeout (seconds)',
      type: 'number',
      target: 'option',
      default: DEFAULT_GO_LIVE_TIMEOUT_SEC,
      help: `How long to wait for Instagram to receive the video before giving up (${MIN_GO_LIVE_TIMEOUT_SEC}–${MAX_GO_LIVE_TIMEOUT_SEC} s).`,
    },
  ],
  developerApp: null,
  titleSupport: 'browser',
  chatSupport: 'browser',
  keyPerSession: true,
  experimental: true,
  notes:
    'The account must be allowed to go live from instagram.com on a computer: a public professional account with at least ' +
    '1,000 followers, in good standing. Every live gets a new stream key. The title is set when the live is created and ' +
    "can't be changed during it. Use one Instagram destination per account. Browser automation may break when Instagram " +
    'changes its site.',
};

const NOT_LOGGED_IN =
  'Not logged in to Instagram yet. Log in in the browser view (including any 2FA or security check), then click "I\'m logged in".';
const SESSION_EXPIRED = 'Instagram session expired — log in again from Accounts';

export interface InstagramDriverOptions {
  /** Default https://www.instagram.com (tests use a local fixture server). */
  baseUrl?: string;
  timeouts?: Partial<FlowTimeouts>;
  chat?: Partial<ChatTimings>;
}

function isAbortLike(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return err instanceof Error && err.name === 'AbortError';
}

/** Playwright/unknown errors → DriverError with a short, URL-free message. */
function toDriverError(err: unknown, what: string, signal?: AbortSignal): unknown {
  if (err instanceof DriverError || isAbortLike(err, signal)) return err;
  return new DriverError(`${what}: ${shortError(err)}`, 'platform-error');
}

export function createInstagramDriver(opts: InstagramDriverOptions = {}): PlatformDriver {
  const baseUrl = (opts.baseUrl ?? IG_ORIGIN).replace(/\/+$/, '');
  const home = `${baseUrl}/`;
  const cfg: FlowConfig = { baseUrl, timeouts: { ...DEFAULT_TIMEOUTS, ...opts.timeouts } };
  const chatTimings: ChatTimings = { ...DEFAULT_CHAT_TIMINGS, ...opts.chat };

  /**
   * accountId → destinationId of the live using that account's (single) browser page. While set,
   * account checks must not navigate the page and another destination can't use the account.
   */
  const busy = new Map<string, string>();

  async function saveSession(ctx: DriverContext, accountId: string, log: Logger): Promise<void> {
    try {
      await ctx.browser.save(accountId);
    } catch (err) {
      log.warn({ error: shortError(err) }, 'saving the Instagram browser session failed');
    }
  }

  /** Cookie-only check, for when the page is busy with a live and must not navigate. */
  async function cookieCheck(account: Account, ctx: DriverContext): Promise<boolean> {
    return hasSessionCookie(await ctx.browser.context(account.id), baseUrl);
  }

  async function markNeedsLogin(ctx: DriverContext, message: string): Promise<void> {
    await ctx.updateAccount({ status: 'needs-login', statusMessage: message }).catch(() => {});
  }

  function prepared(
    page: Page,
    dest: Destination,
    account: Account,
    details: StreamDetails,
    options: InstagramOptions,
    username: string | null,
    ctx: DriverContext,
    log: Logger,
  ): PreparedLive {
    let ending: Promise<void> | null = null;
    return {
      push: { url: joinStreamUrl(details.server, details.key), mode: 'copy', feeds: ['vertical'] },
      watchUrl: options.audience === 'public' && username ? `${baseUrl}/${username}/live/` : null,

      async confirm(signal) {
        try {
          await goLive(page, options.goLiveTimeoutSec * 1000, cfg, signal);
        } catch (err) {
          throw toDriverError(err, 'Instagram automation failed', signal); // the runner prefixes "Couldn't go live"
        }
        log.info({ audience: options.audience }, 'Instagram live started');
        await saveSession(ctx, account.id, log);
      },

      end() {
        ending ??= (async () => {
          try {
            const result = await endLive(page, cfg);
            log.info({ result }, 'Instagram live ended');
          } catch (err) {
            log.warn({ error: shortError(err) }, 'ending the Instagram live failed; leaving the live page');
          }
          try {
            // Leaving the producer also abandons a live that was never started.
            if (!page.isClosed()) {
              await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 8_000 }).catch(() => {});
              await saveSession(ctx, account.id, log);
            }
          } finally {
            if (busy.get(account.id) === dest.id) busy.delete(account.id);
          }
        })();
        return ending;
      },

      chat: (signal) => instagramChat(page, signal, log, chatTimings),
    };
  }

  return {
    info: instagramInfo,

    async startConnect(account): Promise<ConnectStart> {
      if (busy.has(account.id)) {
        // Not 'misconfigured': the UI reads that code as a missing developer app.
        throw new DriverError('This Instagram account is live right now. Stop the live before logging in again.', 'platform-error');
      }
      return {
        method: 'browser',
        startUrl: `${baseUrl}${LOGIN_PATH}`,
        instructions: 'Log in to Instagram in the window below (including 2FA), then click "I\'m logged in".',
      };
    },

    async completeConnect(account, _input, ctx): Promise<ConnectPoll> {
      const log = ctx.log.child({ platform: 'instagram', accountId: account.id });
      try {
        if (busy.has(account.id)) {
          return (await cookieCheck(account, ctx))
            ? { status: 'connected', account: { ...account, status: 'connected', statusMessage: null } }
            : { status: 'error', message: NOT_LOGGED_IN };
        }
        // Clicked "I'm logged in" before the login (or Instagram's check) is finished: still pending.
        const page = await ctx.browser.page(account.id); // the login view's page, as the user left it
        if (!(await hasSessionCookie(page.context(), baseUrl))) return { status: 'pending', message: NOT_LOGGED_IN };
        const checkpoint = checkpointError(page.url());
        if (checkpoint) return { status: 'pending', message: checkpoint.message };

        let path = '';
        try {
          path = new URL(page.url()).pathname;
        } catch {
          // about:blank etc.
        }
        if (!page.url().startsWith(baseUrl) || path !== '/') {
          await page.goto(home, { waitUntil: 'domcontentloaded' });
        }
        if (!(await isLoggedIn(page, cfg, ctx.signal))) return { status: 'pending', message: NOT_LOGGED_IN };
        await dismissInterstitials(page, ctx.signal);

        const username = await readUsername(page);
        const label = username ? `@${username}` : account.label;
        await ctx.updateAccount({ label, status: 'connected', statusMessage: null });
        await saveSession(ctx, account.id, log);
        log.info('Instagram account connected');
        return { status: 'connected', account: { ...account, label, status: 'connected', statusMessage: null } };
      } catch (err) {
        if (isAbortLike(err, ctx.signal)) return { status: 'error', message: 'Checking the Instagram login took too long. Try again.' };
        const e = toDriverError(err, "Couldn't check the Instagram login");
        return { status: 'error', message: e instanceof Error ? e.message : NOT_LOGGED_IN };
      }
    },

    async checkAccount(account, ctx) {
      const log = ctx.log.child({ platform: 'instagram', accountId: account.id });
      if (busy.has(account.id)) {
        // Live right now: don't touch the page.
        return (await cookieCheck(account, ctx)) ? { status: 'connected' } : { status: 'needs-login', message: SESSION_EXPIRED };
      }
      try {
        const page = await ctx.browser.page(account.id, home);
        let loggedIn: boolean;
        try {
          loggedIn = await isLoggedIn(page, cfg, ctx.signal);
        } catch (err) {
          if (err instanceof DriverError && err.code === 'needs-login') return { status: 'needs-login', message: err.message };
          throw err;
        }
        if (!loggedIn) return { status: 'needs-login', message: SESSION_EXPIRED };
        await dismissInterstitials(page, ctx.signal);
        const username = await readUsername(page);
        const label = username ? `@${username}` : undefined;
        await ctx.updateAccount({ ...(label ? { label } : {}), status: 'connected', statusMessage: null });
        await saveSession(ctx, account.id, log);
        return label ? { status: 'connected', label } : { status: 'connected' };
      } catch (err) {
        throw toDriverError(err, "Couldn't check the Instagram account", ctx.signal);
      }
    },

    async validateDestination(dest) {
      const problems = optionProblems(dest);
      if (!dest.accountId) problems.push('Choose the Instagram account to stream to');
      if (dest.feed !== 'vertical') problems.push('Instagram only accepts the vertical feed');
      return problems;
    },

    async prepare(dest, account, title, ctx) {
      if (!account) throw new DriverError('Connect an Instagram account for this destination in Accounts', 'not-connected');
      const owner = busy.get(account.id);
      if (owner && owner !== dest.id) {
        throw new DriverError(
          'This Instagram account is already live from another destination. Use one Instagram destination per account.',
          'misconfigured',
        );
      }
      busy.set(account.id, dest.id);

      const log = ctx.log.child({ platform: 'instagram', destinationId: dest.id });
      const options = readOptions(dest);
      const { signal } = ctx;
      let page: Page | null = null;
      let setupOpened = false;
      try {
        page = await ctx.browser.page(account.id, home);
        const p = page;
        await requireLoggedIn(p, () => isLoggedIn(p, cfg, signal), 'Instagram');
        const username = await readUsername(p);

        setupOpened = true;
        await openLiveSetup(p, cfg, signal); // dismisses prompts / the cookie banner first
        await fillSetup(p, { title, audience: options.audience }, cfg, signal, log);
        const details = await readStreamDetails(p, cfg, signal);
        log.info({ audience: options.audience }, 'Instagram live created; stream URL and key read');
        await saveSession(ctx, account.id, log);
        return prepared(p, dest, account, details, options, username, ctx, log);
      } catch (err) {
        if (busy.get(account.id) === dest.id) busy.delete(account.id);
        if (err instanceof DriverError && err.code === 'needs-login') await markNeedsLogin(ctx, err.message);
        // Don't leave a half-created live behind (leaving the producer abandons it).
        if (setupOpened && page && !page.isClosed()) void page.goto(home, { waitUntil: 'domcontentloaded' }).catch(() => {});
        throw toDriverError(err, 'Instagram automation failed', signal);
      }
    },
  };
}

export const instagramDriver: PlatformDriver = createInstagramDriver();
