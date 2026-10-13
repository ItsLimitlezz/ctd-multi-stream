import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSecretBox } from '../security/secretbox.js';
import type { Repos } from '../services.js';
import { MIGRATIONS, migrate, openDatabase, schemaVersion, type Db } from './database.js';
import { createAuditRepo } from './audit-repo.js';
import { ConflictError, NotFoundError, createRepos } from './repos.js';
import { statementCache } from './rows.js';
import { hashSessionToken } from './sessions-repo.js';

const DAY = 24 * 3600_000;
const box = createSecretBox(crypto.randomBytes(32));

let db: Db;
let repos: Repos;

beforeEach(() => {
  db = openDatabase(':memory:');
  repos = createRepos(db, box);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('database', () => {
  it('migrates to the latest schema version and is idempotent', () => {
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    const fk = db.prepare('PRAGMA foreign_keys').get();
    expect(fk?.foreign_keys).toBe(1);
  });

  it('refuses a database from a newer app version', () => {
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    expect(() => migrate(db)).toThrow(/newer/);
  });

  it('rolls back a failing migration step', () => {
    const fresh = openDatabase(':memory:');
    expect(() => migrate(fresh, [...MIGRATIONS, 'CREATE TABLE extra (x INTEGER); SELECT * FROM nope;'])).toThrow();
    expect(schemaVersion(fresh)).toBe(MIGRATIONS.length);
    expect(fresh.prepare("SELECT name FROM sqlite_master WHERE name = 'extra'").get()).toBeUndefined();
    fresh.close();
  });

  it('opens a file database in WAL mode, creating the directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctd-db-'));
    const file = path.join(dir, 'sub', 'app.db');
    try {
      const fileDb = openDatabase(file);
      expect(fileDb.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
      createRepos(fileDb, box).settings.set('k', 1);
      fileDb.close();
      const reopened = openDatabase(file);
      expect(createRepos(reopened, box).settings.get('k', 0)).toBe(1);
      reopened.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('users repo', () => {
  it('creates, reads, updates, lists and deletes users', () => {
    expect(repos.users.count()).toBe(0);
    const u = repos.users.create({ username: 'Alice', passwordHash: 'hash1', role: 'admin' });
    expect(u).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      username: 'Alice',
      role: 'admin',
      totpEnabled: false,
      createdAt: expect.any(String),
      lastLoginAt: null,
    });
    expect(u).not.toHaveProperty('passwordHash');
    expect(repos.users.count()).toBe(1);

    const rec = repos.users.getByUsername('aLiCe');
    expect(rec?.id).toBe(u.id);
    expect(rec?.passwordHash).toBe('hash1');
    expect(rec?.failedLogins).toBe(0);
    expect(rec?.lockedUntil).toBeNull();
    expect(rec?.totpSecret).toBeNull();

    const updated = repos.users.update(u.id, {
      role: 'operator',
      passwordHash: 'hash2',
      totpEnabled: true,
      totpSecret: 'enc',
      failedLogins: 3,
      lockedUntil: '2030-01-01T00:00:00.000Z',
      lastLoginAt: '2026-10-11T00:00:00.000Z',
    });
    expect(updated.role).toBe('operator');
    expect(updated.totpEnabled).toBe(true);
    expect(updated.lastLoginAt).toBe('2026-10-11T00:00:00.000Z');
    expect(updated).not.toHaveProperty('totpSecret');
    const rec2 = repos.users.get(u.id);
    expect(rec2).toMatchObject({ passwordHash: 'hash2', totpSecret: 'enc', failedLogins: 3, lockedUntil: '2030-01-01T00:00:00.000Z' });

    // null clears, undefined keeps
    repos.users.update(u.id, { lockedUntil: null, totpSecret: undefined });
    expect(repos.users.get(u.id)).toMatchObject({ lockedUntil: null, totpSecret: 'enc' });

    const b = repos.users.create({ username: 'bob', passwordHash: 'h', role: 'operator' });
    expect(repos.users.list().map((x) => x.username)).toEqual(['Alice', 'bob']);
    expect(repos.users.list()[0]).not.toHaveProperty('passwordHash');

    repos.users.delete(b.id);
    expect(repos.users.get(b.id)).toBeNull();
    expect(repos.users.count()).toBe(1);
  });

  it('enforces case-insensitive unique usernames', () => {
    repos.users.create({ username: 'carol', passwordHash: 'h', role: 'admin' });
    expect(() => repos.users.create({ username: 'CAROL', passwordHash: 'h', role: 'admin' })).toThrow(ConflictError);
  });

  it('throws NotFoundError when updating a missing user', () => {
    expect(() => repos.users.update('nope', { role: 'admin' })).toThrow(NotFoundError);
    expect(() => repos.users.update('nope', {})).toThrow(NotFoundError);
  });
});

describe('auth sessions repo', () => {
  function newUser(name = 'sess') {
    return repos.users.create({ username: name, passwordHash: 'h', role: 'operator' });
  }

  it('creates sessions stored by token hash with a separate CSRF token', () => {
    const user = newUser();
    const { record, token } = repos.authSessions.create(user.id, { ip: '10.0.0.1', userAgent: 'test' });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(record.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(record.csrfToken).not.toBe(token);
    expect(record.id).toBe(hashSessionToken(token));
    const raw = db.prepare('SELECT id FROM auth_sessions').all();
    expect(raw.map((r) => r.id)).toEqual([hashSessionToken(token)]);
    expect(Date.parse(record.expiresAt) - Date.parse(record.createdAt)).toBe(30 * DAY);

    const touched = repos.authSessions.touch(token);
    expect(touched?.userId).toBe(user.id);
    expect(touched?.ip).toBe('10.0.0.1');
    expect(repos.authSessions.touch('wrong-token')).toBeNull();
    expect(repos.authSessions.touch('')).toBeNull();
    expect(repos.authSessions.touch('x'.repeat(1000))).toBeNull();
  });

  it('slides expiry at most once per minute and caps it at 90 days', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(t0);
    const user = newUser();
    const { token } = repos.authSessions.create(user.id, { ip: null, userAgent: null });

    vi.setSystemTime(t0 + 30_000);
    expect(repos.authSessions.touch(token)?.lastSeenAt).toBe(new Date(t0).toISOString()); // < 1 min: no write

    vi.setSystemTime(t0 + 2 * 60_000);
    const slid = repos.authSessions.touch(token);
    expect(slid?.lastSeenAt).toBe(new Date(t0 + 2 * 60_000).toISOString());
    expect(slid?.expiresAt).toBe(new Date(t0 + 2 * 60_000 + 30 * DAY).toISOString());

    // Keep using it every 20 days: never idles out, but dies at createdAt + 90 days.
    for (let d = 20; d < 90; d += 20) {
      vi.setSystemTime(t0 + d * DAY);
      const s = repos.authSessions.touch(token);
      expect(s).not.toBeNull();
      expect(Date.parse(s!.expiresAt)).toBeLessThanOrEqual(t0 + 90 * DAY);
    }
    vi.setSystemTime(t0 + 90 * DAY);
    expect(repos.authSessions.touch(token)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get()?.n).toBe(0); // deleted on expiry
  });

  it('expires idle sessions after 30 days and purges them', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-03-01T00:00:00.000Z');
    vi.setSystemTime(t0);
    const user = newUser();
    const idle = repos.authSessions.create(user.id, { ip: null, userAgent: null });
    const active = repos.authSessions.create(user.id, { ip: null, userAgent: null });
    vi.setSystemTime(t0 + 29 * DAY);
    expect(repos.authSessions.touch(active.token)).not.toBeNull();
    vi.setSystemTime(t0 + 30 * DAY);
    repos.authSessions.purgeExpired();
    expect(db.prepare('SELECT id FROM auth_sessions').all().map((r) => r.id)).toEqual([active.record.id]);
    expect(repos.authSessions.touch(idle.token)).toBeNull();
    expect(repos.authSessions.touch(active.token)).not.toBeNull();
  });

  it('deletes single sessions, all sessions for a user, or all but one', () => {
    const user = newUser('multi');
    const other = newUser('other');
    const a = repos.authSessions.create(user.id, { ip: null, userAgent: null });
    const b = repos.authSessions.create(user.id, { ip: null, userAgent: null });
    const c = repos.authSessions.create(user.id, { ip: null, userAgent: null });
    const o = repos.authSessions.create(other.id, { ip: null, userAgent: null });

    repos.authSessions.delete(a.token);
    expect(repos.authSessions.touch(a.token)).toBeNull();

    repos.authSessions.deleteForUser(user.id, b.token);
    expect(repos.authSessions.touch(b.token)).not.toBeNull();
    expect(repos.authSessions.touch(c.token)).toBeNull();

    repos.authSessions.deleteForUser(user.id);
    expect(repos.authSessions.touch(b.token)).toBeNull();
    expect(repos.authSessions.touch(o.token)).not.toBeNull();
  });

  it('cascades session deletion with the user', () => {
    const user = newUser('gone');
    const s = repos.authSessions.create(user.id, { ip: null, userAgent: null });
    repos.users.delete(user.id);
    expect(repos.authSessions.touch(s.token)).toBeNull();
  });
});

describe('accounts and destinations repos', () => {
  it('CRUDs accounts', () => {
    const acc = repos.accounts.create({ platform: 'twitch', label: 'Main', options: { mode: 'page' } });
    expect(acc).toMatchObject({ platform: 'twitch', label: 'Main', status: 'pending', statusMessage: null, options: { mode: 'page' } });
    const upd = repos.accounts.update(acc.id, { status: 'connected', statusMessage: 'ok', label: 'Renamed' });
    expect(upd).toMatchObject({ status: 'connected', statusMessage: 'ok', label: 'Renamed', options: { mode: 'page' } });
    expect(repos.accounts.update(acc.id, { statusMessage: null }).statusMessage).toBeNull();
    expect(repos.accounts.list()).toHaveLength(1);
    expect(() => repos.accounts.update('missing', { label: 'x' })).toThrow(NotFoundError);
    repos.accounts.delete(acc.id);
    expect(repos.accounts.get(acc.id)).toBeNull();
  });

  it('CRUDs destinations and detaches accounts', () => {
    const acc = repos.accounts.create({ platform: 'kick', label: 'K', options: {} });
    const d1 = repos.destinations.create({
      platform: 'kick',
      accountId: acc.id,
      name: 'Kick main',
      feed: 'landscape',
      enabled: true,
      options: { a: 1 },
      ingestUrl: 'rtmps://example.invalid/app',
    });
    expect(d1).toMatchObject({ accountId: acc.id, feed: 'landscape', enabled: true, hasStreamKey: false, options: { a: 1 } });
    const d2 = repos.destinations.create({
      platform: 'custom',
      accountId: null,
      name: 'Custom',
      feed: 'vertical',
      enabled: false,
      options: {},
      ingestUrl: null,
    });
    expect(d2.enabled).toBe(false);

    const upd = repos.destinations.update(d1.id, { hasStreamKey: true, enabled: false, feed: 'vertical', ingestUrl: null });
    expect(upd).toMatchObject({ hasStreamKey: true, enabled: false, feed: 'vertical', ingestUrl: null, name: 'Kick main' });

    repos.destinations.detachAccount(acc.id);
    expect(repos.destinations.get(d1.id)?.accountId).toBeNull();
    expect(repos.destinations.list().map((d) => d.name)).toEqual(['Kick main', 'Custom']);
    expect(() => repos.destinations.update('missing', { name: 'x' })).toThrow(NotFoundError);
    repos.destinations.delete(d2.id);
    expect(repos.destinations.list()).toHaveLength(1);
  });
});

describe('settings repo', () => {
  it('stores JSON values with fallbacks', () => {
    expect(repos.settings.get('session.autoGoLive', true)).toBe(true);
    repos.settings.set('session.autoGoLive', false);
    expect(repos.settings.get('session.autoGoLive', true)).toBe(false);
    repos.settings.set('app', { publicBaseUrl: 'https://x', disconnectGraceSec: 20 });
    expect(repos.settings.get('app', {})).toEqual({ publicBaseUrl: 'https://x', disconnectGraceSec: 20 });
    repos.settings.set('session.title', 'Hello "world"');
    expect(repos.settings.get('session.title', '')).toBe('Hello "world"');
    repos.settings.delete('session.title');
    expect(repos.settings.get('session.title', 'default')).toBe('default');
    db.prepare("INSERT INTO settings (key, value) VALUES ('corrupt', '{nope')").run();
    expect(repos.settings.get('corrupt', 42)).toBe(42);
  });
});

describe('secrets repo', () => {
  it('encrypts at rest and isolates scopes', async () => {
    const a = repos.secrets.scoped('account:a');
    const b = repos.secrets.scoped('account:b');
    await a.set('oauth', 'token-a');
    await b.set('oauth', 'token-b');
    expect(await a.get('oauth')).toBe('token-a');
    expect(await b.get('oauth')).toBe('token-b');
    expect(await a.get('missing')).toBeNull();

    const raw = db.prepare('SELECT value FROM secrets').all().map((r) => String(r.value));
    expect(raw.every((v) => v.startsWith('v1:'))).toBe(true);
    expect(raw.some((v) => v.includes('token-a'))).toBe(false);

    await a.set('oauth', 'token-a2'); // upsert
    expect(await a.get('oauth')).toBe('token-a2');
    await a.delete('oauth');
    expect(await a.get('oauth')).toBeNull();
  });

  it('stores JSON and deletes whole scopes', async () => {
    const s = repos.secrets.scoped('browser:x');
    await s.setJson('storageState', { cookies: [{ name: 'sid', value: 'v' }] });
    await s.set('other', 'y');
    expect(await s.getJson<{ cookies: unknown[] }>('storageState')).toEqual({ cookies: [{ name: 'sid', value: 'v' }] });
    expect(await s.getJson('nope')).toBeNull();
    const keep = repos.secrets.scoped('browser:y');
    await keep.set('k', 'v');

    repos.secrets.deleteScope('browser:x');
    expect(await s.getJson('storageState')).toBeNull();
    expect(await s.get('other')).toBeNull();
    expect(await keep.get('k')).toBe('v');
  });

  it('rejects (without leaking the value) when data was encrypted with another key', async () => {
    const s = repos.secrets.scoped('ingest');
    await s.set('landscape', 'super-secret-key');
    const otherRepos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
    const err = await otherRepos.secrets.scoped('ingest').get('landscape').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/ingest\/landscape/);
    expect((err as Error).message).not.toMatch(/super-secret-key/);
  });
});

describe('audit repo', () => {
  it('lists newest first with paging', () => {
    for (let i = 1; i <= 5; i++) {
      repos.audit.log({ userId: 'u', username: 'alice', action: `act.${i}`, detail: i % 2 ? `d${i}` : null, ip: '1.2.3.4' });
    }
    repos.audit.log({ userId: null, username: null, action: 'system' });
    const all = repos.audit.list({ limit: 100 });
    expect(all.map((e) => e.action)).toEqual(['system', 'act.5', 'act.4', 'act.3', 'act.2', 'act.1']);
    expect(all[0]).toMatchObject({ userId: null, username: null, detail: null, ip: null });
    expect(all[1]).toMatchObject({ userId: 'u', username: 'alice', detail: 'd5', ip: '1.2.3.4' });

    const page1 = repos.audit.list({ limit: 2 });
    const page2 = repos.audit.list({ limit: 2, before: page1[1]!.id });
    expect(page2.map((e) => e.action)).toEqual(['act.4', 'act.3']);
    expect(repos.audit.list({ limit: 0 })).toHaveLength(1); // clamped to >= 1
  });

  it('keeps at most N rows', () => {
    const audit = createAuditRepo(statementCache(db), 50);
    for (let i = 0; i < 230; i++) audit.log({ userId: null, username: null, action: `a${i}` });
    audit.prune();
    const rows = audit.list({ limit: 500 });
    expect(rows).toHaveLength(50);
    expect(rows[0]?.action).toBe('a229');
    expect(rows[49]?.action).toBe('a180');
  });

  it('clips oversized fields', () => {
    repos.audit.log({ userId: null, username: 'u'.repeat(500), action: 'x', detail: 'd'.repeat(10_000) });
    const [e] = repos.audit.list({ limit: 1 });
    expect(e?.username?.length).toBe(64);
    expect(e?.detail?.length).toBe(2000);
  });
});
