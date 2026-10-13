// Live login viewer: streams a Playwright page to the web UI (CDP screencast) and relays the
// user's mouse/keyboard input back. Used for manual logins (2FA, captchas) on browser platforms.
// CDP screencast: https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast

import type { BrowserContext, CDPSession, Page } from 'playwright';
import type { Logger } from 'pino';
import type { BrowserClientMessage, BrowserServerMessage } from '../../../shared/api.js';
import { keyLocation, keyText, textModifiers, virtualKeyCode } from './keys.js';
import { clamp, isNavigationInterrupted, navErrorMessage, parseHttpUrl, safeErrorMessage } from './util.js';

type FrameMessage = Extract<BrowserServerMessage, { type: 'frame' }>;
type KeyMessage = Extract<BrowserClientMessage, { type: 'key' }>;
type NavMessage = Extract<BrowserClientMessage, { type: 'navigate' | 'back' | 'reload' }>;

export interface BrowserViewerOptions {
  /** Deliver a message to the client. */
  send(msg: BrowserServerMessage): void;
  /** Return false to hold frames back (e.g. socket backpressure); the latest frame is retried later. */
  canSendFrame?(): boolean;
  /** Called once when the viewed page (and every popup) has closed. */
  onClosed?(): void;
  log?: Logger;
  /** Frame rate cap. Default 10 fps. */
  maxFps?: number;
  /**
   * Host policy: why `url` must not be shown (e.g. a LAN/loopback host), or null when allowed.
   * Applied to 'navigate' requests and to every main-frame navigation of a viewed page (redirects).
   */
  checkUrl?(url: URL): Promise<string | null>;
  /** The viewing client is macOS: Option+key typing a character inserts it (see keyText). */
  macOptionText?: boolean;
}

const SCREENCAST = { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 } as const;
const NAV_TIMEOUT_MS = 45_000;
const MAX_QUEUE = 500;
const MAX_COORD = 10_000;
const MAX_WHEEL = 5_000;

/**
 * One viewer attached to an account's page. Follows popups (OAuth windows): a new page in the
 * context becomes the viewed page; when it closes, the previous page is shown again.
 * `stop()` detaches everything but leaves the pages open.
 */
export class BrowserViewer {
  private readonly context: BrowserContext;
  private readonly stack: Page[] = [];
  private readonly unwatch = new Map<Page, () => void>();
  private readonly minFrameIntervalMs: number;
  private current: Page;
  private cdp: CDPSession | null = null;
  private started = false;
  private stopped = false;
  private closedNotified = false;
  private switching: Promise<void> = Promise.resolve();
  private pendingFrame: FrameMessage | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private lastFrameAt = 0;
  private lastUrlKey = '';
  private queue: BrowserClientMessage[] = [];
  private draining: Promise<void> | null = null;

  constructor(
    page: Page,
    private readonly opts: BrowserViewerOptions,
  ) {
    this.current = page;
    this.context = page.context();
    this.minFrameIntervalMs = Math.round(1000 / Math.max(1, opts.maxFps ?? 10));
  }

  /** The page currently being shown (the root page or the newest open popup). */
  get page(): Page {
    return this.current;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    if (this.current.isClosed()) {
      this.notifyClosed();
      return;
    }
    this.context.on('page', this.onNewPage);
    this.track(this.current);
    await this.switchTo(this.current);
  }

  /** Stop streaming and input relay. Pages stay open. Safe to call more than once. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.context.off('page', this.onNewPage);
    for (const off of this.unwatch.values()) off();
    this.unwatch.clear();
    this.stack.length = 0;
    this.queue.length = 0;
    await this.switching;
    await this.detach();
  }

  /**
   * Handle one validated client message. Input events are applied in order (consecutive mouse
   * moves are coalesced); navigation runs in the background. Resolves when the input queue is idle.
   */
  handle(msg: BrowserClientMessage): Promise<void> {
    if (this.stopped || !this.started) return Promise.resolve();
    if (msg.type === 'navigate' || msg.type === 'back' || msg.type === 'reload') {
      void this.navigate(msg);
      return Promise.resolve();
    }
    const last = this.queue.at(-1);
    if (msg.type === 'mouse' && msg.action === 'move' && last?.type === 'mouse' && last.action === 'move') {
      this.queue[this.queue.length - 1] = msg;
    } else if (this.queue.length < MAX_QUEUE) {
      this.queue.push(msg);
    }
    this.draining ??= this.drain();
    return this.draining;
  }

