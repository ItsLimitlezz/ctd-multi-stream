// Every URL, locator and text the X driver uses. When X changes its UI, this is the file to fix.
//
// What was verified (Oct 2026, from public docs/guides; the logged-in UI could not be inspected):
// - Live Studio (X Premium, select regions) lives at https://x.com/i/live-studio (also studio.x.com/live,
//   Creator Studio → Tools → Live Studio); sources at /i/live-studio/sources ("Manage Sources",
//   "Create Source"). https://help.x.com/en/using-x/live-studio
// - Flow: "New Livestream" → enter a title → pick a source (reusable, one livestream at a time) →
//   start the encoder → the "Go live" button (top right) becomes active → press it ("Later" schedules).
//   Streaming to a source alone does NOT go live. https://note.com/yuki_tech/n/n1a1467639040,
//   https://upstream.so/blog/how-to-go-live-on-x/ ; the Livestream API also needs an explicit
//   PUBLISH: https://docs.x.com/livestream-api/typical-workflow
// - While live the title can be edited on the stream's details page; "End Livestream" ends it.
//   https://upstream.so/blog/how-to-go-live-on-x/
// - Source ingest: rtmps://<region>.pscp.tv:443/x (rtmp://...:80/x) + stream key (= source id).
//   https://docs.x.com/livestream-api/sources/create-source
// - Watch URL: https://x.com/i/broadcasts/<broadcastId> (13-char id, e.g. 1AxRnanzLOrxl).
//   https://docs.x.com/livestream-api/broadcasts/create-broadcast
// - The logged-in session is the `auth_token` cookie on .x.com; the profile tab link is
//   a[data-testid="AppTabBar_Profile_Link"] (long-standing X web test id).
//
// Assumptions (unverified, kept loose on purpose): button/field names below (case-insensitive
// regexes, several spellings); the create form may be a multi-step wizard ("Next"); a confirm
// dialog may follow "Go live"; the details page shows an "End livestream" button and/or a link to
// /i/broadcasts/<id>; the broadcast page renders chat items in the main document with data-testid
// attributes or as list items of a role="log" region. Wrong guesses degrade to best-effort skips,
// except the "Go live" click itself, which is reported as an error.

import type { Locator, Page } from 'playwright';
import type { ScrapeChatOptions } from '../../browser/helpers.js';

export interface XUrls {
  login: string;
  home: string;
  liveStudio: string;
  /** Origin whose cookies hold the session. */
  cookieOrigin: string;
  broadcast(id: string): string;
}

export const X_URLS: XUrls = {
  login: 'https://x.com/i/flow/login',
  home: 'https://x.com/home',
  liveStudio: 'https://x.com/i/live-studio',
  cookieOrigin: 'https://x.com',
  broadcast: (id) => `https://x.com/i/broadcasts/${encodeURIComponent(id)}`,
};

/** Session cookie set by X after login. */
export const AUTH_COOKIE = 'auth_token';

