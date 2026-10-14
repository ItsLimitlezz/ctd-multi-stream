// Pure dashboard helpers: what test mode does to each destination, and viewer counts.

import type { Account, Destination, DestinationState, PlatformId, PlatformInfo } from '@shared/types';
import { plural } from '../components/format';
import { platformName } from '../components/PlatformBadge';

// ---------------------------------------------------------------------------
// Test mode
// ---------------------------------------------------------------------------

/**
 * - test:    streams with the platform's private/test setting
 * - skip:    the platform has no test mode, so nothing is sent there
 * - depends: supported for some account types only, and the accounts aren't known here (operators)
 * - unknown: platform info not loaded yet
 */
export type TestModeAction = 'test' | 'skip' | 'depends' | 'unknown' | 'external';

/**
 * Destinations whose video doesn't go through this app, so test mode can't make them private
 * (Twitch "OBS sends Dual Format directly": OBS streams to Twitch itself).
 */
export function isExternallyStreamed(dest: Pick<Destination, 'platform'> & { options?: Destination['options'] }): boolean {
  return dest.platform === 'twitch' && dest.options?.dualFormat === 'obs-direct';
}

/**
 * Platforms whose test mode depends on the account (PlatformDriver.supportsTestMode on the server):
 * the account option and the values that have no test mode. Facebook: Pages yes, profiles no.
 */
export const ACCOUNT_TEST_MODE: Partial<Record<PlatformId, { option: string; unsupported: readonly string[] }>> = {
  facebook: { option: 'mode', unsupported: ['profile'] },
};

/** Phases in which the destination is actually being sent (so test mode was applied). */
const SENDING: ReadonlySet<DestinationState['phase']> = new Set(['preparing', 'connecting', 'confirming', 'live', 'retrying', 'recovering']);

export interface TestModeContext {
  /** null/undefined = platform info not loaded (yet). */
  platforms: readonly PlatformInfo[] | null | undefined;
  /** Accounts by id; undefined = not known here (operators can't list accounts). */
  accounts?: Readonly<Record<string, Pick<Account, 'options'>>>;
  /** Live destination states, while a session runs: the server's decision wins. */
  states?: readonly DestinationState[];
  running?: boolean;
}

/**
 * A destination of a platform whose test mode depends on the account, with no account (key only) or
 * one that no longer exists: the server always skips it in test mode.
 */
export function lacksTestModeAccount(dest: Pick<Destination, 'platform' | 'accountId'>, ctx: Pick<TestModeContext, 'accounts'>): boolean {
  if (!ACCOUNT_TEST_MODE[dest.platform]) return false;
  if (!dest.accountId) return true;
  return ctx.accounts !== undefined && !Object.hasOwn(ctx.accounts, dest.accountId);
}

/** What test mode does to one destination. */
export function destinationTestMode(
  dest: Pick<Destination, 'id' | 'platform' | 'accountId' | 'enabled'> & { options?: Destination['options'] },
  ctx: TestModeContext,
): TestModeAction {
  // OBS sends this one itself: whatever the app does, it goes out publicly.
  if (isExternallyStreamed(dest)) return 'external';
  if (ctx.running) {
    const state = ctx.states?.find((s) => s.destinationId === dest.id);
    // The orchestrator never prepares a destination without a test mode: it parks it as 'disabled'.
    if (state && dest.enabled && state.phase === 'disabled') return 'skip';
    if (state && SENDING.has(state.phase)) return 'test';
  }
  if (!ctx.platforms) return 'unknown';
  const info = ctx.platforms.find((p) => p.id === dest.platform);
  // Unsupported or not declared (older driver): skipped, so nothing goes out publicly.
  if (info?.testMode?.supported !== true) return 'skip';
  const dependent = ACCOUNT_TEST_MODE[dest.platform];
  if (!dependent) return 'test';
  if (lacksTestModeAccount(dest, ctx)) return 'skip';
  // Accounts not known here (operators): it depends.
  const account = dest.accountId && ctx.accounts ? ctx.accounts[dest.accountId] : undefined;
  if (!account) return 'depends';
  const value = account.options?.[dependent.option];
  return typeof value === 'string' && dependent.unsupported.includes(value) ? 'skip' : 'test';
}

/**
 * What happens, in words (the platform's own description when it has one). `noAccount`: the destination
 * has no (existing) account, see lacksTestModeAccount.
 */
