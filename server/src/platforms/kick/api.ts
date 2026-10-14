// Kick public API client (official). Docs (checked Oct 2026):
// - OAuth 2.1 + PKCE: https://docs.kick.com/getting-started/generating-tokens-oauth2-flow
// - Scopes:           https://docs.kick.com/getting-started/scopes
// - Users:            https://docs.kick.com/apis/users     (GET /public/v1/users)
// - Channels:         https://docs.kick.com/apis/channels  (GET/PATCH /public/v1/channels)
// GET /channels without params returns the caller's channel, including `stream.url` + `stream.key`
// when the token has `streamkey:read`, and `stream.is_live` / `stream.viewer_count`. PATCH /channels
// takes { stream_title, category_id, custom_tags }; we only ever send stream_title.

import type { ScopedSecrets } from '../../services.js';
import { PlatformHttpError, fetchJson } from '../common/http.js';
import { getValidTokens, loadTokens, refreshTokens, saveTokens, type OAuthTokens } from '../common/oauth.js';
import { DriverError, type DriverContext } from '../types.js';

export const KICK_AUTHORIZE_URL = 'https://id.kick.com/oauth/authorize';
export const KICK_TOKEN_URL = 'https://id.kick.com/oauth/token';
export const KICK_API_BASE = 'https://api.kick.com/public/v1';

/** Least privilege: identity, channel read (slug, stream key), title write. Chat is read without OAuth. */
export const KICK_SCOPES = ['user:read', 'channel:read', 'channel:write', 'streamkey:read'] as const;

export const APP_MISSING = 'Set up the Kick developer app in Settings → Developer apps';
const LOGIN_EXPIRED = 'Kick login expired — reconnect the account in Accounts';

export interface KickApp {
  clientId: string;
  clientSecret: string;
}

export interface KickUser {
  user_id: number;
  name: string;
}

export interface KickChannel {
  broadcaster_user_id: number;
  slug: string;
  stream_title?: string | null;
  stream?: { url?: string | null; key?: string | null; is_live?: boolean; viewer_count?: number | null } | null;
}

/** Viewers of a channel's current stream (null while it isn't live or Kick doesn't say). */
export function liveViewerCount(channel: KickChannel): number | null {
  const stream = channel.stream;
  if (!stream || stream.is_live === false) return null;
  const n = stream.viewer_count;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

interface KickList<T> {
  data?: T[] | null;
  message?: string;
}

export function requireApp(ctx: DriverContext): KickApp {
  const clientId = ctx.app?.clientId?.trim();
  const clientSecret = ctx.app?.clientSecret?.trim();
  if (!clientId || !clientSecret) throw new DriverError(APP_MISSING, 'misconfigured');
  return { clientId, clientSecret };
}

export function requireSecrets(ctx: DriverContext): ScopedSecrets {
  if (!ctx.accountSecrets) throw new DriverError('No Kick account linked to this destination', 'not-connected');
  return ctx.accountSecrets;
}

/** Short, secret-free description of an error for logs and UI messages. */
export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';
  return msg.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Unknown error';
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}

/** Translate a failed Kick API call into a user-facing DriverError. Caller aborts pass through. */
export function mapKickError(err: unknown, what: string, signal?: AbortSignal): unknown {
  if (signal?.aborted || err instanceof DriverError) return err;
  if (isTimeout(err)) return new DriverError(`Kick did not respond in time while ${what}`, 'timeout');
  if (err instanceof PlatformHttpError) {
    switch (err.status) {
      case 401:
        return new DriverError(LOGIN_EXPIRED, 'needs-login');
      case 403:
        return new DriverError(
          `Kick refused ${what}: the account did not grant the needed permission. Reconnect it in Accounts and approve every permission.`,
          'needs-login',
        );
      case 429:
        return new DriverError(`Kick rate limit reached while ${what} — try again in a minute`, 'platform-error');
      default:
        return new DriverError(`Kick API error while ${what}: ${errorText(err)}`, 'platform-error');
    }
  }
  return new DriverError(`Could not reach Kick while ${what}: ${errorText(err)}`, 'platform-error');
}

