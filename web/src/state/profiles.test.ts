import { describe, expect, it } from 'vitest';
import type { ProfileSummary } from '@shared/types';
import { DEFAULT_PROFILE_ID } from '@shared/types';
import {
  deleteBlockedReason,
  findProfile,
  isProfileIdLike,
  liveProfilesText,
  normalizeHexColor,
  obsKeyHint,
  otherProfileLive,
  pathWithProfile,
  profileAlerts,
  PROFILE_COLORS,
  PROFILE_STORAGE_KEY,
  profileColor,
  profileCountsText,
  profileLabel,
  profileQueryValue,
  readStoredProfile,
  resolveProfileId,
  showLiveSummary,
  slugPreview,
  sortProfiles,
  storeProfile,
  suggestColor,
  validateProfileName,
  withProfileQuery,
  type StorageLike,
} from './profiles';

const summary = (id: string, name: string, over: Partial<ProfileSummary> = {}): ProfileSummary => ({
  id,
  name,
  slug: id === DEFAULT_PROFILE_ID ? 'main' : name.toLowerCase(),
  color: null,
  createdAt: '2026-10-15T14:00:00Z',
  updatedAt: '2026-10-15T14:00:00Z',
  status: 'offline',
  startedAt: null,
  testMode: false,
  destinations: 0,
  live: 0,
  down: 0,
  ...over,
});

const main = summary(DEFAULT_PROFILE_ID, 'Miami or Bust');
const club = summary('6f1d2c', 'DPRTMNT', { color: '#E11D48' });

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? (data[k] as string) : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const throwingStorage: StorageLike = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('current profile', () => {
  it('prefers the URL, then the remembered profile, then the default', () => {
    const profiles = [main, club];
    expect(resolveProfileId({ requested: '6f1d2c', stored: null, profiles })).toBe('6f1d2c');
    expect(resolveProfileId({ requested: null, stored: '6f1d2c', profiles })).toBe('6f1d2c');
    expect(resolveProfileId({ requested: 'default', stored: '6f1d2c', profiles })).toBe('default');
    expect(resolveProfileId({ requested: null, stored: null, profiles })).toBe(DEFAULT_PROFILE_ID);
  });

  it('drops unknown or deleted profiles once the list is known', () => {
    expect(resolveProfileId({ requested: 'gone', stored: '6f1d2c', profiles: [main, club] })).toBe('6f1d2c');
    expect(resolveProfileId({ requested: 'gone', stored: 'also-gone', profiles: [main, club] })).toBe(DEFAULT_PROFILE_ID);
    // No default profile in the list (shouldn't happen): the first one.
    expect(resolveProfileId({ requested: 'gone', stored: null, profiles: [club] })).toBe('6f1d2c');
    expect(resolveProfileId({ requested: 'gone', stored: null, profiles: [] })).toBe(DEFAULT_PROFILE_ID);
  });

  it('trusts a well-formed id while the list is unknown, never junk', () => {
    expect(resolveProfileId({ requested: '6f1d2c', stored: null, profiles: null })).toBe('6f1d2c');
    expect(resolveProfileId({ requested: '../x?y', stored: 'abc', profiles: null })).toBe('abc');
    expect(resolveProfileId({ requested: '', stored: '<script>', profiles: null })).toBe(DEFAULT_PROFILE_ID);
    expect(isProfileIdLike('a'.repeat(65))).toBe(false);
    expect(isProfileIdLike('6f1d2c-aa_B')).toBe(true);
  });

  it('puts ?profile= in the URL only when there is something to choose', () => {
    expect(profileQueryValue(DEFAULT_PROFILE_ID, [main])).toBeNull();
    expect(profileQueryValue(DEFAULT_PROFILE_ID, [main, club])).toBe(DEFAULT_PROFILE_ID);
    expect(profileQueryValue('6f1d2c', [main, club])).toBe('6f1d2c');
  });

  it('adds the profile to API paths and app paths', () => {
    expect(withProfileQuery('/api/destinations', '6f1d2c')).toBe('/api/destinations?profile=6f1d2c');
    expect(withProfileQuery('/api/chat/recent?limit=200', 'a b')).toBe('/api/chat/recent?limit=200&profile=a%20b');
    expect(withProfileQuery('/api/ingest', undefined)).toBe('/api/ingest');
    expect(withProfileQuery('/api/ingest', '')).toBe('/api/ingest');
    expect(pathWithProfile('/', '6f1d2c')).toBe('/?profile=6f1d2c');
    expect(pathWithProfile('/settings?tab=obs&profile=old#k', 'new')).toBe('/settings?tab=obs&profile=new#k');
  });

  it('remembers the profile per browser, surviving blocked storage', () => {
    const s = memoryStorage();
    expect(readStoredProfile(s)).toBeNull();
    storeProfile('6f1d2c', s);
    expect(s.data[PROFILE_STORAGE_KEY]).toBe('6f1d2c');
    expect(readStoredProfile(s)).toBe('6f1d2c');
    storeProfile('bad id!', s); // ignored
    expect(readStoredProfile(s)).toBe('6f1d2c');
    expect(readStoredProfile(memoryStorage({ [PROFILE_STORAGE_KEY]: 'x"><' }))).toBeNull();
    expect(readStoredProfile(throwingStorage)).toBeNull();
    expect(() => storeProfile('6f1d2c', throwingStorage)).not.toThrow();
    expect(readStoredProfile(null)).toBeNull();
  });
});

