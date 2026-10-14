// Twitch IRC (IRCv3) parsing for read-only chat. Pure functions, no I/O.
// Docs: https://dev.twitch.tv/docs/chat/irc/ and https://dev.twitch.tv/docs/chat/irc/#irc-tag-reference
// Tag value escaping: https://ircv3.net/specs/extensions/message-tags#escaping-values
//
// Emotes: the `emotes` tag is `<id>:<start>-<end>,<start>-<end>/<id>:...` with zero-based, inclusive
// positions counted in Unicode code points (not UTF-16 units: an emoji before an emote counts as one),
// and, for /me messages, relative to the text after "\x01ACTION ". Images come from Twitch's CDN
// (https://static-cdn.jtvnw.net/emoticons/v2/<id>/default/dark/2.0).
//
// Alerts come from USERNOTICE msg-id sub/resub (msg-param-cumulative-months, msg-param-sub-plan
// 1000/2000/3000/Prime), subgift (msg-param-recipient-*), submysterygift (msg-param-mass-gift-count),
// raid (msg-param-viewerCount, msg-param-displayName), and PRIVMSG cheers (the `bits` tag).
// Moderation: CLEARMSG (target-msg-id) and CLEARCHAT (target-user-id + login param, or nothing = all).

import type { ChatAlert, ChatFragment } from '../../../../shared/types.js';
import type { ChatMessageInput, ChatModerationInput, ChatSourceItem } from '../types.js';

export interface IrcMessage {
  /** IRCv3 tags, values unescaped. Missing value = ''. */
  tags: Record<string, string>;
  /** Source without the leading ':' (e.g. 'nick!nick@nick.tmi.twitch.tv'), or null. */
  prefix: string | null;
  /** Upper-cased command or numeric (PRIVMSG, USERNOTICE, PING, 001...). */
  command: string;
  /** Middle params followed by the trailing param (without its ':'). */
  params: string[];
}

const TAG_ESCAPES: Record<string, string> = { ':': ';', s: ' ', r: '\r', n: '\n', '\\': '\\' };

/** IRCv3 tag value unescaping: \: ; \s space, \\ \, \r CR, \n LF; unknown \x -> x; a trailing lone \ is dropped. */
export function unescapeTagValue(value: string): string {
  if (!value.includes('\\')) return value;
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value.charAt(i);
    if (c !== '\\') {
      out += c;
      continue;
    }
    i += 1;
    if (i >= value.length) break;
    const next = value.charAt(i);
    out += TAG_ESCAPES[next] ?? next;
  }
  return out;
}

function parseTags(raw: string): Record<string, string> {
  const tags = Object.create(null) as Record<string, string>;
  for (const part of raw.split(';')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    if (!key) continue;
    tags[key] = eq < 0 ? '' : unescapeTagValue(part.slice(eq + 1));
  }
  return tags;
}

/** Parse one IRC line (with or without the trailing CRLF). Returns null for empty/garbage lines. */
export function parseIrcLine(raw: string): IrcMessage | null {
  const line = raw.replace(/[\r\n]+$/, '');
  let pos = 0;
  const skipSpaces = (): void => {
    while (line.charAt(pos) === ' ') pos += 1;
  };

  let tags = Object.create(null) as Record<string, string>;
  if (line.startsWith('@')) {
    const end = line.indexOf(' ');
    if (end < 0) return null;
    tags = parseTags(line.slice(1, end));
    pos = end + 1;
  }
  skipSpaces();

  let prefix: string | null = null;
  if (line.charAt(pos) === ':') {
    const end = line.indexOf(' ', pos);
    if (end < 0) return null;
    prefix = line.slice(pos + 1, end);
    pos = end + 1;
    skipSpaces();
  }

  const cmdEnd = line.indexOf(' ', pos);
  const command = (cmdEnd < 0 ? line.slice(pos) : line.slice(pos, cmdEnd)).toUpperCase();
  if (!command) return null;
  pos = cmdEnd < 0 ? line.length : cmdEnd + 1;

  const params: string[] = [];
  while (pos < line.length) {
    if (line.charAt(pos) === ' ') {
      pos += 1;
      continue;
    }
    if (line.charAt(pos) === ':') {
      params.push(line.slice(pos + 1));
      break;
    }
    const end = line.indexOf(' ', pos);
    if (end < 0) {
      params.push(line.slice(pos));
      break;
    }
    params.push(line.slice(pos, end));
    pos = end + 1;
  }
  return { tags, prefix, command, params };
}

