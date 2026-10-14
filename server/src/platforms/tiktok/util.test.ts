import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { tiktokDriver, TIKTOK_INFO } from './index.js';
import { CHAT_EXTRACT, healthScanScript, ingestScript, TEXT, topicScript, USERNAME_SCRIPT } from './selectors.js';
import { makeAccount, makeDestination } from './test-utils.js';
import {
  accountUsername,
  autoRecoverEnabled,
  goLiveTimeoutSec,
  hostOf,
  isLoginUrl,
  isMaskedKey,
  isRtmpUrl,
  isUnder,
  joinRtmpUrl,
  looksLikeStreamKey,
  normalizeUsername,
  parseOptionalBoolean,
  parseOptionalNumber,
  parseViewerCount,
  sameHost,
  takedownConfirmSec,
  watchUrlFor,
  zeroViewerSec,
} from './util.js';

describe('tiktok util', () => {
  it('joins server URL and key with exactly one slash', () => {
    expect(joinRtmpUrl('rtmp://push.tiktokcdn.com/game/', 'stream-1?sign=x')).toBe('rtmp://push.tiktokcdn.com/game/stream-1?sign=x');
    expect(joinRtmpUrl('rtmp://push.tiktokcdn.com/game', '/stream-1')).toBe('rtmp://push.tiktokcdn.com/game/stream-1');
    expect(joinRtmpUrl(' rtmps://h:443/live// ', ' k123456 ')).toBe('rtmps://h:443/live/k123456');
  });

  it('recognizes RTMP URLs, masked keys and plausible keys', () => {
    expect(isRtmpUrl('rtmp://push-rtmp-l11.tiktokcdn.com/game/')).toBe(true);
    expect(isRtmpUrl('rtmps://x.example:443/app')).toBe(true);
    expect(isRtmpUrl('https://x.example/app')).toBe(false);
    expect(isRtmpUrl('rtmp://')).toBe(false);
    expect(isMaskedKey('•'.repeat(12))).toBe(true);
    expect(isMaskedKey('************')).toBe(true);
    expect(isMaskedKey('stream-123')).toBe(false);
    expect(looksLikeStreamKey('stream-7712345678901?expire=1&sign=a')).toBe(true);
    expect(looksLikeStreamKey('•'.repeat(12))).toBe(false);
    expect(looksLikeStreamKey('has space 123')).toBe(false);
    expect(looksLikeStreamKey('rtmp://host/app')).toBe(false);
    expect(looksLikeStreamKey('abc')).toBe(false);
  });

  it('parses the go-live timeout with a default and bounds', () => {
    expect(goLiveTimeoutSec(makeDestination())).toBe(90);
    expect(goLiveTimeoutSec(makeDestination({ options: { goLiveTimeoutSec: 45 } }))).toBe(45);
    expect(goLiveTimeoutSec(makeDestination({ options: { goLiveTimeoutSec: '60' } }))).toBe(60);
    expect(goLiveTimeoutSec(makeDestination({ options: { goLiveTimeoutSec: 1 } }))).toBe(15);
    expect(goLiveTimeoutSec(makeDestination({ options: { goLiveTimeoutSec: 9999 } }))).toBe(150);
    expect(goLiveTimeoutSec(makeDestination({ options: { goLiveTimeoutSec: 'soon' } }))).toBe(90);
    expect(goLiveTimeoutSec(makeDestination({ options: { goLiveTimeoutSec: 2 } }), 1)).toBe(2);
    expect(parseOptionalNumber('')).toBeNull();
    expect(parseOptionalNumber(undefined)).toBeNull();
    expect(parseOptionalNumber('x')).toBeNaN();
  });

  it('parses the Stream Guard options with defaults and bounds', () => {
    const d = (options: Record<string, unknown>) => makeDestination({ options });
    expect(autoRecoverEnabled(d({}))).toBe(true);
    expect(autoRecoverEnabled(d({ autoRecover: false }))).toBe(false);
    expect(autoRecoverEnabled(d({ autoRecover: 'false' }))).toBe(false);
    expect(autoRecoverEnabled(d({ autoRecover: true }))).toBe(true);
    expect(autoRecoverEnabled(d({ autoRecover: 'garbage' }))).toBe(true);
    expect(takedownConfirmSec(d({}))).toBe(5);
    expect(takedownConfirmSec(d({ takedownConfirmSec: 12 }))).toBe(12);
    expect(takedownConfirmSec(d({ takedownConfirmSec: '1' }))).toBe(2);
    expect(takedownConfirmSec(d({ takedownConfirmSec: 999 }))).toBe(60);
    expect(takedownConfirmSec(d({ takedownConfirmSec: 'x' }))).toBe(5);
    expect(zeroViewerSec(d({}))).toBe(0);
    expect(zeroViewerSec(d({ zeroViewerSec: 5 }))).toBe(5);
    expect(zeroViewerSec(d({ zeroViewerSec: -3 }))).toBe(0);
    expect(zeroViewerSec(d({ zeroViewerSec: 10_000 }))).toBe(600);
    expect(zeroViewerSec(d({ zeroViewerSec: 'nope' }))).toBe(0);
    expect(parseOptionalBoolean(undefined)).toBeNull();
    expect(parseOptionalBoolean('on')).toBe(true);
    expect(parseOptionalBoolean(0)).toBe(false);
    expect(parseOptionalBoolean('maybe')).toBe('invalid');
  });

  it('parses viewer counts the way TikTok shows them', () => {
    expect(parseViewerCount('0')).toBe(0);
    expect(parseViewerCount(' 12 ')).toBe(12);
    expect(parseViewerCount('1,234')).toBe(1234);
    expect(parseViewerCount('1.234')).toBe(1234);
    expect(parseViewerCount('1.2K')).toBe(1200);
    expect(parseViewerCount('1,2k')).toBe(1200);
    expect(parseViewerCount('3M')).toBe(3_000_000);
    expect(parseViewerCount('10K+')).toBe(10_000);
    expect(parseViewerCount('--')).toBeNull();
    expect(parseViewerCount('')).toBeNull();
    expect(parseViewerCount(null)).toBeNull();
    expect(parseViewerCount('1.5')).toBeNull();
    expect(parseViewerCount('viewers')).toBeNull();
  });

  it('derives the username and watch URL from the account', () => {
    expect(normalizeUsername('@ctd.tester_1')).toBe('ctd.tester_1');
    expect(normalizeUsername('no spaces allowed')).toBeNull();
    expect(accountUsername(makeAccount('a', { options: { username: 'stored' }, label: '@label' }))).toBe('stored');
    expect(accountUsername(makeAccount('a', { label: '@from_label' }))).toBe('from_label');
    expect(accountUsername(makeAccount('a', { label: 'My TikTok' }))).toBeNull();
    expect(watchUrlFor('ctd_tester')).toBe('https://www.tiktok.com/@ctd_tester/live');
    expect(watchUrlFor(null)).toBeNull();
  });

  it('compares URLs safely', () => {
    expect(isUnder('https://livecenter.tiktok.com/producer?lang=en', 'https://livecenter.tiktok.com/producer')).toBe(true);
    expect(isUnder('https://livecenter.tiktok.com/', 'https://livecenter.tiktok.com/producer')).toBe(false);
    expect(isUnder('https://www.tiktok.com/foryou', 'https://www.tiktok.com/')).toBe(true);
    expect(isUnder('about:blank', 'https://www.tiktok.com/')).toBe(false);
    expect(isLoginUrl('https://www.tiktok.com/login?redirect_url=x')).toBe(true);
    expect(isLoginUrl('https://www.tiktok.com/login/phone-or-email')).toBe(true);
    expect(isLoginUrl('https://livecenter.tiktok.com/producer')).toBe(false);
    expect(sameHost('https://livecenter.tiktok.com/x', 'https://livecenter.tiktok.com/producer')).toBe(true);
    expect(sameHost('https://www.tiktok.com/', 'https://livecenter.tiktok.com/producer')).toBe(false);
    expect(hostOf('rtmp://push.tiktokcdn.com/game/stream-1?sign=secret')).toBe('rtmp://push.tiktokcdn.com');
  });
});

