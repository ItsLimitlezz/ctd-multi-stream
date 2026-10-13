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

export type FieldType = 'text' | 'secret' | 'url' | 'select' | 'boolean' | 'number';

/**
 * Where a destination field's value is stored:
 * - 'option'    -> Destination.options[key] (non-secret, returned to the UI)
 * - 'ingestUrl' -> Destination.ingestUrl (non-secret RTMP server URL)
 * - 'streamKey' -> encrypted secret, never returned to the UI (Destination.hasStreamKey tells if set)
 */
export type FieldTarget = 'option' | 'ingestUrl' | 'streamKey';

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  target?: FieldTarget; // destination fields only; defaults to 'option'
  required?: boolean;
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
}

export type SessionStatus = 'offline' | 'starting' | 'live' | 'stopping';

export interface SessionState {
  status: SessionStatus;
  sessionId: string | null;
  startedAt: string | null;
  title: string;
  autoGoLive: boolean;
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
  author: { name: string; color?: string; badges?: string[]; avatarUrl?: string };
  text: string;
  ts: string; // ISO timestamp
  kind: 'message' | 'event';
}

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

export type TlsMode = 'auto' | 'letsencrypt' | 'self-signed' | 'manual' | 'off';

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