  // ---- pages + popups ------------------------------------------------------

  private readonly onNewPage = (page: Page): void => {
    if (this.stopped) return;
    this.track(page);
    void this.switchTo(page);
  };

  private track(page: Page): void {
    if (this.unwatch.has(page)) return;
    this.stack.push(page);
    const onClose = () => this.onPageClosed(page);
    const onNav = (frame: unknown) => {
      if (frame !== page.mainFrame()) return;
      void this.sendUrl(page);
      void this.guardNavigation(page);
    };
    const onLoad = () => void this.sendUrl(page);
    page.on('close', onClose);
    page.on('framenavigated', onNav);
    page.on('load', onLoad);
    this.unwatch.set(page, () => {
      page.off('close', onClose);
      page.off('framenavigated', onNav);
      page.off('load', onLoad);
    });
  }

  private onPageClosed(page: Page): void {
    this.unwatch.get(page)?.();
    this.unwatch.delete(page);
    const idx = this.stack.indexOf(page);
    if (idx >= 0) this.stack.splice(idx, 1);
    if (this.stopped || page !== this.current) return;
    const fallback = [...this.stack].reverse().find((p) => !p.isClosed());
    if (fallback) {
      void this.switchTo(fallback);
    } else {
      this.notifyClosed();
      void this.stop();
    }
  }

  private notifyClosed(): void {
    if (this.closedNotified) return;
    this.closedNotified = true;
    this.opts.send({ type: 'closed' });
    this.opts.onClosed?.();
  }

  /** Move the screencast to `page` (serialized so concurrent popups can't interleave). */
  private switchTo(page: Page): Promise<void> {
    this.switching = this.switching
      .then(async () => {
        if (this.stopped || page.isClosed()) return;
        await this.detach();
        this.current = page;
        this.lastUrlKey = '';
        // Headed Chromium only produces frames for the foreground tab.
        await page.bringToFront().catch(() => {});
        await this.attach(page);
      })
      .catch((err: unknown) => {
        if (!page.isClosed()) this.opts.log?.warn({ err: safeErrorMessage(err) }, 'browser viewer: could not attach to page');
      });
    return this.switching;
  }

  private async attach(page: Page): Promise<void> {
    const session = await page.context().newCDPSession(page);
    if (this.stopped || page !== this.current || page.isClosed()) {
      await session.detach().catch(() => {});
      return;
    }
    this.cdp = session;
    session.on('Page.screencastFrame', (frame) => {
      // Always ack, even for frames we drop, or Chromium stops sending.
      session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
      if (this.stopped || session !== this.cdp) return;
      this.pendingFrame = {
        type: 'frame',
        data: frame.data,
        width: Math.round(frame.metadata.deviceWidth),
        height: Math.round(frame.metadata.deviceHeight),
      };
      this.flushFrame();
    });
    await session.send('Page.startScreencast', { ...SCREENCAST });
    void this.sendUrl(page);
  }

