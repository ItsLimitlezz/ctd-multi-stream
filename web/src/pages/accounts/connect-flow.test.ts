import { describe, expect, it } from 'vitest';
import type { PlatformAppStatus } from '@shared/api';
import type { Destination, PlatformInfo } from '@shared/types';
import { ApiRequestError } from '../../api';
import {
  ACCOUNT_STATUS_META,
  checkPastedUrl,
  connectablePlatforms,
  connectLabel,
  connectMethodFor,
  deleteConfirmLabel,
  destinationsUsing,
  developerAppBadge,
  developerAppMissing,
  displayUrl,
  formatCountdown,
  isFatalPollError,
  isMisconfigured,
  needsDeveloperApp,
  pollBackoffMs,
  pollIntervalMs,
  readAccountsQuery,
  remainingSeconds,
  verificationLink,
} from './connect-flow';

const platform = (id: PlatformInfo['id'], over: Partial<PlatformInfo> = {}): PlatformInfo => ({
  id,
  name: id,
  feeds: ['landscape'],
  defaultFeed: 'landscape',
  connectMethod: 'device-code',
  accountFields: [],
  destinationFields: [],
  developerApp: { consoleUrl: 'https://dev.example', fields: [], instructions: '' },
  titleSupport: 'api',
  chatSupport: 'api',
  keyPerSession: false,
  experimental: false,
  ...over,
});

const app = (p: PlatformAppStatus['platform'], configured: boolean): PlatformAppStatus => ({
  platform: p,
  configured,
  values: {},
  secretsSet: {},
  redirectUri: null,
});

