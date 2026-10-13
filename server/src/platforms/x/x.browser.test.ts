// X driver flows against local HTML fixtures that mimic Live Studio, X home and a broadcast page,
// in a real headless Chromium. Skipped when CI_NO_BROWSER is set.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessageInput, PlatformDriver } from '../types.js';
import { DriverError } from '../types.js';
import { createXDriver } from './index.js';
import type { XUrls } from './selectors.js';
import type { XTimings } from './studio.js';
import { fakeBrowser, fakeCtx, xAccount, xDestination } from './test-utils.js';

const BROADCAST_ID = '1AxRnanzLOrxl';

interface Action {
  type: string;
  title?: string;
  source?: string;
  at: number;
}

interface ServerState {
  sourceActive: boolean;
  actions: Action[];
  chat: { author: string; text: string }[];
  /** Messages already on the broadcast page when it loads. */
  chatInitial: number;
}

const STUDIO_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Live Studio</title></head><body>
<main id="app"></main>
<script>
const app = document.getElementById('app');
const post = (body) => fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
function dialog(question, confirmLabel, onConfirm) {
  const d = document.createElement('div');
  d.setAttribute('role', 'dialog');
  d.setAttribute('aria-label', question);
  d.innerHTML = '<p></p><button class="ok"></button><button class="cancel">Cancel</button>';
  d.querySelector('p').textContent = question;
  d.querySelector('.ok').textContent = confirmLabel;
  d.querySelector('.cancel').onclick = () => d.remove();
  d.querySelector('.ok').onclick = async () => { await onConfirm(); d.remove(); };
  document.body.appendChild(d);
}
const params = new URLSearchParams(location.search);
function enableWhenActive(go) {
  return setInterval(async () => {
    try { go.disabled = !(await (await fetch('/api/source')).json()).active; } catch (e) {}
  }, 150);
}
function home() {
  app.innerHTML = '<h1>Live Studio</h1><h2>Live now</h2><p>No livestreams</p><button id="new">New Livestream</button>';
  document.getElementById('new').onclick = params.has('wizard') ? wizard : form;
}
// Variant: three steps with "Next", "Go live" only on the last one, no confirmation dialog.
function wizard() {
  app.innerHTML = '<h1>New livestream</h1>' +
    '<section id="s1"><label for="t">Title</label><input id="t">' +
    '<label for="s">Source</label><select id="s"><option>Backup encoder</option><option>OBS main</option></select>' +
    '<button data-next="s2">Next</button></section>' +
    '<section id="s2" hidden><h2>Audience</h2><label><input type="radio" name="aud" checked> Everyone</label>' +
    '<button data-next="s3">Next</button></section>' +
    '<section id="s3" hidden><h2>Post</h2><label for="p">Post text</label><textarea id="p"></textarea>' +
    '<button id="go" disabled>Go live</button></section>';
  for (const b of app.querySelectorAll('[data-next]')) {
    b.onclick = () => { b.parentElement.hidden = true; document.getElementById(b.dataset.next).hidden = false; };
  }
  const go = document.getElementById('go');
  const poll = enableWhenActive(go);
  go.onclick = async () => {
    clearInterval(poll);
    await post({ type: 'go-live', title: document.getElementById('t').value, source: document.getElementById('s').value, wizard: true });
    history.pushState({}, '', '/i/live-studio/broadcasts/${BROADCAST_ID}');
    details();
  };
}
function form() {
  app.innerHTML = '<h1>New livestream</h1>' +
    '<label for="t">Title</label><input id="t" value="">' +
    '<label for="s">Source</label><select id="s"><option>Backup encoder</option><option>OBS main</option></select>' +
    '<div role="radiogroup" aria-label="Start"><label><input type="radio" name="when" checked> Now</label><label><input type="radio" name="when"> Later</label></div>' +
    '<button id="go" disabled>Go live</button>';
  const go = document.getElementById('go');
  const poll = enableWhenActive(go);
  go.onclick = () => dialog('Go live now?', 'Go live', async () => {
    clearInterval(poll);
    await post({ type: 'go-live', title: document.getElementById('t').value, source: document.getElementById('s').value });
    // Variant: a live UI the driver doesn't recognize (no live marker, no broadcast link).
    if (params.has('quiet')) { app.innerHTML = '<p>Streaming to X</p>'; return; }
    // Variant: X takes a while to show the running livestream.
    if (params.has('slow')) { app.innerHTML = '<p>Starting your livestream</p>'; setTimeout(details, 1000); return; }
    history.pushState({}, '', '/i/live-studio/broadcasts/${BROADCAST_ID}');
    details();
  });
}
function details() {
  app.innerHTML = '<h1>Livestream details</h1><p>You\\'re live</p>' +
    '<a href="https://x.com/i/broadcasts/${BROADCAST_ID}">Watch on X</a>' +
    '<button id="edit">Edit</button>' +
    '<div id="editor" hidden><label for="et">Title</label><input id="et"><button id="save">Save</button></div>' +
    '<button id="end">End livestream</button>';
  document.getElementById('edit').onclick = () => { document.getElementById('editor').hidden = false; };
  document.getElementById('save').onclick = async () => {
    await post({ type: 'title', title: document.getElementById('et').value });
    document.getElementById('editor').hidden = true;
  };
  document.getElementById('end').onclick = () => dialog('End livestream?', 'End livestream', async () => {
    await post({ type: 'end' });
    app.innerHTML = '<p>Livestream ended</p>';
  });
}
if (location.pathname.startsWith('/upsell')) app.innerHTML = '<p>Subscribe to Premium to use Live Studio</p>';
else if (/\\/broadcasts\\//.test(location.pathname)) details();
else home();
</script></body></html>`;

function chatRow(origin: string, m: { author: string; text: string }): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return (
    `<div data-testid="chatMessage"><img src="${origin}/avatar.png" alt="">` +
    `<div><span data-testid="chatUserName">${esc(m.author)}</span><span>@handle</span></div>` +
    `<div data-testid="chatMessageText">${esc(m.text)}</div></div>`
  );
}

function broadcastHtml(origin: string, state: ServerState): string {
  const initial = state.chat.slice(0, state.chatInitial).map((m) => chatRow(origin, m)).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Broadcast</title></head><body>
<section aria-label="Chat"><div role="log" id="log">${initial}</div></section>
<script>
let n = ${state.chatInitial};
const esc = (s) => s.replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
async function tick() {
  try {
    const list = await (await fetch('/api/chat?since=' + n)).json();
    for (const m of list) {
      n++;
      const row = document.createElement('div');
      row.innerHTML = ${JSON.stringify(chatRow(origin, { author: '__A__', text: '__T__' }))}.replace('__A__', esc(m.author)).replace('__T__', esc(m.text));
      document.getElementById('log').appendChild(row.firstChild);
    }
  } catch (e) {}
}
setInterval(tick, 150);
</script></body></html>`;
}

