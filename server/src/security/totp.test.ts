import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  forgetTotpUser,
  generateTotpSecret,
  hotp,
  matchTotp,
  otpauthUrl,
  totp,
  totpQrSvg,
  verifyTotp,
} from './totp.js';

const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('base32', () => {
  it('matches RFC 4648 test vectors', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [plain, enc] of vectors) {
      expect(base32Encode(Buffer.from(plain))).toBe(enc);
      expect(base32Decode(enc).toString()).toBe(plain);
    }
  });

  it('round-trips random data and tolerates case, spaces and padding', () => {
    for (let i = 0; i < 50; i++) {
      const buf = crypto.randomBytes(i);
      expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    }
    expect(base32Decode('mzxw 6ytb oi======').toString()).toBe('foobar');
    expect(() => base32Decode('MZXW1')).toThrow();
  });

  it('encodes the RFC 6238 secret', () => {
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('generates 20-byte secrets', () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
  });
});

describe('HOTP/TOTP', () => {
  it('matches RFC 4226 HOTP vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });

  it('matches the RFC 6238 SHA-1 vector at T=59', () => {
    expect(totp(RFC_SECRET, 59_000, 8)).toBe('94287082');
    expect(totp(RFC_SECRET, 59_000)).toBe('287082');
    expect(totp(RFC_SECRET, 1_111_111_109_000, 8)).toBe('07081804');
    expect(totp(RFC_SECRET, 2_000_000_000_000, 8)).toBe('69279037');
  });

  it('accepts ±1 step and rejects further drift or bad formats', () => {
    const secret = base32Encode(RFC_SECRET);
    const t = 1_700_000_000_000;
    const step = Math.floor(t / 30_000);
    expect(matchTotp(secret, totp(RFC_SECRET, t), t)).toBe(step);
    expect(matchTotp(secret, totp(RFC_SECRET, t - 30_000), t)).toBe(step - 1);
    expect(matchTotp(secret, totp(RFC_SECRET, t + 30_000), t)).toBe(step + 1);
    expect(matchTotp(secret, totp(RFC_SECRET, t - 60_000), t)).toBeNull();
    expect(matchTotp(secret, totp(RFC_SECRET, t + 60_000), t)).toBeNull();
    const code = totp(RFC_SECRET, t);
    expect(matchTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, t)).toBe(step);
    expect(matchTotp(secret, '12345', t)).toBeNull();
    expect(matchTotp(secret, 'abcdef', t)).toBeNull();
    expect(matchTotp('!!!', code, t)).toBeNull();
  });

  it('rejects replay of the same (or an older) step per user', () => {
    const secretB32 = generateTotpSecret();
    const secret = base32Decode(secretB32);
    const user = crypto.randomUUID();
    const t = 1_800_000_000_000;
    const code = totp(secret, t);
    expect(verifyTotp(user, secretB32, code, t)).toBe(true);
    expect(verifyTotp(user, secretB32, code, t)).toBe(false); // same code again
    expect(verifyTotp(user, secretB32, totp(secret, t - 30_000), t)).toBe(false); // older step
    expect(verifyTotp(user, secretB32, totp(secret, t + 30_000), t + 30_000)).toBe(true); // next step is fine
    // Another user is independent.
    expect(verifyTotp(crypto.randomUUID(), secretB32, code, t)).toBe(true);
    forgetTotpUser(user);
    expect(verifyTotp(user, secretB32, code, t)).toBe(true);
  });
});

describe('provisioning', () => {
  it('builds the otpauth URL', () => {
    expect(otpauthUrl('juan.s', 'ABC234')).toBe(
      'otpauth://totp/CTD%20Multi-Stream:juan.s?secret=ABC234&issuer=CTD%20Multi-Stream',
    );
  });

  it('renders an SVG QR code', async () => {
    const svg = await totpQrSvg(otpauthUrl('bob', generateTotpSecret()));
    expect(svg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
  });
});
