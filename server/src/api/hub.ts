// The hub (docs/API.md §9.2): connected apps register themselves and what they offer (overlays…),
// so other apps find them through CTD Multi-Stream. Registrations are persisted (ConnectedAppsRepo);
// presence (`online` = seen in the last 90 s) is tracked here, and 'apps-changed' is emitted when an
// app registers, changes, unregisters, or crosses online/offline.

import type { Logger } from 'pino';
import { z } from 'zod';
import type { ApiTokenInfo, AppResource, ConnectedApp } from '../../../shared/types.js';
import type { EventBus } from '../events.js';
import type { AppRegistry, Repos } from '../services.js';
import { ApiProblem } from './http.js';
import { CONTROL_RE, deepEqual, jsonBytes } from './json.js';
import type { ApiConnectedApp, ApiOverlay } from './types.js';

export const APP_ID_RE = /^[a-z0-9-]{1,40}$/;
export const APP_KIND_RE = /^[a-z0-9-]{1,40}$/;
export const RESOURCE_TYPE_RE = /^[a-z0-9-]{1,40}$/;
export const CAPABILITY_RE = /^[a-z0-9_.:-]{1,64}$/;
/** An app is online when it registered or sent a heartbeat this recently. */
export const ONLINE_WINDOW_MS = 90_000;
/** How often online/offline transitions are looked for. */
export const PRESENCE_CHECK_MS = 15_000;
export const MAX_RESOURCES = 200;
export const MAX_META_BYTES = 4096;
export const MAX_CAPABILITIES = 50;
/** Registered apps in total, and per token (each app id is one connection). */
export const MAX_APPS = 100;
export const MAX_APPS_PER_TOKEN = 20;
export const OVERLAY_TYPE = 'overlay';

/** What an app sends to register (PUT /apps/{id}); the registry adds token, profile and times. */
export type AppRegistration = Omit<ConnectedApp, 'tokenId' | 'profileId' | 'registeredAt' | 'lastSeenAt' | 'online'>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const noControls = (s: string) => !CONTROL_RE.test(s);

const label = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'required')
    .max(max, `at most ${max} characters`)
    .refine(noControls, 'control characters are not allowed');

const httpUrl = (max: number) => z.string().max(max, `at most ${max} characters`).refine(isHttpUrl, 'must be an http:// or https:// URL');
const dimension = z.number().int().min(1).max(16384);

const ResourceSchema = z.object({
  type: z.string().regex(RESOURCE_TYPE_RE, '[a-z0-9-], at most 40 characters'),
  id: z.string().min(1, 'required').max(100, 'at most 100 characters').refine(noControls, 'control characters are not allowed'),
  name: label(120),
  profileId: z.string().min(1).max(64).nullable().optional(),
  url: httpUrl(2048).optional(),
  width: dimension.optional(),
  height: dimension.optional(),
  meta: z
    .record(z.string(), z.unknown())
    .refine((m) => !Array.isArray(m), 'must be an object')
    .refine((m) => jsonBytes(m) <= MAX_META_BYTES, `at most ${MAX_META_BYTES} bytes of JSON`)
    .optional(),
});

const RegistrationSchema = z.object({
  name: label(80),
  kind: z.string().regex(APP_KIND_RE, '[a-z0-9-], at most 40 characters'),
  version: z.string().trim().max(40, 'at most 40 characters').refine(noControls, 'control characters are not allowed').nullable().optional(),
  baseUrl: httpUrl(500).nullable().optional(),
  capabilities: z.array(z.string().regex(CAPABILITY_RE, '[a-z0-9_.:-], at most 64 characters')).max(MAX_CAPABILITIES, `at most ${MAX_CAPABILITIES}`).optional(),
  resources: z.array(ResourceSchema).max(MAX_RESOURCES, `at most ${MAX_RESOURCES} resources`).optional(),
});

/** zod issues as one readable line. */
export function issuesText(error: z.ZodError): string {
  const text = error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
  return text.length > 500 ? `${text.slice(0, 497)}…` : text;
}

