// YouTube Data API v3 client for the driver: OAuth tokens (refresh with the developer app's
// secret), typed Live Streaming calls and mapping of Google errors to actionable DriverErrors.
// Docs: https://developers.google.com/youtube/v3/live/docs
//       https://developers.google.com/youtube/v3/docs/errors

import type { ScopedSecrets } from '../../services.js';
import { fetchJson, PlatformHttpError } from '../common/http.js';
import { getValidTokens, loadTokens, refreshTokens, saveTokens, type OAuthTokens } from '../common/oauth.js';
import { DriverError, type PlatformAppCredentials } from '../types.js';

// https://developers.google.com/identity/protocols/oauth2/limited-input-device
export const GOOGLE_DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** The device flow allows `youtube` (not `youtube.force-ssl`); see the "allowed scopes" list in the doc above. */
export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube';

export const API_BASE = 'https://www.googleapis.com/youtube/v3';
/** Discovery rootUrl; liveChat/messages/stream (server streaming) is served here. */
export const STREAM_API_BASE = 'https://youtube.googleapis.com/youtube/v3';
export const FEATURES_URL = 'https://www.youtube.com/features';

export const APP_MISSING = 'Set up the YouTube developer app in Settings → Developer apps';
const LOGIN_EXPIRED =
  'YouTube login expired — reconnect the account in Accounts. If this happens every week, publish your Google OAuth app ("In production").';

const DEFAULT_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Resource shapes (only the fields we use)
// ---------------------------------------------------------------------------

export interface Channel {
  id: string;
  snippet?: { title?: string };
}

export interface LiveStream {
  id: string;
  snippet?: { channelId?: string; title?: string };
  cdn?: {
    ingestionType?: string;
    ingestionInfo?: { streamName?: string; ingestionAddress?: string; rtmpsIngestionAddress?: string };
  };
  status?: { streamStatus?: string };
}

export interface BroadcastSnippet {
  title?: string;
  description?: string;
  scheduledStartTime?: string;
  scheduledEndTime?: string;
  categoryId?: string;
  liveChatId?: string;
}

export interface LiveBroadcast {
  id: string;
  snippet?: BroadcastSnippet;
  status?: { lifeCycleStatus?: string; privacyStatus?: string };
  contentDetails?: { boundStreamId?: string };
}

/**
 * Google serializes uint64 fields (amountMicros, concurrentViewers...) as JSON strings; accept
 * numbers too.
 */
export type Uint64 = string | number;

export interface LiveChatMessage {
  id?: string;
  snippet?: {
    type?: string;
    publishedAt?: string;
    displayMessage?: string;
    authorChannelId?: string;
    textMessageDetails?: { messageText?: string };
    superChatDetails?: {
      amountMicros?: Uint64;
      /** ISO 4217. */
      currency?: string;
      amountDisplayString?: string;
      userComment?: string;
      tier?: number;
    };
    superStickerDetails?: {
      amountMicros?: Uint64;
      currency?: string;
      amountDisplayString?: string;
      tier?: number;
      superStickerMetadata?: { stickerId?: string; altText?: string; language?: string };
    };
    newSponsorDetails?: { memberLevelName?: string; isUpgrade?: boolean };
    memberMilestoneChatDetails?: { userComment?: string; memberMonth?: number; memberLevelName?: string };
    membershipGiftingDetails?: { giftMembershipsCount?: number; giftMembershipsLevelName?: string };
    giftMembershipReceivedDetails?: { memberLevelName?: string; gifterChannelId?: string; associatedMembershipGiftingMessageId?: string };
    giftEventDetails?: { giftMetadata?: { giftName?: string; altText?: string; comboCount?: number } };
    /** messageDeletedEvent: the id of the removed message. */
    messageDeletedDetails?: { deletedMessageId?: string };
    /** userBannedEvent (ban or timeout): the user whose messages are removed. */
    userBannedDetails?: {
      bannedUserDetails?: { channelId?: string; channelUrl?: string; displayName?: string; profileImageUrl?: string };
      banType?: string;
      banDurationSeconds?: Uint64;
    };
  };
  authorDetails?: {
    /** The author's YouTube channel id (stable user id). */
    channelId?: string;
    channelUrl?: string;
    displayName?: string;
    profileImageUrl?: string;
    isVerified?: boolean;
    isChatOwner?: boolean;
    isChatSponsor?: boolean;
    isChatModerator?: boolean;
  };
}

/** videos.list part=liveStreamingDetails (https://developers.google.com/youtube/v3/docs/videos#liveStreamingDetails). */
export interface VideoLiveDetails {
  id?: string;
  liveStreamingDetails?: {
    actualStartTime?: string;
    actualEndTime?: string;
    /** Absent when the live has ended or the channel hides the count. */
    concurrentViewers?: Uint64;
  };
}

