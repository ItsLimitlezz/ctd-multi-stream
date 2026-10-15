import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Destination } from '../../../shared/types.js';
import type { ChatMessageInput } from '../platforms/types.js';
import { isUnknownProfileError, profileParam } from './registry.js';
import { advance, dest, driver, flush, harness, prepared, profile } from './test-helpers.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const CLUB = profile('club', 'DPRTMNT', { createdAt: '2026-02-01T00:00:00.000Z' });

/** Default profile ("Main") with d1, the club profile with c1 — both on the 'custom' platform. */
function twoProfiles(opts: { settings?: Record<string, unknown>; dests?: Destination[]; graceSec?: number } = {}) {
  const prepare = vi.fn(async (_d: Destination, _a: Account | null, _title: string) => prepared());
  const h = harness({
    dests: opts.dests ?? [dest('d1'), dest('c1', { profileId: 'club' })],
    drivers: [driver('custom', { prepare })],
    profiles: [CLUB],
    settings: { 'session.title': 'Miami or Bust', 'profile:club:session.title': 'Club night', ...opts.settings },
    ...(opts.graceSec !== undefined ? { graceSec: opts.graceSec } : {}),
  });
  const club = h.registry.get('club');
  return { h, club, prepare };
}

describe('profiles run independently', () => {
  it('a feed of one profile starts only that profile, with its own destinations and title', async () => {
    const { h, club, prepare } = twoProfiles();
    await h.registry.init();
    const mainSessions = () => h.sessionEvents.filter((s) => s.profileId === 'default').length;
    const before = mainSessions();

    h.media.set('landscape', true, null, 'club');
    await flush();
    expect(club.state().status).toBe('live');
    expect(h.orch.state().status).toBe('offline');
    // Profile B's feed never touches profile A: no session event, its feeds stay offline.
    expect(mainSessions()).toBe(before);
    expect(h.orch.state().feeds.every((f) => !f.online)).toBe(true);
    expect(club.state().feeds.find((f) => f.feed === 'landscape')?.online).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0].id).toBe('c1');
    expect(prepare.mock.calls[0]?.[2]).toBe('Club night');
    expect(h.pushes.starts.map((s) => s.id)).toEqual(['c1']);
    expect(h.orch.state().destinations.map((d) => d.destinationId)).toEqual(['d1']);
    expect(club.state().destinations.map((d) => d.destinationId)).toEqual(['c1']);

    // Now the default profile's OBS: both live at the same time.
    h.media.set('landscape', true);
    await flush();
    h.pushes.running('c1');
    h.pushes.running('d1');
    await flush();
    expect(h.orch.state().status).toBe('live');
    expect(club.state().status).toBe('live');
    expect(prepare.mock.calls[1]?.[0].id).toBe('d1');
    expect(prepare.mock.calls[1]?.[2]).toBe('Miami or Bust');
    expect(h.phase('d1')).toBe('live');
    expect(h.phase('c1')).toBe('live');
    expect(h.orch.state().sessionId).not.toBe(club.state().sessionId);
  });

  it('stamps profileId on every session state, destination state, feed and chat attach', async () => {
    const chat = async function* (): AsyncIterable<ChatMessageInput> {};
    const h = harness({
      dests: [dest('d1'), dest('c1', { profileId: 'club', platform: 'twitch' })],
      drivers: [driver('custom', { prepare: async () => prepared() }), driver('twitch', { prepare: async () => prepared({ push: null, chat }) })],
      profiles: [CLUB],
    });
    await h.registry.init();
    h.media.set('landscape', true, null, 'club');
    h.media.set('landscape', true);
    await flush();
    h.pushes.running('d1');
    await flush();

    for (const s of h.sessionEvents) expect(['default', 'club']).toContain(s.profileId);
    expect(h.sessionEvents.some((s) => s.profileId === 'club')).toBe(true);
    for (const e of h.destEvents) expect(e.profileId).toBe(e.destinationId === 'c1' ? 'club' : 'default');
    expect(h.registry.get('club').state()).toMatchObject({ profileId: 'club', feeds: [{ profileId: 'club' }, { profileId: 'club' }] });
    expect(h.orch.state().destinations[0]).toMatchObject({ destinationId: 'd1', profileId: 'default' });
    expect(h.chat.attaches).toEqual([expect.objectContaining({ id: 'c1', profileId: 'club' })]);
  });

  it('keeps auto go-live per profile', async () => {
    const { h, club, prepare } = twoProfiles({ settings: { 'profile:club:session.autoGoLive': false } });
    await h.registry.init();
    expect(club.state().autoGoLive).toBe(false);
    expect(h.orch.state().autoGoLive).toBe(true);

    h.media.set('landscape', true, null, 'club');
    await flush();
    expect(club.state().status).toBe('offline');
    expect(prepare).not.toHaveBeenCalled();

    h.media.set('landscape', true);
    await flush();
    expect(h.orch.state().status).toBe('live');
    expect(club.state().status).toBe('offline');

    club.setAutoGoLive(true);
    await flush();
    expect(h.settings.get('profile:club:session.autoGoLive')).toBe(true);
    expect(h.settings.has('session.autoGoLive')).toBe(false);
    expect(club.state().status).toBe('live');
  });

  it('keeps titles and test mode per profile (default profile keeps the legacy keys)', async () => {
    const { h, club } = twoProfiles();
    await h.registry.init();
    await club.setTitle('Saturday takeover');
    expect(h.settings.get('profile:club:session.title')).toBe('Saturday takeover');
    expect(h.settings.get('session.title')).toBe('Miami or Bust');
    expect(h.orch.state().title).toBe('Miami or Bust');

    // The default profile goes live; the club profile can still switch test mode (it is offline).
    h.media.set('landscape', true);
    await flush();
    expect(() => h.orch.setTestMode(true)).toThrow(expect.objectContaining({ statusCode: 409, code: 'session_live' }));
    club.setTestMode(true);
    expect(h.settings.get('profile:club:session.testMode')).toBe(true);
    expect(h.settings.has('session.testMode')).toBe(false);
    expect(club.state().testMode).toBe(true);
    expect(h.orch.state().testMode).toBe(false);
  });

  it('ends only the profile whose OBS disconnected, with a notice naming the profile', async () => {
    const { h, club } = twoProfiles({ graceSec: 10 });
    await h.registry.init();
    h.media.set('landscape', true, null, 'club');
    h.media.set('landscape', true);
    await flush();

    h.media.set('landscape', false, null, 'club');
    await advance(10_000);
    expect(club.state().status).toBe('offline');
    expect(h.orch.state().status).toBe('live');
    expect(h.notices).toContainEqual({ level: 'info', message: 'DPRTMNT · Session ended: no feed from OBS for 10 s', profileId: 'club' });

    await h.orch.stop();
    expect(h.notices.at(-1)).toEqual({ level: 'info', message: 'Main · Session stopped', profileId: 'default' });
  });

  it('does not name the profile in notices while only one profile exists', async () => {
    const h = harness({ dests: [dest('d1')], drivers: [driver('custom', { prepare: async () => prepared() })] });
    await h.orch.init();
    await h.orch.start('manual');
    await h.orch.stop();
    expect(h.notices.at(-1)).toEqual({ level: 'info', message: 'Session stopped', profileId: 'default' });
  });

  it('ignores another profile’s destination ids', async () => {
    const { h, club, prepare } = twoProfiles({ settings: { 'session.autoGoLive': false } });
    await h.registry.init();
    await h.orch.start('manual');
    h.media.set('landscape', true);
    await flush();
    expect(prepare).toHaveBeenCalledTimes(1);

    // A route calling the wrong profile's orchestrator must not run the club's destination here.
    await h.orch.destinationChanged('c1');
    await h.orch.retryDestination('c1');
    await flush();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(h.orch.state().destinations.map((d) => d.destinationId)).toEqual(['d1']);
    expect(club.state().destinations.map((d) => d.destinationId)).toEqual(['c1']);
  });
});

