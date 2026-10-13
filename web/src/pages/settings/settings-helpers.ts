// Pure helpers for the settings tabs (and a few shared with the accounts/destinations pages).

import type { AppSettings, PlatformAppStatus } from '@shared/api';
import type { AuditEntry, FieldSpec, TlsMode, TlsStatus } from '@shared/types';
import { cleanValues, type FormErrors, type FormValues } from '../../components/dynamic-form';
import type { Tone } from '../../components/utils';

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export const SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'https', label: 'HTTPS' },
  { id: 'obs', label: 'OBS setup' },
  { id: 'apps', label: 'Developer apps' },
  { id: 'users', label: 'Users' },
  { id: 'overlay', label: 'Chat overlay' },
  { id: 'audit', label: 'Audit log' },
  { id: 'about', label: 'About' },
] as const;

export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id'];

/** Tab id from `?tab=` (unknown or missing -> 'general'). */
export function settingsTab(raw: string | null | undefined): SettingsTabId {
  const found = SETTINGS_TABS.find((t) => t.id === raw);
  return found ? found.id : 'general';
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const STEP_PREFIX = /^(?:step\s*\d+\s*[:.)-]\s*|\d+\s*[.)]\s+|[-*•]\s+)/i;

/** Split driver-provided instructions (one step per line) and drop any numbering already present. */
export function instructionLines(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(STEP_PREFIX, '').trim())
    .filter((line) => line.length > 0);
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "in 5 days", "3 hours ago", "now" — or `fallback` when the timestamp is missing/invalid. */
export function relativeTime(iso: string | null | undefined, now: number, fallback = '—'): string {
  if (!iso) return fallback;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return fallback;
  const diffSec = (t - now) / 1000;
  const abs = Math.abs(diffSec);
  if (abs < 45) return 'now';
  for (const [unit, size] of RELATIVE_UNITS) {
    if (abs >= size || unit === 'second') {
      return relativeFormat.format(Math.round(diffSec / size), unit);
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// General settings
// ---------------------------------------------------------------------------

export interface GeneralDraft {
  publicBaseUrl: string;
  ingestHost: string;
  /** Raw text from the input (validated into a number). */
  disconnectGraceSec: string;
}

export const GRACE_MAX = 600;

export function generalDraft(s: AppSettings): GeneralDraft {
  return { publicBaseUrl: s.publicBaseUrl, ingestHost: s.ingestHost, disconnectGraceSec: String(s.disconnectGraceSec) };
}

export function validateGeneral(d: GeneralDraft): Partial<Record<keyof GeneralDraft, string>> {
  const errors: Partial<Record<keyof GeneralDraft, string>> = {};
  const base = d.publicBaseUrl.trim();
  if (base) {
    let u: URL | null = null;
    try {
      u = new URL(base);
    } catch {
      u = null;
    }
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
      errors.publicBaseUrl = 'Use a full address starting with https:// (or http://).';
    } else if (u.username || u.password || u.search || u.hash) {
      errors.publicBaseUrl = 'Use just the address, without a login, query string or #fragment.';
    }
  }
  const host = d.ingestHost.trim();
  if (host && (/\s/.test(host) || host.includes('://') || host.includes('/'))) {
    errors.ingestHost = 'Enter only a hostname or IP address, e.g. 192.168.1.20 (no rtmp://, no port).';
  } else if (host && /^[^[\]:]+:\d+$/.test(host)) {
    errors.ingestHost = 'Leave out the port; the RTMP port is added automatically.';
  }
  const grace = d.disconnectGraceSec.trim();
  if (!/^\d+$/.test(grace) || Number(grace) > GRACE_MAX) {
    errors.disconnectGraceSec = `Enter a whole number of seconds from 0 to ${GRACE_MAX}.`;
  }
  return errors;
}

/** The changed settings only (empty object = nothing to save). Assumes the draft is valid. */
export function generalChanges(d: GeneralDraft, current: AppSettings): Partial<AppSettings> {
  const out: Partial<AppSettings> = {};
  const base = d.publicBaseUrl.trim();
  const host = d.ingestHost.trim();
  const grace = Number(d.disconnectGraceSec.trim());
  if (base !== current.publicBaseUrl) out.publicBaseUrl = base;
  if (host !== current.ingestHost) out.ingestHost = host;
  if (Number.isFinite(grace) && grace !== current.disconnectGraceSec) out.disconnectGraceSec = grace;
  return out;
}

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------

export const TLS_MODE_LABEL: Record<TlsMode, string> = {
  auto: 'Automatic',
  letsencrypt: "Let's Encrypt",
  'self-signed': 'Self-signed',
  manual: 'Your own certificate files',
  off: 'Off (plain HTTP)',
};

export const TLS_SOURCE_INFO: Record<TlsStatus['source'], { label: string; tone: Tone }> = {
  'letsencrypt-ip': { label: "Let's Encrypt (IP address)", tone: 'success' },
  'letsencrypt-domain': { label: "Let's Encrypt (domain)", tone: 'success' },
  'self-signed': { label: 'Self-signed', tone: 'warn' },
  manual: { label: 'Your own certificate', tone: 'info' },
  none: { label: 'No HTTPS', tone: 'danger' },
};

const DAY_MS = 24 * 3600 * 1000;

/** Badge tone for a certificate expiry: expired = danger, under 2 days = warn. */
export function expiryTone(notAfter: string | null, now: number): Tone {
  if (!notAfter) return 'neutral';
  const t = Date.parse(notAfter);
  if (Number.isNaN(t)) return 'neutral';
  if (t <= now) return 'danger';
  return t - now < 2 * DAY_MS ? 'warn' : 'success';
}

// ---------------------------------------------------------------------------
// Developer apps
// ---------------------------------------------------------------------------

/** Form values for a developer app: stored non-secret values, coerced to each field's type. */
export function appFormValues(fields: readonly FieldSpec[], status: Pick<PlatformAppStatus, 'values'>): FormValues {
  const out: FormValues = {};
  for (const f of fields) {
    if (f.type === 'secret') continue;
    const raw = status.values[f.key];
    if (raw === undefined || raw === '') {
      if (f.default !== undefined) out[f.key] = f.default;
      else if (f.type === 'boolean') out[f.key] = false;
      continue;
    }
    if (f.type === 'boolean') out[f.key] = raw === 'true' || raw === '1';
    else if (f.type === 'number') out[f.key] = Number.isFinite(Number(raw)) ? Number(raw) : raw;
    else out[f.key] = raw;
  }
  return out;
}

/**
 * Values to PUT: every non-secret field as a string ('' clears it), secrets only when the user
 * typed a new one (absent = keep the stored secret).
 */
export function appSubmitValues(fields: readonly FieldSpec[], values: FormValues): Record<string, string> {
  const clean = cleanValues(fields, values);
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = clean[f.key];
    if (f.type === 'secret') {
      if (typeof v === 'string' && v.trim()) out[f.key] = v.trim();
    } else {
      out[f.key] = v === undefined || v === null ? '' : String(v);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** Same rules as the server (security/passwords.ts). */
export const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;

export function validatePassword(password: string, confirm: string): { password?: string; confirm?: string } {
  const e: { password?: string; confirm?: string } = {};
  if (password.length < PASSWORD_MIN) e.password = `Use at least ${PASSWORD_MIN} characters.`;
  else if (password.length > PASSWORD_MAX) e.password = `Use at most ${PASSWORD_MAX} characters.`;
  if (confirm !== password) e.confirm = "Passwords don't match.";
  return e;
}

export function validateNewUser(v: { username: string; password: string; confirm: string }): {
  username?: string;
  password?: string;
  confirm?: string;
} {
  const e: { username?: string; password?: string; confirm?: string } = { ...validatePassword(v.password, v.confirm) };
  if (!USERNAME_RE.test(v.username.trim())) e.username = '3–32 characters: letters, digits, "_", "." or "-".';
  return e;
}

// ---------------------------------------------------------------------------
// Chat overlay
// ---------------------------------------------------------------------------

export const OVERLAY_DEFAULT_MAX = 15;
export const OVERLAY_MAX_LIMIT = 100;
export const OVERLAY_FADE_MAX = 3600;

/**
 * Overlay URL with the optional `fade` (seconds, 0 = never) and `max` (visible messages) options.
 * Out-of-range or default values are left out. Returns the input unchanged if it isn't a URL.
 */
export function overlayUrlWithParams(url: string, opts: { fade?: number | null; max?: number | null }): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const { fade, max } = opts;
  if (fade !== undefined && fade !== null && Number.isFinite(fade) && fade > 0 && fade <= OVERLAY_FADE_MAX) {
    u.searchParams.set('fade', String(Math.round(fade)));
  } else {
    u.searchParams.delete('fade');
  }
  if (max !== undefined && max !== null && Number.isFinite(max) && max >= 1 && max <= OVERLAY_MAX_LIMIT && Math.round(max) !== OVERLAY_DEFAULT_MAX) {
    u.searchParams.set('max', String(Math.round(max)));
  } else {
    u.searchParams.delete('max');
  }
  return u.href;
}

/** Parse an optional whole number from an input ('' -> null, invalid -> NaN). */
export function parseWholeNumber(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  return /^\d+$/.test(s) ? Number(s) : Number.NaN;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export const AUDIT_PAGE_SIZE = 100;

/** Append an older page (newest first overall), dropping duplicates by id. */
export function appendAudit(existing: readonly AuditEntry[], page: readonly AuditEntry[]): AuditEntry[] {
  const seen = new Set(existing.map((e) => e.id));
  return existing.concat(page.filter((e) => !seen.has(e.id)));
}

/** Cursor for the next (older) page: the smallest id seen. */
export function auditCursor(entries: readonly AuditEntry[]): number | undefined {
  let min: number | undefined;
  for (const e of entries) if (min === undefined || e.id < min) min = e.id;
  return min;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Map a server validation message to the field it is about, by label prefix
 * ("Stream key is required" -> 'streamKey'). Longest label wins. Returns null when unknown.
 */
export function fieldForMessage(message: string, labels: Readonly<Record<string, string>>): string | null {
  const msg = message.trim().toLowerCase();
  let best: { key: string; len: number } | null = null;
  for (const [key, label] of Object.entries(labels)) {
    const l = label.trim().toLowerCase();
    if (l && msg.startsWith(l) && (!best || l.length > best.len)) best = { key, len: l.length };
  }
  return best?.key ?? null;
}

/** Errors object -> true when it has any message. */
export function hasErrors(errors: Readonly<Record<string, string | undefined>> | FormErrors): boolean {
  return Object.values(errors).some((v) => !!v);
}
