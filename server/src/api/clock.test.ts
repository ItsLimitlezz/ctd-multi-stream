import { describe, expect, it } from 'vitest';
import { buildClock, clockFps, formatTimecode, nominalFps, parseT0 } from './clock.js';
import type { ApiFeed } from './types.js';

const feed = (name: ApiFeed['feed'], fps?: number, online = true): ApiFeed => ({
  feed: name,
  online,
  since: null,
  video: fps === undefined ? null : { codec: 'H264', width: 1920, height: 1080, fps },
  audio: null,
  bitrateKbps: null,
});

describe('timecode', () => {
  it('formats HH:MM:SS:FF, hours past 24 for run time', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00:00');
    expect(formatTimecode(3_723_500, 30)).toBe('01:02:03:15');
    expect(formatTimecode(999, 60)).toBe('00:00:00:59');
    expect(formatTimecode(26 * 3_600_000, 30)).toBe('26:00:00:00');
    expect(formatTimecode(-5, 30)).toBe('00:00:00:00');
  });

  it('uses the nominal integer rate of the feeds, landscape first', () => {
    expect(nominalFps(29.97)).toBe(30);
    expect(nominalFps(59.94)).toBe(60);
    expect(nominalFps(0)).toBeNull();
    expect(nominalFps('30')).toBeNull();
    expect(clockFps([feed('landscape', 59.94), feed('vertical', 30)])).toEqual({ fps: 60, source: 'landscape' });
    expect(clockFps([feed('landscape', 60, false), feed('vertical', 30)])).toEqual({ fps: 30, source: 'vertical' });
    expect(clockFps([feed('landscape'), feed('vertical')])).toEqual({ fps: 30, source: 'default' });
  });
});

describe('buildClock', () => {
  const sentAt = Date.parse('2026-10-17T03:41:05.500Z');

  it('live: run time from the session start, UTC time of day, the echoed t0', () => {
    const c = buildClock({
      t0: 1234.5,
      receivedAt: sentAt - 2,
      sentAt,
      profileId: 'default',
      session: { status: 'live', startedAt: '2026-10-17T03:37:45.000Z' },
      feeds: [feed('landscape', 30)],
    });
    expect(c).toMatchObject({
      t0: 1234.5,
      receivedAt: sentAt - 2,
      sentAt,
      iso: '2026-10-17T03:41:05.500Z',
      profileId: 'default',
      session: { status: 'live', startedAt: Date.parse('2026-10-17T03:37:45.000Z'), elapsedMs: 200_500 },
      fps: 30,
      fpsSource: 'landscape',
      timecode: { run: '00:03:20:15', utc: '03:41:05:15' },
    });
    expect(c.timecode.local).toMatch(/^\d{2}:\d{2}:\d{2}:\d{2}$/);
    expect(c.utcOffsetMinutes).toBe(-new Date(sentAt).getTimezoneOffset());
  });

  it('offline: no run time', () => {
    const c = buildClock({ t0: null, receivedAt: sentAt, sentAt, profileId: 'p', session: { status: 'offline', startedAt: null }, feeds: [] });
    expect(c.session).toEqual({ status: 'offline', startedAt: null, elapsedMs: null });
    expect(c.timecode.run).toBeNull();
    expect(c.t0).toBeNull();
  });
});

describe('parseT0', () => {
  it('accepts epoch ms (with fractions); absent is null; junk is invalid', () => {
    expect(parseT0(undefined)).toBeNull();
    expect(parseT0('')).toBeNull();
    expect(parseT0('1791830000123')).toBe(1791830000123);
    expect(parseT0('1791830000123.25')).toBe(1791830000123.25);
    for (const bad of ['-1', 'abc', '1e12', ['1', '2']]) expect(parseT0(bad)).toBeUndefined();
  });
});
