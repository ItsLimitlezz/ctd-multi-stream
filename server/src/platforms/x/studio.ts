// Browser flows on X Live Studio: read the handle, create a livestream + press "Go live",
// edit the title while live, end the livestream. Selectors live in selectors.ts.

import type { Logger } from 'pino';
import type { Locator, Page } from 'playwright';
import { abortable, clickWhenEnabled, fillField, humanPause, waitForAny } from '../../browser/helpers.js';
import { DriverError } from '../types.js';
import { BROADCAST_ID_RES, HANDLE_HREF_RE, LOGIN_PATH_RE, sel, type XUrls } from './selectors.js';

export interface XTimings {
  /** One page navigation. */
  navMs: number;
  /** Live Studio / a form step rendering. */
  stepMs: number;
  /** Whole create + go-live flow; below the orchestrator's 180 s confirm budget. */
  goLiveMs: number;
  /** After pressing "Go live": the button is gone but no live marker was recognized. */
  assumeLiveMs: number;
  /** Title edit / end flows; below the orchestrator's 30 s budgets. */
  editMs: number;
  endMs: number;
  /** Reading the @handle after login. */
  handleMs: number;
  /** Chat: how often to check whether the broadcast id became known. */
  chatWaitMs: number;
  /** Typing delay per character (ms). */
  typeMinMs: number;
  typeMaxMs: number;
}

export const DEFAULT_TIMINGS: XTimings = {
  navMs: 45_000,
  stepMs: 30_000,
  goLiveMs: 170_000,
  assumeLiveMs: 15_000,
  editMs: 25_000,
  endMs: 25_000,
  handleMs: 20_000,
  chatWaitMs: 30_000,
  typeMinMs: 30,
  typeMaxMs: 110,
};

export interface FlowOptions {
  urls: XUrls;
  timings: XTimings;
  signal: AbortSignal;
  log: Logger;
}

export const SESSION_EXPIRED = 'X session expired — log in again from Accounts';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** True when `url` is one of X's login/signup pages (any host, so local fixtures work too). */
export function isLoginUrl(url: string): boolean {
  try {
    return LOGIN_PATH_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** First broadcast id found in a list of URLs / texts (page URL, link hrefs, input values). */
export function extractBroadcastId(candidates: readonly string[]): string | null {
  for (const re of BROADCAST_ID_RES) {
    for (const c of candidates) {
      const m = re.exec(c);
      if (m?.[1]) return m[1];
    }
  }
  return null;
}

/** Handle from the profile link href ("/jack" → "jack"), or null. */
export function handleFromHref(href: string | null | undefined): string | null {
  if (!href) return null;
  let path = href;
  try {
    path = new URL(href, 'https://x.com').pathname;
  } catch {
    return null;
  }
  return HANDLE_HREF_RE.exec(path)?.[1] ?? null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n', 1)[0] ?? '';
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function isShown(locator: Locator): Promise<boolean> {
  try {
    return await locator.filter({ visible: true }).first().isVisible();
  } catch {
    return false;
  }
}

async function isClickable(locator: Locator): Promise<boolean> {
  const first = locator.filter({ visible: true }).first();
  try {
    return (await first.isVisible()) && (await first.isEnabled({ timeout: 1000 }));
  } catch {
    return false;
  }
}

async function isEditable(locator: Locator): Promise<boolean> {
  const first = locator.filter({ visible: true }).first();
  try {
    return (await first.isVisible()) && (await first.isEditable({ timeout: 1000 }));
  } catch {
    return false;
  }
}

/** Abortable sleep that resolves false instead of throwing when aborted. */
export function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(ok);
    };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Navigate and fail with needs-login when X bounces to its login page. */
export async function open(page: Page, url: string, opts: FlowOptions): Promise<void> {
  await abortable(page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timings.navMs }), opts.signal);
  if (isLoginUrl(page.url())) throw new DriverError(SESSION_EXPIRED, 'needs-login');
}

/** Navigate unless the page is already there (ignoring query/hash). */
async function ensureOn(page: Page, url: string, opts: FlowOptions): Promise<void> {
  const strip = (u: string) => u.replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (strip(page.url()) !== strip(url)) await open(page, url, opts);
}

