// Domain types shared by the server and the web UI.
// Keep this file free of runtime dependencies (types + small constants only).

export type Feed = 'landscape' | 'vertical';
export const FEEDS: readonly Feed[] = ['landscape', 'vertical'];

export type PlatformId =
  | 'twitch'
  | 'youtube'
  | 'kick'
  | 'facebook'
  | 'x'
  | 'instagram'
  | 'tiktok'
  | 'custom';

export const PLATFORM_IDS: readonly PlatformId[] = [
  'twitch',
  'youtube',
  'kick',
  'facebook',
  'x',
  'instagram',
  'tiktok',
  'custom',
];

export type Role = 'admin' | 'operator';

// ---------------------------------------------------------------------------
// Generic form fields. Drivers describe their settings with these so the UI
// can render forms without platform-specific code.
// ---------------------------------------------------------------------------

/** 'links' = an ordered list of LinkItem ({ title, url }), stored as an array option. */
export type FieldType = 'text' | 'secret' | 'url' | 'select' | 'boolean' | 'number' | 'links';

/**
 * Where a destination field's value is stored:
 * - 'option'    -> Destination.options[key] (non-secret, returned to the UI)
 * - 'ingestUrl' -> Destination.ingestUrl (non-secret RTMP server URL)
 * - 'streamKey' -> encrypted secret, never returned to the UI (Destination.hasStreamKey tells if set)
 */
export type FieldTarget = 'option' | 'ingestUrl' | 'streamKey';

/** A link attached to a live (Instagram allows one per live). Value type of 'links' fields. */
export interface LinkItem {
  title: string;
  url: string;
}

export const LINKS_MAX = 20;
export const LINK_TITLE_MAX = 100;

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  target?: FieldTarget; // destination fields only; defaults to 'option'
  required?: boolean;
  /** For 'links' fields the default is an empty list (omit it). */
  default?: string | number | boolean;
  placeholder?: string;
  help?: string;
  options?: { value: string; label: string }[]; // for 'select'
}

export type ConnectMethod = 'device-code' | 'oauth-paste' | 'token-paste' | 'browser' | 'none';

export interface DeveloperAppSpec {
  /** Where the user registers the app (e.g. https://dev.twitch.tv/console/apps). */
  consoleUrl: string;
  /** Fields to collect, e.g. clientId / clientSecret. */
  fields: FieldSpec[];
  /** Step-by-step setup instructions (plain text, one step per line). */
  instructions: string;
}

export interface PlatformInfo {
  id: PlatformId;
  name: string;
  /** Feeds this platform can accept. */
  feeds: Feed[];
  defaultFeed: Feed;
  /** How an account is connected. 'none' = no account needed (e.g. custom RTMP). */
  connectMethod: ConnectMethod;
  /** Options asked when creating an account (e.g. Facebook "page" vs "profile"). */
  accountFields: FieldSpec[];
  /** Fields shown when creating/editing a destination of this platform. */
  destinationFields: FieldSpec[];
  /** Developer app registration needed (Twitch, YouTube, Kick, Facebook Page). */
  developerApp: DeveloperAppSpec | null;
  titleSupport: 'api' | 'browser' | 'none';
  chatSupport: 'api' | 'browser' | 'unofficial' | 'none';
  /** True when the platform issues a new stream key for every stream (Instagram, TikTok). */
  keyPerSession: boolean;
  experimental: boolean;
  notes?: string;
  /**
   * What session test mode does on this platform. Unsupported (or omitted) = the destination is
   * skipped while test mode is on, so nothing goes out publicly.
   */
  testMode?: { supported: boolean; description: string };
}

// ---------------------------------------------------------------------------
// Accounts and destinations
// ---------------------------------------------------------------------------

export type AccountStatus = 'pending' | 'connected' | 'needs-login' | 'error';

