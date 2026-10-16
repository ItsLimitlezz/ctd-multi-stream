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
//
// Stream Guard (takedown detection, see health.ts). TikTok publishes no wording for the notices it
// shows when it ends a LIVE; creators report (October 2026) red in-LIVE banners about "potentially
// harmful" content, "LIVE access suspended for repeated violations of Community Guidelines", LIVEs
// "interrupted" for violations, copyright/unoriginal-content enforcement that mutes or ends the
// LIVE, and a violations page at livecenter.tiktok.com/violation:
//   https://steadystate1.substack.com/p/tiktok-technical-issues-or-platform
//   https://itch.io/post/11880374
//   https://support.streamlabs.com/hc/en-us/articles/35259691237147-TikTok-Live-Streaming-Access-Revoked-No-Violations
//   https://sociallyin.com/blog/tiktok-live-stream-rules/
// So the matchers are deliberately loose but split by meaning: "the LIVE ended/was removed/suspended"
// (hard signal), "interrupted/paused" (a takedown unless the notice blames the connection or is
// waiting for the stream, with no violation wording: OBS dropping out must not start a new LIVE), violation warnings while the LIVE still runs (warning
// only: TikTok often warns before ending), and network notices (warning only). Viewer comments are
// never scanned. The viewer count label ("Viewers" next to a number, or "12 viewers") is also an
// assumption; when it can't be read the 0-viewer rule never fires.

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
/** "LIVE", "LIVE video", "LIVE stream"... as TikTok names a broadcast. */
const LIVE_WORD = 'live(?:\\s+(?:video|stream|broadcast|session))?';

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

  // Stream Guard notices (health.ts classifies them; see the header for sources)
  /** TikTok ended the LIVE for good: ended / removed / suspended / LIVE access revoked. */
  liveEnded: new RegExp(
    [
      `\\b${LIVE_WORD}\\s+(?:has\\s+)?ended\\b`,
      `\\b${LIVE_WORD}\\s+(?:has\\s+been|was|is|got)\\s+(?:ended|terminated|removed|suspended|banned|shut\\s+down|taken\\s+down|closed|cancell?ed)\\b`,
      `\\b(?:ended|terminated|removed|suspended|shut\\s+down|took\\s+down)\\s+(?:your|this|the)\\s+${LIVE_WORD}\\b`,
      `\\b${LIVE_WORD}\\s+(?:access|feature|privileges?)\\s+(?:has\\s+been\\s+|was\\s+|is\\s+)?(?:suspended|revoked|removed|restricted|banned|disabled)\\b`,
      `\\b(?:banned|suspended|restricted)\\s+from\\s+(?:going\\s+)?live\\b`,
    ].join('|'),
    'i',
  ),
  /**
   * TikTok interrupted/paused the LIVE: a takedown, unless the notice blames the connection or says
   * TikTok is waiting for the stream (and gives no policy/copyright reason).
   */
  liveInterrupted: new RegExp(
    [
      `\\b${LIVE_WORD}\\s+(?:has\\s+been|was|is|got)\\s+(?:interrupted|paused|stopped|cut\\s+off|disrupted)\\b`,
      `\\b(?:interrupted|paused|stopped)\\s+(?:your|this|the)\\s+${LIVE_WORD}\\b`,
      `\\b${LIVE_WORD}\\s+(?:interrupted|paused)\\b`,
    ].join('|'),
    'i',
  ),
  /** Policy / copyright wording. Alone (LIVE still running) it is a warning, not a takedown. */
  liveViolation: new RegExp(
    [
      '\\bviolat(?:e|es|ed|ing|ion|ions)\\b',
      '\\binfring',
      '\\bunoriginal\\b',
      '\\bintellectual\\s+property\\b',
      'copyright(?:ed)?\\s+(?:content|music|audio|sound|material|works?|claims?|strikes?|issues?|protected)',
      '(?:copyright|music|audio|sound)\\s+(?:was\\s+|has\\s+been\\s+|is\\s+)?(?:detected|muted|claimed)',
      '\\bmuted\\s+(?:your\\s+|the\\s+)?(?:live|audio|sound)\\b',
      '\\bagainst\\s+(?:our\\s+)?community\\s+guidelines\\b',
    ].join('|'),
    'i',
  ),
  /** Encoder / network trouble (OBS or the network dropped out): never a takedown by itself. */
  connectionIssue: new RegExp(
    [
      '\\b(?:poor|weak|unstable|lost|bad|slow)\\s+(?:network|connection|internet|signal)',
      '\\b(?:network|connection|internet)\\s+(?:is\\s+|was\\s+)?(?:unstable|lost|issues?|problems?|errors?|interrupted|disconnected)',
      '\\breconnect',
      '\\bdisconnected\\b',
      '\\bno\\s+(?:video|stream|signal|data)\\s+(?:detected|received)',
      '\\b(?:stream|video|signal|encoder)\\s+(?:was\\s+|has\\s+been\\s+)?(?:interrupted|lost|disconnected|stopped)',
      '\\bnot\\s+receiving\\b',
    ].join('|'),
    'i',
  ),
  /**
   * "Check your encoder / network" advice: blames the feed, not the content. Only used to classify an
   * interrupted/paused notice (health.ts), never to find notices on the page.
   */
  checkEncoder:
    /\bcheck\s+(?:your\s+|the\s+)?(?:streaming\s+(?:software|settings)|stream\s+settings|encoder|obs|(?:network|internet)(?:\s+connection)?|connection)\b/i,
  /** A "current viewers" stat label (not total/unique/peak viewers). */
  viewersLabel: /^\s*(?:(?:current|live|concurrent|real[-\s]?time)\s+)?(?:viewers?|viewing(?:\s+now)?|watching(?:\s+now)?)\s*:?\s*$/i,
  /** "12 viewers", "1.2K watching", "Viewers: 12" in one text. Group 1 or 2 = the number. */
  viewersInline:
    /^\s*(?:([\d.,]+\s*[kmb]?)\+?\s+(?:(?:current\s+)?viewers?|watching(?:\s+now)?|viewing(?:\s+now)?)|(?:current\s+)?viewers?\s*:\s*([\d.,]+\s*[kmb]?)\+?)\s*$/i,
  /** Buttons that close a "your LIVE ended" notice (never Share / View / Appeal). */
  noticeDismiss: /^\s*(?:ok(?:ay)?|got\s*it|close|done|dismiss|i\s+understand|understood|acknowledge)\s*$/i,
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
  /** OK / Close on a leftover "your LIVE ended / violated..." dialog (from a LIVE TikTok killed). */
  endedNoticeDismiss: (p: Page) =>
    dialogs(p)
      .or(p.locator('[aria-modal="true"]'))
      .filter({ hasText: ENDED_NOTICE })
      .getByRole('button', { name: TEXT.noticeDismiss }),
};

