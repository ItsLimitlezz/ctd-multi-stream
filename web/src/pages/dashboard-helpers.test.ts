import { describe, expect, it } from 'vitest';
import type { Destination, DestinationPhase, DestinationState, PlatformId, PlatformInfo } from '@shared/types';
import {
  destinationTestMode,
  destinationViewers,
  formatViewers,
  testModePlan,
  testModeSummary,
  testModeText,
  totalViewers,
  viewersLabel,
  type TestModeEntry,
} from './dashboard-helpers';

const info = (id: PlatformId, testMode?: PlatformInfo['testMode']): PlatformInfo => ({
  id,
  name: id,
  feeds: ['landscape'],
  defaultFeed: 'landscape',
  connectMethod: 'none',
  accountFields: [],
  destinationFields: [],
  developerApp: null,
  titleSupport: 'none',
  chatSupport: 'none',
  keyPerSession: false,
  experimental: false,
  testMode,
});

const PLATFORMS: PlatformInfo[] = [
  info('twitch', { supported: true, description: 'Bandwidth test — Twitch receives the stream but nobody sees it' }),
  info('youtube', { supported: true, description: 'Private broadcast — only you can see it' }),
  info('kick', { supported: false, description: 'Kick has no test mode — skipped while testing' }),
  info('facebook', { supported: true, description: 'Pages: only you can see it. Profiles have no test mode and are skipped.' }),
  info('x'), // an older driver without testMode
];

const dest = (id: string, platform: PlatformId, over: Partial<Destination> = {}): Destination => ({
  id,
  platform,
  accountId: null,
  name: `${platform} ${id}`,
  feed: 'landscape',
  enabled: true,
  options: {},
  ingestUrl: null,
  hasStreamKey: false,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...over,
});

const state = (id: string, phase: DestinationPhase, viewers?: number | null): DestinationState => ({
  destinationId: id,
  phase,
  message: null,
  stats: null,
  watchUrl: null,
  retries: 0,
  since: '2026-10-11T10:00:00.000Z',
  recoveries: 0,
  lastRecovery: null,
  viewers,
});

describe('test mode per destination', () => {
  const ctx = { platforms: PLATFORMS };

  it('follows PlatformInfo.testMode; missing info means skipped', () => {
    expect(destinationTestMode(dest('1', 'twitch'), ctx)).toBe('test');
    expect(destinationTestMode(dest('2', 'kick'), ctx)).toBe('skip');
    expect(destinationTestMode(dest('3', 'x'), ctx)).toBe('skip');
    expect(destinationTestMode(dest('4', 'tiktok'), ctx)).toBe('skip'); // not in the list at all
    expect(destinationTestMode(dest('5', 'twitch'), { platforms: null })).toBe('unknown');
  });

  it('Facebook depends on the account type (Page vs profile)', () => {
    const fb = dest('f', 'facebook', { accountId: 'acc' });
    expect(destinationTestMode(fb, ctx)).toBe('depends'); // accounts unknown (operator)
    expect(destinationTestMode(fb, { ...ctx, accounts: { acc: { options: { mode: 'profile' } } } })).toBe('skip');
    expect(destinationTestMode(fb, { ...ctx, accounts: { acc: { options: { mode: 'page' } } } })).toBe('test');
    expect(destinationTestMode(fb, { ...ctx, accounts: { acc: { options: {} } } })).toBe('test'); // server default: page
  });

  it('Facebook without an account, or with a deleted one, is skipped like the server does', () => {
    const keyOnly = dest('k', 'facebook', { accountId: null });
    expect(destinationTestMode(keyOnly, ctx)).toBe('skip'); // even when the accounts aren't known
    expect(destinationTestMode(keyOnly, { ...ctx, accounts: {} })).toBe('skip');
    const deleted = dest('d', 'facebook', { accountId: 'gone' });
    expect(destinationTestMode(deleted, { ...ctx, accounts: {} })).toBe('skip');
    expect(destinationTestMode(dest('p', 'facebook', { accountId: 'toString' }), { ...ctx, accounts: {} })).toBe('skip'); // own keys only
    expect(destinationTestMode(deleted, ctx)).toBe('depends'); // operators: accounts unknown
    // The banner says why.
    const plan = testModePlan([keyOnly, deleted, dest('t', 'twitch')], { ...ctx, accounts: {} });
    expect(plan.map((e) => e.action)).toEqual(['skip', 'skip', 'test']);
    expect(plan[0]?.text).toBe('Skipped — test mode needs a Facebook account, and this destination has none');
    expect(plan[1]?.text).toBe(plan[0]?.text);
    expect(testModeSummary(plan)).toBe('1 destination streams privately, 2 are skipped.');
    // A profile account keeps the account-type text.
    const profile = testModePlan([dest('f', 'facebook', { accountId: 'acc' })], { ...ctx, accounts: { acc: { options: { mode: 'profile' } } } });
    expect(profile[0]?.text).toBe('Skipped — this Facebook account type has no test mode');
  });

  it("while running, the server's decision wins", () => {
    const fb = dest('f', 'facebook', { accountId: 'acc' });
    expect(destinationTestMode(fb, { ...ctx, running: true, states: [state('f', 'disabled')] })).toBe('skip');
    expect(destinationTestMode(fb, { ...ctx, running: true, states: [state('f', 'live')] })).toBe('test');
    // Not running: states are ignored.
    expect(destinationTestMode(fb, { ...ctx, running: false, states: [state('f', 'live')] })).toBe('depends');
    // An error falls back to the platform info.
    expect(destinationTestMode(dest('k', 'kick'), { ...ctx, running: true, states: [state('k', 'error')] })).toBe('skip');
  });

  it('describes what happens', () => {
    expect(testModeText('test', 'twitch', PLATFORMS)).toBe('Bandwidth test — Twitch receives the stream but nobody sees it');
    expect(testModeText('skip', 'kick', PLATFORMS)).toBe('Kick has no test mode — skipped while testing');
    expect(testModeText('skip', 'x', PLATFORMS)).toBe('Skipped — X has no test mode');
    expect(testModeText('skip', 'facebook', PLATFORMS)).toBe('Skipped — this Facebook account type has no test mode');
    expect(testModeText('depends', 'facebook', PLATFORMS)).toContain('Profiles have no test mode');
    expect(testModeText('unknown', 'twitch', null)).toBe('Checking…');
    expect(testModeText('test', 'youtube', [info('youtube', { supported: true, description: ' ' })])).toBe('Streams privately on YouTube');
  });

  it('plans enabled destinations only, in order', () => {
    const plan = testModePlan([dest('1', 'twitch'), dest('2', 'kick', { enabled: false }), dest('3', 'youtube'), dest('4', 'kick')], ctx);
    expect(plan.map((e) => [e.destinationId, e.action])).toEqual([
      ['1', 'test'],
      ['3', 'test'],
      ['4', 'skip'],
    ]);
    expect(plan[0]).toMatchObject({ name: 'twitch 1', platform: 'twitch' });
  });
});

