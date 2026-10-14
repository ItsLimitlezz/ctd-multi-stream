// Service interfaces. Each implementation lives in its own module (see docs/CONTRACTS.md);
// the composition root (main.ts) wires them together into AppServices.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from 'pino';
import type { BrowserContext, Page } from 'playwright';
import type { AppSettings } from '../../shared/api.js';
import type {
  Account,
  AccountStatus,
  ApiScope,
  ApiTokenInfo,
  AuditEntry,
  ChatMessage,
  Destination,
  Feed,
  FeedState,
  PlatformId,
  Role,
  SessionState,
  TitleResult,
  TlsMode,
  TlsStatus,
  User,
} from '../../shared/types.js';
import type { AppConfig } from './config.js';
import type { EventBus } from './events.js';
import type { ChatSourceItem, DriverContext, PlatformDriver, PushPlan } from './platforms/types.js';

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/** Authenticated encryption for secrets at rest (AES-256-GCM). */
export interface SecretBox {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

/** Encrypted key/value storage bound to one scope (e.g. 'account:<id>'). */
export interface ScopedSecrets {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** JSON helpers. */
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown): Promise<void>;
}

// ---------------------------------------------------------------------------
// Repositories (SQLite)
// ---------------------------------------------------------------------------

export interface UserRecord extends User {
  passwordHash: string;
  totpSecret: string | null; // encrypted with SecretBox
  totpPendingSecret: string | null; // encrypted; set by totp/setup until enabled
  failedLogins: number;
  lockedUntil: string | null;
}

export interface UsersRepo {
  count(): number;
  list(): User[];
  get(id: string): UserRecord | null;
  getByUsername(username: string): UserRecord | null;
  create(input: { username: string; passwordHash: string; role: Role }): User;
  update(
    id: string,
    patch: Partial<
      Pick<UserRecord, 'role' | 'passwordHash' | 'totpSecret' | 'totpPendingSecret' | 'totpEnabled' | 'failedLogins' | 'lockedUntil' | 'lastLoginAt'>
    >,
  ): User;
  delete(id: string): void;
}

export interface AuthSessionRecord {
  id: string; // random 32-byte token (stored hashed in DB; this is the hash)
  userId: string;
  csrfToken: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
}

export interface AuthSessionsRepo {
  /** Creates a session; returns the record plus the raw token for the cookie. */
  create(userId: string, meta: { ip: string | null; userAgent: string | null }): { record: AuthSessionRecord; token: string };
  /** Look up by raw cookie token; returns null if missing/expired. Slides lastSeenAt/expiry. */
  touch(token: string): AuthSessionRecord | null;
  /**
   * Like touch() but read-only: null if missing/expired, never slides the expiry. Used to
   * re-validate long-lived connections (WebSockets). Optional until the DB module implements it.
   */
  peek?(token: string): AuthSessionRecord | null;
  delete(token: string): void;
  deleteForUser(userId: string, exceptToken?: string): void;
  purgeExpired(): void;
}

export interface AccountsRepo {
  list(): Account[];
  get(id: string): Account | null;
  create(input: { platform: PlatformId; label: string; options: Record<string, unknown> }): Account;
  update(
    id: string,
    patch: Partial<{ label: string; status: AccountStatus; statusMessage: string | null; options: Record<string, unknown> }>,
  ): Account;
  delete(id: string): void;
}

export interface DestinationsRepo {
  list(): Destination[];
  get(id: string): Destination | null;
  create(input: {
    platform: PlatformId;
    accountId: string | null;
    name: string;
    feed: Feed;
    enabled: boolean;
    options: Record<string, unknown>;
    ingestUrl: string | null;
  }): Destination;
  update(
    id: string,
    patch: Partial<{
      accountId: string | null;
      name: string;
      feed: Feed;
      enabled: boolean;
      options: Record<string, unknown>;
      ingestUrl: string | null;
      hasStreamKey: boolean;
    }>,
  ): Destination;
  delete(id: string): void;
  /** Set accountId = null for all destinations using this account. */
  detachAccount(accountId: string): void;
}

