import type { AuditEntry } from '../../../shared/types.js';
import type { AuditRepo } from '../services.js';
import { int, nowIso, str, strOrNull, type Row, type Stmt } from './rows.js';

export const AUDIT_MAX_ROWS = 10_000;
const PRUNE_EVERY = 100; // inserts between prune passes
const MAX_LIMIT = 500;

function toEntry(row: Row): AuditEntry {
  return {
    id: int(row, 'id'),
    ts: str(row, 'ts'),
    userId: strOrNull(row, 'user_id'),
    username: strOrNull(row, 'username'),
    action: str(row, 'action'),
    detail: strOrNull(row, 'detail'),
    ip: strOrNull(row, 'ip'),
  };
}

const clip = (v: string | null | undefined, max: number): string | null => (v == null ? null : v.slice(0, max));

export function createAuditRepo(stmt: Stmt, maxRows = AUDIT_MAX_ROWS): AuditRepo & { prune(): void } {
  let inserts = 0;

  const prune = (): void => {
    // Keep the newest `maxRows` rows.
    stmt('DELETE FROM audit WHERE id <= (SELECT id FROM audit ORDER BY id DESC LIMIT 1 OFFSET ?)').run(maxRows);
  };

  return {
    log(entry) {
      stmt('INSERT INTO audit (ts, user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?, ?)').run(
        nowIso(),
        entry.userId,
        clip(entry.username, 64),
        clip(entry.action, 100) ?? '',
        clip(entry.detail, 2000),
        clip(entry.ip, 64),
      );
      if (++inserts % PRUNE_EVERY === 0) prune();
    },

    list({ limit, before }) {
      const n = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 100)));
      const rows =
        before !== undefined && Number.isFinite(before)
          ? stmt('SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?').all(Math.trunc(before), n)
          : stmt('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(n);
      return rows.map(toEntry);
    },

    prune,
  };
}
