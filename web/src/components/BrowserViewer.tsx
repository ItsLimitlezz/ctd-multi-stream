// Remote-controlled browser page (login viewer). Shows JPEG frames of a server-side Playwright page
// streamed over a WebSocket and relays mouse, wheel, keyboard, paste and touch input back.
// Protocol: BrowserServerMessage / BrowserClientMessage in shared/api.ts.

import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react';
import type { BrowserClientMessage, BrowserServerMessage } from '@shared/api';
import { wsUrl } from '../api';
import { Button } from './Button';
import { RetryIcon } from './icons';
import { Spinner } from './Spinner';
import { StatusDot } from './StatusDot';
import { TextInput } from './TextInput';
import { cx, type Tone } from './utils';
import './browser-viewer.css';

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** The server clamps the remote viewport to these bounds too. */
export const VIEWPORT = { minWidth: 320, maxWidth: 1920, minHeight: 320, maxHeight: 1200 } as const;
/** Remote viewport height as a share of the window height. */
const HEIGHT_RATIO = 0.6;
const MOVE_INTERVAL_MS = 33; // ~30 mouse moves per second
const WHEEL_INTERVAL_MS = 33;
const RESIZE_DEBOUNCE_MS = 250;
const LINE_HEIGHT_PX = 40;
const MAX_WHEEL = 5000;
const TAP_SLOP_PX = 10;
const DOUBLE_TAP_MS = 400;
const MAX_TYPE_CHARS = 20_000;
const NOTICE_MS = 8000;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export interface ModifierState {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface KeyLike extends ModifierState {
  key: string;
  code: string;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

type KeyMessage = Extract<BrowserClientMessage, { type: 'key' }>;
type FrameMessage = Extract<BrowserServerMessage, { type: 'frame' }>;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** CDP modifier bitmask: Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8. */
export function cdpModifiers(e: ModifierState): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/** DOM MouseEvent.button -> protocol button (back/forward buttons are ignored). */
export function mouseButton(button: number): 'left' | 'middle' | 'right' | null {
  if (button === 0) return 'left';
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  return null;
}

/** MouseEvent.detail -> click count accepted by the server (1–4). */
export function clickCount(detail: number): number {
  return Number.isFinite(detail) ? clamp(Math.round(detail), 1, 4) : 1;
}

export function clampViewport(width: number, height: number): Size {
  return {
    width: clamp(Math.round(width), VIEWPORT.minWidth, VIEWPORT.maxWidth),
    height: clamp(Math.round(height), VIEWPORT.minHeight, VIEWPORT.maxHeight),
  };
}

/** Remote viewport for a container `containerWidth` px wide in a window `windowHeight` px tall. */
export function viewportFor(containerWidth: number, windowHeight: number): Size {
  return clampViewport(containerWidth, windowHeight * HEIGHT_RATIO);
}

/** Client coordinates -> remote page CSS pixels, using the canvas' displayed rect vs the frame size. */
export function toFrameCoords(clientX: number, clientY: number, rect: Rect, frame: Size): { x: number; y: number } {
  const sx = rect.width > 0 ? frame.width / rect.width : 1;
  const sy = rect.height > 0 ? frame.height / rect.height : 1;
  return {
    x: Math.round(clamp((clientX - rect.left) * sx, 0, Math.max(0, frame.width - 1))),
    y: Math.round(clamp((clientY - rect.top) * sy, 0, Math.max(0, frame.height - 1))),
  };
}

/** Wheel deltas in pixels (DOM_DELTA_LINE / DOM_DELTA_PAGE converted). */
export function wheelPixels(e: { deltaX: number; deltaY: number; deltaMode: number }, pageHeight: number): { deltaX: number; deltaY: number } {
  // https://developer.mozilla.org/docs/Web/API/WheelEvent/deltaMode
  const unit = e.deltaMode === 1 ? LINE_HEIGHT_PX : e.deltaMode === 2 ? Math.max(1, pageHeight) : 1;
  return { deltaX: e.deltaX * unit, deltaY: e.deltaY * unit };
}

/** Key message for a DOM key event, or null when it can't be relayed. */
export function keyMessage(action: 'down' | 'up', e: KeyLike): KeyMessage | null {
  if (!e.key || e.key.length > 40 || e.code.length > 40) return null;
  const msg: KeyMessage = { type: 'key', action, key: e.key, code: e.code, modifiers: cdpModifiers(e) };
  if ([...e.key].length === 1) msg.text = e.key;
  return msg;
}

/** Ctrl/Cmd+V or Shift+Insert: let the browser fire a `paste` event (local clipboard) instead. */
export function isPasteShortcut(e: KeyLike): boolean {
  if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Insert') return true;
  return (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v';
}

/** Max gap between two Escape presses (or a held Escape's first repeat) that leaves the page area. */
export const RELEASE_ESCAPE_MS = 1000;

/**
 * Escape pressed twice (or held) without modifiers: give the keyboard back to this window instead of
 * relaying it, so keyboard users aren't trapped in the page area (Tab is relayed to the remote page).
 */
export function isReleaseEscape(e: KeyLike, lastEscapeAt: number | null, now: number): boolean {
  return e.key === 'Escape' && cdpModifiers(e) === 0 && lastEscapeAt !== null && now - lastEscapeAt <= RELEASE_ESCAPE_MS;
}

/** Address typed in the URL bar -> absolute http(s) URL, or null. A bare host gets https://. */
export function normalizeAddress(raw: string): string | null {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  let candidate: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) candidate = s;
  else if (/^(?:javascript|data|file|about|blob|vbscript|chrome|view-source):/i.test(s)) return null;
  else candidate = `https://${s}`;
  try {
    const u = new URL(candidate);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? u.href : null;
  } catch {
    return null;
  }
}

const isPositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Parse one server message; unknown or malformed messages -> null. */
export function parseBrowserMessage(raw: unknown): BrowserServerMessage | null {
  if (typeof raw !== 'string') return null;
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return null;
  const m = d as Record<string, unknown>;
  switch (m.type) {
    case 'frame':
      return typeof m.data === 'string' && BASE64_RE.test(m.data) && isPositive(m.width) && isPositive(m.height)
        ? { type: 'frame', data: m.data, width: m.width, height: m.height }
        : null;
    case 'url':
      return typeof m.url === 'string' ? { type: 'url', url: m.url, title: typeof m.title === 'string' ? m.title : '' } : null;
    case 'closed':
      return { type: 'closed' };
    case 'error':
      return { type: 'error', message: typeof m.message === 'string' && m.message ? m.message : 'Something went wrong in the browser.' };
    default:
      return null;
  }
}

/** Human message for a WebSocket close (codes from server/src/http/routes/browser.ts). */
export function closeMessage(code: number, reason: string): string {
  switch (code) {
    case 4000:
      return 'This browser was opened in another window or tab.';
    case 4404:
      return 'This account no longer exists.';
    case 4401:
      return 'Your session ended. Log in again to use the browser.';
    case 1011:
      return 'The browser could not be started. Check the server logs.';
    case 1001:
      return 'The server is shutting down.';
    case 1000:
      return reason === 'Browser closed' ? 'The browser was closed.' : 'Disconnected.';
    default:
      return 'The connection to the browser was lost.';
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type ConnState = 'connecting' | 'open' | 'closed';

const CONN_META: Record<ConnState, { label: string; tone: Tone }> = {
  connecting: { label: 'Connecting…', tone: 'warn' },
  open: { label: 'Connected', tone: 'success' },
  closed: { label: 'Disconnected', tone: 'danger' },
};

export interface BrowserViewerProps {
  accountId: string;
  /** Called when the remote browser window closed (every page of it). */
  onClosed?: () => void;
  /** Accessible name of the page area. */
  label?: string;
  className?: string;
}

/** Live view of an account's server-side browser with full mouse/keyboard/touch control. */
export function BrowserViewer({ accountId, onClosed, label = 'Remote browser page', className }: BrowserViewerProps) {
  const [conn, setConn] = useState<ConnState>('connecting');
  const [closedText, setClosedText] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [hasFrame, setHasFrame] = useState(false);
  const [page, setPage] = useState({ url: '', title: '' });
  /** Address bar text while the user edits it (null = show the page URL). */
  const [address, setAddress] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [typeText, setTypeText] = useState('');

  const socketRef = useRef<WebSocket | null>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const lastEscapeRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<Size | null>(null);
  const viewportKeyRef = useRef('');
  /** Keys pressed in the page area whose key-up hasn't been relayed yet (by code). */
  const heldKeysRef = useRef(new Map<string, { key: string; code: string }>());
  const onClosedRef = useRef(onClosed);
  useEffect(() => {
    onClosedRef.current = onClosed;
  });

  const send = useCallback((msg: BrowserClientMessage): boolean => {
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }, []);

  /** Make the remote viewport match the space we have (skipped when unchanged). */
  const sendViewport = useCallback(() => {
    const el = screenRef.current;
    if (!el || el.clientWidth <= 0) return;
    const vp = viewportFor(el.clientWidth, window.innerHeight);
    const key = `${vp.width}x${vp.height}`;
    if (key !== viewportKeyRef.current && send({ type: 'resize', ...vp })) viewportKeyRef.current = key;
  }, [send]);

  // ---- connection + frames ----
  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;
    let pending: FrameMessage | null = null;
    let decoding = false;
    let drawn = false;
    heldKeysRef.current.clear();
    setConn('connecting');
    setClosedText(null);

    const decodeNext = () => {
      if (disposed || decoding || !pending) return;
      const frame = pending;
      pending = null;
      decoding = true;
      const img = new Image();
      img.onload = () => {
        decoding = false;
        if (disposed) return;
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (canvas && ctx) {
          if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
          }
          ctx.drawImage(img, 0, 0);
          frameRef.current = { width: frame.width, height: frame.height };
          if (!drawn) {
            drawn = true;
            setHasFrame(true);
          }
        }
        decodeNext();
      };
      img.onerror = () => {
        decoding = false;
        decodeNext();
      };
      img.src = `data:image/jpeg;base64,${frame.data}`;
    };

    // Deferred so React StrictMode's mount/unmount/mount doesn't open two sockets.
    const timer = setTimeout(() => {
      if (disposed) return;
      try {
        ws = new WebSocket(wsUrl(`/api/browser/${encodeURIComponent(accountId)}/ws`));
      } catch {
        setConn('closed');
        setClosedText('Could not connect to the browser.');
        return;
      }
      socketRef.current = ws;
      ws.onopen = () => {
        if (disposed) return;
        setConn('open');
        viewportKeyRef.current = '';
        sendViewport();
      };
      ws.onmessage = (ev: MessageEvent) => {
        if (disposed) return;
        const msg = parseBrowserMessage(ev.data);
        if (!msg) return;
        switch (msg.type) {
          case 'frame':
            pending = msg;
            decodeNext();
            break;
          case 'url':
            setPage({ url: msg.url, title: msg.title });
            break;
          case 'error':
            setNotice(msg.message);
            break;
          case 'closed':
            setClosedText('The browser window was closed.');
            onClosedRef.current?.();
            break;
        }
      };
      ws.onclose = (ev: CloseEvent) => {
        if (disposed) return;
        socketRef.current = null;
        setConn('closed');
        setClosedText((prev) => prev ?? closeMessage(ev.code, ev.reason));
      };
    }, 0);

    return () => {
      disposed = true;
      clearTimeout(timer);
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        try {
          ws.close(1000, 'Viewer closed');
        } catch {
          /* already closed */
        }
        if (socketRef.current === ws) socketRef.current = null;
      }
    };
  }, [accountId, attempt, sendViewport]);

  // ---- remote viewport follows our size ----
  useEffect(() => {
    const el = screenRef.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(sendViewport, RESIZE_DEBOUNCE_MS);
    };
    const ro = el && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (el) ro?.observe(el);
    window.addEventListener('resize', schedule);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', schedule);
      clearTimeout(timer);
    };
  }, [sendViewport]);

  // ---- transient notices ----
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  // ---- pointer input (native listeners: wheel/touch must be non-passive to preventDefault) ----
  useEffect(() => {
    const screen = screenRef.current;
    if (!screen) return;

    const coords = (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      const frame = frameRef.current;
      if (!canvas || !frame) return null;
      return toFrameCoords(clientX, clientY, canvas.getBoundingClientRect(), frame);
    };

    // Mouse moves: at most ~30/s, and the last position is always delivered.
    let moveTimer: ReturnType<typeof setTimeout> | null = null;
    let lastMoveAt = 0;
    let pendingMove: { x: number; y: number } | null = null;
    const flushMove = () => {
      moveTimer = null;
      if (!pendingMove) return;
      lastMoveAt = performance.now();
      send({ type: 'mouse', action: 'move', ...pendingMove });
      pendingMove = null;
    };
    const queueMove = (p: { x: number; y: number }) => {
      pendingMove = p;
      if (moveTimer) return;
      const wait = MOVE_INTERVAL_MS - (performance.now() - lastMoveAt);
      if (wait <= 0) flushMove();
      else moveTimer = setTimeout(flushMove, wait);
    };
    const dropMove = () => {
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = null;
      pendingMove = null;
    };

    // Wheel deltas are summed and sent ~30/s.
    let wheel = { x: 0, y: 0, dx: 0, dy: 0 };
    let wheelTimer: ReturnType<typeof setTimeout> | null = null;
    const flushWheel = () => {
      wheelTimer = null;
      const w = wheel;
      wheel = { ...w, dx: 0, dy: 0 };
      const deltaX = clamp(Math.round(w.dx), -MAX_WHEEL, MAX_WHEEL);
      const deltaY = clamp(Math.round(w.dy), -MAX_WHEEL, MAX_WHEEL);
      if (deltaX || deltaY) send({ type: 'mouse', action: 'wheel', x: w.x, y: w.y, deltaX, deltaY });
    };
    const queueWheel = (x: number, y: number, dx: number, dy: number) => {
      wheel = { x, y, dx: wheel.dx + dx, dy: wheel.dy + dy };
      wheelTimer ??= setTimeout(flushWheel, WHEEL_INTERVAL_MS);
    };

    // While a button is held, follow the mouse outside the canvas too (drags, releases).
    let dragging = false;
    const stopDragging = () => {
      dragging = false;
      window.removeEventListener('mousemove', onWindowMouseMove, true);
      window.removeEventListener('mouseup', onWindowMouseUp, true);
    };
    const onWindowMouseMove = (e: MouseEvent) => {
      const p = coords(e.clientX, e.clientY);
      if (p) queueMove(p);
    };
    const onWindowMouseUp = (e: MouseEvent) => {
      const button = mouseButton(e.button);
      const p = coords(e.clientX, e.clientY);
      if (button && p) {
        dropMove();
        send({ type: 'mouse', action: 'up', ...p, button, clickCount: clickCount(e.detail) });
      }
      if (e.buttons === 0) stopDragging();
    };
    const onMouseMove = (e: MouseEvent) => {
      if (dragging) return;
      const p = coords(e.clientX, e.clientY);
      if (p) queueMove(p);
    };
    const onMouseDown = (e: MouseEvent) => {
      // preventDefault stops text selection / native drags, so focus by hand.
      e.preventDefault();
      screen.focus({ preventScroll: true });
      const button = mouseButton(e.button);
      const p = coords(e.clientX, e.clientY);
      if (!button || !p) return;
      dropMove();
      send({ type: 'mouse', action: 'down', ...p, button, clickCount: clickCount(e.detail) });
      if (!dragging) {
        dragging = true;
        window.addEventListener('mousemove', onWindowMouseMove, true);
        window.addEventListener('mouseup', onWindowMouseUp, true);
      }
    };
    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    const onWheel = (e: WheelEvent) => {
      const p = coords(e.clientX, e.clientY);
      if (!p) return;
      e.preventDefault();
      const d = wheelPixels(e, frameRef.current?.height ?? 600);
      queueWheel(p.x, p.y, d.deltaX, d.deltaY);
    };

    // Touch: tap = click (double tap = double click), drag = scroll the page.
    let touch: { id: number; startX: number; startY: number; lastX: number; lastY: number; scrolling: boolean; point: { x: number; y: number } } | null =
      null;
    let lastTap: { at: number; x: number; y: number; count: number } | null = null;
    const findTouch = (list: TouchList, id: number): Touch | null => {
      for (let i = 0; i < list.length; i++) {
        const t = list.item(i);
        if (t && t.identifier === id) return t;
      }
      return null;
    };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        touch = null; // multi-finger gestures are left to the browser
        return;
      }
      const t = e.touches.item(0);
      const p = t ? coords(t.clientX, t.clientY) : null;
      if (!t || !p) return;
      e.preventDefault(); // also suppresses the emulated mouse events
      screen.focus({ preventScroll: true });
      touch = { id: t.identifier, startX: t.clientX, startY: t.clientY, lastX: t.clientX, lastY: t.clientY, scrolling: false, point: p };
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!touch) return;
      const t = findTouch(e.changedTouches, touch.id);
      if (!t) return;
      e.preventDefault();
      if (!touch.scrolling && Math.hypot(t.clientX - touch.startX, t.clientY - touch.startY) > TAP_SLOP_PX) touch.scrolling = true;
      const canvas = canvasRef.current;
      const frame = frameRef.current;
      if (touch.scrolling && canvas && frame) {
        const rect = canvas.getBoundingClientRect();
        const scale = rect.width > 0 ? frame.width / rect.width : 1;
        queueWheel(touch.point.x, touch.point.y, (touch.lastX - t.clientX) * scale, (touch.lastY - t.clientY) * scale);
      }
      touch.lastX = t.clientX;
      touch.lastY = t.clientY;
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (!touch) return;
      const t = findTouch(e.changedTouches, touch.id);
      if (!t) return;
      e.preventDefault();
      const done = touch;
      touch = null;
      if (done.scrolling || e.type === 'touchcancel') return;
      const now = performance.now();
      const p = done.point;
      const count =
        lastTap && now - lastTap.at < DOUBLE_TAP_MS && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 24 ? Math.min(lastTap.count + 1, 3) : 1;
      lastTap = { at: now, x: p.x, y: p.y, count };
      send({ type: 'mouse', action: 'down', ...p, button: 'left', clickCount: count });
      send({ type: 'mouse', action: 'up', ...p, button: 'left', clickCount: count });
    };

    const active = { passive: false } as const;
    screen.addEventListener('mousemove', onMouseMove);
    screen.addEventListener('mousedown', onMouseDown);
    screen.addEventListener('contextmenu', onContextMenu);
    screen.addEventListener('wheel', onWheel, active);
    screen.addEventListener('touchstart', onTouchStart, active);
    screen.addEventListener('touchmove', onTouchMove, active);
    screen.addEventListener('touchend', onTouchEnd, active);
    screen.addEventListener('touchcancel', onTouchEnd, active);
    return () => {
      screen.removeEventListener('mousemove', onMouseMove);
      screen.removeEventListener('mousedown', onMouseDown);
      screen.removeEventListener('contextmenu', onContextMenu);
      screen.removeEventListener('wheel', onWheel);
      screen.removeEventListener('touchstart', onTouchStart);
      screen.removeEventListener('touchmove', onTouchMove);
      screen.removeEventListener('touchend', onTouchEnd);
      screen.removeEventListener('touchcancel', onTouchEnd);
      stopDragging();
      dropMove();
      if (wheelTimer) clearTimeout(wheelTimer);
    };
  }, [send]);

  // ---- keyboard + paste (only while the page area has focus) ----
  const onKey = (action: 'down' | 'up') => (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (isPasteShortcut(e)) return; // the paste event below delivers the local clipboard
    e.preventDefault(); // no page scrolling / browser shortcuts while controlling the remote page
    if (action === 'down') {
      const now = Date.now();
      if (isReleaseEscape(e, lastEscapeRef.current, now)) {
        // The first Escape went to the page; this one leaves it (blur releases held keys).
        lastEscapeRef.current = null;
        screenRef.current?.blur();
        return;
      }
      lastEscapeRef.current = e.key === 'Escape' && cdpModifiers(e) === 0 ? now : null;
    }
    const id = e.code || e.key;
    if (action === 'down') heldKeysRef.current.set(id, { key: e.key, code: e.code });
    // A key-up whose key-down happened elsewhere (e.g. Enter in the address bar) is not relayed.
    else if (!heldKeysRef.current.delete(id)) return;
    const msg = keyMessage(action, e);
    if (msg) send(msg);
  };

  /** Focus left the page area: release keys still held so the remote page doesn't see them stuck. */
  const releaseHeldKeys = () => {
    const mods = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    for (const k of heldKeysRef.current.values()) {
      const msg = keyMessage('up', { ...k, ...mods });
      if (msg) send(msg);
    }
    heldKeysRef.current.clear();
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (text) send({ type: 'type', text: text.slice(0, MAX_TYPE_CHARS) });
  };

  const pressKey = (key: 'Enter' | 'Tab' | 'Backspace') => {
    const mods = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    const down = keyMessage('down', { key, code: key, ...mods });
    const up = keyMessage('up', { key, code: key, ...mods });
    if (down && up) {
      send(down);
      send(up);
    }
  };

  const navigateTo = (e: FormEvent) => {
    e.preventDefault();
    const url = normalizeAddress(address ?? page.url);
    if (!url) {
      setNotice('Only http:// and https:// addresses can be opened.');
      return;
    }
    if (send({ type: 'navigate', url })) {
      setAddress(null);
      screenRef.current?.focus({ preventScroll: true });
    }
  };

  const sendTyped = (e: FormEvent) => {
    e.preventDefault();
    if (!typeText) return;
    if (send({ type: 'type', text: typeText.slice(0, MAX_TYPE_CHARS) })) setTypeText('');
  };

  const open = conn === 'open';
  const meta = CONN_META[conn];

  return (
    <div className={cx('browser-viewer', className)}>
      <div className="bv-toolbar">
        <button type="button" className="icon-btn" aria-label="Back" title="Back" onClick={() => send({ type: 'back' })} disabled={!open}>
          <BackIcon />
        </button>
        <button type="button" className="icon-btn" aria-label="Reload" title="Reload" onClick={() => send({ type: 'reload' })} disabled={!open}>
          <RetryIcon />
        </button>
        <form className="bv-address" onSubmit={navigateTo}>
          <TextInput
            mono
            type="text"
            inputMode="url"
            enterKeyHint="go"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Address"
            placeholder="https://"
            value={address ?? page.url}
            onFocus={(e) => {
              setAddress(page.url);
              e.currentTarget.select();
            }}
            onBlur={() => setAddress(null)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setAddress(null);
                e.currentTarget.blur();
              }
            }}
            onValueChange={setAddress}
            disabled={!open}
          />
        </form>
        <button
          type="button"
          className={cx('icon-btn', typing && 'is-active')}
          aria-label="Type text"
          aria-pressed={typing}
          title="Type text (phones and tablets)"
          onClick={() => setTyping((t) => !t)}
        >
          <KeyboardIcon />
        </button>
        <span className="bv-status">
          <StatusDot tone={meta.tone} pulse={conn === 'connecting'} />
          <span>{meta.label}</span>
        </span>
      </div>

      {typing && (
        <form className="bv-type" onSubmit={sendTyped}>
          <TextInput
            value={typeText}
            onValueChange={setTypeText}
            placeholder="Text to type into the page"
            aria-label="Text to type into the page"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
            disabled={!open}
          />
          <Button type="submit" size="sm" variant="primary" disabled={!open || !typeText}>
            Type
          </Button>
          <Button size="sm" variant="ghost" onClick={() => pressKey('Backspace')} disabled={!open} aria-label="Backspace">
            ⌫
          </Button>
          <Button size="sm" variant="ghost" onClick={() => pressKey('Tab')} disabled={!open}>
            Tab
          </Button>
          <Button size="sm" variant="ghost" onClick={() => pressKey('Enter')} disabled={!open}>
            Enter
          </Button>
        </form>
      )}

      <div className="bv-title truncate" title={page.title || undefined}>
        {page.title || page.url || ' '}
      </div>

      <div
        ref={screenRef}
        className={cx('bv-screen', !hasFrame && 'is-empty')}
        tabIndex={0}
        role="application"
        aria-roledescription="remote browser"
        aria-label={label}
        onKeyDown={onKey('down')}
        onKeyUp={onKey('up')}
        onBlur={releaseHeldKeys}
        onPaste={onPaste}
      >
        <canvas ref={canvasRef} className="bv-canvas" />
        {conn !== 'closed' && !hasFrame && (
          <div className="bv-overlay">
            <Spinner label={null} />
            <span>{conn === 'connecting' ? 'Starting the browser…' : 'Loading the page…'}</span>
          </div>
        )}
        {conn === 'closed' && (
          <div className="bv-overlay is-closed" role="alert">
            <span>{closedText ?? 'Disconnected.'}</span>
            <Button variant="primary" size="sm" onClick={() => setAttempt((a) => a + 1)}>
              Reconnect
            </Button>
          </div>
        )}
      </div>

      {notice && (
        <div className="alert alert-warn bv-notice" role="alert">
          <span>{notice}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setNotice(null)}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}

      <p className="bv-hint">
        Click the page to control it; click outside it (or press Esc twice) to use the rest of this window. Paste with Ctrl+V (⌘V on a Mac). On a
        phone: tap to click, drag to scroll and use the keyboard button to type.
      </p>
    </div>
  );
}

const BackIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
);

const KeyboardIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M8 14.5h8" />
  </svg>
);
