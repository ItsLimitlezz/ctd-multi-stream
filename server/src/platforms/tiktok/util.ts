// Pure helpers for the TikTok driver (no Playwright), unit-tested in util.test.ts.

import { setTimeout as sleepTimer } from 'node:timers/promises';
import type { Account, Destination } from '../../../../shared/types.js';

export const DEFAULT_GO_LIVE_TIMEOUT_SEC = 90;
export const MIN_GO_LIVE_TIMEOUT_SEC = 15;
/** Stays below the orchestrator's confirm budget (180 s) so our own, clearer timeout fires first. */
export const MAX_GO_LIVE_TIMEOUT_SEC = 150;

const RTMP_RE = /^rtmps?:\/\/[^\s/?#]+\S*$/i;
const MASK_RE = /^[•●·∙⋅*]+$|[•●]{3,}/;
const USERNAME_RE = /^[A-Za-z0-9._]{2,24}$/;

export function isRtmpUrl(value: string): boolean {
  return RTMP_RE.test(value.trim());
}

/** A key shown as bullets/asterisks (needs a "show" click or the Copy button to read). */
export function isMaskedKey(value: string): boolean {
  return MASK_RE.test(value.trim());
}

/** Plausible stream key: one token, not a URL, not masked. */
export function looksLikeStreamKey(value: string): boolean {
  const v = value.trim();
  return v.length >= 6 && v.length <= 4096 && !/\s/.test(v) && !isRtmpUrl(v) && !isMaskedKey(v);
}

/** `<server>/<key>` with exactly one slash between them. */
export function joinRtmpUrl(server: string, key: string): string {
  return `${server.trim().replace(/\/+$/, '')}/${key.trim().replace(/^\/+/, '')}`;
}

/** Seconds to wait for TikTok to receive the video before giving up on "Go LIVE". */
export function goLiveTimeoutSec(dest: Pick<Destination, 'options'>, minSec = MIN_GO_LIVE_TIMEOUT_SEC): number {
  const n = parseOptionalNumber(dest.options.goLiveTimeoutSec);
  const sec = n !== null && Number.isFinite(n) ? n : DEFAULT_GO_LIVE_TIMEOUT_SEC;
  return Math.round(Math.min(MAX_GO_LIVE_TIMEOUT_SEC, Math.max(minSec, sec)));
}

// ---- Stream Guard options ----

export const DEFAULT_TAKEDOWN_CONFIRM_SEC = 5;
export const MIN_TAKEDOWN_CONFIRM_SEC = 2;
export const MAX_TAKEDOWN_CONFIRM_SEC = 60;
export const MAX_ZERO_VIEWER_SEC = 600;
/** Back-to-back failed recoveries before the runner gives up (Stream Guard's MAX_RECOVERY_ATTEMPTS). */
export const RECOVERY_MAX_ATTEMPTS = 3;

function clampSec(raw: unknown, fallback: number, min: number, max: number): number {
  const n = parseOptionalNumber(raw);
  const sec = n !== null && Number.isFinite(n) ? n : fallback;
  return Math.round(Math.min(max, Math.max(min, sec)));
}

/** "Auto-recover" option: on unless explicitly off. */
export function autoRecoverEnabled(dest: Pick<Destination, 'options'>): boolean {
  return parseOptionalBoolean(dest.options.autoRecover) !== false;
}

/** Push down this long (OBS still up) ⇒ takedown. Default 5 s, 2–60 s. */
export function takedownConfirmSec(dest: Pick<Destination, 'options'>): number {
  return clampSec(dest.options.takedownConfirmSec, DEFAULT_TAKEDOWN_CONFIRM_SEC, MIN_TAKEDOWN_CONFIRM_SEC, MAX_TAKEDOWN_CONFIRM_SEC);
}

/** 0 viewers this long ⇒ takedown. 0 = off (default), max 600 s. */
export function zeroViewerSec(dest: Pick<Destination, 'options'>): number {
  return clampSec(dest.options.zeroViewerSec, 0, 0, MAX_ZERO_VIEWER_SEC);
}

/** undefined/'' → null; booleans, 1/0 and 'true'/'false'/'on'/'off'/'yes'/'no' → boolean; anything else → 'invalid'. */
export function parseOptionalBoolean(raw: unknown): boolean | null | 'invalid' {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'boolean') return raw;
  if (raw === 1) return true;
  if (raw === 0) return false;
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === 'true' || v === 'on' || v === 'yes' || v === '1') return true;
    if (v === 'false' || v === 'off' || v === 'no' || v === '0') return false;
  }
  return 'invalid';
}

