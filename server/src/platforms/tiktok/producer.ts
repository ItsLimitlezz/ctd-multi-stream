// TikTok LIVE Producer page flows: detect the page state, fill the title, save the LIVE settings,
// read the server URL + stream key, click "Go LIVE" and "End LIVE". UI assumptions: selectors.ts.

import type { Logger } from 'pino';
import type { BrowserContext, Locator, Page } from 'playwright';
import { abortable, clickWhenEnabled, fillField, humanPause, readTextValue, waitForAny } from '../../browser/helpers.js';
import { truncateTitle } from '../common/http.js';
import { DriverError } from '../types.js';
import {
  ingestScript,
  sel,
  SESSION_COOKIES,
  TEXT,
  TITLE_MAX,
  topicScript,
  USERNAME_SCRIPT,
  type IngestScan,
  type TopicScan,
} from './selectors.js';
import {
  errorText,
  isLoginUrl,
  isNavigationInterrupted,
  isRtmpUrl,
  looksLikeStreamKey,
  navErrorMessage,
  normalizeUsername,
  sleep,
} from './util.js';

export interface ProducerTiming {
  /** Waiting for LIVE Producer to render after navigation. */
  detectMs: number;
  /** Waiting for the page to react to a click (settings opening, credentials appearing). */
  stepMs: number;
  /** Ending a LIVE (End LIVE + confirmation). */
  endMs: number;
  /** Pause once the preview is ready before clicking "Go LIVE" (lets TikTok settle on the video). */
  settleMs: number;
  /** Per-character typing delay range. */
  typingDelayMs: [number, number];
}

/**
 * What LIVE Producer shows: a running LIVE, a prepared LIVE with credentials, the settings form,
 * the start page, an eligibility notice, a login prompt, or nothing recognizable.
 */
export type ProducerState = 'live' | 'keys' | 'form' | 'start' | 'ineligible' | 'login' | 'unknown';

export interface Ingest {
  serverUrl: string;
  streamKey: string;
}

const NAV_TIMEOUT_MS = 45_000;

const TOPIC_MISSING =
  'TikTok requires a LIVE topic and none is selected. Open TikTok LIVE Producer once in the browser view (Accounts), ' +
  'pick a topic there, then try again. The app never changes the topic.';

// ---------------------------------------------------------------------------
// Small locator utilities
// ---------------------------------------------------------------------------

async function visible(locator: Locator): Promise<boolean> {
  try {
    return await locator.filter({ visible: true }).first().isVisible();
  } catch {
    return false; // detached / navigating
  }
}

/** Click the first visible match after a short human pause. False when nothing is visible or the click fails. */
async function clickIfVisible(locator: Locator, signal?: AbortSignal): Promise<boolean> {
  const target = locator.filter({ visible: true }).first();
  if (!(await visible(target))) return false;
  await humanPause(150, 400, signal);
  try {
    await abortable(target.click({ timeout: 5000 }), signal);
    return true;
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof DriverError && err.code === 'timeout';
}

// ---------------------------------------------------------------------------
// Session + navigation
// ---------------------------------------------------------------------------

/** True when the context holds a non-expired TikTok login cookie. */
export async function hasSessionCookie(context: BrowserContext, urls: string[]): Promise<boolean> {
  const now = Date.now() / 1000;
  const cookies = await context.cookies(urls);
  return cookies.some((c) => SESSION_COOKIES.includes(c.name) && c.value !== '' && (c.expires <= 0 || c.expires > now));
}

export async function gotoPage(page: Page, url: string, signal: AbortSignal): Promise<void> {
  try {
    await abortable(page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }), signal);
  } catch (err) {
    signal.throwIfAborted();
    if (isNavigationInterrupted(err)) return; // a redirect (e.g. to the login page) took over
    throw new DriverError(`Couldn't open TikTok: ${navErrorMessage(err)}`, 'platform-error');
  }
}

/** Decline optional cookies and close harmless tip popups. */
export async function dismissBanners(page: Page, signal: AbortSignal): Promise<void> {
  await clickIfVisible(sel.cookieDecline(page), signal);
  await clickIfVisible(sel.benignDismiss(page), signal);
}

