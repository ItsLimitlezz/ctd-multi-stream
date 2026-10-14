// HealthMonitor decision logic with a fake clock (no browser).

import { describe, expect, it } from 'vitest';
import type { LiveHealthEvent } from '../types.js';
import {
  DEFAULT_HEALTH_TIMINGS,
  HealthMonitor,
  PAGE_CLOSED_WARNING,
  SESSION_EXPIRED_WARNING,
  VIEWERS_UNAVAILABLE_WARNING,
  type HealthSnapshot,
  type LiveMarks,
  type MonitorConfig,
} from './health.js';

const LIVE: HealthSnapshot = {
  closed: false,
  loggedOut: false,
  endedText: null,
  warningText: null,
  live: true,
  setup: false,
  viewers: 4,
};

function monitor(patch: Partial<MonitorConfig> = {}, marks: LiveMarks = { liveAt: 0, sawLive: false }) {
  return new HealthMonitor({
    audience: 'public',
    zeroViewerSec: 5,
    timings: DEFAULT_HEALTH_TIMINGS,
    startedAt: 0,
    marks,
    ...patch,
  });
}

/** Feed `snap` every 2 s from `from` to `to` (inclusive); returns [time, event] pairs. */
function run(m: HealthMonitor, snap: Partial<HealthSnapshot>, from: number, to: number): [number, LiveHealthEvent][] {
  const out: [number, LiveHealthEvent][] = [];
  for (let t = from; t <= to; t += 2_000) for (const ev of m.step({ ...LIVE, ...snap }, t)) out.push([t, ev]);
  return out;
}

