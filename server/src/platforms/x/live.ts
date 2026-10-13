// One X livestream driven through Live Studio for a prepared destination: "Go live" (confirm),
// live title edits, "End livestream" and chat from the public broadcast page.
//
// Uses its own pages in the account's browser context (not the shared viewer page), so two X
// destinations on one account, or an admin looking at the login viewer, don't fight over a tab.

import type { Page } from 'playwright';
import type { Account } from '../../../../shared/types.js';
import { abortable, scrapeChat } from '../../browser/helpers.js';
import { truncateTitle } from '../common/http.js';
import { DriverError, type ChatMessageInput, type DriverContext, type PreparedLive, type PushPlan } from '../types.js';
import { X_CHAT, type XUrls } from './selectors.js';
import {
  editTitle,
  endLivestream,
  goLive,
  isLoginUrl,
  SESSION_EXPIRED,
  sleep,
  type FlowOptions,
  type XTimings,
} from './studio.js';

/** X titles follow post length limits (https://docs.x.com/livestream-api/broadcasts/publish-or-end-broadcast). */
export const X_TITLE_MAX = 280;
/** Live Studio needs a title; used when the session title is empty. */
export const DEFAULT_TITLE = 'Live';

export function xTitle(title: string): string {
  return truncateTitle(title, X_TITLE_MAX) || DEFAULT_TITLE;
}