describe('profile lists and labels', () => {
  it('puts the default profile first and keeps the rest in order', () => {
    const b = summary('b', 'B');
    expect(sortProfiles([club, main, b]).map((p) => p.id)).toEqual([DEFAULT_PROFILE_ID, '6f1d2c', 'b']);
  });

  it('names profile ids for token and app lists', () => {
    expect(profileLabel(null, [main])).toBe('Every profile');
    expect(profileLabel('6f1d2c', [main, club])).toBe('DPRTMNT');
    expect(profileLabel('gone', [main])).toBe('Deleted profile');
    expect(profileLabel('gone', null)).toBe('Profile');
    expect(profileLabel(DEFAULT_PROFILE_ID, null)).toBe('Main');
    expect(findProfile([main, club], '6f1d2c')?.name).toBe('DPRTMNT');
    expect(findProfile(null, 'x')).toBeNull();
  });
});

describe('who is live', () => {
  it('summarises live profiles for the header', () => {
    expect(liveProfilesText([main, club])).toBe('');
    expect(liveProfilesText([main, { ...club, status: 'live' }])).toBe('DPRTMNT is live');
    expect(liveProfilesText([{ ...main, status: 'live' }, { ...club, status: 'live' }])).toBe('2 live: Miami or Bust · DPRTMNT');
    // Starting doesn't count as live yet.
    expect(liveProfilesText([{ ...main, status: 'starting' }])).toBe('');
    expect(liveProfilesText(null)).toBe('');
  });

  it('shows the summary when several are live or the live one is not on screen', () => {
    const bothLive = [
      { ...main, status: 'live' as const },
      { ...club, status: 'live' as const },
    ];
    expect(showLiveSummary(bothLive, DEFAULT_PROFILE_ID)).toBe(true);
    expect(showLiveSummary([main, { ...club, status: 'live' }], DEFAULT_PROFILE_ID)).toBe(true);
    expect(showLiveSummary([main, { ...club, status: 'live' }], '6f1d2c')).toBe(false);
    expect(showLiveSummary([main, club], DEFAULT_PROFILE_ID)).toBe(false);
    expect(otherProfileLive([main, { ...club, status: 'live' }], DEFAULT_PROFILE_ID)).toBe(true);
    expect(otherProfileLive([main, { ...club, status: 'live' }], '6f1d2c')).toBe(false);
  });

  it('counts destinations, and live/down while a session runs', () => {
    expect(profileCountsText(main)).toBe('No destinations enabled');
    expect(profileCountsText({ ...main, destinations: 1 })).toBe('1 destination enabled');
    expect(profileCountsText({ ...club, destinations: 4, live: 3, down: 0 })).toBe('4 destinations enabled');
    expect(profileCountsText({ ...club, status: 'live', destinations: 4, live: 3, down: 1 })).toBe('4 destinations enabled · 3 live · 1 down');
    expect(profileCountsText({ ...club, status: 'live', destinations: 3, live: 3, down: 0 })).toBe('3 destinations enabled · 3 live');
  });
});

