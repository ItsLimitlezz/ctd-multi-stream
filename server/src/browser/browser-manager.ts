// Shared Playwright Chromium with one BrowserContext per platform account. Sessions (cookies,
// localStorage, IndexedDB) are persisted encrypted in secrets scope 'browser:<accountId>'.

import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type LaunchOptions, type Page } from 'playwright';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { BrowserManager, SecretsRepo } from '../services.js';
import { nonPublicHostReason, type HostLookup } from './egress.js';
import { withTimeout } from './helpers.js';
import { safeErrorMessage } from './util.js';

export interface BrowserManagerDeps {
  config: AppConfig;
  log: Logger;
  secrets: SecretsRepo;
  /** Let the login viewer open loopback/LAN hosts (tests only; default false). */
  allowPrivateNetwork?: boolean;
  /** Name resolution for the viewer's host check (tests). */
  lookup?: HostLookup;
}

type StorageState = Exclude<NonNullable<BrowserContextOptions['storageState']>, string>;

interface Entry {
  context: BrowserContext;
  autosave: NodeJS.Timeout;
}

const STORAGE_KEY = 'storageState';
const AUTOSAVE_MS = 5 * 60_000;
const SAVE_TIMEOUT_MS = 20_000;
const SHUTDOWN_SAVE_TIMEOUT_MS = 8_000;
const SHUTDOWN_CLOSE_TIMEOUT_MS = 5_000;
const NAV_TIMEOUT_MS = 45_000;
const ACTION_TIMEOUT_MS = 30_000;
const LAUNCH_TIMEOUT_MS = 60_000;
const VIEWPORT = { width: 1280, height: 800 };

// Keep this tiny: patch only what differs from a regular Chrome, and only when it differs
// (an unconditional getter override is itself detectable).
const INIT_SCRIPT = `(() => {
  try {
    if (navigator.webdriver) {
      Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });
    }
  } catch (e) {}
  try {
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', { value: { runtime: {} }, configurable: true, writable: true });
    }
  } catch (e) {}
})();`;

function launchArgs(): string[] {
  const args = ['--disable-blink-features=AutomationControlled'];
  if (process.env.CTD_IN_CONTAINER === '1' || process.getuid?.() === 0) {
    args.push('--no-sandbox', '--disable-dev-shm-usage');
  }
  return args;
}

