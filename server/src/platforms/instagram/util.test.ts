import { describe, expect, it } from 'vitest';
import { instagramDriver, instagramInfo } from './index.js';
import { checkpointError, isLoginUrl } from './flow.js';
import { RE } from './selectors.js';
import {
  instagramTitle,
  isMasked,
  isStreamKey,
  isStreamServerUrl,
  joinStreamUrl,
  optionProblems,
  readOptions,
  shortError,
  TITLE_MAX,
  usernameFromAlt,
  usernameFromHref,
} from './util.js';

describe('instagram info', () => {
  it('describes a vertical-only browser platform with a new key per live', () => {
    expect(instagramDriver.info).toBe(instagramInfo);
    expect(instagramInfo).toMatchObject({
      id: 'instagram',
      feeds: ['vertical'],
      defaultFeed: 'vertical',
      connectMethod: 'browser',
      accountFields: [],
      developerApp: null,
      titleSupport: 'browser',
      chatSupport: 'browser',
      keyPerSession: true,
      experimental: true,
    });
    const audience = instagramInfo.destinationFields.find((f) => f.key === 'audience');
    expect(audience).toMatchObject({ type: 'select', target: 'option', default: 'public' });
    expect(audience?.options?.map((o) => o.value)).toEqual(['public', 'practice']);
    expect(audience?.help).toContain('Practice = only you can see it');
    expect(instagramInfo.destinationFields.find((f) => f.key === 'goLiveTimeoutSec')).toMatchObject({
      type: 'number',
      target: 'option',
      default: 90,
    });
    expect(instagramInfo.notes).toMatch(/1,000 followers/);
  });

  it('has no live title editing (title is set at creation)', () => {
    expect('setTitleOffline' in instagramDriver).toBe(false);
  });
});

describe('options', () => {
  it('reads defaults and clamps the go-live timeout', () => {
    expect(readOptions({ options: {} })).toEqual({ audience: 'public', goLiveTimeoutSec: 90 });
    expect(readOptions({ options: { audience: 'practice', goLiveTimeoutSec: 30 } })).toEqual({ audience: 'practice', goLiveTimeoutSec: 30 });
    expect(readOptions({ options: { audience: 'nonsense', goLiveTimeoutSec: '45' } })).toEqual({ audience: 'public', goLiveTimeoutSec: 45 });
    expect(readOptions({ options: { goLiveTimeoutSec: 1 } }).goLiveTimeoutSec).toBe(15);
    expect(readOptions({ options: { goLiveTimeoutSec: 9999 } }).goLiveTimeoutSec).toBe(150);
    expect(readOptions({ options: { goLiveTimeoutSec: 'abc' } }).goLiveTimeoutSec).toBe(90);
  });

  it('reports invalid options', () => {
    expect(optionProblems({ options: { audience: 'public', goLiveTimeoutSec: 90 } })).toEqual([]);
    expect(optionProblems({ options: { audience: 'friends' } })).toEqual(['Audience must be Public or Practice']);
    expect(optionProblems({ options: { goLiveTimeoutSec: 5 } })[0]).toMatch(/between 15 and 150/);
  });

  it('validateDestination checks account, feed and options', async () => {
    const dest = {
      id: 'd',
      platform: 'instagram' as const,
      accountId: null,
      name: 'IG',
      feed: 'landscape' as const,
      enabled: true,
      options: { audience: 'x' },
      ingestUrl: null,
      hasStreamKey: false,
      createdAt: '',
      updatedAt: '',
    };
    const problems = await instagramDriver.validateDestination!(dest, null, {} as never);
    expect(problems).toEqual([
      'Audience must be Public or Practice',
      'Choose the Instagram account to stream to',
      'Instagram only accepts the vertical feed',
    ]);
  });
});