export interface LiveChatPage {
  nextPageToken?: string;
  pollingIntervalMillis?: number;
  offlineAt?: string;
  items?: LiveChatMessage[];
}

interface ListResponse<T> {
  items?: T[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A Google API error, already mapped to a user-facing DriverError. `reasons` keeps the raw reasons. */
export class YouTubeApiError extends DriverError {
  constructor(
    message: string,
    code: DriverError['code'],
    readonly status: number,
    readonly reasons: readonly string[],
  ) {
    super(message, code);
    this.name = 'YouTubeApiError';
  }

  has(...reasons: string[]): boolean {
    return reasons.some((r) => this.reasons.includes(r));
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Reasons + message from a Google error body (`error.errors[].reason`, `error.details[].reason`). */
export function parseGoogleError(body: string): { reasons: string[]; message: string | null } {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { reasons: [], message: null };
  }
  const err = isRecord(json) ? json.error : undefined;
  if (typeof err === 'string') return { reasons: [err], message: null }; // OAuth-style { error: 'invalid_grant' }
  if (!isRecord(err)) return { reasons: [], message: null };
  const reasons: string[] = [];
  for (const list of [err.errors, err.details]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) if (isRecord(item) && typeof item.reason === 'string') reasons.push(item.reason);
  }
  if (typeof err.status === 'string') reasons.push(err.status);
  return { reasons, message: typeof err.message === 'string' ? err.message.slice(0, 300) : null };
}

export const QUOTA_REASONS = ['quotaExceeded', 'dailyLimitExceeded'];
export const RATE_REASONS = ['rateLimitExceeded', 'userRateLimitExceeded', 'userRequestsExceedRateLimit', 'RATE_LIMIT_EXCEEDED'];

/** Map an HTTP error from the YouTube API to an actionable error. `action` reads like "creating the broadcast". */
export function apiError(status: number, body: string, action: string): YouTubeApiError {
  const { reasons, message } = parseGoogleError(body);
  const has = (...r: string[]) => r.some((x) => reasons.includes(x));
  const make = (msg: string, code: DriverError['code']) => new YouTubeApiError(msg, code, status, reasons);

  if (has('liveStreamingNotEnabled')) {
    return make(
      `Live streaming isn't enabled on this YouTube channel. Enable it at ${FEATURES_URL} (the first time can take up to 24 hours).`,
      'not-eligible',
    );
  }
  if (has('livePermissionBlocked', 'insufficientLivePermissions')) {
    return make(`YouTube doesn't allow this channel to stream live right now. Check ${FEATURES_URL}.`, 'not-eligible');
  }
  if (has('youtubeSignupRequired')) return make('This Google account has no YouTube channel', 'not-eligible');
  if (has(...QUOTA_REASONS)) {
    return make(
      'The YouTube API daily quota of your developer app is used up (10,000 units/day by default; chat reading uses most of it). ' +
        'It resets at midnight Pacific time. You can request more quota in the Google Cloud console.',
      'platform-error',
    );
  }
  if (has('accessNotConfigured', 'SERVICE_DISABLED')) {
    return make(
      'YouTube Data API v3 is not enabled in your Google Cloud project. Enable it in APIs & Services → Library, then try again.',
      'misconfigured',
    );
  }
  if (has('concurrentBroadcastsExceedLimit')) {
    return make('Your channel already has the maximum number of live broadcasts running. End one in YouTube Studio.', 'platform-error');
  }
  if (has('userBroadcastsExceedLimit')) {
    return make(
      'YouTube limits how many broadcasts a channel can create. Delete old upcoming broadcasts in YouTube Studio or try again later.',
      'not-eligible',
    );
  }
  if (has('invalidLatencyPreferenceOptions')) {
    return make('YouTube rejected the latency option for this broadcast. Pick another latency in the destination settings.', 'misconfigured');
  }
  if (has('invalidTitle')) {
    return make('YouTube rejected the stream title (it must be 1–100 characters). Change the title and retry.', 'misconfigured');
  }
  if (has(...RATE_REASONS)) return make(`YouTube is rate-limiting requests (${action}). It will be retried.`, 'platform-error');
  if (status === 401 || has('ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'insufficientPermissions', 'authError')) {
    return make('YouTube rejected the login — reconnect the account in Accounts.', 'needs-login');
  }
  const detail = message ? `: ${message}` : ` (HTTP ${status})`;
  return make(`YouTube API error while ${action}${detail}`, 'platform-error');
}

/** Network failures and timeouts become DriverErrors; aborts propagate unchanged. */
function networkError(err: unknown, action: string, signal?: AbortSignal): unknown {
  if (signal?.aborted) return err;
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError') return new DriverError(`YouTube did not respond in time (${action})`, 'timeout');
  if (err instanceof TypeError) return new DriverError(`Couldn't reach YouTube (${action}): ${err.message}`, 'platform-error');
  return err;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface AppCredentials {
  clientId: string;
  clientSecret: string;
}

export function requireApp(app: PlatformAppCredentials | null): AppCredentials {
  const clientId = app?.clientId?.trim();
  const clientSecret = app?.clientSecret?.trim();
  if (!clientId || !clientSecret) throw new DriverError(APP_MISSING, 'misconfigured');
  return { clientId, clientSecret };
}

export interface TokenSource {
  /** A valid access token (refreshed when it expires within 5 minutes). */
  token(signal?: AbortSignal): Promise<string>;
  /** Force a refresh (after a 401) and return the new access token. */
  refresh(signal?: AbortSignal): Promise<string>;
}

const forced = new WeakMap<ScopedSecrets, Promise<OAuthTokens>>();

export function createTokenSource(secrets: ScopedSecrets | null, app: AppCredentials): TokenSource {
  const doRefresh = (refreshToken: string, previous: OAuthTokens | null, signal?: AbortSignal) =>
    refreshTokens({
      tokenEndpoint: GOOGLE_TOKEN_URL,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      refreshToken,
      previous,
      signal,
    });

  return {
    async token(signal) {
      try {
        const tokens = await getValidTokens(secrets, 'YouTube', (rt, prev) => doRefresh(rt, prev, signal));
        return tokens.accessToken;
      } catch (err) {
        if (err instanceof DriverError && err.code === 'needs-login') throw new DriverError(LOGIN_EXPIRED, 'needs-login');
        throw networkError(err, 'refreshing the login', signal);
      }
    },

    async refresh(signal) {
      if (!secrets) throw new DriverError('No YouTube account linked to this destination', 'not-connected');
      const existing = forced.get(secrets);
      if (existing) return (await existing).accessToken;
      const p = (async () => {
        const tokens = await loadTokens(secrets);
        if (!tokens) throw new DriverError('YouTube account is not connected — connect it in Accounts', 'not-connected');
        if (!tokens.refreshToken) throw new DriverError(LOGIN_EXPIRED, 'needs-login');
        try {
          const fresh = await doRefresh(tokens.refreshToken, tokens, signal);
          await saveTokens(secrets, fresh);
          return fresh;
        } catch (err) {
          if (err instanceof PlatformHttpError && (err.status === 400 || err.status === 401)) {
            throw new DriverError(LOGIN_EXPIRED, 'needs-login');
          }
          throw networkError(err, 'refreshing the login', signal);
        }
      })();
      forced.set(secrets, p);
      try {
        return (await p).accessToken;
      } finally {
        forced.delete(secrets);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface CallOptions {
  /** Arrays become repeated parameters (`part=a&part=b`). Empty values are omitted. */
  query?: Record<string, string | string[] | null | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  base?: string;
}

export function buildUrl(base: string, path: string, query: CallOptions['query'] = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    for (const item of Array.isArray(v) ? v : [v]) if (item !== undefined && item !== null && item !== '') params.append(k, item);
  }
  const qs = params.toString();
  return `${base}/${path}${qs ? `?${qs}` : ''}`;
}

export class YouTubeClient {
  constructor(private readonly tokens: TokenSource) {}

  /** JSON call with one forced token refresh on 401. Throws YouTubeApiError / DriverError. */
  async call<T>(method: string, path: string, action: string, opts: CallOptions = {}): Promise<T> {
    const url = buildUrl(opts.base ?? API_BASE, path, opts.query);
    let token = await this.tokens.token(opts.signal);
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
      if (opts.body !== undefined) headers['content-type'] = 'application/json';
      try {
        return await fetchJson<T>(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: opts.signal,
          timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
      } catch (err) {
        if (err instanceof PlatformHttpError) {
          if (err.status === 401 && attempt === 0) {
            token = await this.tokens.refresh(opts.signal);
            continue;
          }
          throw apiError(err.status, err.body, action);
        }
        throw networkError(err, action, opts.signal);
      }
    }
  }

  /**
   * Open a long-lived streaming GET (no overall timeout; the caller aborts via `signal`).
   * Returns the OK response; errors are mapped like call().
   */
  async open(path: string, action: string, query: CallOptions['query'], signal: AbortSignal): Promise<Response> {
    const url = buildUrl(STREAM_API_BASE, path, query);
    let token = await this.tokens.token(signal);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal });
      } catch (err) {
        throw networkError(err, action, signal);
      }
      if (res.ok) return res;
      const body = (await res.text().catch(() => '')).slice(0, 2000);
      if (res.status === 401 && attempt === 0) {
        token = await this.tokens.refresh(signal);
        continue;
      }
      throw apiError(res.status, body, action);
    }
  }

  // ---- channels ----

  /** https://developers.google.com/youtube/v3/docs/channels/list */
  async myChannel(signal?: AbortSignal): Promise<Channel | null> {
    const res = await this.call<ListResponse<Channel>>('GET', 'channels', 'reading your channel', {
      query: { part: 'snippet', mine: 'true' },
      signal,
    });
    return res?.items?.[0] ?? null;
  }

  // ---- liveStreams: https://developers.google.com/youtube/v3/live/docs/liveStreams ----

  async getStream(id: string, signal?: AbortSignal): Promise<LiveStream | null> {
    const res = await this.call<ListResponse<LiveStream>>('GET', 'liveStreams', 'reading the stream', {
      query: { part: 'id,snippet,cdn,status', id },
      signal,
    });
    return res?.items?.find((s) => s.id === id) ?? null;
  }

  insertStream(title: string, signal?: AbortSignal): Promise<LiveStream> {
    return this.call<LiveStream>('POST', 'liveStreams', 'creating the stream', {
      query: { part: 'snippet,cdn,contentDetails,status' },
      // 'variable' must be set on both resolution and frameRate.
      body: {
        snippet: { title },
        cdn: { frameRate: 'variable', resolution: 'variable', ingestionType: 'rtmp' },
        contentDetails: { isReusable: true },
      },
      signal,
    });
  }

  // ---- liveBroadcasts: https://developers.google.com/youtube/v3/live/docs/liveBroadcasts ----

  insertBroadcast(body: unknown, signal?: AbortSignal): Promise<LiveBroadcast> {
    return this.call<LiveBroadcast>('POST', 'liveBroadcasts', 'creating the broadcast', {
      query: { part: 'snippet,status,contentDetails' },
      body,
      signal,
    });
  }

  bind(broadcastId: string, streamId: string, signal?: AbortSignal): Promise<LiveBroadcast> {
    return this.call<LiveBroadcast>('POST', 'liveBroadcasts/bind', 'binding the broadcast to the stream', {
      query: { id: broadcastId, part: 'id,contentDetails', streamId },
      signal,
    });
  }

  async getBroadcast(id: string, part: string, signal?: AbortSignal): Promise<LiveBroadcast | null> {
    const res = await this.call<ListResponse<LiveBroadcast>>('GET', 'liveBroadcasts', 'reading the broadcast', {
      query: { part, id },
      signal,
    });
    return res?.items?.find((b) => b.id === id) ?? null;
  }

  /** PUT with part=snippet: every mutable snippet field must be sent or YouTube clears it. */
  updateSnippet(id: string, snippet: BroadcastSnippet, signal?: AbortSignal): Promise<LiveBroadcast> {
    return this.call<LiveBroadcast>('PUT', 'liveBroadcasts', 'updating the title', {
      query: { part: 'snippet' },
      body: { id, snippet },
      signal,
    });
  }

  transition(id: string, broadcastStatus: 'live' | 'complete', signal?: AbortSignal): Promise<LiveBroadcast> {
    return this.call<LiveBroadcast>('POST', 'liveBroadcasts/transition', `switching the broadcast to ${broadcastStatus}`, {
      query: { broadcastStatus, id, part: 'status' },
      signal,
    });
  }

  async deleteBroadcast(id: string, signal?: AbortSignal): Promise<void> {
    await this.call<unknown>('DELETE', 'liveBroadcasts', 'deleting the unused broadcast', { query: { id }, signal });
  }

  // ---- videos: https://developers.google.com/youtube/v3/docs/videos/list (1 quota unit per call) ----

  /** Live details of a broadcast's video (the broadcast id is the video id). Null when not found. */
  async getVideoLiveDetails(videoId: string, signal?: AbortSignal): Promise<VideoLiveDetails | null> {
    const res = await this.call<ListResponse<VideoLiveDetails>>('GET', 'videos', 'reading the viewer count', {
      query: { part: 'liveStreamingDetails', id: videoId },
      signal,
    });
    return res?.items?.find((v) => v.id === videoId) ?? res?.items?.[0] ?? null;
  }

  // ---- liveChatMessages: https://developers.google.com/youtube/v3/live/docs/liveChatMessages/list ----

  listChat(liveChatId: string, pageToken: string | null, signal?: AbortSignal): Promise<LiveChatPage> {
    return this.call<LiveChatPage>('GET', 'liveChat/messages', 'reading chat', {
      query: { liveChatId, part: 'snippet,authorDetails', pageToken },
      signal,
    });
  }

  /**
   * https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList
   * REST mapping from the discovery document: GET liveChat/messages/stream, `part` is a repeated parameter.
   */
  openChatStream(liveChatId: string, pageToken: string | null, signal: AbortSignal): Promise<Response> {
    return this.open('liveChat/messages/stream', 'reading chat', { liveChatId, part: ['snippet', 'authorDetails'], pageToken }, signal);
  }
}
