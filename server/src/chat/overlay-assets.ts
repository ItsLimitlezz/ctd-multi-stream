// Static assets for the OBS chat overlay (Browser Source). Served by routes/chat.ts.
// The global CSP is `script-src 'self'`, so the page loads its script from /overlay/chat.js
// (no inline scripts). The script renders with textContent only — never innerHTML.

import type { PlatformId } from '../../../shared/types.js';

export interface PlatformBadge {
  label: string;
  letter: string;
  bg: string;
  fg: string;
}

/** Small colored platform badges (initial letter in brand color; no logos). */
export const PLATFORM_BADGES: Record<PlatformId, PlatformBadge> = {
  twitch: { label: 'Twitch', letter: 'T', bg: '#9146FF', fg: '#FFFFFF' },
  youtube: { label: 'YouTube', letter: 'Y', bg: '#FF0000', fg: '#FFFFFF' },
  kick: { label: 'Kick', letter: 'K', bg: '#53FC18', fg: '#0B0E0F' },
  facebook: { label: 'Facebook', letter: 'F', bg: '#1877F2', fg: '#FFFFFF' },
  x: { label: 'X', letter: 'X', bg: '#000000', fg: '#FFFFFF' },
  instagram: { label: 'Instagram', letter: 'I', bg: '#E1306C', fg: '#FFFFFF' },
  tiktok: { label: 'TikTok', letter: 'T', bg: '#00F2EA', fg: '#000000' },
  custom: { label: 'Custom', letter: 'C', bg: '#888888', fg: '#FFFFFF' },
};

export const OVERLAY_DEFAULT_MAX = 15;
export const OVERLAY_MAX_LIMIT = 100;

