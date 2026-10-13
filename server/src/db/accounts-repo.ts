import crypto from 'node:crypto';
import type { Account, AccountStatus, PlatformId } from '../../../shared/types.js';
import type { AccountsRepo } from '../services.js';
import { NotFoundError, jsonObject, nowIso, str, strOrNull, updateById, type Row, type Stmt } from './rows.js';

const COLUMNS = 'id, platform, label, status, status_message, options, created_at, updated_at';

function toAccount(row: Row): Account {
  return {
    id: str(row, 'id'),
    platform: str(row, 'platform') as PlatformId,
    label: str(row, 'label'),
    status: str(row, 'status') as AccountStatus,
    statusMessage: strOrNull(row, 'status_message'),
    options: jsonObject(row, 'options'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

export function createAccountsRepo(stmt: Stmt): AccountsRepo {
  const get = (id: string): Account | null => {
    const row = stmt(`SELECT ${COLUMNS} FROM accounts WHERE id = ?`).get(id);
    return row ? toAccount(row) : null;
  };

  return {
    list() {
      return stmt(`SELECT ${COLUMNS} FROM accounts ORDER BY created_at, rowid`).all().map(toAccount);
    },

    get,

    create({ platform, label, options }) {
      const id = crypto.randomUUID();
      const now = nowIso();
      stmt(
        `INSERT INTO accounts (id, platform, label, status, status_message, options, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', NULL, ?, ?, ?)`,
      ).run(id, platform, label, JSON.stringify(options ?? {}), now, now);
      const created = get(id);
      if (!created) throw new Error('Account insert failed');
      return created;
    },

    update(id, patch) {
      const changes = updateById(stmt, 'accounts', id, {
        label: patch.label,
        status: patch.status,
        status_message: patch.statusMessage,
        options: patch.options === undefined ? undefined : JSON.stringify(patch.options),
      });
      const updated = changes > 0 ? get(id) : null;
      if (!updated) throw new NotFoundError('Account not found');
      return updated;
    },

    delete(id) {
      stmt('DELETE FROM accounts WHERE id = ?').run(id);
    },
  };
}
