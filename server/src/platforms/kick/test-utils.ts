// Small fakes for the Kick driver tests (no network, no database).

import pino from 'pino';
import type { Account, Destination } from '../../../../shared/types.js';
import type { BrowserManager, ScopedSecrets } from '../../services.js';
import type { DriverContext } from '../types.js';

/** In-memory ScopedSecrets; pass a shared map to mimic two handles on the same scope. */
export class MemorySecrets implements ScopedSecrets {
  constructor(readonly map = new Map<string, string>()) {}
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async getJson<T>(key: string): Promise<T | null> {
    const v = this.map.get(key);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
  async setJson(key: string, value: unknown): Promise<void> {
    this.map.set(key, JSON.stringify(value));
  }
}

export function unusedBrowser(): BrowserManager {
  const fail = (): never => {
    throw new Error('browser not expected in this test');
  };
  return {
    context: async () => fail(),
    page: async () => fail(),
    viewerPage: async () => fail(),
    save: async () => fail(),
    hasSavedSession: async () => false,
    close: async () => {},
    clear: async () => {},
    shutdown: async () => {},
  };
}

export function makeAccount(patch: Partial<Account> = {}): Account {
  const now = new Date().toISOString();
  return {
    id: 'acc1',
    platform: 'kick',
    label: 'Kick',
    status: 'connected',
    statusMessage: null,
    options: {},
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

export function makeDestination(patch: Partial<Destination> = {}): Destination {
  const now = new Date().toISOString();
  return {
    id: 'dest1',
    platform: 'kick',
    accountId: 'acc1',
    name: 'Kick',
    feed: 'landscape',
    enabled: true,
    options: {},
    ingestUrl: 'rtmps://fa723fc1b171.global-contribute.live-video.net/app',
    hasStreamKey: false,
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

export interface FakeCtx extends DriverContext {
  accountSecrets: MemorySecrets;
  destinationSecrets: MemorySecrets;
  updates: Parameters<DriverContext['updateAccount']>[0][];
}

export function makeCtx(patch: Partial<DriverContext> = {}): FakeCtx {
  const updates: FakeCtx['updates'] = [];
  return {
    log: pino({ level: 'silent' }),
    accountSecrets: new MemorySecrets(),
    destinationSecrets: new MemorySecrets(),
    app: { clientId: 'client-123', clientSecret: 'secret-456' },
    browser: unusedBrowser(),
    publicBaseUrl: 'https://203.0.113.7',
    signal: new AbortController().signal,
    async updateAccount(p) {
      updates.push(p);
    },
    updates,
    ...patch,
  } as FakeCtx;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

type Handler = (req: RecordedRequest) => Response | Promise<Response>;

/** A fetch stub routing by `METHOD url-prefix`. Unmatched requests fail the test loudly. */
export function fetchStub(routes: Record<string, Handler>): { fetch: typeof fetch; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = typeof init?.body === 'string' ? init.body : null;
    const req = { method, url, headers, body };
    calls.push(req);
    init?.signal?.throwIfAborted();
    const match = Object.keys(routes)
      .filter((k) => {
        const [m, prefix] = k.split(' ');
        return m === method && prefix !== undefined && url.startsWith(prefix);
      })
      .sort((a, b) => b.length - a.length)[0];
    if (!match) throw new Error(`unexpected request: ${method} ${url}`);
    return routes[match]!(req);
  };
  return { fetch: impl as typeof fetch, calls };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
