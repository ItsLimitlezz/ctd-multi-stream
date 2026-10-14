// Kick driver: OAuth 2.1 (authorization code + PKCE, paste-back), stream title + stream key + viewer
// count through the official public API (https://docs.kick.com), read-only chat (with moderation and
// alerts) through Kick's public Pusher websocket (unofficial, see chat.ts). Only the title is ever
// changed — never the category. Kick has no test mode: it is skipped while session test mode is on.

import crypto from 'node:crypto';
import type { ConnectPoll, ConnectStart } from '../../../../shared/api.js';
import type { Account, Destination, PlatformInfo } from '../../../../shared/types.js';
import { PlatformHttpError, truncateTitle } from '../common/http.js';
import { createPkce, exchangeCode, loadTokens, makeState, parseCallbackUrl, saveTokens } from '../common/oauth.js';
import { DriverError, type DriverContext, type PlatformDriver, type PreparedLive } from '../types.js';
import {
  errorText,
  getMe,
  getMyChannel,
  KICK_AUTHORIZE_URL,
  KICK_SCOPES,
  KICK_TOKEN_URL,
  liveViewerCount,
  mapKickError,
  patchTitle,
  requireApp,
  requireSecrets,
  withKickToken,
  type KickChannel,
} from './api.js';
import { kickChat } from './chat-source.js';
import { fetchChatroomDirect } from './chatroom.js';
import { buildPushUrl, chooseIngestServer, KICK_DEFAULT_INGEST, normalizeIngestServer, usableStreamKey } from './ingest.js';
import { mergeOptions, readOptions, sameSlug, updateOptions } from './options.js';
import { pollViewers } from './viewers.js';

/**
 * Kick doesn't document a stream_title maximum (docs.kick.com/apis/channels: minLength 1 only); we use
 * the app-wide title cap (orchestrator MAX_TITLE_LENGTH = 140).
 */
export const KICK_TITLE_MAX = 140;
const PKCE_TTL_MS = 30 * 60 * 1000;
const LIVE_TITLE_TIMEOUT_MS = 20_000;
const VIEWERS_TIMEOUT_MS = 20_000;

const MISSING_KEY = 'Paste your Kick stream key in this destination (Kick dashboard → Settings → Stream URL & Key)';
const MISSING_API_KEY =
  'Kick did not return your stream key: reconnect the Kick account and approve the stream key permission, or paste your Kick stream key in this destination (Kick dashboard → Settings → Stream URL & Key)';
const BAD_SERVER = 'Server URL must be an rtmps:// (or rtmp://) address without a query string';

export const kickInfo: PlatformInfo = {
  id: 'kick',
  name: 'Kick',
  feeds: ['landscape', 'vertical'],
  defaultFeed: 'landscape',
  connectMethod: 'oauth-paste',
  accountFields: [],
  destinationFields: [
    {
      key: 'ingestUrl',
      label: 'Server URL',
      type: 'url',
      target: 'ingestUrl',
      required: false,
      default: KICK_DEFAULT_INGEST,
      placeholder: KICK_DEFAULT_INGEST,
      help: "Kick's ingest server. Keep the default unless you want a specific ingest server from your Kick dashboard (Settings → Stream URL & Key).",
    },
    {
      key: 'streamKey',
      label: 'Stream key',
      type: 'secret',
      target: 'streamKey',
      required: false,
      help: 'Optional: read automatically from the connected Kick account. Paste it (Kick dashboard → Settings → Stream URL & Key) only to stream without a connected account.',
    },
  ],
  developerApp: {
    consoleUrl: 'https://kick.com/settings/developer',
    fields: [
      { key: 'clientId', label: 'Client ID', type: 'text', required: true },
      { key: 'clientSecret', label: 'Client Secret', type: 'secret', required: true },
    ],
    instructions: [
      '1. Turn on two-factor authentication in your Kick account settings (Kick requires it for developer apps).',
      '2. Open kick.com/settings/developer and create a new app (any name, e.g. "CTD Multi-Stream").',
      '3. Redirect URL: copy it from this page and paste it exactly.',
      `4. Enable these scopes: ${KICK_SCOPES.join(', ')} (read user, read channel, update channel title, read stream key). Leave webhooks off.`,
      '5. Create the app, then copy its Client ID and Client Secret into the fields here and save.',
      '6. Go to Accounts, add a Kick account and click Connect.',
    ].join('\n'),
  },
  titleSupport: 'api',
  chatSupport: 'unofficial',
  keyPerSession: false,
  experimental: false,
  notes:
    "Title and stream key use Kick's official API; the category is never changed. Chat is read from Kick's public chat websocket (unofficial), so it can break when Kick changes it.",
  testMode: { supported: false, description: 'Kick has no test mode — skipped while testing' },
};

