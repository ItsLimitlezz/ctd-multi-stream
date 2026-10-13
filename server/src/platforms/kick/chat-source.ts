// Chat source for one prepared Kick live: resolve the chatroom id (cached), then stream the
// chatroom's Pusher events as chat messages until the signal aborts.

import type { Account } from '../../../../shared/types.js';
import type { ChatMessageInput, DriverContext } from '../types.js';
import { errorText } from './api.js';
import { chatroomChannel, parseKickChatEvent } from './chat.js';
import { ChatroomNotFoundError, lookupChatroom, type ChatroomInfo } from './chatroom.js';
import { readOptions, sameSlug, updateOptions } from './options.js';
import { kickPusherUrl, pusherEvents } from './pusher.js';

/** Waits between failed chatroom lookups (each may launch a browser, so back off generously). */
const LOOKUP_BACKOFF_MS = [10_000, 30_000, 60_000, 120_000, 300_000] as const;

/** slug (lower case) → chatroom id, shared by every live of the process. */
const chatroomCache = new Map<string, number>();

export interface KickChatOptions {
  ctx: DriverContext;
  account: Account;
  slug: string;
  signal: AbortSignal;
  /** Test seams. */
  pusherUrl?: string;
  lookup?: (slug: string, signal: AbortSignal) => Promise<ChatroomInfo>;
  backoffMs?: readonly number[];
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

/** Chatroom id from the caches, else looked up (retrying with backoff). Null when aborted. */
export async function resolveChatroomId(opts: KickChatOptions): Promise<number | null> {
  const { ctx, account, slug, signal } = opts;
  const key = slug.toLowerCase();
  const cached = readOptions(account);
  const known = chatroomCache.get(key) ?? (sameSlug(cached.slug, slug) ? cached.chatroomId : undefined);
  if (known) return known;

  const lookup =
    opts.lookup ?? ((s: string, sig: AbortSignal) => lookupChatroom(s, { browser: ctx.browser, accountId: account.id, signal: sig }));
  const backoff = opts.backoffMs ?? LOOKUP_BACKOFF_MS;
  for (let attempt = 0; !signal.aborted; attempt++) {
    try {
      const info = await lookup(slug, signal);
      chatroomCache.set(key, info.chatroomId);
      try {
        await updateOptions(ctx, account, {
          slug,
          chatroomId: info.chatroomId,
          ...(info.channelId ? { channelId: info.channelId } : {}),
        });
      } catch (err) {
        ctx.log.warn({ error: errorText(err) }, 'could not cache the Kick chatroom id');
      }
      return info.chatroomId;
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

/** Read-only chat for a Kick channel. Throws when the websocket drops (the ChatHub restarts it). */
export async function* kickChat(opts: KickChatOptions): AsyncGenerator<ChatMessageInput> {
  const chatroomId = await resolveChatroomId(opts);
  if (chatroomId === null || opts.signal.aborted) return;
  const events = pusherEvents({
    url: opts.pusherUrl ?? kickPusherUrl(),
    channels: [chatroomChannel(chatroomId)],
    signal: opts.signal,
  });
  for await (const ev of events) {
    const msg = parseKickChatEvent(ev.event, ev.data);
    if (msg) yield msg;
  }
}

/** For tests. */
export function clearChatroomCache(): void {
  chatroomCache.clear();
}
