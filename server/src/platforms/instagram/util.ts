// Pure helpers for the Instagram driver (no browser access; unit-tested).

import { LINK_TITLE_MAX, LINKS_MAX, type Destination, type LinkItem } from '../../../../shared/types.js';
import { truncateTitle } from '../common/http.js';
import { RE } from './selectors.js';

export type Audience = 'public' | 'practice';
/** off = no link; rotate = next link on every new live (cycling); first = always the first link. */
export type LinkMode = 'off' | 'rotate' | 'first';

export interface InstagramOptions {
  audience: Audience;
  goLiveTimeoutSec: number;
  /** Start a new live automatically when Instagram ends this one (Stream Guard). */
  autoRecover: boolean;
  /** Push down this long while the OBS feed is up ⇒ takedown. */
  takedownConfirmSec: number;
  /** Public only: 0 viewers this long ⇒ takedown. 0 = off. */
  zeroViewerSec: number;
  links: LinkItem[];
  linkMode: LinkMode;
}

export const DEFAULT_GO_LIVE_TIMEOUT_SEC = 90;
/** The orchestrator gives confirm() 180 s in total; leave room for the click and the live check. */
export const MIN_GO_LIVE_TIMEOUT_SEC = 15;
export const MAX_GO_LIVE_TIMEOUT_SEC = 150;

/** Stream Guard's DOWN_CONFIRM_SECONDS. */
export const DEFAULT_TAKEDOWN_CONFIRM_SEC = 5;
export const MIN_TAKEDOWN_CONFIRM_SEC = 2;
export const MAX_TAKEDOWN_CONFIRM_SEC = 60;
/** Off by default; Stream Guard (DPRTMNT) uses 5. */
export const DEFAULT_ZERO_VIEWER_SEC = 0;
export const MAX_ZERO_VIEWER_SEC = 600;
/** Stream Guard's MAX_RECOVERY_ATTEMPTS. */
export const MAX_RECOVERY_ATTEMPTS = 3;
/** Longest link URL accepted (same limit as the destination API). */
export const LINK_URL_MAX = 2048;

/**
 * Instagram does not document a limit for live titles. Used when the title field has no
 * `maxlength`; the field's own limit wins when it is smaller.
 */
export const TITLE_MAX = 100;

function toNumber(raw: unknown): number {
  return typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
}

/** A number option rounded and clamped to [min, max]; `fallback` when missing or not a number. */
function clampedOption(raw: unknown, min: number, max: number, fallback: number): number {
  const n = toNumber(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function booleanOption(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === 1 || raw === '1') return true;
  if (raw === 'false' || raw === 0 || raw === '0') return false;
  return fallback;
}

/** An absolute http(s) URL (no spaces, ≤ LINK_URL_MAX), else null. */
export function linkUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > LINK_URL_MAX || /\s/.test(value)) return null;
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname !== '' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The destination's link list (a 'links' option: `LinkItem[]`). Invalid entries are skipped (the
 * API validates the list when it is saved), titles are trimmed to LINK_TITLE_MAX, at most LINKS_MAX.
 */
export function readLinks(raw: unknown): LinkItem[] {
  if (!Array.isArray(raw)) return [];
  const links: LinkItem[] = [];
  for (const item of raw) {
    if (links.length >= LINKS_MAX) break;
    if (!item || typeof item !== 'object') continue;
    const { title, url } = item as { title?: unknown; url?: unknown };
    const href = linkUrl(url);
    if (!href) continue;
    const text = typeof title === 'string' ? truncateTitle(title.replace(/\s+/g, ' '), LINK_TITLE_MAX) : '';
    links.push({ title: text, url: href });
  }
  return links;
}

export function readOptions(dest: Pick<Destination, 'options'>): InstagramOptions {
  const o = dest.options;
  const audience: Audience = o.audience === 'practice' ? 'practice' : 'public';
  const linkMode: LinkMode = o.linkMode === 'off' || o.linkMode === 'first' ? o.linkMode : 'rotate';
  return {
    audience,
    goLiveTimeoutSec: clampedOption(o.goLiveTimeoutSec, MIN_GO_LIVE_TIMEOUT_SEC, MAX_GO_LIVE_TIMEOUT_SEC, DEFAULT_GO_LIVE_TIMEOUT_SEC),
    autoRecover: booleanOption(o.autoRecover, true),
    takedownConfirmSec: clampedOption(
      o.takedownConfirmSec,
      MIN_TAKEDOWN_CONFIRM_SEC,
      MAX_TAKEDOWN_CONFIRM_SEC,
      DEFAULT_TAKEDOWN_CONFIRM_SEC,
    ),
    zeroViewerSec: clampedOption(o.zeroViewerSec, 0, MAX_ZERO_VIEWER_SEC, DEFAULT_ZERO_VIEWER_SEC),
    links: readLinks(o.links),
    linkMode,
  };
}

/**
 * Options for one live. Session test mode always uses the Practice audience (only the account
 * sees the live), whatever the destination's audience option says — also for Stream Guard
 * recoveries, which call prepare() again with the same context. Practice also turns off the
 * zero-viewer rule.
 */
export function readLiveOptions(dest: Pick<Destination, 'options'>, testMode = false): InstagramOptions {
  const options = readOptions(dest);
  return testMode ? { ...options, audience: 'practice' } : options;
}

