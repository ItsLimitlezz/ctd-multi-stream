// Every TikTok URL, UI text and locator the driver uses lives here, so a TikTok redesign is
// patched in one place.
//
// TikTok LIVE Producer ("LIVE Center" → "LIVE Room"): https://livecenter.tiktok.com/producer
// There is no official documentation. The flow below comes from current third-party guides
// (checked October 2026) and could not be verified with an account that has stream key access:
//   https://restream.io/integrations/tiktok/how-to-get-tiktok-stream-key
//   https://help.grabyo.com/en/articles/7207542-broadcast-live-to-tiktok
//   https://blog.tikfinity.com/?p=7010
//   https://help.castream.io/en/help/platform-guides/how-to-stream-to-tiktok-live-with-rtmp
//   1. Red "Go LIVE" button → LIVE settings (title, topic/category) → "Save & Go LIVE". This does
//      not start the LIVE: it creates it and shows the "Server URL" + "Stream key" (Copy buttons)
//      at the bottom of the dashboard. A new key is issued per LIVE (valid ~15 min – 2 h unused).
//   2. The encoder sends video → TikTok shows a preview → "Go LIVE" starts the LIVE.
//   3. "End LIVE" (+ confirmation) ends it.
// Assumptions (unverified, kept deliberately loose): capitalization and "&"/"and" variants, the
// confirmation dialogs, an optional "Streaming software"/"OBS" source choice before the key is
// shown, a masked key with a show toggle (falls back to the Copy button), and the comment list
// markup (borrowed from tiktok.com's LIVE room: data-e2e="chat-message").
// Title limit: 32 characters (https://howmanywords.app/blog/tiktok-character-limits; the
// field's own maxlength wins when it is smaller).

import type { Locator, Page } from 'playwright';

export const URLS = {
  producer: 'https://livecenter.tiktok.com/producer',
  login: 'https://www.tiktok.com/login',
  home: 'https://www.tiktok.com/',
  /** Where the login cookie lives. */
  cookies: ['https://www.tiktok.com', 'https://livecenter.tiktok.com'],
};

/** TikTok's web login cookie (set on .tiktok.com). */
export const SESSION_COOKIES = ['sessionid', 'sessionid_ss'];

export const TITLE_MAX = 32;

const APOS = "['\u2019]"; // straight or curly apostrophe

