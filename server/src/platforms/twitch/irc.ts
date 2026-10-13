// Twitch IRC (IRCv3) parsing for read-only chat. Pure functions, no I/O.
// Docs: https://dev.twitch.tv/docs/chat/irc/ and https://dev.twitch.tv/docs/chat/irc/#irc-tag-reference
// Tag value escaping: https://ircv3.net/specs/extensions/message-tags#escaping-values

import type { ChatMessageInput } from '../types.js';

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

const COLOR_RE = /^#[0-9a-f]{6}$/i;

function author(msg: IrcMessage, fallbackName: string): ChatMessageInput['author'] {
  const name = msg.tags['display-name']?.trim() || msg.tags.login?.trim() || nickFromPrefix(msg.prefix) || fallbackName;
  const out: ChatMessageInput['author'] = { name };
  const color = msg.tags.color?.trim();
  if (color && COLOR_RE.test(color)) out.color = color;
  const badges = parseBadges(msg.tags.badges);
  if (badges.length > 0) out.badges = badges;
  return out;
}

function base(msg: IrcMessage, text: string, kind: 'message' | 'event', fallbackName: string): ChatMessageInput {
  const input: ChatMessageInput = { author: author(msg, fallbackName), text, kind };
  const id = msg.tags.id?.trim();
  if (id) input.id = id;
  const ts = parseSentTs(msg.tags['tmi-sent-ts']);
  if (ts) input.ts = ts;
  return input;
}

/**
 * Chat-relevant IRC messages -> ChatMessageInput:
 * - PRIVMSG: a chat message (/me ACTION unwrapped).
 * - USERNOTICE (subs, gifts, raids, announcements...): an event with Twitch's system-msg,
 *   followed by the user's own message when there is one.
 * Everything else -> null.
 */
export function ircToChat(msg: IrcMessage): ChatMessageInput | null {
  if (msg.command === 'PRIVMSG') {
    const text = stripAction(msg.params[1] ?? '').trim();
    if (!text) return null;
    return base(msg, text, 'message', 'unknown');
  }
  if (msg.command === 'USERNOTICE') {
    const system = (msg.tags['system-msg'] ?? '').trim();
    const said = stripAction(msg.params[1] ?? '').trim();
    const text = system && said ? `${system} — ${said}` : system || said;
    if (!text) return null;
    return base(msg, text, 'event', 'Twitch');
  }
  return null;
}