/** Rotation position persisted per destination (destinationSecrets key LINK_ROTATION_KEY). */
export const LINK_ROTATION_KEY = 'linkRotation';
export interface LinkRotation {
  index: number;
}

/**
 * The link for the next live and the rotation index to store once it was added (null = nothing
 * to store). `storedIndex` is the persisted position (any integer; missing/garbage = 0).
 */
export function pickLink(
  links: LinkItem[],
  mode: LinkMode,
  storedIndex: unknown,
): { link: LinkItem; nextIndex: number | null } | null {
  if (mode === 'off' || links.length === 0) return null;
  if (mode === 'first') return { link: links[0]!, nextIndex: null };
  const raw = typeof storedIndex === 'number' && Number.isFinite(storedIndex) ? Math.trunc(storedIndex) : 0;
  const i = ((raw % links.length) + links.length) % links.length;
  return { link: links[i]!, nextIndex: i + 1 };
}

/**
 * Viewer count as Instagram shows it ("0", "12", "1,234", "1.2K", "3M") → number; null when the
 * text is not a count.
 */
export function parseViewerCount(text: string | null | undefined): number | null {
  const m = /^\s*(\d{1,3}(?:[,\s.]\d{3})+|\d+(?:[.,]\d+)?)\s*([KkMm])?\s*$/.exec(text ?? '');
  if (!m) return null;
  const [, digits = '', suffix] = m;
  if (suffix) {
    const n = Number(digits.replace(',', '.'));
    if (!Number.isFinite(n)) return null;
    return Math.round(n * (suffix.toLowerCase() === 'k' ? 1_000 : 1_000_000));
  }
  // "1,234" / "1.234" / "1 234" are thousands separators; "1.5" without suffix is not a count.
  if (/^\d+[.,]\d{1,2}$/.test(digits)) return null;
  const n = Number(digits.replace(/[,\s.]/g, ''));
  return Number.isSafeInteger(n) ? n : null;
}

/** Problems with the destination's options ([] = OK). */
export function optionProblems(dest: Pick<Destination, 'options'>): string[] {
  const problems: string[] = [];
  const audience = dest.options.audience;
  if (audience !== undefined && audience !== 'public' && audience !== 'practice') {
    problems.push('Audience must be Public or Practice');
  }
  const raw = dest.options.goLiveTimeoutSec;
  if (raw !== undefined && raw !== null && raw !== '') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n) || n < MIN_GO_LIVE_TIMEOUT_SEC || n > MAX_GO_LIVE_TIMEOUT_SEC) {
      problems.push(`Go-live timeout must be between ${MIN_GO_LIVE_TIMEOUT_SEC} and ${MAX_GO_LIVE_TIMEOUT_SEC} seconds`);
    }
  }
  return problems;
}

/** Title as typed into Instagram: trimmed, at most `fieldMax` (the input's maxlength) / TITLE_MAX. */
export function instagramTitle(title: string, fieldMax?: number | null): string {
  const max = fieldMax && fieldMax > 0 ? Math.min(fieldMax, TITLE_MAX) : TITLE_MAX;
  return truncateTitle(title.replace(/\s+/g, ' '), max);
}

export function isStreamServerUrl(value: string): boolean {
  if (/\s/.test(value)) return false;
  try {
    const u = new URL(value);
    return (u.protocol === 'rtmps:' || u.protocol === 'rtmp:') && u.hostname !== '';
  } catch {
    return false;
  }
}

/** A plausible stream key: no whitespace, not a URL, not a masked placeholder ("••••"). */
export function isStreamKey(value: string): boolean {
  return /^\S{8,2048}$/.test(value) && !/^rtmps?:/i.test(value) && !isMasked(value);
}

export function isMasked(value: string): boolean {
  return /^[•●∙·*•●]+$/.test(value.trim());
}

/**
 * Full push URL: Instagram shows the server as `rtmps://<host>:443/rtmp/` and a key that goes
 * right after it (the key may carry its own `?query`). Joined with exactly one slash.
 */
export function joinStreamUrl(server: string, key: string): string {
  return `${server.trim().replace(/\/+$/, '')}/${key.trim().replace(/^\/+/, '')}`;
}

const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;
const RESERVED_PATHS = new Set(['accounts', 'explore', 'reels', 'direct', 'stories', 'p', 'reel', 'live', 'about', 'legal', 'developer']);

/** Username from a profile link href ("/name/" or "https://www.instagram.com/name/"). */
export function usernameFromHref(href: string | null | undefined): string | null {
  if (!href) return null;
  let path = href;
  try {
    path = new URL(href, 'https://www.instagram.com').pathname;
  } catch {
    return null;
  }
  const parts = path.split('/').filter(Boolean);
  const first = parts[0];
  if (parts.length !== 1 || !first || RESERVED_PATHS.has(first.toLowerCase())) return null;
  return USERNAME_RE.test(first) ? first : null;
}

/** Username from an avatar alt text ("name's profile picture"). */
export function usernameFromAlt(alt: string | null | undefined): string | null {
  const m = RE.avatarAlt.exec((alt ?? '').trim());
  const name = m?.[1]?.trim();
  return name && USERNAME_RE.test(name) ? name : null;
}

/** First line of an error message, without URLs (they may embed keys), at most 200 chars. */
export function shortError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const line = raw.split('\n', 1)[0] ?? '';
  return line.replace(/\b(?:https?|wss?|rtmps?):\/\/\S+/gi, '[url]').slice(0, 200);
}
