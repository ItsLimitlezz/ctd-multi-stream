import crypto from 'node:crypto';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { createRepos } from '../db/repos.js';
import { createSecretBox } from './secretbox.js';
import {
  announceSetupCodeIfNeeded,
  clearSetupCode,
  generateSetupCode,
  hasSetupCode,
  verifySetupCode,
} from './setup-code.js';

function captureLogger() {
  const warnings: { obj: unknown; msg: string }[] = [];
  const log = { warn: (obj: unknown, msg: string) => warnings.push({ obj, msg }) } as unknown as Logger;
  return { log, warnings };
}

function newRepos() {
  return createRepos(openDatabase(':memory:'), createSecretBox(crypto.randomBytes(32)));
}

afterEach(() => clearSetupCode());

describe('setup code', () => {
  it('uses the unambiguous XXXX-XXXX-XXXX format', () => {
    for (let i = 0; i < 100; i++) expect(generateSetupCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });

  it('announces a code with a banner when there are no users, and verifies it', () => {
    const { log, warnings } = captureLogger();
    announceSetupCodeIfNeeded(newRepos(), log);
    expect(warnings).toHaveLength(1);
    const code = /Setup code:\s+([A-Z0-9-]+)/.exec(warnings[0]?.msg ?? '')?.[1];
    expect(code).toBeDefined();
    expect(warnings[0]?.msg).toMatch(/open the web UI and enter this code/i);
    expect(verifySetupCode(code!)).toBe(true);
    expect(verifySetupCode(code!.toLowerCase().replace(/-/g, ' '))).toBe(true);
    expect(verifySetupCode('AAAA-AAAA-AAAA')).toBe(false);
    expect(verifySetupCode('')).toBe(false);
    clearSetupCode();
    expect(verifySetupCode(code!)).toBe(false);
  });

  it('regenerates on each announce while there are no users', () => {
    const { log, warnings } = captureLogger();
    const repos = newRepos();
    announceSetupCodeIfNeeded(repos, log);
    announceSetupCodeIfNeeded(repos, log);
    const codes = warnings.map((w) => /Setup code:\s+(\S+)/.exec(w.msg)?.[1]);
    expect(codes[0]).not.toBe(codes[1]);
    expect(verifySetupCode(codes[0]!)).toBe(false);
    expect(verifySetupCode(codes[1]!)).toBe(true);
  });

  it('stays silent and invalid once a user exists', () => {
    const { log, warnings } = captureLogger();
    const repos = newRepos();
    repos.users.create({ username: 'admin', passwordHash: 'x', role: 'admin' });
    announceSetupCodeIfNeeded(repos, log);
    expect(warnings).toHaveLength(0);
    expect(hasSetupCode()).toBe(false);
    expect(verifySetupCode('ABCD-EFGH-JKLM')).toBe(false);
  });
});