/** 'nick!user@host' -> 'nick'. */
export function nickFromPrefix(prefix: string | null): string | null {
  if (!prefix) return null;
  const nick = prefix.split('!')[0] ?? '';
  return nick && !nick.includes('.') ? nick : null;
}

/** 'broadcaster/1,subscriber/12' -> ['broadcaster', 'subscriber']. */
export function parseBadges(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const entry of value.split(',')) {
    const name = entry.split('/')[0]?.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** tmi-sent-ts (epoch ms) -> ISO string, or undefined. */
export function parseSentTs(value: string | undefined): string | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms <= 0) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

const ACTION_RE = /^\u0001ACTION ?([\s\S]*?)\u0001?$/;

/** '\x01ACTION waves\x01' (/me) -> 'waves'. Other text is returned unchanged. */
export function stripAction(text: string): string {
  const m = ACTION_RE.exec(text);
  return m ? (m[1] ?? '') : text;
}

/** True for a /me message ('\x01ACTION ...'). */
export function isAction(text: string): boolean {
  return ACTION_RE.test(text);
}

/** A non-negative integer tag value, or null. */
function intTag(value: string | undefined): number | null {
  if (!value || !/^\d{1,9}$/.test(value)) return null;
  return Number(value);
}

function positiveIntTag(value: string | undefined): number | null {
  const n = intTag(value);
  return n !== null && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Emotes, cheermotes and fragments
// ---------------------------------------------------------------------------

export const EMOTE_CDN = 'https://static-cdn.jtvnw.net/emoticons/v2';
/** Twitch emote ids: digits, or e.g. 'emotesv2_1a2b...'. */
const EMOTE_ID_RE = /^[A-Za-z0-9_]{1,100}$/;
/** Tags with more ranges than this are ignored (a message is at most 500 characters). */
const MAX_EMOTE_RANGES = 500;

export function emoteImageUrl(id: string): string {
  return `${EMOTE_CDN}/${encodeURIComponent(id)}/default/dark/2.0`;
}

export interface EmoteRange {
  id: string;
  /** Zero-based code point index of the first character. */
  start: number;
  /** Inclusive code point index of the last character. */
  end: number;
}

/** The `emotes` tag -> ranges sorted by start. Malformed entries are skipped. */
export function parseEmotesTag(value: string | undefined): EmoteRange[] {
  if (!value) return [];
  const out: EmoteRange[] = [];
  for (const entry of value.split('/')) {
    const colon = entry.indexOf(':');
    if (colon <= 0) continue;
    const id = entry.slice(0, colon);
    if (!EMOTE_ID_RE.test(id)) continue;
    for (const range of entry.slice(colon + 1).split(',')) {
      const m = /^(\d{1,5})-(\d{1,5})$/.exec(range);
      if (!m) continue;
      const start = Number(m[1]);
      const end = Number(m[2]);
      if (end < start) continue;
      out.push({ id, start, end });
      if (out.length > MAX_EMOTE_RANGES) return [];
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Split `text` into text + emote fragments using code point ranges. Ranges that overlap an earlier
 * one, run past the end, or cover whitespace (Twitch emotes never contain any — a sign of a bad
 * offset) are ignored, so the fragments always join back to `text`.
 */
export function emoteFragments(text: string, emotes: readonly EmoteRange[]): ChatFragment[] {
  const chars = Array.from(text);
  const out: ChatFragment[] = [];
  let pos = 0;
  for (const r of emotes) {
    if (r.start < pos || r.end >= chars.length) continue;
    const name = chars.slice(r.start, r.end + 1).join('');
    if (!name || /\s/.test(name)) continue;
    if (r.start > pos) out.push({ type: 'text', text: chars.slice(pos, r.start).join('') });
    out.push({ type: 'emote', text: name, image: emoteImageUrl(r.id) });
    pos = r.end + 1;
  }
  if (pos < chars.length) out.push({ type: 'text', text: chars.slice(pos).join('') });
  return out;
}

/** Trim leading/trailing whitespace off a fragment list (like String#trim on the joined text). */
export function trimFragments(fragments: readonly ChatFragment[]): ChatFragment[] {
  const out = fragments.map((f) => ({ ...f }));
  while (out.length > 0 && out[0]!.type === 'text') {
    const t = out[0]!.text.replace(/^\s+/, '');
    if (t) {
      out[0]!.text = t;
      break;
    }
    out.shift();
  }
  while (out.length > 0 && out[out.length - 1]!.type === 'text') {
    const last = out[out.length - 1]!;
    const t = last.text.replace(/\s+$/, '');
    if (t) {
      last.text = t;
      break;
    }
    out.pop();
  }
  return out.filter((f) => f.text !== '');
}

/** 'Cheer100', 'BibleThump50', '4Head10' -> prefix + amount. */
const CHEERMOTE_RE = /^([A-Za-z0-9]*[A-Za-z])(\d{1,7})$/;

interface CheerToken {
  frag: number;
  start: number;
  end: number;
  amount: number;
  cheer: boolean;
}

/**
 * Mark cheermotes ('Cheer100') in the text fragments of a cheer. Prefixes vary per channel and we
 * don't fetch the list, so a word counts as a cheermote only when the words together add up to the
 * `bits` tag (first every prefix+number word, then only 'Cheer<n>' words); otherwise none is marked.
 */
export function cheermoteFragments(fragments: readonly ChatFragment[], bits: number): ChatFragment[] {
  const tokens: CheerToken[] = [];
  fragments.forEach((f, frag) => {
    if (f.type !== 'text') return;
    for (const m of f.text.matchAll(/\S+/g)) {
      const parsed = CHEERMOTE_RE.exec(m[0]);
      if (!parsed) continue;
      const start = m.index ?? 0;
      tokens.push({ frag, start, end: start + m[0].length, amount: Number(parsed[2]), cheer: /^cheer$/i.test(parsed[1]!) });
    }
  });
  const sum = (list: CheerToken[]): number => list.reduce((n, t) => n + t.amount, 0);
  let chosen = tokens.filter((t) => t.amount > 0);
  if (sum(chosen) !== bits) chosen = chosen.filter((t) => t.cheer);
  if (chosen.length === 0 || sum(chosen) !== bits) return [...fragments];

  const out: ChatFragment[] = [];
  fragments.forEach((f, frag) => {
    const mine = chosen.filter((t) => t.frag === frag);
    if (mine.length === 0) {
      out.push(f);
      return;
    }
    let pos = 0;
    for (const t of mine) {
      if (t.start > pos) out.push({ type: 'text', text: f.text.slice(pos, t.start) });
      out.push({ type: 'cheermote', text: f.text.slice(t.start, t.end), amount: t.amount });
      pos = t.end;
    }
    if (pos < f.text.length) out.push({ type: 'text', text: f.text.slice(pos) });
  });
  return out;
}

interface Body {
  /** Trimmed text; equals the joined fragments. */
  text: string;
  /** Only when there is something besides plain text (emotes, cheermotes). */
  fragments?: ChatFragment[];
}

/** A user-written message (PRIVMSG text or a USERNOTICE's own message) with its emotes. */
function messageBody(raw: string, tags: Record<string, string>, bits: number | null): Body {
  let fragments = trimFragments(emoteFragments(raw, parseEmotesTag(tags.emotes)));
  if (bits) fragments = cheermoteFragments(fragments, bits);
  const text = fragments.map((f) => f.text).join('');
  return fragments.some((f) => f.type !== 'text') ? { text, fragments } : { text };
}

/** `head — body`, keeping the body's fragments behind a text fragment for the head. */
function withHead(head: string, body: Body): Body {
  if (!head) return body;
  if (!body.text) return { text: head };
  const text = `${head} — ${body.text}`;
  if (!body.fragments) return { text };
  const [first, ...rest] = body.fragments;
  const lead = `${head} — `;
  const fragments: ChatFragment[] =
    first?.type === 'text' ? [{ type: 'text', text: lead + first.text }, ...rest] : [{ type: 'text', text: lead }, ...body.fragments];
  return { text, fragments };
}

// ---------------------------------------------------------------------------
// Messages, alerts, moderation
// ---------------------------------------------------------------------------

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const ANONYMOUS_LOGINS = new Set(['ananonymousgifter', 'ananonymouscheerer']);

function authorName(msg: IrcMessage, fallbackName: string): string {
  return msg.tags['display-name']?.trim() || msg.tags.login?.trim() || nickFromPrefix(msg.prefix) || fallbackName;
}

function author(msg: IrcMessage, fallbackName: string): ChatMessageInput['author'] {
  const out: ChatMessageInput['author'] = { name: authorName(msg, fallbackName) };
  const color = msg.tags.color?.trim();
  if (color && COLOR_RE.test(color)) out.color = color;
  const badges = parseBadges(msg.tags.badges);
  if (badges.length > 0) out.badges = badges;
  const id = msg.tags['user-id']?.trim();
  if (id) out.id = id;
  const login = (msg.tags.login?.trim() || nickFromPrefix(msg.prefix) || '').toLowerCase();
  if (login) out.login = login;
  return out;
}

function base(msg: IrcMessage, body: Body, kind: 'message' | 'event', fallbackName: string): ChatMessageInput {
  const input: ChatMessageInput = { author: author(msg, fallbackName), text: body.text, kind };
  if (body.fragments) input.fragments = body.fragments;
  const id = msg.tags.id?.trim();
  if (id) {
    input.id = id;
    input.platformMessageId = id;
  }
  const ts = parseSentTs(msg.tags['tmi-sent-ts']);
  if (ts) input.ts = ts;
  const reply = replyOf(msg.tags);
  if (reply) input.reply = reply;
  return input;
}

/** reply-parent-* tags (a reply to another chat message). */
function replyOf(tags: Record<string, string>): ChatMessageInput['reply'] | null {
  const messageId = tags['reply-parent-msg-id']?.trim();
  if (!messageId) return null;
  const reply: NonNullable<ChatMessageInput['reply']> = { messageId };
  const userName = tags['reply-parent-display-name']?.trim() || tags['reply-parent-user-login']?.trim();
  if (userName) reply.userName = userName;
  const text = tags['reply-parent-msg-body']?.trim();
  if (text) reply.text = text;
  return reply;
}

/** The alert's user: the message's sender (anonymous gifters/cheerers have no usable id). */
function alertUser(msg: IrcMessage, name: string, anonymous = false): ChatAlert['user'] {
  const login = msg.tags.login?.trim().toLowerCase() ?? '';
  if (anonymous || ANONYMOUS_LOGINS.has(login)) return { name, anonymous: true };
  const id = msg.tags['user-id']?.trim();
  return id ? { id, name } : { name };
}

/** msg-param-sub-plan -> '1000' | '2000' | '3000' | 'Prime'. */
export function subTier(plan: string | undefined): string | undefined {
  const p = plan?.trim() ?? '';
  if (/^prime$/i.test(p)) return 'Prime';
  return /^[123]000$/.test(p) ? p : undefined;
}

function withTier(alert: ChatAlert, tags: Record<string, string>): ChatAlert {
  const tier = subTier(tags['msg-param-sub-plan']);
  if (tier) alert.tier = tier;
  return alert;
}

/** The structured alert a USERNOTICE carries (null = none: announcements, bits badges...). */
function usernoticeAlert(msg: IrcMessage, said: string): ChatAlert | null {
  const t = msg.tags;
  const msgId = t['msg-id']?.trim() ?? '';
  const name = authorName(msg, 'Twitch');
  const message = said ? { message: { text: said } } : {};
  switch (msgId) {
    case 'sub':
    case 'resub': {
      const months = positiveIntTag(t['msg-param-cumulative-months']) ?? (msgId === 'sub' ? 1 : null);
      return withTier(
        { kind: 'subscription', user: alertUser(msg, name), ...(months ? { amount: { unit: 'months', value: months } } : {}), ...message },
        t,
      );
    }
    case 'subgift':
    case 'anonsubgift': {
      const recipient = t['msg-param-recipient-display-name']?.trim() || t['msg-param-recipient-user-name']?.trim();
      return withTier(
        {
          kind: 'gift',
          user: alertUser(msg, name, msgId === 'anonsubgift'),
          amount: { unit: 'count', value: 1 },
          gift: { ...(recipient ? { recipients: [recipient] } : {}), total: 1 },
        },
        t,
      );
    }
    case 'submysterygift':
    case 'anonsubmysterygift': {
      const n = positiveIntTag(t['msg-param-mass-gift-count']) ?? 1;
      return withTier(
        { kind: 'gift', user: alertUser(msg, name, msgId === 'anonsubmysterygift'), amount: { unit: 'count', value: n }, gift: { total: n } },
        t,
      );
    }
    case 'raid': {
      const raider = t['msg-param-displayName']?.trim() || t['msg-param-login']?.trim() || name;
      const viewers = intTag(t['msg-param-viewerCount']);
      return { kind: 'raid', user: alertUser(msg, raider), ...(viewers !== null ? { amount: { unit: 'viewers', value: viewers } } : {}) };
    }
    default:
      return null;
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** CLEARMSG / CLEARCHAT -> moderation (null when it names nothing usable). */
export function ircToModeration(msg: IrcMessage): ChatModerationInput | null {
  if (msg.command === 'CLEARMSG') {
    const platformMessageId = msg.tags['target-msg-id']?.trim();
    return platformMessageId ? { kind: 'message-deleted', platformMessageId } : null;
  }
  if (msg.command === 'CLEARCHAT') {
    const userId = msg.tags['target-user-id']?.trim();
    const userName = msg.params[1]?.trim();
    if (!userId && !userName) return { kind: 'cleared' };
    return { kind: 'user-cleared', ...(userId ? { userId } : {}), ...(userName ? { userName } : {}) };
  }
  return null;
}

/**
 * Chat-relevant IRC messages -> chat source items:
 * - PRIVMSG: a chat message (/me unwrapped, `action` set; emote/cheermote fragments; highlighted
 *   for channel-points highlights and paid pins). A cheer (`bits`) becomes an event line + `cheer` alert.
 * - USERNOTICE (subs, gifts, raids, announcements...): an event with Twitch's system-msg, followed by
 *   the user's own message when there is one, plus an alert for subs, gifts and raids.
 * - CLEARMSG / CLEARCHAT: moderation.
 * Everything else -> null.
 */
export function ircToChat(msg: IrcMessage): ChatSourceItem | null {
  if (msg.command === 'PRIVMSG') {
    const raw = msg.params[1] ?? '';
    const bits = positiveIntTag(msg.tags.bits);
    const body = messageBody(stripAction(raw), msg.tags, bits);
    if (!body.text) return null;
    const action = isAction(raw);
    if (bits) {
      const name = authorName(msg, 'unknown');
      const input = base(msg, withHead(`${name} cheered ${plural(bits, 'bit')}`, body), 'event', 'unknown');
      input.alert = { kind: 'cheer', user: alertUser(msg, name), amount: { unit: 'bits', value: bits }, message: { text: body.text } };
      input.highlighted = true;
      if (action) input.action = true;
      return input;
    }
    const input = base(msg, body, 'message', 'unknown');
    if (action) input.action = true;
    if (msg.tags['msg-id'] === 'highlighted-message' || msg.tags['pinned-chat-paid-amount']) input.highlighted = true;
    return input;
  }
  if (msg.command === 'USERNOTICE') {
    const system = (msg.tags['system-msg'] ?? '').trim();
    const body = messageBody(stripAction(msg.params[1] ?? ''), msg.tags, null);
    const line = withHead(system, body);
    if (!line.text) return null;
    const input = base(msg, line, 'event', 'Twitch');
    const alert = usernoticeAlert(msg, body.text);
    if (alert) input.alert = alert;
    if (msg.tags['msg-id'] === 'announcement') input.highlighted = true;
    return input;
  }
  return ircToModeration(msg);
}

/** How long a mystery gift claims the per-recipient subgift notices that follow it. */
const GIFT_BOMB_WINDOW_MS = 60_000;

/**
 * Per connection: a mystery gift of N subs ("submysterygift") is followed by N "subgift" notices,
 * one per recipient. Their chat lines stay, but only the mystery gift keeps its `gift` alert (the
 * subgifts are recognised by msg-param-community-gift-id, or by counting down the gifter's N).
 */
export class GiftBombFilter {
  private readonly pending = new Map<string, { left: number; at: number }>();

  apply(msg: IrcMessage, item: ChatSourceItem | null, now = Date.now()): ChatSourceItem | null {
    if (!item || msg.command !== 'USERNOTICE' || !('alert' in item) || item.alert?.kind !== 'gift') return item;
    const msgId = msg.tags['msg-id'];
    const gifter = msg.tags['user-id']?.trim() || msg.tags.login?.trim().toLowerCase() || msgId || '';
    for (const [k, v] of this.pending) if (now - v.at > GIFT_BOMB_WINDOW_MS) this.pending.delete(k);
    if (msgId === 'submysterygift' || msgId === 'anonsubmysterygift') {
      const n = item.alert.amount?.unit === 'count' ? item.alert.amount.value : 1;
      this.pending.set(gifter, { left: n, at: now });
      return item;
    }
    const bomb = this.pending.get(gifter);
    const partOfBomb = !!msg.tags['msg-param-community-gift-id']?.trim() || (bomb !== undefined && bomb.left > 0);
    if (bomb) {
      bomb.left -= 1;
      if (bomb.left <= 0) this.pending.delete(gifter);
    }
    if (!partOfBomb) return item;
    const { alert: _alert, ...rest } = item;
    return rest;
  }
}
