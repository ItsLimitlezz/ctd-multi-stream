import { describe, expect, it } from 'vitest';
import { instagramDriver, instagramInfo } from './index.js';
import { checkpointError, isLoginUrl } from './flow.js';
import { LEFTOVER_DIALOG, LEFTOVER_POLICY_NOTICE, RE } from './selectors.js';
import {
  instagramTitle,
  isMasked,
  isStreamKey,
  isStreamServerUrl,
  joinStreamUrl,
  linkUrl,
  optionProblems,
  parseViewerCount,
  pickLink,
  readLinks,
  readLiveOptions,
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

  it('appends the Stream Guard fields after the existing ones', () => {
    const field = (key: string) => instagramInfo.destinationFields.find((f) => f.key === key);
    expect(instagramInfo.destinationFields.map((f) => f.key)).toEqual([
      'audience',
      'goLiveTimeoutSec',
      'autoRecover',
      'takedownConfirmSec',
      'zeroViewerSec',
      'links',
      'linkMode',
    ]);
    expect(field('autoRecover')).toMatchObject({ type: 'boolean', target: 'option', default: true });
    expect(field('autoRecover')?.help).toMatch(/copyright takedown/);
    expect(field('takedownConfirmSec')).toMatchObject({ type: 'number', default: 5 });
    expect(field('zeroViewerSec')).toMatchObject({ type: 'number', default: 0 });
    expect(field('zeroViewerSec')?.help).toMatch(/Public lives only/);
    expect(field('links')).toMatchObject({ type: 'links', target: 'option' });
    expect(field('links')?.default).toBeUndefined();
    expect(field('linkMode')).toMatchObject({ type: 'select', default: 'rotate' });
    expect(field('linkMode')?.options?.map((o) => o.value)).toEqual(['off', 'rotate', 'first']);
  });

  it('has no live title editing (title is set at creation)', () => {
    expect('setTitleOffline' in instagramDriver).toBe(false);
  });

  it('supports session test mode (Practice) for every destination', () => {
    expect(instagramInfo.testMode).toEqual({ supported: true, description: 'Practice audience — only you can see it' });
    // No per-destination override: the default (info.testMode.supported) applies.
    expect(instagramDriver.supportsTestMode).toBeUndefined();
  });
});

describe('test mode options', () => {
  it('forces the Practice audience in test mode and changes nothing else', () => {
    const options = { audience: 'public', zeroViewerSec: 5, autoRecover: true, links: [{ title: 'K', url: 'https://kick.com/a' }], linkMode: 'first' };
    expect(readLiveOptions({ options })).toEqual(readOptions({ options }));
    expect(readLiveOptions({ options }, false).audience).toBe('public');
    expect(readLiveOptions({ options }, true)).toEqual({ ...readOptions({ options }), audience: 'practice' });
    expect(readLiveOptions({ options: { audience: 'practice' } }, true).audience).toBe('practice');
    expect(readLiveOptions({ options: {} }, true).audience).toBe('practice');
  });

  it('never rewrites the saved destination options', () => {
    const options = { audience: 'public' };
    readLiveOptions({ options }, true);
    expect(options).toEqual({ audience: 'public' });
  });
});

