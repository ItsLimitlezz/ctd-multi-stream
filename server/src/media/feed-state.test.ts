import { describe, expect, it } from 'vitest';
import { describeTracks, FeedTracker, offlineFeedState, shouldEmitFeed, type MtxPath } from './feed-state.js';

const onlineItem = (bytes: number, extra: Partial<MtxPath> = {}): MtxPath => ({
  name: 'live/landscape',
  online: true,
  onlineTime: '2026-10-11T17:00:00Z',
  inboundBytes: bytes,
  tracks2: [
    { codec: 'H264', codecProps: { width: 1280, height: 720, profile: 'High', level: '3.1' } },
    { codec: 'MPEG-4 Audio', codecProps: { sampleRate: 48000, channelCount: 2 } },
  ],
  ...extra,
});

describe('describeTracks', () => {
  it('maps MediaMTX codec names and props', () => {
    expect(describeTracks(onlineItem(0).tracks2)).toEqual({
      video: { codec: 'h264', width: 1280, height: 720 },
      audio: { codec: 'aac', sampleRate: 48000, channels: 2 },
    });
    expect(describeTracks([{ codec: 'H265', codecProps: null }, { codec: 'Opus' }])).toEqual({
      video: { codec: 'hevc' },
      audio: { codec: 'opus' },
    });
    expect(describeTracks(undefined)).toEqual({ video: null, audio: null });
  });
});

describe('FeedTracker', () => {
  it('derives online state, since and bitrate from byte deltas', () => {
    const t = new FeedTracker('landscape');
    const s1 = t.update(onlineItem(0), 10_000);
    expect(s1).toMatchObject({ feed: 'landscape', online: true, since: '2026-10-11T17:00:00.000Z', bitrateKbps: null });
    expect(s1.video?.codec).toBe('h264');
    // 750_000 bytes in 1 s = 6000 kbit/s
    expect(t.update(onlineItem(750_000), 11_000).bitrateKbps).toBe(6000);
    // window spans 2 s: 1_500_000 bytes over 2 s
    expect(t.update(onlineItem(1_500_000), 12_000).bitrateKbps).toBe(6000);
  });

  it('falls back to deprecated ready/readyTime/bytesReceived fields', () => {
    const t = new FeedTracker('vertical');
    const item: MtxPath = { name: 'live/vertical', ready: true, readyTime: '2026-10-11T20:00:00.123456789+02:00', bytesReceived: 0, tracks2: [] };
    expect(t.update(item, 0)).toMatchObject({ online: true, since: '2026-10-11T18:00:00.123Z' });
    expect(t.update({ ...item, bytesReceived: 125_000 }, 1000).bitrateKbps).toBe(1000);
  });

  it('goes offline when the path is missing or not online, and resets the window on counter resets', () => {
    const t = new FeedTracker('landscape');
    t.update(onlineItem(1_000_000), 0);
    t.update(onlineItem(2_000_000), 1000);
    expect(t.update(onlineItem(10, { online: false }), 2000)).toEqual(offlineFeedState('landscape'));
    t.update(onlineItem(5_000_000), 3000);
    const s = t.update(onlineItem(100), 4000); // publisher reconnected: counter restarted
    expect(s.online).toBe(true);
    expect(s.bitrateKbps).toBeNull();
    expect(t.update(undefined, 5000).online).toBe(false);
  });
});

describe('shouldEmitFeed', () => {
  const base = { ...offlineFeedState('landscape'), online: true, since: 'x', video: { codec: 'h264' }, audio: null, bitrateKbps: 1000 };

  it('emits immediately for state/codec changes and the first state', () => {
    expect(shouldEmitFeed(null, base, 0, 0)).toBe(true);
    expect(shouldEmitFeed(base, { ...base, online: false }, 1000, 1001)).toBe(true);
    expect(shouldEmitFeed(base, { ...base, video: { codec: 'hevc' } }, 1000, 1001)).toBe(true);
    expect(shouldEmitFeed(base, { ...base, video: { codec: 'h264', width: 1920 } }, 1000, 1001)).toBe(true);
  });

  it('rate-limits bitrate-only changes to every 2 s', () => {
    expect(shouldEmitFeed(base, { ...base }, 0, 10_000)).toBe(false);
    expect(shouldEmitFeed(base, { ...base, bitrateKbps: 1200 }, 1000, 2500)).toBe(false);
    expect(shouldEmitFeed(base, { ...base, bitrateKbps: 1200 }, 1000, 3000)).toBe(true);
  });
});
