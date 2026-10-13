import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTimeout } from '../../browser/helpers.js';
import type { BrowserManager } from '../../services.js';
import { DriverError, type ChatMessageInput, type PreparedLive } from '../types.js';
import { createFacebookDriver } from './index.js';
import { DEFAULT_INGEST_URL, joinIngestUrl } from './profile-mode.js';
import { profileNameFromTitle } from './selectors.js';
import { makeAccount, makeCtx, makeDest, type FakeContext } from './test-utils.js';

const profileAccount = makeAccount({ id: 'prof1', options: { mode: 'profile' } });

describe('profile mode: destination validation', () => {
  const driver = createFacebookDriver();

  it('joins server and key with exactly one slash', () => {
    expect(joinIngestUrl('rtmps://live-api-s.facebook.com:443/rtmp/', 'FB-1-0')).toBe('rtmps://live-api-s.facebook.com:443/rtmp/FB-1-0');
    expect(joinIngestUrl('rtmps://h/rtmp//', '/k')).toBe('rtmps://h/rtmp/k');
    expect(joinIngestUrl('rtmps://h/rtmp', 'k')).toBe('rtmps://h/rtmp/k');
  });

  it('requires a persistent stream key and an RTMP(S) server', async () => {
    const ctx = makeCtx();
    const err = await driver.prepare(makeDest(), profileAccount, 'x', ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('misconfigured');
    expect((err as DriverError).message).toMatch(/Persistent stream key/);
    expect(await driver.validateDestination!(makeDest({ ingestUrl: 'https://example.com/' }), profileAccount, ctx)).toEqual([
      'Server URL must be an rtmp:// or rtmps:// URL',
      expect.stringMatching(/^Paste a persistent stream key/),
    ]);
    await ctx.destinationSecrets.set('streamKey', 'FB-123-0');
    expect(await driver.validateDestination!(makeDest(), profileAccount, ctx)).toEqual([]);
    expect(await driver.validateDestination!(makeDest({ accountId: null }), null, ctx)).toEqual([]);
  });

  it('streams to the persistent key without an account (no automation)', async () => {
    const ctx = makeCtx();
    await ctx.destinationSecrets.set('streamKey', ' FB-123-0 ');
    const prepared = await driver.prepare(makeDest({ accountId: null, ingestUrl: null, feed: 'vertical' }), null, 'Title', ctx);
    expect(prepared).toEqual({ push: { url: `${DEFAULT_INGEST_URL}FB-123-0`, mode: 'copy', feeds: ['vertical'] }, watchUrl: null });
  });

  it('starts the browser login for profile accounts', async () => {
    const start = await driver.startConnect!(profileAccount, makeCtx({ app: null }));
    expect(start).toMatchObject({ method: 'browser', startUrl: 'https://www.facebook.com/login' });
  });

  it('reads the profile name from the page title', () => {
    expect(profileNameFromTitle('(3) Jane Doe | Facebook')).toBe('Jane Doe');
    expect(profileNameFromTitle('Jane Doe')).toBe('Jane Doe');
    expect(profileNameFromTitle('Facebook')).toBeNull();
    expect(profileNameFromTitle('Log in to Facebook')).toBeNull();
    expect(profileNameFromTitle('(12+) Facebook')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Live Producer + chat against local HTML fixtures in a real Chromium
// ---------------------------------------------------------------------------

const PRODUCER_HTML = `<!doctype html><html><head><title>Live Producer | Facebook</title></head><body>
<div id="landing"><button id="create">Create live video</button></div>
<div id="setup" hidden>
  <div role="radiogroup" aria-label="Video source">
    <div role="radio" aria-checked="true" tabindex="0" id="webcam">Webcam</div>
    <div role="radio" aria-checked="false" tabindex="0" id="software">Streaming software</div>
  </div>
  <h3>Add post details</h3>
  <input id="title" aria-label="Title (optional)">
  <div id="desc" role="textbox" contenteditable="true" aria-label="Description"></div>
  <button id="golive" disabled>Go live</button>
</div>
<div id="live" hidden>
  <input id="liveTitle" aria-label="Title">
  <button id="save">Save</button>
  <button id="end">End live video</button>
  <h2>Comments</h2>
  <div id="comments">
    <div role="article" aria-label="Comment by Early Bird 5 minutes ago">
      <a role="link" href="/early"><span dir="auto">Early Bird</span></a>
      <div dir="auto">already here before chat started</div>
      <a href="/live/producer?comment_id=100">5m</a>
    </div>
  </div>
</div>
<div id="dialog" role="dialog" aria-label="End live video?" hidden><button id="confirmEnd">End</button></div>
<script>
  const $ = (id) => document.getElementById(id);
  window.events = [];
  $('create').onclick = () => { $('landing').hidden = true; $('setup').hidden = false; };
  $('software').onclick = () => {
    $('webcam').setAttribute('aria-checked', 'false');
    $('software').setAttribute('aria-checked', 'true');
    window.events.push('software');
  };
  // The stream preview "arrives" once the test calls window.streamArrived().
  window.streamArrived = () => { $('golive').disabled = false; };
  $('golive').onclick = () => {
    window.events.push('golive:' + $('title').value);
    $('setup').hidden = true; $('live').hidden = false;
  };
  $('save').onclick = () => window.events.push('save:' + $('liveTitle').value);
  $('end').onclick = () => { $('dialog').hidden = false; };
  $('confirmEnd').onclick = () => { window.events.push('ended'); $('dialog').hidden = true; $('live').hidden = true; };
</script></body></html>`;

const LOGIN_HTML = `<!doctype html><html><head><title>Log in to Facebook</title></head><body>
<form><input name="email"><input name="pass" type="password"><button>Log in</button></form></body></html>`;

function commentHtml(c: { id: string; author: string; text: string; label?: string; replyTo?: string }): string {
  const href = c.replyTo ? `/live/producer?comment_id=${c.replyTo}&reply_comment_id=${c.id}` : `/live/producer?comment_id=${c.id}`;
  return `<div role="article" aria-label="${c.label ?? `Comment by ${c.author} 1 minute ago`}">
    <a role="link" href="/u/${c.id}" aria-label="avatar"><svg width="10" height="10"></svg></a>
    <div><a role="link" href="/u/${c.id}"><span dir="auto">${c.author}</span></a></div>
    <div dir="auto" style="text-align:start"><div dir="auto">${c.text}</div></div>
    <a href="${href}">1m</a>
  </div>`;
}

/** Fake BrowserManager backed by one real Chromium context per account. */
class FixtureBrowser implements BrowserManager {
  saves = 0;
  constructor(private readonly ctx: BrowserContext) {}
  async context() {
    return this.ctx;
  }
  async page(_accountId: string, url?: string): Promise<Page> {
    const p = this.ctx.pages().find((x) => !x.isClosed()) ?? (await this.ctx.newPage());
    if (url) await p.goto(url);
    return p;
  }
  viewerPage(accountId: string, url?: string) {
    return this.page(accountId, url);
  }
  async save() {
    this.saves += 1;
  }
  async hasSavedSession() {
    return true;
  }
  async close() {}
  async clear() {}
  async shutdown() {}
}

const TIMINGS = {
  navMs: 5000,
  goLiveWaitMs: 8000,
  verifyLiveMs: 5000,
  confirmBudgetMs: 20_000,
  titleBudgetMs: 20_000,
  liveTitleMs: 15_000,
  endBudgetMs: 10_000,
  chatPanelMs: 5000,
  chatPollMs: 200,
  typingMinMs: 0,
  typingMaxMs: 3,
};

async function addSessionCookies(context: BrowserContext): Promise<void> {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  await context.addCookies([
    { name: 'c_user', value: '100000001', url: 'https://www.facebook.com', expires },
    { name: 'xs', value: 'session-secret', url: 'https://www.facebook.com', expires },
  ]);
}

async function next(it: AsyncIterator<ChatMessageInput>, ms = 6000): Promise<ChatMessageInput> {
  const r = await withTimeout(it.next(), ms, 'no chat message');
  if (r.done) throw new Error('chat ended');
  return r.value;
}

describe.skipIf(!!process.env.CI_NO_BROWSER)('profile mode in Chromium (fixtures)', () => {
  let browser: Browser;
  let server: http.Server;
  let origin = '';
  let context: BrowserContext;
  let fixtureBrowser: FixtureBrowser;
  let ctx: FakeContext;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const html = path.startsWith('/live/producer')
        ? PRODUCER_HTML
        : path === '/me'
          ? '<!doctype html><title>(2) Jane Doe | Facebook</title><p>profile</p>'
          : path === '/login-wall'
            ? LOGIN_HTML
            : '<!doctype html><title>x</title>';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  beforeEach(async () => {
    context = await browser.newContext();
    fixtureBrowser = new FixtureBrowser(context);
    ctx = makeCtx({ browser: fixtureBrowser, app: null });
  });

  afterEach(async () => {
    await context?.close();
  });

  const driverFor = (producerPath = '/live/producer', timings: Partial<typeof TIMINGS> = {}) =>
    createFacebookDriver({
      profile: { producerUrl: `${origin}${producerPath}`, profileUrl: `${origin}/me`, timings: { ...TIMINGS, ...timings } },
    });

  it('confirm gives up quietly within its budget when the preview never arrives', async () => {
    await addSessionCookies(context);
    await ctx.destinationSecrets.set('streamKey', 'FB-1-0');
    const prepared = await driverFor('/live/producer', { confirmBudgetMs: 1500 }).prepare(makeDest(), profileAccount, 'T', ctx);
    const t0 = Date.now();
    await expect(prepared.confirm!(new AbortController().signal)).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(5000);
    const page = context.pages()[0]!;
    expect(await page.evaluate('window.events')).toEqual(['software']); // never clicked "Go live"

    // An abort from the orchestrator is still reported as an abort.
    const ac = new AbortController();
    const aborted = prepared.confirm!(ac.signal);
    ac.abort();
    await expect(aborted).rejects.toBeDefined();
  });

  it('starts the live title budget only once Live Producer is free, and honors the caller signal', async () => {
    await addSessionCookies(context);
    await ctx.destinationSecrets.set('streamKey', 'FB-1-0');
    const prepared = await driverFor('/live/producer', { confirmBudgetMs: 2500, liveTitleMs: 2000 }).prepare(makeDest(), profileAccount, 'T', ctx);
    const page = context.pages()[0]!;
    // confirm holds the page for its whole budget (the preview never arrives).
    const confirming = prepared.confirm!(new AbortController().signal);
    await new Promise((r) => setTimeout(r, 100));
    const titled = prepared.setTitle!('Queued title', new AbortController().signal);
    await confirming;
    await expect(titled).resolves.toBeUndefined();
    expect(await page.inputValue('#title')).toBe('Queued title');

    const aborted = new AbortController();
    aborted.abort();
    await expect(prepared.setTitle!('Never applied', aborted.signal)).rejects.toBeDefined();
    expect(await page.inputValue('#title')).toBe('Queued title');
  });

  it('connects only with a facebook.com session and labels the account with the profile name', async () => {
    const driver = driverFor();
    const before = await driver.completeConnect!(profileAccount, {}, ctx);
    // Clicked "I'm logged in" too early: still pending, with a hint.
    expect(before).toMatchObject({ status: 'pending', message: expect.stringMatching(/logged-in session/) });
    expect(await driver.checkAccount!(profileAccount, ctx)).toMatchObject({ status: 'needs-login' });

    await addSessionCookies(context);
    const res = await driver.completeConnect!(profileAccount, {}, ctx);
    expect(res).toMatchObject({ status: 'connected', account: { label: 'Jane Doe', options: { mode: 'profile' } } });
    expect(ctx.updates.at(-1)).toMatchObject({ label: 'Jane Doe', status: 'connected' });
    expect(fixtureBrowser.saves).toBe(1);
    expect(await driver.checkAccount!(profileAccount, ctx)).toEqual({ status: 'connected' });
  });

  it('sets the title, clicks Go live once the preview arrives, updates the title, scrapes chat and ends', async () => {
    await addSessionCookies(context);
    await ctx.destinationSecrets.set('streamKey', 'FB-999-0');
    const driver = driverFor();

    const prepared: PreparedLive = await driver.prepare(makeDest(), profileAccount, 'My stream title', ctx);
    expect(prepared.push).toEqual({ url: `${DEFAULT_INGEST_URL}FB-999-0`, mode: 'copy', feeds: ['landscape'] });
    const page = context.pages()[0]!;
    expect(await page.inputValue('#title')).toBe('My stream title');
    expect(await page.evaluate('window.events')).toEqual(['software']);

    // "Go live" stays disabled until the stream preview arrives.
    const confirmed = prepared.confirm!(new AbortController().signal);
    await new Promise((r) => setTimeout(r, 500));
    expect(await page.evaluate('window.events')).toEqual(['software']);
    await page.evaluate('window.streamArrived()');
    await withTimeout(confirmed, 15_000, 'confirm did not finish');
    expect(await page.evaluate('window.events')).toEqual(['software', 'golive:My stream title']);
    expect(fixtureBrowser.saves).toBeGreaterThan(0);

    // Chat: comments present before the scraper started are skipped.
    const ac = new AbortController();
    const chat = prepared.chat!(ac.signal)[Symbol.asyncIterator]();
    const first = chat.next();
    await new Promise((r) => setTimeout(r, 700));
    await page.evaluate(
      `document.getElementById('comments').insertAdjacentHTML('beforeend', ${JSON.stringify(
        commentHtml({ id: '201', author: 'Alice Smith', text: 'Hello <b>there</b>' }) +
          '<div role="article" aria-label="Live video"><div dir="auto">not a comment</div></div>',
      )})`,
    );
    const m1 = (await withTimeout(first, 6000, 'no chat message')).value as ChatMessageInput;
    expect(m1).toMatchObject({ id: '201', author: { name: 'Alice Smith' }, text: 'Hello there', kind: 'message' });

    await page.evaluate(
      `document.getElementById('comments').insertAdjacentHTML('beforeend', ${JSON.stringify(
        commentHtml({ id: '202', author: 'Bob', text: 'parent comment' }).replace(
          /<\/div>\s*$/,
          `${commentHtml({ id: '203', author: 'Carol', text: 'a reply', label: 'Reply by Carol just now', replyTo: '202' })}</div>`,
        ),
      )})`,
    );
    const m2 = await next(chat);
    const m3 = await next(chat);
    expect([m2, m3]).toEqual([
      expect.objectContaining({ id: '202', author: { name: 'Bob' }, text: 'parent comment' }),
      expect.objectContaining({ id: '203', author: { name: 'Carol' }, text: 'a reply' }),
    ]);

    await prepared.setTitle!('Updated title');
    expect(await page.inputValue('#liveTitle')).toBe('Updated title');
    expect(await page.evaluate('window.events')).toContain('save:Updated title');

    ac.abort();
    expect((await withTimeout(chat.next(), 3000, 'chat did not stop')).done).toBe(true);

    await prepared.end!();
    expect(await page.evaluate('window.events')).toContain('ended');
  });

  it('never fails the destination when Live Producer is logged out or missing', async () => {
    await addSessionCookies(context);
    await ctx.destinationSecrets.set('streamKey', 'FB-1-0');
    // The producer URL shows a login wall: prepare and confirm only log.
    const driver = driverFor('/login-wall');
    const prepared = await driver.prepare(makeDest(), profileAccount, 'T', ctx);
    expect(prepared.push?.url).toBe(`${DEFAULT_INGEST_URL}FB-1-0`);
    await expect(prepared.confirm!(new AbortController().signal)).resolves.toBeUndefined();
    await expect(prepared.setTitle!('x')).rejects.toMatchObject({ code: 'needs-login' });

    // Chat ends quietly when there is no comments panel.
    const chat = prepared.chat!(new AbortController().signal)[Symbol.asyncIterator]();
    expect((await withTimeout(chat.next(), 10_000, 'chat did not end')).done).toBe(true);
    await expect(prepared.end!()).resolves.toBeUndefined();
  });

  it('streams anyway and flags the account when the session cookies are gone', async () => {
    await ctx.destinationSecrets.set('streamKey', 'FB-1-0');
    const prepared = await driverFor().prepare(makeDest(), profileAccount, 'T', ctx);
    expect(prepared.push?.url).toBe(`${DEFAULT_INGEST_URL}FB-1-0`);
    expect(ctx.updates).toContainEqual({ status: 'needs-login', statusMessage: 'Facebook session expired — log in again from Accounts' });
    await expect(prepared.confirm!(new AbortController().signal)).resolves.toBeUndefined();
    expect(context.pages()).toHaveLength(0); // no browser automation without a session
  });
});
