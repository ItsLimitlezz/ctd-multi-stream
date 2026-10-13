// JSON settings and encrypted secrets (key/value tables).

import type { ScopedSecrets, SecretBox, SecretsRepo, SettingsRepo } from '../services.js';
import { nowIso, type Stmt } from './rows.js';

export function createSettingsRepo(stmt: Stmt): SettingsRepo {
  const remove = (key: string) => stmt('DELETE FROM settings WHERE key = ?').run(key);

  return {
    get<T>(key: string, fallback: T): T {
      const row = stmt('SELECT value FROM settings WHERE key = ?').get(key);
      if (!row || typeof row.value !== 'string') return fallback;
      try {
        return JSON.parse(row.value) as T;
      } catch {
        return fallback;
      }
    },

    set(key, value) {
      const json = JSON.stringify(value);
      if (json === undefined) {
        remove(key); // undefined / functions have no JSON form
        return;
      }
      stmt('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
        key,
        json,
      );
    },

    delete(key) {
      remove(key);
    },
  };
}

export function createSecretsRepo(stmt: Stmt, box: SecretBox): SecretsRepo {
  const read = (scope: string, key: string): string | null => {
    const row = stmt('SELECT value FROM secrets WHERE scope = ? AND key = ?').get(scope, key);
    if (!row || typeof row.value !== 'string') return null;
    try {
      return box.decrypt(row.value);
    } catch {
      // Never include the value; scope/key names are not secret.
      throw new Error(`Cannot decrypt secret ${scope}/${key}: data was tampered with or the master key changed`);
    }
  };

  const write = (scope: string, key: string, value: string): void => {
    stmt(
      `INSERT INTO secrets (scope, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(scope, key, box.encrypt(value), nowIso());
  };

  const remove = (scope: string, key: string): void => {
    stmt('DELETE FROM secrets WHERE scope = ? AND key = ?').run(scope, key);
  };

  // One object per scope, so callers can key per-scope state (e.g. in-flight token refreshes) on identity.
  const scopes = new Map<string, ScopedSecrets>();

  return {
    scoped(scope): ScopedSecrets {
      const cached = scopes.get(scope);
      if (cached) return cached;
      const scoped: ScopedSecrets = {
        async get(key) {
          return read(scope, key);
        },
        async set(key, value) {
          write(scope, key, value);
        },
        async delete(key) {
          remove(scope, key);
        },
        async getJson<T>(key: string): Promise<T | null> {
          const raw = read(scope, key);
          if (raw === null) return null;
          try {
            return JSON.parse(raw) as T;
          } catch {
            throw new Error(`Secret ${scope}/${key} is not valid JSON`);
          }
        },
        async setJson(key, value) {
          const json = JSON.stringify(value);
          if (json === undefined) remove(scope, key);
          else write(scope, key, json);
        },
      };
      scopes.set(scope, scoped);
      return scoped;
    },

    deleteScope(scope) {
      stmt('DELETE FROM secrets WHERE scope = ?').run(scope);
    },
  };
}
