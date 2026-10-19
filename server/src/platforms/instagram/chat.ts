// Live comments, scraped from the producer page's "Comments" panel.
//
// The panel's markup is not documented, so a small marker script (selectors.ts) tags the
// comments container and each comment row with data attributes, re-run every few seconds so
// re-rendered rows are picked up; scrapeChat then reads the tagged rows.

import type { Logger } from 'pino';
import type { Page } from 'playwright';
import { fillField, humanPause, scrapeChat } from '../../browser/helpers.js';
import type { ChatMessageInput } from '../types.js';
import { selectCommentsTab, visibleNow } from './flow.js';
import { CHAT_CONTAINER_ATTR, CHAT_DIAG_SOURCE, CHAT_EXTRACT_SOURCE, CHAT_MARK_SOURCE, CHAT_ROW_ATTR, DESCRIBE_CONTROLS_SOURCE, sel } from './selectors.js';
import { shortError } from './util.js';

const MARK_EXPRESSION = `(${CHAT_MARK_SOURCE})(${JSON.stringify({ containerAttr: CHAT_CONTAINER_ATTR, rowAttr: CHAT_ROW_ATTR })})`;

export interface ChatTimings {
  /** How often rows are (re)tagged. */
  markMs: number;
  /** scrapeChat poll interval. */
  pollMs: number;
}

export const DEFAULT_CHAT_TIMINGS: ChatTimings = { markMs: 1_500, pollMs: 1_000 };

/**
 * Posted once into a Practice test live's own comment box (only the account sees Practice lives,
 * and the Instagram app doesn't show your own live), so a rehearsal checks that comments reach the chat.
 */
export const TEST_COMMENT = 'CTD Multi-Stream chat test ✅';
const TEST_COMMENT_DELAY_MS = 4_000;
/** No comment read this long after the test comment: log what the reader sees. */
const TEST_COMMENT_CHECK_MS = 20_000;

/** One test comment per live (shared by the chat source's restarts). */
export interface ChatTest {
  comment: string | null;
  posted: boolean;
}

/** Type `text` into the producer's comment box and send it. False when there is no comment box. */
async function postComment(page: Page, text: string, signal: AbortSignal, log: Logger): Promise<boolean> {
  const box = await visibleNow(sel.commentBox(page));
  if (!box) {
    const controls = await page.evaluate(`(${DESCRIBE_CONTROLS_SOURCE})()`).catch(() => null);
    log.warn({ controls }, 'Instagram comment box not found for the chat test; visible controls of the producer');
    return false;
  }
  await fillField(box, text, { signal, timeoutMs: 8_000, minDelayMs: 20, maxDelayMs: 60 });
  await humanPause(200, 400, signal);
  const post = await visibleNow(sel.commentPost(page), true);
  if (post && (await post.isEnabled({ timeout: 1_000 }).catch(() => false))) await post.click({ timeout: 5_000 });
  else await box.press('Enter', { timeout: 3_000 });
  return true;
}

async function markRows(page: Page): Promise<number> {
  if (page.isClosed()) return 0;
  const n = await page.evaluate(MARK_EXPRESSION).catch(() => 0);
  return typeof n === 'number' ? n : 0;
}

/** After this long without finding the comments panel, log what the producer shows (once). */
const DIAGNOSE_AFTER_MS = 30_000;
/** After this long without a single comment row, log what the reader sees (once). */
const DIAGNOSE_ROWS_AFTER_MS = 45_000;
const CHAT_DIAG = `(${CHAT_DIAG_SOURCE})(${JSON.stringify({ containerAttr: CHAT_CONTAINER_ATTR, rowAttr: CHAT_ROW_ATTR })})`;

async function keepMarking(page: Page, signal: AbortSignal, ms: number, log: Logger): Promise<void> {
  let tabTries = 0;
  const started = Date.now();
  let diagnosed = false;
  let diagnosedRows = false;
  let sawRows = false;
  while (!signal.aborted && !page.isClosed()) {
    try {
      await humanPause(ms, ms, signal);
    } catch {
      return; // aborted
    }
    // After a re-render the panel may be back on another tab: reopen "Comments" now and then.
    const marked = await markRows(page);
    if (marked > 0) sawRows = true;
    if (marked === 0 && tabTries++ % 10 === 0) {
      await selectCommentsTab(page, signal).catch(() => {});
    }
    if (!diagnosed && Date.now() - started >= DIAGNOSE_AFTER_MS) {
      diagnosed = true;
      const found = await page.evaluate(`!!document.querySelector('[${CHAT_CONTAINER_ATTR}]')`).catch(() => true);
      if (!found) {
        const controls = await page.evaluate(`(${DESCRIBE_CONTROLS_SOURCE})()`).catch(() => null);
        log.warn({ controls }, 'Instagram comments panel not found; visible controls of the producer');
      }
    }
    if (!diagnosedRows && !sawRows && Date.now() - started >= DIAGNOSE_ROWS_AFTER_MS) {
      diagnosedRows = true;
      const seen = await page.evaluate(CHAT_DIAG).catch(() => null);
      log.warn({ seen }, 'no Instagram comment rows found yet; what the comments reader sees');
    }
  }
}

/**
 * Practice test lives: once the reader runs, post the test comment, then check it came through;
 * when nothing was read, log what the reader sees. Best effort, never throws.
 */
async function runChatTest(page: Page, test: ChatTest, signal: AbortSignal, log: Logger, readCount: () => number): Promise<void> {
  if (!test.comment || test.posted) return;
  try {
    await humanPause(TEST_COMMENT_DELAY_MS, TEST_COMMENT_DELAY_MS, signal);
    if (test.posted) return;
    test.posted = true;
    const before = readCount();
    if (!(await postComment(page, test.comment, signal, log))) return;
    log.info('Instagram chat test comment posted');
    await humanPause(TEST_COMMENT_CHECK_MS, TEST_COMMENT_CHECK_MS, signal);
    if (readCount() > before) {
      log.info('Instagram chat test: the comment reached the chat');
      return;
    }
    const seen = await page.evaluate(CHAT_DIAG).catch(() => null);
    log.warn({ seen }, "Instagram chat test: the test comment didn't reach the chat; what the comments reader sees");
  } catch (err) {
    if (!signal.aborted) log.warn({ error: shortError(err) }, 'Instagram chat test failed');
  }
}

/** Yields new live comments until `signal` aborts (throws if the page closes). */
export async function* instagramChat(
  page: Page,
  signal: AbortSignal,
  log: Logger,
  timings: ChatTimings = DEFAULT_CHAT_TIMINGS,
  test: ChatTest = { comment: null, posted: false },
): AsyncGenerator<ChatMessageInput> {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  signal.addEventListener('abort', stop, { once: true });
  let read = 0;
  try {
    await selectCommentsTab(page, ctl.signal).catch((err: unknown) => {
      if (!ctl.signal.aborted) log.debug({ error: shortError(err) }, 'Instagram comments tab not selected');
    });
    await markRows(page); // tag what is already there so it becomes the baseline
    const marker = keepMarking(page, ctl.signal, timings.markMs, log);
    const tester = runChatTest(page, test, ctl.signal, log, () => read);
    try {
      for await (const item of scrapeChat(page, { itemSelector: `[${CHAT_ROW_ATTR}]`, extract: CHAT_EXTRACT_SOURCE, pollMs: timings.pollMs }, ctl.signal)) {
        read++;
        yield item;
      }
    } finally {
      ctl.abort();
      await marker;
      await tester;
    }
  } finally {
    signal.removeEventListener('abort', stop);
  }
}
