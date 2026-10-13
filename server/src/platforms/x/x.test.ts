import type { BrowserContext, Cookie } from 'playwright';
import { describe, expect, it } from 'vitest';
import { DriverError } from '../types.js';
import { createXDriver, hasAuthCookie, xDriver } from './index.js';
import { DEFAULT_TITLE, X_TITLE_MAX, xTitle } from './live.js';
import { X_URLS } from './selectors.js';
import { extractBroadcastId, handleFromHref, isLoginUrl, SESSION_EXPIRED } from './studio.js';
import { fakeBrowser, fakeCtx, xAccount, xDestination } from './test-utils.js';

const FUTURE = Date.now() / 1000 + 86_400;

function cookie(name: string, value: string, expires = FUTURE): Cookie {
  return { name, value, expires, domain: '.x.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' };
}

/** A context stub: cookies only; opening a tab fails (no browser in unit tests). */
function stubContext(cookies: Cookie[]): BrowserContext {
  return {
    cookies: async () => cookies,
    newPage: async () => {
      throw new Error('no browser in unit tests');
    },
    pages: () => [],
  } as unknown as BrowserContext;
}

function setup(opts: { cookies?: Cookie[]; streamKey?: string | null } = {}) {
  const saves: string[] = [];
  const browser = fakeBrowser(stubContext(opts.cookies ?? []), saves);
  return fakeCtx({ browser, saves, streamKey: opts.streamKey === undefined ? 'key123' : opts.streamKey });
}

describe('X pure helpers', () => {
  it('recognizes login pages on any host', () => {
    expect(isLoginUrl('https://x.com/i/flow/login')).toBe(true);
    expect(isLoginUrl('https://x.com/i/flow/login?redirect_after_login=%2Fi%2Flive-studio')).toBe(true);
    expect(isLoginUrl('https://x.com/login')).toBe(true);
    expect(isLoginUrl('http://127.0.0.1:5555/i/flow/login')).toBe(true);
    expect(isLoginUrl('https://x.com/i/live-studio')).toBe(false);
    expect(isLoginUrl('https://x.com/loginfan')).toBe(false);
    expect(isLoginUrl('not a url')).toBe(false);
  });

  it('extracts broadcast ids, preferring watch URLs', () => {
    expect(extractBroadcastId(['https://x.com/i/broadcasts/1AxRnanzLOrxl'])).toBe('1AxRnanzLOrxl');
    expect(extractBroadcastId(['https://x.com/i/live-studio/broadcasts/1OwGWzLWyBqxQ?tab=chat'])).toBe('1OwGWzLWyBqxQ');
    expect(
      extractBroadcastId(['https://x.com/i/live-studio/streams/AAAAAAAAAAAA', 'Watch: https://x.com/i/broadcasts/1BdGYqLWrlWxX']),
    ).toBe('1BdGYqLWrlWxX');
    expect(extractBroadcastId(['https://x.com/i/live-studio', 'https://x.com/home'])).toBeNull();
    expect(extractBroadcastId([])).toBeNull();
  });

  it('reads handles from profile link hrefs', () => {
    expect(handleFromHref('/jack')).toBe('jack');
    expect(handleFromHref('https://x.com/Ctd_Tester')).toBe('Ctd_Tester');
    expect(handleFromHref('/i/flow/login')).toBeNull();
    expect(handleFromHref('/way_too_long_handle_123')).toBeNull();
    expect(handleFromHref(null)).toBeNull();
  });

  it('checks the auth_token session cookie', () => {
    expect(hasAuthCookie([cookie('auth_token', 'abc')])).toBe(true);
    expect(hasAuthCookie([cookie('auth_token', 'abc', -1)])).toBe(true);
    expect(hasAuthCookie([cookie('auth_token', '')])).toBe(false);
    expect(hasAuthCookie([cookie('auth_token', 'abc', 1000)])).toBe(false);
    expect(hasAuthCookie([cookie('ct0', 'abc'), cookie('guest_id', 'v1')])).toBe(false);
  });

  it('truncates titles to the X limit with a fallback', () => {
    expect(xTitle('  Hello  ')).toBe('Hello');
    expect(xTitle('')).toBe(DEFAULT_TITLE);
    const long = '🎮'.repeat(X_TITLE_MAX + 20);
    expect([...xTitle(long)].length).toBe(X_TITLE_MAX);
  });
});

describe('xDriver info', () => {
  it('is an experimental browser driver with source URL + key fields', () => {
    const { info } = xDriver;
    expect(info.id).toBe('x');
    expect(info.feeds).toEqual(['landscape', 'vertical']);
    expect(info.defaultFeed).toBe('landscape');
    expect(info.connectMethod).toBe('browser');
    expect(info.developerApp).toBeNull();
    expect(info.titleSupport).toBe('browser');
    expect(info.chatSupport).toBe('browser');
    expect(info.keyPerSession).toBe(false);
    expect(info.experimental).toBe(true);
    expect(info.notes).toMatch(/Premium/);
    const byKey = Object.fromEntries(info.destinationFields.map((f) => [f.key, f]));
    expect(byKey.ingestUrl).toMatchObject({ target: 'ingestUrl', required: true });
    expect(byKey.streamKey).toMatchObject({ target: 'streamKey', type: 'secret', required: true });
    expect(byKey.autoGoLive).toMatchObject({ type: 'boolean', default: true });
    expect(byKey.sourceName).toMatchObject({ type: 'text', required: false });
  });

  it('starts a browser login at the X login flow', async () => {
    const { ctx } = setup();
    const start = await xDriver.startConnect!(xAccount(), ctx);
    expect(start).toMatchObject({ method: 'browser', startUrl: 'https://x.com/i/flow/login' });
  });
});

