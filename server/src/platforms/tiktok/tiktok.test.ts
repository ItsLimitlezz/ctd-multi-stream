import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTimeout } from '../../browser/helpers.js';
import { truncateTitle } from '../common/http.js';
import type { ChatMessageInput, PlatformDriver } from '../types.js';
import { createTiktokDriver } from './index.js';
import {
  addSessionCookie,
  fakeBrowserManager,
  FIXTURE_SERVER_URL,
  FIXTURE_STREAM_KEY,
  FIXTURE_USERNAME,
  makeAccount,
  makeContext,
  makeDestination,
  startFixtureServer,
  type FixtureServer,
} from './test-utils.js';
import { joinRtmpUrl } from './util.js';

const PUSH_URL = joinRtmpUrl(FIXTURE_SERVER_URL, FIXTURE_STREAM_KEY);

describe.skipIf(!!process.env.CI_NO_BROWSER)('TikTok driver against a LIVE Producer fixture (Chromium)', () => {
  let browser: Browser;
  let fixture: FixtureServer;
  let bm: ReturnType<typeof fakeBrowserManager>;
  let driver: PlatformDriver;
  let seq = 0;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    browser = await chromium.launch({ headless: true });
    bm = fakeBrowserManager(browser);
    driver = createTiktokDriver({
      urls: { producer: `${fixture.origin}/producer`, login: `${fixture.origin}/login`, home: `${fixture.origin}/` },
      timing: { detectMs: 5000, stepMs: 4000, endMs: 5000, settleMs: 0, typingDelayMs: [0, 3], minGoLiveTimeoutSec: 1 },
    });
  }, 60_000);

  afterAll(async () => {
    await bm?.manager.shutdown();
    await browser?.close();
    await fixture?.close();
  });

  async function account(opts: { loggedIn?: boolean; options?: Record<string, unknown> } = {}) {
    const id = `acc-${++seq}`;
    if (opts.loggedIn !== false) await addSessionCookie(await bm.context(id));
    return makeAccount(id, { options: opts.options ?? { username: FIXTURE_USERNAME }, label: `@${FIXTURE_USERNAME}` });
  }

  async function events(accountId: string): Promise<string[]> {
    return (await (await bm.page(accountId)).evaluate('window.__events || []')) as string[];
  }

  function expectNoSecrets(lines: string[]): void {
    const all = lines.join('\n');
    expect(all).not.toContain(FIXTURE_STREAM_KEY);
    expect(all).not.toContain('sign=');
    expect(all).not.toContain('test-session-cookie');
  }

  it('connects: needs the login cookie, reads the @username and saves the session', async () => {
    const acc = await account({ loggedIn: false, options: {} });
    const { ctx, updates } = makeContext(bm.manager);
    // Clicked "I'm logged in" too early: still pending, with a hint.
    expect(await driver.completeConnect!(acc, {}, ctx)).toMatchObject({ status: 'pending', message: expect.stringMatching(/logged in yet/) });

    await addSessionCookie(await bm.context(acc.id));
    await (await bm.page(acc.id)).goto(`${fixture.origin}/login`); // username not readable here
    const result = await driver.completeConnect!(acc, {}, ctx);
    expect(result.status).toBe('connected');
    if (result.status !== 'connected') return;
    expect(result.account.label).toBe(`@${FIXTURE_USERNAME}`);
    expect(result.account.options).toMatchObject({ username: FIXTURE_USERNAME });
    expect(updates.at(-1)).toMatchObject({ label: `@${FIXTURE_USERNAME}`, status: 'connected', statusMessage: null });
    expect(bm.saves).toContain(acc.id);
  });

  it('checkAccount reports connected, not eligible and logged out', async () => {
    const { ctx } = makeContext(bm.manager);
    expect(await driver.checkAccount!(await account({ loggedIn: false }), ctx)).toMatchObject({ status: 'needs-login' });

    fixture.setScenario({});
    expect(await driver.checkAccount!(await account(), ctx)).toEqual({ status: 'connected', label: `@${FIXTURE_USERNAME}` });

    fixture.setScenario({ initial: 'ineligible' });
    expect(await driver.checkAccount!(await account(), ctx)).toMatchObject({
      status: 'error',
      message: "Logged in, but this account doesn't have LIVE stream key access",
    });

    fixture.setScenario({ loggedOut: true });
    expect(await driver.checkAccount!(await account(), ctx)).toMatchObject({ status: 'needs-login' });
  }, 30_000);

  it('prepares, goes live, reads comments and ends the LIVE', async () => {
    fixture.setScenario({});
    const acc = await account();
    const { ctx, lines } = makeContext(bm.manager);
    const title = 'A very long stream title that is over the TikTok limit';

    const prepared = await driver.prepare(makeDestination({ accountId: acc.id }), acc, title, ctx);
    expect(prepared.push).toEqual({ url: PUSH_URL, mode: 'copy', feeds: ['vertical'] });
    expect(prepared.watchUrl).toBe(`https://www.tiktok.com/@${FIXTURE_USERNAME}/live`);
    expect(prepared.setTitle).toBeUndefined();
    let ev = await events(acc.id);
    expect(ev).toEqual(expect.arrayContaining(['cookie-decline', 'open', `save:${truncateTitle(title, 32)}`, 'reveal']));
    expect(ev).not.toContain('topic-click'); // the topic is never touched
    expect(ev).not.toContain('golive'); // going live waits for confirm()

    await prepared.confirm!(new AbortController().signal);
    ev = await events(acc.id);
    expect(ev).toEqual(expect.arrayContaining(['golive', 'golive-confirm']));

    // Checking the account during the LIVE must not reload the producer (the event log would reset).
    expect(await driver.checkAccount!(acc, ctx)).toMatchObject({ status: 'connected' });
    expect(await events(acc.id)).toContain('golive-confirm');

    // Chat: only comments that arrive after the scraper starts.
    const ac = new AbortController();
    const chat = prepared.chat!(ac.signal)[Symbol.asyncIterator]();
    const got: ChatMessageInput[] = [];
    while (got.length < 6) {
      const r = await withTimeout(chat.next(), 8000, 'no chat message');
      if (r.done) break;
      got.push(r.value);
    }
    expect(got.some((m) => m.text === 'before we started')).toBe(false);
    const messages = got.filter((m) => m.kind === 'message');
    const joins = got.filter((m) => m.kind === 'event');
    expect(messages.length).toBeGreaterThan(0);
    expect(joins.length).toBeGreaterThan(0);
    for (const m of messages) {
      const n = /^viewer(\d+)$/.exec(m.author.name)?.[1];
      expect(n).toBeDefined();
      expect(m.text).toBe(`hello ${n}`);
      expect(m.id).toBe(`m${n}`);
      expect(m.author.avatarUrl).toBe(`${fixture.origin}/a/${n}.jpg`);
    }
    expect(joins[0]).toMatchObject({ author: { name: 'TikTok' } });
    expect(joins[0]!.text).toMatch(/^viewer\d+ joined$/);
    ac.abort();
    expect((await withTimeout(chat.next(), 5000, 'chat did not stop')).done).toBe(true);

    await prepared.end!();
    ev = await events(acc.id);
    expect(ev).toEqual(expect.arrayContaining(['end', 'end-confirm']));
    await prepared.end!(); // already ended: no-op
    expect((await events(acc.id)).filter((e) => e === 'end')).toHaveLength(1);
    expectNoSecrets(lines);
  }, 60_000);

  it('fails with misconfigured when TikTok needs a topic and none is selected', async () => {
    fixture.setScenario({ topic: null });
    // A long step timeout: the error must come from TikTok's "Please select a topic" message, not
    // from waiting the step out. The bound leaves plenty of room for a slow machine.
    const slowSteps = createTiktokDriver({
      urls: { producer: `${fixture.origin}/producer`, login: `${fixture.origin}/login`, home: `${fixture.origin}/` },
      timing: { detectMs: 5000, stepMs: 30_000, endMs: 5000, settleMs: 0, typingDelayMs: [0, 3], minGoLiveTimeoutSec: 1 },
    });
    const acc = await account();
    const { ctx } = makeContext(bm.manager);
    const t0 = Date.now();
    const err = await slowSteps.prepare(makeDestination({ accountId: acc.id }), acc, 'Title', ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'DriverError', code: 'misconfigured' });
    expect((err as Error).message).toMatch(/topic/i);
    // Waiting a step out would take 15 s (Save) or 30 s (credentials); detection takes ~2 s.
    expect(Date.now() - t0).toBeLessThan(12_000);
    expect(await events(acc.id)).not.toContain('topic-click');
  }, 60_000);

  it('lets one destination at a time use an account and keeps account checks off its page', async () => {
    fixture.setScenario({ cookieBanner: false });
    const acc = await account();
    const { ctx } = makeContext(bm.manager);
    const first = await driver.prepare(makeDestination({ id: 'dest-a', accountId: acc.id }), acc, 'Title', ctx);

    const err = await driver.prepare(makeDestination({ id: 'dest-b', accountId: acc.id }), acc, 'Title', ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'DriverError', code: 'misconfigured' });
    expect((err as Error).message).toMatch(/another destination/);

    // While owned: checks don't navigate the producer page (a reload would reset the event log).
    const before = await events(acc.id);
    expect(before).toContain('reveal');
    expect(await driver.checkAccount!(acc, ctx)).toEqual({ status: 'connected', label: `@${FIXTURE_USERNAME}` });
    expect(await driver.completeConnect!(acc, {}, ctx)).toMatchObject({ status: 'connected' });
    expect(await events(acc.id)).toEqual(before);
    // Logging in again is refused, without pointing at a (non-existent) developer app.
    await expect(driver.startConnect!(acc, ctx)).rejects.toMatchObject({ code: 'platform-error' });

    await first.end!();
    const second = await driver.prepare(makeDestination({ id: 'dest-b', accountId: acc.id }), acc, 'Title', ctx);
    expect(second.push?.url).toBe(PUSH_URL);
    await second.end!();
  }, 60_000);

  it('releases the account when prepare fails', async () => {
    fixture.setScenario({ initial: 'ineligible' });
    const acc = await account();
    const { ctx } = makeContext(bm.manager);
    await expect(driver.prepare(makeDestination({ id: 'dest-a', accountId: acc.id }), acc, 'Title', ctx)).rejects.toMatchObject({
      code: 'not-eligible',
    });
    fixture.setScenario({ cookieBanner: false });
    const other = await driver.prepare(makeDestination({ id: 'dest-b', accountId: acc.id }), acc, 'Title', ctx);
    expect(other.push?.url).toBe(PUSH_URL);
    await other.end!();
  }, 60_000);

  it('picks "Streaming software" when TikTok asks for the LIVE source', async () => {
    fixture.setScenario({ sourceChoice: true, cookieBanner: false });
    const acc = await account();
    const { ctx } = makeContext(bm.manager);
    const prepared = await driver.prepare(makeDestination({ accountId: acc.id }), acc, 'Title', ctx);
    expect(prepared.push?.url).toBe(PUSH_URL);
    const ev = await events(acc.id);
    expect(ev).toContain('source-software');
    expect(ev).not.toContain('source-camera');
  }, 30_000);

  it('goes live when the credentials collapse into a preview', async () => {
    fixture.setScenario({ hideKeysOnPreview: true, goLiveDialog: false, cookieBanner: false, keyMode: 'password-input' });
    const acc = await account();
    const { ctx } = makeContext(bm.manager);
    const prepared = await driver.prepare(makeDestination({ accountId: acc.id }), acc, 'Title', ctx);
    await prepared.confirm!(new AbortController().signal);
    expect(await events(acc.id)).toContain('golive');
    await prepared.end!();
    expect(await events(acc.id)).toContain('end-confirm');
  }, 30_000);

  it('fails with not-eligible when the account has no stream key access', async () => {
    fixture.setScenario({ initial: 'ineligible' });
    const acc = await account();
    const { ctx } = makeContext(bm.manager);
    await expect(driver.prepare(makeDestination({ accountId: acc.id }), acc, 'Title', ctx)).rejects.toMatchObject({
      code: 'not-eligible',
      message: "This TikTok account doesn't have LIVE stream key access yet (TikTok requires ~1,000 followers)",
    });
  }, 30_000);

  it('fails with needs-login without a session or when TikTok redirects to the login page', async () => {
    fixture.setScenario({});
    const { ctx } = makeContext(bm.manager);
    const noCookie = await account({ loggedIn: false });
    await expect(driver.prepare(makeDestination(), noCookie, 'Title', ctx)).rejects.toMatchObject({ code: 'needs-login' });

    fixture.setScenario({ loggedOut: true });
    const expired = await account();
    await expect(driver.prepare(makeDestination(), expired, 'Title', ctx)).rejects.toMatchObject({
      code: 'needs-login',
      message: 'TikTok session expired — log in again from Accounts',
    });
  }, 30_000);

  it('reads the key from a password field and through the Copy button', async () => {
    for (const keyMode of ['password-input', 'clipboard'] as const) {
      fixture.setScenario({ keyMode, cookieBanner: false });
      const acc = await account();
      const { ctx, lines } = makeContext(bm.manager);
      const prepared = await driver.prepare(makeDestination({ accountId: acc.id }), acc, 'Short title', ctx);
      expect(prepared.push?.url).toBe(PUSH_URL);
      if (keyMode === 'clipboard') {
        expect(await events(acc.id)).toContain('copied');
        // The clipboard is cleared after reading.
        expect(await (await bm.page(acc.id)).evaluate('navigator.clipboard.readText()')).toBe('');
      }
      expectNoSecrets(lines);
    }
  }, 40_000);

  it('reuses a LIVE that is already running, and reuses a prepared draft', async () => {
    fixture.setScenario({ initial: 'live', keyMode: 'password-input' });
    const acc = await account();
    const { ctx } = makeContext(bm.manager);
    const prepared = await driver.prepare(makeDestination({ accountId: acc.id }), acc, 'Title', ctx);
    expect(prepared.push?.url).toBe(PUSH_URL);
    await prepared.confirm!(new AbortController().signal); // already live: nothing to click
    expect(await events(acc.id)).not.toContain('golive');
    await prepared.end!();
    expect(await events(acc.id)).toContain('end-confirm');

    fixture.setScenario({ initial: 'keys', keyMode: 'password-input', streamDelayMs: null });
    const acc2 = await account();
    const draft = await driver.prepare(makeDestination({ accountId: acc2.id }), acc2, 'Title', ctx);
    expect(draft.push?.url).toBe(PUSH_URL);
  }, 30_000);

  it('times out going live when TikTok never receives the video', async () => {
    fixture.setScenario({ streamDelayMs: null });
    const acc = await account();
    const { ctx } = makeContext(bm.manager);
    const dest = makeDestination({ accountId: acc.id, options: { goLiveTimeoutSec: 2 } });
    const prepared = await driver.prepare(dest, acc, 'Title', ctx);
    const t0 = Date.now();
    const err = await prepared.confirm!(new AbortController().signal).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'DriverError', code: 'timeout' });
    expect((err as Error).message).toContain("didn't receive the video within 2 s");
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(await events(acc.id)).not.toContain('golive');
    await expect(prepared.end!()).resolves.toBeUndefined(); // nothing live: no-op
  }, 30_000);

  it('stops promptly when aborted', async () => {
    fixture.setScenario({});
    const acc = await account();
    const ac = new AbortController();
    const { ctx } = makeContext(bm.manager, ac.signal);
    const t0 = Date.now();
    const p = driver.prepare(makeDestination({ accountId: acc.id }), acc, 'A title that takes a while to type', ctx);
    setTimeout(() => ac.abort(), 300);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - t0).toBeLessThan(3000);

    const confirmAc = new AbortController();
    confirmAc.abort();
    fixture.setScenario({ streamDelayMs: null });
    const acc2 = await account();
    const prepared = await driver.prepare(makeDestination({ accountId: acc2.id }), acc2, 'Title', makeContext(bm.manager).ctx);
    await expect(prepared.confirm!(confirmAc.signal)).rejects.toMatchObject({ name: 'AbortError' });
  }, 30_000);
});
