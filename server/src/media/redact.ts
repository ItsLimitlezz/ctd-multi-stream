// Helpers to keep stream keys and credentials out of logs and UI messages.
// Ingest/egress URLs embed stream keys (path or query), so only scheme + host are ever shown.

/** Scheme + host (incl. port) only, e.g. `rtmps://live.twitch.tv:443`. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.host) return `${u.protocol}//${u.host}`;
  } catch {
    // fall through to the lenient parser
  }
  const m = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/?#\s@]*@)?([^/?#\s]*)/i.exec(url.trim());
  return m?.[2] ? `${m[1]}${m[2]}` : '[redacted url]';
}

// rtmp, rtmps, rtmpt, rtmpe, rtmpts, rtmpte, srt, rtsp, rtsps — anything an FFmpeg/MediaMTX line may echo.
const MEDIA_URL_RE = /\b(?:rtmp[a-z]{0,2}|srt|rtsps?):\/\/[^\s'"<>]+/gi;
// Punctuation that usually ends a sentence rather than the URL (e.g. "rtmp://h/app/key: I/O error").
const TRAILING_PUNCT_RE = /[:,.;)\]}]+$/;

/** Replace every media URL token in free text with its redacted form. */
export function redactUrlsInText(text: string): string {
  return text.replace(MEDIA_URL_RE, (token) => {
    const trail = TRAILING_PUNCT_RE.exec(token)?.[0] ?? '';
    const url = trail ? token.slice(0, -trail.length) : token;
    return redactUrl(url) + trail;
  });
}

const SECRET_PARAM_RE = /\b(key|pass|password|token|streamkey|stream_key|secret|sig)=([^&\s'"<>]+)/gi;

/** Redact media URLs plus loose `key=`/`pass=`-style parameters (e.g. echoed query strings). */
export function redactSecretsInText(text: string): string {
  return redactUrlsInText(text).replace(SECRET_PARAM_RE, '$1=[redacted]');
}

/**
 * Secret-looking parts of a URL (path segments, query values, userinfo) that a remote server might
 * echo back without the URL around them, e.g. a stream key inside an RTMP error description.
 */
export function urlSecretFragments(url: string, minLength = 8): string[] {
  const parts = new Set<string>();
  try {
    const u = new URL(url);
    for (const seg of u.pathname.split('/')) parts.add(safeDecode(seg));
    for (const v of u.searchParams.values()) parts.add(v);
    if (u.username) parts.add(safeDecode(u.username));
    if (u.password) parts.add(safeDecode(u.password));
  } catch {
    // not a parseable URL: nothing extra to hide
  }
  return [...parts].filter((p) => p.length >= minLength).sort((a, b) => b.length - a.length);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Replace each fragment occurrence with [redacted]. */
export function redactFragments(text: string, fragments: readonly string[]): string {
  let out = text;
  for (const f of fragments) if (f) out = out.split(f).join('[redacted]');
  return out;
}
