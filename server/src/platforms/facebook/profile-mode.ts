// Facebook personal-profile mode (EXPERIMENTAL): video goes to a persistent stream key pasted into
// the destination; the title, the "Go live" click and chat are automated in Facebook Live Producer
// on a best-effort basis and never block streaming. Locators live in selectors.ts.
//
// With a persistent key Facebook shows the stream preview but still expects "Go live" to be clicked
// in Live Producer (https://www.facebook.com/help/587160588142067, OBS forum thread 158909), which
// is what confirm() does.

import type { Logger } from 'pino';
import type { Locator, Page } from 'playwright';
import type { ConnectPoll, ConnectStart } from '../../../../shared/api.js';
import type { Account, AccountStatus, Destination } from '../../../../shared/types.js';
import { abortable, clickWhenEnabled, fillField, humanPause, scrapeChat, waitForAny } from '../../browser/helpers.js';
import { truncateTitle } from '../common/http.js';
import { DriverError, type ChatMessageInput, type DriverContext, type PreparedLive, type PushPlan } from '../types.js';
import { TITLE_MAX } from './page-mode.js';
import {
  CHAT_EXTRACT,
  CHAT_ITEM_SELECTOR,
  FACEBOOK_ORIGIN,
  LOGIN_URL,
  PRODUCER_URL,
  PROFILE_URL,
  profileNameFromTitle,
  sel,
  SESSION_COOKIES,
} from './selectors.js';

export const DEFAULT_INGEST_URL = 'rtmps://live-api-s.facebook.com:443/rtmp/';
const SESSION_EXPIRED = 'Facebook session expired — log in again from Accounts';
const NO_KEY =
  'Paste a persistent stream key: in facebook.com/live/producer choose "Streaming software", turn on "Persistent stream key" (Advanced settings) and copy the key into this destination';

export interface ProfileTimings {
  /** Page load / state detection in Live Producer. */
  navMs: number;
  /** Waiting for the stream preview and an enabled "Go live" button. */
  goLiveWaitMs: number;
  /** Waiting for the on-air state after clicking "Go live". */
  verifyLiveMs: number;
  /** Whole confirm() step; must stay below the orchestrator's confirm timeout (180 s). */
  confirmBudgetMs: number;
  /** Budget for filling in the title during prepare. */
  titleBudgetMs: number;
  /** Budget for a title change while live; below the orchestrator's title timeout (30 s). */
  liveTitleMs: number;
  /** Budget for clicking "End live video". */
  endBudgetMs: number;
  /** Waiting for the comments panel before giving up on chat. */
  chatPanelMs: number;
  chatPollMs: number;
  typingMinMs: number;
  typingMaxMs: number;
}

export const DEFAULT_PROFILE_TIMINGS: ProfileTimings = {
  navMs: 30_000,
  goLiveWaitMs: 120_000,
  verifyLiveMs: 30_000,
  confirmBudgetMs: 150_000,
  titleBudgetMs: 60_000,
  liveTitleMs: 25_000,
  endBudgetMs: 20_000,
  chatPanelMs: 45_000,
  chatPollMs: 1500,
  typingMinMs: 30,
  typingMaxMs: 110,
};

export interface ProfileModeEnv {
  producerUrl?: string;
  profileUrl?: string;
  timings?: Partial<ProfileTimings>;
}

interface ResolvedEnv {
  producerUrl: string;
  profileUrl: string;
  t: ProfileTimings;
}

