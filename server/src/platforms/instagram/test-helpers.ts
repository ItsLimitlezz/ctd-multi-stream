// Test fixtures: a local fake of instagram.com's desktop live flow (served on 127.0.0.1), a
// BrowserManager backed by a real Chromium context, and a DriverContext builder.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import type { BrowserContext, Page } from 'playwright';
import type { Account, AccountStatus, Destination } from '../../../../shared/types.js';
import type { BrowserManager, ScopedSecrets } from '../../services.js';
import type { DriverContext } from '../types.js';

export const FIXTURE_SERVER_URL = 'rtmps://edgetee-upload-tst.xx.fbcdn.net:443/rtmp/';
export const FIXTURE_KEY = '17912345678901234?s_bl=1&s_fbp=tst&s_sw=0&s_vt=ig&a=AbCdEfGh123';
export const FIXTURE_USER = 'tester_ig';

export interface FixtureConfig {
  loggedIn: boolean;
  eligibility: 'eligible' | 'no-live' | 'notice';
  audienceUi: 'radio' | 'select' | 'dropdown' | 'none';
  /** 'inputs': labelled inputs; 'text': plain text next to labels (key masked until "Show"). */
  detailsUi: 'inputs' | 'text';
  /** ms after the producer opens until "Go live" is enabled (-1 = never). */
  previewDelayMs: number;
  notificationsPrompt: boolean;
  cookieBanner: boolean;
  goLiveConfirm: boolean;
  endConfirm: boolean;
  titleMaxLength: number;
  /** "Next" stays disabled while the title is empty. */
  requireTitle: boolean;
  /** Where "Add link" is offered: setup form, producer before going live, or only once live. */
  linkUi: 'none' | 'setup' | 'producer' | 'live';
  /** The link form refuses every link ("Couldn't add link"). */
  linkFails: boolean;
  /** maxlength of the link's title field. */
  linkTitleMax: number;
  /** The link form's URL field has no type/placeholder/label the driver recognizes. */
  linkUrlUnlabelled: boolean;
  /** "Add link" opens nothing. */
  linkDead: boolean;
  /**
   * The link form stays open after "Add": 'silent' = nothing else happens; 'shown' = the link is
   * taken and shown in the producer, but the form stays open.
   */
  linkSticky: 'off' | 'silent' | 'shown';
  /** Viewer count once live: an icon labelled "Viewers" + number, or "N viewers" text. */
  viewerUi: 'none' | 'icon' | 'text';
  /** Viewer count shown when the live starts. */
  viewers: number;
  /**
   * A dialog left over from a live Instagram ended, shown when the page loads ('policy': a policy
   * notice without "ended"/"removed" wording).
   */
  leftover: 'none' | 'ended' | 'share' | 'policy';
}

export const DEFAULT_FIXTURE: FixtureConfig = {
  loggedIn: true,
  eligibility: 'eligible',
  audienceUi: 'radio',
  detailsUi: 'inputs',
  previewDelayMs: 800,
  notificationsPrompt: false,
  cookieBanner: false,
  goLiveConfirm: false,
  endConfirm: true,
  titleMaxLength: 30,
  requireTitle: false,
  linkUi: 'none',
  linkFails: false,
  linkTitleMax: 30,
  linkUrlUnlabelled: false,
  linkDead: false,
  linkSticky: 'off',
  viewerUi: 'none',
  viewers: 3,
  leftover: 'none',
};

export interface FixtureEvent {
  type: string;
  value?: string;
}

const AVATAR = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==';

function icon(label: string): string {
  return `<svg aria-label="${label}" role="img" width="20" height="20" viewBox="0 0 20 20"><title>${label}</title><rect width="20" height="20"/></svg>`;
}

function loginPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Login • Instagram</title></head><body>
  <form><input name="username" aria-label="Phone number, username, or email"><input name="password" type="password" aria-label="Password"><button type="button">Log in</button></form>
  </body></html>`;
}

function audienceHtml(ui: FixtureConfig['audienceUi']): string {
  switch (ui) {
    case 'radio':
      return `<div role="radiogroup" aria-label="Audience">
        <label><input type="radio" name="aud" value="Public" checked> Public</label>
        <label><input type="radio" name="aud" value="Practice"> Practice</label>
        <label><input type="radio" name="aud" value="Close friends"> Close friends</label></div>`;
    case 'select':
      return `<label for="audSel">Audience</label><select id="audSel"><option>Public</option><option>Practice</option></select>`;
    case 'dropdown':
      return `<div role="button" tabindex="0" id="audBtn">Audience: <span id="audVal">Public</span></div>
        <div role="listbox" id="audList" hidden><div role="option" aria-selected="true">Public</div><div role="option" aria-selected="false">Practice</div></div>`;
    case 'none':
      return '';
  }
}

function detailsHtml(ui: FixtureConfig['detailsUi']): string {
  if (ui === 'inputs') {
    return `<div><label for="streamUrl">Stream URL</label><input id="streamUrl" readonly value="${FIXTURE_SERVER_URL}"><button type="button">Copy</button></div>
      <div><label for="streamKey">Stream key</label><input id="streamKey" type="password" readonly value="${FIXTURE_KEY.replace(/&/g, '&amp;')}"><button type="button">Copy</button></div>`;
  }
  return `<div><div><span>Stream URL</span></div><div><span>${FIXTURE_SERVER_URL}</span><button type="button">Copy</button></div></div>
    <div><div><span>Stream key</span></div><div><span id="keyText">••••••••••••</span><button type="button" id="showKey">Show</button><button type="button">Copy</button></div></div>`;
}

function viewersHtml(ui: FixtureConfig['viewerUi']): string {
  switch (ui) {
    case 'icon':
      return `<div id="viewers" hidden><svg aria-label="Viewers" role="img" width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16"/></svg><span id="viewerCount"></span></div>`;
    case 'text':
      return `<div id="viewers" hidden><span id="viewerCount"></span> viewers</div>`;
    case 'none':
      return '';
  }
}

function leftoverHtml(kind: FixtureConfig['leftover']): string {
  if (kind === 'none') return '';
  const body =
    kind === 'ended'
      ? `<h2>Your live video was removed</h2><p>It may go against our Community Guidelines.</p>
         <button type="button" id="leftoverShare">Share</button><button type="button" id="leftoverDone">Done</button>`
      : kind === 'policy'
        ? `<h2>Live video interrupted</h2><p>Your live video was interrupted because it may include music that belongs to someone else.</p>
         <button type="button" id="leftoverShare">Share</button><button type="button" id="leftoverDone">Done</button>`
        : `<h2>Share your live video?</h2><p>Your live video will be shared to your profile as a reel.</p>
         <button type="button" id="leftoverShare">Share</button><button type="button" id="leftoverDone">Don't share</button>`;
  return `<div class="overlay" id="leftover"><div class="modal" role="dialog">${body}</div></div>`;
}

