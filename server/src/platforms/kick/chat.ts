// Kick chat (read-only) over the public Pusher websocket that kick.com's own chat uses (unofficial).
// Kick's official API only delivers chat through webhooks (docs.kick.com/events/event-types,
// `chat.message.sent`), which would need a public webhook route; this needs nothing but the chatroom id.
// Events arrive on channel `chatrooms.<chatroomId>.v2`; `data` is a JSON string. Payload shapes follow
// community clients (e.g. https://github.com/retconned/kick-js src/types/events.ts).

import type { ChatMessageInput } from '../types.js';

export const CHAT_MESSAGE_EVENT = 'App\\Events\\ChatMessageEvent';
export const SUBSCRIPTION_EVENT = 'App\\Events\\SubscriptionEvent';
export const GIFTED_SUBS_EVENT = 'App\\Events\\GiftedSubscriptionsEvent';
export const HOST_EVENT = 'App\\Events\\StreamHostEvent';

export function chatroomChannel(chatroomId: number): string {
  return `chatrooms.${chatroomId}.v2`;
}

const EMOTE_RE = /\[emote:\d+:([^\]]*)\]/g;

/** Kick emotes appear inline as `[emote:<id>:<name>]`; show them as `:name:`. */
export function renderEmotes(content: string): string {
  return content.replace(EMOTE_RE, (_m, name: string) => (name.trim() ? `:${name.trim()}:` : ''));
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v === 'string') {
    try {
      return asRecord(JSON.parse(v));
    } catch {
      return null;
    }
  }
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

function isoTime(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** `identity.badges`: [{ type: 'subscriber', text: 'Subscriber', count: 3 }, ...] → ['Subscriber', ...]. */
export function parseBadges(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const b of v) {
    const rec = asRecord(b);
    const label = str(rec?.text) || str(rec?.type);
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

function parseChatMessage(data: unknown): ChatMessageInput | null {
  const d = asRecord(data);
  if (!d) return null;
  const text = renderEmotes(str(d.content)).trim();
  if (!text) return null;
  const sender = asRecord(d.sender) ?? {};
  const identity = asRecord(sender.identity) ?? {};
  const author: ChatMessageInput['author'] = { name: str(sender.username) || str(sender.slug) || 'unknown' };
  const color = str(identity.color);
  if (color) author.color = color;
  const badges = parseBadges(identity.badges);
  if (badges.length > 0) author.badges = badges;

  const msg: ChatMessageInput = { author, text, kind: 'message' };
  if (typeof d.id === 'string' || typeof d.id === 'number') msg.id = String(d.id);
  const ts = isoTime(d.created_at);
  if (ts) msg.ts = ts;
  return msg;
}

function eventMessage(name: string, text: string): ChatMessageInput | null {
  return name && text ? { author: { name }, text, kind: 'event' } : null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Map one Pusher event from a Kick chatroom channel to a chat message (null = ignore it). */
export function parseKickChatEvent(event: string, data: unknown): ChatMessageInput | null {
  switch (event) {
    case CHAT_MESSAGE_EVENT:
      return parseChatMessage(data);
    case SUBSCRIPTION_EVENT: {
      const d = asRecord(data);
      const months = count(d?.months);
      return eventMessage(str(d?.username), months && months > 1 ? `subscribed for ${plural(months, 'month')}` : 'subscribed');
    }
    case GIFTED_SUBS_EVENT: {
      const d = asRecord(data);
      const n = Array.isArray(d?.gifted_usernames) ? d.gifted_usernames.length : 0;
      return n > 0 ? eventMessage(str(d?.gifter_username) || 'Anonymous', `gifted ${plural(n, 'sub')}`) : null;
    }
    case HOST_EVENT: {
      const d = asRecord(data);
      const viewers = count(d?.number_viewers);
      const note = str(d?.optional_message);
      const base = viewers !== null ? `is hosting with ${plural(viewers, 'viewer')}` : 'is hosting';
      return eventMessage(str(d?.host_username), note ? `${base}: ${note}` : base);
    }
    default:
      return null;
  }
}
