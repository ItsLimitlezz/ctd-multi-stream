// Chat aggregation: runs each live destination's chat source, normalizes and de-duplicates
// messages, keeps a ring buffer of recent ones and emits them on the EventBus.

import type { Logger } from 'pino';
import type { ChatMessage, PlatformId } from '../../../shared/types.js';
import type { EventBus } from '../events.js';
import type { ChatMessageInput } from '../platforms/types.js';
import type { ChatHub, ScopedSecrets } from '../services.js';
import { RecentKeys, RingBuffer } from './buffers.js';
import { normalizeChatMessage } from './normalize.js';
import { safeErrorMessage } from './redact.js';
import { generateOverlayToken } from './token.js';

export const RING_SIZE = 500;
export const DEDUPE_SIZE = 2000;
export const DEFAULT_RECENT = 200;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
/** A source that streamed this long before failing restarts with the minimum backoff again. */
export const HEALTHY_RESET_MS = 60_000;

const TOKEN_KEY = 'overlayToken';
const MIN_STORED_TOKEN_LENGTH = 32;

export interface ChatHubDeps {
  bus: EventBus;
  log: Logger;
  /** Secrets scoped to 'chat'. */
  secrets: ScopedSecrets;
}

type ChatSource = (signal: AbortSignal) => AsyncIterable<ChatMessageInput>;

const ABORTED = Symbol('aborted');

/** Resolves with ABORTED once the signal fires (or immediately if it already has). */
function abortPromise(signal: AbortSignal): { promise: Promise<typeof ABORTED>; dispose(): void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<typeof ABORTED>((resolve) => {
    if (signal.aborted) {
      resolve(ABORTED);
      return;
    }
    onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    promise,
    dispose: () => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    },
  };
}

/** Sleep that ends early (without throwing) when the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Consume one run of a source until it ends, throws, or the signal aborts. Iterates manually
 * so an abort stops us promptly even if the source ignores its signal.
 */
async function consume(source: ChatSource, signal: AbortSignal, onMessage: (m: ChatMessageInput) => void): Promise<void> {
  const it = source(signal)[Symbol.asyncIterator]();
  const aborted = abortPromise(signal);
  let finished = false;
  try {
    while (!signal.aborted) {
      const next = it.next();
      next.catch(() => {}); // the race may abandon this promise; never leave it unhandled
      let result: IteratorResult<ChatMessageInput> | typeof ABORTED;
      try {
        result = await Promise.race([next, aborted.promise]);
      } catch (err) {
        finished = true;
        throw err;
      }
      if (result === ABORTED || signal.aborted) return;
      if (result.done) {
        finished = true;
        return;
      }
      onMessage(result.value);
    }
  } finally {
    aborted.dispose();
    // Ask an abandoned iterator to clean up (close sockets...). Not awaited: a stuck source must not block us.
    if (!finished && typeof it.return === 'function') {
      const ret = it.return.bind(it);
      Promise.resolve()
        .then(() => ret())
        .catch(() => {});
    }
  }
}

export function createChatHub({ bus, log, secrets }: ChatHubDeps): ChatHub {
  const buffer = new RingBuffer<ChatMessage>(RING_SIZE);
  const seen = new RecentKeys(DEDUPE_SIZE);
  const attachments = new Map<string, AbortController>();

  function push(destinationId: string, platform: PlatformId, input: ChatMessageInput): void {
    let msg: ChatMessage | null;
    try {
      msg = normalizeChatMessage(input, platform, destinationId);
    } catch {
      return; // malformed input from a scraper; drop it
    }
    if (!msg || !seen.add(msg.id)) return;
    buffer.push(msg);
    try {
      bus.emit('chat', msg);
    } catch (err) {
      // A throwing listener must not be mistaken for a source failure.
      log.error({ reason: safeErrorMessage(err) }, 'chat listener failed');
    }
  }

  async function run(destinationId: string, platform: PlatformId, source: ChatSource, signal: AbortSignal): Promise<void> {
    let delay = BACKOFF_MIN_MS;
    while (!signal.aborted) {
      const startedAt = Date.now();
      let reason = 'source ended';
      try {
        await consume(source, signal, (m) => push(destinationId, platform, m));
      } catch (err) {
        reason = safeErrorMessage(err);
      }
      if (signal.aborted) break;
      if (Date.now() - startedAt >= HEALTHY_RESET_MS) delay = BACKOFF_MIN_MS;
      log.warn({ destinationId, platform, reason, retryInMs: delay }, 'chat source stopped; restarting');
      await sleep(delay, signal);
      delay = Math.min(delay * 2, BACKOFF_MAX_MS);
    }
  }

  // Token reads/writes are serialized so a rotate can't race a first-time create.
  let tokenQueue: Promise<unknown> = Promise.resolve();
  let cachedToken: string | null = null;
  function serialize<T>(op: () => Promise<T>): Promise<T> {
    const result = tokenQueue.then(op, op);
    tokenQueue = result.catch(() => undefined);
    return result;
  }

  return {
    attach(destinationId, platform, source, signal) {
      attachments.get(destinationId)?.abort();
      attachments.delete(destinationId);
      if (signal.aborted) return;

      const controller = new AbortController();
      const onParentAbort = (): void => controller.abort();
      signal.addEventListener('abort', onParentAbort, { once: true });
      attachments.set(destinationId, controller);
      log.debug({ destinationId, platform }, 'chat attached');

      void run(destinationId, platform, source, controller.signal)
        .catch((err: unknown) => log.error({ destinationId, platform, reason: safeErrorMessage(err) }, 'chat loop crashed'))
        .finally(() => {
          signal.removeEventListener('abort', onParentAbort);
          if (attachments.get(destinationId) === controller) attachments.delete(destinationId);
          log.debug({ destinationId, platform }, 'chat detached');
        });
    },

    recent(limit = DEFAULT_RECENT) {
      const n = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 0), RING_SIZE) : DEFAULT_RECENT;
      return buffer.last(n);
    },

    overlayToken() {
      // Queued even when cached, so a read never returns a token that a pending rotate replaces.
      return serialize(async () => {
        if (cachedToken) return cachedToken;
        const stored = await secrets.get(TOKEN_KEY);
        if (stored && stored.length >= MIN_STORED_TOKEN_LENGTH) {
          cachedToken = stored;
          return stored;
        }
        const token = generateOverlayToken();
        await secrets.set(TOKEN_KEY, token);
        cachedToken = token;
        log.info('created chat overlay token');
        return token;
      });
    },

    rotateOverlayToken() {
      return serialize(async () => {
        const token = generateOverlayToken();
        await secrets.set(TOKEN_KEY, token);
        cachedToken = token;
        log.info('rotated chat overlay token');
        return token;
      });
    },
  };
}