function message(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return (raw.split('\n', 1)[0] ?? '').slice(0, 300);
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

export interface XLiveOptions {
  ctx: DriverContext;
  account: Account;
  title: string;
  sourceName: string;
  urls: XUrls;
  timings: XTimings;
}

export class XLive {
  private readonly ctx: DriverContext;
  private readonly accountId: string;
  private title: string;
  private appliedTitle: string | null = null;
  private broadcastId: string | null = null;
  private detailsUrl: string | null = null;
  private live = false;
  /** "Go live" was pressed: X may be live even though confirm() failed or was aborted. */
  private goLiveClicked = false;
  private ended = false;
  private studio: Page | null = null;
  /** Serializes studio page use (confirm, title edits, end). */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: XLiveOptions) {
    this.ctx = opts.ctx;
    this.accountId = opts.account.id;
    this.title = xTitle(opts.title);
  }

  /** The PreparedLive handed to the orchestrator. */
  prepared(push: PushPlan): PreparedLive {
    const watchUrl = () => this.watchUrl();
    return {
      push,
      // Getter: the watch URL is only known once "Go live" succeeded (the runner reads it then).
      get watchUrl() {
        return watchUrl();
      },
      confirm: (signal) => this.confirm(signal),
      setTitle: (title) => this.setTitle(title),
      end: () => this.end(),
      chat: (signal) => this.chat(signal),
    };
  }

  watchUrl(): string | null {
    return this.broadcastId ? this.opts.urls.broadcast(this.broadcastId) : null;
  }

  // ---------------------------------------------------------------------------
  // PreparedLive
  // ---------------------------------------------------------------------------

  async confirm(signal: AbortSignal): Promise<void> {
    await this.serial(async () => {
      if (this.ended) throw new DriverError('This X livestream was already ended', 'platform-error');
      const used = this.title;
      try {
        const page = await this.studioPage();
        const onGoLiveClicked = () => {
          this.goLiveClicked = true;
        };
        const result = await goLive(page, { title: used, sourceName: this.opts.sourceName, onGoLiveClicked }, this.flow(signal));
        this.live = true;
        this.appliedTitle = used;
        this.broadcastId = result.broadcastId;
        this.detailsUrl = result.detailsUrl;
        this.ctx.log.info(
          { broadcastId: result.broadcastId, confirmed: result.confirmed },
          'X livestream started from Live Studio',
        );
      } catch (err) {
        // After a "Go live" click X may be live: keep the studio page (it shows that livestream) so
        // end() can press "End livestream" there.
        if (!this.goLiveClicked) await this.closeStudio();
        if (signal.aborted) throw err;
        throw await this.goLiveError(err);
      }
      await this.ctx.browser.save(this.accountId).catch((err: unknown) =>
        this.ctx.log.warn({ error: message(err) }, 'saving the X browser session failed'),
      );
      await this.ctx.updateAccount({ status: 'connected', statusMessage: null }).catch(() => {});
    });
    // The title changed while we were going live: apply the latest one (best effort).
    if (this.live && this.title !== this.appliedTitle) {
      this.setTitle(this.title).catch((err: unknown) =>
        this.ctx.log.warn({ error: message(err) }, 'X title update after going live failed'),
      );
    }
  }

  async setTitle(title: string): Promise<void> {
    this.title = xTitle(title);
    // Not live yet: confirm() uses (or applies afterwards) the latest title.
    if (!this.live || this.ended) return;
    const wanted = this.title;
    await this.serial(async () => {
      if (this.ended || wanted !== this.title || wanted === this.appliedTitle) return;
      if (!this.detailsUrl) throw new DriverError('The X livestream page is unknown; change the title in Live Studio', 'platform-error');
      const signal = AbortSignal.timeout(this.opts.timings.editMs);
      try {
        await editTitle(await this.studioPage(), this.detailsUrl, wanted, this.flow(signal));
        this.appliedTitle = wanted;
      } catch (err) {
        const reason = err instanceof DriverError && err.code === 'needs-login' ? SESSION_EXPIRED : message(err);
        this.ctx.log.warn({ error: reason }, 'X live title update failed');
        await this.ctx.updateAccount({ statusMessage: `Couldn't update the X title: ${reason}` }).catch(() => {});
        throw new DriverError(`Couldn't update the X title in Live Studio: ${reason}`, 'platform-error');
      }
    });
  }

  /** End the livestream we started (or may have started: "Go live" was pressed). Never throws. */
  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.serial(async () => {
      try {
        const url = this.endUrl();
        if (!url) return;
        const signal = AbortSignal.timeout(this.opts.timings.endMs);
        const found = await endLivestream(await this.studioPage(), url, this.flow(signal));
        if (found) this.ctx.log.info({ broadcastId: this.broadcastId }, 'X livestream ended');
        else this.ctx.log.info('X livestream: no "End livestream" button found (already ended?)');
      } catch (err) {
        this.ctx.log.warn({ error: message(err) }, 'ending the X livestream failed');
        await this.ctx
          .updateAccount({ statusMessage: "Couldn't end the X livestream automatically; end it in Live Studio" })
          .catch(() => {});
      } finally {
        this.live = false;
        await this.closeStudio();
      }
    }).catch(() => {});
  }

  /** Chat of the running broadcast (x.com/i/broadcasts/<id>), scraped from its page. */
  async *chat(signal: AbortSignal): AsyncGenerator<ChatMessageInput> {
    // The id comes from the Live Studio page after "Go live"; when it couldn't be read there is
    // nothing to open, so wait quietly (ending would only make the chat hub restart us).
    while (!this.broadcastId) {
      if (this.ended || !(await sleep(this.opts.timings.chatWaitMs, signal))) return;
    }
    const page = await this.newPage();
    try {
      await abortable(
        page.goto(this.opts.urls.broadcast(this.broadcastId), { waitUntil: 'domcontentloaded', timeout: this.opts.timings.navMs }),
        signal,
      );
      if (isLoginUrl(page.url())) throw new DriverError(SESSION_EXPIRED, 'needs-login');
      yield* scrapeChat(page, X_CHAT, signal);
    } finally {
      await page.close().catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private flow(signal: AbortSignal): FlowOptions {
    return { urls: this.opts.urls, timings: this.opts.timings, signal, log: this.ctx.log };
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async newPage(): Promise<Page> {
    const context = await this.ctx.browser.context(this.accountId);
    return context.newPage();
  }

  private async studioPage(): Promise<Page> {
    if (!this.studio || this.studio.isClosed()) this.studio = await this.newPage();
    return this.studio;
  }

  /**
   * Where end() looks for "End livestream": the livestream's page when going live succeeded;
   * after a failed/aborted go-live that pressed "Go live", the studio page as it is (its URL is
   * whatever X showed then), or Live Studio when that page is gone. Null = nothing to end.
   */
  private endUrl(): string | null {
    if (this.live && this.detailsUrl) return this.detailsUrl;
    if (!this.goLiveClicked) return null;
    const page = this.studio;
    return page && !page.isClosed() ? page.url() : this.opts.urls.liveStudio;
  }

  private async closeStudio(): Promise<void> {
    const page = this.studio;
    this.studio = null;
    await page?.close().catch(() => {});
  }

  /** Turn a failed go-live into a clear, user-facing DriverError (and flag the account). */
  private async goLiveError(err: unknown): Promise<DriverError> {
    if (err instanceof DriverError && err.code === 'needs-login') {
      await this.ctx.updateAccount({ status: 'needs-login', statusMessage: SESSION_EXPIRED }).catch(() => {});
      return err;
    }
    if (err instanceof DriverError && err.code === 'not-eligible') {
      await this.ctx.updateAccount({ statusMessage: err.message }).catch(() => {});
      return err;
    }
    const reason = message(err);
    this.ctx.log.warn({ error: reason, goLiveClicked: this.goLiveClicked }, 'X Live Studio go-live failed');
    const code = err instanceof DriverError ? err.code : isAbort(err) ? 'timeout' : 'platform-error';
    if (this.goLiveClicked) {
      await this.ctx
        .updateAccount({ statusMessage: `Last go-live may have started without confirmation: ${reason}. Check Live Studio.` })
        .catch(() => {});
      return new DriverError(
        `"Go live" was pressed in X Live Studio but X didn't confirm the livestream (${reason}). It may have started: ` +
          'the app tries to end it when this destination stops; check Live Studio to be sure.',
        code,
      );
    }
    await this.ctx.updateAccount({ statusMessage: `Last go-live failed: ${reason}` }).catch(() => {});
    return new DriverError(
      `Couldn't press "Go live" in X Live Studio (${reason}). Go live there yourself, or turn off "Go live automatically" for this destination.`,
      code,
    );
  }
}
