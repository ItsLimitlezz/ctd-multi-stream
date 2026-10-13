import crypto from 'node:crypto';
import type { Role, User } from '../../../shared/types.js';
import type { UserRecord, UsersRepo } from '../services.js';
import {
  ConflictError,
  NotFoundError,
  bool,
  int,
  isUniqueViolation,
  nowIso,
  str,
  strOrNull,
  updateById,
  type Row,
  type Stmt,
} from './rows.js';

const COLUMNS =
  'id, username, password_hash, role, totp_secret, totp_pending_secret, totp_enabled, failed_logins, locked_until, created_at, last_login_at';

function toRecord(row: Row): UserRecord {
  return {
    id: str(row, 'id'),
    username: str(row, 'username'),
    role: str(row, 'role') as Role,
    totpEnabled: bool(row, 'totp_enabled'),
    createdAt: str(row, 'created_at'),
    lastLoginAt: strOrNull(row, 'last_login_at'),
    passwordHash: str(row, 'password_hash'),
    totpSecret: strOrNull(row, 'totp_secret'),
    totpPendingSecret: strOrNull(row, 'totp_pending_secret'),
    failedLogins: int(row, 'failed_logins'),
    lockedUntil: strOrNull(row, 'locked_until'),
  };
}

/** Strip credentials: the shape that may leave the server. */
export function publicUser(u: User): User {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    totpEnabled: u.totpEnabled,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}

export function createUsersRepo(stmt: Stmt): UsersRepo {
  const get = (id: string): UserRecord | null => {
    const row = stmt(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(id);
    return row ? toRecord(row) : null;
  };

  return {
    count() {
      return int(stmt('SELECT COUNT(*) AS n FROM users').get() ?? { n: 0 }, 'n');
    },

    list() {
      return stmt(`SELECT ${COLUMNS} FROM users ORDER BY created_at, rowid`)
        .all()
        .map((r) => publicUser(toRecord(r)));
    },

    get,

    getByUsername(username) {
      // username is declared COLLATE NOCASE, so this lookup is case-insensitive.
      const row = stmt(`SELECT ${COLUMNS} FROM users WHERE username = ?`).get(username);
      return row ? toRecord(row) : null;
    },

    create({ username, passwordHash, role }) {
      const id = crypto.randomUUID();
      const now = nowIso();
      try {
        stmt(
          'INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(id, username, passwordHash, role, now, now);
      } catch (err) {
        if (isUniqueViolation(err)) throw new ConflictError('Username already exists');
        throw err;
      }
      const created = get(id);
      if (!created) throw new Error('User insert failed');
      return publicUser(created);
    },

    update(id, patch) {
      const changes = updateById(stmt, 'users', id, {
        role: patch.role,
        password_hash: patch.passwordHash,
        totp_secret: patch.totpSecret,
        totp_pending_secret: patch.totpPendingSecret,
        totp_enabled: patch.totpEnabled === undefined ? undefined : patch.totpEnabled ? 1 : 0,
        failed_logins: patch.failedLogins,
        locked_until: patch.lockedUntil,
        last_login_at: patch.lastLoginAt,
      });
      if (changes === 0) throw new NotFoundError('User not found');
      const updated = get(id);
      if (!updated) throw new NotFoundError('User not found');
      return publicUser(updated);
    },

    delete(id) {
      // auth_sessions rows go with it (ON DELETE CASCADE).
      stmt('DELETE FROM users WHERE id = ?').run(id);
    },
  };
}