// ---------------------------------------------------------------------------
// Connect (authorization code + PKCE, paste-back)
// ---------------------------------------------------------------------------

interface PendingPkce {
  verifier: string;
  state: string;
  redirectUri: string;
  createdAt: number;
}

function redirectUriFor(ctx: DriverContext): string {
  return `${ctx.publicBaseUrl.replace(/\/+$/, '')}/oauth/callback/kick`;
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Scopes we asked for that the token doesn't carry (null when Kick didn't report scopes). */
function missingScopes(scope: string | null): string[] | null {
  if (!scope) return null;
  const granted = new Set(scope.split(/[\s,]+/).filter(Boolean));
  return KICK_SCOPES.filter((s) => !granted.has(s));
}

function scopeWarning(missing: string[] | null): string | null {
  if (!missing?.length) return null;
  const parts = [`Missing Kick permissions: ${missing.join(', ')}.`];
  if (missing.includes('streamkey:read')) parts.push('Paste the stream key in the destination, or');
  parts.push(`enable ${missing.length === 1 ? 'it' : 'them'} in your Kick app and reconnect.`);
  return parts.join(' ');
}

async function startConnect(account: Account, ctx: DriverContext): Promise<ConnectStart> {
  const app = requireApp(ctx);
  const secrets = requireSecrets(ctx);
  const pkce = createPkce();
  const state = makeState(account.id);
  const redirectUri = redirectUriFor(ctx);
  const pending: PendingPkce = { verifier: pkce.verifier, state, redirectUri, createdAt: Date.now() };
  await secrets.setJson('pkce', pending);

  // https://docs.kick.com/getting-started/generating-tokens-oauth2-flow#authorization-endpoint
  // Documented workaround: Kick's login page rewrites the first "127.0.0.1" in the URL to "localhost",
  // so a sacrificial `redirect=127.0.0.1` must come before redirect_uri.
  const workaround: [string, string][] = new URL(redirectUri).hostname === '127.0.0.1' ? [['redirect', '127.0.0.1']] : [];
  const params = new URLSearchParams([
    ...workaround,
    ['response_type', 'code'],
    ['client_id', app.clientId],
    ['redirect_uri', redirectUri],
    ['scope', KICK_SCOPES.join(' ')],
    ['code_challenge', pkce.challenge],
    ['code_challenge_method', pkce.method],
    ['state', state],
  ]);
  return {
    method: 'oauth-paste',
    authorizeUrl: `${KICK_AUTHORIZE_URL}?${params.toString()}`,
    redirectUri,
    instructions:
      'Open the link, sign in to Kick and approve access. You are then sent back to this app. If that page does not load (e.g. this app is not reachable at that address from your browser), copy the full address from the address bar and paste it here.',
  };
}

/**
 * Fetch the user + channel and store them on the account (label, options, status 'connected' with a
 * warning about missing permissions). Returns the account as now stored.
 */
async function syncAccount(account: Account, ctx: DriverContext): Promise<{ account: Account; channel: KickChannel }> {
  const [user, channel] = await withKickToken(ctx, account.id, ctx.signal, 'reading your Kick profile', (token) =>
    Promise.all([getMe(token, ctx.signal), getMyChannel(token, ctx.signal)]),
  );
  const tokens = await loadTokens(requireSecrets(ctx));
  const statusMessage = scopeWarning(missingScopes(tokens?.scope ?? null));
  const options = mergeOptions(account, { userId: user.user_id, slug: channel.slug }) ?? account.options;
  const label = user.name.trim() || channel.slug;
  await ctx.updateAccount({ label, status: 'connected', statusMessage, options });
  return {
    account: { ...account, label, status: 'connected', statusMessage, options, updatedAt: new Date().toISOString() },
    channel,
  };
}