describe('OrchestratorRegistry', () => {
  it('get() throws 404 unknown_profile for an unknown profile', () => {
    const { h } = twoProfiles();
    let caught: unknown;
    try {
      h.registry.get('nope');
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ statusCode: 404, code: 'unknown_profile' });
    expect(isUnknownProfileError(caught)).toBe(true);
    expect(isUnknownProfileError(new Error('x'))).toBe(false);
    expect(h.registry.get('default').profileId).toBe('default');
    expect(h.registry.get('club').profileId).toBe('club');
  });

  it('init() creates and starts one orchestrator per profile', async () => {
    const { h } = twoProfiles();
    h.media.preset('landscape', true, 'club');
    await h.registry.init();
    await flush();
    expect(h.registry.all().map((o) => o.profileId).sort()).toEqual(['club', 'default']);
    expect(h.registry.get('club').state().status).toBe('live');
    expect(h.orch.state().status).toBe('offline');
  });

  it('add() runs a new profile right away', async () => {
    const { h, prepare } = twoProfiles();
    await h.registry.init();
    const late = profile('late', 'Late show');
    h.profiles.set(late.id, late);
    h.dests.set('l1', dest('l1', { profileId: 'late' }));
    await h.registry.add(late);
    h.media.set('landscape', true, null, 'late');
    await flush();
    expect(h.registry.get('late').state().status).toBe('live');
    expect(prepare.mock.calls.map((c) => c[0].id)).toEqual(['l1']);
  });

  it('get() picks up a profile that exists but was not added, and starts it when running', async () => {
    const { h } = twoProfiles();
    await h.registry.init();
    const extra = profile('extra', 'Extra');
    h.profiles.set(extra.id, extra);
    const orch = h.registry.get('extra');
    await flush();
    h.media.set('landscape', true, null, 'extra');
    await flush();
    expect(orch.state().status).toBe('live');
    expect(h.registry.get('extra')).toBe(orch);
  });

  it('remove() stops the profile’s session and forgets it, even before its row is deleted', async () => {
    const { h, club } = twoProfiles();
    await h.registry.init();
    h.media.set('landscape', true, null, 'club');
    await flush();
    h.pushes.running('c1');
    await flush();
    expect(club.state().status).toBe('live');

    await h.registry.remove('club');
    expect(club.state().status).toBe('offline');
    expect(h.pushes.stops).toContain('c1');
    expect(h.notices.at(-1)).toEqual({ level: 'info', message: 'DPRTMNT · Session stopped: profile deleted', profileId: 'club' });
    // The row still exists (the route deletes it afterwards): never re-created.
    expect(() => h.registry.get('club')).toThrow(expect.objectContaining({ code: 'unknown_profile' }));
    expect(h.registry.summaries().map((s) => s.id)).toEqual(['default']);
    expect(h.registry.all().map((o) => o.profileId)).toEqual(['default']);

    // Unsubscribed: its OBS coming back does nothing.
    h.media.set('landscape', false, null, 'club');
    h.media.set('landscape', true, null, 'club');
    await flush();
    expect(club.state().status).toBe('offline');

    await h.registry.remove('unknown'); // no-op
    await expect(h.registry.remove('default')).rejects.toMatchObject({ statusCode: 400, code: 'default_profile' });
  });

  it('summaries() lists every profile with its live situation', async () => {
    const twitch = driver('twitch', { prepare: async () => prepared(), requiredFeeds: () => ['landscape', 'vertical'] });
    const h = harness({
      dests: [
        dest('d1'),
        dest('d2', { enabled: false }),
        dest('c1', { profileId: 'club' }),
        dest('c2', { profileId: 'club', platform: 'twitch' }),
      ],
      drivers: [driver('custom', { prepare: async () => prepared() }), twitch],
      profiles: [CLUB],
    });
    await h.registry.init();
    expect(h.registry.summaries()).toEqual([
      {
        id: 'default',
        name: 'Main',
        slug: 'main',
        color: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        status: 'offline',
        startedAt: null,
        testMode: false,
        destinations: 1,
        live: 0,
        down: 0,
      },
      expect.objectContaining({ id: 'club', name: 'DPRTMNT', status: 'offline', destinations: 2, live: 0, down: 0 }),
    ]);

    // Club live: c1 live, c2 (Twitch needs both feeds) waiting for the vertical feed → down.
    h.media.set('landscape', true, null, 'club');
    await flush();
    h.pushes.running('c1');
    await flush();
    const club = h.registry.summaries()[1]!;
    expect(club).toMatchObject({ id: 'club', status: 'live', testMode: false, destinations: 2, live: 1, down: 1 });
    expect(club.startedAt).toEqual(expect.any(String));
    expect(h.registry.summaries()[0]).toMatchObject({ id: 'default', status: 'offline', live: 0, down: 0 });
  });

  it('summaries() does not count destinations skipped by test mode as down', async () => {
    const h = harness({
      dests: [dest('c1', { profileId: 'club' })],
      drivers: [driver('custom', { prepare: async () => prepared() })], // no test mode: skipped
      profiles: [CLUB],
      settings: { 'profile:club:session.testMode': true, 'profile:club:session.autoGoLive': false },
    });
    await h.registry.init();
    const club = h.registry.get('club');
    await club.start('manual');
    await flush();
    expect(h.phase('c1')).toBe('disabled');
    expect(h.registry.summaries()[1]).toMatchObject({ id: 'club', status: 'live', testMode: true, destinations: 1, live: 0, down: 0 });
  });

  it('shutdown() stops every profile', async () => {
    const { h, club } = twoProfiles();
    await h.registry.init();
    h.media.set('landscape', true, null, 'club');
    h.media.set('landscape', true);
    await flush();
    await h.registry.shutdown();
    expect(h.orch.state().status).toBe('offline');
    expect(club.state().status).toBe('offline');
    // Closed: nothing new is created or started.
    await h.registry.add(profile('after', 'After'));
    expect(h.registry.all().map((o) => o.profileId).sort()).toEqual(['club', 'default']);
  });
});

describe('profileParam', () => {
  it('reads ?profile= (default profile when omitted), null when malformed', () => {
    expect(profileParam({})).toBe('default');
    expect(profileParam(undefined)).toBe('default');
    expect(profileParam({ profile: '' })).toBe('default');
    expect(profileParam({ profile: 'club' })).toBe('club');
    expect(profileParam({ profile: ['a', 'b'] })).toBeNull();
    expect(profileParam({ profile: 'x'.repeat(101) })).toBeNull();
  });
});
