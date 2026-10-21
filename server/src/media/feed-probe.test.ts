import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzePackets, ffprobePath, probeArgs, PROBE_SECONDS } from './feed-probe.js';
import { FeedTracker, type MtxPath } from './feed-state.js';

/** ffprobe-style "pts_time,flags" lines: `fps` frames per second, a keyframe every `gop` frames. */
function packets(fps: number, gop: number, seconds = PROBE_SECONDS): string {
  const lines: string[] = [];
  for (let i = 0; i < fps * seconds; i++) lines.push(`${(10 + i / fps).toFixed(6)},${i % gop === 0 ? 'K__' : '___'}`);
  return lines.join('\n');
}

describe('analyzePackets', () => {
  it('measures frame rate and the keyframe interval', () => {
    expect(analyzePackets(packets(30, 60))).toEqual({ fps: 30, keyframeSec: 2, keyframeSecIsMinimum: false });
    expect(analyzePackets(packets(60, 250))).toEqual({ fps: 60, keyframeSec: 4.2, keyframeSecIsMinimum: false }); // OBS "auto"
    expect(analyzePackets(packets(29.97, 60)).fps).toBeCloseTo(29.97, 1);
  });

  it('one keyframe in the whole window: "at least the window"; too little data: unknown', () => {
    expect(analyzePackets(packets(30, 100_000))).toEqual({ fps: 30, keyframeSec: 12, keyframeSecIsMinimum: true });
    expect(analyzePackets(packets(30, 100_000, 2))).toEqual({ fps: 30, keyframeSec: null, keyframeSecIsMinimum: false });
    expect(analyzePackets('')).toEqual({ fps: null, keyframeSec: null, keyframeSecIsMinimum: false });
    expect(analyzePackets('garbage\n,K\nN/A,K__')).toEqual({ fps: null, keyframeSec: null, keyframeSecIsMinimum: false });
  });

  it('runs ffprobe next to ffmpeg, reading packets only', () => {
    expect(ffprobePath('/opt/ctd/tools/ffmpeg')).toBe(path.join('/opt/ctd/tools', 'ffprobe'));
    expect(ffprobePath('C:\\ctd\\tools\\ffmpeg.exe').endsWith('ffprobe.exe')).toBe(true);
    expect(ffprobePath('ffmpeg')).toBe('ffprobe');
    expect(probeArgs('rtmp://x')).toEqual(expect.arrayContaining(['-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', 'rtmp://x']));
    expect(probeArgs('rtmp://x')).not.toContain('-show_frames'); // nothing decoded
  });
});

describe('FeedTracker measurements', () => {
  const item = (onlineTime: string): MtxPath => ({
    name: 'live/landscape',
    online: true,
    onlineTime,
    inboundBytes: 1000,
    tracks2: [{ codec: 'H264', codecProps: { width: 1920, height: 1080 } }],
  });

  it('merges into the video of the same OBS connection only', () => {
    const t = new FeedTracker('landscape');
    const s1 = t.update(item('2026-10-21T10:00:00Z'), 1000);
    const since = s1.since!;
    const merged = t.setMeasurements(since, { fps: 30, keyframeSec: 8.3, keyframeSecIsMinimum: false });
    expect(merged.video).toEqual({ codec: 'h264', width: 1920, height: 1080, fps: 30, keyframeSec: 8.3 });
    expect(t.update(item('2026-10-21T10:00:00Z'), 2000).video).toMatchObject({ fps: 30, keyframeSec: 8.3 }); // kept across polls
    // OBS reconnected: a new connection, measured again later.
    expect(t.update(item('2026-10-21T10:05:00Z'), 3000).video).toEqual({ codec: 'h264', width: 1920, height: 1080 });
    // A late result for the old connection is ignored.
    expect(t.setMeasurements(since, { fps: 60, keyframeSec: 2, keyframeSecIsMinimum: false }).video).not.toHaveProperty('keyframeSec');
  });
});
