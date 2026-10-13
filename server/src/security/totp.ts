// TOTP (RFC 6238 / RFC 4226): SHA-1, 6 digits, 30 s step, ±1 step window, replay protection.

import crypto from 'node:crypto';
import QRCode from 'qrcode';

export const TOTP_ISSUER = 'CTD Multi-Stream';
const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1;
const SECRET_BYTES = 20;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding. */
export function base32Encode(buf: Buffer): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Decode base32 (case-insensitive; spaces, dashes and '=' padding ignored). Throws on invalid characters. */
export function base32Decode(input: string): Buffer {
  const s = input.toUpperCase().replace(/[\s=-]/g, '');
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of s) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character');
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(SECRET_BYTES));
}

/** RFC 4226 HOTP with SHA-1. */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', secret).update(msg).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const code = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totpStep(timeMs: number): number {
  return Math.floor(timeMs / 1000 / STEP_SECONDS);
}

export function totp(secret: Buffer, timeMs: number, digits = DIGITS): string {
  return hotp(secret, totpStep(timeMs), digits);
}

/** Returns the matching time step within ±1 step, or null. Comparison is constant-time per candidate. */
export function matchTotp(secretB32: string, code: string, timeMs = Date.now()): number | null {
  const normalized = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return null;
  let secret: Buffer;
  try {
    secret = base32Decode(secretB32);
  } catch {
    return null;
  }
  if (secret.length === 0) return null;
  const given = Buffer.from(normalized);
  const now = totpStep(timeMs);
  let matched: number | null = null;
  for (let step = now - WINDOW; step <= now + WINDOW; step++) {
    if (crypto.timingSafeEqual(Buffer.from(hotp(secret, step)), given)) matched ??= step;
  }
  return matched;
}

// Last accepted step per user (in memory): a code can't be used twice, nor an older one after a newer.
const lastUsedStep = new Map<string, number>();

/** Verify a code for a user and consume its time step (RFC 6238 §5.2 replay protection). */
export function verifyTotp(userId: string, secretB32: string, code: string, timeMs = Date.now()): boolean {
  const step = matchTotp(secretB32, code, timeMs);
  if (step === null) return false;
  const last = lastUsedStep.get(userId);
  if (last !== undefined && step <= last) return false;
  lastUsedStep.set(userId, step);
  pruneReplayCache(totpStep(timeMs));
  return true;
}

function pruneReplayCache(nowStep: number): void {
  if (lastUsedStep.size < 1000) return;
  for (const [user, step] of lastUsedStep) {
    if (step < nowStep - WINDOW - 1) lastUsedStep.delete(user);
  }
}

/** Forget replay state for a user (e.g. TOTP disabled). */
export function forgetTotpUser(userId: string): void {
  lastUsedStep.delete(userId);
}

export function otpauthUrl(username: string, secretB32: string): string {
  const issuer = encodeURIComponent(TOTP_ISSUER);
  return `otpauth://totp/${issuer}:${encodeURIComponent(username)}?secret=${secretB32}&issuer=${issuer}`;
}

export function totpQrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
}
