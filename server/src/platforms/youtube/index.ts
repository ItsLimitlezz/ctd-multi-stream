// YouTube driver (official API).
// Connect: Google OAuth device flow with the user's own "TVs and Limited Input devices" client.
// Each live: a new broadcast (title, privacy, latency, made-for-kids) bound to the destination's
// reusable RTMPS stream, auto-started by the video (no auto stop); the title is updated through
// the API while live; chat (with moderation and Super Chat / membership alerts) and the viewer count
// are read through the API; the broadcast is completed when the live ends (or, after a crash, by the
// next prepare, which won't start while an earlier broadcast is still on air on the same stream).
// Session test mode makes every broadcast private, whatever the destination's privacy.
// Docs: https://developers.google.com/youtube/v3/live/docs
//       https://developers.google.com/identity/protocols/oauth2/limited-input-device

import type { ConnectPoll, ConnectStart } from '../../../../shared/api.js';
import type { Account, Destination } from '../../../../shared/types.js';
import type { ScopedSecrets } from '../../services.js';
import { PlatformHttpError } from '../common/http.js';
import { oauthErrorCode, pollDeviceToken, saveTokens, startDeviceFlow, type DevicePollResult } from '../common/oauth.js';
import { DriverError, type DriverContext, type PlatformDriver, type PreparedLive } from '../types.js';
import {
  APP_MISSING,
  createTokenSource,
  GOOGLE_DEVICE_CODE_URL,
  GOOGLE_TOKEN_URL,
  requireApp,
  YOUTUBE_SCOPE,
  YouTubeClient,
} from './api.js';
import {
  BROADCAST_KEY,
  checkLeftover,
  confirmLive,
  createBroadcast,
  ensureStream,
  finishBroadcast,
  LEFTOVER_BROADCASTS_KEY,
  LIVE_STREAM_KEY,
  setBroadcastTitle,
  type LeftoverCheck,
} from './broadcast.js';
import { createChatSource } from './chat.js';
import { readOptions, YOUTUBE_INFO, youtubeTitle } from './info.js';
import { watchViewers } from './viewers.js';

/** Pending device-code sign-in (accountSecrets key 'device'). */
interface DeviceState {
  deviceCode: string;
  /** Seconds between token polls; grows by 5 on slow_down (RFC 8628 §3.5). */
  interval: number;
  expiresAt: number;
  /** Polls arriving before this are answered "pending" without calling Google. */
  nextPollAt: number;
}

const DEVICE_KEY = 'device';
/** UI poll timers jitter: accept a poll that arrives up to this much early. */
const POLL_TOLERANCE_MS = 1_000;

function accountSecrets(ctx: DriverContext): ScopedSecrets {
  if (!ctx.accountSecrets) throw new DriverError('No YouTube account linked to this destination', 'not-connected');
  return ctx.accountSecrets;
}

