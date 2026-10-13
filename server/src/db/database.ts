// SQLite via node:sqlite (synchronous). Schema migrations are keyed by PRAGMA user_version.
// API: https://nodejs.org/docs/latest-v24.x/api/sqlite.html

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

/** Each entry migrates from user_version = index to index + 1. Append only; never edit a shipped step. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE users (
    id                  TEXT PRIMARY KEY,
    username            TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash       TEXT NOT NULL,
    role                TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
    totp_secret         TEXT,
    totp_pending_secret TEXT,
    totp_enabled        INTEGER NOT NULL DEFAULT 0,
    failed_logins       INTEGER NOT NULL DEFAULT 0,
    locked_until        TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    last_login_at       TEXT
  );

  CREATE TABLE auth_sessions (
    id           TEXT PRIMARY KEY, -- sha256 hex of the raw cookie token
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token   TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    ip           TEXT,
    user_agent   TEXT
  );
  CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
  CREATE INDEX auth_sessions_expires ON auth_sessions(expires_at);

  CREATE TABLE accounts (
    id             TEXT PRIMARY KEY,
    platform       TEXT NOT NULL,
    label          TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending',
    status_message TEXT,
    options        TEXT NOT NULL DEFAULT '{}',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE TABLE destinations (
    id             TEXT PRIMARY KEY,
    platform       TEXT NOT NULL,
    account_id     TEXT, -- no FK: DestinationsRepo.detachAccount clears it
    name           TEXT NOT NULL,
    feed           TEXT NOT NULL,
    enabled        INTEGER NOT NULL DEFAULT 1,
    options        TEXT NOT NULL DEFAULT '{}',
    ingest_url     TEXT,
    has_stream_key INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE INDEX destinations_account ON destinations(account_id);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL -- JSON
  );

  CREATE TABLE secrets (
    scope      TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL, -- SecretBox ciphertext
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope, key)
  );

  CREATE TABLE audit (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    user_id  TEXT,
    username TEXT,
    action   TEXT NOT NULL,
    detail   TEXT,
    ip       TEXT
  );
  `,
];

/** Run `fn` inside a transaction (BEGIN IMMEDIATE), rolling back on error. Not reentrant. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row?.user_version ?? 0);
}

export function migrate(db: Db, migrations: readonly string[] = MIGRATIONS): void {
  const from = schemaVersion(db);
  if (from > migrations.length) {
    throw new Error(`Database schema v${from} is newer than this app supports (v${migrations.length}); upgrade the app`);
  }
  for (let v = from; v < migrations.length; v++) {
    transaction(db, () => {
      db.exec(migrations[v] ?? '');
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** Open (or create) the database, apply pragmas and migrations. Accepts ':memory:' for tests. */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file, { timeout: 5000, enableForeignKeyConstraints: true });
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL'); // safe with WAL
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
