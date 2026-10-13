// Keyboard helpers for relaying browser key events through CDP Input.dispatchKeyEvent.
// Virtual key codes: https://learn.microsoft.com/windows/win32/inputdev/virtual-key-codes
// CDP: https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchKeyEvent

/** CDP modifier bits (same as BrowserClientMessage.modifiers). */
export const MOD_ALT = 1;
export const MOD_CTRL = 2;
export const MOD_META = 4;
export const MOD_SHIFT = 8;

const BY_KEY: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  PrintScreen: 44,
  Insert: 45,
  Delete: 46,
  Meta: 91,
  ContextMenu: 93,
  NumLock: 144,
  ScrollLock: 145,
};

const BY_CODE: Record<string, number> = {
  Space: 32,
  NumpadMultiply: 106,
  NumpadAdd: 107,
  NumpadSubtract: 109,
  NumpadDecimal: 110,
  NumpadDivide: 111,
  NumpadEnter: 13,
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
  IntlBackslash: 226,
};

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/** Windows virtual key code for a key event (needed for shortcuts like Ctrl+A and for named keys). */
export function virtualKeyCode(key: string, code: string): number | undefined {
  if (Object.hasOwn(BY_KEY, key)) return BY_KEY[key];
  let m = /^Key([A-Z])$/.exec(code);
  if (m?.[1]) return m[1].charCodeAt(0);
  m = /^Digit([0-9])$/.exec(code);
  if (m?.[1]) return 48 + Number(m[1]);
  m = /^Numpad([0-9])$/.exec(code);
  if (m?.[1]) return 96 + Number(m[1]);
  m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(key);
  if (m?.[1]) return 111 + Number(m[1]);
  if (Object.hasOwn(BY_CODE, code)) return BY_CODE[code];
  // No usable `code` (e.g. virtual keyboards): derive from a single letter/digit key.
  if ([...key].length === 1) {
    const c = key.toUpperCase();
    if (/^[A-Z0-9]$/.test(c)) return c.charCodeAt(0);
  }
  return undefined;
}

/** One printable character (not a control character), e.g. the '@' of Option+2 on a Spanish Mac. */
function isPrintableChar(s: string | undefined): s is string {
  return s !== undefined && [...s].length === 1 && !/^\p{Cc}$/u.test(s);
}

/**
 * Text a key press should insert, or undefined for none.
 * Ctrl/Meta/Alt shortcuts insert nothing, except AltGr (Ctrl+Alt with text, Windows layouts) and,
 * when `opts.optionComposes` (the viewer runs on macOS), Option (Alt alone) producing one
 * printable character: that is how Mac layouts type '@', '€', '[', '|', '~'...
 * Known gap: Option dead keys (Option+e, then e = 'é') arrive as key 'Dead' and are not composed.
 */
export function keyText(
  key: string,
  text: string | undefined,
  modifiers: number,
  opts: { optionComposes?: boolean } = {},
): string | undefined {
  const ctrl = (modifiers & MOD_CTRL) !== 0;
  const alt = (modifiers & MOD_ALT) !== 0;
  const meta = (modifiers & MOD_META) !== 0;
  const altGr = ctrl && alt && !meta;
  if (alt && !ctrl && !meta && opts.optionComposes) {
    const composed = text || key;
    return isPrintableChar(composed) ? composed : undefined;
  }
  if ((meta || ctrl || alt) && !altGr) return undefined;
  if (key === 'Enter') return '\r';
  if (text) return text;
  if ([...key].length === 1) return key;
  return undefined;
}

/**
 * CDP modifiers for a key event that inserts `text`: Ctrl/Alt are dropped so the character is
 * typed as plain text (Blink on Linux refuses to insert text while ctrlKey is set, which would
 * swallow AltGr characters). Other events keep their modifiers.
 */
export function textModifiers(modifiers: number, text: string | undefined): number {
  return text && text !== '\r' ? modifiers & ~(MOD_CTRL | MOD_ALT) : modifiers;
}

/** Whether a viewer's User-Agent is macOS (where Option composes characters). */
export function isMacUserAgent(userAgent: string | undefined): boolean {
  return typeof userAgent === 'string' && /Macintosh|Mac OS X/i.test(userAgent) && !/iPhone|iPod/i.test(userAgent);
}

/** DOM KeyboardEvent.location: 0 standard, 1 left, 2 right, 3 numpad. */
export function keyLocation(key: string, code: string): number {
  if (code.startsWith('Numpad')) return 3;
  if (MODIFIER_KEYS.has(key)) {
    if (code.endsWith('Left')) return 1;
    if (code.endsWith('Right')) return 2;
  }
  return 0;
}
