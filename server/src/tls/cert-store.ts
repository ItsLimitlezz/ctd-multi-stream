// Reading/writing PEM files under <dataDir>/tls (atomic writes, private keys mode 0600).

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TlsMaterial } from '../services.js';

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Write via a temp file + rename so readers never see a half-written file. */
export async function writeFileAtomic(file: string, data: string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, data, { mode });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function readPemPair(keyFile: string, certFile: string): Promise<TlsMaterial | null> {
  const [key, cert] = await Promise.all([readTextIfExists(keyFile), readTextIfExists(certFile)]);
  return key && cert ? { key, cert } : null;
}

/** Cert first, key second: a crash in between leaves a mismatched pair, which readers reject. */
export async function writePemPair(keyFile: string, certFile: string, m: TlsMaterial): Promise<void> {
  await writeFileAtomic(certFile, m.cert, 0o644);
  await writeFileAtomic(keyFile, m.key, 0o600);
}

/** Load a PEM private key, or create + persist one when missing or unreadable. */
export async function loadOrCreateKey(file: string, create: () => Promise<string>): Promise<{ key: string; created: boolean }> {
  const existing = await readTextIfExists(file);
  if (existing) {
    try {
      crypto.createPrivateKey(existing);
      return { key: existing, created: false };
    } catch {
      // corrupt: fall through and replace it
    }
  }
  const key = await create();
  await writeFileAtomic(file, key, 0o600);
  return { key, created: true };
}
