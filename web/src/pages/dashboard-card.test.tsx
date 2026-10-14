import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Destination, DestinationPhase, DestinationState } from '@shared/types';
import { DestinationCard } from './DashboardPage';

const destination: Destination = {
  id: 'ig',
  platform: 'instagram',
  accountId: 'a1',
  name: 'DPRTMNT Instagram',
  feed: 'vertical',
  enabled: true,
  options: {},
  ingestUrl: null,
  hasStreamKey: false,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};

const state = (phase: DestinationPhase, over: Partial<DestinationState> = {}): DestinationState => ({
  destinationId: 'ig',
  phase,
  message: null,
  stats: null,
  watchUrl: null,
  retries: 0,
  since: new Date().toISOString(),
  recoveries: 0,
  lastRecovery: null,
  ...over,
});

const card = (s: DestinationState | null) =>
  renderToStaticMarkup(<DestinationCard dest={destination} state={s} onUpdated={() => undefined} />);

describe('dashboard destination card', () => {
  it('shows recovering as a warning without a Retry button', () => {
    const out = card(
      state('recovering', { message: 'Instagram ended the live (copyright). Starting a new one…' }),
    );
    expect(out).toContain('Recovering');
    expect(out).toContain('tone-warn');
    expect(out).toContain('dest-card is-recovering');
    expect(out).toContain('Instagram ended the live (copyright). Starting a new one…');
    expect(out).not.toContain('Retry');
    // Error still offers Retry.
    expect(card(state('error', { message: 'gave up' }))).toContain('Retry');
  });

  it('shows the recovery count and the last takedown', () => {
    const at = new Date(Date.now() - 5 * 60_000).toISOString();
    const out = card(state('live', { recoveries: 2, lastRecovery: { at, reason: 'copyright takedown' } }));
    expect(out).toContain('Recovered 2× · last: copyright takedown 5 min ago');
    expect(out).toContain('dest-recovery');
    expect(card(state('live'))).not.toContain('Recovered');
    expect(card(null)).not.toContain('Recovered');
  });
});
