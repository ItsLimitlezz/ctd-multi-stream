import { describe, expect, it } from 'vitest';
import { elapsedSeconds, formatAudio, formatBitrate, formatCodecs, formatDuration, formatFps, formatResolution, plural } from './format';

describe('format', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(75.9)).toBe('01:15');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(-5)).toBe('00:00');
    expect(formatDuration(Number.NaN)).toBe('00:00');
  });

  it('computes elapsed time', () => {
    const now = Date.parse('2026-10-11T10:01:00.000Z');
    expect(elapsedSeconds('2026-10-11T10:00:00.000Z', now)).toBe(60);
    expect(elapsedSeconds('2026-10-11T10:02:00.000Z', now)).toBe(0);
    expect(elapsedSeconds(null, now)).toBe(0);
    expect(elapsedSeconds('garbage', now)).toBe(0);
  });

  it('formats bitrates and frame rates', () => {
    expect(formatBitrate(850.4)).toBe('850 kbps');
    expect(formatBitrate(4500)).toBe('4.5 Mbps');
    expect(formatBitrate(6000)).toBe('6 Mbps');
    expect(formatBitrate(12345)).toBe('12 Mbps');
    expect(formatBitrate(null)).toBe('—');
    expect(formatFps(30)).toBe('30 fps');
    expect(formatFps(29.97)).toBe('29.97 fps');
    expect(formatFps(undefined)).toBe('—');
  });

  it('formats video and audio specs', () => {
    expect(formatResolution(1920, 1080)).toBe('1920×1080');
    expect(formatResolution(undefined, 1080)).toBe('—');
    expect(formatCodecs({ video: { codec: 'h264' }, audio: { codec: 'aac' } })).toBe('H264 / AAC');
    expect(formatCodecs({ video: null, audio: null })).toBe('—');
    expect(formatAudio({ codec: 'aac', sampleRate: 48000, channels: 2 })).toBe('AAC · 48 kHz · stereo');
    expect(formatAudio({ codec: 'opus', sampleRate: 44100, channels: 1 })).toBe('OPUS · 44.1 kHz · mono');
    expect(formatAudio(null)).toBe('—');
  });

  it('pluralizes', () => {
    expect(plural(1, 'destination')).toBe('1 destination');
    expect(plural(3, 'destination')).toBe('3 destinations');
  });
});
