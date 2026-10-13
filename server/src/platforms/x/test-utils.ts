// Small fakes for the X driver tests (excluded from the build by tsconfig: **/test-utils.ts).

import pino from 'pino';
import type { BrowserContext } from 'playwright';
import type { Account, AccountStatus, Destination } from '../../../../shared/types.js';
import type { BrowserManager, ScopedSecrets } from '../../services.js';
import type { DriverContext } from '../types.js';

export type AccountPatch = Partial<{ label: string; status: AccountStatus; statusMessage: string | null; options: Record<string, unknown> }>;

export function memorySecrets(values: Record<string, string> = {}): ScopedSecrets {
  const map = new Map(Object.entries(values));
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
    getJson: async <T>(k: string) => (map.has(k) ? (JSON.parse(map.get(k)!) as T) : null),
    setJson: async (k, v) => void map.set(k, JSON.stringify(v)),
  };
}

/** BrowserManager whose every account uses `context`. */
export function fakeBrowser(context: BrowserContext | (() => Promise<BrowserContext>), saves: string[] = []): BrowserManager {
  const get = typeof context === 'function' ? context : async () => context;
  const page = async (_id: string, url?: string) => {
    const ctx = await get();
    const p = ctx.pages().find((x) => !x.isClosed()) ?? (await ctx.newPage());
    if (url) await p.goto(url);
    return p;
  };
  return {
    context: () => get(),
    page,
    viewerPage: page,
    save: async (id) => void saves.push(id),
    hasSavedSession: async () => true,
    close: async () => {},
    clear: async () => {},
    shutdown: async () => {},
  };
}

export interface FakeCtx {
  ctx: DriverContext;
  updates: AccountPatch[];
  saves: string[];
}

export function fakeCtx(opts: { browser: BrowserManager; saves?: string[]; streamKey?: string | null }): FakeCtx {
  const updates: AccountPatch[] = [];
  const ctx: DriverContext = {
    log: pino({ level: 'silent' }),
    accountSecrets: memorySecrets(),
    destinationSecrets: memorySecrets(opts.streamKey ? { streamKey: opts.streamKey } : {}),
    app: null,
    browser: opts.browser,
    publicBaseUrl: 'https://127.0.0.1',
    updateAccount: async (patch) => void updates.push(patch),
    signal: new AbortController().signal,
  };
  return { ctx, updates, saves: opts.saves ?? [] };
}

const NOW = '2026-10-11T00:00:00.000Z';

export function xAccount(patch: Partial<Account> = {}): Account {
  return {
    id: 'acc1',
    platform: 'x',
    label: 'X',
    status: 'connected',
    statusMessage: null,
    options: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

export function xDestination(patch: Partial<Destination> = {}): Destination {
  return {
    id: 'dest1',
    platform: 'x',
    accountId: 'acc1',
    name: 'X',
    feed: 'landscape',
    enabled: true,
    options: { autoGoLive: true },
    ingestUrl: 'rtmps://de.pscp.tv:443/x',
    hasStreamKey: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}
