// Secrets at rest: AES-256-GCM with a 32-byte master key.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { SecretBox } from '../services.js';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';
export const MASTER_KEY_FILE = 'master.key';

/** Parse MASTER_KEY: 64 hex chars, or base64/base64url of exactly 32 bytes. */
export function parseMasterKey(value: string): Buffer {
  const v = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(v)) {
    const buf = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (buf.length === KEY_BYTES) return buf;
  }
  throw new Error('MASTER_KEY must be 64 hex characters or the base64 encoding of exactly 32 bytes');
}

/** Read the key file: raw 32 bytes (what we write), or a hex/base64 text key placed there by hand. */
function readKeyFile(file: string): Buffer {
  const buf = fs.readFileSync(file);
  if (buf.length === KEY_BYTES) return buf;
  try {
    return parseMasterKey(buf.toString('utf8'));
  } catch {
    throw new Error(`${file} is not a valid master key (expected 32 raw bytes, 64 hex chars or base64 of 32 bytes)`);
  }
}

/**
 * Master key from config.masterKey, else `<dataDir>/master.key` (created with
 * mode 0600 on first run). Losing this file makes every stored secret unreadable.
 */
export function loadMasterKey(config: Pick<AppConfig, 'masterKey' | 'dataDir'>): Buffer {
  if (config.masterKey) return parseMasterKey(config.masterKey);

  const file = path.join(config.dataDir, MASTER_KEY_FILE);
  if (fs.existsSync(file)) return readKeyFile(file);

  fs.mkdirSync(config.dataDir, { recursive: true });
  const key = crypto.randomBytes(KEY_BYTES);
  try {
    // 'wx' fails if another process created the file in the meantime.
    fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return readKeyFile(file);
    throw err;
  }
  return key;
}

function b64(buf: Buffer): string {
  return buf.toString('base64');
}

export function createSecretBox(key: Buffer): SecretBox {
  if (key.length !== KEY_BYTES) throw new Error(`Secret box key must be ${KEY_BYTES} bytes`);
  const k = Buffer.from(key); // private copy

  return {
    encrypt(plaintext: string): string {
      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', k, iv, { authTagLength: TAG_BYTES });
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return `${VERSION}:${b64(iv)}:${b64(cipher.getAuthTag())}:${b64(ct)}`;
    },

    decrypt(ciphertext: string): string {
      const parts = ciphertext.split(':');
      if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Unsupported secret format');
      const iv = Buffer.from(parts[1] ?? '', 'base64');
      const tag = Buffer.from(parts[2] ?? '', 'base64');
      const ct = Buffer.from(parts[3] ?? '', 'base64');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Malformed secret');
      // authTagLength pins the tag size so truncated tags are rejected.
      const decipher = crypto.createDecipheriv('aes-256-gcm', k, iv, { authTagLength: TAG_BYTES });
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
      } catch {
        throw new Error('Secret decryption failed (tampered data or wrong master key)');
      }
    },
  };
}
