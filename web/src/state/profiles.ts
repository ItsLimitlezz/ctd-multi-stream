// Profiles in the web UI: which profile is current (URL `?profile=` with the last one used as the
// default) and small pure helpers for the switcher, headers and the profiles page. React bindings
// live in profile.tsx.

import type { Profile, ProfileSummary } from '@shared/types';
import { DEFAULT_PROFILE_ID } from '@shared/types';
import { plural } from '../components/format';

/** Query parameter that carries the current profile (kept on every in-app link, see router.tsx). */
export const PROFILE_QUERY = 'profile';
/** localStorage key of the last profile used: the default for links and tabs without `?profile=`. */
export const PROFILE_STORAGE_KEY = 'ctd.profile';
/** Same limits as the server (routes/profiles.ts). */
export const PROFILE_NAME_MAX = 60;

/** Accent colours offered when creating a profile (any #RRGGBB works). */
export const PROFILE_COLORS: readonly { value: string; label: string }[] = [
  { value: '#3B82F6', label: 'Blue' },
  { value: '#E11D48', label: 'Rose' },
  { value: '#10B981', label: 'Green' },
  { value: '#F59E0B', label: 'Amber' },
  { value: '#8B5CF6', label: 'Violet' },
  { value: '#06B6D4', label: 'Cyan' },
  { value: '#F97316', label: 'Orange' },
  { value: '#EC4899', label: 'Pink' },
];

// Server ids are UUID-like (or 'default'); anything else from a URL or storage is ignored.
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isProfileIdLike(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v);
}

// ---------------------------------------------------------------------------
// Remembered profile (per browser)
// ---------------------------------------------------------------------------

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // blocked storage throws on access
  }
}

/** The last profile used in this browser, or null (nothing stored, blocked storage, junk). */
export function readStoredProfile(storage: StorageLike | null = browserStorage()): string | null {
  try {
    const v = storage?.getItem(PROFILE_STORAGE_KEY) ?? null;
    return isProfileIdLike(v) ? v : null;
  } catch {
    return null;
  }
}

/** Remember the profile for new tabs and links without `?profile=` (best effort). */
export function storeProfile(id: string, storage: StorageLike | null = browserStorage()): void {
  if (!isProfileIdLike(id)) return;
  try {
    storage?.setItem(PROFILE_STORAGE_KEY, id);
  } catch {
    /* blocked storage: the profile just isn't remembered */
  }
}

// ---------------------------------------------------------------------------
// Current profile
// ---------------------------------------------------------------------------

export interface ResolveProfileInput {
  /** `?profile=` from the URL. */
  requested: string | null | undefined;
  /** The remembered profile. */
  stored: string | null | undefined;
  /** Every profile, or null while the list is unknown (not loaded yet / failed). */
  profiles: readonly Pick<Profile, 'id'>[] | null;
}

/**
 * The profile to show: the URL's when it exists, else the remembered one, else the default profile.
 * While the list is unknown the first well-formed candidate is trusted (the server rejects unknown ids).
 */
export function resolveProfileId({ requested, stored, profiles }: ResolveProfileInput): string {
  const candidates = [requested, stored].filter(isProfileIdLike);
  if (!profiles) return candidates[0] ?? DEFAULT_PROFILE_ID;
  const known = new Set(profiles.map((p) => p.id));
  for (const c of candidates) if (known.has(c)) return c;
  if (profiles.length === 0 || known.has(DEFAULT_PROFILE_ID)) return DEFAULT_PROFILE_ID;
  return (profiles[0] as Pick<Profile, 'id'>).id;
}

/**
 * What `?profile=` should say: the current profile, so links and tabs are stable — except on an
 * install with only the default profile, where there is nothing to choose (no parameter).
 */
export function profileQueryValue(profileId: string, profiles: readonly Pick<Profile, 'id'>[]): string | null {
  return profiles.length > 1 || profileId !== DEFAULT_PROFILE_ID ? profileId : null;
}

