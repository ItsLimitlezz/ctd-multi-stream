// The owner's live install holds developer-app credentials, accounts, destinations, stream keys and
// users. Schema changes are append-only: these tests prove an upgrade keeps all of it intact.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecretBox } from '../security/secretbox.js';
import { createAccountsRepo } from './accounts-repo.js';
import { MIGRATIONS, migrate, openDatabase, schemaVersion } from './database.js';
import { createSecretsRepo, createSettingsRepo } from './kv-repos.js';
import { createDestinationsRepo } from './destinations-repo.js';
import { createRepos } from './repos.js';
import { statementCache } from './rows.js';
import { createUsersRepo } from './users-repo.js';

/** SHA-256 of each shipped migration step. A shipped step must never change. */
const SHIPPED_STEP_HASHES = [
  '4dd2c5b18087e881c32c2570a7f8871fa8b0a317c949d9392dc5bc7d306d2f9f', // v1: initial schema
  'd4c55d6e657418f8be8c2ab177595c933ec0b967bab0629f8a789f9ef6d21d69', // v2: api_tokens
];

const masterKey = crypto.randomBytes(32);
const box = createSecretBox(masterKey);
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctd-migrate-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function tables(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => String(r.name));
}

function dump(db: DatabaseSync, names: string[]) {
  return Object.fromEntries(
    names.map((t) => [
      t,
      {
        columns: db.prepare(`PRAGMA table_info(${t})`).all(),
        rows: db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(),
      },
    ]),
  );
}

describe('migrations are append-only', () => {
  it('never changes a shipped step', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(SHIPPED_STEP_HASHES.length);
    SHIPPED_STEP_HASHES.forEach((hash, i) => {
      expect(crypto.createHash('sha256').update(MIGRATIONS[i] ?? '').digest('hex'), `migration step ${i + 1}`).toBe(hash);
    });
  });

  it('never drops or renames anything', () => {
    for (const step of MIGRATIONS) {
      expect(step).not.toMatch(/\bDROP\b/i);
      expect(step).not.toMatch(/\bRENAME\b/i);
      expect(step).not.toMatch(/\bDELETE\s+FROM\b/i);
      expect(step).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    }
  });
});

