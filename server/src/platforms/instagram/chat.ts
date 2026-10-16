// Live comments, scraped from the producer page's "Comments" panel.
//
// The panel's markup is not documented, so a small marker script (selectors.ts) tags the
// comments container and each comment row with data attributes, re-run every few seconds so
// re-rendered rows are picked up; scrapeChat then reads the tagged rows.

import type { Logger } from 'pino';
import type { Page } from 'playwright';
import { humanPause, scrapeChat } from '../../browser/helpers.js';
import type { ChatMessageInput } from '../types.js';
import { selectCommentsTab } from './flow.js';
import { CHAT_CONTAINER_ATTR, CHAT_EXTRACT_SOURCE, CHAT_MARK_SOURCE, CHAT_ROW_ATTR, DESCRIBE_CONTROLS_SOURCE } from './selectors.js';
import { shortError } from './util.js';

const MARK_EXPRESSION = `(${CHAT_MARK_SOURCE})(${JSON.stringify({ containerAttr: CHAT_CONTAINER_ATTR, rowAttr: CHAT_ROW_ATTR })})`;

export interface ChatTimings {
  /** How often rows are (re)tagged. */
  markMs: number;
  /** scrapeChat poll interval. */
  pollMs: number;
}

export const DEFAULT_CHAT_TIMINGS: ChatTimings = { markMs: 1_500, pollMs: 1_000 };

async function markRows(page: Page): Promise<number> {
  if (page.isClosed()) return 0;
  const n = await page.evaluate(MARK_EXPRESSION).catch(() => 0);
  return typeof n === 'number' ? n : 0;
}

/** After this long without finding the comments panel, log what the producer shows (once). */
const DIAGNOSE_AFTER_MS = 30_000;

async function keepMarking(page: Page, signal: AbortSignal, ms: number, log: Logger): Promise<void> {
  let tabTries = 0;
  const started = Date.now();
  let diagnosed = false;
  while (!signal.aborted && !page.isClosed()) {
    try {
      await humanPause(ms, ms, signal);
    } catch {
      return; // aborted
    }
    // After a re-render the panel may be back on another tab: reopen "Comments" now and then.
    if ((await markRows(page)) === 0 && tabTries++ % 10 === 0) {
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
  }
}

/** Yields new live comments until `signal` aborts (throws if the page closes). */
export async function* instagramChat(
  page: Page,
  signal: AbortSignal,
  log: Logger,
  timings: ChatTimings = DEFAULT_CHAT_TIMINGS,
): AsyncGenerator<ChatMessageInput> {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  signal.addEventListener('abort', stop, { once: true });
  try {
    await selectCommentsTab(page, ctl.signal).catch((err: unknown) => {
      if (!ctl.signal.aborted) log.debug({ error: shortError(err) }, 'Instagram comments tab not selected');
    });
    await markRows(page); // tag what is already there so it becomes the baseline
    const marker = keepMarking(page, ctl.signal, timings.markMs, log);
    try {
      yield* scrapeChat(page, { itemSelector: `[${CHAT_ROW_ATTR}]`, extract: CHAT_EXTRACT_SOURCE, pollMs: timings.pollMs }, ctl.signal);
    } finally {
      ctl.abort();
      await marker;
    }
  } finally {
    signal.removeEventListener('abort', stop);
  }
}