/** Validate a registration (shape, limits, overlay URLs, unique resource ids). Throws a 400 ApiProblem. */
export function parseAppRegistration(id: unknown, body: unknown): AppRegistration {
  if (typeof id !== 'string' || !APP_ID_RE.test(id)) {
    throw new ApiProblem(400, 'invalid', 'App id: [a-z0-9-], 1 to 40 characters (e.g. ctd-overlay, ctd-obs-plugin-studio-pc)');
  }
  const parsed = RegistrationSchema.safeParse(body ?? {});
  if (!parsed.success) throw new ApiProblem(400, 'invalid', issuesText(parsed.error));
  const b = parsed.data;
  const seen = new Set<string>();
  const resources: AppResource[] = [];
  for (const [i, r] of (b.resources ?? []).entries()) {
    if (seen.has(r.id)) throw new ApiProblem(400, 'invalid', `resources.${i}.id: "${r.id}" is used twice (ids are unique within the app)`);
    seen.add(r.id);
    if (r.type === OVERLAY_TYPE && r.url === undefined) throw new ApiProblem(400, 'invalid', `resources.${i}.url: required for overlays (the browser-source URL)`);
    const out: AppResource = { type: r.type, id: r.id, name: r.name, profileId: r.profileId ?? null };
    if (r.url !== undefined) out.url = r.url;
    if (r.width !== undefined) out.width = r.width;
    if (r.height !== undefined) out.height = r.height;
    if (r.meta !== undefined) out.meta = r.meta;
    resources.push(out);
  }
  return {
    id,
    name: b.name,
    kind: b.kind,
    version: b.version ? b.version : null,
    baseUrl: b.baseUrl ?? null,
    capabilities: [...new Set(b.capabilities ?? [])],
    resources,
  };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** What other apps see of an app: everything but the registering token's id. */
export function publicApp(app: ConnectedApp): ApiConnectedApp {
  return {
    id: app.id,
    name: app.name,
    kind: app.kind,
    version: app.version,
    baseUrl: app.baseUrl,
    capabilities: [...app.capabilities],
    resources: app.resources.map((r) => ({ ...r })),
    profileId: app.profileId,
    registeredAt: app.registeredAt,
    lastSeenAt: app.lastSeenAt,
    online: app.online,
  };
}

/**
 * The apps as seen from one profile: apps connected for that profile or for every profile (apps
 * limited to another profile are left out), each with only the resources assigned to that profile
 * or unassigned. `profileId` null = no filter.
 */
export function appsForProfile<T extends Pick<ConnectedApp, 'profileId' | 'resources'>>(apps: readonly T[], profileId: string | null | undefined): T[] {
  if (profileId === null || profileId === undefined) return [...apps];
  return apps
    .filter((a) => a.profileId === null || a.profileId === profileId)
    .map((a) => ({ ...a, resources: a.resources.filter((r) => r.profileId === null || r.profileId === profileId) }));
}

/** Every overlay assigned to `profileId`, from every app (GET /profiles/{id}/overlays). */
export function overlaysFor(apps: readonly Pick<ConnectedApp, 'id' | 'name' | 'online' | 'resources'>[], profileId: string): ApiOverlay[] {
  const out: ApiOverlay[] = [];
  for (const app of apps) {
    for (const r of app.resources) {
      if (r.type !== OVERLAY_TYPE || r.profileId !== profileId) continue;
      const item: ApiOverlay = { appId: app.id, appName: app.name, appOnline: app.online, id: r.id, name: r.name };
      if (r.url !== undefined) item.url = r.url;
      if (r.width !== undefined) item.width = r.width;
      if (r.height !== undefined) item.height = r.height;
      if (r.meta !== undefined) item.meta = r.meta;
      out.push(item);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface AppRegistryDeps {
  repos: Pick<Repos, 'connectedApps' | 'profiles'>;
  bus: EventBus;
  log: Pick<Logger, 'info' | 'warn'>;
  now?: () => number;
  presenceCheckMs?: number;
}

export interface AppRegistryHandle extends AppRegistry {
  /** Look for online/offline transitions now (also runs every PRESENCE_CHECK_MS). */
  checkPresence(): void;
  /** Stop the presence timer. */
  close(): void;
}

function sameContent(a: ConnectedApp, b: ConnectedApp): boolean {
  const pick = (x: ConnectedApp) => [x.name, x.kind, x.version, x.baseUrl, x.capabilities, x.resources, x.profileId];
  return deepEqual(pick(a), pick(b));
}

export function createAppRegistry(deps: AppRegistryDeps): AppRegistryHandle {
  const { repos, bus, log } = deps;
  const now = deps.now ?? Date.now;
  /** Last register/heartbeat per app (epoch ms). Seeded from the repo, so presence survives restarts. */
  const lastSeen = new Map<string, number>();
  /** The online flag the last 'apps-changed' reflected. */
  const shownOnline = new Map<string, boolean>();

  const isOnline = (id: string) => now() - (lastSeen.get(id) ?? Number.NEGATIVE_INFINITY) <= ONLINE_WINDOW_MS;

  const withPresence = (app: ConnectedApp): ConnectedApp => {
    const seen = lastSeen.get(app.id);
    return { ...app, lastSeenAt: seen !== undefined ? new Date(seen).toISOString() : app.lastSeenAt, online: isOnline(app.id) };
  };

  const changed = () => bus.emit('apps-changed');

  const forget = (id: string) => {
    lastSeen.delete(id);
    shownOnline.delete(id);
  };

  try {
    for (const app of repos.connectedApps.list()) {
      const t = Date.parse(app.lastSeenAt);
      lastSeen.set(app.id, Number.isFinite(t) ? t : 0);
      shownOnline.set(app.id, isOnline(app.id));
    }
  } catch (err) {
    log.warn({ error: (err as Error).message }, 'hub: reading the connected apps failed');
  }

  const owned = (token: ApiTokenInfo, id: string): ConnectedApp => {
    const app = repos.connectedApps.get(id);
    if (!app) throw new ApiProblem(404, 'not_found', `No app is registered as "${id}". Register it with PUT /api/v1/apps/${id}.`);
    if (app.tokenId !== token.id) throw new ApiProblem(409, 'app_owned', `"${id}" was registered by another token; pick another app id.`);
    return app;
  };

  const checkPresence = () => {
    let any = false;
    for (const id of lastSeen.keys()) {
      const online = isOnline(id);
      if (shownOnline.get(id) !== online) {
        shownOnline.set(id, online);
        any = true;
      }
    }
    if (any) changed();
  };

  const timer = setInterval(() => {
    try {
      checkPresence();
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'hub: presence check failed');
    }
  }, deps.presenceCheckMs ?? PRESENCE_CHECK_MS);
  timer.unref?.();

  return {
    list(profileId) {
      return appsForProfile(repos.connectedApps.list().map(withPresence), profileId);
    },

    get(id) {
      const app = repos.connectedApps.get(id);
      return app ? withPresence(app) : null;
    },

    register(token, input) {
      const parsed = parseAppRegistration(input.id, input);
      const tokenProfile = token.profileId ?? null;
      let known: Set<string> | null = null;
      const dropped: string[] = [];
      for (const r of parsed.resources) {
        if (r.profileId === null) continue;
        if (tokenProfile !== null && r.profileId !== tokenProfile) {
          throw new ApiProblem(
            403,
            'profile_forbidden',
            `This token is limited to profile "${tokenProfile}": resource "${r.id}" can only be assigned to it or to null.`,
          );
        }
        known ??= new Set(repos.profiles.list().map((p) => p.id));
        if (!known.has(r.profileId)) dropped.push(r.id);
      }
      // A resource assigned to a profile that doesn't exist (typically one deleted since the app last
      // looked) is left out rather than refusing the whole registration, which is also the app's
      // heartbeat. The response lists what was kept.
      const reg: AppRegistration =
        dropped.length === 0 ? parsed : { ...parsed, resources: parsed.resources.filter((r) => r.profileId === null || known?.has(r.profileId) === true) };
      if (dropped.length > 0) log.info({ appId: reg.id, resources: dropped.length }, 'hub: resources for unknown profiles left out');

      const existing = repos.connectedApps.get(reg.id);
      if (existing && existing.tokenId !== token.id) {
        throw new ApiProblem(409, 'app_owned', `"${reg.id}" was registered by another token; pick another app id.`);
      }
      if (!existing) {
        const all = repos.connectedApps.list();
        if (all.length >= MAX_APPS) throw new ApiProblem(409, 'limit', `At most ${MAX_APPS} apps can be registered; remove unused ones in Settings → API.`);
        if (all.filter((a) => a.tokenId === token.id).length >= MAX_APPS_PER_TOKEN) {
          throw new ApiProblem(409, 'limit', `At most ${MAX_APPS_PER_TOKEN} apps per token.`);
        }
      }

      const saved = repos.connectedApps.upsert({
        ...reg,
        tokenId: token.id,
        profileId: tokenProfile,
        ...(existing ? { registeredAt: existing.registeredAt } : {}),
      });
      lastSeen.set(saved.id, now());
      const wasOnline = shownOnline.get(saved.id) === true;
      shownOnline.set(saved.id, true);
      if (!existing) log.info({ appId: saved.id, kind: saved.kind, tokenId: token.id }, 'hub: app registered');
      if (!existing || !wasOnline || !sameContent(existing, saved)) changed();
      return withPresence(saved);
    },

    heartbeat(token, id) {
      const app = owned(token, id);
      repos.connectedApps.touch(id);
      lastSeen.set(id, now());
      if (shownOnline.get(id) !== true) {
        shownOnline.set(id, true);
        changed();
      }
      return withPresence(repos.connectedApps.get(id) ?? app);
    },

    remove(id) {
      if (!repos.connectedApps.get(id)) return;
      repos.connectedApps.delete(id);
      forget(id);
      log.info({ appId: id }, 'hub: app removed');
      changed();
    },

    removeByToken(tokenId) {
      const gone = repos.connectedApps.list().filter((a) => a.tokenId === tokenId);
      repos.connectedApps.deleteByToken(tokenId);
      if (gone.length === 0) return;
      for (const a of gone) forget(a.id);
      log.info({ tokenId, apps: gone.length }, 'hub: apps of a revoked token removed');
      changed();
    },

    checkPresence,

    close() {
      clearInterval(timer);
    },
  };
}
