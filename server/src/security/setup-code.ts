// First-run claim code: printed in the logs so only someone with access to the container
// can create the first admin account.

import crypto from 'node:crypto';
import type { Logger } from 'pino';
import type { Repos } from '../services.js';

// No 0/O, 1/I: easy to read off a log. 32 symbols -> 5 bits each, 12 symbols = 60 bits.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GROUPS = 3;
const GROUP_LEN = 4;

let current: string | null = null;

function normalize(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function generateSetupCode(): string {
  const bytes = crypto.randomBytes(GROUPS * GROUP_LEN);
  // 256 is a multiple of 32, so `byte % 32` is unbiased.
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  const groups: string[] = [];
  for (let i = 0; i < GROUPS; i++) groups.push(chars.slice(i * GROUP_LEN, (i + 1) * GROUP_LEN));
  return groups.join('-');
}

/** At startup: when no users exist, create a fresh code and print it prominently. */
export function announceSetupCodeIfNeeded(repos: Repos, log: Logger): void {
  if (repos.users.count() > 0) {
    current = null;
    return;
  }
  current = generateSetupCode();
  const line = '='.repeat(68);
  const banner = [
    '',
    line,
    '  CTD Multi-Stream: first-run setup',
    '',
    `  Setup code:  ${current}`,
    '',
    '  Open the web UI and enter this code to create the admin account.',
    '  A new code is generated on every restart until setup is complete.',
    line,
  ].join('\n');
  log.warn({ setupCode: current }, banner);
}

/** Constant-time check of a user-entered code (case, spaces and dashes ignored). */
export function verifySetupCode(code: string): boolean {
  if (!current) return false;
  const a = crypto.createHash('sha256').update(normalize(code)).digest();
  const b = crypto.createHash('sha256').update(normalize(current)).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Invalidate the code (setup completed). */
export function clearSetupCode(): void {
  current = null;
}

export function hasSetupCode(): boolean {
  return current !== null;
}