export async function detectState(page: Page, timeoutMs: number, signal: AbortSignal): Promise<ProducerState> {
  if (isLoginUrl(page.url())) return 'login';
  try {
    const key = await waitForAny(
      page,
      {
        live: sel.endLive(page),
        keys: sel.keyLabel(page),
        form: sel.saveSettings(page).or(sel.titleInput(page)),
        start: sel.goLive(page),
        ineligible: sel.ineligible(page),
        login: sel.loginPrompt(page),
      },
      { timeoutMs, signal, pollMs: 300 },
    );
    return key as ProducerState;
  } catch (err) {
    if (isTimeout(err)) return isLoginUrl(page.url()) ? 'login' : 'unknown';
    throw err;
  }
}

/** Open (or just inspect) LIVE Producer and report what it shows. */
export async function loadProducer(
  page: Page,
  producerUrl: string,
  timing: ProducerTiming,
  signal: AbortSignal,
  opts: { navigate: boolean },
): Promise<ProducerState> {
  if (opts.navigate) await gotoPage(page, producerUrl, signal);
  await dismissBanners(page, signal);
  const state = await detectState(page, timing.detectMs, signal);
  if (state !== 'login' && state !== 'unknown') await dismissBanners(page, signal); // late cookie banner
  return state;
}

/** True when this page shows a running LIVE ("End LIVE"). */
export function isLiveOnPage(page: Page): Promise<boolean> {
  return visible(sel.endLive(page));
}

/** True when this page shows a prepared or running LIVE (credentials or "End LIVE"). */
export async function isDashboard(page: Page): Promise<boolean> {
  return (await visible(sel.endLive(page))) || (await visible(sel.keyLabel(page)));
}

/** Choose "Streaming software" (stream key) as the LIVE source when TikTok offers a choice. */
async function pickSoftwareSource(page: Page, signal: AbortSignal): Promise<boolean> {
  const option = sel.softwareSource(page).filter({ visible: true }).first();
  if (!(await visible(option))) return false;
  for (const attr of ['aria-checked', 'aria-selected', 'aria-pressed']) {
    if ((await option.getAttribute(attr, { timeout: 1000 }).catch(() => null)) === 'true') return false; // already chosen
  }
  return clickIfVisible(option, signal);
}

type Progress = 'live' | 'keys' | 'form' | 'topic-error';

/**
 * Wait until the page shows one of `want`; picks the "streaming software" source once if TikTok
 * asks for it on the way. Null on timeout.
 */
async function waitForProgress<P extends Progress>(page: Page, want: P[], timeoutMs: number, signal: AbortSignal): Promise<P | null> {
  const locators: Record<Progress, () => Locator> = {
    live: () => sel.endLive(page),
    keys: () => sel.keyLabel(page),
    form: () => sel.saveSettings(page),
    'topic-error': () => sel.topicError(page),
  };
  const deadline = Date.now() + timeoutMs;
  let pickedSource = false;
  for (;;) {
    signal.throwIfAborted();
    if (page.isClosed()) throw new DriverError('The TikTok browser page was closed', 'platform-error');
    for (const p of want) if (await visible(locators[p]())) return p;
    if (!pickedSource && (await pickSoftwareSource(page, signal))) {
      pickedSource = true;
      continue;
    }
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await sleep(Math.min(250, left), signal);
  }
}

// ---------------------------------------------------------------------------
// LIVE settings (title only; the topic is read, never changed)
// ---------------------------------------------------------------------------

async function readTopic(page: Page): Promise<TopicScan> {
  try {
    return (await page.evaluate(topicScript())) as TopicScan;
  } catch {
    return { found: false, value: null };
  }
}

async function writeTitle(page: Page, title: string, timing: ProducerTiming, signal: AbortSignal, log: Logger): Promise<void> {
  const input = sel.titleInput(page).filter({ visible: true }).first();
  if (!(await visible(input))) {
    log.warn('TikTok title field not found; keeping the title shown in LIVE Producer');
    return;
  }
  const maxAttr = Number(await input.getAttribute('maxlength', { timeout: 2000 }).catch(() => null));
  const max = Number.isInteger(maxAttr) && maxAttr > 0 ? Math.min(maxAttr, TITLE_MAX) : TITLE_MAX;
  const text = truncateTitle(title, max);
  const current = await readTextValue(input, { timeoutMs: 2000 }).catch(() => null);
  if (current === text) return;
  await fillField(input, text, { signal, minDelayMs: timing.typingDelayMs[0], maxDelayMs: timing.typingDelayMs[1] });
  const after = await readTextValue(input, { timeoutMs: 2000 }).catch(() => '');
  if (after !== text) {
    log.warn({ expectedLength: [...text].length, actualLength: [...after].length }, 'TikTok shows a different title than typed');
  }
}

