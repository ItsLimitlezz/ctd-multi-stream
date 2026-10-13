// Minimal Graph API client for the Facebook driver: versioned GET/POST with appsecret_proof and
// error mapping to user-facing DriverErrors.
//
// Graph API v26.0 (released 2026-07-29) is current:
//   https://developers.facebook.com/docs/graph-api/changelog/version26.0
// Error codes: https://developers.facebook.com/docs/graph-api/guides/error-handling
// appsecret_proof: https://developers.facebook.com/docs/graph-api/securing-requests

import { createHmac } from 'node:crypto';
import { fetchJson, PlatformHttpError } from '../common/http.js';
import { DriverError } from '../types.js';

export const GRAPH_VERSION = 'v26.0';
export const GRAPH_HOST = 'https://graph.facebook.com';
export const STREAMING_GRAPH_HOST = 'https://streaming-graph.facebook.com';
export const OAUTH_DIALOG_URL = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`;

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_MESSAGE = 300;

/** Body of a Graph API error response: `{ "error": { ... } }`. */
export interface GraphErrorInfo {
  message: string;
  code: number | null;
  subcode: number | null;
  /** Localized, user-facing text Meta sometimes adds (preferred for display). */
  userMessage: string | null;
}

/** A Graph API failure mapped to a DriverError code; keeps the numeric Graph error for callers. */
export class GraphApiError extends DriverError {
  constructor(
    message: string,
    code: DriverError['code'],
    readonly httpStatus: number,
    readonly graphCode: number | null,
    readonly graphSubcode: number | null,
  ) {
    super(message, code);
  }
}

export function parseGraphError(body: string): GraphErrorInfo | null {
  try {
    const json = JSON.parse(body) as { error?: unknown };
    const e = json.error;
    if (!e || typeof e !== 'object') return null;
    const r = e as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    return {
      message: str(r.message) ?? 'Unknown error',
      code: num(r.code),
      subcode: num(r.error_subcode),
      userMessage: str(r.error_user_msg),
    };
  } catch {
    return null;
  }
}

function clip(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_MESSAGE ? `${clean.slice(0, MAX_MESSAGE - 1)}…` : clean;
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001]);
const TOKEN_CODES = new Set([102, 190, 463, 467]);
const ELIGIBILITY_RE = /eligib|at least 100 followers|60 days old|not allowed to go live|can(?:no|')t go live/i;

/** Map a Graph API error response to a user-facing DriverError. */
export function graphError(httpStatus: number, body: string): GraphApiError {
  const info = parseGraphError(body);
  const code = info?.code ?? null;
  const subcode = info?.subcode ?? null;
  // "(#200) Requires ..." → "Requires ..."
  const text = clip((info?.userMessage ?? info?.message ?? `HTTP ${httpStatus}`).replace(/^\(#\d+\)\s*/, ''));
  const make = (message: string, c: DriverError['code']) => new GraphApiError(message, c, httpStatus, code, subcode);

  if ((code !== null && TOKEN_CODES.has(code)) || httpStatus === 401) {
    return make(`Facebook access expired or was revoked — reconnect the account in Accounts (${text})`, 'needs-login');
  }
  if (code === 368) return make(`Facebook temporarily blocked this action: ${text}`, 'not-eligible');
  if (ELIGIBILITY_RE.test(text)) return make(`Facebook says this account can't go live: ${text}`, 'not-eligible');
  if (code !== null && (code === 3 || code === 10 || (code >= 200 && code <= 299))) {
    return make(
      `Facebook refused the request: ${text}. Reconnect the account in Accounts and allow every requested permission (you must be able to create content on the Page).`,
      'misconfigured',
    );
  }
  if ((code !== null && RATE_LIMIT_CODES.has(code)) || httpStatus === 429) {
    return make(`Facebook rate limit reached: ${text}. Try again in a few minutes.`, 'platform-error');
  }
  return make(`Facebook error: ${text}`, 'platform-error');
}

/** Convert anything thrown by a Graph call into a DriverError (aborts by `signal` pass through). */
export function toDriverError(err: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted) return err;
  if (err instanceof DriverError) return err;
  if (err instanceof PlatformHttpError) return graphError(err.status, err.body);
  const name = err instanceof Error || err instanceof DOMException ? err.name : '';
  if (name === 'TimeoutError') return new DriverError('Facebook did not respond in time — try again', 'timeout');
  if (name === 'AbortError') return err;
  const detail = err instanceof Error ? clip(err.message) : 'network error';
  return new DriverError(`Couldn't reach Facebook (${detail})`, 'platform-error');
}

/** HMAC-SHA256 of the access token keyed with the app secret (hex). */
export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

export interface GraphClientOptions {
  /** Base URL (tests point this at a stub); default https://graph.facebook.com. */
  host?: string;
  /** App secret, used to sign calls with appsecret_proof when a token is sent. */
  appSecret?: string | null;
  timeoutMs?: number;
}

export class GraphClient {
  private readonly host: string;
  private readonly appSecret: string | null;
  private readonly timeoutMs: number;

  constructor(opts: GraphClientOptions = {}) {
    this.host = (opts.host ?? GRAPH_HOST).replace(/\/+$/, '');
    this.appSecret = opts.appSecret || null;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Query/form params for a call: the token (if any) plus its appsecret_proof. */
  authParams(token: string | null): Record<string, string> {
    if (!token) return {};
    return this.appSecret ? { access_token: token, appsecret_proof: appSecretProof(token, this.appSecret) } : { access_token: token };
  }

  url(path: string, params: Record<string, string> = {}): string {
    const u = new URL(`${this.host}/${GRAPH_VERSION}/${path.replace(/^\/+/, '')}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  /** GET; the URL (with the token) is never logged or put in error messages. */
  async get<T>(path: string, token: string | null, params: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
    try {
      return await fetchJson<T>(this.url(path, { ...params, ...this.authParams(token) }), {
        headers: { accept: 'application/json' },
        signal,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      throw toDriverError(err, signal);
    }
  }

  /** POST form-encoded params (token in the body, not the URL). */
  async post<T>(path: string, token: string | null, form: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
    try {
      return await fetchJson<T>(this.url(path), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ ...form, ...this.authParams(token) }).toString(),
        signal,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      throw toDriverError(err, signal);
    }
  }
}