describe('test mode banner text', () => {
  const e = (action: TestModeEntry['action']): TestModeEntry => ({ destinationId: action, name: action, platform: 'twitch', action, text: '' });

  it('summarises the plan', () => {
    expect(testModeSummary([e('test'), e('test'), e('skip')])).toBe('2 destinations stream privately, 1 is skipped.');
    expect(testModeSummary([e('test')])).toBe('1 destination streams privately.');
    expect(testModeSummary([e('test'), e('depends'), e('skip'), e('skip')])).toBe(
      '1 destination streams privately, 1 depends on the account type, 2 are skipped.',
    );
    expect(testModeSummary([e('skip'), e('skip')])).toMatch(/^None of the enabled platforms has a test mode/);
    expect(testModeSummary([])).toBe('No destinations are enabled, so nothing will be streamed.');
    expect(testModeSummary([e('unknown')])).toBe('Checking what each platform supports…');
    expect(testModeSummary([e('unknown'), e('skip')])).toBe('1 is skipped.');
  });
});

describe('viewers', () => {
  it('only counts live destinations with a known count', () => {
    expect(destinationViewers(state('a', 'live', 214))).toBe(214);
    expect(destinationViewers(state('a', 'live', null))).toBeNull();
    expect(destinationViewers(state('a', 'live'))).toBeNull();
    expect(destinationViewers(state('a', 'retrying', 50))).toBeNull();
    expect(destinationViewers(state('a', 'live', -1))).toBeNull();
    expect(destinationViewers(null)).toBeNull();
    expect(totalViewers([state('a', 'live', 214), state('b', 'live', null), state('c', 'live', 6), state('d', 'error', 99)])).toBe(220);
    expect(totalViewers([state('a', 'live', null), state('b', 'idle')])).toBeNull();
    expect(totalViewers([state('a', 'live', 0)])).toBe(0);
  });

  it('formats counts', () => {
    expect(formatViewers(214, 'en-US')).toBe('214');
    expect(formatViewers(1234, 'en-US')).toBe('1,234');
    expect(formatViewers(15_300, 'en-US')).toBe('15.3K');
    expect(formatViewers(2_000_000, 'en-US')).toBe('2M');
    expect(viewersLabel(1, 'en-US')).toBe('1 viewer');
    expect(viewersLabel(0, 'en-US')).toBe('0 viewers');
  });
});

describe('Twitch "OBS sends Dual Format directly" in test mode', () => {
  const obsDirect = dest('od', 'twitch', { options: { dualFormat: 'obs-direct' } });
  const relayed = dest('rl', 'twitch', { options: { dualFormat: 'off' } });

  it('is flagged as public, never as a private test, even while running', () => {
    expect(destinationTestMode(obsDirect, { platforms: PLATFORMS })).toBe('external');
    expect(destinationTestMode(obsDirect, { platforms: PLATFORMS, running: true, states: [state('od', 'live')] })).toBe('external');
    expect(destinationTestMode(relayed, { platforms: PLATFORMS })).toBe('test');
  });

  it('explains how to keep it private and leads the summary with the warning', () => {
    const plan = testModePlan([obsDirect, relayed], { platforms: PLATFORMS });
    expect(plan.find((e) => e.destinationId === 'od')?.text).toMatch(/NOT private/);
    expect(testModeSummary(plan)).toMatch(/^1 destination is NOT private .* 1 destination streams privately\.$/);
    expect(testModeSummary(testModePlan([obsDirect], { platforms: PLATFORMS }))).toBe('1 destination is NOT private (OBS streams it directly).');
  });
});