/** A connected platform account (OAuth tokens / browser session live in encrypted storage). */
export interface Account {
  id: string;
  platform: PlatformId;
  label: string;
  status: AccountStatus;
  statusMessage: string | null;
  /** Non-secret options (e.g. { mode: 'page' } for Facebook). */
  options: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** One output: a platform account + which feed goes there. */
export interface Destination {
  id: string;
  platform: PlatformId;
  accountId: string | null;
  name: string;
  feed: Feed;
  enabled: boolean;
  /** Non-secret, platform-specific options (see PlatformInfo.destinationFields). */
  options: Record<string, unknown>;
  /** Manually entered RTMP(S) server URL, for paste-a-key platforms. */
  ingestUrl: string | null;
  /** Whether a stream key is stored. The key itself is never sent to the UI. */
  hasStreamKey: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Live session state
// ---------------------------------------------------------------------------

export interface FeedState {
  feed: Feed;
  online: boolean;
  since: string | null;
  video: { codec: string; width?: number; height?: number; fps?: number } | null;
  audio: { codec: string; sampleRate?: number; channels?: number } | null;
  bitrateKbps: number | null;
}

export type DestinationPhase =
  | 'idle' // session not running
  | 'disabled' // destination disabled
  | 'waiting-for-feed' // session running, required feed(s) offline
  | 'preparing' // driver.prepare() running (title, key, create live)
  | 'connecting' // ffmpeg started, waiting for data to flow
  | 'confirming' // driver confirm() running (e.g. clicking "Go Live")
  | 'live'
  | 'retrying'
  | 'recovering' // the platform killed the live (e.g. copyright takedown); building a fresh one
  | 'ending'
  | 'error';

export interface PushStats {
  bitrateKbps: number;
  fps: number;
  speed: number;
  uptimeSec: number;
}

export interface DestinationState {
  destinationId: string;
  phase: DestinationPhase;
  message: string | null;
  stats: PushStats | null;
  watchUrl: string | null;
  retries: number;
  since: string;
  /** Automatic takedown recoveries this session (fresh live created after the platform killed one). */
  recoveries: number;
  /** Most recent takedown that triggered a recovery, this session. */
  lastRecovery: { at: string; reason: string } | null;
  /** Current viewers on the platform, when the driver can read them (null = unknown). */
  viewers?: number | null;
}

export type SessionStatus = 'offline' | 'starting' | 'live' | 'stopping';

export interface SessionState {
  status: SessionStatus;
  sessionId: string | null;
  startedAt: string | null;
  title: string;
  autoGoLive: boolean;
  /**
   * Test mode: every destination uses its platform's private/test setting (Twitch bandwidth test,
   * YouTube private, Instagram Practice, Facebook only-me); platforms without one are skipped.
   * Settings key 'session.testMode'. Can only change while offline.
   */
  testMode?: boolean;
  feeds: FeedState[];
  destinations: DestinationState[];
}

export interface TitleResult {
  destinationId: string;
  ok: boolean;
  skipped?: boolean;
  /** Failure reason, or for skipped results the reason it was skipped. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface ChatMessage {
  id: string;
  platform: PlatformId;
  destinationId: string;
  author: {
    name: string;
    color?: string;
    badges?: string[];
    avatarUrl?: string;
    /** Platform user id (unprefixed), when the platform exposes one. */
    id?: string;
    /** Login/handle, when different from the display name. */
    login?: string;
  };
  text: string;
  ts: string; // ISO timestamp
  kind: 'message' | 'event';
  /** The platform's own message id (needed to apply deletions). */
  platformMessageId?: string;
  /** Text split into parts (emotes, mentions, links). Joining every part's text equals `text`. */
  fragments?: ChatFragment[];
  /** /me message. */
  action?: boolean;
  /** Highlighted / paid / pinned message. */
  highlighted?: boolean;
  reply?: { messageId?: string; userName?: string; text?: string } | null;
  /**
   * Structured alert carried by a `kind: 'event'` line (sub, gift, cheer, raid, membership, Super Chat…).
   * Matches CTD Overlay's alert payload; the external API also emits it as `alert.<kind>`.
   */
  alert?: ChatAlert;
}

export type ChatAlertKind = 'follow' | 'subscription' | 'gift' | 'cheer' | 'kicks' | 'raid' | 'membership' | 'superchat' | 'tip';

export interface ChatAlert {
  kind: ChatAlertKind;
  user: { id?: string; name: string; avatar?: string; anonymous?: boolean };
  /** Counts as integers; money as an ISO 4217 currency + decimal string value ("5.00"), never a float. */
  amount?:
    | { unit: 'months' | 'count' | 'bits' | 'kicks' | 'viewers'; value: number }
    | { unit: 'currency'; value: string; currency: string };
  tier?: string;
  message?: { text: string };
  gift?: { recipients?: string[]; total?: number } | null;
}

export interface ChatFragment {
  type: 'text' | 'emote' | 'mention' | 'link' | 'cheermote';
  text: string;
  image?: string;
  animated?: boolean;
  url?: string;
  userId?: string;
  amount?: number;
}

/** Moderation that removes chat (so overlays can remove it too). */
export type ChatModeration =
  | { kind: 'message-deleted'; platform: PlatformId; destinationId: string; ts: string; messageId: string | null; platformMessageId: string }
  | { kind: 'user-cleared'; platform: PlatformId; destinationId: string; ts: string; userId: string | null; userName: string | null }
  | { kind: 'cleared'; platform: PlatformId; destinationId: string; ts: string };

// ---------------------------------------------------------------------------
// Users, audit, TLS
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  username: string;
  role: Role;
  totpEnabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuditEntry {
  id: number;
  ts: string;
  userId: string | null;
  username: string | null;
  action: string;
  detail: string | null;
  ip: string | null;
}

// ---------------------------------------------------------------------------
// External API tokens (other apps, e.g. CTD Overlay, reading chat/status)
// ---------------------------------------------------------------------------

/** chat:read = chat history + live chat events; status:read = stream/destination status. */
export type ApiScope = 'chat:read' | 'status:read';
export const API_SCOPES: readonly ApiScope[] = ['chat:read', 'status:read'];

export interface ApiTokenInfo {
  id: string;
  name: string;
  scopes: ApiScope[];
  /** First characters of the secret, to recognise it (e.g. "ctd_pat_3fK9"). */
  prefix: string;
  createdAt: string;
  createdBy: string | null;
  lastUsedAt: string | null;
}

export type TlsMode ='auto' | 'letsencrypt' | 'self-signed' | 'manual' | 'off';

export interface TlsStatus {
  mode: TlsMode;
  /** What is actually being served right now. */
  source: 'letsencrypt-ip' | 'letsencrypt-domain' | 'self-signed' | 'manual' | 'none';
  subject: string | null; // IP or hostname on the cert
  notAfter: string | null;
  fingerprint256: string | null;
  publicIp: string | null;
  lastError: string | null;
  nextRenewalAt: string | null;
}
