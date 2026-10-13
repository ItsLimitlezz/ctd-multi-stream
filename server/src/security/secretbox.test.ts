import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MASTER_KEY_FILE, createSecretBox, loadMasterKey, parseMasterKey } from './secretbox.js';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctd-secretbox-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('createSecretBox', () => {
  const box = createSecretBox(crypto.randomBytes(32));

  it('round-trips text, including unicode and empty strings', () => {
    for (const s of ['hello', '', 'sk_live_ünïcødé 🔑', 'x'.repeat(10_000)]) {
      expect(box.decrypt(box.encrypt(s))).toBe(s);
    }
  });

  it('uses the v1:<iv>:<tag>:<ct> format with a fresh IV each time', () => {
    const a = box.encrypt('same');
    const b = box.encrypt('same');
    expect(a).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*$/);
    expect(a).not.toBe(b);
    expect(Buffer.from(a.split(':')[1] ?? '', 'base64')).toHaveLength(12);
    expect(Buffer.from(a.split(':')[2] ?? '', 'base64')).toHaveLength(16);
  });

  it('detects tampering of ciphertext, tag and iv', () => {
    const enc = box.encrypt('secret value');
    const [v, iv, tag, ct] = enc.split(':') as [string, string, string, string];
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, 'base64');
      buf[0] = (buf[0] ?? 0) ^ 1;
      return buf.toString('base64');
    };
    expect(() => box.decrypt([v, iv, tag, flip(ct)].join(':'))).toThrow(/decryption failed/);
    expect(() => box.decrypt([v, iv, flip(tag), ct].join(':'))).toThrow(/decryption failed/);
    expect(() => box.decrypt([v, flip(iv), tag, ct].join(':'))).toThrow(/decryption failed/);
  });

  it('rejects truncated tags, wrong versions and garbage', () => {
    const [v, iv, tag, ct] = box.encrypt('abc').split(':') as [string, string, string, string];
    const shortTag = Buffer.from(tag, 'base64').subarray(0, 4).toString('base64');
    expect(() => box.decrypt([v, iv, shortTag, ct].join(':'))).toThrow();
    expect(() => box.decrypt(['v2', iv, tag, ct].join(':'))).toThrow(/Unsupported/);
    expect(() => box.decrypt('not a secret')).toThrow();
  });

  it('fails with a different key', () => {
    const other = createSecretBox(crypto.randomBytes(32));
    expect(() => other.decrypt(box.encrypt('x'))).toThrow(/wrong master key/);
  });

  it('requires a 32-byte key', () => {
    expect(() => createSecretBox(crypto.randomBytes(16))).toThrow();
  });
});

describe('master key loading', () => {
  const key = crypto.randomBytes(32);

  it('accepts 64 hex chars', () => {
    expect(parseMasterKey(key.toString('hex')).equals(key)).toBe(true);
    expect(parseMasterKey(`  ${key.toString('hex').toUpperCase()}\n`).equals(key)).toBe(true);
  });

  it('accepts base64 and base64url of exactly 32 bytes', () => {
    expect(parseMasterKey(key.toString('base64')).equals(key)).toBe(true);
    expect(parseMasterKey(key.toString('base64url')).equals(key)).toBe(true);
  });

  it('rejects other lengths and junk with a clear error', () => {
    expect(() => parseMasterKey(crypto.randomBytes(16).toString('hex'))).toThrow(/MASTER_KEY/);
    expect(() => parseMasterKey(crypto.randomBytes(31).toString('base64'))).toThrow(/MASTER_KEY/);
    expect(() => parseMasterKey('correct horse battery staple')).toThrow(/MASTER_KEY/);
  });

  it('prefers config.masterKey over the key file', () => {
    const dir = tmpDir();
    const loaded = loadMasterKey({ masterKey: key.toString('hex'), dataDir: dir });
    expect(loaded.equals(key)).toBe(true);
    expect(fs.existsSync(path.join(dir, MASTER_KEY_FILE))).toBe(false);
  });

  it('creates <dataDir>/master.key on first run and reuses it', () => {
    const dir = path.join(tmpDir(), 'nested', 'data');
    const first = loadMasterKey({ masterKey: null, dataDir: dir });
    const file = path.join(dir, MASTER_KEY_FILE);
    expect(first).toHaveLength(32);
    expect(fs.readFileSync(file).equals(first)).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(loadMasterKey({ masterKey: null, dataDir: dir }).equals(first)).toBe(true);
  });

  it('reads a hand-placed hex key file and rejects a corrupt one', () => {
    const dir = tmpDir();
    const file = path.join(dir, MASTER_KEY_FILE);
    fs.writeFileSync(file, `${key.toString('hex')}\n`);
    expect(loadMasterKey({ masterKey: null, dataDir: dir }).equals(key)).toBe(true);
    fs.writeFileSync(file, 'short');
    expect(() => loadMasterKey({ masterKey: null, dataDir: dir })).toThrow(/not a valid master key/);
  });
});
