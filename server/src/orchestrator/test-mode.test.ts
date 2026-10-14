// Session test mode: the switch (offline only), skipped destinations, ctx.testMode for the rest.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, Destination, PlatformInfo } from '../../../shared/types.js';
import { DriverError, type PreparedLive } from '../platforms/types.js';
import { advance, dest, driver, flush, goLive, harness, prepared } from './test-helpers.js';
import { hasChannelTitle, supportsTestMode, TEST_MODE_CHANNEL_TITLE, testModeSkipMessage } from './test-mode.js';

const SUPPORTED: Partial<PlatformInfo> = { testMode: { supported: true, description: 'Private' } };
const UNSUPPORTED: Partial<PlatformInfo> = { testMode: { supported: false, description: 'No test mode' } };

function account(id: string, mode: 'page' | 'profile'): Account {
  return {
    id,
    platform: 'facebook',
    label: id,
    status: 'connected',
    statusMessage: null,
    options: { mode },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Twitch (supported), Kick (unsupported) and Facebook (page yes, profile no), each with its own prepare mock. */
function setup(settings: Record<string, unknown> = {}, extraDests: Destination[] = []) {
  const prepares = {
    twitch: vi.fn(async (_d: Destination, _a: Account | null, _t: string): Promise<PreparedLive> => prepared()),
    kick: vi.fn(async (_d: Destination, _a: Account | null, _t: string): Promise<PreparedLive> => prepared()),
    facebook: vi.fn(async (_d: Destination, _a: Account | null, _t: string): Promise<PreparedLive> => prepared()),
  };
  const fbSupports = vi.fn((_d: Destination, a: Account | null) => a?.options.mode === 'page');
  const h = harness({
    dests: [
      dest('tw', { platform: 'twitch', name: 'Twitch' }),
      dest('ki', { platform: 'kick', name: 'Kick' }),
      dest('fbp', { platform: 'facebook', name: 'FB page', accountId: 'acc-page' }),
      dest('fbq', { platform: 'facebook', name: 'FB profile', accountId: 'acc-profile' }),
      ...extraDests,
    ],
    drivers: [
      driver('twitch', { prepare: prepares.twitch }, { name: 'Twitch', ...SUPPORTED }),
      driver('kick', { prepare: prepares.kick }, { name: 'Kick', ...UNSUPPORTED }),
      driver('facebook', { prepare: prepares.facebook, supportsTestMode: fbSupports }, { name: 'Facebook', ...SUPPORTED }),
    ],
    accounts: [account('acc-page', 'page'), account('acc-profile', 'profile')],
    settings,
  });
  return { h, prepares, fbSupports };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('supportsTestMode', () => {
  it('asks the driver first, else PlatformInfo.testMode.supported (missing = unsupported)', () => {
    const d = dest('x');
    expect(supportsTestMode(driver('custom', { prepare: async () => prepared() }), d, null)).toBe(false);
    expect(supportsTestMode(driver('custom', { prepare: async () => prepared() }, SUPPORTED), d, null)).toBe(true);
    expect(supportsTestMode(driver('custom', { prepare: async () => prepared() }, UNSUPPORTED), d, null)).toBe(false);
    expect(supportsTestMode(driver('custom', { prepare: async () => prepared(), supportsTestMode: () => false }, SUPPORTED), d, null)).toBe(false);
    expect(supportsTestMode(driver('custom', { prepare: async () => prepared(), supportsTestMode: () => true }, UNSUPPORTED), d, null)).toBe(true);
    expect(testModeSkipMessage('Kick')).toBe('Skipped — Kick has no test mode');
  });

  it('hasChannelTitle: platforms that edit the title outside a live (setTitleOffline)', () => {
    expect(hasChannelTitle(driver('twitch', { prepare: async () => prepared(), setTitleOffline: async () => {} }))).toBe(true);
    expect(hasChannelTitle(driver('youtube', { prepare: async () => prepared() }))).toBe(false);
  });
});

describe('the test-mode switch', () => {
  it('defaults to off, persists, emits the session and survives a restart', async () => {
    const { h } = setup();
    await h.orch.init();
    expect(h.orch.state().testMode).toBe(false);

    h.orch.setTestMode(true);
    expect(h.orch.state().testMode).toBe(true);
    expect(h.settings.get('session.testMode')).toBe(true);
    expect(h.sessionEvents.at(-1)?.testMode).toBe(true);

    const events = h.sessionEvents.length;
    h.orch.setTestMode(true); // unchanged: no event
    expect(h.sessionEvents).toHaveLength(events);

    // A new orchestrator (restart) loads it from the settings.
    const again = setup({ 'session.testMode': true });
    await again.h.orch.init();
    expect(again.h.orch.state().testMode).toBe(true);
    // Anything but a stored `true` reads as off.
    const odd = setup({ 'session.testMode': 'yes' });
    expect(odd.h.orch.state().testMode).toBe(false);
  });

  it('refuses with 409 session_live while a session runs or stops, and works again once offline', async () => {
    const { h } = setup();
    await goLive(h, ['tw', 'ki', 'fbp', 'fbq']);
    expect(h.orch.state().status).toBe('live');
    let caught: unknown;
    try {
      h.orch.setTestMode(true);
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ statusCode: 409, code: 'session_live' });
    expect(h.orch.state().testMode).toBe(false);
    expect(h.settings.has('session.testMode')).toBe(false);

    // While stopping (end() still running).
    const slow = setup();
    let finishEnd!: () => void;
    slow.prepares.twitch.mockResolvedValue(prepared({ end: vi.fn(() => new Promise<void>((r) => (finishEnd = r))) }));
    await goLive(slow.h, ['tw', 'ki', 'fbp', 'fbq']);
    const stopping = slow.h.orch.stop();
    await flush();
    expect(slow.h.orch.state().status).toBe('stopping');
    expect(() => slow.h.orch.setTestMode(true)).toThrow(/End the stream first/);
    finishEnd();
    await stopping;
    slow.h.orch.setTestMode(true);
    expect(slow.h.orch.state().testMode).toBe(true);

    await h.orch.stop();
    h.orch.setTestMode(true);
    expect(h.orch.state().testMode).toBe(true);
  });
});

describe('a session in test mode', () => {
  it('prepares supported destinations with ctx.testMode and skips the others (never prepared)', async () => {
    const { h, prepares, fbSupports } = setup({ 'session.testMode': true });
    await goLive(h, ['tw', 'fbp']);

    expect(prepares.twitch).toHaveBeenCalledTimes(1);
    expect(prepares.facebook).toHaveBeenCalledTimes(1);
    expect(prepares.facebook.mock.calls[0]?.[0]).toMatchObject({ id: 'fbp' });
    expect(prepares.kick).not.toHaveBeenCalled();
    // supportsTestMode got the destination's account.
    expect(fbSupports).toHaveBeenCalledWith(expect.objectContaining({ id: 'fbq' }), expect.objectContaining({ id: 'acc-profile' }));

    expect(h.phase('tw')).toBe('live');
    expect(h.phase('fbp')).toBe('live');
    expect(h.destState('ki')).toMatchObject({ phase: 'disabled', message: 'Skipped — Kick has no test mode' });
    expect(h.destState('fbq')).toMatchObject({ phase: 'disabled', message: 'Skipped — Facebook has no test mode' });
    // Skipped destinations never push, and stay skipped through feed changes.
    expect(h.pushes.starts.map((s) => s.id).sort()).toEqual(['fbp', 'tw']);
    h.media.set('landscape', false);
    await flush();
    h.media.set('landscape', true);
    await flush();
    expect(h.phase('ki')).toBe('disabled');
    expect(prepares.kick).not.toHaveBeenCalled();
    // Skipping is not an error: no error notice.
    expect(h.notices.filter((n) => n.level === 'error')).toEqual([]);

    // Every prepared live got ctx.testMode = true.
    expect(h.contexts.length).toBeGreaterThan(0);
    expect(h.contexts.every((c) => c.testMode === true)).toBe(true);

    // Stopping returns the skipped ones to idle with no message.
    await h.orch.stop();
    expect(h.destState('ki')).toMatchObject({ phase: 'idle', message: null });
    expect(h.destState('fbq')).toMatchObject({ phase: 'idle', message: null });
  });

  it('without test mode every destination is prepared and ctx.testMode is not set', async () => {
    const { h, prepares } = setup();
    await goLive(h, ['tw', 'ki', 'fbp', 'fbq']);
    expect(prepares.kick).toHaveBeenCalledTimes(1);
    expect(prepares.facebook).toHaveBeenCalledTimes(2);
    expect(h.contexts.some((c) => c.testMode === true)).toBe(false);
    expect(h.orch.state().destinations.every((d) => d.phase === 'live')).toBe(true);
  });

  it('a platform without PlatformInfo.testMode is skipped', async () => {
    const prepare = vi.fn(async () => prepared());
    const h = harness({
      dests: [dest('c1', { platform: 'custom', name: 'Custom' })],
      drivers: [driver('custom', { prepare }, { name: 'Custom RTMP' })],
      settings: { 'session.testMode': true },
    });
    await goLive(h, []);
    expect(prepare).not.toHaveBeenCalled();
    expect(h.destState('c1')).toMatchObject({ phase: 'disabled', message: 'Skipped — Custom RTMP has no test mode' });
  });

  it('a throwing supportsTestMode skips the destination', async () => {
    const prepare = vi.fn(async () => prepared());
    const h = harness({
      dests: [dest('f1', { platform: 'facebook', name: 'FB' })],
      drivers: [
        driver('facebook', { prepare, supportsTestMode: () => { throw new Error('bad account options'); } }, { name: 'Facebook', ...SUPPORTED }),
      ],
      settings: { 'session.testMode': true },
    });
    await goLive(h, []);
    expect(prepare).not.toHaveBeenCalled();
    expect(h.phase('f1')).toBe('disabled');
  });

  it('a destination enabled mid-session is skipped too; retry re-checks and skips again', async () => {
    const { h, prepares } = setup({ 'session.testMode': true }, [dest('ki2', { platform: 'kick', name: 'Kick 2', enabled: false })]);
    await goLive(h, ['tw', 'fbp']);
    expect(h.phase('ki2')).toBe('disabled');
    expect(h.destState('ki2').message).toBeNull();

    h.dests.set('ki2', { ...h.dests.get('ki2')!, enabled: true });
    await h.orch.destinationChanged('ki2');
    await flush();
    expect(h.destState('ki2')).toMatchObject({ phase: 'disabled', message: 'Skipped — Kick has no test mode' });

    await h.orch.retryDestination('ki');
    await flush();
    expect(h.destState('ki')).toMatchObject({ phase: 'disabled', message: 'Skipped — Kick has no test mode' });
    expect(prepares.kick).not.toHaveBeenCalled();
  });

  it('a destination that loses test-mode support before a prepare is never prepared publicly', async () => {
    const { h, prepares, fbSupports } = setup({ 'session.testMode': true, 'session.autoGoLive': false });
    await h.orch.init();
    await h.orch.start('manual');
    await flush();
    expect(h.phase('fbp')).toBe('waiting-for-feed'); // passed the start check
    fbSupports.mockReturnValue(false); // e.g. the account was switched to profile mode
    h.media.set('landscape', true);
    await flush();
    expect(prepares.facebook).not.toHaveBeenCalled();
    expect(h.phase('fbp')).toBe('error');
    expect(h.destState('fbp').message).toContain('Skipped — Facebook has no test mode');
    await advance(10 * 60_000);
    expect(prepares.facebook).not.toHaveBeenCalled(); // no retries
  });

  it('live title changes report skipped destinations as skipped', async () => {
    const setTitle = vi.fn(async () => {});
    const { h, prepares } = setup({ 'session.testMode': true });
    prepares.twitch.mockResolvedValue(prepared({ setTitle }));
    await goLive(h, ['tw', 'fbp']);
    const results = await h.orch.setTitle('Testing 1 2 3');
    expect(results.find((r) => r.destinationId === 'tw')).toEqual({ destinationId: 'tw', ok: true });
    expect(results.find((r) => r.destinationId === 'ki')).toEqual({ destinationId: 'ki', ok: true, skipped: true, error: 'Skipped in test mode' });
    expect(setTitle).toHaveBeenCalledWith('Testing 1 2 3', expect.anything());
  });

  it('offline title changes never touch a channel title while test mode is on (supported platforms included)', async () => {
    const twitchOffline = vi.fn(async () => {});
    const kickOffline = vi.fn(async () => {});
    const h = harness({
      dests: [dest('tw', { platform: 'twitch' }), dest('ki', { platform: 'kick' })],
      drivers: [
        driver('twitch', { prepare: async () => prepared(), setTitleOffline: twitchOffline }, { name: 'Twitch', ...SUPPORTED }),
        driver('kick', { prepare: async () => prepared(), setTitleOffline: kickOffline }, { name: 'Kick', ...UNSUPPORTED }),
      ],
      settings: { 'session.autoGoLive': false },
    });
    await h.orch.init();
    h.orch.setTestMode(true);
    const results = await h.orch.setTitle('Rehearsal');
    // A Twitch bandwidth test is private, but the channel title is public: left alone.
    expect(twitchOffline).not.toHaveBeenCalled();
    expect(kickOffline).not.toHaveBeenCalled();
    for (const id of ['tw', 'ki']) {
      expect(results.find((r) => r.destinationId === id)).toEqual({ destinationId: id, ok: true, skipped: true, error: TEST_MODE_CHANNEL_TITLE });
    }
    // The title itself is saved for later.
    expect(h.orch.state().title).toBe('Rehearsal');

    h.orch.setTestMode(false);
    await h.orch.setTitle('Real show');
    expect(twitchOffline).toHaveBeenCalledTimes(1);
    expect(kickOffline).toHaveBeenCalledTimes(1);
  });

  it('a channel title is not changed by a test-mode prepare or by live title changes; per-live titles are', async () => {
    const twitchLive = vi.fn(async (_t: string) => {});
    const twitchPrepare = vi.fn(async (_d: Destination, _a: Account | null, _t: string): Promise<PreparedLive> => prepared({ setTitle: twitchLive }));
    const ytLive = vi.fn(async (_t: string) => {});
    const ytPrepare = vi.fn(async (_d: Destination, _a: Account | null, _t: string): Promise<PreparedLive> => prepared({ setTitle: ytLive }));
    const h = harness({
      dests: [dest('tw', { platform: 'twitch' }), dest('yt', { platform: 'youtube' })],
      drivers: [
        // Twitch has a channel title (setTitleOffline); a YouTube title belongs to the private broadcast.
        driver('twitch', { prepare: twitchPrepare, setTitleOffline: async () => {} }, { name: 'Twitch', ...SUPPORTED }),
        driver('youtube', { prepare: ytPrepare }, { name: 'YouTube', ...SUPPORTED }),
      ],
      settings: { 'session.testMode': true, 'session.title': 'Rehearsal' },
    });
    await goLive(h, ['tw', 'yt']);
    expect(h.phase('tw')).toBe('live');
    // '' = leave the channel title as it is (what drivers do when no title was ever set).
    expect(twitchPrepare.mock.calls[0]?.[2]).toBe('');
    expect(ytPrepare.mock.calls[0]?.[2]).toBe('Rehearsal');

    const results = await h.orch.setTitle('Rehearsal 2');
    expect(twitchLive).not.toHaveBeenCalled();
    expect(results.find((r) => r.destinationId === 'tw')).toEqual({ destinationId: 'tw', ok: true, skipped: true, error: TEST_MODE_CHANNEL_TITLE });
    expect(ytLive).toHaveBeenCalledWith('Rehearsal 2', expect.anything());
    expect(results.find((r) => r.destinationId === 'yt')).toEqual({ destinationId: 'yt', ok: true });

    // Outside test mode the channel title follows the session title again.
    await h.orch.stop();
    h.orch.setTestMode(false);
    await h.orch.start('manual');
    await flush();
    expect(twitchPrepare).toHaveBeenCalledTimes(2);
    expect(twitchPrepare.mock.calls[1]?.[2]).toBe('Rehearsal 2');
  });

  it('a title edit during a test-mode prepare is not pushed to the channel afterwards', async () => {
    let finish!: (p: PreparedLive) => void;
    const twitchLive = vi.fn(async (_t: string) => {});
    const twitchPrepare = vi.fn(() => new Promise<PreparedLive>((r) => (finish = r)));
    const h = harness({
      dests: [dest('tw', { platform: 'twitch' })],
      drivers: [driver('twitch', { prepare: twitchPrepare, setTitleOffline: async () => {} }, { name: 'Twitch', ...SUPPORTED })],
      settings: { 'session.testMode': true, 'session.title': 'Before' },
    });
    await h.orch.init();
    h.media.set('landscape', true);
    await flush();
    expect(h.phase('tw')).toBe('preparing');
    await h.orch.setTitle('During');
    finish(prepared({ setTitle: twitchLive }));
    await flush();
    expect(twitchLive).not.toHaveBeenCalled();
  });
});
