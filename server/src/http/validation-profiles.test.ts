import { describe, expect, it, vi } from 'vitest';
import type { Profile } from '../../../shared/types.js';
import type { AppServices } from '../services.js';
import { HttpError, profileFromQuery, profileOf, requireProfile, resolveProfileId } from './validation.js';

const club: Profile = { id: 'club', name: 'DPRTMNT', slug: 'dprtmnt', color: '#E11D48', createdAt: '', updatedAt: '' };
const get = vi.fn((id: string) => (id === 'club' ? club : null));
const services = { repos: { profiles: { get } } } as unknown as Pick<AppServices, 'repos'>;

function codeOf(fn: () => unknown): [number, string] | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof HttpError) return [err.statusCode, err.code];
    throw err;
  }
}

describe('profile helpers', () => {
  it('?profile= defaults to the default profile (no lookup needed: it always exists)', () => {
    get.mockClear();
    expect(profileFromQuery(services, {})).toBe('default');
    expect(profileFromQuery(services, undefined)).toBe('default');
    expect(profileFromQuery(services, { profile: '' })).toBe('default');
    expect(profileFromQuery(services, { profile: 'default' })).toBe('default');
    expect(get).not.toHaveBeenCalled();
  });

  it('?profile= resolves existing profiles, 404s unknown ones, 400s malformed ones', () => {
    expect(profileFromQuery(services, { profile: 'club' })).toBe('club');
    expect(profileFromQuery(services, { profile: ' club ' })).toBe('club');
    expect(codeOf(() => profileFromQuery(services, { profile: 'ghost' }))).toEqual([404, 'unknown_profile']);
    expect(codeOf(() => profileFromQuery(services, { profile: ['club', 'default'] }))).toEqual([400, 'invalid']);
    expect(codeOf(() => profileFromQuery(services, { profile: 'x'.repeat(65) }))).toEqual([400, 'invalid']);
  });

  it('body profileId: omitted/null/empty = default profile', () => {
    expect(resolveProfileId(services, undefined)).toBe('default');
    expect(resolveProfileId(services, null)).toBe('default');
    expect(resolveProfileId(services, '')).toBe('default');
    expect(resolveProfileId(services, 'club')).toBe('club');
    expect(codeOf(() => resolveProfileId(services, 'ghost'))).toEqual([404, 'unknown_profile']);
    expect(requireProfile(services, 'club')).toBe(club);
  });

  it('rows from before profiles belong to the default profile', () => {
    expect(profileOf({})).toBe('default');
    expect(profileOf({ profileId: undefined })).toBe('default');
    expect(profileOf({ profileId: 'club' })).toBe('club');
  });
});
