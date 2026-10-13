import { truncate } from './normalize.js';

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi;
const SECRET_PARAM_RE = /\b(\w*(?:token|key|secret|password|sig|signature))\s*[=:]\s*[^\s&,;'"]+/gi;
const BEARER_RE = /\bbearer\s+[\w.~+/-]+=*/gi;

/** Error text that is safe to log: URLs reduced to scheme + host, token-like values masked. */
export function safeErrorMessage(err: unknown): string {
  const raw =
    err instanceof Error ? `${err.name}: ${err.message}` : typeof err === 'string' ? err : 'unknown error';
  const redacted = raw
    .replace(URL_RE, (m) => {
      try {
        const u = new URL(m);
        return `${u.protocol}//${u.host}`;
      } catch {
        return '[url]';
      }
    })
    .replace(SECRET_PARAM_RE, '$1=[redacted]')
    .replace(BEARER_RE, 'Bearer [redacted]');
  return truncate(redacted, 300);
}
