import type { Logger } from 'pino';
import type { ConnectPoll, ConnectStart } from '../../../shared/api.js';
import type {
  Account,
  AccountStatus,
  ChatMessage,
  Destination,
  Feed,
  PlatformInfo,
} from '../../../shared/types.js';
import type { BrowserManager, ScopedSecrets } from '../services.js';

/** Chat message as produced by a driver; the ChatHub fills in id/platform/destinationId. */
export type ChatMessageInput = Omit<ChatMessage, 'id' | 'platform' | 'destinationId' | 'kind' | 'ts'> & {
  id?: string;
  kind?: ChatMessage['kind'];
  /** ISO timestamp; defaults to now. */
  ts?: string;
};

/**
 * Chat moderation as produced by a driver (a chat source may yield these between messages).
 * The ChatHub removes the affected messages and emits 'chat-moderation'.
 */
export type ChatModerationInput =
  | { kind: 'message-deleted'; platformMessageId: string }
  | { kind: 'user-cleared'; userId?: string; userName?: string }
  | { kind: 'cleared' };

/** What a chat source yields. Tell them apart with `isChatModeration`. */
export type ChatSourceItem = ChatMessageInput | ChatModerationInput;

export function isChatModeration(item: ChatSourceItem): item is ChatModerationInput {
  return item.kind === 'message-deleted' || item.kind === 'user-cleared' || item.kind === 'cleared';
}

/** Developer-app credentials the user entered for this platform (see PlatformInfo.developerApp). */
export type PlatformAppCredentials = Record<string, string>;

/**
 * Everything a driver may touch. Built per call by the composition root for one
 * (platform, account?, destination?) combination.
 */
export interface DriverContext {
  log: Logger;
  /** Encrypted storage scoped to the account (OAuth tokens, device-code state...). Null if no account. */
  accountSecrets: ScopedSecrets | null;
  /** Encrypted storage scoped to the destination (manual stream key lives at key 'streamKey'). */
  destinationSecrets: ScopedSecrets | null;
  /** Developer-app credentials for this platform, or null when not configured. */
  app: PlatformAppCredentials | null;
  /** Playwright contexts (browser-driven platforms). */
  browser: BrowserManager;
  /** e.g. https://203.0.113.7 — used to build redirect URIs. */
  publicBaseUrl: string;
  /** Persist account changes (label, status, options) and notify the UI. No-op without an account. */
  updateAccount(
    patch: Partial<{ label: string; status: AccountStatus; statusMessage: string | null; options: Record<string, unknown> }>,
  ): Promise<void>;
  /** Aborted when the session/destination is stopped. Drivers should pass it to fetch/waits. */
  signal: AbortSignal;
  /**
   * Session test mode is on: prepare() must use the platform's private/test setting
   * (PlatformInfo.testMode). Drivers without a test mode are never prepared while it's on.
   */
  testMode?: boolean;
}

/**
 * How the FFmpeg supervisor should send video to the platform.
 * - 'copy': exactly one feed, passthrough (`-c copy`).
 * - 'multitrack': EXPERIMENTAL Enhanced-RTMP multitrack with several feeds in one connection
 *   (Twitch Dual Format). feeds[0] is the primary (landscape) track.
 * - 'ivs': Amazon IVS multitrack (Twitch Dual Format through Relay): FFmpeg encodes `ivs.tracks`
 *   from the feeds with aligned IDRs, Relay adds the broadcast performance metrics and publishes the
 *   Enhanced RTMP stream itself (media/ivs-forwarder.ts).
 */
export interface PushPlan {
  /** Full RTMP(S) URL including the stream key. Never log it. */
  url: string;
  mode: 'copy' | 'multitrack' | 'ivs';
  feeds: Feed[];
  /** Extra FFmpeg output args (rarely needed). */
  extraOutputArgs?: string[];
  /** 'ivs' only: what to encode. */
  ivs?: IvsEncodePlan;
}

/** One video track Amazon IVS asked for (GetClientConfiguration encoder_configurations[i] = track i). */
export interface IvsTrack {
  feed: Feed;
  width: number;
  height: number;
  fps: { numerator: number; denominator: number };
  bitrateKbps: number;
  keyintSec: number;
  profile: 'baseline' | 'main' | 'high';
  bframes: number;
}

export interface IvsEncodePlan {
  /** Track 0 first (the primary, highest quality track). */
  tracks: IvsTrack[];
  audioBitrateKbps: number;
  audioChannels: number;
  /** x264 preset: faster presets use less CPU at slightly lower quality. */
  preset: string;
}

