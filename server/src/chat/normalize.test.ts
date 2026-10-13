import { describe, expect, it } from 'vitest';
import type { ChatMessageInput } from '../platforms/types.js';
import { RecentKeys, RingBuffer } from './buffers.js';
import { MAX_AUTHOR_LENGTH, MAX_TEXT_LENGTH, cleanText, normalizeChatMessage, truncate } from './normalize.js';
import { safeErrorMessage } from './redact.js';
import { generateOverlayToken, tokensEqual } from './token.js';

const NOW = new Date('2026-10-11T12:00:00.000Z');

function input(over: Partial<ChatMessageInput> = {}): ChatMessageInput {
  return { author: { name: 'alice' }, text: 'hello', ts: '2026-10-11T11:59:00.000Z', ...over };
}

describe('normalizeChatMessage', () => {
  it('prefixes the platform id and fills platform/destination/kind', () => {
    const m = normalizeChatMessage(input({ id: 'abc' }), 'twitch', 'dest-1', NOW);
    expect(m).toEqual({
      id: 'twitch:abc',
      platform: 'twitch',
      destinationId: 'dest-1',
      author: { name: 'alice' },
      text: 'hello',
      ts: '2026-10-11T11:59:00.000Z',
      kind: 'message',
    });
  });

  it('keeps kind=event', () => {
    expect(normalizeChatMessage(input({ kind: 'event' }), 'kick', 'd', NOW)?.kind).toBe('event');
  });

  it('hashes platform+author+text+ts into a stable id when the platform gives none', () => {
    const a = normalizeChatMessage(input(), 'youtube', 'd1', NOW);
    const b = normalizeChatMessage(input(), 'youtube', 'd2', NOW);
    const c = normalizeChatMessage(input({ text: 'other' }), 'youtube', 'd1', NOW);
    const d = normalizeChatMessage(input(), 'kick', 'd1', NOW);
    expect(a?.id).toMatch(/^youtube:[\w-]{24}$/);
    expect(a?.id).toBe(b?.id);
    expect(c?.id).not.toBe(a?.id);
    expect(d?.id).not.toBe(a?.id?.replace('youtube', 'kick'));
  });

  it('defaults ts to now for missing or invalid timestamps and normalizes valid ones to ISO', () => {
    expect(normalizeChatMessage(input({ ts: '' }), 'x', 'd', NOW)?.ts).toBe(NOW.toISOString());
    expect(normalizeChatMessage(input({ ts: 'not a date' }), 'x', 'd', NOW)?.ts).toBe(NOW.toISOString());
    expect(normalizeChatMessage(input({ ts: '2026-10-11T13:00:00+01:00' }), 'x', 'd', NOW)?.ts).toBe(
      '2026-10-11T12:00:00.000Z',
    );
  });

  it('strips control and bidi characters; line breaks become spaces', () => {
    const m = normalizeChatMessage(
      input({ text: 'a\u0000b\nc\r\n\td\u{202E}e\u0007', author: { name: '\u{2066}bob\u0000\n' } }),
      'twitch',
      'd',
      NOW,
    );
    expect(m?.text).toBe('ab c de');
    expect(m?.author.name).toBe('bob');
  });

  it('trims text to 500 and author to 64 characters without splitting surrogate pairs', () => {
    const m = normalizeChatMessage(input({ text: 'x'.repeat(600), author: { name: 'n'.repeat(100) } }), 'kick', 'd', NOW);
    expect(m?.text).toHaveLength(MAX_TEXT_LENGTH);
    expect(m?.author.name).toHaveLength(MAX_AUTHOR_LENGTH);

    const emoji = 'a'.repeat(MAX_TEXT_LENGTH - 1) + '\u{1F600}';
    const e = normalizeChatMessage(input({ text: emoji }), 'kick', 'd', NOW);
    expect(e?.text).toBe('a'.repeat(MAX_TEXT_LENGTH - 1));
  });

  it('keeps at most 10 unique badges, valid hex colors and http(s) avatars only', () => {
    const badges = Array.from({ length: 15 }, (_, i) => `b${i}`);
    const m = normalizeChatMessage(
      input({ author: { name: 'a', badges: ['b0', ...badges, ''], color: '#FF00aa', avatarUrl: 'https://cdn.example/a.png' } }),
      'twitch',
      'd',
      NOW,
    );
    expect(m?.author.badges).toEqual(badges.slice(0, 10));
    expect(m?.author.color).toBe('#FF00aa');
    expect(m?.author.avatarUrl).toBe('https://cdn.example/a.png');

    const bad = normalizeChatMessage(
      input({ author: { name: 'a', badges: [], color: 'red;background:url(x)', avatarUrl: 'javascript:alert(1)' } }),
      'twitch',
      'd',
      NOW,
    );
    expect(bad?.author).toEqual({ name: 'a' });
  });

  it('drops messages without visible text and survives malformed input', () => {
    expect(normalizeChatMessage(input({ text: ' \n\u0000 ' }), 'x', 'd', NOW)).toBeNull();
    expect(normalizeChatMessage(null as unknown as ChatMessageInput, 'x', 'd', NOW)).toBeNull();
    const noAuthor = normalizeChatMessage({ text: 'hi' } as unknown as ChatMessageInput, 'x', 'd', NOW);
    expect(noAuthor?.author.name).toBe('unknown');
  });
});

describe('text helpers', () => {
  it('truncate and cleanText', () => {
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdef', 3)).toBe('abc');
    expect(cleanText(42, 10)).toBe('');
    expect(cleanText('  a    b  ', 10)).toBe('a b');
  });

  it('safeErrorMessage hides URLs paths/queries and token-like values', () => {
    const msg = safeErrorMessage(
      new Error('GET https://api.example.com/v1/chat?access_token=SECRET1 failed; key=SECRET2 Bearer SECRET3'),
    );
    expect(msg).toContain('https://api.example.com');
    expect(msg).not.toMatch(/SECRET/);
    expect(safeErrorMessage('Twitch token expired')).toBe('Twitch token expired');
    expect(safeErrorMessage(undefined)).toBe('unknown error');
  });
});

describe('tokens', () => {
  it('generates 43-char base64url tokens and compares them', () => {
    const t = generateOverlayToken();
    expect(t).toMatch(/^[\w-]{43}$/);
    expect(generateOverlayToken()).not.toBe(t);
    expect(tokensEqual(t, t)).toBe(true);
    expect(tokensEqual(t, t.slice(0, -1))).toBe(false);
    expect(tokensEqual(t, '')).toBe(false);
  });
});

describe('buffers', () => {
  it('RingBuffer keeps the newest items, oldest first', () => {
    const rb = new RingBuffer<number>(3);
    expect(rb.last(10)).toEqual([]);
    for (let i = 1; i <= 5; i++) rb.push(i);
    expect(rb.size).toBe(3);
    expect(rb.last(10)).toEqual([3, 4, 5]);
    expect(rb.last(2)).toEqual([4, 5]);
    expect(rb.last(0)).toEqual([]);
    expect(() => new RingBuffer(0)).toThrow(RangeError);
  });

  it('RecentKeys forgets the oldest key past capacity', () => {
    const keys = new RecentKeys(2);
    expect(keys.add('a')).toBe(true);
    expect(keys.add('a')).toBe(false);
    keys.add('b');
    keys.add('c');
    expect(keys.size).toBe(2);
    expect(keys.has('a')).toBe(false);
    expect(keys.add('a')).toBe(true);
  });
});
