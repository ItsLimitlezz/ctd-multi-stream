// Chatroom id lookup for Kick chat. The official API (docs.kick.com/apis/channels) doesn't expose
// the chatroom id the chat websocket needs, so we read kick.com's own (unofficial) channel endpoint,
// `GET https://kick.com/api/v2/channels/<slug>` → `{ id, chatroom: { id } }`. kick.com sits behind
// Cloudflare, which often blocks server-side requests: we try a plain fetch first and fall back to
// loading the URL in the account's Playwright context (a real Chromium passes the challenge).

import type { Page, Response } from 'playwright';
import type { BrowserManager } from '../../services.js';

export const KICK_WEB_CHANNEL_API = 'https://kick.com/api/v2/channels/';

const DIRECT_TIMEOUT_MS = 10_000;
const BROWSER_TIMEOUT_MS = 45_000;
// Cloudflare is less suspicious of a browser-like request than of the default undici agent.
const BROWSER_LIKE_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

export interface ChatroomInfo {
  chatroomId: number;
  channelId: number | null;
}

/** Thrown when Kick answered but the channel (or its chatroom) does not exist: retrying won't help soon. */
export class ChatroomNotFoundError extends Error {
  constructor(slug: string) {
    super(`Kick channel "${slug}" has no chatroom`);
    this.name = 'ChatroomNotFoundError';
  }
}

function positiveInt(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Parse the kick.com channel JSON. Null when it has no chatroom id. */
export function parseChatroomResponse(json: unknown): ChatroomInfo | null {
  if (typeof json !== 'object' || json === null) return null;
  const rec = json as { id?: unknown; chatroom?: { id?: unknown } | null };
  const chatroomId = positiveInt(rec.chatroom?.id);
  return chatroomId ? { chatroomId, channelId: positiveInt(rec.id) } : null;
}

export function channelApiUrl(slug: string, base = KICK_WEB_CHANNEL_API): string {
  return `${base}${encodeURIComponent(slug)}`;
}

/**
 * Plain HTTPS lookup. Returns null when the answer isn't usable JSON (Cloudflare challenge, 403,
 * 429, 5xx, network error) so the caller can try the browser. Throws ChatroomNotFoundError on 404.
 */
export async function fetchChatroomDirect(
  slug: string,
  opts: { signal: AbortSignal; base?: string; timeoutMs?: number },
): Promise<ChatroomInfo | null> {
  const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? DIRECT_TIMEOUT_MS)]);
  let res: globalThis.Response;
  let text: string;
  try {
    res = await fetch(channelApiUrl(slug, opts.base), { headers: BROWSER_LIKE_HEADERS, signal, redirect: 'follow' });
    text = await res.text();
  } catch (err) {
    if (opts.signal.aborted) throw err;
    return null;
  }
  if (res.status === 404) throw new ChatroomNotFoundError(slug);
  if (!res.ok) return null;
  try {
    const info = parseChatroomResponse(JSON.parse(text));
    if (!info) throw new ChatroomNotFoundError(slug);
    return info;
  } catch (err) {
    if (err instanceof ChatroomNotFoundError) throw err;
    return null; // HTML challenge page with a 200
  }
}

function isJsonResponse(res: Response): boolean {
  return /json/i.test(res.headers()['content-type'] ?? '');
}

/**
 * Load the channel JSON in a fresh tab of the account's browser context and wait for a JSON
 * answer, letting a Cloudflare challenge page reload itself into the real response.
 */
export async function fetchChatroomViaBrowser(
  browser: BrowserManager,
  accountId: string,
  slug: string,
  opts: { signal: AbortSignal; base?: string; timeoutMs?: number },
): Promise<ChatroomInfo> {
  const url = channelApiUrl(slug, opts.base);
  const target = new URL(url);
  const timeoutMs = opts.timeoutMs ?? BROWSER_TIMEOUT_MS;
  opts.signal.throwIfAborted();
  const context = await browser.context(accountId);
  let page: Page | null = null;
  let nav: Promise<unknown> | null = null;
  try {
    page = await context.newPage();
    const answer = page.waitForResponse(
      (res) => {
        const u = new URL(res.url());
        return u.origin === target.origin && u.pathname === target.pathname && (res.status() === 404 || isJsonResponse(res));
      },
      { timeout: timeoutMs },
    );
    answer.catch(() => {}); // observed below; never an unhandled rejection
    // A challenge page may abort/redirect this first navigation: only the response matters.
    const loading = page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});

    const res = await abortableWait(answer, opts.signal);
    nav = loading; // the answer arrived: its navigation is about to settle
    if (res.status() === 404) throw new ChatroomNotFoundError(slug);
    if (!res.ok()) throw new Error(`kick.com answered ${res.status()} for the channel lookup`);
    const info = parseChatroomResponse(await res.json());
    if (!info) throw new ChatroomNotFoundError(slug);
    return info;
  } finally {
    if (page) await closeTab(page, nav);
  }
}

/**
 * Close the tab, bounded. After an answer, first let its navigation settle: closing a tab while a
 * just-answered navigation commits can hang Playwright's close().
 */
async function closeTab(page: Page, nav: Promise<unknown> | null): Promise<void> {
  const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());
  if (nav) await Promise.race([nav, settle(5_000)]);
  await Promise.race([page.close().catch(() => {}), settle(5_000)]);
}

function abortableWait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** Lookups in flight per account + slug, so parallel chat sources share one browser visit. */
const inflight = new Map<string, Promise<ChatroomInfo>>();

/**
 * Direct fetch, then the browser. Closes the account's browser context afterwards (saving it keeps
 * the Cloudflare clearance cookie for next time); Kick accounts don't otherwise use the browser.
 */
export function lookupChatroom(
  slug: string,
  opts: { browser: BrowserManager; accountId: string; signal: AbortSignal; base?: string; browserTimeoutMs?: number },
): Promise<ChatroomInfo> {
  const key = `${opts.accountId}\u0000${slug.toLowerCase()}`;
  const existing = inflight.get(key);
  if (existing) return abortableWait(existing, opts.signal);

  const p = (async () => {
    const direct = await fetchChatroomDirect(slug, { signal: opts.signal, base: opts.base });
    if (direct) return direct;
    try {
      return await fetchChatroomViaBrowser(opts.browser, opts.accountId, slug, {
        signal: opts.signal,
        base: opts.base,
        timeoutMs: opts.browserTimeoutMs,
      });
    } finally {
      await opts.browser.close(opts.accountId, { save: true }).catch(() => {});
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
