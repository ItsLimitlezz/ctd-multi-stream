// Helpers for browser-driven platform drivers (Instagram, TikTok, X, Facebook profile).
// Keep this API small and stable: drivers built by other modules depend on it.

import { createHash, randomBytes } from 'node:crypto';
import vm from 'node:vm';
import type { Locator, Page } from 'playwright';
import { DriverError, type ChatMessageInput } from '../platforms/types.js';

// ---------------------------------------------------------------------------
// Promise utilities
// ---------------------------------------------------------------------------

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException('The operation was aborted', 'AbortError');
}

/** Sleep for `ms`, rejecting early with the abort reason when `signal` aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function randomInt(min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * Race `promise` against `signal`: rejects with the abort reason as soon as the signal aborts.
 * The underlying operation is not cancelled (Playwright calls can't be), only no longer awaited;
 * its eventual rejection is swallowed so it never becomes an unhandled rejection.
 */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** Reject with `DriverError(message, 'timeout')` if `promise` does not settle within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DriverError(message, 'timeout')), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Random human-like pause between actions. Rejects with the abort reason if `signal` aborts. */
export function humanPause(minMs = 300, maxMs = 900, signal?: AbortSignal): Promise<void> {
  return delay(randomInt(minMs, maxMs), signal);
}

// ---------------------------------------------------------------------------
// Locator helpers
// ---------------------------------------------------------------------------

async function isVisible(locator: Locator): Promise<boolean> {
  try {
    return await locator.filter({ visible: true }).first().isVisible();
  } catch {
    return false; // detached / navigating
  }
}

function assertPageOpen(page: Page): void {
  if (page.isClosed()) throw new DriverError('The browser page was closed', 'platform-error');
}

/**
 * Wait until one of several locators is visible and return its key (first key wins when several
 * are visible). Useful to branch on "logged in" vs "login form" vs "error banner".
 * Throws `DriverError(..., 'timeout')` after `timeoutMs`, or the abort reason when `signal` aborts.
 */
export async function waitForAny(
  page: Page,
  candidates: Record<string, Locator>,
  opts: { timeoutMs: number; signal?: AbortSignal; pollMs?: number },
): Promise<string> {
  const entries = Object.entries(candidates);
  if (entries.length === 0) throw new Error('waitForAny: no candidates');
  const pollMs = Math.max(50, opts.pollMs ?? 200);
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    opts.signal?.throwIfAborted();
    assertPageOpen(page);
    for (const [key, locator] of entries) {
      if (await isVisible(locator)) return key;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new DriverError(
        `Timed out after ${Math.round(opts.timeoutMs / 1000)} s waiting for the page (expected: ${entries.map(([k]) => k).join(', ')})`,
        'timeout',
      );
    }
    await delay(Math.min(pollMs, left), opts.signal);
  }
}

/**
 * Wait until the element is visible and enabled (including aria-disabled), pause briefly like a
 * person would, then click it. If the locator matches several elements, the first visible one is used.
 * `what` names the element in the timeout error (e.g. 'the "Go live" button').
 */
export async function clickWhenEnabled(
  locator: Locator,
  opts: { timeoutMs: number; signal?: AbortSignal; what?: string },
): Promise<void> {
  const target = locator.filter({ visible: true }).first();
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    opts.signal?.throwIfAborted();
    const ready = (await isVisible(target)) && (await target.isEnabled({ timeout: 1000 }).catch(() => false));
    if (ready) break;
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new DriverError(`Timed out waiting for ${opts.what ?? 'a button'} to become clickable`, 'timeout');
    }
    await delay(Math.min(200, left), opts.signal);
  }
  await humanPause(80, 250, opts.signal);
  await abortable(target.click({ timeout: Math.max(2000, deadline - Date.now()), delay: randomInt(30, 90) }), opts.signal);
}

async function currentValue(locator: Locator): Promise<string> {
  return locator
    .evaluate((el) => {
      const e = el as unknown as { value?: unknown; innerText?: unknown; textContent?: unknown };
      if (typeof e.value === 'string') return e.value;
      if (typeof e.innerText === 'string') return e.innerText;
      return typeof e.textContent === 'string' ? e.textContent : '';
    })
    .catch(() => '');
}

/**
 * Focus a text field (input, textarea or contenteditable), clear it and type `value` one character
 * at a time with small random delays (default 30–110 ms per character).
 */
export async function fillField(
  locator: Locator,
  value: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; minDelayMs?: number; maxDelayMs?: number } = {},
): Promise<void> {
  const timeout = opts.timeoutMs ?? 15_000;
  const target = locator.filter({ visible: true }).first();
  await abortable(target.click({ timeout }), opts.signal);
  await humanPause(80, 200, opts.signal);
  await abortable(target.fill('', { timeout }), opts.signal);
  if ((await currentValue(target)).trim() !== '') {
    // Some editors ignore fill(''); fall back to select-all + delete.
    await target.press('ControlOrMeta+A', { timeout });
    await target.press('Backspace', { timeout });
  }
  for (const ch of value) {
    opts.signal?.throwIfAborted();
    await target.pressSequentially(ch, { timeout });
    await delay(randomInt(opts.minDelayMs ?? 30, opts.maxDelayMs ?? 110), opts.signal);
  }
}

