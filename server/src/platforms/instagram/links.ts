// The live's link (Instagram allows one link per live; Stream Guard rotates through a list).
//
// Best effort everywhere: a link that can't be added never fails the live. The rotation position is
// kept per destination in destinationSecrets ('linkRotation' → { index }) and advances only when a
// link was actually added (never for a test-mode live).

import type { Logger } from 'pino';
import type { Locator, Page } from 'playwright';
import { LINK_TITLE_MAX, type LinkItem } from '../../../../shared/types.js';
import { fillField, humanPause } from '../../browser/helpers.js';
import type { ScopedSecrets } from '../../services.js';
import { truncateTitle } from '../common/http.js';
import { click, visibleNow, waitVisible } from './flow.js';
import {
  CLEAR_ATTR_SOURCE,
  DESCRIBE_CONTROLS_SOURCE,
  LINK_FORM_ARGS,
  LINK_FORM_ATTR,
  LINK_TITLE_ARGS,
  LINK_TITLE_ATTR,
  LINK_TITLE_SOURCE,
  LINK_URL_ATTR,
  MARK_DIALOGS_SOURCE,
  PRE_DIALOG_ATTR,
  RE,
  sel,
  TAG_LINK_FORM_SOURCE,
} from './selectors.js';
import { LINK_ROTATION_KEY, pickLink, shortError, type LinkMode, type LinkRotation } from './util.js';

export type LinkResult = { status: 'added' } | { status: 'not-found' } | { status: 'failed'; reason: string; controls?: unknown };

/**
 * A failed step inside the link form (its message becomes the warning's reason). `controls`: what the
 * form showed (DESCRIBE_CONTROLS_SOURCE), logged so the selectors can be fixed from the server log.
 */
class LinkStepError extends Error {
  constructor(
    message: string,
    readonly controls?: unknown,
  ) {
    super(message);
  }
}

/** The visible controls of the topmost dialog (else the page), or null. */
function describeControls(page: Page): Promise<unknown> {
  return page.evaluate(`(${DESCRIBE_CONTROLS_SOURCE})()`).catch(() => null);
}

const MARK_DIALOGS = `(${MARK_DIALOGS_SOURCE})(${JSON.stringify(LINK_FORM_ARGS)})`;
const TAG_LINK_FORM = `(${TAG_LINK_FORM_SOURCE})(${JSON.stringify(LINK_FORM_ARGS)})`;

function clearAttrs(page: Page, attrs: string[]): Promise<void> {
  return page
    .evaluate(`${JSON.stringify(attrs)}.forEach(${CLEAR_ATTR_SOURCE})`)
    .then(() => undefined)
    .catch(() => undefined);
}

/**
 * Clear the field tags. `done` (the attempt is over): also the pre-click dialog marks, and the
 * link-form tag unless that form is still open (closeLinkForm can then still close it later).
 */
async function clearTags(page: Page, done = false): Promise<void> {
  if (!done) return clearAttrs(page, [LINK_URL_ATTR, LINK_TITLE_ATTR]);
  const attrs = [LINK_URL_ATTR, LINK_TITLE_ATTR, PRE_DIALOG_ATTR];
  if (!(await visibleNow(sel.taggedLinkForm(page)))) attrs.push(LINK_FORM_ATTR);
  await clearAttrs(page, attrs);
}

/** Tag the dialog the "Add link" click opened (see TAG_LINK_FORM_SOURCE); the visible form or null. */
async function tagLinkForm(page: Page): Promise<Locator | null> {
  const tagged = await page.evaluate(TAG_LINK_FORM).catch(() => false);
  return tagged === true ? visibleNow(sel.taggedLinkForm(page)) : null;
}

/** How many visible elements outside the link form show `text` (at most 10 are looked at). */
async function shownOutsideForm(page: Page, text: string): Promise<number> {
  const hits = page.getByText(text, { exact: false }).filter({ visible: true });
  const n = Math.min(10, await hits.count().catch(() => 0));
  let count = 0;
  for (let i = 0; i < n; i++) {
    const inForm = await hits
      .nth(i)
      .evaluate((el, attr) => (el as unknown as { closest(s: string): unknown }).closest(`[${attr}]`) !== null, LINK_FORM_ATTR, {
        timeout: 1_000,
      })
      .catch(() => true);
    if (!inForm) count++;
  }
  return count;
}

async function gone(loc: Locator, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    if (!(await visibleNow(loc))) return true;
    if (Date.now() >= until) return false;
    await humanPause(100, 150);
  }
}

