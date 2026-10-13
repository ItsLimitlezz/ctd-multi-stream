import { describe, expect, it } from 'vitest';
import { parseBitrate, parseProgressText, ProgressParser, toPushStats } from './ffmpeg-progress.js';

const block = (o: Record<string, string>) =>
  Object.entries({
    frame: '120',
    fps: '30.00',
    stream_0_0_q: '-1.0',
    bitrate: '2510.3kbits/s',
    total_size: '1254400',
    out_time_us: '4000000',
    out_time_ms: '4000000',
    out_time: '00:00:04.000000',
    dup_frames: '0',
    drop_frames: '0',
    speed: '1.00x',
    progress: 'continue',
    ...o,
  })
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

describe('parseBitrate', () => {
  it('handles units and N/A', () => {
    expect(parseBitrate('2510.3kbits/s')).toBe(2510.3);
    expect(parseBitrate('6.5Mbits/s')).toBe(6500);
    expect(parseBitrate('800bits/s')).toBe(0.8);
    expect(parseBitrate('N/A')).toBe(0);
    expect(parseBitrate(undefined)).toBe(0);
  });
});

describe('parseProgressText', () => {
  it('parses a full block', () => {
    expect(parseProgressText(block({}))).toEqual({
      bitrateKbps: 2510.3,
      fps: 30,
      speed: 1,
      outTimeUs: 4_000_000,
      totalSize: 1254400,
      frame: 120,
      dropFrames: 0,
      end: false,
    });
  });

  it('maps N/A and negative values to 0 and detects the end block', () => {
    const p = parseProgressText(block({ bitrate: 'N/A', speed: 'N/A', fps: '0.00', out_time_us: 'N/A', total_size: 'N/A', progress: 'end' }));
    expect(p).toMatchObject({ bitrateKbps: 0, speed: 0, fps: 0, outTimeUs: 0, totalSize: null, end: true });
    expect(parseProgressText('out_time_us=-9223372036854775807\nprogress=continue').outTimeUs).toBe(0);
  });

  it('converts to PushStats', () => {
    expect(toPushStats(parseProgressText(block({ out_time_us: '65500000' })))).toEqual({ bitrateKbps: 2510, fps: 30, speed: 1, uptimeSec: 65 });
  });
});

describe('ProgressParser', () => {
  it('emits one result per block, with the current bitrate from size deltas', () => {
    const parser = new ProgressParser();
    const feed = (text: string) => text.split('\n').map((l) => parser.push(l)).filter(Boolean);

    const first = feed(block({ total_size: '1000000', out_time_us: '2000000' }));
    expect(first).toHaveLength(1);
    expect(first[0]?.stats.bitrateKbps).toBe(2510); // no previous block: FFmpeg's average

    // 750_000 bytes over 1 s of media time = 6000 kbit/s
    const second = feed(block({ total_size: '1750000', out_time_us: '3000000' }));
    expect(second[0]?.stats.bitrateKbps).toBe(6000);
    expect(second[0]?.block.outTimeUs).toBe(3_000_000);
  });

  it('ignores junk lines and partial blocks', () => {
    const parser = new ProgressParser();
    expect(parser.push('')).toBeNull();
    expect(parser.push('garbage')).toBeNull();
    expect(parser.push('fps=25')).toBeNull();
    expect(parser.push('progress=continue')?.stats.fps).toBe(25);
  });
});
