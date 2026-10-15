import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROFILE_ID } from '../../../shared/types.js';
import { createSecretBox } from '../security/secretbox.js';
import type { Repos } from '../services.js';
import { openDatabase, type Db } from './database.js';
import { DefaultProfileError, PROFILE_SLUG_RE, RESERVED_PROFILE_SLUGS, slugify, uniqueSlug } from './profiles-repo.js';
import { NotFoundError, createRepos } from './repos.js';

let db: Db;
let repos: Repos;

beforeEach(() => {
  db = openDatabase(':memory:');
  repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('slugify', () => {
  it.each([
    ['DPRTMNT', 'dprtmnt'],
    ['Miami or Bust', 'miami-or-bust'],
    ['  Saturday -- Night!! ', 'saturday-night'],
    ['Café Ñandú', 'cafe-nandu'],
    ['ＤＰＲＴＭＮＴ', 'dprtmnt'], // full-width letters
    ['🎉🎉', 'profile'],
    ['', 'profile'],
    ['a'.repeat(40), 'a'.repeat(32)],
    [`${'a'.repeat(31)} b`, 'a'.repeat(31)], // no trailing dash after the cut
    ['Main', 'main'], // reserved: made unique by uniqueSlug()
  ])('%j -> %s', (name, slug) => {
    expect(slugify(name)).toBe(slug);
    expect(slug).toMatch(PROFILE_SLUG_RE);
  });
});

describe('uniqueSlug', () => {
  it('suffixes reserved and taken slugs, staying within 32 characters', () => {
    const none = () => false;
    for (const reserved of RESERVED_PROFILE_SLUGS) expect(uniqueSlug(reserved, none)).toBe(`${reserved}-2`);
    const taken = new Set(['club', 'club-2', 'club-3']);
    expect(uniqueSlug('club', (s) => taken.has(s))).toBe('club-4');
    const long = 'x'.repeat(32);
    expect(uniqueSlug(long, (s) => s === long)).toBe(`${'x'.repeat(30)}-2`);
    const dashy = `${'y'.repeat(29)}-zz`; // cutting to 30 would leave a trailing dash
    expect(uniqueSlug(dashy, (s) => s === dashy)).toBe(`${'y'.repeat(29)}-2`);
  });
});

describe('profiles repo', () => {
  it('always has the default profile, listed first', () => {
    expect(repos.profiles.get(DEFAULT_PROFILE_ID)).toMatchObject({ id: 'default', name: 'Main', slug: 'main', color: null });
    expect(repos.profiles.getBySlug('main')?.id).toBe(DEFAULT_PROFILE_ID);
    // Even if a later profile somehow sorts earlier by time.
    db.prepare("INSERT INTO profiles (id, name, slug, color, created_at, updated_at) VALUES ('old', 'Old', 'old', NULL, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')").run();
    expect(repos.profiles.list().map((p) => p.id)).toEqual(['default', 'old']);
  });

  it('creates profiles with a unique, fixed slug', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-15T14:05:00.000Z'));
    const club = repos.profiles.create({ name: 'DPRTMNT', color: '#E11D48' });
    expect(club).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: 'DPRTMNT',
      slug: 'dprtmnt',
      color: '#E11D48',
      createdAt: '2026-10-15T14:05:00.000Z',
      updatedAt: '2026-10-15T14:05:00.000Z',
    });
    vi.setSystemTime(Date.parse('2026-10-15T14:06:00.000Z'));
    const again = repos.profiles.create({ name: 'dprtmnt!', color: null });
    expect(again.slug).toBe('dprtmnt-2');
    expect(repos.profiles.create({ name: 'Main', color: null }).slug).toBe('main-2');
    expect(repos.profiles.create({ name: 'Landscape', color: null }).slug).toBe('landscape-2');
    expect(repos.profiles.list().map((p) => p.slug)).toEqual(['main', 'dprtmnt', 'dprtmnt-2', 'main-2', 'landscape-2']);
    expect(repos.profiles.getBySlug('dprtmnt-2')?.id).toBe(again.id);
    expect(repos.profiles.getBySlug('nope')).toBeNull();

    // Renaming keeps the slug (OBS stream keys keep working).
    vi.setSystemTime(Date.parse('2026-10-16T09:00:00.000Z'));
    const renamed = repos.profiles.update(club.id, { name: 'DPRTMNT Club' });
    expect(renamed).toMatchObject({ name: 'DPRTMNT Club', slug: 'dprtmnt', color: '#E11D48', updatedAt: '2026-10-16T09:00:00.000Z', createdAt: club.createdAt });
    expect(repos.profiles.update(club.id, { color: null }).color).toBeNull();
    expect(repos.profiles.update(club.id, {}).name).toBe('DPRTMNT Club');
    expect(() => repos.profiles.update('missing', { name: 'x' })).toThrow(NotFoundError);
  });

  it('renames the default profile without touching its slug', () => {
    const p = repos.profiles.update(DEFAULT_PROFILE_ID, { name: 'Miami or Bust', color: '#3B82F6' });
    expect(p).toMatchObject({ id: 'default', name: 'Miami or Bust', slug: 'main', color: '#3B82F6' });
  });

  it('deletes profiles but never the default one', () => {
    const club = repos.profiles.create({ name: 'Club', color: null });
    repos.profiles.delete(club.id);
    expect(repos.profiles.get(club.id)).toBeNull();
    repos.profiles.delete('missing'); // no-op
    expect(() => repos.profiles.delete(DEFAULT_PROFILE_ID)).toThrow(DefaultProfileError);
    expect(repos.profiles.get(DEFAULT_PROFILE_ID)).not.toBeNull();
    // A deleted profile's slug can be reused by a new profile.
    expect(repos.profiles.create({ name: 'Club', color: null }).slug).toBe('club');
  });
});