/**
 * Read a value shown on the page: an input/textarea/select value, a single input inside the
 * element (e.g. a "Stream key" field wrapper), or otherwise the element's visible text. Trimmed.
 */
export async function readTextValue(locator: Locator, opts: { timeoutMs?: number } = {}): Promise<string> {
  const value = await locator.first().evaluate(
    (el) => {
      type Node = {
        tagName?: string;
        value?: unknown;
        innerText?: unknown;
        textContent?: unknown;
        querySelector?: (s: string) => Node | null;
      };
      const e = el as unknown as Node;
      const tag = String(e.tagName ?? '').toLowerCase();
      if ((tag === 'input' || tag === 'textarea' || tag === 'select') && typeof e.value === 'string') return e.value;
      const text = typeof e.innerText === 'string' ? e.innerText : typeof e.textContent === 'string' ? e.textContent : '';
      if (text.trim()) return text;
      const inner = e.querySelector?.('input, textarea');
      return inner && typeof inner.value === 'string' ? inner.value : text;
    },
    undefined,
    { timeout: opts.timeoutMs ?? 10_000 },
  );
  return String(value).trim();
}

/**
 * Throw `DriverError('<Platform> session expired — log in again from Accounts', 'needs-login')`
 * when `isLoggedIn()` resolves false. Errors thrown by `isLoggedIn` propagate unchanged.
 */
export async function requireLoggedIn(page: Page, isLoggedIn: () => Promise<boolean>, platformName: string): Promise<void> {
  assertPageOpen(page);
  if (!(await isLoggedIn())) {
    throw new DriverError(`${platformName} session expired — log in again from Accounts`, 'needs-login');
  }
}

// ---------------------------------------------------------------------------
// Chat scraping
// ---------------------------------------------------------------------------

/** What the `extract` function returns for one chat item (null/undefined = skip for now, retried later). */
export interface ChatExtractResult {
  /** Stable platform message id, if the DOM exposes one (best dedupe key). */
  id?: string | number | null;
  author: string;
  text: string;
  color?: string;
  avatarUrl?: string;
  badges?: string[];
  kind?: 'message' | 'event';
  /** A "<name> joined" presence line (with kind 'event'). */
  join?: boolean;
}

export interface ScrapeChatOptions {
  /** Element that contains the chat list. Default: the whole document. */
  containerSelector?: string;
  /** CSS selector matching one chat item inside the container. */
  itemSelector: string;
  /**
   * Plain JavaScript function source run in the page for each item element:
   * `(el) => ({ id?, author, text, color?, avatarUrl?, badges?, kind? }) | null`.
   * Must be self-contained (no closures over Node variables). Pass a string, not a TS function,
   * so bundler helpers never leak into the page.
   */
  extract: string;
  /** Poll interval. Default 1000 ms (minimum 200). */
  pollMs?: number;
}

interface ScannedItem {
  id: string | null;
  author: string;
  text: string;
  color: string | null;
  avatarUrl: string | null;
  badges: string[] | null;
  kind: 'message' | 'event';
  join: boolean;
  occ: number;
}

interface ScanResult {
  found: boolean;
  /** First scan that found the container in this document (initial load or after navigation). */
  firstFound: boolean;
  /** document.readyState is 'complete'. */
  ready: boolean;
  items: ScannedItem[];
}

// Runs in the page (kept as a plain JS string so no transpiler helpers end up inside it).
// Each item element is extracted once (cached in a WeakMap); elements already reported are
// remembered in a WeakSet so only new elements are returned. `occ` = how many earlier items in
// the current list have the same author + text (position part of the fallback dedupe key).
const SCAN_SOURCE = `(args, extract) => {
  const w = window;
  let st = w[args.stateKey];
  if (!st) {
    st = { seen: new WeakSet(), cache: new WeakMap(), baselined: false };
    Object.defineProperty(w, args.stateKey, { value: st, configurable: true, enumerable: false });
  }
  const root = args.container ? document.querySelector(args.container) : document;
  const ready = document.readyState === 'complete';
  if (!root) return { found: false, firstFound: false, ready: ready, items: [] };
  const firstFound = !st.baselined;
  st.baselined = true;
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const counts = new Map();
  const items = [];
  for (const el of root.querySelectorAll(args.item)) {
    let data = st.cache.get(el);
    if (!data) {
      let r = null;
      try { r = extract(el); } catch (e) { r = null; }
      const text = r ? str(r.text) : '';
      if (!text) continue;
      const author = typeof r.author === 'string' ? r.author.trim() : str(r.author && r.author.name);
      data = {
        id: r.id === undefined || r.id === null || r.id === '' ? null : String(r.id),
        author: author,
        text: text,
        color: str(r.color) || null,
        avatarUrl: str(r.avatarUrl) || null,
        badges: Array.isArray(r.badges) ? r.badges.filter((b) => typeof b === 'string').slice(0, 10) : null,
        kind: r.kind === 'event' ? 'event' : 'message',
        join: r.kind === 'event' && r.join === true,
      };
      st.cache.set(el, data);
    }
    const ck = data.author + '\\u0000' + data.text;
    const occ = counts.get(ck) || 0;
    counts.set(ck, occ + 1);
    if (!st.seen.has(el)) {
      st.seen.add(el);
      items.push(Object.assign({}, data, { occ: occ }));
    }
  }
  return { found: true, firstFound: firstFound, ready: ready, items: items };
}`;

