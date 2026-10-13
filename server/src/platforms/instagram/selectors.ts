// Every Instagram locator, label and in-page script lives here, so a site change is a contained fix.
//
// Flow (desktop instagram.com, "Live Producer"), as documented by Instagram and recent guides:
//   sidebar "Create" (+, svg "New post") → "Live video" → "Go live" setup: title + audience
//   (Public / Practice / sometimes Close friends) → "Next" → "Stream URL" + "Stream key" (new key
//   every live) → start sending video → preview → "Go live" (top right) → live; "Comments" tab;
//   "End live video" ends it.
//   https://about.instagram.com/blog/tips-and-tricks/instagram-live-producer/
//   https://support.restream.io/en/articles/6379108-stream-to-instagram
//   https://support.ecamm.com/en/articles/3847198-streaming-to-instagram-live-with-ecamm
// Ineligible accounts (since Aug 2025: public + 1,000 followers) see "Your account is no longer
// eligible for Live" — https://9to5mac.com/2025/08/01/new-instagram-rule-cuts-off-live-broadcasts-for-small-accounts/
//
// ASSUMPTIONS (not verifiable without an eligible logged-in account; keep locators tolerant):
// - Accessible names may repeat an icon label ("New post Create"), hence `names()` below.
// - The title is a textbox labelled/placeholdered "...title..."; the audience is a radio group,
//   a <select> or a custom dropdown labelled "Audience".
// - Stream URL / key are inputs (or text) next to "Stream URL" / "Stream key" labels.
// - "Go live" stays disabled until the preview arrives; "End live video" asks for confirmation.
// - Comment rows show an avatar whose alt is "<username>'s profile picture" (the context is en-US).

import type { Locator, Page } from 'playwright';

export const IG_ORIGIN = 'https://www.instagram.com';
export const LOGIN_PATH = '/accounts/login/';
/** Cookie present only while logged in (HttpOnly, readable through the browser context). */
export const SESSION_COOKIE = 'sessionid';

/**
 * Regex matching any of `labels`, optionally repeated: an icon label + text gives accessible names
 * like "New post Create" (or "New postCreate" when the parts are inline). Case-insensitive.
 */
function names(...labels: string[]): RegExp {
  const alt = labels.join('|');
  return new RegExp(`^\\s*(?:${alt})(?:\\s*(?:${alt}))*\\s*$`, 'i');
}

