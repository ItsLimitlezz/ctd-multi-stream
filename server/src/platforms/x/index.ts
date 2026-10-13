// X (Twitter) via Live Studio — EXPERIMENTAL browser automation.
//
// Video goes to a reusable Live Studio "source" (RTMPS URL + stream key pasted once). Streaming to
// a source does not go live by itself: a livestream must be created with a title and "Go live"
// pressed (https://help.x.com/en/using-x/live-studio). With a linked account (browser login) this
// driver does that in confirm(), edits the title while live, ends the livestream and scrapes chat
// from x.com/i/broadcasts/<id>. Without one it only pushes video. See selectors.ts for sources.

import type { Cookie, Page } from 'playwright';
import type { Account, Destination, PlatformInfo } from '../../../../shared/types.js';
import { joinIngestUrl, rtmpUrlProblem, safeHost, streamKeyProblem } from '../custom/url.js';
import { DriverError, type DriverContext, type PlatformDriver, type PreparedLive, type PushPlan } from '../types.js';
import { XLive } from './live.js';
import { AUTH_COOKIE, X_URLS, type XUrls } from './selectors.js';
import { DEFAULT_TIMINGS, openStudio, readHandle, SESSION_EXPIRED, type FlowOptions, type XTimings } from './studio.js';

export interface XDriverOptions {
  urls?: Partial<XUrls>;
  timings?: Partial<XTimings>;
}

const info: PlatformInfo = {
  id: 'x',
  name: 'X',
  feeds: ['landscape', 'vertical'],
  defaultFeed: 'landscape',
  connectMethod: 'browser',
  accountFields: [],
  destinationFields: [
    {
      key: 'ingestUrl',
      label: 'Source URL',
      type: 'url',
      target: 'ingestUrl',
      required: true,
      placeholder: 'rtmps://de.pscp.tv:443/x',
      help: 'RTMPS URL of your Live Studio source (x.com/i/live-studio → Sources), e.g. rtmps://<region>.pscp.tv:443/x',
    },
    {
      key: 'streamKey',
      label: 'Stream key',
      type: 'secret',
      target: 'streamKey',
      required: true,
      help: 'Stream key of the same source. Sources are reusable, so this is pasted once.',
    },
    {
      key: 'autoGoLive',
      label: 'Go live automatically',
      type: 'boolean',
      default: true,
      help:
        'Needs a linked X account: creates the livestream in Live Studio with the session title and presses "Go live" ' +
        'once X receives video (experimental). Turn off to go live yourself, e.g. with a scheduled livestream set to Auto-start.',
    },
    {
      key: 'sourceName',
      label: 'Live Studio source name',
      type: 'text',
      required: false,
      placeholder: 'OBS',
      help: 'Name of this source in Live Studio, so the right one is picked for the livestream. Leave empty to keep the one Live Studio preselects.',
    },
  ],
  developerApp: null,
  titleSupport: 'browser',
  chatSupport: 'browser',
  keyPerSession: false,
  experimental: true,
  notes:
    'Needs X Premium and Live Studio, which is only available in some regions; your posts must not be protected. ' +
    'Create a source once in Live Studio and paste its URL and key. Streaming alone does not go live on X: with a linked ' +
    'account the app creates the livestream and presses "Go live" (experimental browser automation; chat and live title ' +
    'edits need it too). Without one, press "Go live" in Live Studio yourself. Vertical video is untested on X.',
};

/** True when the cookies contain a live X session (`auth_token`). */
export function hasAuthCookie(cookies: readonly Pick<Cookie, 'name' | 'value' | 'expires'>[], nowSec = Date.now() / 1000): boolean {
  return cookies.some((c) => c.name === AUTH_COOKIE && c.value !== '' && (c.expires === -1 || c.expires > nowSec));
}

function errorText(err: unknown): string {
  return ((err instanceof Error ? err.message : String(err)).split('\n', 1)[0] ?? '').slice(0, 300);
}

async function readKey(ctx: DriverContext): Promise<string> {
  return ((await ctx.destinationSecrets?.get('streamKey')) ?? '').trim();
}

async function destinationProblems(dest: Destination, ctx: DriverContext): Promise<string[]> {
  const out: string[] = [];
  const urlProblem = rtmpUrlProblem(dest.ingestUrl, 'Source URL');
  if (urlProblem) out.push(urlProblem);
  const key = await readKey(ctx);
  const keyProblem = key ? streamKeyProblem(key) : 'Stream key is missing';
  if (keyProblem) out.push(keyProblem);
  return out;
}

function optionString(dest: Destination, key: string): string {
  const v = dest.options[key];
  return typeof v === 'string' ? v.trim() : '';
}