function resolveEnv(env: ProfileModeEnv): ResolvedEnv {
  return {
    producerUrl: env.producerUrl ?? PRODUCER_URL,
    profileUrl: env.profileUrl ?? PROFILE_URL,
    t: { ...DEFAULT_PROFILE_TIMINGS, ...env.timings },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Per-account lock: Live Producer steps (prepare/confirm/title/end) share one browser page.
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<void>>();

async function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(accountId) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(
    () => {},
    () => {},
  );
  locks.set(accountId, tail);
  try {
    return await run;
  } finally {
    if (locks.get(accountId) === tail) locks.delete(accountId);
  }
}

// ---------------------------------------------------------------------------
// Session + stream key
// ---------------------------------------------------------------------------

/** Logged in = facebook.com session cookies (c_user + xs) present and unexpired. */
export async function hasFacebookSession(ctx: DriverContext, accountId: string): Promise<boolean> {
  const context = await ctx.browser.context(accountId);
  const cookies = await context.cookies(FACEBOOK_ORIGIN);
  const now = Date.now() / 1000;
  return SESSION_COOKIES.every((name) => cookies.some((c) => c.name === name && c.value !== '' && (c.expires === -1 || c.expires > now)));
}

/** `<server>/<key>` with exactly one slash between them. */
export function joinIngestUrl(server: string, key: string): string {
  return `${server.trim().replace(/\/+$/, '')}/${key.trim().replace(/^\/+/, '')}`;
}

function serverUrl(dest: Destination): string {
  return dest.ingestUrl?.trim() || DEFAULT_INGEST_URL;
}

function isRtmpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'rtmp:' || u.protocol === 'rtmps:') && u.hostname !== '';
  } catch {
    return false;
  }
}

/** Problems with a persistent-key destination ([] = OK). */
export async function profileDestinationProblems(dest: Destination, ctx: DriverContext): Promise<string[]> {
  const problems: string[] = [];
  if (!isRtmpUrl(serverUrl(dest))) problems.push('Server URL must be an rtmp:// or rtmps:// URL');
  const key = (await ctx.destinationSecrets?.get('streamKey'))?.trim();
  if (!key) problems.push(NO_KEY);
  return problems;
}

export async function persistentKeyPush(dest: Destination, ctx: DriverContext): Promise<PushPlan> {
  const server = serverUrl(dest);
  if (!isRtmpUrl(server)) throw new DriverError('Server URL must be an rtmp:// or rtmps:// URL', 'misconfigured');
  const key = (await ctx.destinationSecrets?.get('streamKey'))?.trim();
  if (!key) throw new DriverError(NO_KEY, 'misconfigured');
  return { url: joinIngestUrl(server, key), mode: 'copy', feeds: [dest.feed] };
}

// ---------------------------------------------------------------------------
// Live Producer automation
// ---------------------------------------------------------------------------

async function visible(locator: Locator): Promise<boolean> {
  try {
    return await locator.filter({ visible: true }).first().isVisible();
  } catch {
    return false;
  }
}

async function isSelected(locator: Locator): Promise<boolean> {
  return locator
    .filter({ visible: true })
    .first()
    .evaluate((el) => {
      const e = el as unknown as { getAttribute(n: string): string | null; checked?: unknown };
      return (
        e.getAttribute('aria-checked') === 'true' ||
        e.getAttribute('aria-selected') === 'true' ||
        e.getAttribute('aria-pressed') === 'true' ||
        e.checked === true
      );
    })
    .catch(() => false);
}

export class LiveProducer {
  constructor(
    private readonly page: Page,
    private readonly env: ResolvedEnv,
  ) {}

  isOpen(): boolean {
    return !this.page.isClosed() && this.page.url().startsWith(this.env.producerUrl);
  }

  private goto(signal: AbortSignal): Promise<unknown> {
    return abortable(this.page.goto(this.env.producerUrl, { waitUntil: 'domcontentloaded', timeout: this.env.t.navMs }), signal);
  }

