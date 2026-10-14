// Typed client for the server API (see shared/api.ts for the contract).

import type {
  ApiError,
  ApiTokensResponse,
  AppSettings,
  AuditResponse,
  ChangePasswordRequest,
  ConnectCompleteRequest,
  ConnectPoll,
  ConnectStart,
  CreateAccountRequest,
  CreateApiTokenRequest,
  CreateApiTokenResponse,
  CreateDestinationRequest,
  CreateUserRequest,
  IngestInfo,
  LoginRequest,
  MeResponse,
  OverlayInfo,
  PlatformAppStatus,
  SettingsResponse,
  SetupRequest,
  SetupStatusResponse,
  TitleResponse,
  TotpSetupResponse,
  UpdateAccountRequest,
  UpdateDestinationRequest,
  UpdateUserRequest,
} from '@shared/api';
import { CSRF_HEADER } from '@shared/api';
import type {
  Account,
  ChatMessage,
  Destination,
  Feed,
  PlatformId,
  PlatformInfo,
  SessionState,
  User,
} from '@shared/types';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Called when any request returns 401 (session expired) — the app shows the login page. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

/** Title updates and connect flows touch every platform, so allow a generous timeout. */
const REQUEST_TIMEOUT_MS = 90_000;

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers[CSRF_HEADER] = csrfToken;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new ApiRequestError(0, 'The server took too long to respond', 'timeout');
    }
    throw new ApiRequestError(0, 'Could not reach the server', 'network');
  }
  if (!res.ok) {
    let err: ApiError = { error: res.statusText || `HTTP ${res.status}` };
    try {
      err = (await res.json()) as ApiError;
    } catch {
      /* non-JSON error */
    }
    if (res.status === 401 && err.code === 'unauthenticated') {
      setCsrfToken(null);
      onUnauthorized?.();
    }
    throw new ApiRequestError(res.status, err.error, err.code);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const get = <T>(url: string) => request<T>('GET', url);
const post = <T>(url: string, body: unknown = {}) => request<T>('POST', url, body);
const put = <T>(url: string, body: unknown) => request<T>('PUT', url, body);
const patch = <T>(url: string, body: unknown) => request<T>('PATCH', url, body);
const del = <T>(url: string) => request<T>('DELETE', url);

async function withCsrf(p: Promise<MeResponse>): Promise<MeResponse> {
  const me = await p;
  setCsrfToken(me.csrfToken);
  return me;
}

export const api = {
  // setup + auth
  setupStatus: () => get<SetupStatusResponse>('/api/setup/status'),
  setup: (body: SetupRequest) => withCsrf(post<MeResponse>('/api/setup', body)),
  login: (body: LoginRequest) => withCsrf(post<MeResponse>('/api/auth/login', body)),
  me: () => withCsrf(get<MeResponse>('/api/auth/me')),
  logout: async () => {
    await post<object>('/api/auth/logout');
    setCsrfToken(null);
  },
  changePassword: (body: ChangePasswordRequest) => post<object>('/api/auth/password', body),
  totpSetup: () => post<TotpSetupResponse>('/api/auth/totp/setup'),
  totpEnable: (code: string) => post<object>('/api/auth/totp/enable', { code }),
  totpDisable: (password: string) => post<object>('/api/auth/totp/disable', { password }),

  // users
  users: () => get<User[]>('/api/users'),
  createUser: (body: CreateUserRequest) => post<User>('/api/users', body),
  updateUser: (id: string, body: UpdateUserRequest) => patch<User>(`/api/users/${encodeURIComponent(id)}`, body),
  deleteUser: (id: string) => del<object>(`/api/users/${encodeURIComponent(id)}`),

  // platforms + developer apps
  platforms: () => get<PlatformInfo[]>('/api/platforms'),
  platformApps: () => get<PlatformAppStatus[]>('/api/platform-apps'),
  putPlatformApp: (platform: PlatformId, values: Record<string, string>) =>
    put<PlatformAppStatus>(`/api/platform-apps/${platform}`, { values }),

  // accounts
  accounts: () => get<Account[]>('/api/accounts'),
  createAccount: (body: CreateAccountRequest) => post<Account>('/api/accounts', body),
  updateAccount: (id: string, body: UpdateAccountRequest) => patch<Account>(`/api/accounts/${encodeURIComponent(id)}`, body),
  deleteAccount: (id: string) => del<object>(`/api/accounts/${encodeURIComponent(id)}`),
  connectAccount: (id: string) => post<ConnectStart>(`/api/accounts/${encodeURIComponent(id)}/connect`),
  pollConnect: (id: string) => post<ConnectPoll>(`/api/accounts/${encodeURIComponent(id)}/connect/poll`),
  completeConnect: (id: string, body: ConnectCompleteRequest) =>
    post<ConnectPoll>(`/api/accounts/${encodeURIComponent(id)}/connect/complete`, body),
  checkAccount: (id: string) => post<Account>(`/api/accounts/${encodeURIComponent(id)}/check`),

  // destinations
  destinations: () => get<Destination[]>('/api/destinations'),
  createDestination: (body: CreateDestinationRequest) => post<Destination>('/api/destinations', body),
  updateDestination: (id: string, body: UpdateDestinationRequest) =>
    patch<Destination>(`/api/destinations/${encodeURIComponent(id)}`, body),
  deleteDestination: (id: string) => del<object>(`/api/destinations/${encodeURIComponent(id)}`),
  setDestinationEnabled: (id: string, enabled: boolean) =>
    put<Destination>(`/api/destinations/${encodeURIComponent(id)}/enabled`, { enabled }),
  retryDestination: (id: string) => post<object>(`/api/destinations/${encodeURIComponent(id)}/retry`),

  // session
  session: () => get<SessionState>('/api/session'),
  startSession: () => post<SessionState>('/api/session/start'),
  stopSession: () => post<SessionState>('/api/session/stop'),
  setTitle: (title: string) => put<TitleResponse>('/api/session/title', { title }),
  setAutoGoLive: (autoGoLive: boolean) => put<SessionState>('/api/session/auto', { autoGoLive }),
  /** 409 code 'session_live' while a session runs (test mode only changes while offline). */
  setTestMode: (testMode: boolean) => put<SessionState>('/api/session/test-mode', { testMode }),

  // ingest
  ingest: () => get<IngestInfo>('/api/ingest'),
  rotateIngestKey: (feed: Feed) => post<IngestInfo>('/api/ingest/rotate', { feed }),

  // chat
  recentChat: (limit = 200) => get<ChatMessage[]>(`/api/chat/recent?limit=${limit}`),
  overlay: () => get<OverlayInfo>('/api/chat/overlay'),
  rotateOverlay: () => post<OverlayInfo>('/api/chat/overlay/rotate'),

  // settings + audit
  settings: () => get<SettingsResponse>('/api/settings'),
  putSettings: (body: Partial<AppSettings>) => put<SettingsResponse>('/api/settings', body),
  audit: (limit = 100, before?: number) =>
    get<AuditResponse>(`/api/audit?limit=${limit}${before !== undefined ? `&before=${before}` : ''}`),

  // external API tokens (Settings → API)
  apiTokens: () => get<ApiTokensResponse>('/api/tokens'),
  /** The response carries the secret: show it once, never store or log it. */
  createApiToken: (body: CreateApiTokenRequest) => post<CreateApiTokenResponse>('/api/tokens', body),
  deleteApiToken: (id: string) => del<object>(`/api/tokens/${encodeURIComponent(id)}`),

  // browser login viewer
  browserOpen: (accountId: string, url?: string) =>
    post<object>(`/api/browser/${encodeURIComponent(accountId)}/open`, url ? { url } : {}),
  browserClose: (accountId: string, save: boolean) =>
    post<object>(`/api/browser/${encodeURIComponent(accountId)}/close`, { save }),
};

/** Build a ws:// or wss:// URL for a same-origin path. */
export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}
