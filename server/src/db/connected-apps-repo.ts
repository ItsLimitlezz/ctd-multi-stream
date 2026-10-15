// Registered external apps (the hub registry). Persisted so an app's resources (e.g. CTD Overlay's
// overlays per profile) survive a restart. Presence (`online`) is computed by the AppRegistry from
// lastSeenAt; this repo always returns `online: false`.

import type { AppResource, ConnectedApp } from '../../../shared/types.js';
import type { ConnectedAppsRepo } from '../services.js';
import { jsonArray, nowIso, str, strOrNull, type Row, type Stmt } from './rows.js';

const COLUMNS = 'id, name, kind, version, base_url, capabilities, resources, token_id, profile_id, registered_at, last_seen_at';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Keep well-formed resources only (a hand-edited or corrupt row must not crash readers). */
function toResources(values: unknown[]): AppResource[] {
  const out: AppResource[] = [];
  for (const v of values) {
    if (!isRecord(v) || typeof v.type !== 'string' || typeof v.id !== 'string' || typeof v.name !== 'string') continue;
    const r: AppResource = {
      type: v.type,
      id: v.id,
      name: v.name,
      profileId: typeof v.profileId === 'string' ? v.profileId : null,
    };
    if (typeof v.url === 'string') r.url = v.url;
    if (typeof v.width === 'number') r.width = v.width;
    if (typeof v.height === 'number') r.height = v.height;
    if (isRecord(v.meta)) r.meta = v.meta;
    out.push(r);
  }
  return out;
}

function toApp(row: Row): ConnectedApp {
  return {
    id: str(row, 'id'),
    name: str(row, 'name'),
    kind: str(row, 'kind'),
    version: strOrNull(row, 'version'),
    baseUrl: strOrNull(row, 'base_url'),
    capabilities: jsonArray(row, 'capabilities').filter((c): c is string => typeof c === 'string'),
    resources: toResources(jsonArray(row, 'resources')),
    tokenId: str(row, 'token_id'),
    profileId: strOrNull(row, 'profile_id'),
    registeredAt: str(row, 'registered_at'),
    lastSeenAt: str(row, 'last_seen_at'),
    online: false,
  };
}

export function createConnectedAppsRepo(stmt: Stmt): ConnectedAppsRepo {
  const get = (id: string): ConnectedApp | null => {
    const row = stmt(`SELECT ${COLUMNS} FROM connected_apps WHERE id = ?`).get(id);
    return row ? toApp(row) : null;
  };

  return {
    list() {
      return stmt(`SELECT ${COLUMNS} FROM connected_apps ORDER BY registered_at, rowid`).all().map(toApp);
    },

    get,

    upsert(app) {
      const now = nowIso();
      // An update keeps the original registration time unless the caller passes one.
      const registeredAt = app.registeredAt ?? get(app.id)?.registeredAt ?? now;
      stmt(
        `INSERT INTO connected_apps (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, kind = excluded.kind, version = excluded.version, base_url = excluded.base_url,
           capabilities = excluded.capabilities, resources = excluded.resources, token_id = excluded.token_id,
           profile_id = excluded.profile_id, registered_at = excluded.registered_at, last_seen_at = excluded.last_seen_at`,
      ).run(
        app.id,
        app.name,
        app.kind,
        app.version ?? null,
        app.baseUrl ?? null,
        JSON.stringify(app.capabilities ?? []),
        JSON.stringify(app.resources ?? []),
        app.tokenId,
        app.profileId ?? null,
        registeredAt,
        now,
      );
      const saved = get(app.id);
      if (!saved) throw new Error('Connected app upsert failed');
      return saved;
    },

    touch(id) {
      stmt('UPDATE connected_apps SET last_seen_at = ? WHERE id = ?').run(nowIso(), id);
    },

    delete(id) {
      stmt('DELETE FROM connected_apps WHERE id = ?').run(id);
    },

    deleteByToken(tokenId) {
      stmt('DELETE FROM connected_apps WHERE token_id = ?').run(tokenId);
    },
  };
}