export const TEXT = {
  // Buttons
  goLive: /^\s*go\s*live\s*$/i,
  saveAndGoLive: /^\s*save\s*(?:&|and)\s*go\s*live\s*$/i,
  save: /^\s*save(?:\s+(?:settings|changes))?\s*$/i,
  editSettings: /^\s*(?:edit(?:\s+(?:live\s+)?settings)?|live\s+settings)\s*$/i,
  endLive: /^\s*end\s*(?:the\s*)?live\s*$/i,
  endConfirm: /^\s*(?:end(?:\s*live)?(?:\s*now)?|confirm|yes)\s*$/i,
  goLiveConfirm: /^\s*(?:go\s*live(?:\s*now)?|confirm|start(?:\s*live)?|continue|ok)\s*$/i,
  generateKey:
    /^\s*(?:(?:re)?generate(?:\s+(?:a\s+|new\s+)?(?:stream\s+)?key)?|(?:get|create)\s+(?:a\s+|new\s+)?(?:stream\s+)?key)\s*$/i,
  revealKey: /show|reveal|unhide|view|eye/i,
  copy: /copy/i,
  /** Source choice some guides mention ("Streaming software" / "OBS" vs. camera/browser). */
  softwareSource:
    /^\s*(?:streaming\s+software|third[-\s]party(?:\s+(?:software|tools?|encoders?))?|obs(?:\s*(?:\/|or)\s*streamlabs)?|(?:use\s+(?:a\s+)?)?stream\s+key|encoder|rtmp)\s*$/i,
  login: /^\s*log\s*in\s*$/i,
  cookieDecline:
    /^\s*(?:decline(?:\s+(?:optional|all|non-essential))?(?:\s+cookies)?|reject(?:\s+(?:all|optional|non-essential))?(?:\s+cookies)?|(?:only\s+)?(?:allow\s+)?(?:essential|necessary)\s+cookies(?:\s+only)?)\s*$/i,
  benignDismiss: /^\s*(?:got\s*it|not\s*now|skip|maybe\s*later|dismiss)\s*$/i,

  // Fields and labels
  titleField: /title/i,
  serverLabel: /^\s*(?:server\s*(?:url|address)|stream\s*url|rtmp\s*(?:url|server))\s*:?\s*\*?\s*$/i,
  keyLabel: /^\s*stream\s*key\s*:?\s*\*?\s*$/i,
  topicLabel: /^\s*(?:live\s+)?(?:topic|category)\s*:?\s*\*?\s*$/i,
  /** What an empty topic picker shows. */
  topicPlaceholder: /^\s*(?:(?:select|choose|add|pick)\b.*|none|-+|\*)?\s*$/i,
  /** Neighbouring labels the topic reader must not mistake for a value. */
  otherFieldLabel: /^\s*(?:title|cover|description|server\s*url|stream\s*key|change|edit|\*)\s*:?\s*$/i,
  /** Words next to a key/URL that are never the value itself. */
  valueSkip: /^(?:copy|copied!?|show|hide|reveal|required|optional|generate|regenerate|refresh|edit|change|new|\*|:)$/i,

  // Messages
  /** Placeholder or error about the topic (checked only after saving failed). */
  topicRequired:
    /(?:select|choose|add|pick)\s+(?:a\s+|the\s+|your\s+)?(?:live\s+)?(?:topic|category)|(?:topic|category)\s+(?:is\s+)?required/i,
  /** An explicit validation error (not the empty picker's placeholder): fail fast on it. */
  topicError:
    /please\s+(?:select|choose|add|pick)\s+(?:a\s+|the\s+|your\s+)?(?:live\s+)?(?:topic|category)|(?:topic|category)\s+(?:is\s+)?required/i,
  noStream: new RegExp(
    [
      'waiting\\s+for\\s+(?:the\\s+|your\\s+)?(?:stream|video|signal|connection|data)',
      'no\\s+(?:stream|video|signal)\\s+(?:detected|received|found)',
      'not\\s+receiving\\s+(?:any\\s+)?(?:video|stream|data)',
      `(?:haven${APOS}t|have\\s+not|hasn${APOS}t|has\\s+not)\\s+(?:received|detected)\\s+(?:any\\s+|your\\s+)?(?:video|stream|signal)`,
    ].join('|'),
    'i',
  ),
  ineligible: new RegExp(
    [
      `\\b(?:not|aren${APOS}t|isn${APOS}t)\\s+(?:yet\\s+)?eligible\\b`,
      `\\b(?:don${APOS}t|do\\s+not|doesn${APOS}t|does\\s+not)\\s+(?:yet\\s+)?have\\s+(?:live\\s+)?(?:access|permission)`,
      '\\bat\\s+least\\s+[\\d.,]+\\s*k?\\s+followers\\b',
      `\\b(?:isn${APOS}t|is\\s+not|not)\\s+(?:yet\\s+)?available\\s+(?:for|to|in)\\s+(?:you|your)\\b`,
    ].join('|'),
    'i',
  ),
};

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

function dialogs(page: Page): Locator {
  return page.getByRole('dialog').or(page.getByRole('alertdialog'));
}

/** The nearest ancestor of the "Stream key" label that holds buttons (Copy / show). */
function keyBlock(page: Page): Locator {
  return page.getByText(TEXT.keyLabel).locator('xpath=ancestor::*[.//button or .//*[@role="button"]][1]').first();
}