/** Fill the title in the open settings form and save it ("Save & Go LIVE"); wait for the credentials. */
async function applySettings(page: Page, title: string, timing: ProducerTiming, signal: AbortSignal, log: Logger): Promise<void> {
  if (title) await writeTitle(page, title, timing, signal, log);
  const topic = await readTopic(page);
  const topicEmpty = topic.found && (!topic.value || TEXT.topicPlaceholder.test(topic.value));
  const topicProblem = async () => topicEmpty || (await visible(sel.topicRequired(page)));
  await pickSoftwareSource(page, signal); // the key is only shown for the "streaming software" source

  try {
    await clickWhenEnabled(sel.saveSettings(page), {
      timeoutMs: Math.min(timing.stepMs, 15_000),
      signal,
      what: 'the "Save & Go LIVE" button',
    });
  } catch (err) {
    if (!isTimeout(err)) throw err;
    if (await topicProblem()) throw new DriverError(TOPIC_MISSING, 'misconfigured');
    if (!title) throw new DriverError('TikTok needs a LIVE title: set a stream title, then try again.', 'misconfigured');
    throw new DriverError(
      'TikTok LIVE Producer did not accept the LIVE settings ("Save & Go LIVE" stayed disabled). Check them in the browser view.',
      'platform-error',
    );
  }

  const result = await waitForProgress(page, ['live', 'keys', 'topic-error'], timing.stepMs, signal);
  if (result === 'topic-error' || (result === null && (await topicProblem()))) {
    throw new DriverError(TOPIC_MISSING, 'misconfigured');
  }
  if (result === null) {
    throw new DriverError("TikTok didn't show the server URL and stream key after saving the LIVE settings", 'platform-error');
  }
}

/**
 * From the start page, the settings form or an existing draft, get to a prepared LIVE whose
 * server URL + stream key are on screen.
 */
export async function setupLive(
  page: Page,
  initial: ProducerState,
  title: string,
  timing: ProducerTiming,
  signal: AbortSignal,
  log: Logger,
): Promise<void> {
  let state = initial;
  if (state === 'start') {
    await clickWhenEnabled(sel.goLive(page), { timeoutMs: timing.stepMs, signal, what: 'the "Go LIVE" button in TikTok LIVE Producer' });
    const next = await waitForProgress(page, ['live', 'keys', 'form'], timing.stepMs, signal);
    if (!next) throw new DriverError("Clicked \"Go LIVE\" in TikTok LIVE Producer, but the LIVE settings didn't open", 'platform-error');
    state = next;
  }
  if (state === 'keys') {
    // A prepared LIVE already exists (e.g. an earlier attempt). Update its title when TikTok offers a way.
    if (!(await visible(sel.saveSettings(page))) && (await clickIfVisible(sel.editSettings(page), signal))) {
      await waitForProgress(page, ['form'], Math.min(timing.stepMs, 5000), signal);
    }
    if (await visible(sel.saveSettings(page))) state = 'form';
    else log.warn('TikTok already has a LIVE prepared; its title could not be updated');
  }
  if (state === 'form') await applySettings(page, title, timing, signal, log);
  else if (state !== 'keys' && state !== 'live') {
    throw new DriverError('TikTok LIVE Producer is not showing the LIVE settings', 'platform-error');
  }
}

// ---------------------------------------------------------------------------
// Server URL + stream key
// ---------------------------------------------------------------------------

const EMPTY_SCAN: IngestScan = { serverUrl: null, streamKey: null, masked: false, keyLabel: false };

async function scanIngest(page: Page, signal: AbortSignal): Promise<IngestScan> {
  try {
    return (await abortable(page.evaluate(ingestScript()) as Promise<IngestScan>, signal)) ?? EMPTY_SCAN;
  } catch {
    signal.throwIfAborted();
    return EMPTY_SCAN; // navigating / re-rendering: try again
  }
}