describe.each(Array.from({ length: MIGRATIONS.length - 1 }, (_, i) => i + 1))('upgrading a v%i database', (fromVersion) => {
  it('keeps users, accounts, destinations, settings and secrets intact and readable', async () => {
    const file = path.join(dir, 'app.db');

    // 1. A database as an older release left it, with the owner's data in it.
    const old = new DatabaseSync(file);
    old.exec('PRAGMA journal_mode = WAL');
    migrate(old, MIGRATIONS.slice(0, fromVersion));
    expect(schemaVersion(old)).toBe(fromVersion);

    const stmt = statementCache(old);
    const users = createUsersRepo(stmt);
    const accounts = createAccountsRepo(stmt);
    const destinations = createDestinationsRepo(stmt);
    const settings = createSettingsRepo(stmt);
    const secrets = createSecretsRepo(stmt, box);

    const user = users.create({ username: 'Owner', passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA', role: 'admin' });
    users.update(user.id, { totpEnabled: true, totpSecret: box.encrypt('JBSWY3DPEHPK3PXP'), lastLoginAt: '2026-10-01T10:00:00.000Z' });
    const account = accounts.create({ platform: 'youtube', label: 'DPRTMNT', options: { channelId: 'UC123' } });
    accounts.update(account.id, { status: 'connected', statusMessage: null });
    const destination = destinations.create({
      platform: 'youtube',
      accountId: account.id,
      name: 'YouTube main',
      feed: 'landscape',
      enabled: true,
      options: { privacy: 'public', links: [{ title: 'Shop', url: 'https://example.com' }] },
      ingestUrl: 'rtmps://a.rtmps.youtube.com/live2',
    });
    destinations.update(destination.id, { hasStreamKey: true });
    const custom = destinations.create({
      platform: 'custom',
      accountId: null,
      name: 'Backup RTMP',
      feed: 'vertical',
      enabled: false,
      options: {},
      ingestUrl: 'rtmp://backup.example/live',
    });

    const youtubeApp = { clientId: '1234-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-super-secret' };
    const twitchApp = { clientId: 'twitchclient', clientSecret: 'twitchsecret' };
    await secrets.scoped('app:youtube').setJson('values', youtubeApp);
    await secrets.scoped('app:twitch').setJson('values', twitchApp);
    await secrets.scoped(`account:${account.id}`).setJson('oauth', { accessToken: 'ya29.token', refreshToken: '1//refresh' });
    await secrets.scoped(`destination:${destination.id}`).set('streamKey', 'abcd-efgh-ijkl-mnop');
    await secrets.scoped(`destination:${custom.id}`).set('streamKey', 'custom-key');
    await secrets.scoped('ingest').set('landscape', 'ingest-key-1');
    await secrets.scoped('chat').set('overlayToken', 'O'.repeat(43));
    settings.set('app', { publicBaseUrl: 'https://stream.example.com', ingestHost: '192.168.1.20', disconnectGraceSec: 20 });
    settings.set('session.title', 'DPRTMNT Saturday');
    settings.set('session.autoGoLive', false);

    const oldTables = tables(old);
    const before = dump(old, oldTables);
    old.close();

    // 2. The new release opens it (runs every pending migration).
    const db = openDatabase(file);
    try {
      expect(schemaVersion(db)).toBe(MIGRATIONS.length);
      expect(tables(db)).toEqual(expect.arrayContaining(oldTables));
      expect(tables(db)).toContain('api_tokens');

      // Every pre-existing table: same columns, byte-identical rows.
      expect(dump(db, oldTables)).toEqual(before);

      // 3. Everything is still readable through the repos with the same master key.
      const repos = createRepos(db, createSecretBox(masterKey));
      expect(repos.users.getByUsername('owner')).toMatchObject({ id: user.id, role: 'admin', totpEnabled: true });
      expect(box.decrypt(repos.users.get(user.id)!.totpSecret!)).toBe('JBSWY3DPEHPK3PXP');
      expect(repos.accounts.get(account.id)).toMatchObject({ platform: 'youtube', status: 'connected', options: { channelId: 'UC123' } });
      expect(repos.destinations.list().map((d) => d.id)).toEqual([destination.id, custom.id]);
      expect(repos.destinations.get(destination.id)).toMatchObject({ hasStreamKey: true, accountId: account.id, enabled: true });
      expect(await repos.secrets.scoped('app:youtube').getJson('values')).toEqual(youtubeApp);
      expect(await repos.secrets.scoped('app:twitch').getJson('values')).toEqual(twitchApp);
      expect(await repos.secrets.scoped(`account:${account.id}`).getJson('oauth')).toEqual({ accessToken: 'ya29.token', refreshToken: '1//refresh' });
      expect(await repos.secrets.scoped(`destination:${destination.id}`).get('streamKey')).toBe('abcd-efgh-ijkl-mnop');
      expect(await repos.secrets.scoped(`destination:${custom.id}`).get('streamKey')).toBe('custom-key');
      expect(await repos.secrets.scoped('ingest').get('landscape')).toBe('ingest-key-1');
      expect(await repos.secrets.scoped('chat').get('overlayToken')).toBe('O'.repeat(43));
      expect(repos.settings.get('app', {})).toEqual({ publicBaseUrl: 'https://stream.example.com', ingestHost: '192.168.1.20', disconnectGraceSec: 20 });
      expect(repos.settings.get('session.title', '')).toBe('DPRTMNT Saturday');
      expect(repos.settings.get('session.autoGoLive', true)).toBe(false);
    } finally {
      db.close();
    }

    // 4. Opening again (every restart) is a no-op for the data, and the new table works alongside it.
    const again = openDatabase(file);
    try {
      expect(dump(again, oldTables)).toEqual(before);
      const repos = createRepos(again, createSecretBox(masterKey));
      const { secret } = repos.apiTokens.create({ name: 'OBS', scopes: ['status:read'], createdBy: 'Owner' });
      expect(repos.apiTokens.verify(secret)?.name).toBe('OBS');
      expect(await repos.secrets.scoped('app:youtube').getJson('values')).toEqual(youtubeApp);
    } finally {
      again.close();
    }
  });
});
