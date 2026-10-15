import { describe, expect, it } from 'vitest';
import type { DestinationPhase, DestinationState } from '../../../shared/types.js';
import type { AppServices } from '../services.js';
import { accountInUse } from './account-in-use.js';

type Phases = Record<string, DestinationPhase>;

function states(phases: Phases): DestinationState[] {
  return Object.entries(phases).map(([destinationId, phase]) => ({
    destinationId,
    phase,
    message: null,
    stats: null,
    watchUrl: null,
    retries: 0,
    since: '',
    recoveries: 0,
    lastRecovery: null,
  }));
}

/** `byProfile`: each profile's destination phases; `accounts`: destination → account; `owners`: account → profile. */
function services(byProfile: Record<string, Phases>, accounts: Record<string, string | null>, owners: Record<string, string> = {}) {
  const reads: string[] = [];
  const orchestrators = Object.entries(byProfile).map(([profileId, phases]) => ({
    profileId,
    state: () => {
      reads.push(profileId);
      return { destinations: states(phases) };
    },
  }));
  const svc = {
    orchestrators: { all: () => orchestrators },
    repos: {
      destinations: { get: (id: string) => (id in accounts ? { id, accountId: accounts[id] } : null) },
      accounts: { get: (id: string) => (id in owners ? { id, profileId: owners[id] } : null) },
    },
  } as unknown as Pick<AppServices, 'orchestrators' | 'repos'>;
  return { svc, reads };
}

describe('accountInUse', () => {
  it('is true only while a runner for one of the account destinations is active', () => {
    const links = { d1: 'acc1', d2: 'acc2', d3: null };
    for (const phase of ['preparing', 'connecting', 'confirming', 'live', 'retrying', 'recovering', 'ending'] as const) {
      expect(accountInUse(services({ default: { d1: phase } }, links).svc, 'acc1'), phase).toBe(true);
    }
    for (const phase of ['idle', 'disabled', 'waiting-for-feed', 'error'] as const) {
      expect(accountInUse(services({ default: { d1: phase } }, links).svc, 'acc1'), phase).toBe(false);
    }
    expect(accountInUse(services({ default: { d2: 'live', d3: 'live' } }, links).svc, 'acc1')).toBe(false);
    expect(accountInUse(services({ default: { gone: 'live' } }, links).svc, 'acc1')).toBe(false);
  });

  it('checks the account’s own profile first, and finds it live in any profile', () => {
    const links = { c1: 'clubAcc', d1: 'mainAcc' };
    const owners = { clubAcc: 'club', mainAcc: 'default' };
    const club = services({ default: { d1: 'idle' }, club: { c1: 'live' } }, links, owners);
    expect(accountInUse(club.svc, 'clubAcc')).toBe(true);
    expect(club.reads).toEqual(['club']); // found in its own profile: no other profile read

    const main = services({ default: { d1: 'idle' }, club: { c1: 'live' } }, links, owners);
    expect(accountInUse(main.svc, 'mainAcc')).toBe(false);
    expect(main.reads).toEqual(['default', 'club']);

    // Unknown account (or one without a profile): every profile is still checked.
    expect(accountInUse(services({ default: {}, club: { c1: 'live' } }, links).svc, 'clubAcc')).toBe(true);
  });
});
