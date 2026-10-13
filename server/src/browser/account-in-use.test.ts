import { describe, expect, it } from 'vitest';
import type { DestinationPhase, DestinationState } from '../../../shared/types.js';
import type { AppServices } from '../services.js';
import { accountInUse } from './account-in-use.js';

function services(phases: Record<string, DestinationPhase>, accounts: Record<string, string | null>) {
  const destinations: DestinationState[] = Object.entries(phases).map(([destinationId, phase]) => ({
    destinationId,
    phase,
    message: null,
    stats: null,
    watchUrl: null,
    retries: 0,
    since: '',
  }));
  return {
    orchestrator: { state: () => ({ destinations }) },
    repos: { destinations: { get: (id: string) => (id in accounts ? { id, accountId: accounts[id] } : null) } },
  } as unknown as Pick<AppServices, 'orchestrator' | 'repos'>;
}

describe('accountInUse', () => {
  it('is true only while a runner for one of the account destinations is active', () => {
    const links = { d1: 'acc1', d2: 'acc2', d3: null };
    for (const phase of ['preparing', 'connecting', 'confirming', 'live', 'retrying', 'ending'] as const) {
      expect(accountInUse(services({ d1: phase }, links), 'acc1'), phase).toBe(true);
    }
    for (const phase of ['idle', 'disabled', 'waiting-for-feed', 'error'] as const) {
      expect(accountInUse(services({ d1: phase }, links), 'acc1'), phase).toBe(false);
    }
    expect(accountInUse(services({ d2: 'live', d3: 'live' }, links), 'acc1')).toBe(false);
    expect(accountInUse(services({ gone: 'live' }, links), 'acc1')).toBe(false);
  });
});