/** The page itself is static: the token stays in the URL and is read by the script. */
export const OVERLAY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>Chat overlay</title>
<link rel="stylesheet" href="chat.css">
</head>
<body>
<ol id="chat" aria-live="polite"></ol>
<script src="chat.js" defer></script>
</body>
</html>
`;

/** Users can restyle via OBS "Custom CSS" by overriding the --chat-* variables. */
export const OVERLAY_CSS = `:root {
  --chat-font: "Segoe UI", Inter, system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
  --chat-font-size: 22px;
  --chat-text: #ffffff;
  --chat-bg: rgba(10, 10, 14, 0.55);
  --chat-radius: 10px;
  --chat-gap: 6px;
  --chat-fade: 1s;
}
html, body {
  margin: 0;
  padding: 0;
  background: transparent;
  overflow: hidden;
}
body {
  font-family: var(--chat-font);
  font-size: var(--chat-font-size);
  line-height: 1.35;
  color: var(--chat-text);
  -webkit-font-smoothing: antialiased;
}
#chat {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  max-height: 100vh;
  margin: 0;
  padding: 8px;
  box-sizing: border-box;
  list-style: none;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: flex-start;
  gap: var(--chat-gap);
}
.msg {
  max-width: 100%;
  box-sizing: border-box;
  padding: 0.3em 0.55em;
  border-radius: var(--chat-radius);
  background: var(--chat-bg);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
  overflow-wrap: anywhere;
  animation: chat-in 0.2s ease-out;
  transition: opacity var(--chat-fade) ease;
}
.msg.fading {
  opacity: 0;
}
.msg.event {
  font-style: italic;
}
.badge {
  display: inline-block;
  min-width: 1.35em;
  height: 1.35em;
  line-height: 1.35em;
  margin-right: 0.45em;
  border-radius: 0.3em;
  text-align: center;
  vertical-align: 0.12em;
  font-size: 0.72em;
  font-weight: 800;
  font-style: normal;
  text-shadow: none;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.25);
}
.author {
  font-weight: 700;
  margin-right: 0.35em;
}
.author::after {
  content: ":";
  color: var(--chat-text);
}
.msg.event .author::after {
  content: "";
}
.text {
  font-weight: 500;
}
@keyframes chat-in {
  from { opacity: 0; transform: translateY(0.4em); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .msg { animation: none; transition: none; }
}
`;

/**
 * Overlay client. Query params: token (required), max (visible messages, default 15),
 * fade (seconds before a message fades out; 0/absent = never).
 * Embedded in a template literal: no backticks or placeholders besides the constants injected here.
 */
export const OVERLAY_JS = `(function () {
  'use strict';
  var BADGES = ${JSON.stringify(PLATFORM_BADGES)};
  var FALLBACK = { label: 'Chat', letter: '?', bg: '#888888', fg: '#FFFFFF' };
  var HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  var SEEN_LIMIT = 1000;
  var FADE_OUT_MS = 1000;

  var params = new URLSearchParams(location.search);
  var token = params.get('token') || '';
  var maxVisible = Math.round(numParam('max', ${OVERLAY_DEFAULT_MAX}, 1, ${OVERLAY_MAX_LIMIT}));
  var fadeMs = numParam('fade', 0, 0, 3600) * 1000;
  var list = document.getElementById('chat');
  var seen = new Set();
  var seenOrder = [];
  /** id -> { node, dest, userId, name, login } for messages on screen (moderation removes them). */
  var shown = new Map();
  var retryMs = 1000;
  var stopped = false;

  function numParam(name, def, min, max) {
    var raw = params.get(name);
    if (raw === null || raw === '') return def;
    var n = Number(raw);
    if (!isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  function remember(id) {
    if (seen.has(id)) return false;
    seen.add(id);
    seenOrder.push(id);
    if (seenOrder.length > SEEN_LIMIT) seen.delete(seenOrder.shift());
    return true;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function removeNode(node) {
    if (typeof node.ctdId === 'string' && shown.get(node.ctdId) && shown.get(node.ctdId).node === node) {
      shown.delete(node.ctdId);
    }
    node.remove();
  }

  function trim() {
    while (list.childElementCount > maxVisible && list.firstElementChild) {
      removeNode(list.firstElementChild);
    }
  }

  function scheduleFade(item, delay) {
    setTimeout(function () {
      item.classList.add('fading');
      setTimeout(function () { removeNode(item); }, FADE_OUT_MS);
    }, Math.max(0, delay));
  }

  function lower(v) {
    return typeof v === 'string' ? v.toLowerCase() : null;
  }

  /** Remove what moderation removed: one message, one user's messages, or a destination's whole chat. */
  function moderate(mod) {
    if (!mod || typeof mod !== 'object' || typeof mod.destinationId !== 'string') return;
    var victims = [];
    if (mod.kind === 'message-deleted') {
      shown.forEach(function (entry, id) {
        if (entry.dest !== mod.destinationId) return;
        if ((typeof mod.messageId === 'string' && id === mod.messageId) ||
            (typeof mod.platformMessageId === 'string' && (entry.platformMessageId === mod.platformMessageId || id === mod.platform + ':' + mod.platformMessageId))) {
          victims.push(entry.node);
        }
      });
    } else if (mod.kind === 'user-cleared') {
      var userId = typeof mod.userId === 'string' ? mod.userId : null;
      var userName = lower(mod.userName);
      shown.forEach(function (entry) {
        if (entry.dest !== mod.destinationId) return;
        var match = userId && entry.userId ? entry.userId === userId
          : (userName !== null && (lower(entry.name) === userName || lower(entry.login) === userName));
        if (match) victims.push(entry.node);
      });
    } else if (mod.kind === 'cleared') {
      shown.forEach(function (entry) {
        if (entry.dest === mod.destinationId) victims.push(entry.node);
      });
    }
    victims.forEach(removeNode);
  }

  function render(m) {
    if (!m || typeof m.id !== 'string' || typeof m.text !== 'string') return;
    if (!remember(m.id)) return;
    var age = 0;
    if (fadeMs > 0) {
      var ts = Date.parse(m.ts);
      if (isFinite(ts)) age = Math.max(0, Date.now() - ts);
      if (age >= fadeMs) return;
    }
    var known = Object.prototype.hasOwnProperty.call(BADGES, m.platform);
    var brand = known ? BADGES[m.platform] : FALLBACK;
    var author = m.author && typeof m.author === 'object' ? m.author : {};

    var item = el('li', m.kind === 'event' ? 'msg event' : 'msg');
    item.setAttribute('data-platform', known ? m.platform : 'unknown');
    var badge = el('span', 'badge', brand.letter);
    badge.title = brand.label;
    badge.style.backgroundColor = brand.bg;
    badge.style.color = brand.fg;
    var name = el('span', 'author', typeof author.name === 'string' ? author.name : '');
    if (typeof author.color === 'string' && HEX_COLOR.test(author.color)) name.style.color = author.color;
    item.append(badge, name, el('span', 'text', m.text));
    item.ctdId = m.id;
    shown.set(m.id, {
      node: item,
      dest: m.destinationId,
      platformMessageId: typeof m.platformMessageId === 'string' ? m.platformMessageId : null,
      userId: typeof author.id === 'string' ? author.id : null,
      name: author.name,
      login: author.login
    });

    list.appendChild(item);
    trim();
    if (fadeMs > 0) scheduleFade(item, fadeMs - age);
  }

  function retry() {
    if (stopped) return;
    var wait = retryMs + Math.floor(Math.random() * 250);
    retryMs = Math.min(retryMs * 2, 30000);
    setTimeout(connect, wait);
  }

  function connect() {
    if (stopped) return;
    var url = new URL('ws', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = '?token=' + encodeURIComponent(token);
    url.hash = '';
    var ws;
    try {
      ws = new WebSocket(url.toString());
    } catch (e) {
      retry();
      return;
    }
    var openedAt = 0;
    ws.onopen = function () {
      openedAt = Date.now();
    };
    ws.onmessage = function (ev) {
      var data;
      try {
        data = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (data && data.type === 'chat') render(data.message);
      else if (data && data.type === 'chat-moderation') moderate(data.moderation);
    };
    ws.onclose = function (ev) {
      if (ev.code === 4401) {
        stopped = true; // token rotated or wrong: this URL will never work again
        return;
      }
      if (openedAt && Date.now() - openedAt > 10000) retryMs = 1000;
      retry();
    };
  }

  if (list && token) connect();
})();
`;
