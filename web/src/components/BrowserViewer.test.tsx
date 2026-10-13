import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BrowserViewer,
  cdpModifiers,
  clampViewport,
  clickCount,
  closeMessage,
  isPasteShortcut,
  isReleaseEscape,
  keyMessage,
  mouseButton,
  normalizeAddress,
  parseBrowserMessage,
  RELEASE_ESCAPE_MS,
  toFrameCoords,
  viewportFor,
  wheelPixels,
} from './BrowserViewer';

const noMods = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

describe('BrowserViewer helpers', () => {
  it('encodes modifiers as the CDP bitmask', () => {
    expect(cdpModifiers(noMods)).toBe(0);
    expect(cdpModifiers({ ...noMods, altKey: true })).toBe(1);
    expect(cdpModifiers({ ...noMods, ctrlKey: true })).toBe(2);
    expect(cdpModifiers({ ...noMods, metaKey: true })).toBe(4);
    expect(cdpModifiers({ ...noMods, shiftKey: true })).toBe(8);
    expect(cdpModifiers({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
  });

  it('maps mouse buttons and click counts', () => {
    expect([0, 1, 2, 3].map(mouseButton)).toEqual(['left', 'middle', 'right', null]);
    expect(clickCount(0)).toBe(1);
    expect(clickCount(2)).toBe(2);
    expect(clickCount(9)).toBe(4);
  });

  it('converts client coordinates to frame coordinates', () => {
    const rect = { left: 100, top: 50, width: 640, height: 400 };
    const frame = { width: 1280, height: 800 };
    expect(toFrameCoords(100, 50, rect, frame)).toEqual({ x: 0, y: 0 });
    expect(toFrameCoords(420, 250, rect, frame)).toEqual({ x: 640, y: 400 });
    // Outside the canvas: clamped to the frame.
    expect(toFrameCoords(2000, -20, rect, frame)).toEqual({ x: 1279, y: 0 });
    // Degenerate rect doesn't divide by zero.
    expect(toFrameCoords(5, 5, { left: 0, top: 0, width: 0, height: 0 }, frame)).toEqual({ x: 5, y: 5 });
  });

  it('clamps the remote viewport to 320–1920 × 320–1200', () => {
    expect(clampViewport(100, 100)).toEqual({ width: 320, height: 320 });
    expect(clampViewport(5000, 5000)).toEqual({ width: 1920, height: 1200 });
    expect(clampViewport(800.4, 600.6)).toEqual({ width: 800, height: 601 });
    expect(viewportFor(337, 812)).toEqual({ width: 337, height: 487 });
    expect(viewportFor(1100, 1000)).toEqual({ width: 1100, height: 600 });
  });

  it('converts wheel deltas to pixels', () => {
    expect(wheelPixels({ deltaX: 0, deltaY: 120, deltaMode: 0 }, 800)).toEqual({ deltaX: 0, deltaY: 120 });
    expect(wheelPixels({ deltaX: 1, deltaY: 3, deltaMode: 1 }, 800)).toEqual({ deltaX: 40, deltaY: 120 });
    expect(wheelPixels({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 800)).toEqual({ deltaX: 0, deltaY: 800 });
  });

  it('builds key messages with text only for printable keys', () => {
    expect(keyMessage('down', { ...noMods, key: 'a', code: 'KeyA' })).toEqual({ type: 'key', action: 'down', key: 'a', code: 'KeyA', text: 'a', modifiers: 0 });
    expect(keyMessage('up', { ...noMods, shiftKey: true, key: 'Enter', code: 'Enter' })).toEqual({
      type: 'key',
      action: 'up',
      key: 'Enter',
      code: 'Enter',
      modifiers: 8,
    });
    expect(keyMessage('down', { ...noMods, key: '😀', code: '' })?.text).toBe('😀');
    expect(keyMessage('down', { ...noMods, key: '', code: '' })).toBeNull();
    expect(keyMessage('down', { ...noMods, key: 'x'.repeat(41), code: '' })).toBeNull();
  });

  it('leaves paste shortcuts to the paste event', () => {
    expect(isPasteShortcut({ ...noMods, ctrlKey: true, key: 'v', code: 'KeyV' })).toBe(true);
    expect(isPasteShortcut({ ...noMods, metaKey: true, key: 'V', code: 'KeyV' })).toBe(true);
    expect(isPasteShortcut({ ...noMods, shiftKey: true, key: 'Insert', code: 'Insert' })).toBe(true);
    expect(isPasteShortcut({ ...noMods, key: 'v', code: 'KeyV' })).toBe(false);
    // AltGr (Ctrl+Alt) + V types a character on some layouts.
    expect(isPasteShortcut({ ...noMods, ctrlKey: true, altKey: true, key: 'v', code: 'KeyV' })).toBe(false);
  });

  it('a second (or held) Escape gives the keyboard back to the window', () => {
    const esc = { ...noMods, key: 'Escape', code: 'Escape' };
    expect(isReleaseEscape(esc, null, 1000)).toBe(false); // the first one goes to the page
    expect(isReleaseEscape(esc, 1000, 1400)).toBe(true);
    expect(isReleaseEscape(esc, 1000, 1000 + RELEASE_ESCAPE_MS + 1)).toBe(false);
    expect(isReleaseEscape({ ...esc, shiftKey: true }, 1000, 1400)).toBe(false);
    expect(isReleaseEscape({ ...noMods, key: 'a', code: 'KeyA' }, 1000, 1400)).toBe(false);
  });

  it('only navigates to http(s) addresses', () => {
    expect(normalizeAddress('accounts.google.com')).toBe('https://accounts.google.com/');
    expect(normalizeAddress(' http://example.com/login ')).toBe('http://example.com/login');
    expect(normalizeAddress('localhost:3000')).toBe('https://localhost:3000/');
    expect(normalizeAddress('javascript:alert(1)')).toBeNull();
    expect(normalizeAddress('file:///etc/passwd')).toBeNull();
    expect(normalizeAddress('ftp://example.com')).toBeNull();
    expect(normalizeAddress('two words')).toBeNull();
    expect(normalizeAddress('')).toBeNull();
  });

  it('parses server messages defensively', () => {
    expect(parseBrowserMessage(JSON.stringify({ type: 'frame', data: 'QUJD', width: 1280, height: 800 }))).toEqual({
      type: 'frame',
      data: 'QUJD',
      width: 1280,
      height: 800,
    });
    expect(parseBrowserMessage(JSON.stringify({ type: 'frame', data: 'x"y', width: 1, height: 1 }))).toBeNull();
    expect(parseBrowserMessage(JSON.stringify({ type: 'frame', data: 'QUJD', width: 0, height: 1 }))).toBeNull();
    expect(parseBrowserMessage(JSON.stringify({ type: 'url', url: 'https://x.com' }))).toEqual({ type: 'url', url: 'https://x.com', title: '' });
    expect(parseBrowserMessage(JSON.stringify({ type: 'closed' }))).toEqual({ type: 'closed' });
    expect(parseBrowserMessage(JSON.stringify({ type: 'error' }))).toEqual({ type: 'error', message: expect.any(String) });
    expect(parseBrowserMessage('{nope')).toBeNull();
    expect(parseBrowserMessage(JSON.stringify({ type: 'other' }))).toBeNull();
    expect(parseBrowserMessage(42)).toBeNull();
  });

  it('explains socket close codes', () => {
    expect(closeMessage(4000, 'Opened in another window')).toMatch(/another window/);
    expect(closeMessage(1000, 'Browser closed')).toMatch(/closed/);
    expect(closeMessage(1011, '')).toMatch(/could not be started/);
    expect(closeMessage(1006, '')).toMatch(/lost/);
  });
});

describe('BrowserViewer (static render)', () => {
  it('renders the toolbar and a focusable page area before connecting', () => {
    const out = renderToStaticMarkup(<BrowserViewer accountId="acc-1" label="Instagram login page" />);
    expect(out).toContain('aria-label="Back"');
    expect(out).toContain('aria-label="Reload"');
    expect(out).toContain('aria-label="Address"');
    expect(out).toContain('tabindex="0"');
    expect(out).toContain('role="application"');
    expect(out).toContain('aria-label="Instagram login page"');
    expect(out).toContain('<canvas');
    expect(out).toContain('Starting the browser');
    expect(out).toContain('Connecting');
  });
});
