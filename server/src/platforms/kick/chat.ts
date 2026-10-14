// Kick chat (read-only) over the public Pusher websocket that kick.com's own chat uses (unofficial).
// Kick's official API only delivers chat through webhooks (docs.kick.com/events/event-types,
// `chat.message.sent`), which would need a public webhook route; this needs nothing but the chatroom id.
// `data` is a JSON string. Payload shapes follow community clients and captures (checked Oct 2026:
// https://github.com/retconned/kick-js src/types/events.ts, https://github.com/lox-x/kick-live-connector,
// senchabot-opensource/monorepo PRs #693/#714, AnisAbdellatif/BetterChat PR #5). Kick splits events
// over several channels, and names some with the Laravel namespace ("App\Events\...") and some without:
// - chatrooms.<chatroomId>.v2: ChatMessageEvent, MessageDeletedEvent ({ id, message: { id } }),
//   UserBannedEvent (bans and timeouts: { user: { id, username, slug }, permanent, duration? }),
//   ChatroomClearEvent, SubscriptionEvent ({ username, months }), StreamHostEvent.
// - chatroom_<chatroomId>: GiftedSubscriptionsEvent ({ gifter_username, gifted_usernames, gifted_total?,
//   correlation_id? } — a big gift arrives in chunks sharing the correlation id).
// - channel_<channelId>: ChannelSubscriptionEvent (paid subs, sometimes instead of SubscriptionEvent),
//   KicksGifted ({ sender: { id, username }, gift: { amount, name }, message }; a highlighted event
//   line without an alert: `alert.kicks` is reserved in docs/API.md).
// The same alert can arrive on two channels, so the chat source drops repeats (kickEventKey).
// Emotes appear inline as `[emote:<id>:<name>]`; they become emote fragments named after the emote
// (image https://files.kick.com/emotes/<id>/fullsize), and `text` uses the same names.

import type { ChatAlert, ChatFragment } from '../../../../shared/types.js';
import type { ChatMessageInput, ChatModerationInput, ChatSourceItem } from '../types.js';

export const CHAT_MESSAGE_EVENT = 'App\\Events\\ChatMessageEvent';
export const SUBSCRIPTION_EVENT = 'App\\Events\\SubscriptionEvent';
export const CHANNEL_SUBSCRIPTION_EVENT = 'App\\Events\\ChannelSubscriptionEvent';
export const GIFTED_SUBS_EVENT = 'App\\Events\\GiftedSubscriptionsEvent';
export const HOST_EVENT = 'App\\Events\\StreamHostEvent';
export const MESSAGE_DELETED_EVENT = 'App\\Events\\MessageDeletedEvent';
export const USER_BANNED_EVENT = 'App\\Events\\UserBannedEvent';
export const CHATROOM_CLEAR_EVENT = 'App\\Events\\ChatroomClearEvent';
export const KICKS_GIFTED_EVENT = 'KicksGifted';

/** The event name without Kick's Laravel namespace ('App\Events\ChatMessageEvent' -> 'ChatMessageEvent'). */
export function eventName(event: string): string {
  return event.replace(/^App\\+Events\\+/, '');
}

/** Chat, moderation, subs and hosts. */
export function chatroomChannel(chatroomId: number): string {
  return `chatrooms.${chatroomId}.v2`;
}

/** Gifted subs. */
export function giftsChannel(chatroomId: number): string {
  return `chatroom_${chatroomId}`;
}

/** Paid subs and Kicks (needs the kick.com channel id, not the chatroom id). */
export function channelEventsChannel(channelId: number): string {
  return `channel_${channelId}`;
}

export const KICK_EMOTE_CDN = 'https://files.kick.com/emotes';

export function kickEmoteUrl(id: string): string {
  return `${KICK_EMOTE_CDN}/${encodeURIComponent(id)}/fullsize`;
}

const EMOTE_RE = /\[emote:(\d{1,20}):([^\]]*)\]/g;

/** Message content -> text + emote fragments (joined, they spell the rendered text). */
export function contentFragments(content: string): ChatFragment[] {
  const out: ChatFragment[] = [];
  let plain = '';
  let last = 0;
  for (const m of content.matchAll(EMOTE_RE)) {
    const start = m.index ?? 0;
    plain += content.slice(last, start);
    last = start + m[0].length;
    const name = (m[2] ?? '').trim();
    if (!name) continue; // nameless code: drop it
    if (plain) out.push({ type: 'text', text: plain });
    plain = '';
    out.push({ type: 'emote', text: name, image: kickEmoteUrl(m[1]!) });
  }
  plain += content.slice(last);
  if (plain) out.push({ type: 'text', text: plain });
  return out;
}