/** Last resort for a masked key: TikTok's Copy button + the page clipboard (then cleared). */
async function keyFromClipboard(page: Page, signal: AbortSignal, log: Logger): Promise<string | null> {
  const copy = sel.copyKey(page);
  if (!(await visible(copy))) return null;
  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    if (!(await clickIfVisible(copy, signal))) return null;
    await sleep(300, signal);
    const text: unknown = await abortable(page.evaluate('navigator.clipboard.readText()'), signal);
    await page.evaluate("navigator.clipboard.writeText('')").catch(() => {});
    return typeof text === 'string' && looksLikeStreamKey(text) ? text.trim() : null;
  } catch (err) {
    signal.throwIfAborted();
    log.warn({ err: errorText(err).split('\n', 1)[0]?.slice(0, 200) }, 'reading the TikTok stream key with the Copy button failed');
    return null;
  }
}

/** Read the server URL and stream key shown by LIVE Producer (generating/revealing the key if needed). */
export async function readIngest(page: Page, timeoutMs: number, signal: AbortSignal, log: Logger): Promise<Ingest> {
  const deadline = Date.now() + timeoutMs;
  let scan = EMPTY_SCAN;
  let reveals = 0;
  let generated = false;
  let pickedSource = false;
  for (;;) {
    signal.throwIfAborted();
    scan = await scanIngest(page, signal);
    if (scan.serverUrl && scan.streamKey && !scan.masked) break;
    if (!scan.keyLabel && !pickedSource && (await pickSoftwareSource(page, signal))) {
      pickedSource = true;
      continue;
    }
    if (scan.masked) {
      // A re-render can mask the key again: retry the "show" toggle a few times.
      if (reveals < 3 && (await clickIfVisible(sel.revealKey(page), signal))) {
        reveals += 1;
        await sleep(300, signal);
        continue;
      }
      break; // no working "show" toggle: use the Copy button
    } else if (!scan.streamKey && !generated && (await clickIfVisible(sel.generateKey(page), signal))) {
      generated = true;
      log.info('Asked TikTok LIVE Producer to generate a stream key');
      continue;
    }
    if (Date.now() >= deadline) break;
    await sleep(500, signal);
  }

  let key = scan.streamKey && !scan.masked ? scan.streamKey.trim() : null;
  if ((!key || !looksLikeStreamKey(key)) && scan.serverUrl) key = await keyFromClipboard(page, signal, log);
  if (!scan.serverUrl) throw new DriverError("Couldn't read the Server URL from TikTok LIVE Producer", 'platform-error');
  if (!isRtmpUrl(scan.serverUrl)) {
    throw new DriverError('TikTok LIVE Producer shows a server URL that is not rtmp:// or rtmps://', 'platform-error');
  }
  if (!key || !looksLikeStreamKey(key)) throw new DriverError("Couldn't read the stream key from TikTok LIVE Producer", 'platform-error');
  return { serverUrl: scan.serverUrl.trim(), streamKey: key };
}