/** JSON key/value settings. */
export interface SettingsRepo {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

/** Encrypted secrets table; scope examples: 'account:<id>', 'destination:<id>', 'app:<platform>', 'ingest', 'chat'. */
export interface SecretsRepo {
  scoped(scope: string): ScopedSecrets;
  deleteScope(scope: string): void;
}

export interface AuditRepo {
  log(entry: { userId: string | null; username: string | null; action: string; detail?: string | null; ip?: string | null }): void;
  list(opts: { limit: number; before?: number }): AuditEntry[];
}

/** Personal access tokens for the external API (/api/v1). Secrets are stored hashed (SHA-256). */
export interface ApiTokensRepo {
  list(): ApiTokenInfo[];
  /** Creates a token; the secret (`ctd_pat_…`) is returned once and never stored in plain text. */
  create(input: { name: string; scopes: ApiScope[]; createdBy: string | null }): { token: ApiTokenInfo; secret: string };
  /** Look up a presented secret; null if unknown. Updates lastUsedAt (at most once a minute). */
  verify(secret: string): ApiTokenInfo | null;
  delete(id: string): void;
}

export interface Repos {
  users: UsersRepo;
  authSessions: AuthSessionsRepo;
  accounts: AccountsRepo;
  destinations: DestinationsRepo;
  settings: SettingsRepo;
  secrets: SecretsRepo;
  audit: AuditRepo;
  apiTokens: ApiTokensRepo;
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export interface MediaMtxAuthRequest {
  user: string;
  password: string;
  ip: string;
  action: 'publish' | 'read' | 'playback' | 'api' | 'metrics' | 'pprof';
  path: string;
  protocol: string;
  id: string | null;
  query: string;
  token?: string;
  userAgent?: string;
}

/** MediaMTX wrapper: ingest of the two OBS feeds. */
export interface MediaServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  feeds(): FeedState[];
  feed(feed: Feed): FeedState;
  /** Local URL FFmpeg uses to read a feed (includes internal read credentials). */
  readUrl(feed: Feed): string;
  /** Decide a MediaMTX HTTP auth request (called by the internal auth route). */
  authorize(req: MediaMtxAuthRequest): boolean;
  /** Stream keys for OBS (generated on first run, stored encrypted). */
  ingestKeys(): Promise<Record<Feed, string>>;
  rotateIngestKey(feed: Feed): Promise<string>;
  /** Path under the RTMP server, e.g. 'live'. OBS server URL = rtmp://<host>:<port>/<appName>. */
  readonly appName: string;
}

/** Supervises one FFmpeg process per destination. Emits 'push' events on the EventBus. */
export interface PushSupervisor {
  /** Start (or restart) pushing for `id`. Retries automatically with backoff until stop(id). */
  start(id: string, plan: PushPlan): void;
  stop(id: string): Promise<void>;
  stopAll(): Promise<void>;
  isRunning(id: string): boolean;
}

// ---------------------------------------------------------------------------
// Browser automation
// ---------------------------------------------------------------------------

export interface BrowserManager {
  /** Get (or launch) the account's context, restoring its encrypted storage state. */
  context(accountId: string): Promise<BrowserContext>;
  /** A page for the account; reuses the viewer page if one is open. */
  page(accountId: string, url?: string): Promise<Page>;
  /** Page used by the login viewer (created on demand, navigated to url if given). */
  viewerPage(accountId: string, url?: string): Promise<Page>;
  /**
   * Why the login viewer must not open `url` (a loopback/LAN/link-local... host), or null when it
   * may. Optional so test fakes can omit it (no check).
   */
  checkViewerUrl?(url: URL): Promise<string | null>;
  /** Persist storage state (cookies, localStorage, IndexedDB) encrypted. */
  save(accountId: string): Promise<void>;
  hasSavedSession(accountId: string): Promise<boolean>;
  /** Close the account's context. Saves first only when `save: true` (default false). */
  close(accountId: string, opts?: { save?: boolean }): Promise<void>;
  /** Delete the saved session. */
  clear(accountId: string): Promise<void>;
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface ChatHub {
  /**
   * Run `source` for a destination until `signal` aborts. Restarts it with backoff when it
   * throws or ends. Messages are normalized, deduplicated, stored in a ring buffer and
   * emitted as 'chat' events.
   */
  attach(
    destinationId: string,
    platform: PlatformId,
    source: (signal: AbortSignal) => AsyncIterable<ChatSourceItem>,
    signal: AbortSignal,
  ): void;
  recent(limit?: number): ChatMessage[];
  /** Token for the OBS chat overlay URL (created on first call). */
  overlayToken(): Promise<string>;
  rotateOverlayToken(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface Orchestrator {
  /** Subscribe to feed events, restore title/auto setting. */
  init(): Promise<void>;
  state(): SessionState;
  start(trigger: 'auto' | 'manual'): Promise<void>;
  stop(reason?: string): Promise<void>;
  setTitle(title: string): Promise<TitleResult[]>;
  setAutoGoLive(value: boolean): void;
  /**
   * Session test mode (persisted as 'session.testMode'). Only while no session runs: otherwise
   * throws an error with statusCode 409 and code 'session_live'.
   */
  setTestMode(value: boolean): void;
  /** Destination enabled/disabled or edited mid-session. */
  destinationChanged(id: string): Promise<void>;
  destinationRemoved(id: string): Promise<void>;
  retryDestination(id: string): Promise<void>;
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------

export interface TlsMaterial {
  key: string; // PEM
  cert: string; // PEM (full chain)
}

export interface TlsManager {
  readonly mode: TlsMode;
  /** Load or create the initial certificate. Null when mode is 'off'. */
  init(): Promise<TlsMaterial | null>;
  /**
   * Start the plain-HTTP listener (ACME HTTP-01 + redirect to HTTPS) and the
   * issuance/renewal loop. onRenew is called with new material to hot-swap.
   */
  start(onRenew: (m: TlsMaterial) => void): Promise<void>;
  status(): TlsStatus;
  stop(): Promise<void>;
  /**
   * Plain-HTTP handoff for LAN clients: the HTTP listener passes requests from private/loopback/
   * CGNAT/ULA/link-local addresses for /api/v1, /dock and /overlay/* (and /overlay/ws upgrades) to
   * `handler` instead of redirecting them to HTTPS. Null removes it. Optional (no-op when TLS is off).
   */
  setLanHandler?(handler: LanHandler | null): void;
}

/** Where the TLS module's HTTP listener hands LAN requests (the Fastify app). */
export interface LanHandler {
  request(req: IncomingMessage, res: ServerResponse): void;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

// ---------------------------------------------------------------------------
// Platform registry + composition
// ---------------------------------------------------------------------------

export interface PlatformRegistry {
  get(id: PlatformId): PlatformDriver;
  all(): PlatformDriver[];
}

export interface AppServices {
  config: AppConfig;
  log: Logger;
  bus: EventBus;
  repos: Repos;
  secretBox: SecretBox;
  media: MediaServer;
  pushes: PushSupervisor;
  browser: BrowserManager;
  chat: ChatHub;
  platforms: PlatformRegistry;
  orchestrator: Orchestrator;
  tls: TlsManager;
  /** Build a DriverContext for a platform call. */
  driverContext(opts: {
    platform: PlatformId;
    accountId?: string | null;
    destinationId?: string | null;
    signal?: AbortSignal;
  }): Promise<DriverContext>;
  /** Current settings with defaults applied. */
  appSettings(): AppSettings;
  /** Public base URL (settings override, else derived from TLS public IP/host + PUBLIC_PORT). */
  publicBaseUrl(): string;
}