/** Login / signup pages X redirects to when the session is gone (path only, any host). */
export const LOGIN_PATH_RE = /^\/(?:i\/flow\/(?:login|signup)|login|logout|account\/access)(?:[/?#]|$)/i;

/** Broadcast id in watch URLs, Live Studio detail URLs or "copy link" fields. */
export const BROADCAST_ID_RES: readonly RegExp[] = [
  /\/i\/broadcasts\/([A-Za-z0-9]{6,32})(?![A-Za-z0-9])/,
  /\/i\/live-studio\/(?:broadcasts?|livestreams?|streams?|events?)\/([A-Za-z0-9]{6,32})(?![A-Za-z0-9])/,
];

/** X handle from the profile tab link href ("/jack"). */
export const HANDLE_HREF_RE = /^\/([A-Za-z0-9_]{1,15})\/?$/;

const GO_LIVE = /^\s*go live( now)?\s*$/i;
const END_LIVE = /^\s*end( (the )?(live ?stream|broadcast|stream|live))?\s*$/i;

export const sel = {
  // ---- session ----
  profileLink: (page: Page): Locator => page.locator('a[data-testid="AppTabBar_Profile_Link"]'),
  loginForm: (page: Page): Locator =>
    page
      .locator('input[autocomplete="username"], input[name="text"][autocomplete], input[name="password"]')
      .or(page.getByRole('button', { name: /^\s*(log in|sign in)\s*$/i })),

  // ---- Live Studio home ----
  newLivestream: (page: Page): Locator =>
    page
      .getByRole('button', { name: /new live ?stream/i })
      .or(page.getByRole('link', { name: /new live ?stream/i })),
  /** Shown instead of the studio when the account isn't eligible (no Premium, region, protected posts). */
  notEligible: (page: Page): Locator =>
    page.getByText(
      /(subscribe to|get|upgrade to|requires?|available (only )?(with|to|for)) (x )?premium|not (yet )?available in your (country|region)|can(no|')t go live|protected (posts|account)/i,
    ),

  // ---- create form ----
  titleField: (page: Page): Locator =>
    page
      .getByRole('textbox', { name: /title/i })
      .or(page.getByLabel(/^\s*(stream |livestream |broadcast )?title/i))
      .or(page.getByPlaceholder(/title/i)),
  sourcePicker: (page: Page): Locator =>
    page
      .getByRole('combobox', { name: /source/i })
      .or(page.getByLabel(/^\s*(select (a )?)?source/i))
      .or(page.getByRole('button', { name: /^\s*(select (a )?)?source\b/i })),
  /** An option in an opened source list (custom dropdowns). */
  sourceOption: (page: Page, name: RegExp): Locator =>
    page
      .getByRole('option', { name })
      .or(page.getByRole('menuitem', { name }))
      .or(page.getByRole('menuitemradio', { name }))
      .or(page.getByRole('radio', { name })),
  /** "Now" (vs "Later") start choice, when the form asks. */
  startNow: (page: Page): Locator =>
    page
      .getByRole('radio', { name: /^\s*now\s*$/i })
      .or(page.getByRole('tab', { name: /^\s*now\s*$/i }))
      .or(page.getByRole('button', { name: /^\s*now\s*$/i })),
  nextStep: (page: Page): Locator => page.getByRole('button', { name: /^\s*(next|continue)\s*$/i }),
  goLive: (page: Page): Locator => page.getByRole('button', { name: GO_LIVE }),
  /** Confirmation dialog after "Go live". */
  dialogConfirmGoLive: (page: Page): Locator =>
    page
      .getByRole('dialog')
      .or(page.getByRole('alertdialog'))
      .getByRole('button', { name: /^\s*(go live( now)?|confirm|start( live ?stream)?|yes)\s*$/i }),
  /** Error banner/toast while creating or starting the livestream. */
  errorText: (page: Page): Locator =>
    page.getByRole('alert').filter({ hasText: /went wrong|failed|error|couldn('|’)?t|unable|not receiving|no (video|signal)/i }),

  // ---- live / details page ----
  /** Only markers of OUR running livestream (not e.g. a "Live now" list heading on the studio home). */
  liveIndicator: (page: Page): Locator =>
    page
      .getByRole('button', { name: END_LIVE })
      .or(page.getByText(/^\s*(you('|’)re|you are) live( now)?!?\s*$/i)),
  endButton: (page: Page): Locator => page.getByRole('button', { name: END_LIVE }),
  dialogConfirmEnd: (page: Page): Locator =>
    page
      .getByRole('dialog')
      .or(page.getByRole('alertdialog'))
      .getByRole('button', { name: /^\s*(end( (the )?(live ?stream|broadcast|stream|live))?|confirm|yes)\s*$/i }),
  endedIndicator: (page: Page): Locator =>
    page.getByText(/^\s*(ended|livestream ended|broadcast ended|this (live ?stream|broadcast) (has )?ended)\s*$/i),
  editButton: (page: Page): Locator =>
    page.getByRole('button', { name: /^\s*edit( (details|title|live ?stream|broadcast))?\s*$/i }),
  saveButton: (page: Page): Locator => page.getByRole('button', { name: /^\s*(save|update|done|apply)( changes)?\s*$/i }),
};

// ---- chat (x.com/i/broadcasts/<id>) ----

const CHAT_ITEM = [
  '[data-testid="chatMessage" i]',
  '[data-testid="chat-message" i]',
  '[data-testid="chat_message" i]',
  '[data-testid="liveChatMessage" i]',
  '[role="log"] > [role="listitem"]',
  '[role="log"] > li',
].join(', ');

// Plain JS (runs in the page, see scrapeChat). Uses the innermost matching element so a list
// item wrapping a data-testid message isn't reported twice. Author: a username-like test id, else
// the first line; an "@handle" line is skipped; text: a message-text test id or [lang] node, else
// the remaining lines.
const CHAT_EXTRACT = `(el) => {
  const ITEM = ${JSON.stringify(CHAT_ITEM)};
  if (el.querySelector(ITEM)) return null;
  const read = (n) => (n ? String(n.innerText || n.textContent || '').trim() : '');
  const pick = (s) => read(el.querySelector(s));
  let author = pick('[data-testid*="username" i], [data-testid*="user-name" i], [data-testid*="displayname" i], [data-testid*="author" i]');
  let text = pick('[data-testid*="messagetext" i], [data-testid*="message-text" i], [data-testid*="chattext" i], [lang]');
  if (!author || !text) {
    const lines = read(el).split('\\n').map((s) => s.trim()).filter(Boolean);
    let i = 0;
    if (!author && lines.length > 1) { author = lines[0]; i = 1; }
    else if (author && lines[0] === author) i = 1;
    while (i < lines.length - 1 && /^@\\w{1,15}$/.test(lines[i])) i++;
    if (!text) text = lines.slice(i).join(' ');
  }
  if (!text) return null;
  const img = el.querySelector('img[src^="http"]');
  const tid = String(el.getAttribute('data-testid') || '');
  return {
    id: el.getAttribute('data-message-id') || el.getAttribute('data-id') || null,
    author: author.replace(/^@/, ''),
    text: text,
    avatarUrl: img ? img.src : undefined,
    kind: /join/i.test(tid) ? 'event' : 'message',
  };
}`;

export const X_CHAT: ScrapeChatOptions = {
  itemSelector: CHAT_ITEM,
  extract: CHAT_EXTRACT,
  pollMs: 1500,
};
