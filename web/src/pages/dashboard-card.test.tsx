import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Destination, DestinationPhase, DestinationState, SessionState } from '@shared/types';
import { AuthProvider } from '../state/auth';
import { LiveProvider } from '../state/live';
import type { TestModeEntry } from './dashboard-helpers';
import { DestinationCard, StatusCard, TestModeBanner } from './DashboardPage';

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

  it('flags a Twitch destination whose own "Bandwidth test" option is on (the channel stays offline)', () => {
    const twitch = (options: Record<string, unknown>) =>
      renderToStaticMarkup(
        <DestinationCard dest={{ ...destination, platform: 'twitch', feed: 'landscape', options }} state={state('live')} onUpdated={() => undefined} />,
      );
    expect(twitch({ bandwidthTest: true })).toContain('Bandwidth test: not public');
    expect(twitch({ bandwidthTest: false })).not.toContain('Bandwidth test');
    expect(twitch({})).not.toContain('Bandwidth test');
  });

  it('shows viewers while live (hidden when unknown)', () => {
    const live = card(state('live', { viewers: 1234 }));
    expect(live).toContain('dest-viewers');
    expect(live).toContain('1,234');
    expect(card(state('live', { viewers: null }))).not.toContain('dest-viewers');
    expect(card(state('connecting', { viewers: 5 }))).not.toContain('dest-viewers');
  });

  it('test mode: skipped destinations say so; supported ones are marked as a private test', () => {
    const entry = (action: TestModeEntry['action'], text: string): TestModeEntry => ({
      destinationId: 'ig',
      name: destination.name,
      platform: 'instagram',
      action,
      text,
    });
    const skipped = renderToStaticMarkup(
      <DestinationCard dest={destination} state={null} testMode={entry('skip', 'Skipped — Instagram has no test mode')} onUpdated={() => undefined} />,
    );
    expect(skipped).toContain('Skipped in test mode');
    expect(skipped).toContain('dest-card is-skipped');
    expect(skipped).toContain('Skipped — Instagram has no test mode');
    expect(skipped).not.toContain('>Idle<');
    // During the session the server parks it as 'disabled' with its own message.
    const parked = renderToStaticMarkup(
      <DestinationCard
        dest={destination}
        state={state('disabled', { message: 'Skipped — Instagram has no test mode' })}
        testMode={entry('skip', 'x')}
        onUpdated={() => undefined}
      />,
    );
    expect(parked).toContain('Skipped in test mode');
    expect(parked).not.toContain('>Disabled<');
    const practice = renderToStaticMarkup(
      <DestinationCard dest={destination} state={state('live')} testMode={entry('test', 'Practice audience — only you can see it')} onUpdated={() => undefined} />,
    );
    expect(practice).toContain('Private test');
    expect(practice).toContain('title="Practice audience — only you can see it"');
    expect(practice).not.toContain('Skipped in test mode');
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

const withProviders = (el: ReactElement) =>
  renderToStaticMarkup(
    <AuthProvider>
      <LiveProvider>{el}</LiveProvider>
    </AuthProvider>,
  );

const session = (over: Partial<SessionState> = {}): SessionState => ({
  status: 'offline',
  sessionId: null,
  startedAt: null,
  title: 'Show',
  autoGoLive: false,
  testMode: false,
  feeds: [],
  destinations: [],
  ...over,
});

describe('dashboard status card', () => {
  it('has a labelled test-mode switch next to Go live', () => {
    const off = withProviders(<StatusCard session={session()} />);
    expect(off).toContain('Test mode');
    expect(off).toContain('Stream privately where possible, skip the rest');
    expect(off).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(off.indexOf('Go live</button>')).toBeGreaterThan(off.indexOf('Test mode'));
    expect(off.indexOf('Test mode')).toBeGreaterThan(off.indexOf('status-actions'));
    expect(off).not.toContain('is-test');

    const on = withProviders(<StatusCard session={session({ testMode: true })} />);
    expect(on).toContain('status-card is-offline is-test');
    expect(on).toContain('test-switch is-on');
  });

  it('locks the switch while a session runs and says why', () => {
    const out = withProviders(<StatusCard session={session({ status: 'live', startedAt: new Date().toISOString(), testMode: true })} />);
    expect(out).toContain('title="Test mode can only change while offline. End the stream first."');
    expect(out).toContain('Locked while the stream runs');
    expect(out).toMatch(/role="switch"[^>]*aria-checked="true"[^>]*disabled=""|disabled=""[^>]*role="switch"/);
    expect(out).toContain('status-test');
  });

  it('shows the total of known viewers', () => {
    const live = (id: string, viewers: number | null): DestinationState => ({ ...state('live', { viewers }), destinationId: id });
    const out = withProviders(
      <StatusCard session={session({ status: 'live', startedAt: new Date().toISOString(), destinations: [live('a', 200), live('b', 14), live('c', null)] })} />,
    );
    expect(out).toContain('214 viewers');
    const unknown = withProviders(<StatusCard session={session({ status: 'live', destinations: [live('a', null)] })} />);
    expect(unknown).not.toContain('viewers');
  });
});

describe('test mode banner', () => {
  it('lists what happens on every destination', () => {
    const plan: TestModeEntry[] = [
      { destinationId: 't', name: 'Twitch main', platform: 'twitch', action: 'test', text: 'Bandwidth test — Twitch receives the stream but nobody sees it' },
      { destinationId: 'k', name: 'Kick', platform: 'kick', action: 'skip', text: 'Kick has no test mode — skipped while testing' },
      { destinationId: 'f', name: 'FB page', platform: 'facebook', action: 'depends', text: 'Pages: only you. Profiles are skipped.' },
    ];
    const out = renderToStaticMarkup(<TestModeBanner plan={plan} running={false} />);
    expect(out).toContain('TEST MODE');
    expect(out).toContain('Nothing goes out publicly.');
    expect(out).toContain('1 destination streams privately, 1 depends on the account type, 1 is skipped.');
    expect(out).toContain('Bandwidth test — Twitch receives the stream but nobody sees it');
    expect(out).toContain('Kick has no test mode — skipped while testing');
    expect(out).toContain('Private test');
    expect(out).toContain('Skipped');
    expect(out).toContain('Depends on account');
    expect(out).toContain('Turn test mode off before you go live for real.');
    expect(renderToStaticMarkup(<TestModeBanner plan={null} running />)).toContain('Test mode stays on until this stream ends.');
  });
});