  private async detach(): Promise<void> {
    const session = this.cdp;
    this.cdp = null;
    this.pendingFrame = null;
    if (this.frameTimer) {
      clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
    if (!session) return;
    await session.send('Page.stopScreencast').catch(() => {});
    await session.detach().catch(() => {});
  }

  /** Send the newest pending frame, at most `maxFps` per second and only when the client keeps up. */
  private flushFrame(): void {
    if (this.frameTimer || !this.pendingFrame || this.stopped) return;
    const wait = this.lastFrameAt + this.minFrameIntervalMs - Date.now();
    const blocked = this.opts.canSendFrame ? !this.opts.canSendFrame() : false;
    if (wait > 0 || blocked) {
      this.frameTimer = setTimeout(
        () => {
          this.frameTimer = null;
          this.flushFrame();
        },
        wait > 0 ? wait : this.minFrameIntervalMs,
      );
      this.frameTimer.unref?.();
      return;
    }
    const frame = this.pendingFrame;
    this.pendingFrame = null;
    this.lastFrameAt = Date.now();
    this.opts.send(frame);
  }

  /** Leave a viewed page that ended up (e.g. through a redirect) on a host the policy refuses. */
  private async guardNavigation(page: Page): Promise<void> {
    const check = this.opts.checkUrl;
    if (!check || this.stopped || page.isClosed()) return;
    const url = parseHttpUrl(page.url());
    if (!url) return; // about:blank, error pages...
    const refused = await check(url).catch(() => null);
    if (!refused || this.stopped || page.isClosed() || parseHttpUrl(page.url())?.href !== url.href) return;
    this.opts.send({ type: 'error', message: refused });
    await page.goto('about:blank').catch(() => {});
  }

  private async sendUrl(page: Page): Promise<void> {
    if (this.stopped || page !== this.current || page.isClosed()) return;
    const url = page.url();
    const title = await page.title().catch(() => '');
    if (this.stopped || page !== this.current) return;
    const key = `${url}\n${title}`;
    if (key === this.lastUrlKey) return;
    this.lastUrlKey = key;
    this.opts.send({ type: 'url', url, title });
  }

  // ---- input ---------------------------------------------------------------

  private async drain(): Promise<void> {
    await null; // let handle() store this promise before the loop can finish
    for (;;) {
      const msg = this.queue.shift();
      if (!msg || this.stopped) {
        this.queue.length = 0;
        this.draining = null;
        return;
      }
      try {
        await this.dispatch(msg);
      } catch (err) {
        if (!this.current.isClosed()) this.opts.log?.debug({ err: safeErrorMessage(err) }, 'browser viewer: input failed');
      }
    }
  }

  private async dispatch(msg: BrowserClientMessage): Promise<void> {
    const page = this.current;
    if (page.isClosed()) return;
    switch (msg.type) {
      case 'mouse': {
        const x = clamp(msg.x, 0, MAX_COORD);
        const y = clamp(msg.y, 0, MAX_COORD);
        const button = msg.button ?? 'left';
        const clickCount = msg.clickCount ?? 1;
        await page.mouse.move(x, y);
        if (msg.action === 'down') await page.mouse.down({ button, clickCount });
        else if (msg.action === 'up') await page.mouse.up({ button, clickCount });
        else if (msg.action === 'wheel') {
          await page.mouse.wheel(clamp(msg.deltaX ?? 0, -MAX_WHEEL, MAX_WHEEL), clamp(msg.deltaY ?? 0, -MAX_WHEEL, MAX_WHEEL));
        }
        return;
      }
      case 'key':
        return this.dispatchKey(msg);
      case 'type':
        return page.keyboard.insertText(msg.text);
      case 'resize':
        return page.setViewportSize({ width: clamp(msg.width, 320, 1920), height: clamp(msg.height, 320, 1200) });
      default:
        return;
    }
  }

  /** Raw CDP key events so shortcuts (Ctrl+A, Ctrl+V of 'type'd text, Enter, Tab...) behave natively. */
  private async dispatchKey(msg: KeyMessage): Promise<void> {
    const session = this.cdp;
    if (!session) return;
    const vk = virtualKeyCode(msg.key, msg.code);
    const location = keyLocation(msg.key, msg.code);
    // Computed for 'up' too, so a key's down and up carry the same modifiers.
    const text = keyText(msg.key, msg.text, msg.modifiers, { optionComposes: this.opts.macOptionText === true });
    const base = {
      modifiers: textModifiers(msg.modifiers, text),
      key: msg.key,
      code: msg.code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      location,
      isKeypad: location === 3,
    };
    if (msg.action === 'down') {
      await session.send('Input.dispatchKeyEvent', {
        type: text ? 'keyDown' : 'rawKeyDown',
        ...base,
        ...(text ? { text, unmodifiedText: text } : {}),
      });
    } else {
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    }
  }

  private async navigate(msg: NavMessage): Promise<void> {
    const page = this.current;
    if (page.isClosed()) return;
    try {
      if (msg.type === 'navigate') {
        const url = parseHttpUrl(msg.url, { allowBareHost: true });
        if (!url) {
          this.opts.send({ type: 'error', message: 'Only http:// and https:// addresses can be opened' });
          return;
        }
        const refused = await this.opts.checkUrl?.(url);
        if (refused) {
          this.opts.send({ type: 'error', message: refused });
          return;
        }
        if (this.stopped || page.isClosed()) return;
        await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      } else if (msg.type === 'back') {
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      } else {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      }
    } catch (err) {
      if (this.stopped || page.isClosed() || isNavigationInterrupted(err)) return;
      this.opts.send({ type: 'error', message: navErrorMessage(err) });
    }
  }
}