/** Desktop Chrome UA for this OS (keeps UA and navigator.platform consistent; no "HeadlessChrome"). */
export function desktopUserAgent(browserVersion: string, platform: NodeJS.Platform = process.platform): string {
  const major = /^(\d+)/.exec(browserVersion)?.[1] ?? '140';
  const os =
    platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** Run async work one at a time per key (no duplicate contexts, no overlapping saves). */
function createKeyedLock() {
  const tails = new Map<string, Promise<void>>();
  return async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail = run.then(
      () => {},
      () => {},
    );
    tails.set(key, tail);
    try {
      return await run;
    } finally {
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

export function createBrowserManager({ config, log, secrets, allowPrivateNetwork = false, lookup }: BrowserManagerDeps): BrowserManager {
  const entries = new Map<string, Entry>();
  const withLock = createKeyedLock();
  let browserPromise: Promise<Browser> | null = null;
  let shutDown = false;

  const scope = (accountId: string) => secrets.scoped(`browser:${accountId}`);

  async function launch(): Promise<Browser> {
    const opts: LaunchOptions = {
      headless: config.browserHeadless,
      args: launchArgs(),
      // Removes the "controlled by automated software" switch (and its navigator.webdriver side effect).
      ignoreDefaultArgs: ['--enable-automation'],
      timeout: LAUNCH_TIMEOUT_MS,
    };
    if (!config.browserHeadless) return chromium.launch(opts);
    try {
      // Full Chromium in new headless mode looks like a regular browser; the headless shell
      // does not. https://playwright.dev/docs/browsers#chromium-new-headless-mode
      return await chromium.launch({ ...opts, channel: 'chromium' });
    } catch (err) {
      log.warn({ err: safeErrorMessage(err) }, 'full Chromium unavailable, falling back to the headless shell');
      return chromium.launch(opts);
    }
  }

  async function getBrowser(): Promise<Browser> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!browserPromise) {
        const p = launch().then((browser) => {
          browser.on('disconnected', () => {
            if (browserPromise === p) browserPromise = null;
            for (const entry of entries.values()) clearInterval(entry.autosave);
            entries.clear();
            if (!shutDown) log.warn('Chromium disconnected; it will be relaunched on next use');
          });
          log.info({ version: browser.version(), headless: config.browserHeadless }, 'Chromium launched');
          return browser;
        });
        browserPromise = p;
        p.catch(() => {
          if (browserPromise === p) browserPromise = null;
        });
      }
      const browser = await browserPromise;
      if (browser.isConnected()) return browser;
      browserPromise = null;
    }
    throw new Error('Chromium could not be started');
  }

  async function loadState(accountId: string): Promise<StorageState | undefined> {
    const raw = await scope(accountId).get(STORAGE_KEY);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as StorageState;
      if (!parsed || !Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) throw new Error('bad shape');
      return parsed;
    } catch {
      log.warn({ accountId }, 'saved browser session is unreadable; starting a fresh session');
      return undefined;
    }
  }

  async function newContext(browser: Browser, accountId: string): Promise<BrowserContext> {
    const options: BrowserContextOptions = {
      viewport: VIEWPORT,
      screen: VIEWPORT,
      deviceScaleFactor: 1,
      locale: 'en-US',
      userAgent: desktopUserAgent(browser.version()),
      acceptDownloads: false,
    };
    const state = await loadState(accountId);
    let context: BrowserContext;
    try {
      context = await browser.newContext({ ...options, ...(state ? { storageState: state } : {}) });
    } catch (err) {
      if (!state) throw err;
      log.warn({ accountId, err: safeErrorMessage(err) }, 'could not restore browser session; starting a fresh session');
      context = await browser.newContext(options);
    }
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    await context.addInitScript(INIT_SCRIPT);
    return context;
  }

  /** Get or create the account's context. Call only inside withLock(accountId). */
  async function openContext(accountId: string): Promise<BrowserContext> {
    if (shutDown) throw new Error('Browser manager is shut down');
    const existing = entries.get(accountId);
    if (existing) return existing.context;

    const browser = await getBrowser();
    const context = await newContext(browser, accountId);
    const autosave = setInterval(() => {
      withLock(accountId, () => saveUnlocked(accountId)).catch((err: unknown) =>
        log.warn({ accountId, err: safeErrorMessage(err) }, 'browser session auto-save failed'),
      );
    }, AUTOSAVE_MS);
    autosave.unref();
    entries.set(accountId, { context, autosave });
    context.on('close', () => {
      const entry = entries.get(accountId);
      if (entry?.context === context) {
        clearInterval(entry.autosave);
        entries.delete(accountId);
      }
    });
    log.info({ accountId }, 'browser context opened');
    return context;
  }

  /** Persist the open context's storage state. No-op when the account has no open context. */
  async function saveUnlocked(accountId: string, timeoutMs = SAVE_TIMEOUT_MS): Promise<void> {
    const entry = entries.get(accountId);
    if (!entry) return;
    const state = await withTimeout(
      entry.context.storageState({ indexedDB: true }),
      timeoutMs,
      'Saving the browser session timed out',
    );
    await scope(accountId).set(STORAGE_KEY, JSON.stringify(state));
    log.debug({ accountId }, 'browser session saved');
  }

  async function closeUnlocked(accountId: string, save: boolean, saveTimeoutMs = SAVE_TIMEOUT_MS): Promise<void> {
    const entry = entries.get(accountId);
    if (!entry) return;
    if (save) {
      await saveUnlocked(accountId, saveTimeoutMs).catch((err: unknown) =>
        log.warn({ accountId, err: safeErrorMessage(err) }, 'could not save browser session before closing'),
      );
    }
    clearInterval(entry.autosave);
    entries.delete(accountId);
    await entry.context.close().catch(() => {});
    log.info({ accountId, saved: save }, 'browser context closed');
  }

  async function page(accountId: string, url?: string): Promise<Page> {
    const p = await withLock(accountId, async () => {
      const context = await openContext(accountId);
      return context.pages().find((candidate) => !candidate.isClosed()) ?? (await context.newPage());
    });
    if (url) await p.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    return p;
  }

  return {
    context: (accountId) => withLock(accountId, () => openContext(accountId)),
    page,
    viewerPage: page,
    checkViewerUrl: (url) => nonPublicHostReason(url, { allowPrivateNetwork, ...(lookup ? { lookup } : {}) }),
    save: (accountId) => withLock(accountId, () => saveUnlocked(accountId)),

    async hasSavedSession(accountId) {
      return (await scope(accountId).get(STORAGE_KEY)) !== null;
    },

    /** Close the account's context. Saves first only when `opts.save` is true. */
    close: (accountId, opts) => withLock(accountId, () => closeUnlocked(accountId, opts?.save === true)),

    async clear(accountId) {
      await withLock(accountId, async () => {
        await closeUnlocked(accountId, false);
        secrets.deleteScope(`browser:${accountId}`);
      });
      log.info({ accountId }, 'browser session cleared');
    },

    async shutdown() {
      if (shutDown) return;
      shutDown = true;
      await Promise.all(
        [...entries.keys()].map((accountId) =>
          // Short save timeout: the process force-exits 15 s after SIGTERM.
          withTimeout(
            withLock(accountId, () => closeUnlocked(accountId, true, SHUTDOWN_SAVE_TIMEOUT_MS)),
            SHUTDOWN_SAVE_TIMEOUT_MS + SHUTDOWN_CLOSE_TIMEOUT_MS,
            'Closing the browser context timed out',
          ).catch((err: unknown) =>
            log.warn({ accountId, err: safeErrorMessage(err) }, 'error closing browser context'),
          ),
        ),
      );
      const pending = browserPromise;
      browserPromise = null;
      if (pending) {
        // Bounded: a wedged Chromium must not hold up process exit (the force-exit is 15 s after SIGTERM).
        await withTimeout(
          pending.then((browser) => browser.close()),
          SHUTDOWN_CLOSE_TIMEOUT_MS,
          'Closing Chromium timed out',
        ).catch((err: unknown) => log.warn({ err: safeErrorMessage(err) }, 'could not close Chromium cleanly'));
      }
    },
  };
}
