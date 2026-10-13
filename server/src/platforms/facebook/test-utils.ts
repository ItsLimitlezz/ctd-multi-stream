// Test fakes for the Facebook driver (no network, no real accounts).

import pino from 'pino';
import { vi } from 'vitest';
import type { Account, Destination } from '../../../../shared/types.js';
import type { BrowserManager, ScopedSecrets } from '../../services.js';
import type { DriverContext } from '../types.js';

export class MemorySecrets implements ScopedSecrets {
  readonly map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
  async getJson<T>(key: string): Promise<T | null> {
    const v = this.map.get(key);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
  async setJson(key: string, value: unknown) {
    this.map.set(key, JSON.stringify(value));
  }
}

const NOW = '2026-10-11T00:00:00.000Z';

export function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc1',
    platform: 'facebook',
    label: 'Facebook',
    status: 'pending',
    statusMessage: null,
    options: { mode: 'page' },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function makeDest(overrides: Partial<Destination> = {}): Destination {
  return {
    id: 'dest1',
    platform: 'facebook',
    accountId: 'acc1',
    name: 'FB',
    feed: 'landscape',
    enabled: true,
    options: {},
    ingestUrl: 'rtmps://live-api-s.facebook.com:443/rtmp/',
    hasStreamKey: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** BrowserManager that must not be used (API-only tests). */
export const noBrowser: BrowserManager = new Proxy({} as BrowserManager, {
  get(_t, prop) {
    return () => {
      throw new Error(`browser.${String(prop)} should not be called`);
    };
  },
});

export interface FakeContext extends DriverContext {
  accountSecrets: MemorySecrets;
  destinationSecrets: MemorySecrets;
  updates: Parameters<DriverContext['updateAccount']>[0][];
}

export function makeCtx(opts: Partial<DriverContext> = {}): FakeContext {
  const updates: FakeContext['updates'] = [];
  return {
    log: pino({ level: 'silent' }),
    accountSecrets: new MemorySecrets(),
    destinationSecrets: new MemorySecrets(),
    app: { clientId: 'app-123', clientSecret: 'app-secret-xyz' },
    browser: noBrowser,
    publicBaseUrl: 'https://203.0.113.7',
    signal: new AbortController().signal,
    async updateAccount(patch) {
      updates.push(patch);
    },
    ...opts,
    updates,
  } as FakeContext;
}

export interface StubCall {
  method: string;
  url: URL;
  /** Form body (POST) or null. */
  form: URLSearchParams | null;
}

export type StubHandler = (call: StubCall, init: RequestInit | undefined) => Response | Promise<Response>;

/** Replace global fetch; returns the recorded calls. Restore with vi.unstubAllGlobals(). */
export function stubFetch(handler: StubHandler): StubCall[] {
  const calls: StubCall[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const form = typeof init?.body === 'string' ? new URLSearchParams(init.body) : null;
    const call = { method, url, form };
    calls.push(call);
    init?.signal?.throwIfAborted();
    return handler(call, init);
  });
  return calls;
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function graphErr(status: number, code: number, message: string, subcode?: number): Response {
  return json(status, { error: { message, type: 'OAuthException', code, ...(subcode ? { error_subcode: subcode } : {}), fbtrace_id: 'x' } });
}

/** Path after the Graph version, e.g. '/v26.0/123/live_videos' → '123/live_videos'. */
export function graphPath(url: URL): string {
  return url.pathname.replace(/^\/v\d+\.\d+\//, '');
}

/** Graph param from query (GET) or form (POST). */
export function param(call: StubCall, name: string): string | null {
  return call.form?.get(name) ?? call.url.searchParams.get(name);
}