export const RE = {
  create: names('create', 'new post'),
  liveVideo: names('live video', 'live'),
  postItem: names('post'),
  /** Sidebar "Profile" link; its name usually starts with the avatar alt ("name's profile picture"). */
  profileLink: /profile\s*$/i,
  avatarAlt: /^(.+?)['’]s profile picture$/i,
  notNow: names('not now'),
  cookieDecline: names('decline optional cookies', 'only allow essential cookies', 'reject optional cookies'),
  // Kept narrow: producer hints like "you can't go live until we receive your stream" must not match.
  ineligible: /no longer eligible for live|(?:not|isn'?t) eligible (?:to go live|for live)|only public accounts with [\d,.]+ followers/i,
  postDialog: /^(?:create new post|drag photos and videos here)$/i,
  title: /title/i,
  audience: /audience|who can see/i,
  public: /^\s*public\b/i,
  practice: /^\s*practice\b/i,
  next: names('next'),
  streamUrlLabel: '^(?:stream|server) url$',
  streamKeyLabel: '^stream key$',
  showKey: /^(?:show|reveal)(?: stream)?(?: key)?$/i,
  goLive: names('go live'),
  goLiveConfirmDialog: /go live\s*\?|start (?:your |this )?live(?: video)?\s*\?/i,
  waitingForStream: /waiting for (?:your )?(?:stream|video|connection|signal)|connect your streaming software|no stream detected/i,
  endLive: names('end live video', 'end live'),
  endConfirm: /^\s*end(?: live(?: video)?)?(?: now)?\s*$/i,
  endConfirmDialog: /end (?:this |your )?live(?: video)?\s*\?|are you sure/i,
  liveNow: /^(?:you'?re live|you are live|live now)$/i,
  ended: /(?:live video|live) (?:has )?ended|your live video has ended|thanks for going live/i,
  afterEnd: names('done', 'close', 'not now', 'ok'),
  platformError: /something went wrong|couldn'?t start (?:your )?live|could not start (?:your )?live|try again later/i,
  comments: names('comments', 'comment'),
} as const;

type Scope = Page | Locator;

function anyRole(scope: Scope, roles: Parameters<Page['getByRole']>[0][], name: RegExp): Locator {
  let loc = scope.getByRole(roles[0]!, { name });
  for (const role of roles.slice(1)) loc = loc.or(scope.getByRole(role, { name }));
  return loc;
}

/** Locator factories. Callers apply `.filter({ visible: true }).first()` where needed. */
export const sel = {
  // ---- session ----
  loginForm: (p: Page) => p.locator('input[type="password"]').or(p.locator('input[name="username"]')),
  loggedInMarker: (p: Page) =>
    anyRole(p, ['link', 'button'], names('home', 'reels', 'messages', 'direct', 'create', 'new post'))
      .or(p.locator('a[href^="/direct/"], a[href="/reels/"]')),
  profileLink: (p: Page) => p.getByRole('link', { name: RE.profileLink }),
  avatarImages: (p: Page) => p.locator('img[alt$="profile picture" i]'),

  // ---- interstitials (never accept anything; only "Not now" / decline optional cookies) ----
  cookieDecline: (p: Page) => p.getByRole('button', { name: RE.cookieDecline }),
  notNow: (p: Page) => p.getByRole('button', { name: RE.notNow }),

  // ---- create → live ----
  createButton: (p: Page) => anyRole(p, ['link', 'button'], RE.create),
  liveOption: (p: Page) =>
    anyRole(p, ['link', 'menuitem', 'button', 'option'], RE.liveVideo).or(p.getByText(/^live video$/i)),
  postItem: (p: Page) => anyRole(p, ['link', 'menuitem', 'button', 'option'], RE.postItem),
  postDialog: (p: Page) => p.getByText(RE.postDialog),
  ineligible: (p: Page) => p.getByText(RE.ineligible),

  // ---- setup ("Go live" form) ----
  titleInput: (p: Page) =>
    p.getByRole('textbox', { name: RE.title }).or(p.getByPlaceholder(RE.title)).or(p.getByLabel(RE.title)),
  audienceRadio: (p: Page, re: RegExp) => p.getByRole('radio', { name: re }),
  audienceCombo: (p: Page) => anyRole(p, ['combobox', 'button'], RE.audience),
  audienceOption: (p: Page, re: RegExp) => anyRole(p, ['option', 'menuitemradio', 'menuitem', 'radio'], re),
  audienceText: (p: Page, re: RegExp) => p.getByText(re),
  nextButton: (p: Page) => p.getByRole('button', { name: RE.next }),

  // ---- stream details ----
  streamUrlField: (p: Page) =>
    p.getByLabel(new RegExp(RE.streamUrlLabel, 'i')).or(p.getByRole('textbox', { name: /(?:stream|server) url/i })),
  streamKeyField: (p: Page) =>
    p.getByLabel(new RegExp(RE.streamKeyLabel, 'i')).or(p.getByRole('textbox', { name: /stream key/i })),
  streamKeyLabel: (p: Page) => p.getByText(new RegExp(RE.streamKeyLabel, 'i')),
  showKeyButton: (p: Page) => p.getByRole('button', { name: RE.showKey }),

  // ---- producer ----
  goLiveButton: (p: Page) => p.getByRole('button', { name: RE.goLive }),
  /** A possible "Go live?" confirmation step after clicking "Go live". */
  goLiveConfirmButton: (p: Page) =>
    p
      .getByRole('alertdialog')
      .or(p.getByRole('dialog').filter({ hasText: RE.goLiveConfirmDialog }))
      .getByRole('button', { name: RE.goLive }),
  waitingForStream: (p: Page) => p.getByText(RE.waitingForStream),
  endLiveButton: (p: Page) => p.getByRole('button', { name: RE.endLive }),
  endConfirmButton: (p: Page) =>
    p
      .getByRole('alertdialog')
      .or(p.getByRole('dialog').filter({ hasText: RE.endConfirmDialog }))
      .getByRole('button', { name: RE.endConfirm }),
  liveNow: (p: Page) => p.getByText(RE.liveNow),
  ended: (p: Page) => p.getByText(RE.ended),
  afterEndButton: (p: Page) => p.getByRole('button', { name: RE.afterEnd }),
  platformError: (p: Page) => p.getByText(RE.platformError),
  commentsTab: (p: Page) => anyRole(p, ['tab', 'button'], RE.comments),
};

// ---------------------------------------------------------------------------
// In-page scripts (plain JS strings: nothing from the TS toolchain leaks into the page)
// ---------------------------------------------------------------------------

/**
 * `(args) => { url, key }`: finds the values shown next to the "Stream URL" / "Stream key" labels
 * (label[for], or the nearest input / text leaf in the label's ancestors). Fallback for when the
 * fields are not exposed as labelled inputs.
 */
export const STREAM_DETAILS_SOURCE = `(args) => {
  const urlRe = new RegExp(args.urlLabel, 'i');
  const keyRe = new RegExp(args.keyLabel, 'i');
  const skipRe = /^(copy|copied|reset|reset key|reset stream key|show|hide|stream url|server url|stream key)$/i;
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const ownText = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
  const valueOf = (el) => (el.matches('input, textarea') ? String(el.value || '') : String(el.innerText || el.textContent || '')).trim();
  const find = (labelRe, accept) => {
    for (const el of document.querySelectorAll('label, span, div, p, h1, h2, h3, h4, h5, h6, dt, strong')) {
      if (!visible(el)) continue;
      const own = ownText(el);
      if (!own || !labelRe.test(own)) continue;
      if (el.tagName === 'LABEL' && el.htmlFor) {
        const target = document.getElementById(el.htmlFor);
        if (target && accept(valueOf(target))) return valueOf(target);
      }
      let node = el.parentElement;
      for (let depth = 0; depth < 5 && node; depth++, node = node.parentElement) {
        for (const input of node.querySelectorAll('input, textarea')) {
          const v = valueOf(input);
          if (accept(v)) return v;
        }
        for (const leaf of node.querySelectorAll('*')) {
          if (leaf === el || leaf.children.length > 0 || !visible(leaf)) continue;
          const t = String(leaf.textContent || '').trim();
          if (t && !skipRe.test(t) && accept(t)) return t;
        }
      }
    }
    return null;
  };
  const isUrl = (v) => /^rtmps?:\\/\\/\\S+$/i.test(v);
  // Keys hold digits (e.g. "1791...?s_bl=1&..."); a masked key ("••••") is returned so the caller
  // can click "Show" and read again.
  const isKey = (v) => !isUrl(v) && !skipRe.test(v) && ((/^\\S{10,}$/.test(v) && /\\d/.test(v)) || /^[•●*]{6,}$/.test(v));
  return { url: find(urlRe, isUrl), key: find(keyRe, isKey) };
}`;

/** Attributes the chat marker sets on the comments container and on each comment row. */
export const CHAT_CONTAINER_ATTR = 'data-ctd-ig-comments';
export const CHAT_ROW_ATTR = 'data-ctd-ig-comment';

/**
 * `(args) => number`: locates the live comments panel and tags each comment row with
 * CHAT_ROW_ATTR (idempotent; run repeatedly). Container: a "Comments" tabpanel / labelled region,
 * else the area around the "Add a comment" box, else around a "Comments" heading. Row: the
 * smallest ancestor of one avatar that also holds text besides the username, or a list item.
 * Rows never contain an input (the composer) or more than one avatar.
 */
export const CHAT_MARK_SOURCE = `(args) => {
  const CATTR = args.containerAttr;
  const RATTR = args.rowAttr;
  const avatarSel = 'img[alt$="profile picture" i]';
  const altRe = /^(.+?)['\\u2019]s profile picture$/i;
  const commentsRe = /^(live )?comments?$/i;
  const visible = (el) => !!(el && el.isConnected && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const ownText = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
  const climb = (el, levels, minHeight) => {
    let node = el;
    for (let i = 0; i < levels && node.parentElement && node.parentElement !== document.body; i++) {
      node = node.parentElement;
      if (node.getBoundingClientRect().height >= minHeight) return node;
    }
    return node;
  };
  const findContainer = () => {
    for (const panel of document.querySelectorAll('[role="tabpanel"]')) {
      if (!visible(panel)) continue;
      const by = panel.getAttribute('aria-labelledby');
      const tab = by ? document.getElementById(by) : null;
      const label = (panel.getAttribute('aria-label') || (tab && tab.textContent) || '').trim();
      if (commentsRe.test(label)) return panel;
    }
    for (const el of document.querySelectorAll('[aria-label]')) {
      if (visible(el) && commentsRe.test(el.getAttribute('aria-label').trim()) && el.tagName !== 'svg' && !el.matches('button, a, [role="tab"], [role="button"]')) return el;
    }
    for (const box of document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"]')) {
      const hint = (box.getAttribute('placeholder') || box.getAttribute('aria-label') || '').trim();
      if (visible(box) && /comment/i.test(hint)) return climb(box, 4, 200);
    }
    for (const el of document.querySelectorAll('h1, h2, h3, h4, span, div')) {
      if (visible(el) && commentsRe.test(ownText(el)) && !el.closest('button, a, [role="tab"], [role="button"]')) return climb(el, 4, 200);
    }
    return null;
  };
  let container = document.querySelector('[' + CATTR + ']');
  if (container && !visible(container)) {
    container.removeAttribute(CATTR);
    container = null;
  }
  if (!container) {
    container = findContainer();
    if (!container) return 0;
    container.setAttribute(CATTR, '');
  }
  const isRow = (el) => !el.querySelector('input, textarea, [contenteditable="true"]') && el.querySelectorAll(avatarSel).length <= 1;
  let marked = 0;
  for (const img of container.querySelectorAll(avatarSel)) {
    const m = altRe.exec((img.getAttribute('alt') || '').trim());
    const user = m ? m[1].trim() : '';
    let node = img.parentElement;
    while (node && node !== container) {
      const text = String(node.innerText || node.textContent || '').replace(user, '').trim();
      if (text) break;
      node = node.parentElement;
    }
    if (!node || node === container || !isRow(node)) continue;
    if (!node.hasAttribute(RATTR)) node.setAttribute(RATTR, '');
    marked++;
  }
  for (const item of container.querySelectorAll('li, [role="listitem"], [role="row"]')) {
    if (item.querySelector('[' + RATTR + ']') || item.closest('[' + RATTR + ']') || !isRow(item)) continue;
    if (!String(item.innerText || '').trim()) continue;
    item.setAttribute(RATTR, '');
    marked++;
  }
  return marked;
}`;

/**
 * `(el) => ChatExtractResult | null` for one tagged row (see scrapeChat in browser/helpers.ts).
 * Author from the avatar alt (else the first profile link / first text). Text = the row's other
 * visible text nodes minus timestamps and action labels. "joined" rows become events.
 */
export const CHAT_EXTRACT_SOURCE = `(el) => {
  const altRe = /^(.+?)['\\u2019]s profile picture$/i;
  const metaRe = /^(reply|replies|see translation|pin|pin comment|unpin|report|like|liked|\\u00b7|\\u2022|now|just now|\\d+\\s?[smhdw]|\\d+\\s?(sec|min|hr|hour|day|week)s?( ago)?|verified)$/i;
  const eventRe = /^(joined|joined the live video|joined the live|is watching|started watching|requested to join)\\.?$/i;
  const visible = (n) => !!(n && (n.offsetWidth || n.offsetHeight || n.getClientRects().length));
  const img = el.querySelector('img[alt$="profile picture" i]');
  let author = '';
  if (img) {
    const m = altRe.exec((img.getAttribute('alt') || '').trim());
    if (m) author = m[1].trim();
  }
  const texts = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = String(n.textContent || '').replace(/\\s+/g, ' ').trim();
    const parent = n.parentElement;
    if (!t || !parent || !visible(parent) || parent.closest('button, time, svg')) continue;
    texts.push(t);
  }
  if (!author) {
    const link = el.querySelector('a[href^="/"]');
    const linkText = link ? String(link.textContent || '').trim() : '';
    author = linkText || (texts.length > 1 ? texts[0] : '');
  }
  const rest = [];
  let dropped = false;
  for (const t of texts) {
    if (!dropped && author && t === author) { dropped = true; continue; }
    if (metaRe.test(t)) continue;
    rest.push(t);
  }
  let text = rest.join(' ').trim();
  if (!dropped && author && text.toLowerCase().startsWith(author.toLowerCase() + ' ')) text = text.slice(author.length + 1).trim();
  if (!text) return null;
  const isEvent = eventRe.test(text);
  const badges = el.querySelector('svg[aria-label="Verified" i]') ? ['verified'] : undefined;
  return {
    author: author || 'Instagram',
    text: isEvent && author ? author + ' ' + text : text,
    kind: isEvent ? 'event' : 'message',
    avatarUrl: img && /^https?:/i.test(img.src || '') ? img.src : undefined,
    badges: badges,
  };
}`;
