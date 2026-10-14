import { describe, expect, it } from 'vitest';
import type { LiveHealthEvent } from '../types.js';
import {
  CANT_SEE_WARNING,
  classifyNotice,
  createHealthTracker,
  LIVE_GONE_REASON,
  LOGGED_OUT_WARNING,
  VIEWERS_UNAVAILABLE_WARNING,
  type HealthSample,
  type Notice,
} from './health.js';

const live = (patch: Partial<HealthSample> = {}): HealthSample => ({ state: 'live', notices: [], viewers: 5, ...patch });
const notice = (text: string, overlay = true): Notice => {
  const kind = classifyNotice(text);
  if (!kind) throw new Error(`not a notice: ${text}`);
  return { text, overlay, kind };
};

/** Feed samples every `stepMs` starting at t0; returns all events with their times. */
function run(tracker: ReturnType<typeof createHealthTracker>, samples: HealthSample[], stepMs = 2000, t0 = 0) {
  const out: { t: number; event: LiveHealthEvent }[] = [];
  samples.forEach((s, i) => {
    for (const event of tracker.next(s, t0 + i * stepMs)) out.push({ t: t0 + i * stepMs, event });
  });
  return out;
}

const NO_VIEWER_RULE = { zeroViewerMs: 0, graceMs: 60_000, liveSince: 0 };

describe('classifyNotice', () => {
  it('tells takedowns from warnings and connection trouble', () => {
    for (const text of [
      'LIVE ended',
      'Your LIVE has ended',
      'This LIVE has been ended because it may violate our Community Guidelines',
      'Your LIVE was removed for violating our Community Guidelines',
      "We've ended your LIVE",
      'Your LIVE access has been suspended for 14 days',
      'You are banned from going LIVE',
      'Your LIVE was interrupted',
      'LIVE interrupted: this content may infringe copyright',
      'Your LIVE has been paused due to copyrighted music',
    ]) {
      expect(classifyNotice(text), text).toBe('ended');
    }
    for (const text of [
      'Your LIVE may violate our Community Guidelines',
      'Copyrighted music detected. Your audio was muted.',
      'This content may be unoriginal',
    ]) {
      expect(classifyNotice(text), text).toBe('violation');
    }
    for (const text of [
      'Your LIVE was interrupted because of a poor network connection',
      'Poor network connection. Trying to reconnect…',
      'Stream disconnected',
    ]) {
      expect(classifyNotice(text), text).toBe('connection');
    }
    for (const text of ['End LIVE', 'Go LIVE', 'LIVE Producer', 'Community Guidelines', 'Ended', 'Viewers', 'LIVE title']) {
      expect(classifyNotice(text), text).toBeNull();
    }
  });

  it('treats a pause/interruption that waits for the stream as connection trouble, not a takedown', () => {
    for (const text of [
      'LIVE paused. Waiting for your stream to resume',
      'Your LIVE has been paused. Waiting for stream...',
      "LIVE interrupted. We haven't received any video",
      'Your LIVE was interrupted. We are not receiving video',
      'Your LIVE was paused. No video detected',
      'Your LIVE was paused. Check your streaming software',
      'LIVE interrupted. Please check your network connection',
    ]) {
      expect(classifyNotice(text), text).toBe('connection');
    }
    // Policy/copyright wording still makes it a takedown, even when it also waits for the stream.
    for (const text of [
      'Your LIVE has been paused due to copyrighted music',
      'LIVE paused: waiting for stream. This content may violate our Community Guidelines',
      'Your LIVE was interrupted for infringing copyright. Waiting for your stream',
      'Your LIVE was interrupted', // no reason given: still a takedown
      'LIVE paused',
    ]) {
      expect(classifyNotice(text), text).toBe('ended');
    }
    // The producer's own preview placeholder and stray "check" wording are not notices by themselves.
    for (const text of ['Waiting for stream...', 'Check your streaming software', 'Please check our Community Guidelines']) {
      expect(classifyNotice(text), text).toBeNull();
    }
  });
});