describe('xDriver connect (cookie check)', () => {
  it('refuses to connect without an auth_token cookie', async () => {
    const { ctx, updates, saves } = setup({ cookies: [cookie('guest_id', 'v1')] });
    const res = await xDriver.completeConnect!(xAccount({ status: 'pending' }), {}, ctx);
    // Clicked "I'm logged in" too early: still pending (the UI keeps the login view open).
    expect(res.status).toBe('pending');
    expect(res.status === 'pending' && res.message).toMatch(/Not logged in to X/);
    expect(updates).toEqual([]);
    expect(saves).toEqual([]);
  });

  it('connects with the session cookie even when the handle cannot be read', async () => {
    const { ctx, updates, saves } = setup({ cookies: [cookie('auth_token', 'secret')] });
    const res = await xDriver.completeConnect!(xAccount({ status: 'pending' }), {}, ctx);
    expect(res.status).toBe('connected');
    expect(saves).toEqual(['acc1']);
    expect(updates).toEqual([{ label: 'X', status: 'connected', statusMessage: null, options: {} }]);
    expect(JSON.stringify(updates)).not.toContain('secret');
  });

  it('reports needs-login on check without a session cookie', async () => {
    const { ctx } = setup({ cookies: [] });
    expect(await xDriver.checkAccount!(xAccount(), ctx)).toEqual({ status: 'needs-login', message: SESSION_EXPIRED });
  });

  it('turns an unexpected check failure into a platform error', async () => {
    const { ctx } = setup({ cookies: [cookie('auth_token', 'secret')] });
    const err = await xDriver.checkAccount!(xAccount(), ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('platform-error');
  });
});

describe('xDriver destinations', () => {
  it('validates the source URL and key', async () => {
    const { ctx } = setup();
    expect(await xDriver.validateDestination!(xDestination(), null, ctx)).toEqual([]);
    const { ctx: noKey } = setup({ streamKey: null });
    expect(await xDriver.validateDestination!(xDestination({ ingestUrl: null }), null, noKey)).toEqual([
      'Source URL is missing',
      'Stream key is missing',
    ]);
    const problems = await xDriver.validateDestination!(xDestination({ ingestUrl: 'https://studio.x.com' }), null, ctx);
    expect(problems[0]).toMatch(/^Source URL must start with rtmp/);
  });

  it('pushes to the source without an account (no go-live automation)', async () => {
    const { ctx } = setup();
    const prepared = await xDriver.prepare(xDestination({ accountId: null }), null, 'My stream', ctx);
    expect(prepared.push).toEqual({ url: 'rtmps://de.pscp.tv:443/x/key123', mode: 'copy', feeds: ['landscape'] });
    expect(prepared.confirm).toBeUndefined();
    expect(prepared.setTitle).toBeUndefined();
    expect(prepared.end).toBeUndefined();
    expect(prepared.chat).toBeUndefined();
  });

  it('skips automation when "Go live automatically" is off', async () => {
    const { ctx } = setup({ cookies: [] });
    const prepared = await xDriver.prepare(
      xDestination({ feed: 'vertical', options: { autoGoLive: false } }),
      xAccount(),
      't',
      ctx,
    );
    expect(prepared.push).toEqual({ url: 'rtmps://de.pscp.tv:443/x/key123', mode: 'copy', feeds: ['vertical'] });
    expect(prepared.confirm).toBeUndefined();
  });

  it('fails fast with needs-login when the linked account has no session', async () => {
    const { ctx, updates } = setup({ cookies: [] });
    const err = await xDriver.prepare(xDestination(), xAccount(), 't', ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('needs-login');
    expect((err as DriverError).message).toMatch(/Go live automatically/);
    expect(updates).toEqual([{ status: 'needs-login', statusMessage: SESSION_EXPIRED }]);
  });

  it('rejects a missing key as misconfigured', async () => {
    const { ctx } = setup({ streamKey: null });
    const err = await xDriver.prepare(xDestination(), null, 't', ctx).catch((e: unknown) => e);
    expect((err as DriverError).code).toBe('misconfigured');
  });

  it('returns a live with go-live, title, end and chat hooks when the account is logged in', async () => {
    const { ctx } = setup({ cookies: [cookie('auth_token', 'secret')] });
    const driver = createXDriver({ urls: X_URLS });
    const prepared = await driver.prepare(xDestination(), xAccount(), 'Title', ctx);
    expect(prepared.push?.url).toBe('rtmps://de.pscp.tv:443/x/key123');
    expect(typeof prepared.confirm).toBe('function');
    expect(typeof prepared.setTitle).toBe('function');
    expect(typeof prepared.end).toBe('function');
    expect(typeof prepared.chat).toBe('function');
    expect(prepared.watchUrl).toBeNull();
    // Not live yet: a title change is stored for the go-live step and touches no browser.
    await expect(prepared.setTitle!('Changed')).resolves.toBeUndefined();
    // Nothing was started: end() is a quiet no-op.
    await expect(prepared.end!()).resolves.toBeUndefined();
  });

  it('chat ends quietly on abort while the broadcast is unknown', async () => {
    const { ctx } = setup({ cookies: [cookie('auth_token', 'secret')] });
    const driver = createXDriver({ timings: { chatWaitMs: 50 } });
    const prepared = await driver.prepare(xDestination(), xAccount(), 'Title', ctx);
    const ac = new AbortController();
    const it = prepared.chat!(ac.signal)[Symbol.asyncIterator]();
    const next = it.next();
    setTimeout(() => ac.abort(), 120);
    await expect(next).resolves.toEqual({ done: true, value: undefined });
  });
});