export const sel = {
  /**
   * Opens the LIVE settings on the producer start page, and starts the LIVE on the dashboard.
   * Buttons only: www.tiktok.com's sidebar has a "Go LIVE" *link* that just navigates here.
   */
  goLive: (p: Page) => p.getByRole('button', { name: TEXT.goLive }),
  saveAndGoLive: (p: Page) => p.getByRole('button', { name: TEXT.saveAndGoLive }),
  /** "Save & Go LIVE", or a plain "Save" in layouts without it. */
  saveSettings: (p: Page) => p.getByRole('button', { name: TEXT.saveAndGoLive }).or(p.getByRole('button', { name: TEXT.save })),
  editSettings: (p: Page) => p.getByRole('button', { name: TEXT.editSettings }),
  titleInput: (p: Page) =>
    p.getByRole('textbox', { name: TEXT.titleField }).or(p.getByPlaceholder(TEXT.titleField)).or(p.getByLabel(TEXT.titleField)),
  keyLabel: (p: Page) => p.getByText(TEXT.keyLabel),
  /** The stream preview (TikTok may collapse the credentials once video arrives). */
  preview: (p: Page) => p.locator('video'),
  revealKey: (p: Page) => keyBlock(p).getByRole('button', { name: TEXT.revealKey }),
  copyKey: (p: Page) => keyBlock(p).getByRole('button', { name: TEXT.copy }),
  generateKey: (p: Page) => p.getByRole('button', { name: TEXT.generateKey }),
  endLive: (p: Page) => p.getByRole('button', { name: TEXT.endLive }),
  dialogButton: (p: Page, name: RegExp) => dialogs(p).getByRole('button', { name }),
  noStream: (p: Page) => p.getByText(TEXT.noStream),
  topicRequired: (p: Page) => p.getByText(TEXT.topicRequired),
  topicError: (p: Page) => p.getByText(TEXT.topicError),
  softwareSource: (p: Page) =>
    p
      .getByRole('radio', { name: TEXT.softwareSource })
      .or(p.getByRole('tab', { name: TEXT.softwareSource }))
      .or(p.getByRole('option', { name: TEXT.softwareSource }))
      .or(p.getByRole('button', { name: TEXT.softwareSource })),
  ineligible: (p: Page) => p.getByText(TEXT.ineligible),
  loginPrompt: (p: Page) => p.getByRole('button', { name: TEXT.login }).or(p.getByRole('link', { name: TEXT.login })),
  cookieDecline: (p: Page) => p.getByRole('button', { name: TEXT.cookieDecline }),
  benignDismiss: (p: Page) => dialogs(p).getByRole('button', { name: TEXT.benignDismiss }),
};

// ---------------------------------------------------------------------------
// In-page scripts. Plain JavaScript strings (not TS functions) so no transpiler helpers end up
// in the page; regexes are passed as sources.
// ---------------------------------------------------------------------------

function reArg(re: RegExp): { source: string; flags: string } {
  return { source: re.source, flags: re.flags.replace(/[gy]/g, '') };
}

const PAGE_UTILS = `
  const re = (r) => new RegExp(r.source, r.flags);
  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  };
  const labelsFor = (rx) => {
    const out = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const t = (n.textContent || '').trim();
      if (!t || t.length > 40 || !rx.test(t)) continue;
      const el = n.parentElement;
      if (el && visible(el) && !out.includes(el)) out.push(el);
    }
    return out;
  };
`;

