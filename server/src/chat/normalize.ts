// Turns driver-produced ChatMessageInput into a safe, bounded ChatMessage.

import { createHash } from 'node:crypto';
import type { ChatMessage, PlatformId } from '../../../shared/types.js';
import type { ChatMessageInput } from '../platforms/types.js';

export const MAX_TEXT_LENGTH = 500;
export const MAX_AUTHOR_LENGTH = 64;
export const MAX_BADGES = 10;
const MAX_BADGE_LENGTH = 32;
const MAX_ID_LENGTH = 200;
const MAX_URL_LENGTH = 2048;

// C0/C1 control characters plus bidi embeddings/overrides/isolates (can visually spoof overlays).
const CONTROL_RE = /[\u{0}-\u{1F}\u{7F}-\u{9F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;
const WHITESPACE_CONTROL_RE = /[\t\n\v\f\r\u{85}\u{2028}\u{2029}]+/gu;
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Cut to `max` UTF-16 units without leaving half of a surrogate pair. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** Line breaks/tabs become spaces, other control characters are removed, runs of spaces collapse. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(WHITESPACE_CONTROL_RE, ' ').replace(CONTROL_RE, '').replace(/ {2,}/g, ' ').trim();
  return truncate(cleaned, max).trim();
}

function cleanColor(value: unknown): string | undefined {
  return typeof value === 'string' && HEX_COLOR_RE.test(value.trim()) ? value.trim() : undefined;
}

function cleanAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function cleanBadges(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const badges: string[] = [];
  for (const b of value) {
    const clean = cleanText(b, MAX_BADGE_LENGTH);
    if (clean && !badges.includes(clean)) badges.push(clean);
    if (badges.length >= MAX_BADGES) break;
  }
  return badges.length > 0 ? badges : undefined;
}

function cleanTs(value: unknown, now: Date): string {
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (value !== '' && !Number.isNaN(d.getTime())) return d.toISOString();
  }
  return now.toISOString();
}

/** Stable id for messages whose platform gives none. */
export function hashMessageId(platform: PlatformId, author: string, text: string, ts: string): string {
  return createHash('sha256').update(JSON.stringify([platform, author, text, ts])).digest('base64url').slice(0, 24);
}

/**
 * Normalize one driver message. Returns null for messages with no visible text.
 * Defensive about runtime shapes: scrapers can hand us anything.
 */
export function normalizeChatMessage(
  input: ChatMessageInput,
  platform: PlatformId,
  destinationId: string,
  now: Date = new Date(),
): ChatMessage | null {
  if (!input || typeof input !== 'object') return null;
  const text = cleanText(input.text, MAX_TEXT_LENGTH);
  if (!text) return null;

  const rawAuthor: Partial<ChatMessage['author']> =
    input.author && typeof input.author === 'object' ? input.author : {};
  const name = cleanText(rawAuthor.name, MAX_AUTHOR_LENGTH) || 'unknown';
  const author: ChatMessage['author'] = { name };
  const color = cleanColor(rawAuthor.color);
  if (color) author.color = color;
  const badges = cleanBadges(rawAuthor.badges);
  if (badges) author.badges = badges;
  const avatarUrl = cleanAvatarUrl(rawAuthor.avatarUrl);
  if (avatarUrl) author.avatarUrl = avatarUrl;

  const ts = cleanTs(input.ts, now);
  const rawId = cleanText(input.id, MAX_ID_LENGTH);
  const id = `${platform}:${rawId || hashMessageId(platform, name, text, ts)}`;
  const kind: ChatMessage['kind'] = input.kind === 'event' ? 'event' : 'message';

  return { id, platform, destinationId, author, text, ts, kind };
}
