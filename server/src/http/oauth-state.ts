// Helpers for the OAuth redirect landing (GET /oauth/callback/:platform).
// Drivers build `state` as '<accountId>.<random>' (see platforms/common/oauth.ts makeState()).

/** Account id embedded in an OAuth `state`, or null when the state is malformed. */
export function accountIdFromState(state: string | null | undefined): string | null {
  if (!state || state.length > 512) return null;
  const dot = state.lastIndexOf('.');
  if (dot <= 0 || dot === state.length - 1) return null;
  return state.slice(0, dot);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Tiny page that re-requests `target` (a same-origin path) from our own origin.
 *
 * The session cookie is SameSite=Strict, so browsers leave it off the cross-site redirect
 * coming back from the platform's consent page. A navigation started by one of our own
 * pages is same-site, so the cookie is sent the second time. Uses a meta refresh (no
 * inline script, so it passes the strict CSP) plus a manual link as a fallback.
 */
export function sameSiteBouncePage(target: string): string {
  const href = escapeHtml(target);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0;url=${href}">
<title>Connecting…</title>
</head>
<body>
<p>Finishing the connection… <a href="${href}">Continue</a></p>
</body>
</html>
`;
}