/**
 * A viewer count as TikTok shows it ("0", "12", "1,234", "1.2K", "3M", "1,2K") → number; anything
 * else (empty, "--", text) → null (unreadable: the 0-viewer rule never fires on it).
 */
export function parseViewerCount(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const m = /^\s*(\d+(?:[.,\s]\d+)*)\s*([kmb])?\+?\s*$/i.exec(raw);
  if (!m) return null;
  const digits = m[1]!.replace(/\s/g, '');
  const suffix = m[2]?.toLowerCase();
  let value: number;
  if (suffix) {
    // "1.2K" / "1,2K": the separator is a decimal point.
    const parts = digits.split(/[.,]/);
    if (parts.length > 2) return null;
    value = Number(parts.join('.')) * (suffix === 'k' ? 1e3 : suffix === 'm' ? 1e6 : 1e9);
  } else if (/^\d{1,3}(?:[.,]\d{3})+$/.test(digits)) {
    value = Number(digits.replace(/[.,]/g, '')); // thousands separators
  } else if (/^\d+$/.test(digits)) {
    value = Number(digits);
  } else {
    return null; // "1.5" viewers: not a count
  }
  return Number.isFinite(value) ? Math.round(value) : null;
}

/** undefined/'' → null; numbers and numeric strings → number; anything else → NaN. */
export function parseOptionalNumber(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : Number.NaN;
  return Number.isFinite(n) ? n : Number.NaN;
}

/** "@name" / "name" → "name" when it is a valid TikTok username. */
export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/^@/, '');
  return USERNAME_RE.test(name) ? name : null;
}

/** The account's TikTok username: stored on connect, else parsed from an "@name" label. */
export function accountUsername(account: Pick<Account, 'options' | 'label'>): string | null {
  const stored = normalizeUsername(account.options.username);
  if (stored) return stored;
  return account.label.trim().startsWith('@') ? normalizeUsername(account.label) : null;
}

export function watchUrlFor(username: string | null): string | null {
  return username ? `https://www.tiktok.com/@${username}/live` : null;
}

/** Scheme + host only (safe to log: ingest URLs embed nothing secret here, but paths/queries might). */
export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host ? `${u.protocol}//${u.host}` : u.protocol;
  } catch {
    return '[invalid url]';
  }
}

/** True when `url` is on the same host as `base` and under its path. */
export function isUnder(url: string, base: string): boolean {
  try {
    const u = new URL(url);
    const b = new URL(base);
    return u.host === b.host && u.pathname.replace(/\/+$/, '').startsWith(b.pathname.replace(/\/+$/, ''));
  } catch {
    return false;
  }
}

export function sameHost(url: string, base: string): boolean {
  try {
    return new URL(url).host === new URL(base).host;
  } catch {
    return false;
  }
}

export function isLoginUrl(url: string): boolean {
  try {
    return /^\/login(?:\/|$)/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** User-facing text for a failed navigation (no URLs). */
export function navErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const net = /net::ERR_[A-Z0-9_]+/.exec(raw);
  if (net) return `the page could not be loaded (${net[0]})`;
  if ((err instanceof Error && err.name === 'TimeoutError') || /Timeout \d+ms exceeded/i.test(raw)) {
    return 'the page took too long to load';
  }
  return 'the page could not be loaded';
}

/** "A newer navigation replaced this one" (e.g. a redirect to the login page). */
export function isNavigationInterrupted(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return /interrupted by another navigation|net::ERR_ABORTED|frame was detached/i.test(raw);
}

/** Abortable sleep (rejects with an AbortError when `signal` aborts). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return sleepTimer(Math.max(0, ms), undefined, signal ? { signal } : undefined);
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