const HOME_HTML = `<!doctype html><html><body><nav><a data-testid="AppTabBar_Profile_Link" href="/ctd_tester">Profile</a></nav></body></html>`;
const LOGIN_HTML = `<!doctype html><html><body><h1>Sign in to X</h1><input autocomplete="username" name="text"></body></html>`;

const FAST: Partial<XTimings> = {
  navMs: 10_000,
  stepMs: 8_000,
  goLiveMs: 20_000,
  assumeLiveMs: 2_000,
  editMs: 15_000,
  endMs: 15_000,
  handleMs: 8_000,
  chatWaitMs: 200,
  typeMinMs: 0,
  typeMaxMs: 5,
};

async function nextMessage(it: AsyncIterator<ChatMessageInput>, ms = 10_000): Promise<ChatMessageInput> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no chat message')), ms));
  const r = await Promise.race([it.next(), timeout]);
  if (r.done) throw new Error('chat ended');
  return r.value;
}

describe.skipIf(!!process.env.CI_NO_BROWSER)('X driver flows (Chromium + fixtures)', () => {
  let browser: Browser;
  let server: http.Server;
  let origin = '';
  let state: ServerState;
  let context: BrowserContext;

  const urls = (): Partial<XUrls> => ({
    home: `${origin}/home`,
    liveStudio: `${origin}/i/live-studio`,
    login: `${origin}/i/flow/login`,
    broadcast: (id) => `${origin}/i/broadcasts/${id}`,
  });

  function driver(extra: Partial<XUrls> = {}, timings: Partial<XTimings> = {}): PlatformDriver {
    return createXDriver({ urls: { ...urls(), ...extra }, timings: { ...FAST, ...timings } });
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const send = (status: number, type: string, body: string) => {
        res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(body);
      };
      if (url.pathname === '/api/action' && req.method === 'POST') {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          state.actions.push({ ...(JSON.parse(body) as Omit<Action, 'at'>), at: Date.now() });
          send(200, 'application/json', '{}');
        });
        return;
      }
      if (url.pathname === '/api/source') return send(200, 'application/json', JSON.stringify({ active: state.sourceActive }));
      if (url.pathname === '/api/chat') {
        return send(200, 'application/json', JSON.stringify(state.chat.slice(Number(url.searchParams.get('since') ?? 0))));
      }
      if (url.pathname === '/home') return send(200, 'text/html', HOME_HTML);
      if (url.pathname === '/i/flow/login') return send(200, 'text/html', LOGIN_HTML);
      if (url.pathname === '/expired-studio') {
        res.writeHead(302, { location: '/i/flow/login?redirect_after_login=%2Fi%2Flive-studio' });
        return res.end();
      }
      if (url.pathname.startsWith('/i/broadcasts/')) return send(200, 'text/html', broadcastHtml(origin, state));
      if (url.pathname.startsWith('/i/live-studio') || url.pathname.startsWith('/upsell')) {
        return send(200, 'text/html', STUDIO_HTML);
      }
      send(404, 'text/plain', 'not found');
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
    state = { sourceActive: false, actions: [], chat: [], chatInitial: 0 };
    await context?.close().catch(() => {});
    context = await browser.newContext();
    await context.addCookies([{ name: 'auth_token', value: 'fixture-session', domain: '.x.com', path: '/', secure: true, httpOnly: true }]);
  });

  it('completeConnect reads the @handle and saves the session', async () => {
    const saves: string[] = [];
    const { ctx, updates } = fakeCtx({ browser: fakeBrowser(context, saves) });
    const res = await driver().completeConnect!(xAccount({ status: 'pending' }), {}, ctx);
    expect(res.status).toBe('connected');
    expect(updates).toEqual([{ label: '@ctd_tester', status: 'connected', statusMessage: null, options: { handle: 'ctd_tester' } }]);
    expect(saves).toEqual(['acc1']);
    expect(context.pages()).toHaveLength(0); // the temporary tab was closed
  });

  it('checkAccount verifies the session and Live Studio', async () => {
    const { ctx } = fakeCtx({ browser: fakeBrowser(context) });
    expect(await driver().checkAccount!(xAccount(), ctx)).toEqual({ status: 'connected', label: '@ctd_tester' });
    const upsell = await driver({ liveStudio: `${origin}/upsell-studio` }).checkAccount!(xAccount(), ctx);
    expect(upsell.status).toBe('connected');
    expect(upsell.message).toMatch(/Premium/);
  });

  it('goes live once X receives video, edits the title, scrapes chat and ends', async () => {
    const saves: string[] = [];
    const { ctx, updates } = fakeCtx({ browser: fakeBrowser(context, saves), streamKey: 'src-key' });
    const dest = xDestination({ options: { autoGoLive: true, sourceName: 'obs main' } });
    const prepared = await driver().prepare(dest, xAccount(), 'Friday stream', ctx);
    expect(prepared.push).toEqual({ url: 'rtmps://de.pscp.tv:443/x/src-key', mode: 'copy', feeds: ['landscape'] });
    expect(prepared.watchUrl).toBeNull();

    const confirmAc = new AbortController();
    const confirming = prepared.confirm!(confirmAc.signal);
    // "Go live" stays disabled until the source receives video: nothing may be clicked before.
    await new Promise((r) => setTimeout(r, 2500));
    expect(state.actions).toEqual([]);
    const activatedAt = Date.now();
    state.sourceActive = true;
    await confirming;

    const goLive = state.actions.filter((a) => a.type === 'go-live');
    expect(goLive).toHaveLength(1);
    expect(goLive[0]).toMatchObject({ title: 'Friday stream', source: 'OBS main' });
    expect(goLive[0]!.at).toBeGreaterThanOrEqual(activatedAt);
    expect(prepared.watchUrl).toBe(`${origin}/i/broadcasts/${BROADCAST_ID}`);
    expect(saves).toContain('acc1');
    expect(updates).toContainEqual({ status: 'connected', statusMessage: null });

    // Live title edit.
    await prepared.setTitle!('New title ✓');
    expect(state.actions.filter((a) => a.type === 'title')).toEqual([expect.objectContaining({ title: 'New title ✓' })]);
    // Same title again: nothing to do.
    await prepared.setTitle!('New title ✓');
    expect(state.actions.filter((a) => a.type === 'title')).toHaveLength(1);

    // Chat: only messages posted after the scraper started are yielded.
    state.chat = [{ author: 'early bird', text: 'already here' }];
    state.chatInitial = 1;
    const chatAc = new AbortController();
    const chat = prepared.chat!(chatAc.signal)[Symbol.asyncIterator]();
    const first = nextMessage(chat, 15_000);
    await new Promise((r) => setTimeout(r, 2500));
    state.chat.push({ author: 'Viewer One', text: 'hello <from> X' });
    const m1 = await first;
    expect(m1.author.name).toBe('Viewer One');
    expect(m1.text).toBe('hello <from> X');
    expect(m1.author.avatarUrl).toBe(`${origin}/avatar.png`);
    expect(m1.kind).toBe('message');
    state.chat.push({ author: 'Viewer Two', text: 'second' });
    expect((await nextMessage(chat)).text).toBe('second');
    chatAc.abort();
    const done = await Promise.race([chat.next(), new Promise((r) => setTimeout(() => r('stuck'), 5000))]);
    expect(done).toEqual({ done: true, value: undefined });

    // End: presses "End livestream" and confirms; idempotent.
    await prepared.end!();
    expect(state.actions.filter((a) => a.type === 'end')).toHaveLength(1);
    await prepared.end!();
    expect(state.actions.filter((a) => a.type === 'end')).toHaveLength(1);
    expect(context.pages().filter((p) => !p.isClosed())).toHaveLength(0);
  }, 90_000);

  it('reports a Go live button that never turns on (no video on the source)', async () => {
    const { ctx, updates } = fakeCtx({ browser: fakeBrowser(context), streamKey: 'k' });
    const prepared = await driver({}, { goLiveMs: 4000 }).prepare(xDestination(), xAccount(), 'Title', ctx);
    const err = await prepared.confirm!(new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('timeout');
    expect((err as DriverError).message).toMatch(/never became active/);
    expect((err as DriverError).message).toMatch(/Go live automatically/);
    expect(state.actions).toEqual([]);
    expect(updates.at(-1)?.statusMessage).toMatch(/^Last go-live failed/);
    expect(context.pages().filter((p) => !p.isClosed())).toHaveLength(0);
  }, 30_000);

  it('walks a multi-step form ("Next") before pressing Go live', async () => {
    state.sourceActive = true;
    const { ctx } = fakeCtx({ browser: fakeBrowser(context), streamKey: 'k' });
    const prepared = await driver({ liveStudio: `${origin}/i/live-studio?wizard=1` }).prepare(
      xDestination(),
      xAccount(),
      'Wizard title',
      ctx,
    );
    await prepared.confirm!(new AbortController().signal);
    expect(state.actions).toEqual([
      expect.objectContaining({ type: 'go-live', title: 'Wizard title', source: 'Backup encoder', wizard: true }),
    ]);
    expect(prepared.watchUrl).toBe(`${origin}/i/broadcasts/${BROADCAST_ID}`);
    await prepared.end!();
    expect(state.actions.map((a) => a.type)).toEqual(['go-live', 'end']);
  }, 30_000);

  it('assumes the livestream started when "Go live" goes away without a known live marker', async () => {
    state.sourceActive = true;
    const { ctx, updates } = fakeCtx({ browser: fakeBrowser(context), streamKey: 'k' });
    const prepared = await driver({ liveStudio: `${origin}/i/live-studio?quiet=1` }).prepare(xDestination(), xAccount(), 'T', ctx);
    await prepared.confirm!(new AbortController().signal);
    expect(state.actions.map((a) => a.type)).toEqual(['go-live']);
    expect(prepared.watchUrl).toBeNull();
    // No "End livestream" button to press: end() logs and returns, never throws.
    await expect(prepared.end!()).resolves.toBeUndefined();
    expect(state.actions.map((a) => a.type)).toEqual(['go-live']);
    expect(updates.every((u) => u.status !== 'needs-login')).toBe(true);
  }, 40_000);

  it('still ends the livestream when the go-live is aborted after "Go live" was pressed', async () => {
    state.sourceActive = true;
    const { ctx } = fakeCtx({ browser: fakeBrowser(context), streamKey: 'k' });
    const prepared = await driver({ liveStudio: `${origin}/i/live-studio?slow=1` }).prepare(xDestination(), xAccount(), 'T', ctx);
    const ac = new AbortController();
    const confirming = prepared.confirm!(ac.signal).catch((e: unknown) => e);
    const deadline = Date.now() + 15_000;
    while (!state.actions.some((a) => a.type === 'go-live') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(state.actions.map((a) => a.type)).toEqual(['go-live']);
    ac.abort();
    expect(((await confirming) as Error).name).toBe('AbortError');
    expect(prepared.watchUrl).toBeNull();

    await prepared.end!();
    expect(state.actions.map((a) => a.type)).toEqual(['go-live', 'end']);
    expect(context.pages().filter((p) => !p.isClosed())).toHaveLength(0);
  }, 40_000);

  it('maps an upsell page to not-eligible', async () => {
    const { ctx } = fakeCtx({ browser: fakeBrowser(context), streamKey: 'k' });
    const prepared = await driver({ liveStudio: `${origin}/upsell-studio` }).prepare(xDestination(), xAccount(), 'T', ctx);
    const err = await prepared.confirm!(new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('not-eligible');
  }, 30_000);

  it('maps a redirect to the login page to needs-login', async () => {
    const { ctx, updates } = fakeCtx({ browser: fakeBrowser(context), streamKey: 'k' });
    const prepared = await driver({ liveStudio: `${origin}/expired-studio` }).prepare(xDestination(), xAccount(), 'T', ctx);
    const err = await prepared.confirm!(new AbortController().signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('needs-login');
    expect(updates).toContainEqual(expect.objectContaining({ status: 'needs-login' }));
  }, 30_000);

  it('stops promptly when the go-live is aborted', async () => {
    const { ctx } = fakeCtx({ browser: fakeBrowser(context), streamKey: 'k' });
    const prepared = await driver().prepare(xDestination(), xAccount(), 'T', ctx);
    const ac = new AbortController();
    const confirming = prepared.confirm!(ac.signal).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 1500));
    const t0 = Date.now();
    ac.abort();
    const err = await confirming;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect((err as Error).name).toBe('AbortError');
    await prepared.end!();
    expect(state.actions).toEqual([]);
  }, 30_000);
});