/** Result of preparing a destination for one session. */
export interface PreparedLive {
  /** Null = the platform receives video some other way (e.g. Twitch "OBS direct" Dual Format). */
  push: PushPlan | null;
  /** Public watch URL, when known. */
  watchUrl?: string | null;
  /**
   * Called once FFmpeg is pushing and data is flowing. Browser platforms click
   * "Go Live" here (waiting for the preview first). Throwing marks the destination as error.
   */
  confirm?(signal: AbortSignal): Promise<void>;
  /** Change the title while live. `signal` aborts when the orchestrator's time budget runs out. */
  setTitle?(title: string, signal?: AbortSignal): Promise<void>;
  /** End the live on the platform (after FFmpeg stops). Must not throw for "already ended". */
  end?(signal?: AbortSignal): Promise<void>;
  /**
   * Chat stream for this live. Should yield until `signal` aborts. If it throws or ends early,
   * the ChatHub restarts it with backoff while the destination is live.
   */
  chat?(signal: AbortSignal): AsyncIterable<ChatSourceItem>;
  /**
   * Live health watcher, started by the runner once the destination is live (and stopped with
   * `signal`). Yield `ended` when the platform killed the live (copyright takedown, "live ended"
   * banner, 0 viewers for too long...). The runner then recovers with a fresh prepare() when
   * `recovery` is set. Drivers apply their own start-up grace for slow signals (e.g. viewer counts).
   */
  health?(signal: AbortSignal): AsyncIterable<LiveHealthEvent>;
  /**
   * Enables automatic takedown recovery for this live (platforms that issue a new key per live,
   * like Instagram). Besides `health`, the runner treats "push to the platform is down for
   * `pushDownConfirmMs` while the OBS feed is still online" as a takedown.
   */
  recovery?: LiveRecoveryPolicy;
}

export type LiveHealthEvent =
  /** The platform ended the live; recover with a new one (when recovery is enabled). */
  | { type: 'ended'; reason: string }
  /** Something looks wrong but needs no action; shown on the destination card. */
  | { type: 'warning'; message: string }
  /** A previous warning cleared. */
  | { type: 'ok' }
  /** Current viewer count (null = unknown/hidden). Poll politely (≥ 30 s for API platforms; YouTube ≥ 60 s). */
  | { type: 'viewers'; count: number | null };

export interface LiveRecoveryPolicy {
  /** Push down (feed still up) this long ⇒ takedown. Stream Guard default: 5 s. */
  pushDownConfirmMs: number;
  /** Back-to-back failed recoveries before giving up and asking for a human. Default 3. */
  maxAttempts: number;
}

export interface PlatformDriver {
  readonly info: PlatformInfo;

  /** Feeds that must be online before prepare() is called. Default: [dest.feed]. */
  requiredFeeds?(dest: Destination): Feed[];

  /**
   * Whether this destination can stream privately while session test mode is on. Default:
   * `info.testMode?.supported === true`. (Facebook: Pages yes, profile mode no.) Unsupported
   * destinations are skipped in test mode.
   */
  supportsTestMode?(dest: Destination, account: Account | null): boolean;

  // ---- account connection (omit for connectMethod 'none') ----
  startConnect?(account: Account, ctx: DriverContext): Promise<ConnectStart>;
  /** device-code: poll once (the UI calls repeatedly). Must persist tokens on success. */
  pollConnect?(account: Account, ctx: DriverContext): Promise<ConnectPoll>;
  /** oauth-paste / token-paste / browser ("I'm logged in"). Must persist tokens/session on success. */
  completeConnect?(
    account: Account,
    input: { pastedUrl?: string; fields?: Record<string, string> },
    ctx: DriverContext,
  ): Promise<ConnectPoll>;
  /** Re-validate stored credentials (refresh tokens, check browser session). */
  checkAccount?(account: Account, ctx: DriverContext): Promise<{ status: AccountStatus; label?: string; message?: string }>;

  // ---- destination ----
  /** Return human-readable problems with the destination config ([] = OK). */
  validateDestination?(dest: Destination, account: Account | null, ctx: DriverContext): Promise<string[]>;
  /** Update the channel title while NOT live (e.g. Twitch/Kick channel title). Optional. */
  setTitleOffline?(dest: Destination, account: Account | null, title: string, ctx: DriverContext): Promise<void>;
  /** Prepare one live: set title, obtain ingest URL + key, create the live if the platform needs it. */
  prepare(dest: Destination, account: Account | null, title: string, ctx: DriverContext): Promise<PreparedLive>;
}

/** Thrown by drivers for problems the user must fix (shown verbatim in the UI). */
export class DriverError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not-connected'
      | 'needs-login'
      | 'misconfigured'
      | 'not-eligible'
      | 'platform-error'
      | 'timeout' = 'platform-error',
  ) {
    super(message);
    this.name = 'DriverError';
  }
}