  /** Open Live Producer at the live setup (video source "Streaming software"), or detect that we're on air. */
  async open(signal: AbortSignal): Promise<'setup' | 'live'> {
    const p = this.page;
    let navigated = false;
    if (!this.isOpen()) {
      await this.goto(signal);
      navigated = true;
    }
    let entered = false;
    for (;;) {
      const candidates: Record<string, Locator> = {
        login: sel.loginForm(p),
        live: sel.endLiveButton(p),
        setup: sel.titleField(p).or(sel.descriptionField(p)).or(sel.streamingSoftware(p)),
      };
      if (!entered) candidates.entry = sel.createLiveEntry(p);
      let state: string;
      try {
        state = await waitForAny(p, candidates, { timeoutMs: this.env.t.navMs, signal });
      } catch (err) {
        if (signal.aborted || navigated || !(err instanceof DriverError)) throw err;
        await this.goto(signal); // stale page (e.g. a finished live): reload once
        navigated = true;
        continue;
      }
      if (state === 'login') throw new DriverError(SESSION_EXPIRED, 'needs-login');
      if (state === 'live') return 'live';
      if (state === 'setup') break;
      entered = true;
      await clickWhenEnabled(sel.createLiveEntry(p), { timeoutMs: 10_000, signal, what: 'the "Create live video" button' });
      await humanPause(500, 1200, signal);
    }
    const source = sel.streamingSoftware(p);
    if ((await visible(source)) && !(await isSelected(source))) {
      await clickWhenEnabled(source, { timeoutMs: 10_000, signal, what: 'the "Streaming software" option' });
      await humanPause(400, 900, signal);
    }
    return 'setup';
  }

  /** Type the title into "Add post details" (title box, else description). False when neither exists. */
  async fillTitle(title: string, signal: AbortSignal): Promise<boolean> {
    for (const field of [sel.titleField(this.page), sel.descriptionField(this.page)]) {
      if (!(await visible(field))) continue;
      await fillField(field, title, { signal, minDelayMs: this.env.t.typingMinMs, maxDelayMs: this.env.t.typingMaxMs });
      return true;
    }
    return false;
  }

  /** Wait for the preview to enable "Go live", click it and check that we're on air. */
  async goLive(signal: AbortSignal): Promise<'live' | 'unconfirmed' | 'no-button'> {
    const p = this.page;
    try {
      await clickWhenEnabled(sel.goLiveButton(p), { timeoutMs: this.env.t.goLiveWaitMs, signal, what: 'the Facebook "Go live" button' });
    } catch (err) {
      if (!signal.aborted && err instanceof DriverError && err.code === 'timeout') return 'no-button';
      throw err;
    }
    for (let i = 0; i < 2; i++) {
      let state: string;
      try {
        state = await waitForAny(p, { live: sel.endLiveButton(p), confirm: sel.goLiveConfirm(p) }, { timeoutMs: this.env.t.verifyLiveMs, signal });
      } catch (err) {
        if (!signal.aborted && err instanceof DriverError && err.code === 'timeout') return 'unconfirmed';
        throw err;
      }
      if (state === 'live') return 'live';
      await clickWhenEnabled(sel.goLiveConfirm(p), { timeoutMs: 10_000, signal, what: 'the "Go live" confirmation' });
    }
    return 'unconfirmed';
  }

  /** Change the title (while live: fill + Save when there is one; during setup: fill only). */
  async updateTitle(title: string, signal: AbortSignal, live: boolean): Promise<void> {
    if (!(await this.fillTitle(title, signal))) {
      throw new DriverError("Couldn't find the title box in Facebook Live Producer — change the title there", 'platform-error');
    }
    const save = sel.saveButton(this.page);
    if (live && (await visible(save))) await clickWhenEnabled(save, { timeoutMs: 10_000, signal, what: 'the Save button' });
  }

