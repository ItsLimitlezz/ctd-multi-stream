// Small fetch helpers shared by platform drivers.

export class PlatformHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: string,
  ) {
    super(message);
    this.name = 'PlatformHttpError';
  }
}

export interface FetchJsonInit extends Omit<RequestInit, 'signal'> {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** fetch + JSON with a timeout. Throws PlatformHttpError (body truncated, no secrets) on non-2xx. */
export async function fetchJson<T>(url: string, init: FetchJsonInit = {}): Promise<T> {
  const { timeoutMs = 15_000, signal, ...rest } = init;
  const res = await fetch(url, { ...rest, signal: combineSignals(signal, timeoutMs) });
  const text = await res.text();
  if (!res.ok) {
    const host = safeHost(url);
    throw new PlatformHttpError(res.status, `${host} responded ${res.status}: ${summarize(text)}`, text.slice(0, 2000));
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PlatformHttpError(res.status, `${safeHost(url)} returned invalid JSON`, text.slice(0, 2000));
  }
}

/** POST application/x-www-form-urlencoded and parse JSON. */
export function postForm<T>(url: string, form: Record<string, string>, init: FetchJsonInit = {}): Promise<T> {
  return fetchJson<T>(url, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...(init.headers ?? {}) },
    body: new URLSearchParams(form).toString(),
  });
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'platform';
  }
}

/** Extract a short human-readable message from an error body (JSON `message`/`error_description`/`error`). */
function summarize(text: string): string {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const err = j.error;
    const msg =
      j.error_description ??
      j.message ??
      (typeof err === 'object' && err !== null ? (err as Record<string, unknown>).message : undefined) ??
      err;
    if (typeof msg === 'string') return msg.slice(0, 300);
  } catch {
    /* not JSON */
  }
  return text.replace(/\s+/g, ' ').slice(0, 200) || 'no body';
}

/** Truncate to `max` user-visible characters (code points), for platform title limits. */
export function truncateTitle(title: string, max: number): string {
  const chars = [...title.trim()];
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
}
