// Pure helpers for the Instagram driver (no browser access; unit-tested).

import type { Destination } from '../../../../shared/types.js';
import { truncateTitle } from '../common/http.js';
import { RE } from './selectors.js';

export type Audience = 'public' | 'practice';

export interface InstagramOptions {
  audience: Audience;
  goLiveTimeoutSec: number;
}

export const DEFAULT_GO_LIVE_TIMEOUT_SEC = 90;
/** The orchestrator gives confirm() 180 s in total; leave room for the click and the live check. */
export const MIN_GO_LIVE_TIMEOUT_SEC = 15;
export const MAX_GO_LIVE_TIMEOUT_SEC = 150;

/**
 * Instagram does not document a limit for live titles. Used when the title field has no
 * `maxlength`; the field's own limit wins when it is smaller.
 */
export const TITLE_MAX = 100;

export function readOptions(dest: Pick<Destination, 'options'>): InstagramOptions {
  const audience: Audience = dest.options.audience === 'practice' ? 'practice' : 'public';
  const raw = dest.options.goLiveTimeoutSec;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  const goLiveTimeoutSec = Number.isFinite(n)
    ? Math.min(MAX_GO_LIVE_TIMEOUT_SEC, Math.max(MIN_GO_LIVE_TIMEOUT_SEC, Math.round(n)))
    : DEFAULT_GO_LIVE_TIMEOUT_SEC;
  return { audience, goLiveTimeoutSec };
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
