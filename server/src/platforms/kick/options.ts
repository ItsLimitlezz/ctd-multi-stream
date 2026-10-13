// Non-secret per-account data the Kick driver caches in Account.options.

import type { Account } from '../../../../shared/types.js';
import type { DriverContext } from '../types.js';

export interface KickAccountOptions {
  /** Kick user id (= broadcaster_user_id). */
  userId?: number;
  /** Channel slug (kick.com/<slug>). */
  slug?: string;
  /** kick.com channel id (unofficial API). */
  channelId?: number;
  /** Chat websocket chatroom id (unofficial API), valid for `slug`. */
  chatroomId?: number;
}

function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined;
}

export function readOptions(account: Account | null): KickAccountOptions {
  const o = account?.options ?? {};
  const out: KickAccountOptions = {};
  const userId = int(o.userId);
  if (userId) out.userId = userId;
  if (typeof o.slug === 'string' && o.slug.trim()) out.slug = o.slug.trim();
  const channelId = int(o.channelId);
  if (channelId) out.channelId = channelId;
  const chatroomId = int(o.chatroomId);
  if (chatroomId) out.chatroomId = chatroomId;
  return out;
}

export function sameSlug(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * `patch` merged into the account's options, keeping unrelated keys. A changed slug drops the cached
 * chatroom/channel ids unless the patch brings new ones. Null when nothing changes.
 */
export function mergeOptions(account: Account, patch: KickAccountOptions): Record<string, unknown> | null {
  const current = account.options ?? {};
  const next: Record<string, unknown> = { ...current };
  if (patch.slug && !sameSlug(patch.slug, readOptions(account).slug)) {
    delete next.chatroomId;
    delete next.channelId;
  }
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v;
  const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
  return [...keys].some((k) => current[k] !== next[k]) ? next : null;
}

/**
 * Persist `patch` into the account's options when it changes anything. Also updates `account.options`
 * (the caller's per-call snapshot) so later merges in the same live build on it.
 */
export async function updateOptions(ctx: DriverContext, account: Account, patch: KickAccountOptions): Promise<void> {
  const next = mergeOptions(account, patch);
  if (!next) return;
  await ctx.updateAccount({ options: next });
  account.options = next;
}