async function textOf(loc: Locator): Promise<string> {
  const text = await loc.innerText({ timeout: 2_000 }).catch(() => '');
  return text.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** "https://www.kick.com/name/" → "kick.com/name" (how a page usually shows a link). */
export function displayUrl(url: string): string {
  return url
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '');
}

/**
 * Close the link form an "Add link" click opened (the tagged dialog), so it never stays over
 * "Next" / "Go live" / "End live video": its own Cancel/Close first, Escape only when that didn't
 * close it. No-op when no such form is open — never a bare Escape, which could close the setup
 * form or the producer instead. Never throws.
 */
export async function closeLinkForm(page: Page): Promise<void> {
  try {
    const form = sel.taggedLinkForm(page);
    if (!(await visibleNow(form))) return;
    const cancel = await visibleNow(form.getByRole('button', { name: RE.linkCancel }), true);
    if (cancel) {
      await cancel.click({ timeout: 3_000 }).catch(() => {});
      if (await gone(form, 1_000)) return;
    }
    await page.keyboard.press('Escape');
    await gone(form, 1_000);
  } catch {
    // best effort
  }
}

/**
 * Link fields inline in the setup form / producer (no form of their own): empty them, so a
 * half-typed link is not submitted with the rest. Escape is not used here (see closeLinkForm).
 */
async function clearInlineFields(page: Page): Promise<void> {
  try {
    if (await visibleNow(sel.taggedLinkForm(page))) return;
    for (const loc of [sel.taggedLinkUrl(page), sel.taggedLinkTitle(page)]) {
      const field = await visibleNow(loc);
      if (field) await field.fill('', { timeout: 2_000 }).catch(() => {});
    }
  } catch {
    // best effort
  }
}

/**
 * In a link-type chooser, pick "Link / Add a URL" (never WhatsApp) and press "Confirm". False when
 * `form` isn't such a chooser; throws when it is but the URL option can't be confirmed.
 */
async function chooseUrlLinkType(form: Locator, signal: AbortSignal): Promise<boolean> {
  const option = await visibleNow(sel.linkTypeExternal(form));
  const confirm = await visibleNow(sel.linkTypeConfirm(form), true);
  if (!option || !confirm) return false;
  await click(option, signal, 5_000);
  // The radio behind the option must now be the checked one (when the form exposes it).
  const radio = sel.linkTypeRadio(form).first();
  if ((await radio.count().catch(() => 0)) > 0) {
    const checked =
      (await radio.isChecked({ timeout: 1_000 }).catch(() => false)) || (await radio.getAttribute('aria-checked').catch(() => null)) === 'true';
    if (!checked) await radio.check({ force: true, timeout: 2_000 }).catch(() => {});
  }
  await humanPause(150, 300, signal);
  if (!(await confirm.isEnabled({ timeout: 1_000 }).catch(() => false))) {
    throw new LinkStepError('Instagram kept "Confirm" disabled after choosing "Link"');
  }
  await click(confirm, signal, 5_000);
  return true;
}

