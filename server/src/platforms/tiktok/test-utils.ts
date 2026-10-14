// Test helpers for the TikTok driver: a local LIVE Producer look-alike, a fake BrowserManager on a
// real Chromium, and a DriverContext with in-memory secrets. Not part of the build.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import type { Browser, BrowserContext, Page } from 'playwright';
import type { Account, AccountStatus, Destination } from '../../../../shared/types.js';
import type { BrowserManager, ScopedSecrets } from '../../services.js';
import type { DriverContext } from '../types.js';

export const FIXTURE_SERVER_URL = 'rtmp://push-rtmp-test.tiktokcdn.com/game/';
export const FIXTURE_STREAM_KEY = 'stream-7712345678901?expire=1760000000&sign=0123abcdef';
export const FIXTURE_USERNAME = 'ctd_tester';

export interface ProducerScenario {
  /** What the producer shows on load. */
  initial: 'start' | 'keys' | 'live' | 'ineligible';
  /** Redirect /producer to /login. */
  loggedOut: boolean;
  /** Selected topic; null = "Select a topic" and saving is blocked. */
  topic: string | null;
  /** How the key is shown: masked text + show button, a password input, or masked with only Copy. */
  keyMode: 'masked-reveal' | 'password-input' | 'clipboard';
  /** Delay after the credentials appear until the "stream" is received; null = never. */
  streamDelayMs: number | null;
  /** "Go LIVE" opens a confirmation dialog. */
  goLiveDialog: boolean;
  /** After saving, TikTok asks for the LIVE source; the key shows once "Streaming software" is picked. */
  sourceChoice: boolean;
  /** Once video arrives, the credentials collapse and only a <video> preview + "Go LIVE" remain. */
  hideKeysOnPreview: boolean;
  cookieBanner: boolean;
  chatIntervalMs: number;
  /** Current viewers shown while LIVE ("Viewers" stat); null = no such stat (unreadable). */
  viewers: number | null;
  /** The server remembers a running LIVE across reloads (like TikTok): go LIVE / end / takedown update it. */
  persistLive: boolean;
  /** On load, a full-screen "LIVE ended" modal (OK / Share) left over from a LIVE TikTok killed. */
  endedNotice: string | null;
}

export const DEFAULT_SCENARIO: ProducerScenario = {
  initial: 'start',
  loggedOut: false,
  topic: 'Gaming',
  keyMode: 'masked-reveal',
  streamDelayMs: 800,
  goLiveDialog: true,
  sourceChoice: false,
  hideKeysOnPreview: false,
  cookieBanner: true,
  chatIntervalMs: 250,
  viewers: 3,
  persistLive: false,
  endedNotice: null,
};

/**
 * How the fixture simulates TikTok ending a LIVE (window.__fixture.takedown(mode, text)):
 * - 'ended': back to the start page with "Your LIVE has ended" plus a dialog showing `text`.
 * - 'silent': back to the start page, no notice at all.
 * - 'overlay': the dashboard stays ("End LIVE" still shown) with a role=alert toast showing `text`.
 */
export type TakedownMode = 'ended' | 'silent' | 'overlay';

