// Password hashing (Argon2id via node:crypto, scrypt fallback) and credential policy.
// Argon2 API: https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoargon2algorithm-parameters-callback

import crypto from 'node:crypto';
import { z } from 'zod';

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;
export const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

export const usernameSchema = z
  .string()
  .regex(USERNAME_RE, 'Username must be 3-32 characters: letters, digits, "_", "." or "-"');
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters`)
  .max(PASSWORD_MAX, `Password must be at most ${PASSWORD_MAX} characters`);

// OWASP-style Argon2id parameters: 64 MiB, 3 passes, 1 lane, 16-byte salt, 32-byte tag.
const ARGON2 = { memory: 65536, passes: 3, parallelism: 1, tagLength: 32, saltLength: 16 } as const;
// Fallback: scrypt N=2^16, r=8, p=1 (64 MiB).
const SCRYPT = { N: 65536, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;

// Upper bounds when parsing stored hashes, so a corrupted row can't request absurd work.
const MAX_MEMORY_KIB = 1024 * 1024;
const MAX_PASSES = 64;
const MAX_PARALLELISM = 16;

const hasArgon2 = typeof (crypto as { argon2?: unknown }).argon2 === 'function';

// Each KDF run holds ~64 MiB: cap concurrent runs so a login flood can't exhaust memory.
const MAX_CONCURRENT_KDF = 4;
let running = 0;
const waiting: (() => void)[] = [];

async function withKdfSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running < MAX_CONCURRENT_KDF) running++;
  else await new Promise<void>((resolve) => waiting.push(resolve)); // slot is handed over on release
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

/** NIST SP 800-63B: normalize so the same password typed on different devices matches. */
function passwordBytes(pw: string): Buffer {
  return Buffer.from(pw.normalize('NFKC'), 'utf8');
}

interface Argon2Params {
  memory: number;
  passes: number;
  parallelism: number;
}

function argon2id(pw: string, salt: Buffer, p: Argon2Params, tagLength: number): Promise<Buffer> {
  return withKdfSlot(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        crypto.argon2(
          'argon2id',
          { message: passwordBytes(pw), nonce: salt, memory: p.memory, passes: p.passes, parallelism: p.parallelism, tagLength },
          (err, key) => (err ? reject(err) : resolve(key)),
        );
      }),
  );
}

interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

function scrypt(pw: string, salt: Buffer, p: ScryptParams, keyLength: number): Promise<Buffer> {
  const maxmem = 128 * p.N * p.r * p.p + 32 * 1024 * 1024;
  return withKdfSlot(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        crypto.scrypt(passwordBytes(pw), salt, keyLength, { N: p.N, r: p.r, p: p.p, maxmem }, (err, key) =>
          err ? reject(err) : resolve(key),
        );
      }),
  );
}

// PHC strings use unpadded standard base64.
function phcB64(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '');
}

function parseParams(s: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of s.split(',')) {
    const m = /^([a-zA-Z]+)=(\d{1,10})$/.exec(part);
    if (!m || !m[1] || !m[2]) throw new Error('bad params');
    out[m[1]] = Number(m[2]);
  }
  return out;
}

function intInRange(v: number | undefined, min: number, max: number): number {
  if (v === undefined || !Number.isInteger(v) || v < min || v > max) throw new Error('param out of range');
  return v;
}

type ParsedHash =
  | { kind: 'argon2id'; params: Argon2Params; salt: Buffer; hash: Buffer }
  | { kind: 'scrypt'; params: ScryptParams; salt: Buffer; hash: Buffer };

/** Parse `$argon2id$v=19$m=..,t=..,p=..$salt$hash` or `$scrypt$N=..,r=..,p=..$salt$hash`. Throws when malformed. */
function parseHash(encoded: string): ParsedHash {
  const parts = encoded.split('$');
  if (parts[0] !== '') throw new Error('bad hash');
  if (parts[1] === 'argon2id' && parts.length === 6 && parts[2] === 'v=19') {
    const p = parseParams(parts[3] ?? '');
    const parallelism = intInRange(p.p, 1, MAX_PARALLELISM);
    const params = {
      memory: intInRange(p.m, 8 * parallelism, MAX_MEMORY_KIB),
      passes: intInRange(p.t, 1, MAX_PASSES),
      parallelism,
    };
    return { kind: 'argon2id', params, salt: decodeB64(parts[4], 8), hash: decodeB64(parts[5], 16) };
  }
  if (parts[1] === 'scrypt' && parts.length === 5) {
    const p = parseParams(parts[2] ?? '');
    const N = intInRange(p.N, 2, 1 << 20);
    if ((N & (N - 1)) !== 0) throw new Error('N must be a power of two');
    const params = { N, r: intInRange(p.r, 1, 32), p: intInRange(p.p, 1, MAX_PARALLELISM) };
    return { kind: 'scrypt', params, salt: decodeB64(parts[3], 8), hash: decodeB64(parts[4], 16) };
  }
  throw new Error('unsupported hash');
}

function decodeB64(s: string | undefined, minBytes: number): Buffer {
  if (!s || !/^[A-Za-z0-9+/]+$/.test(s)) throw new Error('bad base64');
  const buf = Buffer.from(s, 'base64');
  if (buf.length < minBytes || buf.length > 1024) throw new Error('bad length');
  return buf;
}

export async function hashPassword(pw: string): Promise<string> {
  if (hasArgon2) {
    const salt = crypto.randomBytes(ARGON2.saltLength);
    const params = { memory: ARGON2.memory, passes: ARGON2.passes, parallelism: ARGON2.parallelism };
    const hash = await argon2id(pw, salt, params, ARGON2.tagLength);
    return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${phcB64(salt)}$${phcB64(hash)}`;
  }
  const salt = crypto.randomBytes(SCRYPT.saltLength);
  const hash = await scrypt(pw, salt, SCRYPT, SCRYPT.keyLength);
  return `$scrypt$N=${SCRYPT.N},r=${SCRYPT.r},p=${SCRYPT.p}$${phcB64(salt)}$${phcB64(hash)}`;
}

