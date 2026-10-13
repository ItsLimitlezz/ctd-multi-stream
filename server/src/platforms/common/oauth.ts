// OAuth 2.0 helpers shared by API drivers: device authorization grant (RFC 8628),
// authorization code + PKCE (RFC 7636), refresh, and encrypted token storage.

import crypto from 'node:crypto';
import type { ScopedSecrets } from '../../services.js';
import { DriverError } from '../types.js';
import { PlatformHttpError, postForm } from './http.js';

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds, or null when the provider didn't say. */
  expiresAt: number | null;
  scope: string | null;
  tokenType: string | null;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  scope?: string | string[];
  token_type?: string;
}

export function parseTokenResponse(json: RawTokenResponse, previous?: OAuthTokens | null): OAuthTokens {
  if (!json.access_token) throw new Error('Token response had no access_token');
  const expiresIn = json.expires_in !== undefined ? Number(json.expires_in) : NaN;
  return {
    accessToken: json.access_token,
    // Providers may omit the refresh token on refresh; keep the old one then.
    refreshToken: json.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
    scope: Array.isArray(json.scope) ? json.scope.join(' ') : (json.scope ?? null),
    tokenType: json.token_type ?? null,
  };
}

// ---------------------------------------------------------------------------
// Device authorization grant (Twitch, Google)
// ---------------------------------------------------------------------------

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceFlowOptions {
  endpoint: string;
  clientId: string;
  scopes: string[];
  /** Form field name for scopes: 'scope' (RFC 8628, Google) or 'scopes' (Twitch). */
  scopeParam?: 'scope' | 'scopes';
  extraParams?: Record<string, string>;
  signal?: AbortSignal;
}

export async function startDeviceFlow(opts: DeviceFlowOptions): Promise<DeviceStart> {
  const json = await postForm<{
    device_code: string;
    user_code: string;
    verification_uri?: string;
    verification_url?: string; // Google uses verification_url
    verification_uri_complete?: string;
    expires_in: number;
    interval?: number;
  }>(
    opts.endpoint,
    { client_id: opts.clientId, [opts.scopeParam ?? 'scope']: opts.scopes.join(' '), ...(opts.extraParams ?? {}) },
    { signal: opts.signal },
  );
  const verificationUri = json.verification_uri ?? json.verification_url;
  if (!json.device_code || !json.user_code || !verificationUri) throw new Error('Unexpected device authorization response');
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri,
    verificationUriComplete: json.verification_uri_complete,
    expiresIn: json.expires_in,
    interval: json.interval ?? 5,
  };
}

export type DevicePollResult =
  | { status: 'ok'; tokens: OAuthTokens }
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'expired' }
  | { status: 'denied' };