  /** Click "End live video" (+ confirmation) when it is on screen. */
  async end(signal: AbortSignal): Promise<boolean> {
    if (!this.isOpen()) return false;
    const button = sel.endLiveButton(this.page);
    if (!(await visible(button))) return false;
    await clickWhenEnabled(button, { timeoutMs: 5000, signal, what: 'the "End live video" button' });
    try {
      await clickWhenEnabled(sel.endLiveConfirm(this.page), { timeoutMs: 8000, signal, what: 'the end confirmation' });
    } catch (err) {
      if (signal.aborted) throw err; // no confirmation dialog in this layout
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

export function startProfileConnect(): ConnectStart {
  return {
    method: 'browser',
    startUrl: LOGIN_URL,
    instructions: [
      'Log in to Facebook in the browser below (complete any security check or two-factor prompt).',
      'When your feed is showing, click "I\'m logged in".',
      'Then create a destination with your persistent stream key from facebook.com/live/producer (Streaming software → Advanced settings → Persistent stream key).',
    ].join('\n'),
  };
}

async function readProfileName(ctx: DriverContext, accountId: string, env: ResolvedEnv): Promise<string | null> {
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]);
  const page = await abortable(ctx.browser.page(accountId), signal);
  await abortable(page.goto(env.profileUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }), signal);
  return profileNameFromTitle(await abortable(page.title(), signal));
}

export async function completeProfileConnect(account: Account, ctx: DriverContext, envIn: ProfileModeEnv): Promise<ConnectPoll> {
  const env = resolveEnv(envIn);
  if (!(await hasFacebookSession(ctx, account.id))) {
    // Clicked "I'm logged in" too early: the login is still in progress.
    return {
      status: 'pending',
      message: 'Facebook does not show a logged-in session yet — finish logging in (including any security check) in the browser window, then try again.',
    };
  }
  let label = 'Facebook profile';
  try {
    label = (await readProfileName(ctx, account.id, env)) ?? label;
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    ctx.log.debug({ error: errorText(err) }, 'reading the Facebook profile name failed');
  }
  await ctx.browser.save(account.id);
  const options = { ...account.options, mode: 'profile' };
  await ctx.updateAccount({ label, status: 'connected', statusMessage: null, options });
  return { status: 'connected', account: { ...account, label, status: 'connected', statusMessage: null, options } };
}