const READ_INGEST_SOURCE = `(args) => {
  ${PAGE_UTILS}
  const serverRe = re(args.server);
  const keyRe = re(args.key);
  const skipRe = re(args.skip);
  const rtmpRe = /^rtmps?:\\/\\/[^\\s\\/?#]+\\S*$/i;
  const maskRe = /^[\\u2022\\u25CF\\u00B7\\u2219\\u22C5*]+$|[\\u2022\\u25CF]{3,}/;
  const valuesIn = (root, label) => {
    const out = [];
    for (const input of root.querySelectorAll('input, textarea')) {
      if (input.type === 'hidden') continue;
      const v = String(input.value || '').trim();
      if (v) out.push(v);
    }
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const el = n.parentElement;
      if (!el || label.contains(el) || el.closest('button, [role="button"], script, style, noscript')) continue;
      const v = (n.textContent || '').trim();
      if (!v || skipRe.test(v) || !visible(el)) continue;
      out.push(v);
    }
    return out;
  };
  const near = (label, accept) => {
    let node = label;
    for (let i = 0; i < 5; i++) {
      node = node.parentElement;
      if (!node || node === document.body || node === document.documentElement) return null;
      const v = valuesIn(node, label).find(accept);
      if (v !== undefined) return v;
    }
    return null;
  };
  let serverUrl = null;
  for (const l of labelsFor(serverRe)) {
    serverUrl = near(l, (v) => rtmpRe.test(v));
    if (serverUrl) break;
  }
  if (!serverUrl) {
    // No label found: accept the page's only RTMP URL.
    const all = new Set();
    for (const input of document.querySelectorAll('input, textarea')) {
      const v = String(input.value || '').trim();
      if (rtmpRe.test(v)) all.add(v);
    }
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const v = (n.textContent || '').trim();
      if (rtmpRe.test(v) && n.parentElement && visible(n.parentElement)) all.add(v);
    }
    if (all.size === 1) serverUrl = Array.from(all)[0];
  }
  const isKey = (v) =>
    !rtmpRe.test(v) && !keyRe.test(v) && !serverRe.test(v) && v.length <= 4096 && !/\\s/.test(v) &&
    (maskRe.test(v) ? v.length >= 6 : (v.length >= 8 && /\\d/.test(v)) || v.length >= 16);
  const keyLabels = labelsFor(keyRe);
  let streamKey = null;
  for (const l of keyLabels) {
    streamKey = near(l, isKey);
    if (streamKey) break;
  }
  return { serverUrl, streamKey, masked: !!streamKey && maskRe.test(streamKey), keyLabel: keyLabels.length > 0 };
}`;

export interface IngestScan {
  serverUrl: string | null;
  streamKey: string | null;
  masked: boolean;
  keyLabel: boolean;
}

/** Expression returning IngestScan for the current page. */
export function ingestScript(): string {
  const args = { server: reArg(TEXT.serverLabel), key: reArg(TEXT.keyLabel), skip: reArg(TEXT.valueSkip) };
  return `(${READ_INGEST_SOURCE})(${JSON.stringify(args)})`;
}

const READ_TOPIC_SOURCE = `(args) => {
  ${PAGE_UTILS}
  const labelRe = re(args.label);
  const otherRe = re(args.other);
  const labels = labelsFor(labelRe);
  if (labels.length === 0) return { found: false, value: null };
  for (const label of labels) {
    let node = label;
    for (let i = 0; i < 2; i++) {
      node = node.parentElement;
      if (!node || node === document.body) break;
      for (const s of node.querySelectorAll('select')) {
        const o = s.selectedOptions && s.selectedOptions[0];
        const v = o ? (o.textContent || '').trim() : '';
        if (v) return { found: true, value: v };
      }
      for (const input of node.querySelectorAll('input:not([type="hidden"])')) {
        const v = String(input.value || '').trim();
        if (v) return { found: true, value: v };
      }
      const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        const el = n.parentElement;
        if (!el || label.contains(el) || el.closest('script, style')) continue;
        const v = (n.textContent || '').trim();
        if (!v || otherRe.test(v) || labelRe.test(v) || !visible(el)) continue;
        return { found: true, value: v };
      }
    }
  }
  return { found: true, value: null };
}`;

export interface TopicScan {
  found: boolean;
  value: string | null;
}

/** Expression returning TopicScan (read only: the driver never changes the topic). */
export function topicScript(): string {
  const args = { label: reArg(TEXT.topicLabel), other: reArg(TEXT.otherFieldLabel) };
  return `(${READ_TOPIC_SOURCE})(${JSON.stringify(args)})`;
}