const PRODUCER_SCRIPT = `(() => {
  const S = window.SCENARIO;
  const SERVER = S.serverUrl, KEY = S.streamKey;
  const app = document.getElementById('app');
  const dialogs = document.getElementById('dialogs');
  const events = (window.__events = []);
  let state = S.initial;
  let title = 'Old title from the last LIVE';
  let streamReceived = false;
  let softwareChosen = !S.sourceChoice;
  let chatTimer = null;
  let n = 0;
  let viewers = S.viewers;

  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const on = (id, fn) => { const node = document.getElementById(id); if (node) node.addEventListener('click', fn); };
  // With persistLive the server remembers the LIVE across reloads; the page changes state once it did.
  const persist = (live) => S.persistLive
    ? fetch('/fixture/live?on=' + (live ? '1' : '0'), { method: 'POST' }).then(() => {}, () => {})
    : Promise.resolve();
  const toLive = () => persist(true).then(() => { state = 'live'; render(); });
  const toEnded = (next) => { clearInterval(chatTimer); return persist(false).then(() => { state = next; render(); }); };

  window.__fixture = {
    state: () => state,
    takedown(mode, text) {
      events.push('takedown:' + mode);
      if (mode === 'overlay') {
        document.body.appendChild(el('<div role="alert" class="toast">' + text + '</div>'));
        return Promise.resolve();
      }
      return toEnded(mode === 'ended' ? 'ended' : 'start').then(() => {
        if (mode !== 'ended') return;
        dialogs.appendChild(el('<div role="dialog" aria-label="LIVE ended"><h2>LIVE ended</h2><p>' + text + '</p>' +
          '<button id="ended-dialog-ok">OK</button></div>'));
        on('ended-dialog-ok', () => { events.push('ended-dialog-ok'); document.getElementById('ended-dialog-ok').parentElement.remove(); });
      });
    },
    clearToasts() { for (const t of document.querySelectorAll('.toast')) t.remove(); },
    setViewers(v) { viewers = v; if (state === 'live') renderStats(); },
    comment(author, text) {
      const list = document.getElementById('comments');
      if (list) list.appendChild(el('<div data-e2e="chat-message"><span data-e2e="message-owner-name">' + author + '</span>' +
        '<div class="comment-text">' + text + '</div></div>'));
    },
  };

  function statsHtml() {
    return (viewers === null ? '' : '<div class="stat"><span>Viewers</span><strong>' + viewers + '</strong></div>') +
      '<div class="stat"><span>Total viewers</span><strong>57</strong></div><div class="stat"><span>Likes</span><strong>1.2K</strong></div>';
  }
  function renderStats() { const s = document.getElementById('stats'); if (s) s.innerHTML = statsHtml(); }

  if (S.endedNotice) {
    const modal = el('<div id="ended-backdrop" style="position:fixed;inset:0;z-index:20;background:rgba(0,0,0,.3)">' +
      '<div role="dialog" aria-modal="true" aria-label="LIVE ended" style="position:absolute;left:30%;top:30%;background:#fff;padding:8px">' +
      '<p>' + S.endedNotice + '</p><button id="notice-share">Share</button><button id="notice-ok">OK</button></div></div>');
    document.body.appendChild(modal);
    on('notice-ok', () => { events.push('ended-notice-ok'); modal.remove(); });
    on('notice-share', () => events.push('ended-notice-share'));
  }

  if (S.cookieBanner) {
    const banner = el('<div id="cookie" role="dialog" aria-label="Cookies"><p>We use cookies.</p>' +
      '<button id="cookie-decline">Decline optional cookies</button><button id="cookie-allow">Allow all</button></div>');
    document.body.appendChild(banner);
    on('cookie-decline', () => { events.push('cookie-decline'); banner.remove(); });
    on('cookie-allow', () => { events.push('cookie-allow'); banner.remove(); });
  }

  function keysSection() {
    let key;
    if (S.keyMode === 'password-input') key = '<input id="key" type="password" readonly value="' + KEY + '">';
    else if (S.keyMode === 'masked-reveal') key = '<span id="key">\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022</span><button id="reveal" aria-label="Show stream key"><svg width="10" height="10"></svg></button>';
    else key = '<span id="key">\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022</span>';
    return '<section id="ingest"><p>Never share your stream key with anyone.</p>' +
      '<div class="row"><div class="label">Server URL</div><div class="value"><input id="server" readonly value="' + SERVER + '"></div><button>Copy</button></div>' +
      '<div class="row"><div class="label">Stream key</div><div class="value">' + key + '</div><button id="copy-key">Copy</button></div>' +
      '</section>';
  }

  function wireKeys() {
    on('reveal', () => { document.getElementById('key').textContent = KEY; events.push('reveal'); });
    on('copy-key', () => {
      navigator.clipboard.writeText(KEY).then(() => events.push('copied'), () => events.push('copy-failed'));
    });
  }

  function startChat() {
    clearInterval(chatTimer);
    chatTimer = setInterval(() => {
      const list = document.getElementById('comments');
      if (!list) return;
      n += 1;
      if (n % 3 === 0) {
        list.appendChild(el('<div data-e2e="social-message">viewer' + n + ' joined</div>'));
      } else {
        list.appendChild(el('<div data-e2e="chat-message" data-id="m' + n + '"><img src="/a/' + n + '.jpg" alt="">' +
          '<div class="DivChatMessageContent"><span data-e2e="message-owner-name">viewer' + n + '</span>' +
          '<div class="comment-text">hello ' + n + '</div></div></div>'));
      }
    }, S.chatIntervalMs);
  }

  function render() {
    dialogs.innerHTML = '';
    if (state === 'ineligible') {
      app.innerHTML = '<h1>LIVE Producer</h1><p>You are not eligible to use LIVE Producer yet. You need at least 1,000 followers.</p>';
      return;
    }
    if (state === 'start' || state === 'ended') {
      app.innerHTML = (state === 'ended' ? '<p>Your LIVE has ended</p>' : '') + '<h1>LIVE Producer</h1><button id="open">Go LIVE</button>';
      on('open', () => { events.push('open'); state = 'form'; render(); });
      return;
    }
    if (state === 'form') {
      app.innerHTML = '<h1>LIVE Producer</h1><button id="open">Go LIVE</button>';
      const dlg = el('<div role="dialog" aria-label="LIVE settings"><h2>LIVE settings</h2>' +
        '<label>Title <input id="title" maxlength="32" placeholder="Add a title"></label>' +
        '<div class="field"><span>Topic</span><div role="combobox" id="topic">' + (S.topic || 'Select a topic') + '</div></div>' +
        '<p id="err" style="display:none">Please select a topic</p>' +
        '<button id="save">Save &amp; Go LIVE</button></div>');
      dialogs.appendChild(dlg);
      const input = document.getElementById('title');
      input.value = title;
      document.getElementById('topic').addEventListener('click', () => events.push('topic-click'));
      on('save', () => {
        title = input.value;
        events.push('save:' + title);
        if (!S.topic) { document.getElementById('err').style.display = 'block'; return; }
        state = 'keys';
        render();
        if (S.streamDelayMs !== null) {
          setTimeout(() => { streamReceived = true; if (state === 'keys') render(); }, S.streamDelayMs);
        }
      });
      return;
    }
    if (state === 'keys' && !softwareChosen) {
      app.innerHTML = '<h1>LIVE Producer</h1><p>How do you want to go LIVE?</p><div role="radiogroup" aria-label="LIVE source">' +
        '<div role="radio" aria-checked="true" tabindex="0" id="src-camera">Mobile camera</div>' +
        '<div role="radio" aria-checked="false" tabindex="0" id="src-software">Streaming software</div></div>';
      on('src-camera', () => events.push('source-camera'));
      on('src-software', () => { events.push('source-software'); softwareChosen = true; render(); });
      return;
    }
    if (state === 'keys') {
      app.innerHTML = '<h1>LIVE Producer</h1><div id="preview">' + (streamReceived ? 'Preview' : 'Waiting for stream...') + '</div>' +
        '<button id="golive"' + (streamReceived ? '' : ' disabled') + '>Go LIVE</button>' +
        (streamReceived && S.hideKeysOnPreview ? '<video width="160" height="90"></video>' : keysSection());
      wireKeys();
      on('golive', () => {
        events.push('golive');
        if (!S.goLiveDialog) { toLive(); return; }
        const d = el('<div role="dialog" aria-label="Go LIVE?"><p>Ready to go LIVE?</p>' +
          '<button id="cancel-go">Cancel</button><button id="confirm-go">Go LIVE</button></div>');
        dialogs.appendChild(d);
        on('confirm-go', () => { events.push('golive-confirm'); toLive(); });
        on('cancel-go', () => d.remove());
      });
      return;
    }
    if (state === 'live') {
      app.innerHTML = '<h1>LIVE Producer</h1><span>LIVE</span><button id="end">End LIVE</button>' +
        '<div id="stats">' + statsHtml() + '</div>' + keysSection() +
        '<div id="comments"><div data-e2e="chat-message" data-id="m0"><span data-e2e="message-owner-name">early</span>' +
        '<div class="comment-text">before we started</div></div></div>';
      wireKeys();
      on('end', () => {
        events.push('end');
        const d = el('<div role="dialog" aria-label="End LIVE?"><p>End LIVE?</p>' +
          '<button id="cancel-end">Cancel</button><button id="confirm-end">End</button></div>');
        dialogs.appendChild(d);
        on('confirm-end', () => { events.push('end-confirm'); toEnded('ended'); });
        on('cancel-end', () => d.remove());
      });
      startChat();
    }
  }
  render();
})();`;