/** Constant-time verification. Returns false (never throws) for wrong passwords and malformed hashes. */
export async function verifyPassword(pw: string, encoded: string): Promise<boolean> {
  let parsed: ParsedHash;
  try {
    parsed = parseHash(encoded);
  } catch {
    return false;
  }
  let actual: Buffer;
  if (parsed.kind === 'argon2id') {
    if (!hasArgon2) return false;
    actual = await argon2id(pw, parsed.salt, parsed.params, parsed.hash.length);
  } else {
    actual = await scrypt(pw, parsed.salt, parsed.params, parsed.hash.length);
  }
  return actual.length === parsed.hash.length && crypto.timingSafeEqual(actual, parsed.hash);
}

/** True when a stored hash uses weaker/older parameters than we would use today. */
export function needsRehash(encoded: string): boolean {
  try {
    const p = parseHash(encoded);
    if (!hasArgon2) return p.kind !== 'scrypt' || p.params.N < SCRYPT.N;
    return (
      p.kind !== 'argon2id' ||
      p.params.memory < ARGON2.memory ||
      p.params.passes < ARGON2.passes ||
      p.hash.length < ARGON2.tagLength
    );
  } catch {
    return true;
  }
}

let dummyHash: Promise<string> | null = null;

function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

/** Compute the dummy hash ahead of time so even the first unknown-user login has normal timing. */
export function warmUpDummyHash(): void {
  getDummyHash().catch(() => {
    dummyHash = null;
  });
}

/**
 * Verify against a throwaway hash so a login for an unknown username costs the same
 * time as one for a real user. Always resolves to false.
 */
export async function verifyDummyPassword(pw: string): Promise<false> {
  try {
    await verifyPassword(pw, await getDummyHash());
  } catch {
    dummyHash = null;
  }
  return false;
}
