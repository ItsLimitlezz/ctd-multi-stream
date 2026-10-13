// RTMP(S) push URL helpers for paste-a-key destinations (Custom RTMP, X).

const RTMP_PROTOCOLS = new Set(['rtmp:', 'rtmps:']);
/** Same bound as the destination route (validation.ts MAX_URL). */
const MAX_LENGTH = 2048;

/** Problem with a server URL entered by the user, or null when it is a usable rtmp(s):// URL. */
export function rtmpUrlProblem(value: string | null | undefined, label = 'Server URL'): string | null {
  const s = value?.trim() ?? '';
  if (!s) return `${label} is missing`;
  if (s.length > MAX_LENGTH) return `${label} is too long`;
  if (/\s/.test(s)) return `${label} must not contain spaces`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return `${label} must be an rtmp:// or rtmps:// URL`;
  }
  if (!RTMP_PROTOCOLS.has(url.protocol)) return `${label} must start with rtmp:// or rtmps://`;
  if (!url.hostname) return `${label} has no host name`;
  return null;
}

/** Problem with a pasted stream key, or null. An empty key is allowed (checked by callers). */
export function streamKeyProblem(key: string): string | null {
  if (key.length > MAX_LENGTH) return 'Stream key is too long';
  if (/[\s\u0000-\u001f\u007f]/.test(key)) return 'Stream key must not contain spaces or control characters';
  return null;
}

/**
 * Final push URL: `<server>/<key>` with exactly one slash between them, the way OBS joins its
 * "Server" and "Stream key" fields. The key is not encoded (some servers expect `name?params`).
 * Without a key the server URL is used as-is (key already embedded). Never log the result.
 */
export function joinIngestUrl(server: string, key?: string | null): string {
  const base = server.trim();
  const k = (key ?? '').trim().replace(/^\/+/, '');
  if (!k) return base;
  return `${base.replace(/\/+$/, '')}/${k}`;
}

/** Scheme + host of a URL, safe for logs (no path, no key). */
export function safeHost(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '[invalid url]';
  }
}