describe('options', () => {
  it('reads defaults and clamps the go-live timeout', () => {
    expect(readOptions({ options: {} })).toEqual({
      audience: 'public',
      goLiveTimeoutSec: 90,
      autoRecover: true,
      takedownConfirmSec: 5,
      zeroViewerSec: 0,
      links: [],
      linkMode: 'rotate',
    });
    expect(readOptions({ options: { audience: 'practice', goLiveTimeoutSec: 30 } })).toMatchObject({ audience: 'practice', goLiveTimeoutSec: 30 });
    expect(readOptions({ options: { audience: 'nonsense', goLiveTimeoutSec: '45' } })).toMatchObject({ audience: 'public', goLiveTimeoutSec: 45 });
    expect(readOptions({ options: { goLiveTimeoutSec: 1 } }).goLiveTimeoutSec).toBe(15);
    expect(readOptions({ options: { goLiveTimeoutSec: 9999 } }).goLiveTimeoutSec).toBe(150);
    expect(readOptions({ options: { goLiveTimeoutSec: 'abc' } }).goLiveTimeoutSec).toBe(90);
  });

  it('reads the Stream Guard options with defaults and clamps', () => {
    expect(readOptions({ options: { autoRecover: false, takedownConfirmSec: 12, zeroViewerSec: 5, linkMode: 'first' } })).toMatchObject({
      autoRecover: false,
      takedownConfirmSec: 12,
      zeroViewerSec: 5,
      linkMode: 'first',
    });
    expect(readOptions({ options: { autoRecover: 'false', linkMode: 'off' } })).toMatchObject({ autoRecover: false, linkMode: 'off' });
    expect(readOptions({ options: { autoRecover: 'yes?', linkMode: 'random' } })).toMatchObject({ autoRecover: true, linkMode: 'rotate' });
    expect(readOptions({ options: { takedownConfirmSec: 1 } }).takedownConfirmSec).toBe(2);
    expect(readOptions({ options: { takedownConfirmSec: 999 } }).takedownConfirmSec).toBe(60);
    expect(readOptions({ options: { takedownConfirmSec: 'x' } }).takedownConfirmSec).toBe(5);
    expect(readOptions({ options: { zeroViewerSec: -3 } }).zeroViewerSec).toBe(0);
    expect(readOptions({ options: { zeroViewerSec: 5000 } }).zeroViewerSec).toBe(600);
    expect(readOptions({ options: { zeroViewerSec: '5' } }).zeroViewerSec).toBe(5);
  });

  it('reads the link list, skipping invalid entries', () => {
    const links = [
      { title: 'Kick - Live Stream', url: 'https://kick.com/dprtmnttoronto' },
      { title: '  Twitch   -  Live ', url: ' https://www.twitch.tv/dprtmnttoronto ' },
      { title: 'bad', url: 'javascript:alert(1)' },
      { title: 'ftp', url: 'ftp://example.com/x' },
      { title: 'spaces', url: 'https://exa mple.com' },
      { url: 'http://no-title.example/' },
      'nonsense',
      null,
      { title: 'x'.repeat(300), url: 'https://long.example/' },
    ];
    expect(readOptions({ options: { links } }).links).toEqual([
      { title: 'Kick - Live Stream', url: 'https://kick.com/dprtmnttoronto' },
      { title: 'Twitch - Live', url: 'https://www.twitch.tv/dprtmnttoronto' },
      { title: '', url: 'http://no-title.example/' },
      { title: 'x'.repeat(100), url: 'https://long.example/' },
    ]);
    expect(readLinks('not a list')).toEqual([]);
    expect(readLinks(Array.from({ length: 30 }, (_, i) => ({ title: `L${i}`, url: `https://e.example/${i}` })))).toHaveLength(20);
    expect(linkUrl('https://kick.com/x')).toBe('https://kick.com/x');
    expect(linkUrl(`https://e.example/${'a'.repeat(3000)}`)).toBeNull();
    expect(linkUrl('data:text/html,hi')).toBeNull();
  });

  it('picks the link for a live: rotate cycles, first sticks, off/empty skip', () => {
    const links = [
      { title: 'Kick', url: 'https://kick.com/a' },
      { title: 'Twitch', url: 'https://twitch.tv/a' },
    ];
    expect(pickLink(links, 'rotate', undefined)).toEqual({ link: links[0], nextIndex: 1 });
    expect(pickLink(links, 'rotate', 1)).toEqual({ link: links[1], nextIndex: 2 });
    expect(pickLink(links, 'rotate', 2)).toEqual({ link: links[0], nextIndex: 1 });
    expect(pickLink(links, 'rotate', 7)).toEqual({ link: links[1], nextIndex: 2 });
    expect(pickLink(links, 'rotate', -1)).toEqual({ link: links[1], nextIndex: 2 });
    expect(pickLink(links, 'rotate', 'junk')).toEqual({ link: links[0], nextIndex: 1 });
    expect(pickLink(links, 'first', 5)).toEqual({ link: links[0], nextIndex: null });
    expect(pickLink(links, 'off', 0)).toBeNull();
    expect(pickLink([], 'rotate', 0)).toBeNull();
  });

  it('parses viewer counts', () => {
    expect(parseViewerCount('0')).toBe(0);
    expect(parseViewerCount(' 12 ')).toBe(12);
    expect(parseViewerCount('1,234')).toBe(1234);
    expect(parseViewerCount('1.2K')).toBe(1200);
    expect(parseViewerCount('3 M')).toBe(3_000_000);
    expect(parseViewerCount('1.5')).toBeNull();
    expect(parseViewerCount('LIVE')).toBeNull();
    expect(parseViewerCount('')).toBeNull();
    expect(parseViewerCount(null)).toBeNull();
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

  it('tell an ended/removed live from a warning', () => {
    const ended = [
      'Your live video has ended',
      'Live video ended',
      'Your live video was removed because it may go against our Community Guidelines',
      'We removed your live video',
      'Your live has been taken down',
    ];
    for (const t of ended) expect([t, RE.liveEnded.test(t)]).toEqual([t, true]);
    const policy = ['Your live video violates our music guidelines', 'Live stopped: copyright claim', 'This live may go against our Community Guidelines'];
    for (const t of policy) expect([t, RE.takedownPolicy.test(t) && /\blive\b/i.test(t)]).toEqual([t, true]);

    const warning = "Your live video will be removed soon if you continue to broadcast music you don't have permission to use";
    expect(RE.takedownWarning.test(warning)).toBe(true);
    expect(RE.takedownWarning.test('Live videos that violate our guidelines may be removed')).toBe(true);
    expect(RE.takedownWarning.test('Your live video has ended')).toBe(false);
    expect(RE.liveInterrupted.test('Your live video was interrupted. Reconnecting…')).toBe(true);
    expect(RE.liveEnded.test('Your live video was interrupted')).toBe(false);

    // Producer texts that must never read as an end.
    for (const t of ['End live video?', 'Go live', 'Waiting for your stream…', 'Live producer', 'Stream setup', 'LIVE']) {
      expect([t, RE.liveEnded.test(t) || RE.takedownWarning.test(t)]).toEqual([t, false]);
    }

    // Every notice the health watcher ends a live on can also be dismissed as a leftover dialog
    // (dialog text = textContent: heading glued to the paragraph and the button labels).
    const leftover = (t: string) => LEFTOVER_DIALOG.test(t) || LEFTOVER_POLICY_NOTICE.test(t);
    const interrupted = 'Live video interruptedYour live video was interrupted because it may include music that belongs to someone else.ShareDone';
    for (const t of [...ended, ...policy, interrupted]) expect([t, leftover(t)]).toEqual([t, true]);
    // Transient warnings, policy text without "live" and long panels are not leftovers.
    for (const t of [
      'Your live video was interrupted. Reconnecting…OK',
      'Poor connection. Check your network.OK',
      'Copyright notice: this audio is protected.Done',
      `Live video${' setup details'.repeat(30)} Community Guidelines`,
    ]) {
      expect([t, leftover(t)]).toEqual([t, false]);
    }
  });

  it('find the link controls but never the stream URL, key, title or comment box', () => {
    expect(RE.addLink.test('Add link')).toBe(true);
    expect(RE.addLink.test('Link')).toBe(true);
    expect(RE.addLink.test('Copy link')).toBe(false);
    for (const t of ['URL', 'Link', 'Paste link', 'Website URL', 'https://']) expect([t, RE.linkUrl.test(t)]).toEqual([t, true]);
    for (const t of ['Stream URL', 'Server URL', 'Stream key', 'Link title', 'Add a title', 'Add a comment…', 'Link label']) {
      expect([t, RE.linkUrl.test(t)]).toEqual([t, false]);
    }
    expect(RE.linkSubmit.test('Add')).toBe(true);
    expect(RE.linkSubmit.test('Cancel')).toBe(false);
    expect(RE.leftoverDismiss.test("Don't share")).toBe(true);
    expect(RE.leftoverDismiss.test('Share')).toBe(false);
    expect(RE.leftoverDismiss.test('Delete')).toBe(false);
  });
});
