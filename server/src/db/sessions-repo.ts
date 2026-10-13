import crypto from 'node:crypto';
import type { AuthSessionRecord, AuthSessionsRepo } from '../services.js';
import { str, strOrNull, type Row, type Stmt } from './rows.js';

export const SESSION_IDLE_MS = 30 * 24 * 3600_000; // sliding expiry
export const SESSION_MAX_MS = 90 * 24 * 3600_000; // absolute lifetime from createdAt
const TOUCH_INTERVAL_MS = 60_000; // write lastSeenAt at most once per minute
const MAX_TOKEN_LENGTH = 128;

const COLUMNS = 'id, user_id, csrf_token, created_at, last_seen_at, expires_at, ip, user_agent';

/** Sessions are stored by sha256(token) so a database leak doesn't hand out live cookies. */
export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function toRecord(row: Row): AuthSessionRecord {
  return {
    id: str(row, 'id'),
    userId: str(row, 'user_id'),
    csrfToken: str(row, 'csrf_token'),
    createdAt: str(row, 'created_at'),
    lastSeenAt: str(row, 'last_seen_at'),
    expiresAt: str(row, 'expires_at'),
    ip: strOrNull(row, 'ip'),
    userAgent: strOrNull(row, 'user_agent'),
  };
}

function expiryFrom(createdAtMs: number, nowMs: number): string {
  return new Date(Math.min(nowMs + SESSION_IDLE_MS, createdAtMs + SESSION_MAX_MS)).toISOString();
}

function clip(v: string | null, max: number): string | null {
  return v === null ? null : v.slice(0, max);
}

export function createSessionsRepo(stmt: Stmt): AuthSessionsRepo {
  const remove = (id: string) => stmt('DELETE FROM auth_sessions WHERE id = ?').run(id);

  /** Valid session for a raw token, or null (expired sessions are deleted). Never slides the expiry. */
  const lookup = (token: string): AuthSessionRecord | null => {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
    const id = hashSessionToken(token);
    const row = stmt(`SELECT ${COLUMNS} FROM auth_sessions WHERE id = ?`).get(id);
    if (!row) return null;
    const record = toRecord(row);
    const now = Date.now();
    if (!(Date.parse(record.expiresAt) > now) || !(Date.parse(record.createdAt) + SESSION_MAX_MS > now)) {
      remove(id);
      return null;
    }
    return record;
  };

  return {
    create(userId, meta) {
      const token = randomToken();
      const now = Date.now();
      const record: AuthSessionRecord = {
        id: hashSessionToken(token),
        userId,
        csrfToken: randomToken(),
        createdAt: new Date(now).toISOString(),
        lastSeenAt: new Date(now).toISOString(),
        expiresAt: expiryFrom(now, now),
        ip: clip(meta.ip, 64),
        userAgent: clip(meta.userAgent, 512),
      };
      stmt(`INSERT INTO auth_sessions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        record.id,
        record.userId,
        record.csrfToken,
        record.createdAt,
        record.lastSeenAt,
        record.expiresAt,
        record.ip,
        record.userAgent,
      );
      return { record, token };
    },

    peek(token) {
      return lookup(token);
    },

    touch(token) {
      const record = lookup(token);
      if (!record) return null;
      const id = record.id;
      const now = Date.now();
      const createdAt = Date.parse(record.createdAt);
      if (now - Date.parse(record.lastSeenAt) >= TOUCH_INTERVAL_MS) {
        record.lastSeenAt = new Date(now).toISOString();
        record.expiresAt = expiryFrom(createdAt, now);
        stmt('UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(
          record.lastSeenAt,
          record.expiresAt,
          id,
        );
      }
      return record;
    },

    delete(token) {
      remove(hashSessionToken(token));
    },

    deleteForUser(userId, exceptToken) {
      if (exceptToken) {
        stmt('DELETE FROM auth_sessions WHERE user_id = ? AND id <> ?').run(userId, hashSessionToken(exceptToken));
      } else {
        stmt('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
      }
    },

    purgeExpired() {
      // expires_at is always capped at createdAt + 90 days, so one comparison covers both limits.
      stmt('DELETE FROM auth_sessions WHERE expires_at <= ?').run(new Date().toISOString());
    },
  };
}