async function fillLinkForm(
  page: Page,
  opener: Locator,
  link: LinkItem,
  signal: AbortSignal,
  stepMs: number,
  state: { clicked: boolean },
): Promise<LinkResult> {
  await page.evaluate(MARK_DIALOGS).catch(() => undefined);
  await click(opener, signal, 5_000);
  state.clicked = true;

  // The form: a dialog that showed up after the click (tagged at once, so it can be closed even
  // when its URL field isn't recognized), else fields inline in the setup form / producer.
  let form: Locator | null = null;
  let urlField: Locator | null = null;
  let fieldDeadline = Date.now() + stepMs;
  let choseType = false;
  for (;;) {
    form = await tagLinkForm(page);
    urlField = await visibleNow(sel.linkUrlInput(form ?? page));
    if (urlField) break;
    // First a link-type chooser ("Link / Add a URL" or "WhatsApp link") + "Confirm": take the URL one.
    if (!choseType && form && (await chooseUrlLinkType(form, signal))) {
      choseType = true;
      fieldDeadline = Date.now() + stepMs;
      continue;
    }
    if (Date.now() >= fieldDeadline) throw new LinkStepError("Instagram's link form has no URL field", await describeControls(page));
    await humanPause(150, 250, signal);
  }
  await clearTags(page);
  await urlField.evaluate(
    (el, attr) => (el as unknown as { setAttribute(n: string, v: string): void }).setAttribute(attr, ''),
    LINK_URL_ATTR,
  );

  // Title/label field, when the form has one (else Instagram only takes the URL).
  const hasTitle = (await page.evaluate(`(${LINK_TITLE_SOURCE})(${JSON.stringify(LINK_TITLE_ARGS)})`).catch(() => false)) === true;
  if (hasTitle && link.title) {
    const field = sel.taggedLinkTitle(page);
    const maxAttr = await field.getAttribute('maxlength', { timeout: 2_000 }).catch(() => null);
    const max = maxAttr ? Number.parseInt(maxAttr, 10) : NaN;
    const limit = Number.isFinite(max) && max > 0 ? Math.min(max, LINK_TITLE_MAX) : LINK_TITLE_MAX;
    await fillField(field, truncateTitle(link.title, limit), { signal, timeoutMs: 8_000, minDelayMs: 20, maxDelayMs: 60 });
  }
  await fillField(sel.taggedLinkUrl(page), link.url, { signal, timeoutMs: 8_000, minDelayMs: 15, maxDelayMs: 45 });

  const dialog = form ?? (await visibleNow(sel.linkDialog(page), true));
  // Fields inline in the setup form: its "Next" submits the link with the rest.
  if (!form && dialog && (await visibleNow(dialog.getByRole('button', { name: RE.next })))) return { status: 'added' };

  const submit = sel.linkSubmit(dialog ?? page);
  const deadline = Date.now() + stepMs;
  let target: Locator | null;
  for (;;) {
    target = await visibleNow(submit, true);
    if (target && (await target.isEnabled({ timeout: 1_000 }).catch(() => false))) break;
    const error = await visibleNow(sel.linkError(page));
    if (error) throw new LinkStepError(`Instagram said: ${await textOf(error)}`);
    if (Date.now() >= deadline) {
      throw new LinkStepError(
        target ? 'Instagram kept the link\'s "Add" button disabled' : 'no "Add" button in the link form',
        await describeControls(page),
      );
    }
    await humanPause(150, 250, signal);
  }
  // Text already on the page (e.g. the live's title holding the same address) proves nothing.
  const display = displayUrl(link.url);
  const shownBefore = await shownOutsideForm(page, display);
  await click(target, signal, 5_000);

  // Accepted once the form is gone, or (fields inline in the page) once the link shows up on the
  // page; an error message = refused. Never 'added' while the form is still open over the page.
  const until = Date.now() + stepMs;
  for (;;) {
    const error = await visibleNow(sel.linkError(page));
    if (error) throw new LinkStepError(`Instagram said: ${await textOf(error)}`);
    if (!(await visibleNow(form ?? sel.taggedLinkUrl(page)))) return { status: 'added' };
    if ((await shownOutsideForm(page, display)) > shownBefore) {
      if (!form) return { status: 'added' };
      // Shown on the page but the form stayed open: close it; the link counts only once it's gone.
      await closeLinkForm(page);
      if (!(await visibleNow(form))) return { status: 'added' };
      throw new LinkStepError("Instagram's link form wouldn't close");
    }
    if (Date.now() >= until) {
      throw new LinkStepError(form ? "Instagram's link form stayed open after adding the link" : "Instagram didn't accept the link");
    }
    await humanPause(200, 300, signal);
  }
}

/**
 * Add `link` through an "Add link" control on the current page. `findMs` = how long to look for
 * the control (0 = only what is visible now). 'not-found' = no such control here (try a later
 * step); 'failed' = the control was there but Instagram did not take the link. Only an abort
 * rejects.
 */
export async function addLiveLink(
  page: Page,
  link: LinkItem,
  signal: AbortSignal,
  opts: { findMs: number; stepMs: number },
): Promise<LinkResult> {
  const opener =
    opts.findMs > 0 ? await waitVisible(sel.addLinkButton(page), page, opts.findMs, signal) : await visibleNow(sel.addLinkButton(page));
  if (!opener) return { status: 'not-found' };
  const state = { clicked: false };
  // Which control was taken for "Add link" (its role/name/text), for the log when the form fails.
  const openerText = await opener
    .evaluate((el) => {
      const e = el as unknown as { tagName: string; getAttribute(n: string): string | null; textContent: string | null };
      return `${e.tagName.toLowerCase()} ${e.getAttribute('role') ?? ''} ${e.getAttribute('aria-label') ?? ''} "${(e.textContent ?? '').trim().slice(0, 60)}"`;
    })
    .catch(() => null);
  try {
    return await fillLinkForm(page, opener, link, signal, opts.stepMs, state);
  } catch (err) {
    const controls = err instanceof LinkStepError && err.controls !== undefined ? { opener: openerText, form: err.controls } : undefined;
    // Also on abort and when no URL field was recognized: never leave the form over "Next" /
    // "Go live". A form that only showed up late is still found once the opener was clicked.
    if (state.clicked) await tagLinkForm(page);
    await closeLinkForm(page);
    await clearInlineFields(page);
    if (signal.aborted) throw err;
    return { status: 'failed', reason: err instanceof LinkStepError ? err.message : shortError(err), ...(controls ? { controls } : {}) };
  } finally {
    await clearTags(page, true);
  }
}