/** Add `profile=<id>` to a same-origin API path (no id = the server's default profile). */
export function withProfileQuery(path: string, profileId: string | null | undefined): string {
  if (!profileId) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}${PROFILE_QUERY}=${encodeURIComponent(profileId)}`;
}

/** Set (or replace) `profile=<id>` in an app path such as "/chat?x=1#y". */
export function pathWithProfile(path: string, profileId: string): string {
  const hashAt = path.indexOf('#');
  const hash = hashAt === -1 ? '' : path.slice(hashAt);
  const beforeHash = hashAt === -1 ? path : path.slice(0, hashAt);
  const qAt = beforeHash.indexOf('?');
  const pathname = qAt === -1 ? beforeHash : beforeHash.slice(0, qAt);
  const sp = new URLSearchParams(qAt === -1 ? '' : beforeHash.slice(qAt + 1));
  sp.set(PROFILE_QUERY, profileId);
  return `${pathname}?${sp.toString()}${hash}`;
}

/** Default profile first, the rest in the server's order (creation order). */
export function sortProfiles<T extends Pick<Profile, 'id'>>(profiles: readonly T[]): T[] {
  const def = profiles.filter((p) => p.id === DEFAULT_PROFILE_ID);
  return def.concat(profiles.filter((p) => p.id !== DEFAULT_PROFILE_ID));
}

export function findProfile<T extends Pick<Profile, 'id'>>(profiles: readonly T[] | null | undefined, id: string | null | undefined): T | null {
  if (!profiles || !id) return null;
  return profiles.find((p) => p.id === id) ?? null;
}

/** Name of a profile id for lists (null = every profile; a removed profile says so). */
export function profileLabel(profileId: string | null, profiles: readonly Pick<Profile, 'id' | 'name'>[] | null | undefined): string {
  if (profileId === null) return 'Every profile';
  const p = findProfile(profiles, profileId);
  if (p) return p.name;
  if (profileId === DEFAULT_PROFILE_ID) return 'Main';
  return profiles ? 'Deleted profile' : 'Profile';
}

// ---------------------------------------------------------------------------
// Live situation
// ---------------------------------------------------------------------------

export function liveProfiles<T extends Pick<ProfileSummary, 'status'>>(profiles: readonly T[] | null | undefined): T[] {
  return (profiles ?? []).filter((p) => p.status === 'live');
}

/** "DPRTMNT is live" / "2 live: Miami or Bust · DPRTMNT" ('' when nothing is live). */
export function liveProfilesText(profiles: readonly Pick<ProfileSummary, 'status' | 'name'>[] | null | undefined): string {
  const live = liveProfiles(profiles);
  if (live.length === 0) return '';
  if (live.length === 1) return `${(live[0] as Pick<ProfileSummary, 'name'>).name} is live`;
  return `${live.length} live: ${live.map((p) => p.name).join(' · ')}`;
}

/**
 * Show the "who is live" pill in the header: several profiles are live, or one that isn't the
 * profile on screen (so a live club night is never hidden behind the personal profile).
 */
export function showLiveSummary(profiles: readonly Pick<ProfileSummary, 'id' | 'status'>[] | null | undefined, currentId: string): boolean {
  const live = liveProfiles(profiles);
  return live.length >= 2 || (live.length === 1 && (live[0] as Pick<ProfileSummary, 'id'>).id !== currentId);
}

/** Another profile than the current one is live (a dot on the switcher). */
export function otherProfileLive(profiles: readonly Pick<ProfileSummary, 'id' | 'status'>[] | null | undefined, currentId: string): boolean {
  return liveProfiles(profiles).some((p) => p.id !== currentId);
}

export interface ProfileAlert {
  profileId: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  /** Also sound / notify / speak (opt-in alerts); false = a toast only. */
  alert: boolean;
}

type AlertSummary = Pick<ProfileSummary, 'id' | 'name' | 'status' | 'down'>;

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * Alerts for profiles other than the one on screen, from two successive 'profiles' pushes. The live
 * socket only carries the current profile's notices (Stream Guard's "Instagram ended the live…"),
 * so without this a destination failing on another live profile would go unnoticed.
 *
 * - more destinations down than before, while that profile streams → warn (sound when alerts are on);
 * - every destination back up → info;
 * - the profile stopped being live without passing through 'stopping' (not a normal stop) → info toast.
 *
 * Profiles new in `next` (no previous summary) are only a baseline. `prev` null (first list after
 * connecting, reconnect or profile switch) → nothing.
 */
export function profileAlerts(
  prev: readonly AlertSummary[] | null | undefined,
  next: readonly AlertSummary[] | null | undefined,
  currentId: string,
): ProfileAlert[] {
  if (!prev || !next) return [];
  const before = new Map(prev.map((p) => [p.id, p]));
  const out: ProfileAlert[] = [];
  for (const p of next) {
    if (p.id === currentId) continue;
    const was = before.get(p.id);
    if (!was) continue;
    const name = p.name || 'Another profile';
    const down = count(p.down);
    const wasDown = count(was.down);
    const streaming = p.status === 'live' || p.status === 'starting';
    if (streaming && down > wasDown) {
      out.push({
        profileId: p.id,
        level: 'warn',
        message: `${name} · ${plural(down, 'destination')} down. Switch to ${name} to see which.`,
        alert: true,
      });
    } else if (streaming && wasDown > 0 && down === 0) {
      out.push({ profileId: p.id, level: 'info', message: `${name} · every destination is live again.`, alert: true });
    }
    if (was.status === 'live' && p.status === 'offline') {
      out.push({ profileId: p.id, level: 'info', message: `${name} is no longer live.`, alert: false });
    }
  }
  return out;
}

/** "4 destinations enabled" / "3 destinations enabled · 2 live · 1 down" (live counts while a session runs). */
export function profileCountsText(p: Pick<ProfileSummary, 'status' | 'destinations' | 'live' | 'down'>): string {
  const n = Number.isFinite(p.destinations) ? p.destinations : 0;
  const parts = [n === 0 ? 'No destinations enabled' : `${plural(n, 'destination')} enabled`];
  if (p.status !== 'offline') {
    parts.push(`${p.live} live`);
    if (p.down > 0) parts.push(`${p.down} down`);
  }
  return parts.join(' · ');
}

/** Why a profile can't be deleted right now (null = it can). */
export function deleteBlockedReason(p: Pick<ProfileSummary, 'id' | 'status'>): string | null {
  if (p.id === DEFAULT_PROFILE_ID) return "The default profile can't be deleted: it keeps your original OBS stream keys.";
  if (p.status !== 'offline') return 'End this profile’s stream before deleting it.';
  return null;
}

/** How this profile's OBS stream keys start (the default profile keeps the pre-profiles keys). */
export function obsKeyHint(p: Pick<Profile, 'id' | 'slug'>): string {
  return p.id === DEFAULT_PROFILE_ID ? 'landscape?key=…' : `${p.slug}/landscape?key=…`;
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

// C0/C1 controls and bidi overrides (the server rejects them too).
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/;

export function validateProfileName(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Give the profile a name, e.g. DPRTMNT.';
  if (n.length > PROFILE_NAME_MAX) return `Use at most ${PROFILE_NAME_MAX} characters.`;
  if (CONTROL_RE.test(n)) return 'Use plain text without control characters.';
  return null;
}

/** '#rrggbb' / 'rrggbb' -> '#RRGGBB'; '' -> null (no colour); anything else -> undefined (invalid). */
export function normalizeHexColor(raw: string | null | undefined): string | null | undefined {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(s);
  return m ? `#${(m[1] as string).toUpperCase()}` : undefined;
}

/** A palette colour no profile uses yet (the first one when all are taken). */
export function suggestColor(profiles: readonly Pick<Profile, 'color'>[] | null | undefined): string {
  const used = new Set((profiles ?? []).map((p) => (p.color ?? '').toUpperCase()));
  return (PROFILE_COLORS.find((c) => !used.has(c.value)) ?? (PROFILE_COLORS[0] as { value: string })).value;
}

/**
 * Roughly the slug the server derives from a name (lowercase a-z, 0-9 and dashes, ≤ 32), for the
 * "OBS keys will start with …" hint. The server makes it unique and avoids reserved words, so the
 * final one can differ slightly.
 */
export function slugPreview(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
}

/** Only a server colour that is a plain #RRGGBB may be used in a style. */
export function profileColor(p: Pick<Profile, 'color'> | null | undefined): string | null {
  const c = p?.color;
  return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : null;
}
