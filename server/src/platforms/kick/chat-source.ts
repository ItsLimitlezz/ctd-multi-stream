// Chat source for one prepared Kick live: resolve the chatroom id (cached), then stream the
// chatroom's events (chat, moderation, alerts) until the signal aborts — over Kick's Centrifugo
// websocket since Oct 2026 (realtime.ts), or Pusher when Kick offers it / KICK_PUSHER_KEY is set.

import type { Account } from '../../../../shared/types.js';
import type { ChatSourceItem, DriverContext } from '../types.js';
import { errorText } from './api.js';
import { channelEventsChannel, chatroomChannel, giftsChannel, kickEventKey, parseKickChatEvent } from './chat.js';
import { ChatroomNotFoundError, lookupChatroom, type ChatroomInfo } from './chatroom.js';
import { readOptions, sameSlug, updateOptions } from './options.js';
import { kickPusherUrl, pusherEvents, type PusherEvent } from './pusher.js';
import { centrifugoEvents, kickGuestToken, kickRealtimeTarget, pusherUrlFor, type RealtimeTarget } from './realtime.js';

/** Waits between failed chatroom lookups (each may launch a browser, so back off generously). */
const LOOKUP_BACKOFF_MS = [10_000, 30_000, 60_000, 120_000, 300_000] as const;
/** The same alert arriving on two channels (or a big gift's later chunks) within this window is dropped. */
const DEDUPE_WINDOW_MS = 60_000;
const DEDUPE_MAX_KEYS = 500;

/** slug (lower case) → chatroom (and channel) id, shared by every live of the process. */
const chatroomCache = new Map<string, ChatroomInfo>();

export interface KickChatOptions {
  ctx: DriverContext;
  account: Account;
  slug: string;
  signal: AbortSignal;
  /** Test seams. */
  pusherUrl?: string;
  lookup?: (slug: string, signal: AbortSignal) => Promise<ChatroomInfo>;
  backoffMs?: readonly number[];
  realtime?: (channelId: number, signal: AbortSignal) => Promise<RealtimeTarget>;
  guestToken?: (clientId: string, signal: AbortSignal) => Promise<string>;
  /** Skip caches that lack the channel id (Kick's realtime service needs it). */
  requireChannelId?: boolean;
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Chatroom (and channel) id from the caches, else looked up (retrying with backoff). Null when aborted. */
export async function resolveChatroom(opts: KickChatOptions): Promise<ChatroomInfo | null> {
  const { ctx, account, slug, signal } = opts;
  const key = slug.toLowerCase();
  const memo = chatroomCache.get(key);
  if (memo && (memo.channelId || !opts.requireChannelId)) return memo;
  const cached = readOptions(account);
  if (cached.chatroomId && sameSlug(cached.slug, slug) && (cached.channelId || !opts.requireChannelId)) {
    return { chatroomId: cached.chatroomId, channelId: cached.channelId ?? null };
  }

  const lookup =
    opts.lookup ?? ((s: string, sig: AbortSignal) => lookupChatroom(s, { browser: ctx.browser, accountId: account.id, signal: sig }));
  const backoff = opts.backoffMs ?? LOOKUP_BACKOFF_MS;
  for (let attempt = 0; !signal.aborted; attempt++) {
    try {
      const info = await lookup(slug, signal);
      chatroomCache.set(key, info);
      try {
        await updateOptions(ctx, account, {
          slug,
          chatroomId: info.chatroomId,
          ...(info.channelId ? { channelId: info.channelId } : {}),
        });
      } catch (err) {
        ctx.log.warn({ error: errorText(err) }, 'could not cache the Kick chatroom id');
      }
      return info;
    } catch (err) {
      if (signal.aborted) return null;
      const wait = backoff[Math.min(attempt, backoff.length - 1)] ?? 300_000;
      const reason = err instanceof ChatroomNotFoundError ? err.message : errorText(err);
      ctx.log.warn({ slug, reason, retryInSec: Math.round(wait / 1000) }, 'Kick chatroom lookup failed; chat will start once it succeeds');
      if (!(await sleep(wait, signal))) return null;
    }
  }
  return null;
}

/** Chatroom id from the caches, else looked up (retrying with backoff). Null when aborted. */
export async function resolveChatroomId(opts: KickChatOptions): Promise<number | null> {
  return (await resolveChatroom(opts))?.chatroomId ?? null;
}

/** Keys seen within a time window (bounded). */
export class RecentEventKeys {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly windowMs = DEDUPE_WINDOW_MS,
    private readonly maxKeys = DEDUPE_MAX_KEYS,
  ) {}

  /** True when `key` was already seen within the window; records it otherwise. */
  repeat(key: string, now = Date.now()): boolean {
    for (const [k, at] of this.seen) {
      if (now - at < this.windowMs) break; // insertion order = time order
      this.seen.delete(k);
    }
    if (this.seen.has(key)) return true;
    this.seen.set(key, now);
    if (this.seen.size > this.maxKeys) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return false;
  }
}

/**
 * Read-only chat for a Kick channel: chat messages, moderation (deleted messages, bans/timeouts,
 * cleared chat), alerts (subs, gifted subs, hosts) and Kicks event lines. Throws when the websocket
 * drops (the ChatHub restarts it).
 */
export async function* kickChat(opts: KickChatOptions): AsyncGenerator<ChatSourceItem> {
  // Kick's realtime service is asked per channel id, so a cached chatroom without one is looked up again.
  const room = await resolveChatroom({ ...opts, requireChannelId: !opts.pusherUrl && !legacyPusherForced() });
  if (room === null || opts.signal.aborted) return;
  const optionalChannels = [giftsChannel(room.chatroomId)];
  if (room.channelId) optionalChannels.push(channelEventsChannel(room.channelId));
  const channels = [chatroomChannel(room.chatroomId)];
  const events = await chatEvents(opts, room, channels, optionalChannels);
  if (!events) return;
  const recent = new RecentEventKeys();
  for await (const ev of events) {
    const item = parseKickChatEvent(ev.event, ev.data);
    if (!item) continue;
    const key = kickEventKey(ev.event, ev.data);
    if (key && recent.repeat(key)) continue;
    yield item;
  }
}

/** KICK_PUSHER_KEY set by hand: keep using that Pusher key (the pre-Oct-2026 transport). */
function legacyPusherForced(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.KICK_PUSHER_KEY?.trim());
}

/**
 * The chatroom's event stream: whatever Kick's realtime service offers for the channel (Centrifugo
 * since Oct 2026, or a Pusher key/cluster), else the hand-set / built-in Pusher key. Null when aborted.
 */
async function chatEvents(
  opts: KickChatOptions,
  room: ChatroomInfo,
  channels: string[],
  optionalChannels: string[],
): Promise<AsyncGenerator<PusherEvent> | null> {
  const { signal } = opts;
  if (opts.pusherUrl || legacyPusherForced() || !room.channelId) {
    return pusherEvents({ url: opts.pusherUrl ?? kickPusherUrl(), channels, optionalChannels, signal });
  }
  const target = await (opts.realtime ?? kickRealtimeTarget)(room.channelId, signal);
  if (signal.aborted) return null;
  if (target.provider === 'pusher') {
    return pusherEvents({ url: pusherUrlFor(target.appKey, target.cluster), channels, optionalChannels, signal });
  }
  const token = opts.guestToken ?? kickGuestToken;
  return centrifugoEvents({ url: target.url, token: () => token(target.clientId, signal), channels, optionalChannels, signal });
}

/** For tests. */
export function clearChatroomCache(): void {
  chatroomCache.clear();
}