export type LinkStage = 'setup' | 'producer' | 'live';

/**
 * The link for one live: tries each stage until the link is added or fails, persists the rotation
 * on success and keeps a warning for the health watcher when it couldn't be added.
 */
export class LiveLink {
  private state: 'pending' | 'added' | 'failed' | 'none';
  private problem: string | null = null;

  private constructor(
    readonly link: LinkItem | null,
    private readonly nextIndex: number | null,
    private readonly secrets: ScopedSecrets | null,
    private readonly memory: Map<string, number>,
    private readonly destinationId: string,
    private readonly log: Logger,
  ) {
    this.state = link ? 'pending' : 'none';
  }

  /**
   * Pick the link for a new live: `rotate` uses links[index % n] (index from destinationSecrets,
   * or `memory` when there is no secret store), `first` links[0], `off`/empty list none.
   * `advance: false` (test mode): the link is still added, but the rotation position is left as is.
   */
  static async choose(
    links: LinkItem[],
    mode: LinkMode,
    secrets: ScopedSecrets | null,
    memory: Map<string, number>,
    destinationId: string,
    log: Logger,
    opts: { advance?: boolean } = {},
  ): Promise<LiveLink> {
    let stored: unknown = memory.get(destinationId);
    if (mode === 'rotate' && links.length > 0 && secrets) {
      try {
        stored = (await secrets.getJson<LinkRotation>(LINK_ROTATION_KEY))?.index;
      } catch (err) {
        log.warn({ error: shortError(err) }, 'reading the Instagram link rotation failed; starting at the first link');
      }
    }
    const pick = pickLink(links, mode, stored);
    const nextIndex = opts.advance === false ? null : (pick?.nextIndex ?? null);
    return new LiveLink(pick?.link ?? null, nextIndex, secrets, memory, destinationId, log);
  }

  get pending(): boolean {
    return this.state === 'pending';
  }

  /** Warning for the destination card while the link couldn't be added (null = fine). */
  get warning(): string | null {
    return this.problem;
  }

  /**
   * Try to add the link at this stage. `final` = last chance: not finding the control is then a
   * failure. Never throws except on abort.
   */
  async attempt(page: Page, stage: LinkStage, signal: AbortSignal, opts: { findMs: number; stepMs: number; final: boolean }): Promise<void> {
    if (this.state !== 'pending' || !this.link) return;
    let result: LinkResult;
    try {
      result = await addLiveLink(page, this.link, signal, opts);
    } catch (err) {
      if (signal.aborted) throw err;
      result = { status: 'failed', reason: shortError(err) };
    }
    if (result.status === 'added') {
      this.state = 'added';
      this.problem = null;
      this.log.info({ stage }, 'link added to the Instagram live');
      this.log.debug({ url: this.link.url }, 'Instagram live link');
      await this.advance();
      return;
    }
    if (result.status === 'not-found' && !opts.final) return;
    this.state = 'failed';
    const reason = result.status === 'failed' ? result.reason : 'no "Add link" option found on Instagram';
    this.problem = `Couldn't add the link "${this.link.title || 'link'}" to the Instagram live: ${reason}`;
    const controls = result.status === 'failed' ? result.controls : undefined;
    this.log.warn({ stage, reason, ...(controls ? { controls } : {}) }, 'adding the link to the Instagram live failed; the live goes on without it');
  }

  /** Give up (e.g. no time left): the link is reported as not added. */
  skip(reason: string): void {
    if (this.state !== 'pending' || !this.link) return;
    this.state = 'failed';
    this.problem = `Couldn't add the link "${this.link.title || 'link'}" to the Instagram live: ${reason}`;
    this.log.warn({ reason }, 'the Instagram live link was not added');
  }

  private async advance(): Promise<void> {
    if (this.nextIndex === null) return;
    this.memory.set(this.destinationId, this.nextIndex);
    if (!this.secrets) return;
    try {
      await this.secrets.setJson(LINK_ROTATION_KEY, { index: this.nextIndex } satisfies LinkRotation);
    } catch (err) {
      this.log.warn({ error: shortError(err) }, 'saving the Instagram link rotation failed');
    }
  }
}