describe('stream URL helpers', () => {
  it('joins the server and key with exactly one slash', () => {
    const key = '1791?s_bl=1&a=Ab';
    expect(joinStreamUrl('rtmps://edgetee-upload-fra.xx.fbcdn.net:443/rtmp/', key)).toBe(
      'rtmps://edgetee-upload-fra.xx.fbcdn.net:443/rtmp/1791?s_bl=1&a=Ab',
    );
    expect(joinStreamUrl('rtmps://h:443/rtmp', key)).toBe('rtmps://h:443/rtmp/1791?s_bl=1&a=Ab');
    expect(joinStreamUrl(' rtmps://h:443/rtmp// ', ' /k123 ')).toBe('rtmps://h:443/rtmp/k123');
  });

  it('validates server URLs and keys', () => {
    expect(isStreamServerUrl('rtmps://edgetee-upload-fra.xx.fbcdn.net:443/rtmp/')).toBe(true);
    expect(isStreamServerUrl('rtmp://live.example.com/app')).toBe(true);
    expect(isStreamServerUrl('https://instagram.com/')).toBe(false);
    expect(isStreamServerUrl('rtmps://')).toBe(false);
    expect(isStreamServerUrl('rtmps://a b')).toBe(false);
    expect(isStreamKey('17912345678901234?s_bl=1&a=Ab')).toBe(true);
    expect(isStreamKey('short')).toBe(false);
    expect(isStreamKey('••••••••••')).toBe(false);
    expect(isStreamKey('rtmps://x/y/z/w')).toBe(false);
    expect(isStreamKey('has space inside')).toBe(false);
    expect(isMasked('●●●●')).toBe(true);
    expect(isMasked('abc')).toBe(false);
  });
});

describe('titles', () => {
  it('truncates to the field limit or TITLE_MAX and collapses whitespace', () => {
    expect(instagramTitle('  Hello   world  ')).toBe('Hello world');
    expect([...instagramTitle('x'.repeat(500))]).toHaveLength(TITLE_MAX);
    expect(instagramTitle('abcdef', 3)).toBe('abc');
    expect(instagramTitle('🎮'.repeat(10), 4)).toBe('🎮🎮🎮🎮');
    expect([...instagramTitle('y'.repeat(500), 5000)]).toHaveLength(TITLE_MAX);
  });
});

describe('usernames', () => {
  it('parses profile hrefs and avatar alts', () => {
    expect(usernameFromHref('/tester.ig_1/')).toBe('tester.ig_1');
    expect(usernameFromHref('https://www.instagram.com/someone/')).toBe('someone');
    expect(usernameFromHref('/explore/')).toBeNull();
    expect(usernameFromHref('/p/abc/')).toBeNull();
    expect(usernameFromHref('/a/b/')).toBeNull();
    expect(usernameFromHref(null)).toBeNull();
    expect(usernameFromAlt("tester_ig's profile picture")).toBe('tester_ig');
    expect(usernameFromAlt('tester_ig’s profile picture')).toBe('tester_ig');
    expect(usernameFromAlt('Profile photo')).toBeNull();
  });
});

describe('page state helpers', () => {
  it('detects login and checkpoint URLs', () => {
    expect(isLoginUrl('https://www.instagram.com/accounts/login/?next=%2F')).toBe(true);
    expect(isLoginUrl('https://www.instagram.com/')).toBe(false);
    expect(checkpointError('https://www.instagram.com/challenge/123/')?.code).toBe('needs-login');
    expect(checkpointError('https://www.instagram.com/accounts/suspended/')?.code).toBe('needs-login');
    expect(checkpointError('https://www.instagram.com/')).toBeNull();
  });

  it('shortError keeps one line and strips URLs (they may embed keys)', () => {
    const msg = shortError(new Error('push to rtmps://h:443/rtmp/SECRETKEY failed\nmore'));
    expect(msg).toBe('push to [url] failed');
    expect(msg).not.toContain('SECRET');
  });
});

describe('label regexes', () => {
  it('match accessible names that repeat an icon label', () => {
    expect(RE.create.test('New post Create')).toBe(true);
    expect(RE.create.test('Create')).toBe(true);
    expect(RE.create.test('Create new account')).toBe(false);
    expect(RE.liveVideo.test('Live video Live video')).toBe(true);
    expect(RE.liveVideo.test('Live')).toBe(true);
    expect(RE.liveVideo.test('Live photos')).toBe(false);
    expect(RE.goLive.test('Go live')).toBe(true);
    expect(RE.endLive.test('End live video')).toBe(true);
    expect(RE.endConfirm.test('End now')).toBe(true);
    expect(RE.endConfirm.test('End')).toBe(true);
    expect(RE.endConfirm.test('Cancel')).toBe(false);
    expect(RE.ineligible.test('Your account is no longer eligible for Live')).toBe(true);
    expect(RE.ineligible.test('Only public accounts with 1,000 followers or more will be able to create live videos.')).toBe(true);
    expect(RE.practice.test('Practice Only you can see it')).toBe(true);
    expect(RE.public.test('Public')).toBe(true);
    expect(RE.afterEnd.test('Share')).toBe(false);
    expect(RE.afterEnd.test('Done')).toBe(true);
  });
});
