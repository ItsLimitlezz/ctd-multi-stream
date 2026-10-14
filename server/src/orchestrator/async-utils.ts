// Small async helpers for the orchestrator: bounded waits, a serial queue, safe error messages.

/** Thrown when an awaited operation exceeds its time budget. */
export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${Math.round(ms / 1000)} s`);
    this.name = 'TimeoutError';
  }
}

export function abortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export interface BoundedOptions<T> {
  /** Time budget in milliseconds. */
  ms: number;
  /** Human-readable name of the operation, used in the timeout message. */
  what: string;
  /** Stop waiting (reject with an AbortError) when this aborts. */
  signal?: AbortSignal;
  /** Receives the value when the work resolves after we stopped waiting (e.g. to clean it up). */
  onLate?: (value: T) => void;
}

/**
 * Run `work` with a timeout and an optional abort signal. The signal passed to `work` aborts on
 * timeout or when `opts.signal` aborts. Rejections that arrive after we stopped waiting are
 * swallowed, so a slow or misbehaving callee can never cause an unhandled rejection.
 */
export function awaitBounded<T>(work: (signal: AbortSignal) => Promise<T>, opts: BoundedOptions<T>): Promise<T> {
  const inner = new AbortController();
  const outer = opts.signal;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
      return true;
    };
    const onAbort = (): void => {
      if (!finish()) return;
      inner.abort();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      if (!finish()) return;
      const err = new TimeoutError(opts.what, opts.ms);
      inner.abort(err);
      reject(err);
    }, opts.ms);

    if (outer?.aborted) {
      onAbort();
      return;
    }
    outer?.addEventListener('abort', onAbort, { once: true });

    let p: Promise<T>;
    try {
      p = Promise.resolve(work(inner.signal));
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(
      (value) => {
        if (finish()) resolve(value);
        else opts.onLate?.(value);
      },
      (err: unknown) => {
        if (finish()) reject(err);
      },
    );
  });
}

/** Wait `ms`; resolves early (never rejects) when `signal` aborts. Leaves no timer behind. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Runs async tasks one at a time, in call order. A failing task does not block later ones. */
export class SerialQueue {
  private tail: Promise<unknown>;

  /** `after`: tasks start only once this settles. */
  constructor(after: Promise<unknown> = Promise.resolve()) {
    this.tail = after.catch(() => undefined);
  }

  run<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

// rtmp/srt URLs embed stream keys: keep scheme + host only. http(s) URLs: drop query + fragment.
const URL_RE = /\b(rtmps?|srt|https?|wss?):\/\/[^\s'"<>]+/gi;

export function redactText(text: string): string {
  return text.replace(URL_RE, (match: string, scheme: string) => {
    try {
      const u = new URL(match);
      if (/^(rtmps?|srt)$/i.test(scheme)) return `${u.protocol}//${u.host}/…`;
      return `${u.protocol}//${u.host}${u.pathname}${u.search || u.hash ? '?…' : ''}`;
    } catch {
      return `${scheme}://…`;
    }
  });
}

/** A short, secret-free message for an error, suitable for the UI and logs. */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const msg = redactText(raw).trim();
  return (msg || 'Unknown error').slice(0, 500);
}

/** Number of user-perceived characters (code points), as platforms count title length. */
export function textLength(text: string): number {
  return Array.from(text).length;
}

/** Deterministic JSON (sorted object keys), for config fingerprints. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
    }
    return v;
  });
}