/** Best effort at connect time: cache the chat chatroom id if kick.com answers a plain request. */
async function prefetchChatroom(account: Account, slug: string, ctx: DriverContext): Promise<void> {
  const cached = readOptions(account);
  if (cached.chatroomId && sameSlug(cached.slug, slug)) return;
  try {
    const info = await fetchChatroomDirect(slug, { signal: ctx.signal, timeoutMs: 5_000 });
    if (info) {
      await updateOptions(ctx, account, { slug, chatroomId: info.chatroomId, ...(info.channelId ? { channelId: info.channelId } : {}) });
    }
  } catch (err) {
    ctx.log.debug({ error: errorText(err) }, 'Kick chatroom prefetch skipped');
  }
}

async function completeConnect(
  account: Account,
  input: { pastedUrl?: string; fields?: Record<string, string> },
  ctx: DriverContext,
): Promise<ConnectPoll> {
  const app = requireApp(ctx);
  const secrets = requireSecrets(ctx);
  const pasted = input.pastedUrl?.trim();
  if (!pasted) return { status: 'error', message: 'Paste the full address of the page Kick sent you to after approving access.' };

  const callback = parseCallbackUrl(pasted);
  const pending = await secrets.getJson<PendingPkce>('pkce');
  if (!pending?.state || !pending.verifier) return { status: 'expired' };
  if (typeof pending.createdAt !== 'number' || Date.now() - pending.createdAt > PKCE_TTL_MS) {
    await secrets.delete('pkce');
    return { status: 'expired' };
  }
  // The state is the CSRF defense of the OAuth landing route: it must match exactly.
  if (!callback.state || !sameSecret(callback.state, pending.state)) {
    return { status: 'error', message: 'This sign-in link does not belong to the connection you started. Start the connection again.' };
  }
  if (callback.error) {
    await secrets.delete('pkce');
    const why = (callback.errorDescription || callback.error).slice(0, 200);
    return { status: 'error', message: `Kick did not authorize the app: ${why}` };
  }
  if (!callback.code) return { status: 'error', message: 'The pasted address has no authorization code. Paste the full address.' };

  // Codes are single-use: consume the pending state before exchanging.
  await secrets.delete('pkce');
  let tokens;
  try {
    tokens = await exchangeCode({
      tokenEndpoint: KICK_TOKEN_URL,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      code: callback.code,
      redirectUri: pending.redirectUri,
      codeVerifier: pending.verifier,
      signal: ctx.signal,
    });
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    ctx.log.warn({ error: errorText(err) }, 'Kick token exchange failed');
    if (err instanceof PlatformHttpError && err.status >= 400 && err.status < 500) {
      return {
        status: 'error',
        message:
          'Kick rejected the authorization (the code may have expired or been used, or the Client ID/Secret or Redirect URL do not match the Kick app). Start the connection again.',
      };
    }
    return { status: 'error', message: errorText(mapKickError(err, 'exchanging the authorization code')) };
  }
  await saveTokens(secrets, tokens);

  try {
    const { account: connected, channel } = await syncAccount(account, ctx);
    await prefetchChatroom(connected, channel.slug, ctx);
    return { status: 'connected', account: connected };
  } catch (err) {
    if (err instanceof DriverError && !ctx.signal.aborted) return { status: 'error', message: err.message };
    throw err;
  }
}

async function checkAccount(account: Account, ctx: DriverContext): Promise<{ status: 'connected'; label: string; message?: string }> {
  const { account: synced } = await syncAccount(account, ctx);
  return { status: 'connected', label: synced.label, ...(synced.statusMessage ? { message: synced.statusMessage } : {}) };
}

// ---------------------------------------------------------------------------
// Destination: title, ingest, chat
// ---------------------------------------------------------------------------

async function validateDestination(dest: Destination, account: Account | null): Promise<string[]> {
  const problems: string[] = [];
  if (!account && !dest.hasStreamKey) {
    problems.push('Connect a Kick account to this destination, or paste your Kick stream key (Kick dashboard → Settings → Stream URL & Key)');
  }
  if (dest.ingestUrl && !normalizeIngestServer(dest.ingestUrl)) problems.push(BAD_SERVER);
  return problems;
}

function titleFor(title: string): string {
  return truncateTitle(title, KICK_TITLE_MAX);
}