function clientFor(ctx: DriverContext): YouTubeClient {
  return new YouTubeClient(createTokenSource(accountSecrets(ctx), requireApp(ctx.app)));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Map device-flow failures (Google OAuth errors, network) to actionable DriverErrors. */
function signInError(err: unknown, signal: AbortSignal): unknown {
  if (signal.aborted || err instanceof DriverError) return err;
  if (err instanceof PlatformHttpError) {
    const code = oauthErrorCode(err.body) ?? (err.body.includes('rate_limit_exceeded') ? 'rate_limit_exceeded' : null);
    switch (code) {
      case 'invalid_client':
      case 'unauthorized_client':
        return new DriverError(
          'Google rejected the YouTube developer app. Check the Client ID and secret in Settings → Developer apps; ' +
            'the OAuth client type must be "TVs and Limited Input devices".',
          'misconfigured',
        );
      case 'invalid_scope':
      case 'restricted_client':
        return new DriverError(
          'This OAuth client cannot request YouTube access. Create a client of type "TVs and Limited Input devices".',
          'misconfigured',
        );
      case 'org_internal':
        return new DriverError(
          'This Google OAuth app only allows users of its Google Workspace organization. Set its audience to External.',
          'misconfigured',
        );
      case 'admin_policy_enforced':
        return new DriverError("Your Google Workspace administrator doesn't allow this app to access YouTube.", 'not-eligible');
      case 'rate_limit_exceeded':
        return new DriverError('Google is rate-limiting sign-in requests. Wait a minute and try again.', 'platform-error');
      default:
        return new DriverError(`Google sign-in failed: ${err.message}`, 'platform-error');
    }
  }
  if (err instanceof TypeError || (err instanceof Error && err.name === 'TimeoutError')) {
    return new DriverError(`Couldn't reach Google: ${err.message}`, 'platform-error');
  }
  return err;
}

/**
 * Temporary sign-in failures (Google 5xx / rate limits, network, timeouts): the device flow keeps
 * polling instead of failing. Google can send rate_limit_exceeded with a 403, so match the code too.
 */
function isTransientSignInError(err: unknown): boolean {
  if (err instanceof PlatformHttpError) {
    return (
      err.status >= 500 ||
      err.status === 429 ||
      oauthErrorCode(err.body) === 'rate_limit_exceeded' ||
      err.body.includes('rate_limit_exceeded')
    );
  }
  if (err instanceof Error && err.name === 'TimeoutError') return true;
  return err instanceof TypeError; // fetch network failure
}

/** Extra wait added to the poll interval after a rate limit. */
const RATE_LIMIT_BACKOFF_MS = 5_000;

/** Read the channel and store it on the account (label = channel title, options.channelId). */
async function linkChannel(account: Account, ctx: DriverContext): Promise<Account> {
  const channel = await clientFor(ctx).myChannel(ctx.signal);
  if (!channel?.id) throw new DriverError('This Google account has no YouTube channel', 'not-eligible');
  const patch = {
    label: channel.snippet?.title?.trim() || YOUTUBE_INFO.name,
    status: 'connected' as const,
    statusMessage: null,
    options: { ...account.options, channelId: channel.id },
  };
  await ctx.updateAccount(patch);
  return { ...account, ...patch };
}

/** Non-success device poll results. */
async function pendingResult(
  result: Exclude<DevicePollResult, { status: 'ok' }>,
  device: DeviceState,
  secrets: ScopedSecrets,
  now: number,
): Promise<ConnectPoll> {
  switch (result.status) {
    case 'pending':
      await secrets.setJson(DEVICE_KEY, { ...device, nextPollAt: now + device.interval * 1000 - POLL_TOLERANCE_MS });
      return { status: 'pending' };
    case 'slow_down': {
      const interval = device.interval + 5;
      await secrets.setJson(DEVICE_KEY, { ...device, interval, nextPollAt: now + interval * 1000 - POLL_TOLERANCE_MS });
      return { status: 'pending' };
    }
    case 'expired':
      await secrets.delete(DEVICE_KEY);
      return { status: 'expired' };
    case 'denied':
      await secrets.delete(DEVICE_KEY);
      return { status: 'error', message: 'Access was denied on the Google consent screen. Click Connect again and allow access.' };
  }
}

/** Most leftover broadcast ids remembered per destination (the oldest are forgotten first). */
const MAX_LEFTOVERS = 10;

/** Leftover broadcast ids: the remembered list plus the last live's broadcast, oldest first. */
async function leftoverIds(secrets: ScopedSecrets): Promise<string[]> {
  let stored: unknown = null;
  try {
    stored = await secrets.getJson<unknown>(LEFTOVER_BROADCASTS_KEY);
  } catch {
    // Unreadable list: start over (the last live's broadcast is still under BROADCAST_KEY).
  }
  const ids = Array.isArray(stored) ? stored.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
  const last = await secrets.get(BROADCAST_KEY);
  if (last) ids.push(last);
  return [...new Set(ids)];
}

function leftoverOnAir(status: string | undefined): DriverError {
  return new DriverError(
    `The previous YouTube broadcast is still ${status ?? 'on air'} and couldn't be ended yet; it would show this live too. ` +
      'Retrying — if this keeps failing, end it in YouTube Studio.',
    'platform-error',
  );
}

function leftoverUnknown(err: unknown): DriverError {
  // Problems the user must fix (login, app setup) keep their code; anything else is retried.
  if (err instanceof DriverError && err.code !== 'platform-error' && err.code !== 'timeout') return err;
  return new DriverError(
    `Couldn't end the previous YouTube broadcast or make sure it is off air (${errText(err)}). ` +
      'Retrying — if this keeps failing, end it in YouTube Studio.',
    'platform-error',
  );
}

/**
 * End the broadcasts earlier lives left behind (crash, or an end() that failed). One that can't be
 * ended yet is remembered under LEFTOVER_BROADCASTS_KEY (the new broadcast overwrites
 * BROADCAST_KEY) and retried by the next prepare(). If it is still on air on the destination's
 * stream, or YouTube can't tell, this throws a retryable error instead of starting a live that it
 * would mirror (publicly, even in test mode).
 */
async function endLeftovers(client: YouTubeClient, secrets: ScopedSecrets, ctx: DriverContext): Promise<void> {
  const ids = await leftoverIds(secrets);
  if (ids.length === 0) return;
  const streamId = await secrets.get(LIVE_STREAM_KEY);
  const kept: string[] = [];
  let blocker: DriverError | null = null;
  for (const id of ids) {
    try {
      await finishBroadcast(client, id, ctx.signal);
      ctx.log.info({ broadcastId: id }, 'ended a leftover YouTube broadcast');
      continue;
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log.warn({ broadcastId: id, error: errText(err) }, 'ending a leftover YouTube broadcast failed');
    }
    let check: LeftoverCheck;
    try {
      check = await checkLeftover(client, id, streamId, ctx.signal);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      kept.push(id);
      blocker ??= leftoverUnknown(err);
      continue;
    }
    if (check.state === 'gone') {
      ctx.log.info({ broadcastId: id, status: check.status }, 'leftover YouTube broadcast is gone');
      continue;
    }
    kept.push(id);
    if (check.state === 'on-air') blocker ??= leftoverOnAir(check.status);
    else ctx.log.info({ broadcastId: id, status: check.status }, 'leftover YouTube broadcast kept for the next live');
  }
  // Save the unresolved ids before BROADCAST_KEY is cleared (and later overwritten by the new broadcast).
  if (kept.length > MAX_LEFTOVERS) {
    ctx.log.warn({ dropped: kept.slice(0, kept.length - MAX_LEFTOVERS) }, 'forgetting the oldest leftover YouTube broadcasts');
  }
  const remembered = kept.slice(-MAX_LEFTOVERS);
  if (remembered.length > 0) await secrets.setJson(LEFTOVER_BROADCASTS_KEY, remembered);
  else await secrets.delete(LEFTOVER_BROADCASTS_KEY);
  await secrets.delete(BROADCAST_KEY);
  if (blocker) throw blocker;
}

export const youtubeDriver: PlatformDriver = {
  info: YOUTUBE_INFO,

  async startConnect(account: Account, ctx: DriverContext): Promise<ConnectStart> {
    const app = requireApp(ctx.app);
    const secrets = accountSecrets(ctx);
    let start: Awaited<ReturnType<typeof startDeviceFlow>>;
    try {
      start = await startDeviceFlow({
        endpoint: GOOGLE_DEVICE_CODE_URL,
        clientId: app.clientId,
        scopes: [YOUTUBE_SCOPE],
        signal: ctx.signal,
      });
    } catch (err) {
      throw signInError(err, ctx.signal);
    }
    const interval = Math.max(1, Math.round(start.interval) || 5);
    const expiresIn = Number.isFinite(start.expiresIn) && start.expiresIn > 0 ? start.expiresIn : 1800;
    const device: DeviceState = { deviceCode: start.deviceCode, interval, expiresAt: Date.now() + expiresIn * 1000, nextPollAt: 0 };
    await secrets.setJson(DEVICE_KEY, device);
    ctx.log.info({ accountId: account.id }, 'YouTube device sign-in started');
    // Google's response has `verification_url` (mapped by startDeviceFlow) and no "complete" URL.
    return { method: 'device-code', userCode: start.userCode, verificationUri: start.verificationUri, expiresIn, interval };
  },

  async pollConnect(account: Account, ctx: DriverContext): Promise<ConnectPoll> {
    const app = requireApp(ctx.app);
    const secrets = accountSecrets(ctx);
    const device = await secrets.getJson<DeviceState>(DEVICE_KEY);
    if (!device?.deviceCode) return { status: 'expired' };
    const now = Date.now();
    if (now >= device.expiresAt) {
      await secrets.delete(DEVICE_KEY);
      return { status: 'expired' };
    }
    if (now < device.nextPollAt) return { status: 'pending' };

    let result: DevicePollResult;
    try {
      result = await pollDeviceToken({
        tokenEndpoint: GOOGLE_TOKEN_URL,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        deviceCode: device.deviceCode,
        signal: ctx.signal,
      });
    } catch (err) {
      if (ctx.signal.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
      // invalid_grant: the code was already used or is no longer valid.
      if (err instanceof PlatformHttpError && oauthErrorCode(err.body) === 'invalid_grant') {
        await secrets.delete(DEVICE_KEY);
        return { status: 'expired' };
      }
      // Temporary: keep the device state and let the UI poll again later (the expiry check above
      // still ends the flow once the code expires).
      if (isTransientSignInError(err)) {
        const rateLimited = err instanceof PlatformHttpError && err.status < 500;
        const wait = device.interval * 1000 - POLL_TOLERANCE_MS + (rateLimited ? RATE_LIMIT_BACKOFF_MS : 0);
        await secrets.setJson(DEVICE_KEY, { ...device, nextPollAt: now + wait });
        ctx.log.warn({ accountId: account.id, error: errText(err) }, 'YouTube device token poll failed; will retry');
        return { status: 'pending' };
      }
      throw signInError(err, ctx.signal);
    }
    if (result.status !== 'ok') return pendingResult(result, device, secrets, now);

    await secrets.delete(DEVICE_KEY);
    const granted = result.tokens.scope?.split(/\s+/) ?? null;
    if (granted && !granted.includes(YOUTUBE_SCOPE)) {
      return { status: 'error', message: 'Google did not grant access to YouTube. Click Connect again and allow "Manage your YouTube account".' };
    }
    await saveTokens(secrets, result.tokens);
    try {
      const linked = await linkChannel(account, ctx);
      ctx.log.info({ accountId: account.id }, 'YouTube account connected');
      return { status: 'connected', account: linked };
    } catch (err) {
      if (err instanceof DriverError) return { status: 'error', message: err.message };
      throw err;
    }
  },

  async checkAccount(account: Account, ctx: DriverContext) {
    const linked = await linkChannel(account, ctx);
    return { status: 'connected' as const, label: linked.label };
  },

  async validateDestination(dest: Destination, account: Account | null, ctx: DriverContext): Promise<string[]> {
    const problems: string[] = [];
    if (!ctx.app?.clientId?.trim() || !ctx.app?.clientSecret?.trim()) problems.push(APP_MISSING);
    if (!account) problems.push('Choose a connected YouTube account for this destination');
    else if (account.platform !== 'youtube') problems.push('The selected account is not a YouTube account');
    if (!YOUTUBE_INFO.feeds.includes(dest.feed)) problems.push(`YouTube can't take the ${dest.feed} feed`);
    return problems;
  },

  async prepare(dest: Destination, account: Account | null, title: string, ctx: DriverContext): Promise<PreparedLive> {
    if (!account) throw new DriverError('Choose a connected YouTube account for this destination', 'not-connected');
    const client = clientFor(ctx);
    const destSecrets = ctx.destinationSecrets;
    if (!destSecrets) throw new DriverError('YouTube destination storage is unavailable', 'misconfigured');
    const { log, signal } = ctx;
    const opts = readOptions(dest.options, ctx.testMode === true);
    const since = Date.now();

    await endLeftovers(client, destSecrets, ctx);
    const channelId = typeof account.options.channelId === 'string' ? account.options.channelId : null;
    const stream = await ensureStream(client, destSecrets, dest.feed, channelId, log, signal);
    const broadcast = await createBroadcast(client, youtubeTitle(title, dest.name), opts, stream.id, log, signal, (id) =>
      destSecrets.set(BROADCAST_KEY, id),
    );
    const broadcastId = broadcast.id;
    log.info(
      { broadcastId, feed: dest.feed, privacy: opts.privacy, latency: opts.latency, testMode: ctx.testMode === true },
      'YouTube broadcast ready',
    );

    const prepared: PreparedLive = {
      push: { url: stream.url, mode: 'copy', feeds: [dest.feed] },
      watchUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(broadcastId)}`,
      // The driver call's signal is not used past prepare(): these run later with their own timeouts.
      confirm: (s) => confirmLive(client, broadcastId, log, s),
      // Viewer count only (videos.list every 60 s); YouTube lives are not recovered automatically.
      health: watchViewers(client, broadcastId, log),
      setTitle: (next, s) => setBroadcastTitle(client, broadcastId, youtubeTitle(next, dest.name), s),
      end: async (s) => {
        // Throws (keeping BROADCAST_KEY, so the next prepare() ends it) when it can't be ended yet.
        await finishBroadcast(client, broadcastId, s);
        if ((await destSecrets.get(BROADCAST_KEY)) === broadcastId) await destSecrets.delete(BROADCAST_KEY);
        log.info({ broadcastId }, 'YouTube broadcast ended');
      },
    };
    // Made-for-kids broadcasts have no live chat.
    if (opts.enableChat && !opts.madeForKids) {
      let liveChatId = broadcast.snippet?.liveChatId ?? null;
      prepared.chat = createChatSource({
        client,
        since,
        log,
        liveChatId: async (s) => {
          liveChatId ??= (await client.getBroadcast(broadcastId, 'snippet', s))?.snippet?.liveChatId ?? null;
          return liveChatId;
        },
      });
    }
    return prepared;
  },
};