const MAX_SEEN_KEYS = 5000;
/** Longest wait for a still-loading page before its empty chat container is taken as empty. */
const MAX_SETTLE_MS = 10_000;
const MAX_TEXT = 2000;

class BoundedSet {
  private readonly set = new Set<string>();
  constructor(private readonly max: number) {}
  has(key: string): boolean {
    return this.set.has(key);
  }
  add(key: string): void {
    this.set.add(key);
    if (this.set.size > this.max) {
      const oldest = this.set.values().next().value;
      if (oldest !== undefined) this.set.delete(oldest);
    }
  }
}

function itemKey(item: ScannedItem): string {
  if (item.id) return `i:${item.id}`;
  const h = createHash('sha1').update(`${item.author}\u0000${item.text}\u0000${item.occ}`).digest('hex');
  return `c:${h.slice(0, 20)}`;
}

function toChatInput(item: ScannedItem): ChatMessageInput {
  const author: ChatMessageInput['author'] = { name: item.author.slice(0, 100) || 'Unknown' };
  if (item.color) author.color = item.color;
  if (item.avatarUrl) author.avatarUrl = item.avatarUrl;
  if (item.badges?.length) author.badges = item.badges;
  const msg: ChatMessageInput = {
    author,
    text: item.text.slice(0, MAX_TEXT),
    ts: new Date().toISOString(),
    kind: item.kind,
  };
  if (item.id) msg.id = item.id;
  if (item.join) msg.join = true;
  return msg;
}

/**
 * Generic DOM chat scraper. Polls the page every `pollMs` and yields only messages that appear
 * after it starts (whatever is already on screen when the chat container is first found is
 * skipped; an empty container found while the page is still loading is re-checked once it has
 * loaded, so a backlog rendered during the load is not replayed). Dedupes by stable `id` when `extract` returns one, else by author + text + position.
 * Navigation errors and reloads are survived (messages already seen are not re-yielded after a
 * reload). Ends quietly when `signal` aborts; throws if the page is closed or `extract` is not
 * valid JavaScript (so the ChatHub can restart the source with a fresh page).
 */
export async function* scrapeChat(page: Page, opts: ScrapeChatOptions, signal: AbortSignal): AsyncGenerator<ChatMessageInput> {
  try {
    new vm.Script(`(${opts.extract})`); // syntax check only, never run in Node
  } catch (err) {
    throw new Error(`scrapeChat: extract is not valid JavaScript (${err instanceof Error ? err.message : String(err)})`);
  }
  const pollMs = Math.max(200, opts.pollMs ?? 1000);
  const args = {
    stateKey: `__ctdChat_${randomBytes(6).toString('hex')}`,
    container: opts.containerSelector ?? null,
    item: opts.itemSelector,
  };
  const expression = `(${SCAN_SOURCE})(${JSON.stringify(args)}, (${opts.extract}))`;
  const seen = new BoundedSet(MAX_SEEN_KEYS);
  let baselined = false;
  let settleDeadline: number | null = null;

  while (!signal.aborted) {
    if (page.isClosed()) throw new DriverError('The chat page was closed', 'platform-error');
    let result: ScanResult | null = null;
    try {
      const evaluation = page.evaluate(expression) as Promise<ScanResult>;
      result = await abortable(withTimeout(evaluation, 15_000, 'Chat scan timed out'), signal);
    } catch {
      if (signal.aborted) return;
      // Navigation in progress, context destroyed, slow page: try again on the next tick.
    }

    if (result?.found && !baselined && result.items.length === 0 && !result.ready) {
      // The container exists but the page is still loading, so the existing comments may not have
      // rendered yet (a restarted source re-opening the page): an empty baseline now would replay
      // them all as new. Wait for the load to finish (bounded).
      settleDeadline ??= Date.now() + MAX_SETTLE_MS;
      if (Date.now() >= settleDeadline) baselined = true;
    } else if (result?.found) {
      const fresh: ChatMessageInput[] = [];
      for (const item of result.items) {
        const key = itemKey(item);
        if (!baselined) {
          seen.add(key);
          continue;
        }
        // Stable ids are always deduped; content keys only right after a reload/navigation
        // (within one document, a new element is a new message even if the text repeats).
        if ((item.id || result.firstFound) && seen.has(key)) continue;
        seen.add(key);
        fresh.push(toChatInput(item));
      }
      baselined = true;
      for (const msg of fresh) {
        if (signal.aborted) return;
        yield msg;
      }
    }

    try {
      await delay(pollMs, signal);
    } catch {
      return;
    }
  }
}
