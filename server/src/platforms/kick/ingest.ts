// Kick ingest URL handling (pure).
//
// Kick streams through Amazon IVS. The dashboard (and the API's `stream.url`) shows the server as
// `rtmps://fa723fc1b171.global-contribute.live-video.net` without the `/app` application path that
// IVS needs; encoders must use `rtmps://<host>[:443]/app/<stream key>`. Sources (Oct 2026):
// https://support.streamyard.com/hc/en-us/articles/16599000591508-Streaming-to-Kick-com,
// https://www.unilink.us/blog/how-to-stream-on-kick-2026

export const KICK_DEFAULT_INGEST = 'rtmps://fa723fc1b171.global-contribute.live-video.net/app';

/**
 * Canonical server URL: rtmp(s) only, no credentials/query/fragment, no trailing slash, and the
 * IVS `/app` path added when the URL has none. Null when the value is not a usable server URL.
 */
export function normalizeIngestServer(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== 'rtmp:' && u.protocol !== 'rtmps:') return null;
  if (!u.hostname || u.username || u.password || u.search || u.hash) return null;
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path || '/app'}`;
}

/**
 * Pick the server: an explicit non-default server on the destination wins (e.g. a regional ingest),
 * then the URL Kick's API reports for the account, then Kick's global ingest.
 */
export function chooseIngestServer(destIngestUrl: string | null, apiUrl: string | null | undefined): string {
  const fallback = normalizeIngestServer(KICK_DEFAULT_INGEST)!;
  const custom = normalizeIngestServer(destIngestUrl);
  if (custom && custom !== fallback) return custom;
  return normalizeIngestServer(apiUrl) ?? fallback;
}

/** `<server>/<key>` with exactly one slash. The result embeds the key: never log it. */
export function buildPushUrl(server: string, key: string): string {
  return `${server.replace(/\/+$/, '')}/${key.trim().replace(/^\/+/, '')}`;
}

/** A stream key we can put in a URL path: non-empty, no whitespace, control characters or slashes. */
export function usableStreamKey(key: string | null | undefined): string | null {
  const k = key?.trim();
  if (!k || /[\s\u0000-\u001f\u007f/?#]/.test(k)) return null;
  return k;
}
