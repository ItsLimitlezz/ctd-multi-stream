// ULID (https://github.com/ulid/spec): 48-bit millisecond time + 80-bit randomness, Crockford
// base32, 26 characters, lexicographically sortable. The generator is monotonic: within one
// millisecond (or if the clock goes backwards) the random part is incremented, so ids are always
// strictly increasing — they double as event-stream cursors.

import crypto from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const TIME_MAX = 2 ** 48 - 1;
const RANDOM_MAX = (1n << 80n) - 1n;

/** Canonical (uppercase) ULID. The first character is at most 7 (48-bit time). */
export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function encodeTime(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > TIME_MAX) throw new RangeError('ULID time out of range');
  let out = '';
  let t = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ALPHABET.charAt(t % 32) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(value: bigint): string {
  let out = '';
  let v = value;
  for (let i = 0; i < RANDOM_LEN; i++) {
    out = ALPHABET.charAt(Number(v & 31n)) + out;
    v >>= 5n;
  }
  return out;
}

function randomBits(bytes: (n: number) => Uint8Array): bigint {
  const b = bytes(10);
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v & RANDOM_MAX;
}

/** The ms timestamp encoded in a ULID. */
export function decodeTime(id: string): number {
  let t = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const v = ALPHABET.indexOf(id.charAt(i).toUpperCase());
    if (v < 0) throw new Error('Invalid ULID');
    t = t * 32 + v;
  }
  return t;
}

/** Canonical form of a client-supplied ULID (case-insensitive per the spec), or null. */
export function parseUlid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim().toUpperCase();
  return ULID_RE.test(id) ? id : null;
}

/** Smallest ULID of the given millisecond (randomness all zero). Every id generated at or after `ms` is >= it. */
export function ulidFloor(ms: number): string {
  return encodeTime(ms) + '0'.repeat(RANDOM_LEN);
}

export type UlidGenerator = () => string;

export function createUlidGenerator(
  now: () => number = Date.now,
  bytes: (n: number) => Uint8Array = (n) => crypto.randomBytes(n),
): UlidGenerator {
  let lastTime = -1;
  let lastRandom = 0n;
  return () => {
    let t = Math.floor(now());
    if (t <= lastTime) {
      t = lastTime;
      if (lastRandom === RANDOM_MAX) {
        // 2^80 ids in one millisecond: move to the next millisecond instead of wrapping.
        t = lastTime + 1;
        lastRandom = randomBits(bytes);
      } else {
        lastRandom += 1n;
      }
    } else {
      lastRandom = randomBits(bytes);
    }
    lastTime = t;
    return encodeTime(t) + encodeRandom(lastRandom);
  };
}