export async function pollDeviceToken(opts: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string | null;
  deviceCode: string;
  extraParams?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<DevicePollResult> {
  const form: Record<string, string> = {
    client_id: opts.clientId,
    device_code: opts.deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    ...(opts.extraParams ?? {}),
  };
  if (opts.clientSecret) form.client_secret = opts.clientSecret;
  try {
    const json = await postForm<RawTokenResponse>(opts.tokenEndpoint, form, { signal: opts.signal });
    return { status: 'ok', tokens: parseTokenResponse(json) };
  } catch (err) {
    if (err instanceof PlatformHttpError) {
      const code = oauthErrorCode(err.body);
      if (code === 'authorization_pending') return { status: 'pending' };
      if (code === 'slow_down') return { status: 'slow_down' };
      if (code === 'expired_token' || code === 'invalid_device_code') return { status: 'expired' };
      if (code === 'access_denied') return { status: 'denied' };
    }
    throw err;
  }
}

/** Read the OAuth `error` code (or Twitch's `message`) from an error body. */
export function oauthErrorCode(body: string): string | null {
  try {
    const j = JSON.parse(body) as { error?: unknown; message?: unknown };
    const v = typeof j.error === 'string' ? j.error : typeof j.message === 'string' ? j.message : null;
    return v ? v.toLowerCase().replace(/\s+/g, '_') : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Authorization code + PKCE (Kick, Facebook)
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function createPkce(): { verifier: string; challenge: string; method: 'S256' } {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

/** OAuth `state` that also identifies the account (`<accountId>.<random>`); see GET /oauth/callback/:platform. */
export function makeState(accountId: string): string {
  return `${accountId}.${base64url(crypto.randomBytes(16))}`;
}

/** Parse a pasted redirect URL (or just its query string). */
export function parseCallbackUrl(pasted: string): {
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
} {
  const trimmed = pasted.trim();
  let params: URLSearchParams;
  try {
    params = new URL(trimmed).searchParams;
  } catch {
    params = new URLSearchParams(trimmed.replace(/^[^?]*\?/, ''));
  }
  return {
    code: params.get('code'),
    state: params.get('state'),
    error: params.get('error'),
    errorDescription: params.get('error_description'),
  };
}

export async function exchangeCode(opts: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string | null;
  code: string;
  redirectUri: string;
  codeVerifier?: string | null;
  signal?: AbortSignal;
}): Promise<OAuthTokens> {
  const form: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: opts.clientId,
    code: opts.code,
    redirect_uri: opts.redirectUri,
  };
  if (opts.clientSecret) form.client_secret = opts.clientSecret;
  if (opts.codeVerifier) form.code_verifier = opts.codeVerifier;
  const json = await postForm<RawTokenResponse>(opts.tokenEndpoint, form, { signal: opts.signal });
  return parseTokenResponse(json);
}

export async function refreshTokens(opts: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string | null;
  refreshToken: string;
  previous?: OAuthTokens | null;
  signal?: AbortSignal;
}): Promise<OAuthTokens> {
  const form: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: opts.clientId,
    refresh_token: opts.refreshToken,
  };
  if (opts.clientSecret) form.client_secret = opts.clientSecret;
  const json = await postForm<RawTokenResponse>(opts.tokenEndpoint, form, { signal: opts.signal });
  return parseTokenResponse(json, opts.previous);
}

// ---------------------------------------------------------------------------
// Encrypted token storage with automatic refresh
// ---------------------------------------------------------------------------

const TOKEN_KEY = 'oauth';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** In-flight refreshes per secrets object, so concurrent callers share one refresh. */
const inflight = new WeakMap<ScopedSecrets, Promise<OAuthTokens>>();

export async function saveTokens(secrets: ScopedSecrets, tokens: OAuthTokens): Promise<void> {
  await secrets.setJson(TOKEN_KEY, tokens);
}

export async function loadTokens(secrets: ScopedSecrets): Promise<OAuthTokens | null> {
  return secrets.getJson<OAuthTokens>(TOKEN_KEY);
}

/**
 * Return a valid access token, refreshing it when it expires within 5 minutes.
 * Throws DriverError('needs-login'/'not-connected') when the user must reconnect.
 */
export async function getValidTokens(
  secrets: ScopedSecrets | null,
  platformName: string,
  refresh: (refreshToken: string, previous: OAuthTokens) => Promise<OAuthTokens>,
): Promise<OAuthTokens> {
  if (!secrets) throw new DriverError(`No ${platformName} account linked to this destination`, 'not-connected');
  const tokens = await loadTokens(secrets);
  if (!tokens) throw new DriverError(`${platformName} account is not connected — connect it in Accounts`, 'not-connected');
  if (tokens.expiresAt === null || tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS) return tokens;
  if (!tokens.refreshToken) {
    throw new DriverError(`${platformName} login expired — reconnect the account in Accounts`, 'needs-login');
  }
  const existing = inflight.get(secrets);
  if (existing) return existing;
  const p = (async () => {
    try {
      const fresh = await refresh(tokens.refreshToken!, tokens);
      await saveTokens(secrets, fresh);
      return fresh;
    } catch (err) {
      if (err instanceof PlatformHttpError && (err.status === 400 || err.status === 401)) {
        throw new DriverError(`${platformName} login expired — reconnect the account in Accounts`, 'needs-login');
      }
      throw err;
    } finally {
      inflight.delete(secrets);
    }
  })();
  inflight.set(secrets, p);
  return p;
}