describe('profiles page rules', () => {
  it('never deletes the default profile or a live one, and says why', () => {
    expect(deleteBlockedReason(main)).toMatch(/default profile/);
    expect(deleteBlockedReason({ ...club, status: 'live' })).toMatch(/End this profile/);
    expect(deleteBlockedReason({ ...club, status: 'starting' })).not.toBeNull();
    expect(deleteBlockedReason(club)).toBeNull();
  });

  it('shows how OBS keys start (the default profile keeps its old keys)', () => {
    expect(obsKeyHint(main)).toBe('landscape?key=…');
    expect(obsKeyHint(club)).toBe('dprtmnt/landscape?key=…');
  });

  it('validates names and colours like the server', () => {
    expect(validateProfileName('  ')).toMatch(/name/);
    expect(validateProfileName('x'.repeat(61))).toMatch(/60/);
    expect(validateProfileName('DPRTMNT‮')).toMatch(/control/);
    expect(validateProfileName(' DPRTMNT ')).toBeNull();
    expect(normalizeHexColor('#e11d48')).toBe('#E11D48');
    expect(normalizeHexColor('e11d48')).toBe('#E11D48');
    expect(normalizeHexColor('')).toBeNull();
    expect(normalizeHexColor(null)).toBeNull();
    expect(normalizeHexColor('red')).toBeUndefined();
    expect(normalizeHexColor('#fff')).toBeUndefined();
    expect(profileColor(club)).toBe('#E11D48');
    expect(profileColor({ color: 'red; background:url(x)' })).toBeNull();
    expect(profileColor(null)).toBeNull();
  });

  it('suggests an unused colour and previews the slug', () => {
    expect(suggestColor([])).toBe(PROFILE_COLORS[0]?.value);
    expect(suggestColor([{ color: (PROFILE_COLORS[0]?.value ?? '').toLowerCase() }])).toBe(PROFILE_COLORS[1]?.value);
    expect(suggestColor(PROFILE_COLORS.map((c) => ({ color: c.value })))).toBe(PROFILE_COLORS[0]?.value);
    expect(slugPreview('DPRTMNT')).toBe('dprtmnt');
    expect(slugPreview('  Miami or Bust! ')).toBe('miami-or-bust');
    expect(slugPreview('Café Señor')).toBe('cafe-senor');
    expect(slugPreview('x'.repeat(40))).toHaveLength(32);
    expect(slugPreview('!!!')).toBe('');
  });
});

describe('profileAlerts (other live profiles)', () => {
  const live = (over: Partial<ProfileSummary> = {}) => summary('6f1d2c', 'DPRTMNT', { status: 'live', destinations: 4, live: 4, ...over });

  it('nothing without a baseline (first list after connecting, reconnect, profile switch)', () => {
    expect(profileAlerts(null, [main, live({ down: 2 })], DEFAULT_PROFILE_ID)).toEqual([]);
  });

  it('warns (with sound) when another live profile loses destinations, naming it', () => {
    const out = profileAlerts([main, live()], [main, live({ live: 3, down: 1 })], DEFAULT_PROFILE_ID);
    expect(out).toEqual([
      { profileId: '6f1d2c', level: 'warn', message: 'DPRTMNT · 1 destination down. Switch to DPRTMNT to see which.', alert: true },
    ]);
    expect(profileAlerts([main, live({ down: 1 })], [main, live({ down: 2 })], DEFAULT_PROFILE_ID)[0]?.message).toContain('2 destinations down');
  });

  it('says when every destination is back, and when the profile stopped being live without a stop', () => {
    expect(profileAlerts([main, live({ down: 2 })], [main, live({ down: 0 })], DEFAULT_PROFILE_ID)).toEqual([
      { profileId: '6f1d2c', level: 'info', message: 'DPRTMNT · every destination is live again.', alert: true },
    ]);
    expect(profileAlerts([main, live()], [main, live({ status: 'offline', live: 0 })], DEFAULT_PROFILE_ID)).toEqual([
      { profileId: '6f1d2c', level: 'info', message: 'DPRTMNT is no longer live.', alert: false },
    ]);
    // A normal stop goes through 'stopping': quiet.
    expect(profileAlerts([main, live({ status: 'stopping' })], [main, live({ status: 'offline' })], DEFAULT_PROFILE_ID)).toEqual([]);
  });

  it('ignores the profile on screen (its own notices arrive), unchanged counts, new profiles and offline ones', () => {
    expect(profileAlerts([main, live()], [main, live({ down: 3 })], '6f1d2c')).toEqual([]);
    expect(profileAlerts([main, live({ down: 1 })], [main, live({ down: 1 })], DEFAULT_PROFILE_ID)).toEqual([]);
    expect(profileAlerts([main], [main, live({ down: 1 })], DEFAULT_PROFILE_ID)).toEqual([]);
    expect(profileAlerts([main, club], [main, { ...club, down: 1 }], DEFAULT_PROFILE_ID)).toEqual([]);
  });
});