async function kickRequest<T>(
  method: 'GET' | 'PATCH',
  path: string,
  token: string,
  signal: AbortSignal,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetchJson<T>(`${KICK_API_BASE}${path}`, {
    method,
    headers,
    signal,
    timeoutMs: 15_000,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function first<T>(res: KickList<T> | undefined, what: string): T {
  const item = res?.data?.[0];
  if (!item) throw new DriverError(`Kick returned no ${what}`, 'platform-error');
  return item;
}

export async function getMe(token: string, signal: AbortSignal): Promise<KickUser> {
  const user = first(await kickRequest<KickList<KickUser>>('GET', '/users', token, signal), 'user');
  if (typeof user.user_id !== 'number' || typeof user.name !== 'string') {
    throw new DriverError('Kick returned an unexpected user response', 'platform-error');
  }
  return user;
}

export async function getMyChannel(token: string, signal: AbortSignal): Promise<KickChannel> {
  const channel = first(await kickRequest<KickList<KickChannel>>('GET', '/channels', token, signal), 'channel');
  if (typeof channel.slug !== 'string' || !channel.slug) {
    throw new DriverError('Kick returned an unexpected channel response', 'platform-error');
  }
  return channel;
}

/** Update the stream title only (never category_id / custom_tags). Kick answers 204. */
export async function patchTitle(token: string, title: string, signal: AbortSignal): Promise<void> {
  await kickRequest<unknown>('PATCH', '/channels', token, signal, { stream_title: title });
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

async function refreshWith(ctx: DriverContext, refreshToken: string, previous: OAuthTokens, signal: AbortSignal): Promise<OAuthTokens> {
  const app = requireApp(ctx);
  return refreshTokens({
    tokenEndpoint: KICK_TOKEN_URL,
    clientId: app.clientId,
    clientSecret: app.clientSecret,
    refreshToken,
    previous,
    signal,
  });
}

/**
 * Token reads/refreshes run one at a time per account. Kick rotates the refresh token on every
 * refresh, so two destinations of one account refreshing in parallel would invalidate each other
 * (the shared helper only dedupes per ScopedSecrets object, and every DriverContext has its own).
 */
const tokenLocks = new Map<string, Promise<void>>();

async function underTokenLock<T>(accountId: string, task: () => Promise<T>): Promise<T> {
  const previous = tokenLocks.get(accountId) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tokenLocks.set(accountId, tail);
  try {
    return await run;
  } finally {
    if (tokenLocks.get(accountId) === tail) tokenLocks.delete(accountId);
  }
}

/** Refresh after Kick rejected `rejected` — unless another caller already replaced it. */
async function refreshAfter401(ctx: DriverContext, secrets: ScopedSecrets, rejected: string, signal: AbortSignal): Promise<OAuthTokens> {
  const current = await loadTokens(secrets);
  if (current && current.accessToken !== rejected) return current;
  if (!current?.refreshToken) throw new DriverError(LOGIN_EXPIRED, 'needs-login');
  try {
    const fresh = await refreshWith(ctx, current.refreshToken, current, signal);
    await saveTokens(secrets, fresh);
    return fresh;
  } catch (err) {
    if (err instanceof PlatformHttpError && (err.status === 400 || err.status === 401)) {
      throw new DriverError(LOGIN_EXPIRED, 'needs-login');
    }
    throw err;
  }
}

/**
 * Run `fn` with a valid access token (refreshed when close to expiry). A 401 triggers one refresh +
 * retry, covering tokens Kick expired early. Errors come back as DriverErrors.
 */
export async function withKickToken<T>(
  ctx: DriverContext,
  accountId: string,
  signal: AbortSignal,
  what: string,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  const secrets = requireSecrets(ctx);
  try {
    const tokens = await underTokenLock(accountId, () =>
      getValidTokens(secrets, 'Kick', (rt, prev) => refreshWith(ctx, rt, prev, signal)),
    );
    try {
      return await fn(tokens.accessToken);
    } catch (err) {
      if (!(err instanceof PlatformHttpError && err.status === 401)) throw err;
      const fresh = await underTokenLock(accountId, () => refreshAfter401(ctx, secrets, tokens.accessToken, signal));
      return await fn(fresh.accessToken);
    }
  } catch (err) {
    throw mapKickError(err, what, signal);
  }
}
