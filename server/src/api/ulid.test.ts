import { describe, expect, it } from 'vitest';
import { ULID_RE, createUlidGenerator, decodeTime, encodeTime, parseUlid, ulidFloor } from './ulid.js';

describe('ulid', () => {
  it('encodes 48-bit ms time + 80-bit randomness as 26 Crockford base32 characters', () => {
    const ms = Date.parse('2026-10-13T12:00:00.000Z');
    const id = createUlidGenerator(() => ms)();
    expect(id).toMatch(ULID_RE);
    expect(id).toHaveLength(26);
    expect(decodeTime(id)).toBe(ms);
    expect(encodeTime(0)).toBe('0000000000');
    expect(encodeTime(2 ** 48 - 1)).toBe('7ZZZZZZZZZ');
    expect(() => encodeTime(2 ** 48)).toThrow(RangeError);
    expect(() => encodeTime(-1)).toThrow(RangeError);
  });

  it('is strictly increasing within one millisecond (random part + 1)', () => {
    const gen = createUlidGenerator(() => 1_000, () => new Uint8Array(10).fill(0x11));
    const a = gen();
    const b = gen();
    const c = gen();
    expect(a < b && b < c).toBe(true);
    expect(decodeTime(c)).toBe(1_000);
    expect(b.slice(0, 10)).toBe(a.slice(0, 10));
    expect(a.slice(-1)).not.toBe(b.slice(-1));
  });

  it('stays monotonic when the clock goes backwards, and sorts by time', () => {
    let now = 5_000;
    const gen = createUlidGenerator(() => now);
    const ids: string[] = [];
    ids.push(gen());
    now = 4_000; // NTP step back
    ids.push(gen());
    now = 6_000;
    ids.push(gen());
    ids.push(gen());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(decodeTime(ids[1]!)).toBe(5_000);
    expect(decodeTime(ids[2]!)).toBe(6_000);
  });

  it('moves to the next millisecond instead of wrapping the random part', () => {
    const gen = createUlidGenerator(() => 7, () => new Uint8Array(10).fill(0xff));
    const max = gen();
    expect(max.slice(10)).toBe('Z'.repeat(16));
    const next = gen();
    expect(next > max).toBe(true);
    expect(decodeTime(next)).toBe(8);
  });

  it('many ids in a burst are unique and ordered', () => {
    const gen = createUlidGenerator();
    const ids = Array.from({ length: 5000 }, () => gen());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(5000);
  });

  it('parses client cursors case-insensitively and rejects junk', () => {
    const id = createUlidGenerator()();
    expect(parseUlid(id.toLowerCase())).toBe(id);
    expect(parseUlid(` ${id} `)).toBe(id);
    for (const bad of ['', 'x', `${id}0`, id.slice(1), '8ZZZZZZZZZZZZZZZZZZZZZZZZZ', 'IIIIIIIIIIIIIIIIIIIIIIIIII', 42, null, undefined, [id]]) {
      expect(parseUlid(bad)).toBeNull();
    }
  });

  it('floor is <= every id of the same or a later millisecond', () => {
    const ms = 1_791_830_000_123;
    const floor = ulidFloor(ms);
    expect(floor).toMatch(ULID_RE);
    expect(createUlidGenerator(() => ms)() > floor).toBe(true);
    expect(createUlidGenerator(() => ms - 1)() < floor).toBe(true);
  });
});
