// Every facebook.com locator / text used by profile mode (EXPERIMENTAL).
//
// Not verified against a logged-in session (Oct 2026). Sources for the expected UI:
// - Help Center "Go live using streaming software" (https://www.facebook.com/help/587160588142067):
//   facebook.com/live/create → "Go live" → video source "Streaming software" → Advanced settings
//   "Persistent stream key" → stream preview appears → "Add post details" (title, description) →
//   "Go Live Now" / "Go live".
// - Live Producer lives at facebook.com/live/producer; users report that with a persistent key the
//   preview appears but "Go live" must still be clicked (OBS forum thread 158909).
// Assumptions:
// - The account's Facebook UI language is English (Facebook ignores the browser locale for
//   logged-in users). Other languages: title / Go live / chat automation won't find its targets.
// - Buttons expose accessible names ("Go live", "End live video"); the title is a textbox whose
//   accessible name or placeholder starts with "Title"; comments are role="article" nodes labelled
//   "Comment by <name> …" with a permalink containing comment_id=.
// When Facebook changes its UI, update this file only.

import type { Locator, Page } from 'playwright';

export const FACEBOOK_ORIGIN = 'https://www.facebook.com';
export const LOGIN_URL = 'https://www.facebook.com/login';
export const PRODUCER_URL = 'https://www.facebook.com/live/producer';
export const PROFILE_URL = 'https://www.facebook.com/me';
/** Session cookies of a logged-in facebook.com browser (user id + session). */
export const SESSION_COOKIES = ['c_user', 'xs'] as const;

export const sel = {
  /** Logged-out: login form or "Log in" button. */
  loginForm: (p: Page): Locator =>
    p.locator('form input[name="pass"]').or(p.getByRole('button', { name: /^log ?in$/i })),

  /**
   * Producer landing: entry into the live setup. Only used when no setup marker is visible; enabled
   * buttons only, so the (disabled until the preview arrives) final "Go live" is not mistaken for it.
   */
  createLiveEntry: (p: Page): Locator =>
    p
      .getByRole('button', { name: /^(go live|create live video|live video)$/i, disabled: false })
      .or(p.getByRole('link', { name: /^(go live|create live video)$/i })),

  /** Video source option "Streaming software" (radio card / tab / button depending on the layout). */
  streamingSoftware: (p: Page): Locator =>
    p
      .getByRole('radio', { name: /streaming software/i })
      .or(p.getByRole('tab', { name: /streaming software/i }))
      .or(p.getByRole('button', { name: /^streaming software/i })),

  /** "Add post details": the title box. */
  titleField: (p: Page): Locator =>
    p.getByRole('textbox', { name: /^title/i }).or(p.getByPlaceholder(/^title/i)),

  /** Fallback when there is no separate title box: the post description. */
  descriptionField: (p: Page): Locator =>
    p.getByRole('textbox', { name: /description|say something/i }).or(p.getByPlaceholder(/description|say something/i)),

  /** Final "Go live" button (disabled until the stream preview arrives). */
  goLiveButton: (p: Page): Locator => p.getByRole('button', { name: /^go live( now)?$/i }),

  /** Confirmation dialog that sometimes follows "Go live". */
  goLiveConfirm: (p: Page): Locator => p.getByRole('dialog').getByRole('button', { name: /^go live( now)?$/i }),

  /** Present while the live is on air. */
  endLiveButton: (p: Page): Locator => p.getByRole('button', { name: /^end live( video)?$/i }),

  /** "End live video?" confirmation. */
  endLiveConfirm: (p: Page): Locator => p.getByRole('dialog').getByRole('button', { name: /^end( live( video)?)?$/i }),

  /** Saves post-detail edits made while live. */
  saveButton: (p: Page): Locator => p.getByRole('button', { name: /^(save|update)$/i }),

  /** Comments panel of Live Producer. */
  commentsPanel: (p: Page): Locator =>
    p
      .getByRole('heading', { name: /^(live )?comments$/i })
      .or(p.getByRole('tab', { name: /^comments$/i }))
      .or(p.getByRole('region', { name: /comments/i })),
};

/** Comment nodes (CSS, used by the in-page chat scanner). */
export const CHAT_ITEM_SELECTOR = '[role="article"]';

/**
 * Runs in the page for each comment node (plain JS string, no closures). Returns null for nodes that
 * are not comments (other articles). Prefers the stable comment id from the comment permalink.
 */
export const CHAT_EXTRACT = `(el) => {
  const label = (el.getAttribute('aria-label') || '').trim();
  const byLabel = /^(?:comment|reply) by (.+?)(?:\\s+(?:(?:\\d+|an?)\\s+(?:second|minute|hour|day|week|month|year)s?\\s+ago|just now))?$/i.exec(label);
  const own = (node) => node.closest('[role="article"]') === el;
  const link = Array.from(el.querySelectorAll('a[href*="comment_id="]')).find(own) || null;
  if (!byLabel && !link) return null;
  let id = null;
  if (link) {
    try {
      const u = new URL(link.getAttribute('href'), location.href);
      id = u.searchParams.get('reply_comment_id') || u.searchParams.get('comment_id');
    } catch (e) { id = null; }
  }
  let author = '';
  for (const a of el.querySelectorAll('a[role="link"], a[href]')) {
    if (!own(a) || a === link) continue;
    const t = (a.innerText || a.textContent || '').trim();
    if (t) { author = t; break; }
  }
  if (!author && byLabel) author = byLabel[1].trim();
  const parts = [];
  for (const d of el.querySelectorAll('div[dir="auto"]')) {
    if (!own(d) || d.closest('a')) continue;
    if (d.parentElement && d.parentElement.closest('div[dir="auto"]') && own(d.parentElement.closest('div[dir="auto"]'))) continue;
    const t = (d.innerText || d.textContent || '').trim();
    if (t && t !== author) parts.push(t);
  }
  const text = parts.join(' ');
  if (!text) return null;
  return { id: id, author: author || 'Facebook user', text: text };
}`;

/** "(3) Jane Doe | Facebook" → "Jane Doe"; null for generic titles. */
export function profileNameFromTitle(title: string): string | null {
  const name = title
    .replace(/^\(\d+\+?\)\s*/, '')
    .replace(/\s*[|·-]\s*Facebook\s*$/i, '')
    .trim();
  if (!name || /^facebook$/i.test(name) || /^(log in|login|home|watch)\b/i.test(name)) return null;
  return name.slice(0, 100);
}
