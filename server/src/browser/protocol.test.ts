import { describe, expect, it } from 'vitest';
import { isMacUserAgent, keyLocation, keyText, MOD_ALT, MOD_CTRL, MOD_META, MOD_SHIFT, textModifiers, virtualKeyCode } from './keys.js';
import { decodeBrowserClientMessage, parseBrowserClientMessage } from './protocol.js';
import { clamp, navErrorMessage, parseHttpUrl, redactUrl, safeErrorMessage } from './util.js';

describe('browser client message validation', () => {
  it('accepts valid messages', () => {
    expect(parseBrowserClientMessage({ type: 'mouse', action: 'down', x: 10, y: 20, button: 'left', clickCount: 1 })).toEqual({
      type: 'mouse',
      action: 'down',
      x: 10,
      y: 20,
      button: 'left',
      clickCount: 1,
    });
    expect(parseBrowserClientMessage({ type: 'key', action: 'down', key: 'a', code: 'KeyA', text: 'a', modifiers: 0 })).not.toBeNull();
    expect(parseBrowserClientMessage({ type: 'type', text: 'hello' })).not.toBeNull();
    expect(parseBrowserClientMessage({ type: 'navigate', url: 'https://example.com' })).not.toBeNull();
    expect(parseBrowserClientMessage({ type: 'back' })).not.toBeNull();
    expect(parseBrowserClientMessage({ type: 'reload' })).not.toBeNull();
    expect(parseBrowserClientMessage({ type: 'resize', width: 800, height: 600 })).not.toBeNull();
  });

  it('rejects invalid messages', () => {
    expect(parseBrowserClientMessage(null)).toBeNull();
    expect(parseBrowserClientMessage({ type: 'eval', code: 'x' })).toBeNull();
    expect(parseBrowserClientMessage({ type: 'mouse', action: 'down', x: 'a', y: 1 })).toBeNull();
    expect(parseBrowserClientMessage({ type: 'mouse', action: 'down', x: Infinity, y: 1 })).toBeNull();
    expect(parseBrowserClientMessage({ type: 'key', action: 'down', key: '', code: '', modifiers: 0 })).toBeNull();
    expect(parseBrowserClientMessage({ type: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers: 99 })).toBeNull();
    expect(parseBrowserClientMessage({ type: 'type', text: 'x'.repeat(20_001) })).toBeNull();
    expect(decodeBrowserClientMessage('not json')).toBeNull();
    expect(decodeBrowserClientMessage(Buffer.from('{"type":"back"}'))).toEqual({ type: 'back' });
    expect(decodeBrowserClientMessage([Buffer.from('{"type":'), Buffer.from('"reload"}')])).toEqual({ type: 'reload' });
  });
});