async function updateTitle(ctx: DriverContext, account: Account, title: string, signal: AbortSignal): Promise<void> {
  const value = titleFor(title);
  if (!value) return; // Kick requires a non-empty title; leave the current one
  await withKickToken(ctx, account.id, signal, 'updating the stream title', (token) => patchTitle(token, value, signal));
}

async function setTitleOffline(_dest: Destination, account: Account | null, title: string, ctx: DriverContext): Promise<void> {
  if (!account) return; // key-only destination: no API access to the title
  await updateTitle(ctx, account, title, ctx.signal);
}

async function readManualKey(ctx: DriverContext): Promise<string | null> {
  return usableStreamKey(await ctx.destinationSecrets?.get('streamKey'));
}

/** The account's channel (title, slug, stream key); null when the API failed but a pasted key can stream. */
async function channelOrFallback(account: Account, ctx: DriverContext, canFallBack: boolean): Promise<KickChannel | null> {
  try {
    return await withKickToken(ctx, account.id, ctx.signal, 'reading your Kick channel', (token) => getMyChannel(token, ctx.signal));
  } catch (err) {
    if (ctx.signal.aborted || !canFallBack) throw err;
    ctx.log.warn({ error: errorText(err) }, 'Kick API unavailable; streaming with the pasted stream key (title not updated)');
    if (err instanceof DriverError && err.code === 'needs-login') {
      await ctx.updateAccount({ status: 'needs-login', statusMessage: err.message }).catch(() => {});
    }
    return null;
  }
}

async function applyTitle(account: Account, channel: KickChannel, title: string, ctx: DriverContext): Promise<void> {
  const value = titleFor(title);
  if (!value || channel.stream_title === value) return;
  try {
    await updateTitle(ctx, account, value, ctx.signal);
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    ctx.log.warn({ error: errorText(err) }, 'could not set the Kick title; streaming anyway');
  }
}

async function prepare(dest: Destination, account: Account | null, title: string, ctx: DriverContext): Promise<PreparedLive> {
  // The orchestrator skips Kick in test mode; never go out publicly if it ever asks anyway.
  if (ctx.testMode === true) throw new DriverError(kickInfo.testMode!.description, 'not-eligible');
  const manualKey = await readManualKey(ctx);
  const channel = account ? await channelOrFallback(account, ctx, manualKey !== null) : null;

  if (account && channel) {
    try {
      await updateOptions(ctx, account, { slug: channel.slug, userId: channel.broadcaster_user_id });
    } catch (err) {
      ctx.log.warn({ error: errorText(err) }, 'could not update the Kick account details');
    }
    await applyTitle(account, channel, title, ctx);
  }

  const key = usableStreamKey(channel?.stream?.key) ?? manualKey;
  if (!key) throw new DriverError(channel ? MISSING_API_KEY : MISSING_KEY, 'misconfigured');
  const server = chooseIngestServer(dest.ingestUrl, channel?.stream?.url);
  const slug = channel?.slug ?? readOptions(account).slug ?? null;

  const prepared: PreparedLive = {
    push: { url: buildPushUrl(server, key), mode: 'copy', feeds: [dest.feed] },
    watchUrl: slug ? `https://kick.com/${encodeURIComponent(slug)}` : null,
  };
  if (account) {
    prepared.setTitle = (t) => updateTitle(ctx, account, t, AbortSignal.timeout(LIVE_TITLE_TIMEOUT_MS));
    if (slug) prepared.chat = (signal) => kickChat({ ctx, account, slug, signal });
    // Viewers only (GET /public/v1/channels every 30 s); never 'ended': Kick lives aren't recovered.
    prepared.health = (signal) =>
      pollViewers((s) => readViewers(ctx, account, s), signal, {
        log: ctx.log,
        logContext: { destinationId: dest.id, platform: 'kick' },
      });
  }
  return prepared;
}

async function readViewers(ctx: DriverContext, account: Account, signal: AbortSignal): Promise<number | null> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(VIEWERS_TIMEOUT_MS)]);
  const channel = await withKickToken(ctx, account.id, bounded, 'reading the viewer count', (token) => getMyChannel(token, bounded));
  return liveViewerCount(channel);
}

export const kickDriver: PlatformDriver = {
  info: kickInfo,
  startConnect,
  completeConnect,
  checkAccount,
  validateDestination,
  setTitleOffline,
  prepare,
};