describe('tiktok selectors', () => {
  it('tells the Go LIVE buttons apart', () => {
    expect(TEXT.goLive.test('Go LIVE')).toBe(true);
    expect(TEXT.goLive.test('Save & Go LIVE')).toBe(false);
    expect(TEXT.saveAndGoLive.test('Save & Go LIVE')).toBe(true);
    expect(TEXT.saveAndGoLive.test('SAVE AND GO LIVE')).toBe(true);
    expect(TEXT.endLive.test('End LIVE')).toBe(true);
    expect(TEXT.endLive.test('End')).toBe(false);
    expect(TEXT.endConfirm.test('End')).toBe(true);
    expect(TEXT.generateKey.test('Generate')).toBe(true);
    expect(TEXT.generateKey.test('Get stream key')).toBe(true);
    expect(TEXT.generateKey.test('Get')).toBe(false);
  });

  it('matches status texts', () => {
    expect(TEXT.ineligible.test("You aren’t eligible for LIVE Producer yet")).toBe(true);
    expect(TEXT.ineligible.test('You need at least 1,000 followers to go LIVE')).toBe(true);
    expect(TEXT.ineligible.test('LIVE Producer')).toBe(false);
    expect(TEXT.noStream.test('Waiting for stream...')).toBe(true);
    expect(TEXT.noStream.test("We haven't received any video")).toBe(true);
    expect(TEXT.noStream.test('Preview')).toBe(false);
    expect(TEXT.checkEncoder.test('Please check your streaming software')).toBe(true);
    expect(TEXT.checkEncoder.test('Check your network connection')).toBe(true);
    expect(TEXT.checkEncoder.test('Check OBS')).toBe(true);
    expect(TEXT.checkEncoder.test('Please check our Community Guidelines')).toBe(false);
    expect(TEXT.topicPlaceholder.test('Select a topic')).toBe(true);
    expect(TEXT.topicPlaceholder.test('')).toBe(true);
    expect(TEXT.topicPlaceholder.test('Gaming')).toBe(false);
    expect(TEXT.topicError.test('Please select a topic')).toBe(true);
    expect(TEXT.topicError.test('Select a topic')).toBe(false); // the empty picker itself is not an error
    expect(TEXT.softwareSource.test('Streaming software')).toBe(true);
    expect(TEXT.softwareSource.test('OBS / Streamlabs')).toBe(true);
    expect(TEXT.softwareSource.test('Mobile camera')).toBe(false);
    expect(TEXT.keyLabel.test('Stream key')).toBe(true);
    expect(TEXT.keyLabel.test('Never share your stream key')).toBe(false);
    expect(TEXT.serverLabel.test('Server URL')).toBe(true);
  });

  it('page scripts are valid JavaScript', () => {
    for (const source of [ingestScript(), topicScript(), healthScanScript(), USERNAME_SCRIPT, `(${CHAT_EXTRACT})`]) {
      expect(() => new vm.Script(source)).not.toThrow();
    }
  });
});

