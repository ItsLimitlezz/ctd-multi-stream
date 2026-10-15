// Profiles: independent streaming set-ups. The slug is derived from the name once and never
// changes, because it is part of the profile's OBS stream keys (`<slug>/landscape?key=…`).

import crypto from 'node:crypto';
import { DEFAULT_PROFILE_ID, type Profile } from '../../../shared/types.js';
import type { ProfilesRepo } from '../services.js';
import { NotFoundError, isUniqueViolation, nowIso, str, strOrNull, updateById, type Row, type Stmt } from './rows.js';

export const PROFILE_SLUG_MAX = 32;
/** A valid slug: lowercase letters, digits and dashes, 1–32 characters. */
export const PROFILE_SLUG_RE = /^[a-z0-9-]{1,32}$/;
/**
 * Slugs a new profile never gets: the feed names (they would read like the default profile's
 * stream keys), the default profile's own slug, and its id.
 */
export const RESERVED_PROFILE_SLUGS: readonly string[] = ['landscape', 'vertical', 'main', 'default'];

const COLUMNS = 'id, name, slug, color, created_at, updated_at';

/** Error for the default profile, which can never be deleted. */
export class DefaultProfileError extends Error {
  readonly statusCode = 400;
  readonly code = 'default_profile';
  constructor() {
    super('The default profile cannot be deleted');
    this.name = 'DefaultProfileError';
  }
}

function toProfile(row: Row): Profile {
  return {
    id: str(row, 'id'),
    name: str(row, 'name'),
    slug: str(row, 'slug'),
    color: strOrNull(row, 'color'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

/**
 * URL-safe base slug for a name: lowercase ASCII letters/digits (accents dropped), every other run
 * of characters becomes one dash, no leading/trailing dash, at most 32 characters. 'profile' when
 * nothing usable is left (e.g. a name made of emoji).
 */
export function slugify(name: string): string {
  const ascii = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining accents: "é" -> "e"
    .toLowerCase();
  const slug = ascii
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PROFILE_SLUG_MAX)
    .replace(/-+$/, '');
  return slug || 'profile';
}

/**
 * First free slug for `base`: the base itself unless reserved or taken, else `<base>-2`, `<base>-3`…
 * (the base is shortened so the result stays within 32 characters).
 */
export function uniqueSlug(base: string, isTaken: (slug: string) => boolean): string {
  const free = (s: string) => !RESERVED_PROFILE_SLUGS.includes(s) && !isTaken(s);
  if (free(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const head = base.slice(0, PROFILE_SLUG_MAX - suffix.length).replace(/-+$/, '') || 'profile';
    const candidate = `${head}${suffix}`;
    if (free(candidate)) return candidate;
  }
}

export function createProfilesRepo(stmt: Stmt): ProfilesRepo {
  const get = (id: string): Profile | null => {
    const row = stmt(`SELECT ${COLUMNS} FROM profiles WHERE id = ?`).get(id);
    return row ? toProfile(row) : null;
  };
  const getBySlug = (slug: string): Profile | null => {
    const row = stmt(`SELECT ${COLUMNS} FROM profiles WHERE slug = ?`).get(slug);
    return row ? toProfile(row) : null;
  };

  return {
    list() {
      // The default profile first, then oldest first.
      return stmt(`SELECT ${COLUMNS} FROM profiles ORDER BY (id = ?) DESC, created_at, rowid`).all(DEFAULT_PROFILE_ID).map(toProfile);
    },

    get,
    getBySlug,

    create({ name, color }) {
      const id = crypto.randomUUID();
      const base = slugify(name);
      const tried = new Set<string>();
      // The UNIQUE constraint is the final word; retry with the next suffix if a slug was taken meanwhile.
      for (let attempt = 0; attempt < 5; attempt++) {
        const slug = uniqueSlug(base, (s) => tried.has(s) || getBySlug(s) !== null);
        const now = nowIso();
        try {
          stmt(`INSERT INTO profiles (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`).run(id, name, slug, color ?? null, now, now);
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          tried.add(slug);
          continue;
        }
        const created = get(id);
        if (!created) throw new Error('Profile insert failed');
        return created;
      }
      throw new Error('Could not find a free profile slug');
    },

    update(id, patch) {
      const changes = updateById(stmt, 'profiles', id, {
        name: patch.name,
        color: patch.color,
      });
      const updated = changes > 0 ? get(id) : null;
      if (!updated) throw new NotFoundError('Profile not found');
      return updated;
    },

    delete(id) {
      if (id === DEFAULT_PROFILE_ID) throw new DefaultProfileError();
      stmt('DELETE FROM profiles WHERE id = ?').run(id);
    },
  };
}