export function createXDriver(opts: XDriverOptions = {}): PlatformDriver {
  const urls: XUrls = { ...X_URLS, ...opts.urls };
  const timings: XTimings = { ...DEFAULT_TIMINGS, ...opts.timings };

  const flow = (ctx: DriverContext, signal: AbortSignal = ctx.signal): FlowOptions => ({ urls, timings, signal, log: ctx.log });

  async function hasSession(accountId: string, ctx: DriverContext): Promise<boolean> {
    const context = await ctx.browser.context(accountId);
    return hasAuthCookie(await context.cookies(urls.cookieOrigin));
  }

  /** Run `fn` on a fresh tab of the account's browser (closed afterwards). */
  async function withPage<T>(accountId: string, ctx: DriverContext, fn: (page: Page) => Promise<T>): Promise<T> {
    const page = await (await ctx.browser.context(accountId)).newPage();
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => {});
    }
  }

  return {
    info,

    async startConnect() {
      return {
        method: 'browser',
        startUrl: urls.login,
        instructions:
          'Log in to X in the browser below (including 2FA if asked), then click "I\'m logged in". ' +
          'The password is never stored; only the browser session is kept (encrypted).',
      };
    },

    async completeConnect(account, _input, ctx) {
      // Clicked too early: not a failure, the login is still in progress.
      if (!(await hasSession(account.id, ctx))) {
        return {
          status: 'pending',
          message: 'Not logged in to X yet. Log in in the browser window first, then click "I\'m logged in" again.',
        };
      }
      let handle: string | null = null;
      try {
        handle = await withPage(account.id, ctx, (page) => readHandle(page, flow(ctx)));
      } catch (err) {
        if (err instanceof DriverError && err.code === 'needs-login') {
          return { status: 'pending', message: 'X still shows the login page. Finish logging in, then try again.' };
        }
        ctx.log.warn({ error: errorText(err) }, 'reading the X handle failed; connecting without it');
      }
      try {
        await ctx.browser.save(account.id);
      } catch (err) {
        ctx.log.warn({ error: errorText(err) }, 'saving the X browser session failed');
        return { status: 'error', message: 'Logged in, but saving the browser session failed. Click "I\'m logged in" again.' };
      }
      const label = handle ? `@${handle}` : account.label;
      const options = handle ? { ...account.options, handle } : account.options;
      await ctx.updateAccount({ label, status: 'connected', statusMessage: null, options });
      const connected: Account = { ...account, label, status: 'connected', statusMessage: null, options };
      return { status: 'connected', account: connected };
    },

    async checkAccount(account, ctx) {
      if (!(await hasSession(account.id, ctx))) return { status: 'needs-login', message: SESSION_EXPIRED };
      try {
        return await withPage(account.id, ctx, async (page) => {
          const handle = await readHandle(page, flow(ctx));
          let message: string | undefined;
          try {
            await openStudio(page, flow(ctx));
          } catch (err) {
            if (err instanceof DriverError && err.code === 'needs-login') throw err;
            message =
              err instanceof DriverError && err.code === 'not-eligible'
                ? err.message
                : `Logged in, but X Live Studio could not be checked: ${errorText(err)}`;
          }
          await ctx.browser.save(account.id);
          return { status: 'connected' as const, ...(handle ? { label: `@${handle}` } : {}), ...(message ? { message } : {}) };
        });
      } catch (err) {
        if (err instanceof DriverError && err.code === 'needs-login') return { status: 'needs-login', message: SESSION_EXPIRED };
        throw new DriverError(`Couldn't check the X session: ${errorText(err)}`, 'platform-error');
      }
    },

    async validateDestination(dest, _account, ctx) {
      return destinationProblems(dest, ctx);
    },

    async prepare(dest, account, title, ctx): Promise<PreparedLive> {
      const problems = await destinationProblems(dest, ctx);
      if (problems.length > 0) throw new DriverError(`${problems.join('; ')}. Edit the destination.`, 'misconfigured');
      const push: PushPlan = { url: joinIngestUrl(dest.ingestUrl!, await readKey(ctx)), mode: 'copy', feeds: [dest.feed] };

      if (!account || dest.options.autoGoLive === false) {
        ctx.log.info(
          { server: safeHost(push.url), linked: account !== null },
          'X destination ready; the livestream must be started in Live Studio',
        );
        return { push };
      }
      if (!(await hasSession(account.id, ctx))) {
        await ctx.updateAccount({ status: 'needs-login', statusMessage: SESSION_EXPIRED }).catch(() => {});
        throw new DriverError(
          `${SESSION_EXPIRED} (or turn off "Go live automatically" for this destination and go live in Live Studio yourself)`,
          'needs-login',
        );
      }
      ctx.log.info({ server: safeHost(push.url) }, 'X destination ready; will go live from Live Studio');
      return new XLive({ ctx, account, title, sourceName: optionString(dest, 'sourceName'), urls, timings }).prepared(push);
    },
  };
}

export const xDriver: PlatformDriver = createXDriver();