/** Expression returning the logged-in username on a www.tiktok.com page, or null. */
export const USERNAME_SCRIPT = `(() => {
  const valid = (s) => typeof s === 'string' && /^[A-Za-z0-9._]{2,24}$/.test(s.replace(/^@/, '')) ? s.replace(/^@/, '') : null;
  try {
    const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
    if (el) {
      const data = JSON.parse(el.textContent || '{}');
      const scope = (data && data.__DEFAULT_SCOPE__) || {};
      const app = scope['webapp.app-context'] || {};
      const u = valid(app.user && app.user.uniqueId);
      if (u) return u;
    }
  } catch (e) {}
  for (const a of document.querySelectorAll('a[data-e2e="nav-profile"], a[data-e2e="profile-icon"]')) {
    const m = /\\/@([A-Za-z0-9._]+)/.exec(a.getAttribute('href') || '');
    const u = m && valid(m[1]);
    if (u) return u;
  }
  return null;
})()`;

// ---------------------------------------------------------------------------
// Chat (comment panel of the producer)
// ---------------------------------------------------------------------------

const CHAT_PRIMARY = ['[data-e2e="chat-message"]', '[data-e2e="social-message"]', '[data-e2e*="comment-item"]'].join(', ');
const CHAT_FALLBACK = ['[class*="CommentItem"]', '[class*="comment-item"]', '[class*="ChatMessage"]'].join(', ');

export const CHAT_ITEM_SELECTOR = `${CHAT_PRIMARY}, ${CHAT_FALLBACK}`;

/** Extractor for scrapeChat (see browser/helpers.ts). Tolerant: unknown shapes yield null. */
export const CHAT_EXTRACT = `(el) => {
  const PRIMARY = ${JSON.stringify(CHAT_PRIMARY)};
  const FALLBACK = ${JSON.stringify(CHAT_FALLBACK)};
  if (el.parentElement && el.parentElement.closest(PRIMARY)) return null;
  if (!el.matches(PRIMARY)) {
    // Class-based fallback only when the page has no data-e2e items, and only for leaf items.
    if (document.querySelector(PRIMARY) || el.querySelector(FALLBACK)) return null;
  }
  const txt = (n) => (n ? String(n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim() : '');
  const first = (sels) => {
    for (const s of sels) {
      const n = el.querySelector(s);
      if (n && txt(n)) return n;
    }
    return null;
  };
  const authorEl = first([
    '[data-e2e="message-owner-name"]', '[data-e2e*="nickname"]', '[data-e2e*="user-name"]', '[data-e2e*="username"]',
    '[class*="nickname" i]', '[class*="user-name" i]', '[class*="username" i]', '[class*="OwnerName"]', '[class*="EllipsisName"]',
  ]);
  const author = txt(authorEl).replace(/[:\\uFF1A]\\s*$/, '');
  const textEl = first([
    '[data-e2e*="comment-text"]', '[data-e2e*="message-text"]', '[data-e2e*="chat-text"]', '[class*="comment-text" i]',
    '[class*="CommentText"]', '[class*="DivComment"]', '[class*="message-text" i]', '[class*="content-text" i]',
  ]);
  let text = textEl && !(authorEl && textEl.contains(authorEl)) ? txt(textEl) : '';
  if (!text) {
    text = txt(el);
    if (author && text.startsWith(author)) text = text.slice(author.length).replace(/^[\\s:\\uFF1A\\u00B7-]+/, '');
  }
  if (!text) return null;
  const e2e = el.getAttribute('data-e2e') || '';
  const cls = typeof el.className === 'string' ? el.className : '';
  const isEvent = /social|enter|join|gift|like|member|system/i.test(e2e) ||
    /(?:social|gift|enter|join|member|system|like)[-_]?(?:message|item|msg)/i.test(cls);
  const img = el.querySelector('img');
  const avatar = img && /^https?:/.test(img.src || '') ? img.src : undefined;
  const id = el.getAttribute('data-id') || el.getAttribute('data-msg-id') || el.getAttribute('data-message-id') ||
    el.getAttribute('data-comment-id') || null;
  return { id, author: author || (isEvent ? 'TikTok' : ''), text, avatarUrl: avatar, kind: isEvent ? 'event' : 'message' };
}`;