function producerHtml(s: ProducerScenario): string {
  const data = { ...s, serverUrl: FIXTURE_SERVER_URL, streamKey: FIXTURE_STREAM_KEY };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>LIVE Producer (fixture)</title>
<style>[role=dialog]{position:fixed;left:20%;top:20%;background:#fff;border:1px solid #000;padding:8px;z-index:10}</style></head>
<body><nav><a href="/producer">Go LIVE</a> <a href="/analytics">Analytics</a></nav><div id="app"></div><div id="dialogs"></div>
<script>window.SCENARIO = ${JSON.stringify(data)};</script>
<script>${PRODUCER_SCRIPT}</script></body></html>`;
}

const HOME_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>TikTok (fixture)</title>
<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({
  __DEFAULT_SCOPE__: { 'webapp.app-context': { user: { uniqueId: FIXTURE_USERNAME, nickName: 'CTD Tester' } } },
})}</script></head><body><a data-e2e="nav-profile" href="/@${FIXTURE_USERNAME}">Profile</a></body></html>`;

const LOGIN_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Log in (fixture)</title></head>
<body><h1>Log in to TikTok</h1><button>Log in</button></body></html>`;

export interface FixtureServer {
  origin: string;
  scenario: ProducerScenario;
  setScenario(patch: Partial<ProducerScenario>): void;
  close(): Promise<void>;
}

/** Local LIVE Producer look-alike on 127.0.0.1 (/producer, /login, / with the username). */
export async function startFixtureServer(): Promise<FixtureServer> {
  const fixture = { scenario: { ...DEFAULT_SCENARIO } };
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const send = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    };
    if (path === '/fixture/live' && req.method === 'POST') {
      // persistLive: the page reports going LIVE / the LIVE ending, so a reload shows it like TikTok would.
      const on = new URL(req.url ?? '/', 'http://localhost').searchParams.get('on') === '1';
      fixture.scenario = { ...fixture.scenario, initial: on ? 'live' : 'start' };
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === '/producer') {
      if (fixture.scenario.loggedOut) {
        res.writeHead(302, { location: '/login?redirect_url=producer' });
        res.end();
        return;
      }
      send(200, producerHtml(fixture.scenario));
    } else if (path === '/login') {
      send(200, LOGIN_HTML);
    } else if (path === '/') {
      send(200, HOME_HTML);
    } else {
      send(404, 'not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    get scenario() {
      return fixture.scenario;
    },
    setScenario(patch) {
      fixture.scenario = { ...DEFAULT_SCENARIO, ...patch };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** BrowserManager over a real Chromium: one context per account, one reused page. */
export function fakeBrowserManager(browser: Browser) {
  const contexts = new Map<string, BrowserContext>();
  const saves: string[] = [];
  async function context(accountId: string): Promise<BrowserContext> {
    let ctx = contexts.get(accountId);
    if (!ctx) {
      ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
      contexts.set(accountId, ctx);
    }
    return ctx;
  }
  async function page(accountId: string, url?: string): Promise<Page> {
    const ctx = await context(accountId);
    const p = ctx.pages().find((candidate) => !candidate.isClosed()) ?? (await ctx.newPage());
    if (url) await p.goto(url);
    return p;
  }
  const manager: BrowserManager = {
    context,
    page,
    viewerPage: page,
    async save(accountId) {
      saves.push(accountId);
    },
    async hasSavedSession() {
      return true;
    },
    async close(accountId) {
      await contexts.get(accountId)?.close();
      contexts.delete(accountId);
    },
    async clear(accountId) {
      await manager.close(accountId);
    },
    async shutdown() {
      await Promise.all([...contexts.values()].map((c) => c.close()));
      contexts.clear();
    },
  };
  return { manager, saves, context, page };
}

/** Log in a context the way TikTok does (sessionid cookie on .tiktok.com). */
export async function addSessionCookie(context: BrowserContext): Promise<void> {
  await context.addCookies([
    { name: 'sessionid', value: 'test-session-cookie', domain: '.tiktok.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' },
  ]);
}

export function memorySecrets(): ScopedSecrets {
  const store = new Map<string, string>();
  const api: ScopedSecrets = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
    getJson: async <T>(key: string) => {
      const v = store.get(key);
      return v === undefined ? null : (JSON.parse(v) as T);
    },
    setJson: async (key, value) => {
      store.set(key, JSON.stringify(value));
    },
  };
  return api;
}

type AccountPatch = Partial<{ label: string; status: AccountStatus; statusMessage: string | null; options: Record<string, unknown> }>;

/** DriverContext with a capturing logger (to assert secrets never reach the logs). */
export function makeContext(browser: BrowserManager, signal: AbortSignal = new AbortController().signal) {
  const lines: string[] = [];
  const updates: AccountPatch[] = [];
  const log = pino({ level: 'debug' }, { write: (line: string) => void lines.push(line) });
  const ctx: DriverContext = {
    log,
    accountSecrets: memorySecrets(),
    destinationSecrets: memorySecrets(),
    app: null,
    browser,
    publicBaseUrl: 'https://127.0.0.1:8443',
    updateAccount: async (patch) => {
      updates.push(patch);
    },
    signal,
  };
  return { ctx, lines, updates };
}

export function makeAccount(id: string, patch: Partial<Account> = {}): Account {
  const now = new Date().toISOString();
  return {
    id,
    platform: 'tiktok',
    label: 'TikTok',
    status: 'connected',
    statusMessage: null,
    options: {},
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

export function makeDestination(patch: Partial<Destination> = {}): Destination {
  const now = new Date().toISOString();
  return {
    id: 'dest-tiktok',
    platform: 'tiktok',
    accountId: 'acc',
    name: 'TikTok',
    feed: 'vertical',
    enabled: true,
    options: {},
    ingestUrl: null,
    hasStreamKey: false,
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}
