// Small shared utilities for the browser module (URL checks, safe error text).

const URL_RE = /\b(?:https?|wss?|rtmps?):\/\/[^\s"'<>`]+/gi;

/**
 * Parse an http(s) URL. Returns null for anything else (javascript:, file:, data:, chrome:...).
 * With `allowBareHost`, input without a scheme ("instagram.com/accounts") is treated as https.
 */
export function parseHttpUrl(input: string, opts: { allowBareHost?: boolean } = {}): URL | null {
  let text = input.trim();
  if (!text) return null;
  if (opts.allowBareHost && !/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

/** Scheme + host only (safe to log / audit: never includes paths, queries or credentials). */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host ? `${u.protocol}//${u.host}` : u.protocol;
  } catch {
    return '[invalid url]';
  }
}

/** First line of an error message with every URL reduced to scheme + host (safe for logs). */
export function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const firstLine = raw.split('\n', 1)[0] ?? '';
  return firstLine.replace(URL_RE, (m) => redactUrl(m)).slice(0, 300);
}

/** User-facing text for a failed navigation. */
export function navErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const net = /net::ERR_[A-Z0-9_]+/.exec(raw);
  if (net) return `Could not load the page (${net[0]})`;
  if ((err instanceof Error && err.name === 'TimeoutError') || /Timeout \d+ms exceeded/i.test(raw)) {
    return 'The page took too long to load';
  }
  return 'Could not load the page';
}

/** True for errors that just mean "a newer navigation replaced this one". */
export function isNavigationInterrupted(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err);
  return /interrupted by another navigation|net::ERR_ABORTED|frame was detached/i.test(raw);
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}
