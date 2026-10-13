import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  needsRehash,
  passwordSchema,
  usernameSchema,
  verifyDummyPassword,
  verifyPassword,
} from './passwords.js';

describe('password hashing', () => {
  it('hashes with argon2id in PHC format and verifies', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batterY', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
    expect(needsRehash(hash)).toBe(false);
  });

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same password'), hashPassword('same password')]);
    expect(a).not.toBe(b);
  });

  it('verifies the reference argon2 CLI vector (interoperable PHC encoding)', async () => {
    // echo -n password | argon2 somesalt -id -t 2 -m 16 -p 1 -l 32
    const ref = '$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc';
    expect(await verifyPassword('password', ref)).toBe(true);
    expect(await verifyPassword('passwore', ref)).toBe(false);
    expect(needsRehash(ref)).toBe(true); // t=2 is below our current t=3
  });

  it('verifies scrypt fallback hashes', async () => {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync('fallback pass', salt, 32, { N: 1024, r: 8, p: 1 });
    const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');
    const hash = `$scrypt$N=1024,r=8,p=1$${b64(salt)}$${b64(key)}`;
    expect(await verifyPassword('fallback pass', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(needsRehash(hash)).toBe(true);
  });

  it('treats NFC/NFD forms of the same password as equal', async () => {
    const hash = await hashPassword('café-pässword');
    expect(await verifyPassword('café-pässword', hash)).toBe(true);
  });

  it('returns false (never throws) for malformed hashes', async () => {
    const bad = [
      '',
      'plaintext',
      '$argon2id$v=19$m=65536,t=3,p=1$$',
      '$argon2id$v=18$m=65536,t=3,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc',
      '$argon2id$v=19$m=99999999999,t=3,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc',
      '$argon2id$v=19$m=65536,t=3$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc',
      '$argon2i$v=19$m=65536,t=3,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc',
      '$scrypt$N=1000,r=8,p=1$c29tZXNhbHQ$CTFhFdXPJO1aFaMaO6Mm5c8y7cJHAph8ArZWb2GRPPc',
      '$bcrypt$whatever',
    ];
    for (const h of bad) {
      expect(await verifyPassword('password', h)).toBe(false);
      expect(needsRehash(h)).toBe(true);
    }
  });

  it('dummy verification always fails', async () => {
    expect(await verifyDummyPassword('anything')).toBe(false);
  });
});

describe('credential policy', () => {
  it('passwords must be 10-256 characters', () => {
    expect(passwordSchema.safeParse('123456789').success).toBe(false);
    expect(passwordSchema.safeParse('1234567890').success).toBe(true);
    expect(passwordSchema.safeParse('x'.repeat(256)).success).toBe(true);
    expect(passwordSchema.safeParse('x'.repeat(257)).success).toBe(false);
  });

  it('usernames must be 3-32 of [A-Za-z0-9_.-]', () => {
    for (const ok of ['bob', 'Alice_01', 'a.b-c', 'x'.repeat(32)]) expect(usernameSchema.safeParse(ok).success).toBe(true);
    for (const bad of ['ab', 'x'.repeat(33), 'with space', 'émile', 'a/b', '']) {
      expect(usernameSchema.safeParse(bad).success).toBe(false);
    }
  });
});
