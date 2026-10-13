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
}

/**
 * How the FFmpeg supervisor should send video to the platform.
 * - 'copy': exactly one feed, passthrough (`-c copy`).
 * - 'multitrack': EXPERIMENTAL Enhanced-RTMP multitrack with several feeds in one connection
 *   (Twitch Dual Format). feeds[0] is the primary (landscape) track.
 */
export interface PushPlan {
  /** Full RTMP(S) URL including the stream key. Never log it. */
  url: string;
  mode: 'copy' | 'multitrack';
  feeds: Feed[];
  /** Extra FFmpeg output args (rarely needed). */
  extraOutputArgs?: string[];
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
  chat?(signal: AbortSignal): AsyncIterable<ChatMessageInput>;
}

export interface PlatformDriver {
  readonly info: PlatformInfo;

  /** Feeds that must be online before prepare() is called. Default: [dest.feed]. */
  requiredFeeds?(dest: Destination): Feed[];

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
