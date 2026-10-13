// YouTube driver (official API).
// Connect: Google OAuth device flow with the user's own "TVs and Limited Input devices" client.
// Each live: a new broadcast (title, privacy, latency, made-for-kids) bound to the destination's
// reusable RTMPS stream, auto-started by the video (no auto stop); the title is updated through
// the API while live; chat is read through the API; the broadcast is completed when the live ends
// (or, after a crash, by the next prepare).
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
  confirmLive,
  createBroadcast,
  ensureStream,
  finishBroadcast,
  setBroadcastTitle,
} from './broadcast.js';
import { createChatSource } from './chat.js';
import { readOptions, YOUTUBE_INFO, youtubeTitle } from './info.js';

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

/** End the broadcast a previous (crashed or interrupted) live left behind. Best effort. */
async function endLeftover(client: YouTubeClient, secrets: ScopedSecrets, ctx: DriverContext): Promise<void> {
  const previous = await secrets.get(BROADCAST_KEY);
  if (!previous) return;
  try {
    await finishBroadcast(client, previous, ctx.signal);
    await secrets.delete(BROADCAST_KEY);
    ctx.log.info({ broadcastId: previous }, 'ended a leftover YouTube broadcast');
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    ctx.log.warn({ broadcastId: previous, error: errText(err) }, 'ending a leftover YouTube broadcast failed');
  }
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
    const opts = readOptions(dest.options);
    const since = Date.now();

    await endLeftover(client, destSecrets, ctx);
    const channelId = typeof account.options.channelId === 'string' ? account.options.channelId : null;
    const stream = await ensureStream(client, destSecrets, dest.feed, channelId, log, signal);
    const broadcast = await createBroadcast(client, youtubeTitle(title, dest.name), opts, stream.id, log, signal, (id) =>
      destSecrets.set(BROADCAST_KEY, id),
    );
    const broadcastId = broadcast.id;
    log.info({ broadcastId, feed: dest.feed, privacy: opts.privacy, latency: opts.latency }, 'YouTube broadcast ready');

    const prepared: PreparedLive = {
      push: { url: stream.url, mode: 'copy', feeds: [dest.feed] },
      watchUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(broadcastId)}`,
      // The driver call's signal is not used past prepare(): these run later with their own timeouts.
      confirm: (s) => confirmLive(client, broadcastId, log, s),
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