describe('Stream Guard health tracker', () => {
  it('reports a takedown banner at once, even right after going live', () => {
    const tracker = createHealthTracker({ zeroViewerMs: 5000, graceMs: 60_000, liveSince: 0 });
    const banner = notice('Your LIVE was ended because it may violate our Community Guidelines');
    const events = run(tracker, [live(), live({ notices: [banner] })]);
    expect(events).toEqual([
      { t: 2000, event: { type: 'ended', reason: 'Your LIVE was ended because it may violate our Community Guidelines' } },
    ]);
    expect(tracker.done).toBe(true);
    expect(tracker.next(live({ state: 'not-live' }), 4000)).toEqual([]); // done: nothing more
  });

  it('ignores "LIVE ended" text outside dialogs/toasts while the LIVE still runs', () => {
    const tracker = createHealthTracker(NO_VIEWER_RULE);
    const recentLives = notice('LIVE ended 2 hours ago', false);
    expect(run(tracker, [live({ notices: [recentLives] }), live({ notices: [recentLives] })])).toEqual([]);
  });

  it('reports the dashboard dropping out of the live state after two polls', () => {
    const tracker = createHealthTracker(NO_VIEWER_RULE);
    const events = run(tracker, [live(), live({ state: 'not-live' }), live({ state: 'not-live' })]);
    expect(events).toEqual([{ t: 4000, event: { type: 'ended', reason: LIVE_GONE_REASON } }]);
  });

  it('does not count a single flicker of the live state', () => {
    const tracker = createHealthTracker(NO_VIEWER_RULE);
    const flicker = [live(), live({ state: 'not-live' }), live(), live({ state: 'not-live' }), live()];
    expect(run(tracker, flicker)).toEqual([]);
  });

  it('ends at once when the non-live page explains why', () => {
    const tracker = createHealthTracker(NO_VIEWER_RULE);
    const page = live({ state: 'not-live', notices: [notice('Your LIVE has ended', false)] });
    expect(run(tracker, [page])).toEqual([{ t: 0, event: { type: 'ended', reason: 'Your LIVE has ended' } }]);
  });

  it('treats an unrecognizable page with an ended text like a lost live state', () => {
    const tracker = createHealthTracker(NO_VIEWER_RULE);
    const page = live({ state: 'unknown', notices: [notice('This LIVE has ended', false)] });
    expect(run(tracker, [page, page])).toEqual([{ t: 2000, event: { type: 'ended', reason: 'This LIVE has ended' } }]);
  });

  it('warns (no takedown) for violation warnings and connection notices while live', () => {
    const tracker = createHealthTracker(NO_VIEWER_RULE);
    const events = run(tracker, [
      live({ notices: [notice('Your LIVE may violate our Community Guidelines')] }),
      live({ notices: [notice('Your LIVE may violate our Community Guidelines')] }),
      live(),
      live({ notices: [notice('Your LIVE was interrupted because of a poor network connection')] }),
      live(),
    ]);
    expect(events.map((e) => e.event)).toEqual([
      { type: 'warning', message: 'TikTok warning: Your LIVE may violate our Community Guidelines' },
      { type: 'ok' },
      { type: 'warning', message: 'TikTok: Your LIVE was interrupted because of a poor network connection' },
      { type: 'ok' },
    ]);
    expect(tracker.done).toBe(false);
  });

  it('only warns for a "LIVE paused, waiting for your stream" dialog while live (OBS dropped out)', () => {
    const tracker = createHealthTracker(NO_VIEWER_RULE);
    const paused = notice('LIVE paused. Waiting for your stream to resume');
    expect(paused.kind).toBe('connection');
    const events = run(tracker, [live(), live({ notices: [paused] }), live({ notices: [paused] }), live({ notices: [paused] }), live()]);
    expect(events.map((e) => e.event)).toEqual([
      { type: 'warning', message: 'TikTok: LIVE paused. Waiting for your stream to resume' },
      { type: 'ok' },
    ]);
    expect(tracker.done).toBe(false);
  });

  it('warns when logged out or when the page is unrecognizable for a while', () => {
    const tracker = createHealthTracker(NO_VIEWER_RULE);
    const unknown = live({ state: 'unknown', viewers: null });
    const events = run(tracker, [live({ state: 'logged-out' }), live(), unknown, unknown, unknown, unknown, unknown, live()]);
    expect(events.map((e) => e.event)).toEqual([
      { type: 'warning', message: LOGGED_OUT_WARNING },
      { type: 'ok' },
      { type: 'warning', message: CANT_SEE_WARNING },
      { type: 'ok' },
    ]);
  });

  it('applies the 0-viewer rule only after the grace period', () => {
    const tracker = createHealthTracker({ zeroViewerMs: 5000, graceMs: 60_000, liveSince: 0 });
    // 0 viewers from the start: nothing during the 60 s grace, then 0 for 5 s ⇒ ended.
    const samples = Array.from({ length: 40 }, () => live({ viewers: 0 }));
    const events = run(tracker, samples);
    expect(events).toEqual([{ t: 66_000, event: { type: 'ended', reason: '0 viewers for 5 s' } }]);
  });

  it('resets the 0-viewer streak on any viewer or an unreadable count', () => {
    const tracker = createHealthTracker({ zeroViewerMs: 5000, graceMs: 0, liveSince: 0 });
    const zero = live({ viewers: 0 });
    // t=0..14 s: the streak restarts at 6 s (a viewer at 4 s) and at 12 s (unreadable at 10 s);
    // it then reaches 5 s of 0 viewers at 18 s.
    const samples = [zero, zero, live({ viewers: 1 }), zero, zero, live({ viewers: null }), zero, zero, zero, zero];
    expect(run(tracker, samples)).toEqual([{ t: 18_000, event: { type: 'ended', reason: '0 viewers for 5 s' } }]);
  });

  it('never fires the viewer rule on an unreadable count, and says so', () => {
    const tracker = createHealthTracker({ zeroViewerMs: 2000, graceMs: 0, liveSince: 0 });
    const unreadable = live({ viewers: null });
    const events = run(tracker, Array.from({ length: 20 }, () => unreadable));
    expect(events.map((e) => e.event)).toEqual([{ type: 'warning', message: VIEWERS_UNAVAILABLE_WARNING }]);
    expect(run(tracker, [live({ viewers: 4 })], 2000, 50_000).map((e) => e.event)).toEqual([{ type: 'ok' }]);
  });

  it('has no viewer rule when it is off', () => {
    const tracker = createHealthTracker({ zeroViewerMs: 0, graceMs: 0, liveSince: 0 });
    expect(run(tracker, Array.from({ length: 50 }, () => live({ viewers: 0 })))).toEqual([]);
    expect(run(tracker, Array.from({ length: 10 }, () => live({ viewers: null })), 2000, 200_000)).toEqual([]);
  });

  it('clips long reasons', () => {
    const tracker = createHealthTracker(NO_VIEWER_RULE);
    const long = `Your LIVE was ended because ${'it may violate our Community Guidelines '.repeat(10)}`;
    const [event] = tracker.next(live({ notices: [notice(long)] }), 0);
    expect(event?.type).toBe('ended');
    if (event?.type === 'ended') {
      expect(event.reason.length).toBeLessThanOrEqual(160);
      expect(event.reason.endsWith('…')).toBe(true);
    }
  });
});