function homePage(cfg: FixtureConfig): string {
  const liveItem =
    cfg.eligibility === 'no-live' ? '' : `<a href="#" role="link" id="menuLive">${icon('Live video')}<span>Live video</span></a>`;
  const addLink = (id: string, hidden: boolean) => `<button type="button" class="addLink" id="${id}" ${hidden ? 'hidden' : ''}>Add link</button>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Instagram</title>
<style>
  body { font-family: sans-serif; margin: 0; }
  [hidden] { display: none !important; }
  nav a { display: block; padding: 6px; }
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 10; }
  .modal { background: #fff; padding: 16px; min-width: 320px; min-height: 120px; }
  .producer { position: fixed; inset: 0; background: #fff; z-index: 5; padding: 12px; overflow: auto; }
  .c { display: flex; gap: 6px; padding: 4px; }
  .c img, nav img, .composer img { width: 20px; height: 20px; }
  #panelComments { min-height: 220px; }
</style></head><body>
<nav aria-label="Primary">
  <a href="/" role="link">${icon('Home')}<span>Home</span></a>
  <a href="/reels/" role="link">${icon('Reels')}<span>Reels</span></a>
  <a href="#" role="link" id="create">${icon('New post')}<span>Create</span></a>
  <a href="/${FIXTURE_USER}/" role="link"><img alt="${FIXTURE_USER}'s profile picture" src="${AVATAR}"><span>Profile</span></a>
</nav>
<main><p>Feed</p></main>
<div id="createMenu" role="menu" hidden>
  <a href="#" role="link" id="menuPost">${icon('Post')}<span>Post</span></a>
  ${liveItem}
</div>
<div class="overlay" id="notif" ${cfg.notificationsPrompt ? '' : 'hidden'}><div class="modal" role="dialog"><h2>Turn on Notifications</h2>
  <button type="button">Turn On</button><button type="button" id="notNow">Not Now</button></div></div>
<div class="overlay" id="cookies" ${cfg.cookieBanner ? '' : 'hidden'}><div class="modal" role="dialog"><p>Allow the use of cookies from Instagram on this browser?</p>
  <button type="button" id="allowCookies">Allow all cookies</button><button type="button" id="declineCookies">Decline optional cookies</button></div></div>
<div class="overlay" id="notice" hidden><div class="modal" role="dialog"><h2>Your account is no longer eligible for Live</h2>
  <p>We changed requirements to use this feature. Only public accounts with 1,000 followers or more will be able to create live videos.</p><button type="button">OK</button></div></div>
<div class="overlay" id="setup" hidden><div class="modal" role="dialog" aria-label="Go live">
  <h2>Go live</h2>
  <input id="title" type="text" placeholder="Add a title" maxlength="${cfg.titleMaxLength}">
  ${audienceHtml(cfg.audienceUi)}
  ${cfg.linkUi === 'setup' ? addLink('addLinkSetup', false) : ''}
  <button type="button" id="next">Next</button>
</div></div>
<div class="producer" id="producer" role="dialog" aria-label="Live producer" hidden>
  <header><span id="liveBadge" hidden>LIVE</span><span id="producerTitle"></span>
    ${viewersHtml(cfg.viewerUi)}
    <button type="button" id="goLive" disabled>Go live</button>
    <button type="button" id="endLive" hidden>End live video</button>
    ${cfg.linkUi === 'producer' || cfg.linkUi === 'live' ? addLink('addLinkProducer', cfg.linkUi === 'live') : ''}
    <span id="linkShown" hidden></span>
    <div role="alert" id="warnBanner" hidden></div></header>
  <section>${detailsHtml(cfg.detailsUi)}</section>
  <div id="waiting">Waiting for your stream…</div>
  <div role="tablist"><button type="button" role="tab" id="tabSetup" aria-selected="true">Stream setup</button>
    <button type="button" role="tab" id="tabComments" aria-selected="false" aria-controls="panelComments">Comments</button></div>
  <div role="tabpanel" id="panelComments" aria-labelledby="tabComments" hidden>
    <div id="commentList"></div>
    <div class="composer"><img alt="${FIXTURE_USER}'s profile picture" src="${AVATAR}"><input placeholder="Add a comment…"><button type="button">Post</button></div>
  </div>
</div>
<div class="overlay" id="goLiveConfirm" hidden><div class="modal" role="dialog"><h3>Go live?</h3>
  <button type="button" id="goLiveConfirmBtn">Go live</button><button type="button">Cancel</button></div></div>
<div class="overlay" id="endConfirm" hidden><div class="modal" role="dialog"><h3>End live video?</h3><p>Your viewers will be notified.</p>
  <button type="button" id="endNow">End now</button><button type="button">Cancel</button></div></div>
<div class="overlay" id="ended" hidden><div class="modal" role="dialog"><h2>Your live video has ended</h2>
  <button type="button" id="share">Share</button><button type="button" id="done">Done</button></div></div>
<div class="overlay" id="linkDialog" hidden><div class="modal" role="dialog" aria-label="Add link"><h3>Add link</h3>
  <input id="linkTitle" type="text" placeholder="Link title" maxlength="${cfg.linkTitleMax}">
  <input id="linkUrl" ${cfg.linkUrlUnlabelled ? 'type="text"' : 'type="url" placeholder="URL"'}>
  <p id="linkError" hidden>Couldn't add link. Try again.</p>
  <button type="button" id="linkAdd" disabled>Add</button><button type="button" id="linkCancel">Cancel</button></div></div>
<div class="overlay" id="takedown" hidden><div class="modal" role="dialog"><h2 id="tdTitle"></h2><p id="tdText"></p>
  <button type="button" id="tdShare">Share</button><button type="button" id="tdDone">Done</button></div></div>
${leftoverHtml(cfg.leftover)}
<script>
const CFG = ${JSON.stringify(cfg)};
const AVATAR = ${JSON.stringify(AVATAR)};
const $ = (id) => document.getElementById(id);
const show = (id, on = true) => { $(id).hidden = !on; };
const ev = (type, value) => fetch('/__event', { method: 'POST', body: JSON.stringify({ type, value }) });
$('notNow').onclick = () => { show('notif', false); ev('notifications-dismissed'); };
$('allowCookies').onclick = () => { show('cookies', false); ev('cookies-allowed'); };
$('declineCookies').onclick = () => { show('cookies', false); ev('cookies-declined'); };
$('create').onclick = (e) => { e.preventDefault(); show('createMenu'); };
$('menuPost').onclick = (e) => { e.preventDefault(); ev('post-clicked'); };
if ($('menuLive')) $('menuLive').onclick = (e) => {
  e.preventDefault(); show('createMenu', false);
  if (CFG.eligibility === 'notice') { show('notice'); return; }
  show('setup');
};
if ($('audBtn')) {
  $('audBtn').onclick = () => show('audList', $('audList').hidden);
  for (const opt of $('audList').children) opt.onclick = () => {
    for (const o of $('audList').children) o.setAttribute('aria-selected', String(o === opt));
    $('audVal').textContent = opt.textContent; show('audList', false);
  };
}
function audience() {
  if (CFG.audienceUi === 'radio') return document.querySelector('input[name="aud"]:checked').value;
  if (CFG.audienceUi === 'select') return $('audSel').value;
  if (CFG.audienceUi === 'dropdown') return $('audVal').textContent;
  return 'Public';
}
if (CFG.requireTitle) {
  const sync = () => { $('next').disabled = $('title').value.trim() === ''; };
  $('title').addEventListener('input', sync); sync();
}
$('next').onclick = async () => {
  await ev('title', $('title').value);
  await ev('audience', audience());
  $('producerTitle').textContent = $('title').value;
  show('setup', false); show('producer');
  if (CFG.previewDelayMs >= 0) setTimeout(() => { $('goLive').disabled = false; show('waiting', false); }, CFG.previewDelayMs);
};
if ($('showKey')) $('showKey').onclick = () => { $('keyText').textContent = ${JSON.stringify(FIXTURE_KEY)}; };
function setViewers(n) {
  if (!$('viewers')) return;
  if (n === null) { show('viewers', false); return; }
  $('viewerCount').textContent = String(n); show('viewers');
}
function startLive() {
  ev('golive'); show('goLive', false); show('endLive'); show('liveBadge');
  $('tabSetup').setAttribute('aria-selected', 'false');
  setViewers(CFG.viewers);
  if (CFG.linkUi === 'live' && !$('linkShown').textContent) show('addLinkProducer');
}
window.__setViewers = setViewers;
for (const b of document.querySelectorAll('.addLink')) b.onclick = () => {
  if (CFG.linkDead) { ev('link-dead'); return; }
  $('linkTitle').value = ''; $('linkUrl').value = ''; $('linkAdd').disabled = true; show('linkError', false);
  show('linkDialog'); ev('link-opened');
};
$('linkUrl').addEventListener('input', () => { $('linkAdd').disabled = !/^https?:\\/\\/\\S+$/.test($('linkUrl').value.trim()); });
$('linkAdd').onclick = () => {
  if (CFG.linkFails) { show('linkError'); ev('link-refused'); return; }
  if (CFG.linkSticky === 'silent') { ev('link-sticky'); return; }
  ev('link', $('linkTitle').value + '|' + $('linkUrl').value);
  if (CFG.linkSticky !== 'shown') show('linkDialog', false);
  for (const b of document.querySelectorAll('.addLink')) b.hidden = true;
  $('linkShown').textContent = $('linkTitle').value + ' ' + $('linkUrl').value.replace(/^https?:\\/\\//, ''); show('linkShown');
};
$('linkCancel').onclick = () => { show('linkDialog', false); ev('link-cancelled'); };
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  ev('key-escape');
  if (!$('linkDialog').hidden) { show('linkDialog', false); ev('link-escaped'); }
});
// Instagram ends the live (takedown): the live UI goes away and a notice shows.
window.__takedown = (title, text) => {
  ev('takedown'); show('endLive', false); show('liveBadge', false); setViewers(null);
  $('tdTitle').textContent = title; $('tdText').textContent = text || ''; show('takedown');
};
$('tdShare').onclick = () => ev('share');
$('tdDone').onclick = () => { show('takedown', false); ev('takedown-dismissed'); };
// The producer drops back to its setup state (no notice).
window.__dropLive = () => { show('endLive', false); show('liveBadge', false); show('goLive'); $('goLive').disabled = false; setViewers(null); };
window.__warn = (text) => { $('warnBanner').textContent = text; show('warnBanner', !!text); };
if ($('leftover')) {
  $('leftoverShare').onclick = () => ev('share');
  $('leftoverDone').onclick = () => { show('leftover', false); ev('leftover-dismissed'); };
}
$('goLive').onclick = () => { if (CFG.goLiveConfirm) show('goLiveConfirm'); else startLive(); };
$('goLiveConfirmBtn').onclick = () => { show('goLiveConfirm', false); startLive(); };
$('tabComments').onclick = () => { $('tabComments').setAttribute('aria-selected', 'true'); show('panelComments'); };
function finishLive() { ev('end'); show('endLive', false); show('liveBadge', false); show('ended'); }
$('endLive').onclick = () => { if (CFG.endConfirm) show('endConfirm'); else finishLive(); };
$('endNow').onclick = () => { show('endConfirm', false); finishLive(); };
$('share').onclick = () => ev('share');
$('done').onclick = () => { show('ended', false); show('producer', false); ev('done'); };
window.__addComment = (user, text) => {
  const row = document.createElement('div'); row.className = 'c';
  row.innerHTML = '<a href="/' + user + '/"><img alt="' + user + '\\'s profile picture" src="' + AVATAR + '"></a>' +
    '<div><a href="/' + user + '/"><span class="u"></span></a> <span class="t"></span></div><time>1m</time><button type="button">Reply</button>';
  row.querySelector('.u').textContent = user; row.querySelector('.t').textContent = text;
  $('commentList').appendChild(row);
};
window.__addPlain = (user, text) => {
  const li = document.createElement('li');
  li.innerHTML = '<a href="/' + user + '/"></a><span></span>';
  li.firstChild.textContent = user; li.lastChild.textContent = text;
  $('commentList').appendChild(li);
};
window.__addJoin = (user) => {
  const row = document.createElement('div'); row.className = 'c';
  row.innerHTML = '<a href="/' + user + '/"><img alt="' + user + '\\'s profile picture" src="' + AVATAR + '"></a><span><span class="u"></span> joined</span>';
  row.querySelector('.u').textContent = user;
  $('commentList').appendChild(row);
};
</script></body></html>`;
}