/** Any "LIVE ended / interrupted / violation" wording (for dialogs to dismiss before a new LIVE). */
const ENDED_NOTICE = new RegExp([TEXT.liveEnded.source, TEXT.liveInterrupted.source, TEXT.liveViolation.source].join('|'), 'i');

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
  // "<name> joined": a presence line, not a gift/like/system notice.
  const join = isEvent && (/enter|join/i.test(e2e + ' ' + cls) || /\\bjoined\\b\\.?$/i.test(text));
  return { id, author: author || (isEvent ? 'TikTok' : ''), text, avatarUrl: avatar, kind: isEvent ? 'event' : 'message', join };
}`;

// ---------------------------------------------------------------------------
// Stream Guard: notices + viewer count on the producer page (classified in health.ts)
// ---------------------------------------------------------------------------

/** Viewer comments: never read as notices (a viewer typing "LIVE ended" must not end the LIVE). */
const CHAT_ITEMS = `${CHAT_ITEM_SELECTOR}, [role="log"]`;
/** Anything that looks like the comment panel; skipped too unless the text is in a dialog/toast. */
const CHAT_AREA = [CHAT_ITEMS, '[data-e2e*="chat" i]', '[data-e2e*="comment" i]', '[class*="comment" i]', '[class*="chat" i]'].join(
  ', ',
);

/** Controls, navigation and form fields: their text is never a notice ("Violations" menu item, the title field...). */
const NOT_NOTICE = [
  CHAT_ITEMS,
  'script, style, noscript, template, input, textarea, select, option, label, button, a, nav, header, footer',
  '[contenteditable="true"], [role="button"], [role="link"], [role="navigation"], [role="menu"], [role="menuitem"]',
  '[role="tab"], [role="tablist"], [role="option"], [role="listbox"], [role="textbox"]',
].join(', ');

const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="alert"]',
  '[role="status"]',
  '[aria-modal="true"]',
  '[aria-live="assertive"]',
  '[aria-live="polite"]',
].join(', ');

const HEALTH_SCAN_SOURCE = `(args) => {
  ${PAGE_UTILS}
  const noticeRes = args.notices.map(re);
  const keywordRe = /live|violat|copyright|infring|guideline|unoriginal|propert|suspend|interrupt|terminat|banned|removed|ended|paus|stopp|mute|network|connect|internet|signal|detect|receiv|video|stream|encoder/i;
  const labelRe = re(args.viewersLabel);
  const inlineRe = re(args.viewersInline);
  const countRe = /^[\\d.,]+\\s*[kmb]?\\+?$/i;
  const overlayClassRe = /toast|snackbar|banner|notice|notification|modal|popup|popover|alert/i;
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const isOverlay = (el) => {
    if (el.closest(args.overlay)) return true;
    let n = el;
    for (let i = 0; n && n !== document.body && i < 8; i++, n = n.parentElement) {
      const c = typeof n.className === 'string' ? n.className : '';
      if (c && overlayClassRe.test(c)) return true;
    }
    return false;
  };
  // A sentence split over inline elements ("Your LIVE <b>was ended</b>") is read from its block.
  const blockOf = (el) => {
    let b = el;
    while (b.parentElement && b.parentElement !== document.body) {
      const d = getComputedStyle(b).display;
      if (d !== 'inline' && d !== 'contents') break;
      b = b.parentElement;
    }
    return b;
  };

  const notices = [];
  const seen = new Set();
  const tooLong = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode()) && notices.length < 30) {
    const own = norm(node.textContent);
    if (own.length < 3 || !keywordRe.test(own)) continue;
    const el = node.parentElement;
    if (!el || el.closest(args.notNotice)) continue;
    // The sentence's block, or just the element when that block is a whole page section.
    let block = blockOf(el);
    if (tooLong.has(block)) block = el;
    if (seen.has(block)) continue;
    let text = norm(block.innerText || block.textContent);
    if (text.length > 300 && block !== el) {
      tooLong.add(block);
      block = el;
      if (seen.has(block)) continue;
      text = norm(el.innerText || el.textContent);
    }
    seen.add(block);
    if (!text || text.length > 300 || !visible(block)) continue;
    if (block.closest(args.chat) || block.querySelector(args.chat)) continue;
    const overlay = isOverlay(block);
    if (!overlay && block.closest(args.chatArea)) continue;
    if (!noticeRes.some((r) => r.test(text))) continue;
    notices.push({ text, overlay });
  }

  // Current viewers: a "Viewers" label with exactly one number next to it (else ambiguous: unreadable).
  const valueNear = (label) => {
    let n = label;
    for (let i = 0; i < 2; i++) {
      n = n.parentElement;
      if (!n || n === document.body) return null;
      const values = [];
      const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
      let t;
      while ((t = w.nextNode())) {
        const el = t.parentElement;
        if (!el || label.contains(el) || el.closest(args.chat)) continue;
        const v = norm(t.textContent);
        if (v && countRe.test(v) && visible(el)) values.push(v);
      }
      if (values.length === 1) return values[0];
      if (values.length > 1) return null;
    }
    return null;
  };
  let viewers = null;
  for (const label of labelsFor(labelRe)) {
    if (label.closest(args.chat)) continue;
    viewers = valueNear(label);
    if (viewers) break;
  }
  if (!viewers) {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = w.nextNode())) {
      const v = norm(t.textContent);
      if (!v || v.length > 40) continue;
      const m = inlineRe.exec(v);
      const el = t.parentElement;
      if (m && el && !el.closest(args.chat) && visible(el)) {
        viewers = m[1] || m[2] || null;
        break;
      }
    }
  }
  if (!viewers) {
    for (const el of document.querySelectorAll('[aria-label]')) {
      const m = inlineRe.exec(norm(el.getAttribute('aria-label')));
      if (m && !el.closest(args.chat) && visible(el)) {
        viewers = m[1] || m[2] || null;
        break;
      }
    }
  }
  return { notices, viewers };
}`;

export interface HealthScan {
  /** Visible texts outside chat/controls that look like a LIVE notice; `overlay` = in a dialog/toast/banner. */
  notices: { text: string; overlay: boolean }[];
  /** Raw current-viewers value ("12", "1.2K"), or null when not found. */
  viewers: string | null;
}

/** Expression returning HealthScan for the current page. */
export function healthScanScript(): string {
  const args = {
    notices: [TEXT.liveEnded, TEXT.liveInterrupted, TEXT.liveViolation, TEXT.connectionIssue].map(reArg),
    viewersLabel: reArg(TEXT.viewersLabel),
    viewersInline: reArg(TEXT.viewersInline),
    chat: CHAT_ITEMS,
    chatArea: CHAT_AREA,
    notNotice: NOT_NOTICE,
    overlay: OVERLAY_SELECTOR,
  };
  return `(${HEALTH_SCAN_SOURCE})(${JSON.stringify(args)})`;
}