describe('tiktok driver info', () => {
  it('describes a vertical-only, key-per-session browser platform', () => {
    expect(TIKTOK_INFO.id).toBe('tiktok');
    expect(TIKTOK_INFO.feeds).toEqual(['vertical']);
    expect(TIKTOK_INFO.defaultFeed).toBe('vertical');
    expect(TIKTOK_INFO.connectMethod).toBe('browser');
    expect(TIKTOK_INFO.developerApp).toBeNull();
    expect(TIKTOK_INFO.keyPerSession).toBe(true);
    expect(TIKTOK_INFO.experimental).toBe(true);
    expect(TIKTOK_INFO.titleSupport).toBe('browser');
    expect(TIKTOK_INFO.chatSupport).toBe('browser');
    expect(TIKTOK_INFO.destinationFields).toEqual([
      expect.objectContaining({ key: 'goLiveTimeoutSec', type: 'number', target: 'option', default: 90 }),
      expect.objectContaining({ key: 'autoRecover', type: 'boolean', target: 'option', default: true }),
      expect.objectContaining({ key: 'takedownConfirmSec', type: 'number', target: 'option', default: 5 }),
      expect.objectContaining({ key: 'zeroViewerSec', type: 'number', target: 'option', default: 0 }),
    ]);
    expect(TIKTOK_INFO.notes).toMatch(/topic/i);
    expect(TIKTOK_INFO.notes).toMatch(/new one automatically/);
    expect(tiktokDriver.info).toBe(TIKTOK_INFO);
  });

  it('starts a browser connect at the TikTok login page', async () => {
    const start = await tiktokDriver.startConnect!(makeAccount('a'), {} as never);
    expect(start).toMatchObject({ method: 'browser', startUrl: 'https://www.tiktok.com/login' });
  });

  it('validates destinations', async () => {
    const ctx = {} as never;
    expect(await tiktokDriver.validateDestination!(makeDestination(), null, ctx)).toEqual([]);
    expect(await tiktokDriver.validateDestination!(makeDestination({ feed: 'landscape' }), null, ctx)).toEqual([
      'TikTok only accepts the vertical feed',
    ]);
    expect(await tiktokDriver.validateDestination!(makeDestination({ options: { goLiveTimeoutSec: 'x' } }), null, ctx)).toHaveLength(1);
    expect(
      await tiktokDriver.validateDestination!(
        makeDestination({ options: { autoRecover: false, takedownConfirmSec: 10, zeroViewerSec: '5' } }),
        null,
        ctx,
      ),
    ).toEqual([]);
    expect(
      await tiktokDriver.validateDestination!(
        makeDestination({ options: { autoRecover: 'maybe', takedownConfirmSec: 'soon', zeroViewerSec: {} } }),
        null,
        ctx,
      ),
    ).toEqual([
      'Auto-recover must be on or off',
      'Takedown confirmation must be a number of seconds',
      '0-viewer takedown must be a number of seconds',
    ]);
  });

  it('requires an account to prepare', async () => {
    await expect(tiktokDriver.prepare(makeDestination(), null, 't', {} as never)).rejects.toMatchObject({
      name: 'DriverError',
      code: 'not-connected',
    });
  });
});