describe('key mapping', () => {
  it('maps virtual key codes', () => {
    expect(virtualKeyCode('Enter', 'Enter')).toBe(13);
    expect(virtualKeyCode('Backspace', 'Backspace')).toBe(8);
    expect(virtualKeyCode('ArrowLeft', 'ArrowLeft')).toBe(37);
    expect(virtualKeyCode('a', 'KeyA')).toBe(65);
    expect(virtualKeyCode('A', 'KeyA')).toBe(65);
    expect(virtualKeyCode('5', 'Digit5')).toBe(53);
    expect(virtualKeyCode('F5', 'F5')).toBe(116);
    expect(virtualKeyCode(',', 'Comma')).toBe(188);
    expect(virtualKeyCode('z', '')).toBe(90);
    expect(virtualKeyCode('constructor', '')).toBeUndefined();
  });

  it('computes inserted text', () => {
    expect(keyText('a', 'a', 0)).toBe('a');
    expect(keyText('A', undefined, MOD_SHIFT)).toBe('A');
    expect(keyText('Enter', undefined, 0)).toBe('\r');
    expect(keyText('a', 'a', MOD_CTRL)).toBeUndefined();
    expect(keyText('a', 'a', MOD_META)).toBeUndefined();
    expect(keyText('@', '@', MOD_CTRL | MOD_ALT)).toBe('@'); // AltGr
    expect(keyText('Backspace', undefined, 0)).toBeUndefined();
    expect(keyText('a', undefined, MOD_ALT)).toBeUndefined();
  });

  it('lets macOS Option compose characters, only for Mac viewers', () => {
    const mac = { optionComposes: true };
    expect(keyText('@', '@', MOD_ALT, mac)).toBe('@'); // Option+2 on a Spanish Mac
    expect(keyText('€', undefined, MOD_ALT | MOD_SHIFT, mac)).toBe('€');
    expect(keyText('Enter', undefined, MOD_ALT, mac)).toBeUndefined();
    expect(keyText('Dead', undefined, MOD_ALT, mac)).toBeUndefined(); // dead keys: known gap
    expect(keyText('a', 'a', MOD_ALT | MOD_META, mac)).toBeUndefined(); // Cmd+Option shortcut
    // Windows/Linux: Alt+key stays a shortcut (Alt+Shift+2 reports '@' but must not type it).
    expect(keyText('@', '@', MOD_ALT | MOD_SHIFT)).toBeUndefined();
    expect(keyText('a', undefined, MOD_ALT, { optionComposes: false })).toBeUndefined();
  });

  it('drops Ctrl/Alt from events that insert text', () => {
    expect(textModifiers(MOD_ALT | MOD_SHIFT, '@')).toBe(MOD_SHIFT);
    expect(textModifiers(MOD_CTRL | MOD_ALT, '@')).toBe(0); // AltGr: Blink on Linux ignores text with ctrlKey
    expect(textModifiers(MOD_CTRL, undefined)).toBe(MOD_CTRL); // shortcuts keep their modifiers
    expect(textModifiers(MOD_ALT, '\r')).toBe(MOD_ALT);
  });

  it('detects macOS viewers from the User-Agent', () => {
    expect(isMacUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')).toBe(true);
    expect(isMacUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')).toBe(false);
    expect(isMacUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(false);
    expect(isMacUserAgent(undefined)).toBe(false);
  });

  it('computes key location', () => {
    expect(keyLocation('Shift', 'ShiftLeft')).toBe(1);
    expect(keyLocation('Control', 'ControlRight')).toBe(2);
    expect(keyLocation('1', 'Numpad1')).toBe(3);
    expect(keyLocation('a', 'KeyA')).toBe(0);
  });
});

describe('url utilities', () => {
  it('accepts only http(s)', () => {
    expect(parseHttpUrl('https://www.instagram.com/accounts/login')?.hostname).toBe('www.instagram.com');
    expect(parseHttpUrl('http://127.0.0.1:8080/x')?.port).toBe('8080');
    expect(parseHttpUrl('javascript:alert(1)')).toBeNull();
    expect(parseHttpUrl('file:///etc/passwd')).toBeNull();
    expect(parseHttpUrl('chrome://settings')).toBeNull();
    expect(parseHttpUrl('data:text/html,hi')).toBeNull();
    expect(parseHttpUrl('instagram.com')).toBeNull();
    expect(parseHttpUrl('instagram.com/live', { allowBareHost: true })?.href).toBe('https://instagram.com/live');
    expect(parseHttpUrl('javascript:alert(1)', { allowBareHost: true })).toBeNull();
    expect(parseHttpUrl('   ')).toBeNull();
  });

  it('redacts urls and error messages', () => {
    expect(redactUrl('rtmps://live.example.com:443/app/SECRETKEY?x=1')).toBe('rtmps://live.example.com:443');
    expect(redactUrl('nope')).toBe('[invalid url]');
    const msg = safeErrorMessage(new Error('page.goto: failed for https://example.com/path?token=abc\nCall log: ...'));
    expect(msg).toBe('page.goto: failed for https://example.com');
    expect(navErrorMessage(new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.invalid/'))).toBe(
      'Could not load the page (net::ERR_NAME_NOT_RESOLVED)',
    );
    expect(navErrorMessage(new Error('page.goto: Timeout 100ms exceeded.'))).toBe('The page took too long to load');
  });

  it('clamps', () => {
    expect(clamp(10, 320, 1920)).toBe(320);
    expect(clamp(5000, 320, 1920)).toBe(1920);
    expect(clamp(800.6, 320, 1920)).toBe(801);
  });
});
