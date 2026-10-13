// Test fakes for the YouTube driver: in-memory secrets, a DriverContext and a routing fetch stub.

import pino from 'pino';
import { vi } from 'vitest';
import type { Account, Destination } from '../../../../shared/types.js';
import type { BrowserManager, ScopedSecrets } from '../../services.js';
import type { OAuthTokens } from '../common/oauth.js';
import type { DriverContext } from '../types.js';
import { YOUTUBE_SCOPE } from './api.js';

export const silentLog = pino({ level: 'silent' });

export function memorySecrets(): ScopedSecrets & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
    async getJson<T>(key: string) {
      const v = data.get(key);
      return v === undefined ? null : (JSON.parse(v) as T);
    },
    async setJson(key, value) {
      data.set(key, JSON.stringify(value));
    },
  };
}

export function validTokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: Date.now() + 3600_000,
    scope: YOUTUBE_SCOPE,
    tokenType: 'Bearer',
    ...overrides,
  };
}

export function makeCtx(overrides: Partial<DriverContext> = {}) {
  const accountSecrets = memorySecrets();
  const destinationSecrets = memorySecrets();
  const updateAccount = vi.fn(async () => {});
  const ctx: DriverContext = {
    log: silentLog,
    accountSecrets,
    destinationSecrets,
    app: { clientId: 'client-id.apps.googleusercontent.com', clientSecret: 'client-secret' },
    browser: {} as BrowserManager,
    publicBaseUrl: 'https://203.0.113.7',
    updateAccount,
    signal: new AbortController().signal,
    ...overrides,
  };
  return { ctx, accountSecrets, destinationSecrets, updateAccount };
}

export function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc1',
    platform: 'youtube',
    label: 'YouTube',
    status: 'connected',
    statusMessage: null,
    options: { channelId: 'UC123' },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeDestination(overrides: Partial<Destination> = {}): Destination {
  return {
    id: 'dest1',
    platform: 'youtube',
    accountId: 'acc1',
    name: 'YouTube main',
    feed: 'landscape',
    enabled: true,
    options: { privacy: 'public', latency: 'low', madeForKids: false, enableChat: true },
    ingestUrl: null,
    hasStreamKey: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// fetch stub
// ---------------------------------------------------------------------------

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  /** Parsed JSON body, or the form fields for urlencoded bodies. */
  body: unknown;
  form: Record<string, string> | null;
}

type Handler = (call: RecordedCall, signal: AbortSignal | undefined) => Response | Promise<Response>;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A Google API error body (`error.errors[].reason`). */
export function googleError(status: number, reason: string, message = `error ${reason}`): Response {
  return json({ error: { code: status, message, errors: [{ reason, domain: 'youtube', message }] } }, status);
}

/** An OAuth endpoint error body (`{ error, error_description }`). */
export function oauthError(status: number, error: string): Response {
  return json({ error, error_description: `desc ${error}` }, status);
}

/** Routes `METHOD https://host/path` to queued handlers; the last handler of a route repeats. */
export class FetchStub {
  readonly calls: RecordedCall[] = [];
  private readonly routes = new Map<string, Handler[]>();

  on(method: string, url: string, ...handlers: (Handler | Response)[]): this {
    const list = handlers.map((h) => (typeof h === 'function' ? h : () => h.clone()));
    this.routes.set(`${method.toUpperCase()} ${url}`, list);
    return this;
  }

  callsTo(method: string, url: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method.toUpperCase() && `${c.url.origin}${c.url.pathname}` === url);
  }

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    let body: unknown = undefined;
    let form: Record<string, string> | null = null;
    if (typeof init.body === 'string') {
      if (headers['content-type']?.includes('x-www-form-urlencoded')) {
        form = Object.fromEntries(new URLSearchParams(init.body));
        body = form;
      } else {
        body = JSON.parse(init.body);
      }
    }
    const call: RecordedCall = { method, url, headers, body, form };
    this.calls.push(call);
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const key = `${method} ${url.origin}${url.pathname}`;
    const handlers = this.routes.get(key);
    if (!handlers || handlers.length === 0) throw new Error(`Unexpected fetch: ${key}`);
    const handler = handlers.length > 1 ? handlers.shift()! : handlers[0]!;
    return handler(call, signal);
  };
}

/** A response whose body is written by the test (for streaming endpoints). */
export function streamingResponse(contentType = 'application/json; charset=UTF-8') {
  const encoder = new TextEncoder();
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
    cancel() {
      closed = true;
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': contentType } }),
    write(text: string) {
      if (!closed) ctl.enqueue(encoder.encode(text));
    },
    close() {
      if (!closed) {
        closed = true;
        ctl.close();
      }
    },
    get cancelled() {
      return closed;
    },
  };
}