export async function checkProfileAccount(account: Account, ctx: DriverContext): Promise<{ status: AccountStatus; message?: string }> {
  if (await hasFacebookSession(ctx, account.id)) return { status: 'connected' };
  return { status: 'needs-login', message: SESSION_EXPIRED };
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

export async function prepareProfileLive(
  dest: Destination,
  account: Account | null,
  title: string,
  ctx: DriverContext,
  envIn: ProfileModeEnv,
): Promise<PreparedLive> {
  const push = await persistentKeyPush(dest, ctx);
  if (!account) return { push, watchUrl: null }; // key only: no title, Go live or chat automation

  const env = resolveEnv(envIn);
  const accountId = account.id;
  const log = ctx.log;
  let latestTitle = truncateTitle(title, TITLE_MAX);
  let appliedTitle: string | null = null;
  let producerUsed = false;

  const producer = async (signal: AbortSignal): Promise<LiveProducer> => {
    producerUsed = true;
    return new LiveProducer(await abortable(ctx.browser.page(accountId), signal), env);
  };

  // Best effort: open Live Producer and fill in the title before the stream arrives.
  let loggedIn: boolean | null = null;
  try {
    loggedIn = await hasFacebookSession(ctx, accountId);
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    log.warn({ error: errorText(err) }, 'browser unavailable: streaming to the persistent key without Live Producer automation');
  }
  if (loggedIn) {
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(env.t.titleBudgetMs)]);
    try {
      await withAccountLock(accountId, async () => {
        const lp = await producer(signal);
        if ((await lp.open(signal)) === 'setup' && latestTitle && (await lp.fillTitle(latestTitle, signal))) appliedTitle = latestTitle;
      });
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      log.warn({ error: errorText(err) }, 'setting the title in Facebook Live Producer failed; streaming anyway');
    }
  } else if (loggedIn === false) {
    log.warn('Facebook profile session expired: streaming to the persistent key without Live Producer automation');
    await ctx.updateAccount({ status: 'needs-login', statusMessage: SESSION_EXPIRED }).catch(() => {});
  }

  return {
    push,
    watchUrl: null,

    // Never fails the destination (the video still reaches the persistent key) and finishes within
    // its own budget, so the orchestrator's confirm timeout never turns a slow page into an error.
    async confirm(outer) {
      const signal = AbortSignal.any([outer, AbortSignal.timeout(env.t.confirmBudgetMs)]);
      try {
        await withAccountLock(accountId, async () => {
          if (!(await hasFacebookSession(ctx, accountId))) {
            log.warn('Facebook profile session expired: click "Go live" in Live Producer yourself');
            return;
          }
          const lp = await producer(signal);
          if ((await lp.open(signal)) === 'live') return;
          if (latestTitle && appliedTitle !== latestTitle) {
            try {
              if (await lp.fillTitle(latestTitle, signal)) appliedTitle = latestTitle;
            } catch (err) {
              if (signal.aborted) throw err;
              log.warn({ error: errorText(err) }, 'setting the Facebook live title failed');
            }
          }
          const result = await lp.goLive(signal);
          if (result === 'no-button') log.warn('Facebook "Go live" button not found; click it in Live Producer yourself if the live has not started');
          else if (result === 'unconfirmed') log.warn('Clicked "Go live" in Facebook Live Producer but could not confirm the live started');
          else log.info('Facebook profile live started in Live Producer');
          await ctx.browser.save(accountId).catch(() => {});
        });
      } catch (err) {
        if (outer.aborted) throw err;
        log.warn({ error: errorText(err) }, 'Facebook Live Producer automation failed; click "Go live" there yourself if needed');
      }
    },

    async setTitle(next, outer) {
      latestTitle = truncateTitle(next, TITLE_MAX);
      if (!latestTitle) return;
      await withAccountLock(accountId, async () => {
        // The step budget starts once the page is ours (confirm/prepare may hold it for a while);
        // the orchestrator's signal bounds the whole call, including the wait for the lock.
        outer?.throwIfAborted();
        const budget = AbortSignal.timeout(env.t.liveTitleMs);
        const signal = outer ? AbortSignal.any([outer, budget]) : budget;
        const lp = await producer(signal);
        const state = await lp.open(signal);
        await lp.updateTitle(latestTitle, signal, state === 'live');
        appliedTitle = latestTitle;
      });
    },

    async end() {
      if (!producerUsed) return; // the live ends on its own once the stream stops
      const signal = AbortSignal.timeout(env.t.endBudgetMs);
      try {
        await withAccountLock(accountId, async () => {
          const lp = await producer(signal);
          if (await lp.end(signal)) log.info('Ended the Facebook profile live in Live Producer');
        });
      } catch (err) {
        log.warn({ error: errorText(err) }, 'ending the live in Facebook Live Producer failed; it ends when the stream stops');
      }
    },

    chat: (signal) => profileChat(ctx, accountId, env, signal),
  };
}

/** Scrape the Live Producer comments panel; ends quietly when it can't be found. */
async function* profileChat(ctx: DriverContext, accountId: string, env: ResolvedEnv, signal: AbortSignal): AsyncGenerator<ChatMessageInput> {
  const log: Logger = ctx.log;
  let page: Page;
  try {
    page = await withAccountLock(accountId, async () => {
      const pg = await abortable(ctx.browser.page(accountId), signal);
      if (!new LiveProducer(pg, env).isOpen()) {
        await abortable(pg.goto(env.producerUrl, { waitUntil: 'domcontentloaded', timeout: env.t.navMs }), signal);
      }
      return pg;
    });
    await waitForAny(page, { panel: sel.commentsPanel(page), comment: page.locator(CHAT_ITEM_SELECTOR) }, { timeoutMs: env.t.chatPanelMs, signal });
  } catch (err) {
    if (signal.aborted) return;
    log.info({ error: errorText(err) }, 'Facebook Live Producer comments panel not found; profile chat unavailable for now');
    return;
  }
  yield* scrapeChat(page, { itemSelector: CHAT_ITEM_SELECTOR, extract: CHAT_EXTRACT, pollMs: env.t.chatPollMs }, signal);
}