export interface FixtureServer {
  origin: string;
  config: FixtureConfig;
  events: FixtureEvent[];
  reset(patch?: Partial<FixtureConfig>): void;
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const state = { config: { ...DEFAULT_FIXTURE }, events: [] as FixtureEvent[] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/__event') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        try {
          state.events.push(JSON.parse(body) as FixtureEvent);
        } catch {
          // ignore
        }
        res.writeHead(204).end();
      });
      return;
    }
    const html = !state.config.loggedIn || url.pathname.startsWith('/accounts/login') ? loginPage() : homePage(state.config);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    get config() {
      return state.config;
    },
    get events() {
      return state.events;
    },
    reset(patch = {}) {
      state.config = { ...DEFAULT_FIXTURE, ...patch };
      state.events = [];
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** BrowserManager over one real context (all accounts share it in tests). */
export class FakeBrowserManager implements BrowserManager {
  saves = 0;
  constructor(readonly ctx: BrowserContext) {}

  async context(): Promise<BrowserContext> {
    return this.ctx;
  }

  async page(_accountId: string, url?: string): Promise<Page> {
    const page = this.ctx.pages().find((p) => !p.isClosed()) ?? (await this.ctx.newPage());
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
    return page;
  }

  viewerPage(accountId: string, url?: string): Promise<Page> {
    return this.page(accountId, url);
  }

  async save(): Promise<void> {
    this.saves++;
  }

  async hasSavedSession(): Promise<boolean> {
    return false;
  }

  async close(): Promise<void> {}
  async clear(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

export type AccountPatch = Partial<{ label: string; status: AccountStatus; statusMessage: string | null; options: Record<string, unknown> }>;

/** In-memory ScopedSecrets (values stored as strings, like the real store). */
export class FakeSecrets implements ScopedSecrets {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
  async getJson<T>(key: string): Promise<T | null> {
    const raw = this.values.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }
  async setJson(key: string, value: unknown): Promise<void> {
    this.values.set(key, JSON.stringify(value));
  }
}

export function makeCtx(
  browser: BrowserManager,
  signal: AbortSignal = new AbortController().signal,
  destinationSecrets: ScopedSecrets | null = null,
) {
  const updates: AccountPatch[] = [];
  const ctx: DriverContext = {
    log: pino({ level: 'silent' }),
    accountSecrets: null,
    destinationSecrets,
    app: null,
    browser,
    publicBaseUrl: 'https://203.0.113.7',
    async updateAccount(patch) {
      updates.push(patch);
    },
    signal,
  };
  return { ctx, updates };
}

const NOW = '2026-10-11T00:00:00.000Z';

export function makeAccount(id = 'acc-ig'): Account {
  return { id, platform: 'instagram', label: 'Instagram', status: 'connected', statusMessage: null, options: {}, createdAt: NOW, updatedAt: NOW };
}

export function makeDestination(options: Record<string, unknown> = {}, id = 'dest-ig', accountId: string | null = 'acc-ig'): Destination {
  return {
    id,
    platform: 'instagram',
    accountId,
    name: 'Instagram',
    feed: 'vertical',
    enabled: true,
    options,
    ingestUrl: null,
    hasStreamKey: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