export function testModeText(
  action: TestModeAction,
  platform: PlatformId,
  platforms: readonly PlatformInfo[] | null | undefined,
  noAccount = false,
): string {
  const name = platformName(platform);
  const info = platforms?.find((p) => p.id === platform);
  const description = info?.testMode?.description?.trim() || '';
  switch (action) {
    case 'test':
      return info?.testMode?.supported === true && description ? description : `Streams privately on ${name}`;
    case 'depends':
      return description || `Depends on the ${name} account type`;
    case 'skip':
      if (info?.testMode?.supported === true) {
        return noAccount ? `Skipped — test mode needs a ${name} account, and this destination has none` : `Skipped — this ${name} account type has no test mode`;
      }
      return description || `Skipped — ${name} has no test mode`;
    case 'unknown':
      return 'Checking…';
    case 'external':
      return `NOT private — OBS sends this to ${name} itself ("OBS sends Dual Format directly"). Turn off the ${name} output in OBS / Aitum Vertical for a private test.`;
  }
}

export const TEST_MODE_BADGE: Readonly<Record<TestModeAction, { label: string; tone: 'warn' | 'neutral' | 'info' }>> = {
  test: { label: 'Private test', tone: 'warn' },
  skip: { label: 'Skipped', tone: 'neutral' },
  depends: { label: 'Depends on account', tone: 'info' },
  unknown: { label: '…', tone: 'neutral' },
  external: { label: 'Public — OBS direct', tone: 'warn' },
};

export interface TestModeEntry {
  destinationId: string;
  name: string;
  platform: PlatformId;
  action: TestModeAction;
  text: string;
}

/** Per enabled destination, what test mode will do (or does, while running). */
export function testModePlan(destinations: readonly Destination[], ctx: TestModeContext): TestModeEntry[] {
  return destinations
    .filter((d) => d.enabled)
    .map((d) => {
      const action = destinationTestMode(d, ctx);
      const text = testModeText(action, d.platform, ctx.platforms, lacksTestModeAccount(d, ctx));
      return { destinationId: d.id, name: d.name, platform: d.platform, action, text };
    });
}

/** Banner headline, e.g. "2 destinations stream privately, 1 is skipped." */
export function testModeSummary(plan: readonly TestModeEntry[]): string {
  if (plan.length === 0) return 'No destinations are enabled, so nothing will be streamed.';
  const n = (a: TestModeAction) => plan.filter((e) => e.action === a).length;
  const test = n('test');
  const skip = n('skip');
  const depends = n('depends');
  const external = n('external');
  if (n('unknown') === plan.length) return 'Checking what each platform supports…';
  if (external) {
    const rest = testModeSummary(plan.filter((e) => e.action !== 'external'));
    const warn = `${plural(external, 'destination')} ${external === 1 ? 'is' : 'are'} NOT private (OBS streams ${external === 1 ? 'it' : 'them'} directly).`;
    return plan.length === external ? warn : `${warn} ${rest}`;
  }
  if (skip === plan.length) return 'None of the enabled platforms has a test mode: every destination is skipped, so nothing will be streamed.';
  const parts: string[] = [];
  if (test) parts.push(`${plural(test, 'destination')} ${test === 1 ? 'streams' : 'stream'} privately`);
  if (depends) parts.push(`${depends} ${depends === 1 ? 'depends' : 'depend'} on the account type`);
  if (skip) parts.push(`${skip} ${skip === 1 ? 'is' : 'are'} skipped`);
  return parts.length ? `${parts.join(', ')}.` : 'Checking what each platform supports…';
}

export const TEST_MODE_LOCKED = 'Test mode can only change while offline. End the stream first.';

// ---------------------------------------------------------------------------
// Viewers
// ---------------------------------------------------------------------------

function knownCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** Viewers to show on a destination card: only while live, and only when the platform reports them. */
export function destinationViewers(state: Pick<DestinationState, 'phase' | 'viewers'> | null | undefined): number | null {
  return state && state.phase === 'live' && knownCount(state.viewers) ? Math.floor(state.viewers) : null;
}

/** Sum of the known viewer counts of live destinations (null when none is known). */
export function totalViewers(states: readonly Pick<DestinationState, 'phase' | 'viewers'>[]): number | null {
  let sum = 0;
  let known = false;
  for (const s of states) {
    const v = destinationViewers(s);
    if (v === null) continue;
    sum += v;
    known = true;
  }
  return known ? sum : null;
}

/** 214 -> "214", 1234 -> "1,234", 15300 -> "15.3K". */
export function formatViewers(n: number, locale?: string | string[]): string {
  const v = Math.max(0, Math.floor(n));
  return v >= 10_000
    ? new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(v)
    : new Intl.NumberFormat(locale).format(v);
}

export function viewersLabel(n: number, locale?: string | string[]): string {
  return `${formatViewers(n, locale)} ${Math.floor(n) === 1 ? 'viewer' : 'viewers'}`;
}