/** Broadcast id from the page URL, link hrefs and input values. */
export async function findBroadcastId(page: Page): Promise<string | null> {
  const found = await page
    .evaluate(
      `(() => {
        const out = [location.href];
        for (const a of document.querySelectorAll('a[href]')) out.push(a.href);
        for (const i of document.querySelectorAll('input, textarea')) if (typeof i.value === 'string') out.push(i.value);
        return out.slice(0, 2000);
      })()`,
    )
    .catch(() => [page.url()]);
  return extractBroadcastId(Array.isArray(found) ? found.map(String) : [page.url()]);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** Open X home and read the @handle from the profile tab. Throws needs-login when logged out. */
export async function readHandle(page: Page, opts: FlowOptions): Promise<string | null> {
  await open(page, opts.urls.home, opts);
  const which = await waitForAny(page, { profile: sel.profileLink(page), login: sel.loginForm(page) }, {
    timeoutMs: opts.timings.handleMs,
    signal: opts.signal,
  });
  if (which === 'login' || isLoginUrl(page.url())) throw new DriverError(SESSION_EXPIRED, 'needs-login');
  return handleFromHref(await sel.profileLink(page).first().getAttribute('href'));
}

/** Open Live Studio; resolves when "New Livestream" is available. */
export async function openStudio(page: Page, opts: FlowOptions): Promise<void> {
  await open(page, opts.urls.liveStudio, opts);
  const which = await waitForAny(
    page,
    { ready: sel.newLivestream(page), notEligible: sel.notEligible(page), login: sel.loginForm(page) },
    { timeoutMs: opts.timings.stepMs, signal: opts.signal },
  ).catch((err: unknown) => {
    if (err instanceof DriverError && err.code === 'timeout') {
      throw new DriverError('X Live Studio did not load (no "New Livestream" button found)', 'timeout');
    }
    throw err;
  });
  if (which === 'login' || isLoginUrl(page.url())) throw new DriverError(SESSION_EXPIRED, 'needs-login');
  if (which === 'notEligible') {
    // An upsell can render before the studio itself (e.g. a nav item): give the studio a moment.
    const ready = await waitForAny(page, { ready: sel.newLivestream(page) }, { timeoutMs: 4000, signal: opts.signal }).catch(
      (err: unknown) => {
        if (opts.signal.aborted) throw err;
        return null;
      },
    );
    if (ready) return;
    throw new DriverError(
      'X Live Studio is not available for this account (it needs X Premium, a public account and a supported region)',
      'not-eligible',
    );
  }
}

// ---------------------------------------------------------------------------
// Go live
// ---------------------------------------------------------------------------

export interface GoLiveInput {
  title: string;
  /** Live Studio source to select; empty = keep the preselected one. */
  sourceName: string;
  /**
   * Called right before each "Go live" click (main button or confirmation dialog): from then on X
   * may be live even if this flow fails or is aborted, so the caller must try to end it.
   */
  onGoLiveClicked?: () => void;
}

export interface GoLiveResult {
  broadcastId: string | null;
  /** Live Studio page of the running livestream (title edits, end). */
  detailsUrl: string;
  /** True when a live marker was seen; false when assumed from the "Go live" button going away. */
  confirmed: boolean;
}

async function selectSource(page: Page, name: string, opts: FlowOptions): Promise<boolean> {
  const picker = sel.sourcePicker(page).filter({ visible: true }).first();
  if (!(await isShown(picker))) return false;
  const pattern = new RegExp(escapeRegExp(name), 'i');
  const tag = await picker.evaluate((el) => String((el as { tagName?: unknown }).tagName ?? '').toLowerCase()).catch(() => '');
  if (tag === 'select') {
    const labels = await picker.locator('option').allTextContents();
    const index = labels.findIndex((l) => pattern.test(l));
    if (index < 0) return false;
    await abortable(picker.selectOption({ index }), opts.signal);
    return true;
  }
  await clickWhenEnabled(picker, { timeoutMs: opts.timings.stepMs, signal: opts.signal, what: 'the source picker' });
  const option = sel.sourceOption(page, pattern);
  try {
    await waitForAny(page, { option }, { timeoutMs: 5000, signal: opts.signal });
  } catch (err) {
    if (opts.signal.aborted) throw err;
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  await clickWhenEnabled(option, { timeoutMs: opts.timings.stepMs, signal: opts.signal, what: 'the source' });
  return true;
}

/** Fill the title field. Returns false when no title field was found. */
async function fillTitle(page: Page, title: string, opts: FlowOptions, timeoutMs: number): Promise<boolean> {
  const field = sel.titleField(page);
  try {
    await waitForAny(page, { field }, { timeoutMs, signal: opts.signal });
  } catch (err) {
    if (opts.signal.aborted) throw err;
    return false;
  }
  await fillField(field, title, {
    signal: opts.signal,
    timeoutMs: opts.timings.stepMs,
    minDelayMs: opts.timings.typeMinMs,
    maxDelayMs: opts.timings.typeMaxMs,
  });
  return true;
}

/**
 * Create a livestream on Live Studio with `title` on the configured source and press "Go live"
 * as soon as X receives the video (the button stays disabled until then). Call once the push is
 * running. Throws DriverError (needs-login / not-eligible / timeout / platform-error).
 */
export async function goLive(page: Page, input: GoLiveInput, opts: FlowOptions): Promise<GoLiveResult> {
  const { signal, timings, log } = opts;
  const deadline = Date.now() + timings.goLiveMs;
  const left = () => Math.max(1000, deadline - Date.now());

  await openStudio(page, opts);
  await humanPause(400, 900, signal);
  await clickWhenEnabled(sel.newLivestream(page), { timeoutMs: timings.stepMs, signal, what: 'the "New Livestream" button' });

  if (await fillTitle(page, input.title, opts, Math.min(timings.stepMs, left()))) {
    await humanPause(200, 500, signal);
  } else {
    log.warn('X Live Studio: no title field found; continuing with the default title');
  }

  if (input.sourceName) {
    const ok = await selectSource(page, input.sourceName, opts).catch((err: unknown) => {
      if (signal.aborted) throw err;
      log.warn({ error: errText(err) }, 'X Live Studio: selecting the source failed');
      return false;
    });
    if (!ok) log.warn('X Live Studio: source not found; keeping the preselected source');
  }

  let nowClicked = false;
  let nextClicks = 0;
  let dialogClicks = 0;
  let goLiveClicks = 0;
  let lastGoLiveAt = 0;

  for (;;) {
    signal.throwIfAborted();
    if (page.isClosed()) throw new DriverError('The X Live Studio page was closed', 'platform-error');

    if (await isShown(sel.liveIndicator(page))) {
      return { broadcastId: await findBroadcastId(page), detailsUrl: page.url(), confirmed: true };
    }
    if (goLiveClicks > 0 && dialogClicks < 3 && (await isClickable(sel.dialogConfirmGoLive(page)))) {
      dialogClicks += 1;
      input.onGoLiveClicked?.();
      await clickWhenEnabled(sel.dialogConfirmGoLive(page), { timeoutMs: timings.stepMs, signal, what: 'the "Go live" confirmation' });
      lastGoLiveAt = Date.now();
      await humanPause(800, 1500, signal);
      continue;
    }
    if (goLiveClicks > 0) {
      const error = sel.errorText(page);
      if (await isShown(error)) {
        const text = (await error.first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
        throw new DriverError(`X Live Studio reported: ${text || 'an error'}`, 'platform-error');
      }
    }
    const goLiveReady = await isClickable(sel.goLive(page));
    if (goLiveReady && goLiveClicks < 2) {
      input.onGoLiveClicked?.();
      await clickWhenEnabled(sel.goLive(page), { timeoutMs: timings.stepMs, signal, what: 'the "Go live" button' });
      goLiveClicks += 1;
      lastGoLiveAt = Date.now();
      await humanPause(800, 1500, signal);
      continue;
    }
    const goLiveShown = goLiveReady || (await isShown(sel.goLive(page)));
    if (goLiveClicks > 0 && !goLiveShown && Date.now() - lastGoLiveAt >= timings.assumeLiveMs) {
      // The button went away and nothing failed: X most likely went live with a UI we don't recognize.
      log.warn('X Live Studio: no live marker recognized after "Go live"; assuming the livestream started');
      return { broadcastId: await findBroadcastId(page), detailsUrl: page.url(), confirmed: false };
    }
    // Before "Go live": walk the form ("Now" instead of "Later", wizard steps) while the button is
    // missing or still disabled (it only turns on once X receives video).
    if (goLiveClicks === 0 && !goLiveReady) {
      if (!nowClicked && (await isClickable(sel.startNow(page)))) {
        nowClicked = true;
        await clickWhenEnabled(sel.startNow(page), { timeoutMs: timings.stepMs, signal, what: 'the "Now" option' });
        continue;
      }
      if (nextClicks < 6 && (await isClickable(sel.nextStep(page)))) {
        nextClicks += 1;
        await clickWhenEnabled(sel.nextStep(page), { timeoutMs: timings.stepMs, signal, what: 'the "Next" button' });
        await humanPause(300, 700, signal);
        continue;
      }
    }
    if (Date.now() >= deadline) {
      if (goLiveClicks > 0) {
        throw new DriverError('X did not confirm that the livestream started after pressing "Go live"', 'timeout');
      }
      throw new DriverError(
        goLiveShown
          ? 'The "Go live" button in X Live Studio never became active: X is not receiving video on the selected source. Check the source URL/key and the "Live Studio source" name'
          : 'Could not find the "Go live" button in X Live Studio',
        'timeout',
      );
    }
    await humanPause(400, 700, signal);
  }
}

// ---------------------------------------------------------------------------
// While live
// ---------------------------------------------------------------------------

/** Change the title of the running livestream on its Live Studio page. */
export async function editTitle(page: Page, detailsUrl: string, title: string, opts: FlowOptions): Promise<void> {
  const { signal, timings } = opts;
  await ensureOn(page, detailsUrl, opts);
  const field = sel.titleField(page);
  await waitForAny(page, { field, edit: sel.editButton(page) }, { timeoutMs: timings.editMs, signal });
  if (!(await isEditable(field)) && (await isClickable(sel.editButton(page)))) {
    await clickWhenEnabled(sel.editButton(page), { timeoutMs: timings.editMs, signal, what: 'the "Edit" button' });
  }
  if (!(await fillTitle(page, title, opts, timings.editMs))) {
    throw new DriverError('No title field found on the X livestream page', 'platform-error');
  }
  await humanPause(200, 400, signal);
  if (await isClickable(sel.saveButton(page))) {
    await clickWhenEnabled(sel.saveButton(page), { timeoutMs: timings.editMs, signal, what: 'the "Save" button' });
  } else {
    await abortable(field.filter({ visible: true }).first().press('Enter'), signal);
  }
  await humanPause(500, 900, signal);
}

/**
 * Press "End livestream" (and confirm). Returns false when no end button was found (already
 * ended, or a UI we don't recognize).
 */
export async function endLivestream(page: Page, detailsUrl: string, opts: FlowOptions): Promise<boolean> {
  const { signal, timings } = opts;
  await ensureOn(page, detailsUrl, opts);
  let which: string;
  try {
    which = await waitForAny(page, { end: sel.endButton(page), ended: sel.endedIndicator(page) }, {
      timeoutMs: Math.min(timings.stepMs, timings.endMs),
      signal,
    });
  } catch (err) {
    if (signal.aborted || !(err instanceof DriverError && err.code === 'timeout')) throw err;
    return false;
  }
  if (which === 'ended') return true;
  await clickWhenEnabled(sel.endButton(page), { timeoutMs: timings.endMs, signal, what: 'the "End livestream" button' });
  try {
    const next = await waitForAny(page, { confirm: sel.dialogConfirmEnd(page), ended: sel.endedIndicator(page) }, {
      timeoutMs: 6000,
      signal,
    });
    if (next === 'confirm') {
      await clickWhenEnabled(sel.dialogConfirmEnd(page), { timeoutMs: timings.endMs, signal, what: 'the end confirmation' });
    }
  } catch (err) {
    if (signal.aborted) throw err;
    // No confirmation dialog: the first click ended it.
  }
  await humanPause(500, 1000, signal);
  return true;
}
