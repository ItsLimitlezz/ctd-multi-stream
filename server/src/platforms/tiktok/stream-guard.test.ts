// Stream Guard for TikTok against the LIVE Producer fixture on a real headless Chromium:
// takedown detection (banner, live-state loss, interruption toast), warnings, the viewer rule,
// the recovery policy, and prepare()/end() around a takedown.

import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveHealthEvent, PlatformDriver, PreparedLive } from '../types.js';
import { LIVE_GONE_REASON, LOGGED_OUT_WARNING, VIEWERS_UNAVAILABLE_WARNING } from './health.js';
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
  type TakedownMode,
} from './test-utils.js';
import { joinRtmpUrl } from './util.js';

const PUSH_URL = joinRtmpUrl(FIXTURE_SERVER_URL, FIXTURE_STREAM_KEY);
const VIOLATION_ENDED = 'Your LIVE was ended because it may violate our Community Guidelines.';

/** Runs a health iterator in the background, collecting its events. */
function collect(prepared: PreparedLive) {
  const ac = new AbortController();
  const events: LiveHealthEvent[] = [];
  let finished = false;
  const done = (async () => {
    for await (const event of prepared.health!(ac.signal)) events.push(event);
    finished = true;
  })();
  return {
    events,
    done,
    get finished() {
      return finished;
    },
    stop: async () => {
      ac.abort();
      await done;
    },
  };
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!!process.env.CI_NO_BROWSER)('TikTok Stream Guard against a LIVE Producer fixture (Chromium)', () => {
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
      timing: {
        detectMs: 5000,
        stepMs: 4000,
        endMs: 5000,
        settleMs: 0,
        typingDelayMs: [0, 3],
        minGoLiveTimeoutSec: 1,
        healthPollMs: 200,
        healthGraceMs: 1500,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await bm?.manager.shutdown();
    await browser?.close();
    await fixture?.close();
  });

  async function account() {
    const id = `guard-${++seq}`;
    await addSessionCookie(await bm.context(id));
    return makeAccount(id, { options: { username: FIXTURE_USERNAME }, label: `@${FIXTURE_USERNAME}` });
  }

  async function events(accountId: string): Promise<string[]> {
    return (await (await bm.page(accountId)).evaluate('window.__events || []')) as string[];
  }

  async function takedown(accountId: string, mode: TakedownMode, text = ''): Promise<void> {
    await (await bm.page(accountId)).evaluate(`window.__fixture.takedown(${JSON.stringify(mode)}, ${JSON.stringify(text)})`);
  }

  /** prepare + confirm on a fresh account. */
  async function goLive(options: Record<string, unknown> = {}) {
    const acc = await account();
    const made = makeContext(bm.manager);
    const dest = makeDestination({ accountId: acc.id, options });
    const prepared = await driver.prepare(dest, acc, 'Title', made.ctx);
    await prepared.confirm!(new AbortController().signal);
    return { acc, dest, prepared, ...made };
  }

  it('opts into recovery per the auto-recover option', async () => {
    fixture.setScenario({ cookieBanner: false, keyMode: 'password-input' });
    const cases: [Record<string, unknown>, PreparedLive['recovery']][] = [
      [{}, { pushDownConfirmMs: 5000, maxAttempts: 3 }],
      [{ takedownConfirmSec: 12 }, { pushDownConfirmMs: 12_000, maxAttempts: 3 }],
      [{ takedownConfirmSec: 1 }, { pushDownConfirmMs: 2000, maxAttempts: 3 }],
      [{ autoRecover: false }, undefined],
    ];
    for (const [options, recovery] of cases) {
      const acc = await account();
      const { ctx } = makeContext(bm.manager);
      const prepared = await driver.prepare(makeDestination({ accountId: acc.id, options }), acc, 'Title', ctx);
      expect(prepared.recovery).toEqual(recovery);
      expect(typeof prepared.health).toBe('function'); // takedowns are still reported (as an error) without recovery
      await prepared.end!();
    }
  }, 60_000);

  it('reports a takedown banner, ends harmlessly and prepares a fresh LIVE after it', async () => {
    fixture.setScenario({ cookieBanner: false, keyMode: 'password-input' });
    const { acc, dest, prepared, ctx, lines } = await goLive();
    const health = collect(prepared);
    await sleep(600);
    expect(health.events).toEqual([]);

    await takedown(acc.id, 'ended', VIOLATION_ENDED);
    await waitFor(() => health.finished, 5000, 'the health watcher to report the takedown');
    expect(health.events).toEqual([{ type: 'ended', reason: VIOLATION_ENDED }]);

    // end() of the killed LIVE: closes TikTok's dialog, nothing to end, no error.
    await expect(prepared.end!()).resolves.toBeUndefined();
    const ev = await events(acc.id);
    expect(ev).toContain('ended-dialog-ok');
    expect(ev).not.toContain('end');

    // The runner's recovery: a fresh prepare for the same destination creates a new LIVE.
    const next = await driver.prepare(dest, acc, 'Title', ctx);
    expect(next.push?.url).toBe(PUSH_URL);
    expect(await events(acc.id)).toEqual(expect.arrayContaining(['open', 'save:Title']));
    await next.confirm!(new AbortController().signal);
    expect(await events(acc.id)).toContain('golive');
    await next.end!();
    expect(await events(acc.id)).toContain('end-confirm');
    expect(lines.join('\n')).not.toContain(FIXTURE_STREAM_KEY);
  }, 60_000);

  it('reports the dashboard dropping out of the live state', async () => {
    fixture.setScenario({ cookieBanner: false, keyMode: 'password-input' });
    const { acc, prepared } = await goLive();
    const health = collect(prepared);
    await sleep(400);
    await takedown(acc.id, 'silent');
    await waitFor(() => health.finished, 5000, 'the live-state loss');
    expect(health.events).toEqual([{ type: 'ended', reason: LIVE_GONE_REASON }]);
    await expect(prepared.end!()).resolves.toBeUndefined();
  }, 30_000);

  it('reports an interruption over a running dashboard and never reuses the killed LIVE', async () => {
    fixture.setScenario({ cookieBanner: false, keyMode: 'password-input', persistLive: true });
    const { acc, dest, prepared, ctx, lines } = await goLive();
    const health = collect(prepared);
    await takedown(acc.id, 'overlay', 'Your LIVE has been interrupted for violating our Community Guidelines');
    await waitFor(() => health.finished, 5000, 'the interruption');
    expect(health.events).toEqual([
      { type: 'ended', reason: 'Your LIVE has been interrupted for violating our Community Guidelines' },
    ]);

    // TikTok still shows the LIVE as running after a reload, and the old end() never ran (e.g. the
    // runner's bound expired): the new prepare must end it and create a fresh LIVE, not reuse its key.
    const next = await driver.prepare(dest, acc, 'Title', ctx);
    expect(next.push?.url).toBe(PUSH_URL);
    expect(lines.join('\n')).toContain('Ending the TikTok LIVE that TikTok interrupted');
    expect(await events(acc.id)).toEqual(expect.arrayContaining(['open', 'save:Title']));
    await next.confirm!(new AbortController().signal);

    // The superseded LIVE's end() must not touch the new one.
    await expect(prepared.end!()).resolves.toBeUndefined();
    expect(await events(acc.id)).not.toContain('end');
    await next.end!();
    expect(await events(acc.id)).toContain('end-confirm');
  }, 60_000);

  it('never reuses a LIVE it already ended, even when TikTok still shows it running', async () => {
    // E.g. a recovery triggered by the push dying (not by health): end() ran, yet TikTok's
    // dashboard still shows the LIVE after a reload. The next prepare must not reuse its key.
    fixture.setScenario({ cookieBanner: false, keyMode: 'password-input', persistLive: true });
    const { acc, dest, prepared, ctx, lines } = await goLive();
    await prepared.end!();
    await fetch(`${fixture.origin}/fixture/live?on=1`, { method: 'POST' }); // still "running" on TikTok's side
    const next = await driver.prepare(dest, acc, 'Title', ctx);
    expect(next.push?.url).toBe(PUSH_URL);
    expect(lines.join('\n')).toContain('Ending the previous TikTok LIVE (still shown as running)');
    expect(await events(acc.id)).toEqual(expect.arrayContaining(['open', 'save:Title']));
    await next.end!();
  }, 30_000);

  it('only warns for violation warnings and never reads viewer comments as notices', async () => {
    fixture.setScenario({ cookieBanner: false, keyMode: 'password-input' });
    const { acc, prepared } = await goLive();
    const health = collect(prepared);
    const page = await bm.page(acc.id);
    await page.evaluate(`window.__fixture.comment('troll', 'LIVE ended lol, your LIVE was removed for copyright')`);
    await sleep(600);
    expect(health.events).toEqual([]);

    await takedown(acc.id, 'overlay', 'Your LIVE may violate our Community Guidelines');
    await waitFor(() => health.events.length >= 1, 3000, 'the warning');
    await page.evaluate('window.__fixture.clearToasts()');
    await waitFor(() => health.events.length >= 2, 3000, 'the warning to clear');
    await sleep(400);
    expect(health.events).toEqual([
      { type: 'warning', message: 'TikTok warning: Your LIVE may violate our Community Guidelines' },
      { type: 'ok' },
    ]);
    expect(health.finished).toBe(false);

    const t0 = Date.now();
    await health.stop();
    expect(Date.now() - t0).toBeLessThan(1500);
    await prepared.end!();
    expect(await events(acc.id)).toContain('end-confirm');
  }, 30_000);

  it('applies the 0-viewer rule after the grace period, only with auto-recover and a readable count', async () => {
    fixture.setScenario({ cookieBanner: false, keyMode: 'password-input', viewers: 0 });
    const [off, unreadable] = await Promise.all([goLive({ zeroViewerSec: 1, autoRecover: false }), goLive({ zeroViewerSec: 1 })]);
    await (await bm.page(unreadable.acc.id)).evaluate('window.__fixture.setViewers(null)');
    // The grace counts from "Go LIVE": measure from right after this LIVE's confirm.
    const rule = await goLive({ zeroViewerSec: 1 });
    const t0 = Date.now();
    const watchers = [collect(rule.prepared), collect(off.prepared), collect(unreadable.prepared)] as const;

    await waitFor(() => watchers[0].finished, 8000, 'the 0-viewer takedown');
    // Grace 1.5 s + 1 s of 0 viewers (polls every 200 ms).
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2300);
    expect(watchers[0].events).toEqual([{ type: 'ended', reason: '0 viewers for 1 s' }]);

    await sleep(Math.max(0, 3500 - (Date.now() - t0)));
    expect(watchers[1].events).toEqual([]);
    expect(watchers[2].events).toEqual([{ type: 'warning', message: VIEWERS_UNAVAILABLE_WARNING }]);
    await Promise.all([watchers[1].stop(), watchers[2].stop()]);
    await Promise.all([rule.prepared.end!(), off.prepared.end!(), unreadable.prepared.end!()]);
  }, 60_000);

  it('dismisses a leftover "LIVE ended" dialog before creating the next LIVE', async () => {
    fixture.setScenario({ cookieBanner: false, keyMode: 'password-input', endedNotice: VIOLATION_ENDED });
    const acc = await account();
    const { ctx } = makeContext(bm.manager);
    const prepared = await driver.prepare(makeDestination({ accountId: acc.id }), acc, 'Title', ctx);
    expect(prepared.push?.url).toBe(PUSH_URL);
    const ev = await events(acc.id);
    expect(ev).toEqual(expect.arrayContaining(['ended-notice-ok', 'open', 'save:Title']));
    expect(ev).not.toContain('ended-notice-share');
  }, 30_000);

  it('keeps watching when the page is navigated away or logged out', async () => {
    fixture.setScenario({ cookieBanner: false, keyMode: 'password-input', persistLive: true });
    const { acc, prepared } = await goLive();
    const health = collect(prepared);
    const page = await bm.page(acc.id);

    await page.goto(`${fixture.origin}/analytics`);
    await waitFor(() => page.url().endsWith('/producer'), 5000, 'the watcher to reopen LIVE Producer');
    await sleep(600);
    expect(health.events).toEqual([]); // the LIVE is still running there

    await page.goto(`${fixture.origin}/login`);
    await waitFor(() => health.events.length >= 1, 3000, 'the logged-out warning');
    expect(health.events[0]).toEqual({ type: 'warning', message: LOGGED_OUT_WARNING });
    await page.goto(`${fixture.origin}/producer`);
    await waitFor(() => health.events.length >= 2, 3000, 'the warning to clear');
    expect(health.events[1]).toEqual({ type: 'ok' });
    expect(health.finished).toBe(false);

    await health.stop();
    await prepared.end!();
  }, 30_000);
});