describe('connect flow helpers', () => {
  it('has a label and tone for every account status', () => {
    expect(Object.keys(ACCOUNT_STATUS_META).sort()).toEqual(['connected', 'error', 'needs-login', 'pending']);
    expect(connectLabel('pending')).toBe('Connect');
    expect(connectLabel('needs-login')).toBe('Reconnect');
  });

  it('prefers the complete verification URI and rejects unsafe links', () => {
    expect(verificationLink({ verificationUri: 'https://www.twitch.tv/activate', verificationUriComplete: 'https://www.twitch.tv/activate?device-code=ABCD' })).toBe(
      'https://www.twitch.tv/activate?device-code=ABCD',
    );
    expect(verificationLink({ verificationUri: 'https://google.com/device' })).toBe('https://google.com/device');
    expect(verificationLink({ verificationUri: 'https://google.com/device', verificationUriComplete: 'javascript:alert(1)' })).toBe(
      'https://google.com/device',
    );
    expect(verificationLink({ verificationUri: 'javascript:alert(1)' })).toBeNull();
    expect(displayUrl('https://www.twitch.tv/activate/')).toBe('twitch.tv/activate');
    expect(displayUrl('https://google.com/')).toBe('google.com');
  });

  it('computes poll timing and the countdown', () => {
    expect(pollIntervalMs(5)).toBe(5000);
    expect(pollIntervalMs(0)).toBe(5000);
    expect(pollIntervalMs(Number.NaN)).toBe(5000);
    expect(pollIntervalMs(0.2)).toBe(1000);
    expect(pollIntervalMs(600)).toBe(60_000);
    expect(pollBackoffMs(5000)).toBe(10_000);
    expect(pollBackoffMs(20_000)).toBe(30_000);
    expect(remainingSeconds(10_500, 0)).toBe(11);
    expect(remainingSeconds(0, 5000)).toBe(0);
    expect(formatCountdown(245)).toBe('4:05');
    expect(formatCountdown(-3)).toBe('0:00');
  });

  it('classifies poll and connect errors', () => {
    expect(isFatalPollError(new ApiRequestError(400, 'Denied', 'platform-error'))).toBe(true);
    expect(isFatalPollError(new ApiRequestError(404, 'Account not found', 'not_found'))).toBe(true);
    expect(isFatalPollError(new ApiRequestError(429, 'Slow down'))).toBe(false);
    expect(isFatalPollError(new ApiRequestError(502, 'Bad gateway'))).toBe(false);
    expect(isFatalPollError(new ApiRequestError(0, 'Could not reach the server', 'network'))).toBe(false);
    expect(isFatalPollError(new Error('x'))).toBe(false);
    expect(isMisconfigured(new ApiRequestError(400, 'Set up the Twitch app first', 'misconfigured'))).toBe(true);
    expect(isMisconfigured(new ApiRequestError(400, 'nope', 'invalid'))).toBe(false);
  });

  it('checks the pasted OAuth redirect address', () => {
    expect(checkPastedUrl('  https://203.0.113.7/oauth/callback/kick?code=abc&state=a1.xyz ')).toEqual({
      ok: true,
      url: 'https://203.0.113.7/oauth/callback/kick?code=abc&state=a1.xyz',
    });
    expect(checkPastedUrl('https://h/cb?error=access_denied').ok).toBe(true);
    expect(checkPastedUrl('https://h/cb#access_token=t').ok).toBe(true);
    expect(checkPastedUrl('').ok).toBe(false);
    expect(checkPastedUrl('code=abc').ok).toBe(false);
    expect(checkPastedUrl('ftp://h/cb?code=1').ok).toBe(false);
    expect(checkPastedUrl('https://h/cb').ok).toBe(false);
  });

  it('reads the accounts page query', () => {
    expect(readAccountsQuery(new URLSearchParams('connected=a1&error=&add=twitch'))).toEqual({ connected: 'a1', error: null, add: 'twitch' });
    expect(readAccountsQuery(new URLSearchParams('error=Authorization%20failed'))).toEqual({
      connected: null,
      error: 'Authorization failed',
      add: null,
    });
    expect(readAccountsQuery(new URLSearchParams(`error=${'x'.repeat(900)}`)).error).toHaveLength(500);
  });

  it('knows which platforms need a developer app first', () => {
    const twitch = platform('twitch');
    const tiktok = platform('tiktok', { connectMethod: 'browser', developerApp: null });
    const custom = platform('custom', { connectMethod: 'none', developerApp: null });
    expect(connectablePlatforms([twitch, tiktok, custom]).map((p) => p.id)).toEqual(['twitch', 'tiktok']);
    expect(needsDeveloperApp(twitch, [app('twitch', false)])).toBe(true);
    expect(needsDeveloperApp(twitch, [app('twitch', true)])).toBe(false);
    expect(needsDeveloperApp(twitch, undefined)).toBe(false);
    expect(needsDeveloperApp(tiktok, [])).toBe(false);
    expect(needsDeveloperApp(undefined, [])).toBe(false);
    expect(developerAppBadge(twitch, [app('twitch', false)])).toBe('Needs developer app');
    expect(developerAppBadge(twitch, [app('twitch', true)])).toBeNull();
    expect(connectMethodFor(twitch, {})).toBe('device-code');
  });

  it('only asks for the Meta app for Facebook Page accounts, not profile accounts', () => {
    const facebook = platform('facebook', { connectMethod: 'oauth-paste' });
    const missing = [app('facebook', false)];
    // No account type chosen yet: don't block the platform, the form decides.
    expect(needsDeveloperApp(facebook, missing)).toBe(false);
    expect(developerAppMissing(facebook, missing)).toBe(true);
    expect(developerAppBadge(facebook, missing)).toBe('Some account types need a developer app');
    // Page mode (also the server's default when mode is missing) needs it; profile mode doesn't.
    expect(needsDeveloperApp(facebook, missing, { mode: 'page' })).toBe(true);
    expect(needsDeveloperApp(facebook, missing, {})).toBe(true);
    expect(needsDeveloperApp(facebook, missing, { mode: 'profile' })).toBe(false);
    expect(needsDeveloperApp(facebook, [app('facebook', true)], { mode: 'page' })).toBe(false);
    // Profile mode logs in through the built-in browser.
    expect(connectMethodFor(facebook, { mode: 'profile' })).toBe('browser');
    expect(connectMethodFor(facebook, { mode: 'page' })).toBe('oauth-paste');
  });

  it('counts linked destinations for the delete warning', () => {
    const d = (id: string, accountId: string | null) => ({ id, accountId }) as Destination;
    expect(destinationsUsing([d('1', 'a'), d('2', 'b'), d('3', 'a')], 'a')).toBe(2);
    expect(destinationsUsing(undefined, 'a')).toBe(0);
    expect(deleteConfirmLabel(0)).toBe('Delete?');
    expect(deleteConfirmLabel(2)).toBe('Delete and unlink 2?');
  });
});