describe('HealthMonitor', () => {
  it('a takedown notice is a hard signal: ended at once, even inside the grace', () => {
    const m = monitor();
    expect(m.step(LIVE, 1_000)).toEqual([]);
    expect(m.step({ ...LIVE, endedText: '  Your live video was removed   because it may go against our Community Guidelines ' }, 3_000)).toEqual([
      { type: 'ended', reason: 'Your live video was removed because it may go against our Community Guidelines' },
    ]);
    expect(m.step({ ...LIVE, endedText: 'again' }, 5_000)).toEqual([]); // nothing after an end
  });

  it('producer back at setup after being live → ended after setupBackMs', () => {
    const marks = { liveAt: 0, sawLive: false };
    const m = monitor({ zeroViewerSec: 0 }, marks);
    expect(m.step(LIVE, 0)).toEqual([]);
    expect(marks.sawLive).toBe(true);
    const events = run(m, { live: false, setup: true, viewers: null }, 2_000, 10_000);
    expect(events).toEqual([[6_000, { type: 'ended', reason: 'the Instagram producer is back at the setup screen' }]]);
  });

  it('End button gone with no recognizable state → ended only after liveLostMs', () => {
    const m = monitor({ zeroViewerSec: 0 });
    m.step(LIVE, 0);
    const events = run(m, { live: false, viewers: null }, 2_000, 40_000);
    expect(events).toHaveLength(1);
    expect(events[0]![0]).toBe(22_000);
    expect(events[0]![1]).toMatchObject({ type: 'ended', reason: expect.stringMatching(/left the live/) });
  });

  it('never treats a missing End button as an end when it was never seen (unknown UI)', () => {
    const m = monitor({ zeroViewerSec: 0 });
    expect(run(m, { live: false, setup: true }, 0, 120_000)).toEqual([]);
  });

  it('the End button coming back cancels the state-loss timer', () => {
    const m = monitor({ zeroViewerSec: 0 });
    m.step(LIVE, 0);
    expect(m.step({ ...LIVE, live: false, setup: true }, 2_000)).toEqual([]);
    expect(m.step(LIVE, 4_000)).toEqual([]);
    expect(m.step({ ...LIVE, live: false, setup: true }, 6_000)).toEqual([]);
    expect(m.step({ ...LIVE, live: false, setup: true }, 8_000)).toEqual([]);
    expect(m.step({ ...LIVE, live: false, setup: true }, 10_000)).toMatchObject([{ type: 'ended' }]);
  });

  it('0 viewers (Public, zeroViewerSec=5) fires only after the 60 s grace', () => {
    const m = monitor();
    // Inside the grace: 0 viewers for 58 s never fires.
    expect(run(m, { viewers: 0 }, 0, 58_000)).toEqual([]);
    // From 60 s the 5 s count starts.
    const events = run(m, { viewers: 0 }, 60_000, 80_000);
    expect(events).toEqual([[66_000, { type: 'ended', reason: '0 viewers for 5 s' }]]);
  });

  it('the grace counts from go-live (marks.liveAt), not from when health started', () => {
    const m = monitor({ startedAt: 100_000 }, { liveAt: 10_000, sawLive: true });
    expect(run(m, { viewers: 0 }, 70_000, 76_000)).toEqual([[76_000, { type: 'ended', reason: '0 viewers for 5 s' }]]);
  });

  it('a viewer joining resets the zero-viewer timer', () => {
    const m = monitor();
    expect(m.step({ ...LIVE, viewers: 0 }, 60_000)).toEqual([]);
    expect(m.step({ ...LIVE, viewers: 0 }, 64_000)).toEqual([]);
    expect(m.step({ ...LIVE, viewers: 1 }, 66_000)).toEqual([]);
    expect(m.step({ ...LIVE, viewers: 0 }, 68_000)).toEqual([]);
    expect(m.step({ ...LIVE, viewers: 0 }, 72_000)).toEqual([]);
    expect(m.step({ ...LIVE, viewers: 0 }, 74_000)).toEqual([{ type: 'ended', reason: '0 viewers for 5 s' }]);
  });

  it('Practice never fires the viewer rule; zeroViewerSec=0 = off', () => {
    expect(run(monitor({ audience: 'practice' }), { viewers: 0 }, 0, 600_000)).toEqual([]);
    expect(run(monitor({ zeroViewerSec: 0 }), { viewers: 0 }, 0, 600_000)).toEqual([]);
  });

  it('an unreadable count never fires; one warning after a while, ok when readable again', () => {
    const m = monitor();
    const events = run(m, { viewers: null }, 0, 200_000);
    expect(events).toEqual([[80_000, { type: 'warning', message: VIEWERS_UNAVAILABLE_WARNING }]]);
    expect(m.step({ ...LIVE, viewers: 3 }, 202_000)).toEqual([{ type: 'ok' }]);
    expect(m.step({ ...LIVE, viewers: 3 }, 204_000)).toEqual([]);
  });

  it('logged out → warning, never ended (no recovery into a logged-out browser)', () => {
    const m = monitor();
    m.step(LIVE, 0);
    const events = run(m, { loggedOut: true, live: false, setup: true, endedText: 'Your live video has ended', viewers: 0 }, 70_000, 200_000);
    expect(events).toEqual([[70_000, { type: 'warning', message: SESSION_EXPIRED_WARNING }]]);
    expect(m.step(LIVE, 202_000)).toEqual([{ type: 'ok' }]);
  });

  it('closed page → one warning', () => {
    const m = monitor();
    expect(run(m, { closed: true }, 0, 20_000)).toEqual([[0, { type: 'warning', message: PAGE_CLOSED_WARNING }]]);
  });

  it('soft notices and the link problem are warnings; ok once they clear', () => {
    let linkProblem: string | null = "Couldn't add the link";
    const m = monitor({ extraWarning: () => linkProblem });
    expect(m.step(LIVE, 0)).toEqual([{ type: 'warning', message: "Couldn't add the link" }]);
    expect(m.step({ ...LIVE, warningText: 'Your live video will be removed soon if you continue' }, 2_000)).toEqual([
      { type: 'warning', message: 'Instagram: "Your live video will be removed soon if you continue"' },
    ]);
    expect(m.step(LIVE, 4_000)).toEqual([{ type: 'warning', message: "Couldn't add the link" }]);
    linkProblem = null;
    expect(m.step(LIVE, 6_000)).toEqual([{ type: 'ok' }]);
    expect(m.step(LIVE, 8_000)).toEqual([]);
  });
});