/** Kick emotes appear inline as `[emote:<id>:<name>]`; show them by name. */
export function renderEmotes(content: string): string {
  return contentFragments(content)
    .map((f) => f.text)
    .join('');
}

/** Trim leading/trailing whitespace off a fragment list (like String#trim on the joined text). */
function trimFragments(fragments: ChatFragment[]): ChatFragment[] {
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
    const lastFrag = out[out.length - 1]!;
    const t = lastFrag.text.replace(/\s+$/, '');
    if (t) {
      lastFrag.text = t;
      break;
    }
    out.pop();
  }
  return out;
}

/** Trimmed text with emote fragments (fragments only when there is an emote). */
function body(content: string): { text: string; fragments?: ChatFragment[] } {
  const fragments = trimFragments(contentFragments(content));
  const text = fragments.map((f) => f.text).join('');
  return fragments.some((f) => f.type === 'emote') ? { text, fragments } : { text };
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

/** A string or numeric id as a string ('' when missing). */
function idOf(v: unknown): string {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? String(v) : '';
  return str(v);
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

const ME_RE = /^\s*\/me\s+/i;

function parseReply(metadata: unknown): ChatMessageInput['reply'] | null {
  const meta = asRecord(metadata);
  const original = asRecord(meta?.original_message);
  const sender = asRecord(meta?.original_sender);
  if (!original && !sender) return null;
  const reply: NonNullable<ChatMessageInput['reply']> = {};
  const messageId = idOf(original?.id);
  if (messageId) reply.messageId = messageId;
  const userName = str(sender?.username);
  if (userName) reply.userName = userName;
  const text = renderEmotes(typeof original?.content === 'string' ? original.content : '').trim();
  if (text) reply.text = text;
  return Object.keys(reply).length > 0 ? reply : null;
}

function parseChatMessage(data: unknown): ChatMessageInput | null {
  const d = asRecord(data);
  if (!d) return null;
  let content = typeof d.content === 'string' ? d.content : '';
  const action = ME_RE.test(content);
  if (action) content = content.replace(ME_RE, '');
  const { text, fragments } = body(content);
  if (!text) return null;
  const sender = asRecord(d.sender) ?? {};
  const identity = asRecord(sender.identity) ?? {};
  const author: ChatMessageInput['author'] = { name: str(sender.username) || str(sender.slug) || 'unknown' };
  const color = str(identity.color);
  if (color) author.color = color;
  const badges = parseBadges(identity.badges);
  if (badges.length > 0) author.badges = badges;
  const userId = idOf(sender.id);
  if (userId) author.id = userId;
  const login = str(sender.slug);
  if (login) author.login = login;

  const msg: ChatMessageInput = { author, text, kind: 'message' };
  const id = idOf(d.id);
  if (id) {
    msg.id = id;
    msg.platformMessageId = id;
  }
  if (fragments) msg.fragments = fragments;
  if (action) msg.action = true;
  const reply = parseReply(d.metadata);
  if (reply) msg.reply = reply;
  const ts = isoTime(d.created_at);
  if (ts) msg.ts = ts;
  return msg;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** An event line with its alert. */
function eventLine(author: ChatMessageInput['author'], text: string, alert: ChatAlert): ChatMessageInput {
  return { author, text, kind: 'event', alert };
}

function subscription(d: Record<string, unknown> | null, userName: string, userId: string): ChatMessageInput | null {
  if (!userName) return null;
  const months = count(d?.months);
  const author: ChatMessageInput['author'] = userId ? { name: userName, id: userId } : { name: userName };
  const user: ChatAlert['user'] = userId ? { id: userId, name: userName } : { name: userName };
  const text = months && months > 1 ? `subscribed for ${plural(months, 'month')}` : 'subscribed';
  return eventLine(author, text, { kind: 'subscription', user, amount: { unit: 'months', value: months && months > 0 ? months : 1 } });
}

function giftedUsernames(d: Record<string, unknown> | null): string[] {
  if (!Array.isArray(d?.gifted_usernames)) return [];
  return d.gifted_usernames.map(str).filter(Boolean);
}

function parseGiftedSubs(d: Record<string, unknown> | null): ChatMessageInput | null {
  const recipients = giftedUsernames(d);
  const total = count(d?.gifted_total) || recipients.length;
  if (!total) return null;
  const gifter = str(d?.gifter_username);
  const anonymous = !gifter || /^anonymous$/i.test(gifter);
  const name = anonymous ? 'Anonymous' : gifter;
  const alert: ChatAlert = {
    kind: 'gift',
    user: anonymous ? { name, anonymous: true } : { name },
    amount: { unit: 'count', value: total },
    gift: { ...(recipients.length > 0 ? { recipients } : {}), total },
  };
  return eventLine({ name }, `gifted ${plural(total, 'sub')}`, alert);
}

function parseHost(d: Record<string, unknown> | null): ChatMessageInput | null {
  const host = str(d?.host_username);
  if (!host) return null;
  const viewers = count(d?.number_viewers);
  const note = str(d?.optional_message);
  const head = viewers !== null ? `is hosting with ${plural(viewers, 'viewer')}` : 'is hosting';
  const alert: ChatAlert = { kind: 'raid', user: { name: host } };
  if (viewers !== null) alert.amount = { unit: 'viewers', value: viewers };
  if (note) alert.message = { text: note };
  return eventLine({ name: host }, note ? `${head}: ${note}` : head, alert);
}

/**
 * Kicks: a highlighted event line only. `alert.kicks` is still reserved in the external API
 * contract (docs/API.md §5/§6: "no chat source sends them yet"), so no alert is attached until the
 * contract documents it.
 */
function parseKicks(d: Record<string, unknown> | null): ChatMessageInput | null {
  const sender = asRecord(d?.sender);
  const gift = asRecord(d?.gift);
  const name = str(sender?.username);
  const amount = count(gift?.amount);
  if (!name || !amount) return null;
  const userId = idOf(sender?.id);
  const giftName = str(gift?.name);
  const rawMessage = d?.message;
  const message = typeof rawMessage === 'string' ? rawMessage.trim() : str(asRecord(rawMessage)?.content);
  const head = `sent ${plural(amount, 'Kick')}${giftName ? ` (${giftName})` : ''}`;
  const author: ChatMessageInput['author'] = userId ? { name, id: userId } : { name };
  return { author, text: message ? `${head}: ${message}` : head, kind: 'event', highlighted: true };
}

function parseModeration(name: string, d: Record<string, unknown> | null): ChatModerationInput | null {
  switch (name) {
    case 'MessageDeletedEvent': {
      const platformMessageId = idOf(asRecord(d?.message)?.id) || idOf(d?.id);
      return platformMessageId ? { kind: 'message-deleted', platformMessageId } : null;
    }
    case 'UserBannedEvent': {
      const user = asRecord(d?.user);
      const userId = idOf(user?.id);
      const userName = str(user?.username) || str(user?.slug);
      if (!userId && !userName) return null;
      return { kind: 'user-cleared', ...(userId ? { userId } : {}), ...(userName ? { userName } : {}) };
    }
    case 'ChatroomClearEvent':
      return { kind: 'cleared' };
    default:
      return null;
  }
}

/** Map one Pusher event from a Kick chat channel to a chat item (null = ignore it). */
export function parseKickChatEvent(event: string, data: unknown): ChatSourceItem | null {
  const name = eventName(event);
  switch (name) {
    case 'ChatMessageEvent':
      return parseChatMessage(data);
    case 'SubscriptionEvent': {
      const d = asRecord(data);
      return subscription(d, str(d?.username), '');
    }
    case 'ChannelSubscriptionEvent': {
      // Paid subs; seen as { user_ids, channel_id } — only usable when it names the subscriber.
      const d = asRecord(data);
      const user = asRecord(d?.user);
      const ids = Array.isArray(d?.user_ids) ? d.user_ids : [];
      return subscription(d, str(d?.username) || str(user?.username), idOf(user?.id) || idOf(ids[0]));
    }
    case 'GiftedSubscriptionsEvent':
      return parseGiftedSubs(asRecord(data));
    case 'StreamHostEvent':
      return parseHost(asRecord(data));
    case 'KicksGifted':
      return parseKicks(asRecord(data));
    default:
      return parseModeration(name, asRecord(data));
  }
}

/**
 * Identity of an alert event, to drop the copy Kick sends on a second channel (or the later chunks
 * of one big gift). Null for events that need no de-duplication.
 */
export function kickEventKey(event: string, data: unknown): string | null {
  const d = asRecord(data);
  switch (eventName(event)) {
    case 'SubscriptionEvent':
    case 'ChannelSubscriptionEvent': {
      const name = str(d?.username) || str(asRecord(d?.user)?.username);
      return name ? `sub:${name.toLowerCase()}` : null;
    }
    case 'GiftedSubscriptionsEvent': {
      const correlation = idOf(d?.correlation_id) || idOf(asRecord(d?.chunk_details)?.correlation_id);
      if (correlation) return `gift:${correlation}`;
      return `gift:${str(d?.gifter_username).toLowerCase()}:${giftedUsernames(d).join(',').toLowerCase()}`;
    }
    case 'StreamHostEvent': {
      const host = str(d?.host_username);
      return host ? `host:${host.toLowerCase()}` : null;
    }
    case 'KicksGifted': {
      const id = idOf(d?.gift_transaction_id) || idOf(d?.id);
      return id ? `kicks:${id}` : null;
    }
    default:
      return null;
  }
}