/** readIngest that reports "not available" instead of throwing (used for a LIVE found running). */
export async function tryReadIngest(page: Page, timeoutMs: number, signal: AbortSignal, log: Logger): Promise<Ingest | null> {
  try {
    return await readIngest(page, timeoutMs, signal, log);
  } catch (err) {
    if (err instanceof DriverError) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Go LIVE / End LIVE
// ---------------------------------------------------------------------------

/**
 * Wait until TikTok received the video: "Go LIVE" enabled, no "waiting for stream" notice, and still
 * on the prepared LIVE (credentials or preview on screen, so the start page's "Go LIVE" is never
 * mistaken for it).
 */
async function waitUntilReady(page: Page, deadline: number, sec: number, signal: AbortSignal): Promise<'live' | 'ready'> {
  for (;;) {
    signal.throwIfAborted();
    if (page.isClosed()) throw new DriverError('The TikTok browser page was closed', 'platform-error');
    if (await visible(sel.endLive(page))) return 'live';
    const button = sel.goLive(page).filter({ visible: true }).first();
    const enabled = (await visible(button)) && (await button.isEnabled({ timeout: 1000 }).catch(() => false));
    const prepared = enabled && ((await visible(sel.keyLabel(page))) || (await visible(sel.preview(page))));
    if (prepared && !(await visible(sel.noStream(page)))) return 'ready';
    const left = deadline - Date.now();
    if (left <= 0) {
      throw new DriverError(
        `TikTok didn't receive the video within ${sec} s ("Go LIVE" stayed unavailable). Check that the vertical feed from OBS reaches the app, then retry.`,
        'timeout',
      );
    }
    await sleep(Math.min(500, left), signal);
  }
}

/** After clicking "Go LIVE": confirm dialogs, then wait for the LIVE to start. */
async function afterGoLiveClick(page: Page, timeoutMs: number, signal: AbortSignal): Promise<'live' | 'no-stream' | 'timeout'> {
  const deadline = Date.now() + timeoutMs;
  let confirms = 0;
  let saved = false;
  for (;;) {
    signal.throwIfAborted();
    if (await visible(sel.endLive(page))) return 'live';
    if (confirms < 2 && (await clickIfVisible(sel.dialogButton(page, TEXT.goLiveConfirm), signal))) {
      confirms += 1;
      continue;
    }
    if (!saved && (await clickIfVisible(sel.saveAndGoLive(page), signal))) {
      saved = true;
      continue;
    }
    if (await visible(sel.noStream(page))) return 'no-stream';
    if (Date.now() >= deadline) return 'timeout';
    await sleep(400, signal);
  }
}

/** Wait for TikTok to receive the video (≤ timeoutMs), click "Go LIVE" and verify the LIVE started. */
export async function goLive(page: Page, timeoutMs: number, timing: ProducerTiming, signal: AbortSignal, log: Logger): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const sec = Math.round(timeoutMs / 1000);
  for (let attempt = 1; ; attempt++) {
    if ((await waitUntilReady(page, deadline, sec, signal)) === 'live') return;
    if (timing.settleMs > 0) await humanPause(timing.settleMs, timing.settleMs + 1000, signal);
    const left = deadline - Date.now();
    await clickWhenEnabled(sel.goLive(page), {
      timeoutMs: Math.max(2000, Math.min(10_000, left)),
      signal,
      what: 'the "Go LIVE" button',
    });
    const outcome = await afterGoLiveClick(page, Math.max(5000, Math.min(30_000, deadline - Date.now())), signal);
    if (outcome === 'live') return;
    if (attempt >= 3 || deadline - Date.now() < 5000) {
      throw new DriverError(
        outcome === 'no-stream'
          ? "TikTok reports it isn't receiving the video. Check that the vertical feed from OBS reaches the app, then retry."
          : `Clicked "Go LIVE", but TikTok didn't start the LIVE within ${sec} s`,
        'timeout',
      );
    }
    log.info({ attempt, outcome }, 'TikTok has not started the LIVE yet; trying "Go LIVE" again');
    await sleep(3000, signal);
  }
}

/** Click "End LIVE" and confirm. 'not-live' when no LIVE is running on this page. */
export async function endLive(page: Page, timeoutMs: number, signal?: AbortSignal): Promise<'ended' | 'not-live'> {
  if (!(await visible(sel.endLive(page)))) return 'not-live';
  await clickWhenEnabled(sel.endLive(page), { timeoutMs: 5000, ...(signal ? { signal } : {}), what: 'the "End LIVE" button' });
  const deadline = Date.now() + timeoutMs;
  let confirms = 0;
  for (;;) {
    if (confirms < 2 && (await clickIfVisible(sel.dialogButton(page, TEXT.endConfirm), signal))) {
      confirms += 1;
      await sleep(300, signal);
      continue;
    }
    const dialogOpen = await visible(sel.dialogButton(page, TEXT.endConfirm));
    if (!dialogOpen && !(await visible(sel.endLive(page)))) return 'ended';
    if (Date.now() >= deadline) {
      throw new DriverError("TikTok didn't confirm that the LIVE ended. End it in TikTok LIVE Producer.", 'timeout');
    }
    await sleep(300, signal);
  }
}

/** The logged-in username on a www.tiktok.com page, or null. */
export async function readUsername(page: Page): Promise<string | null> {
  try {
    return normalizeUsername(await page.evaluate(USERNAME_SCRIPT));
  } catch {
    return null;
  }
}
