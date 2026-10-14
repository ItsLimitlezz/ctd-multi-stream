// Pure helpers for rendering chat: alert labels and amounts (subs, gifts, Super Chats…) and the
// message text split into emote/mention fragments. Everything here returns plain strings; the
// ChatLog renders them as text nodes.

import type { ChatAlert, ChatAlertKind, ChatMessage } from '@shared/types';

export const ALERT_KINDS: readonly ChatAlertKind[] = [
  'follow',
  'subscription',
  'gift',
  'cheer',
  'kicks',
  'raid',
  'membership',
  'superchat',
  'tip',
];

export const ALERT_LABEL: Readonly<Record<ChatAlertKind, string>> = {
  follow: 'Follow',
  subscription: 'Subscription',
  gift: 'Gift',
  cheer: 'Cheer',
  kicks: 'Kicks',
  raid: 'Raid',
  membership: 'Membership',
  superchat: 'Super Chat',
  tip: 'Tip',
};

export function isAlertKind(v: unknown): v is ChatAlertKind {
  return typeof v === 'string' && (ALERT_KINDS as readonly string[]).includes(v);
}

/** The alert carried by an event line, or null (plain messages never render as alerts). */
export function messageAlert(m: Pick<ChatMessage, 'kind' | 'alert'>): ChatAlert | null {
  const a = m.alert;
  if (m.kind !== 'event' || !a || typeof a !== 'object' || !isAlertKind(a.kind)) return null;
  return a;
}

const DECIMAL_RE = /^[+-]?\d{1,30}(?:\.\d{1,20})?$/;
const CURRENCY_RE = /^[A-Za-z]{3}$/;

/**
 * Format money from an ISO 4217 currency and a decimal string ("5.00"), e.g. "$5.00" / "5,00 €".
 * The string goes to Intl as-is (exact decimal, no float rounding); a value with more decimals
 * than the currency normally shows keeps them. Invalid input comes back as "<value> <currency>".
 */
export function formatMoney(value: string, currency: string, locale?: string | string[]): string {
  const v = typeof value === 'string' ? value.trim() : '';
  const cur = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  const fallback = [v, cur].filter(Boolean).join(' ').slice(0, 64);
  if (!DECIMAL_RE.test(v) || !CURRENCY_RE.test(cur)) return fallback;
  try {
    const base = new Intl.NumberFormat(locale, { style: 'currency', currency: cur });
    const decimals = v.includes('.') ? (v.split('.')[1]?.length ?? 0) : 0;
    const max = base.resolvedOptions().maximumFractionDigits ?? 2;
    const fmt = decimals > max ? new Intl.NumberFormat(locale, { style: 'currency', currency: cur, maximumFractionDigits: decimals }) : base;
    return fmt.format(v as Intl.StringNumericLiteral);
  } catch {
    return fallback;
  }
}

function count(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function counted(n: number, one: string, many: string, locale?: string | string[]): string {
  return `${n.toLocaleString(locale)} ${n === 1 ? one : many}`;
}

/** "12 months", "5 gifts", "500 bits", "100 Kicks", "120 viewers", "$5.00" — or null. */
export function formatAlertAmount(alert: Pick<ChatAlert, 'kind' | 'amount'>, locale?: string | string[]): string | null {
  const a = alert.amount;
  if (!a || typeof a !== 'object') return null;
  if (a.unit === 'currency') {
    return typeof a.value === 'string' && typeof a.currency === 'string' ? formatMoney(a.value, a.currency, locale) || null : null;
  }
  const n = count(a.value);
  if (n === null) return null;
  switch (a.unit) {
    case 'months':
      return counted(n, 'month', 'months', locale);
    case 'bits':
      return counted(n, 'bit', 'bits', locale);
    case 'kicks':
      return counted(n, 'Kick', 'Kicks', locale);
    case 'viewers':
      return counted(n, 'viewer', 'viewers', locale);
    case 'count':
      return alert.kind === 'gift' ? counted(n, 'gift', 'gifts', locale) : `×${n.toLocaleString(locale)}`;
    default:
      return null;
  }
}

const TIER_MAX = 30;

/** Twitch plans "1000"/"2000"/"3000"/"Prime", "1".."3", or whatever the platform calls it. */
export function formatTier(tier: unknown): string | null {
  if (typeof tier !== 'string') return null;
  const t = tier.trim();
  if (!t) return null;
  if (/^prime$/i.test(t)) return 'Prime';
  const plan = /^([1-3])000$/.exec(t) ?? /^([1-9])$/.exec(t);
  if (plan) return `Tier ${plan[1]}`;
  return t.length > TIER_MAX ? `${t.slice(0, TIER_MAX - 1)}…` : t;
}

/** Label, amount and tier of an alert, e.g. ["Subscription", "12 months", "Tier 1"]. */
export function alertParts(alert: ChatAlert, locale?: string | string[]): { label: string; amount: string | null; tier: string | null } {
  return {
    label: isAlertKind(alert.kind) ? ALERT_LABEL[alert.kind] : 'Alert',
    amount: formatAlertAmount(alert, locale),
    tier: formatTier(alert.tier),
  };
}

/** One-line summary: "Super Chat · $5.00", "Subscription · 12 months · Tier 1". */
export function alertSummary(alert: ChatAlert, locale?: string | string[]): string {
  const p = alertParts(alert, locale);
  return [p.label, p.amount, p.tier].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// Message text
// ---------------------------------------------------------------------------

export type ChatSegment = { kind: 'text'; text: string } | { kind: 'mention'; text: string } | { kind: 'emote'; text: string; src: string };

/** Emote images: https only (the page CSP allows https images; never http, data: or javascript:). */
export function safeImageUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** More parts than this (spam walls of emotes) render as plain text. */
export const MAX_SEGMENTS = 300;

/**
 * The message text as segments: emotes with a safe image, mentions, and text. Uses `fragments` only
 * when they are well-formed and add up to exactly `text`; otherwise the whole text as one segment.
 */
export function chatSegments(m: Pick<ChatMessage, 'text' | 'fragments'>): ChatSegment[] {
  const text = typeof m.text === 'string' ? m.text : '';
  const frags = m.fragments;
  if (!Array.isArray(frags) || frags.length === 0 || frags.length > MAX_SEGMENTS) return [{ kind: 'text', text }];
  const out: ChatSegment[] = [];
  let joined = '';
  for (const f of frags) {
    if (!f || typeof f !== 'object' || typeof f.text !== 'string') return [{ kind: 'text', text }];
    joined += f.text;
    const src = f.type === 'emote' ? safeImageUrl(f.image) : null;
    if (src && f.text) out.push({ kind: 'emote', text: f.text, src });
    else if (f.type === 'mention' && f.text) out.push({ kind: 'mention', text: f.text });
    else if (f.text) {
      // Merge neighbouring text so the DOM stays small.
      const last = out[out.length - 1];
      if (last?.kind === 'text') last.text += f.text;
      else out.push({ kind: 'text', text: f.text });
    }
  }
  return joined === text ? out : [{ kind: 'text', text }];
}
