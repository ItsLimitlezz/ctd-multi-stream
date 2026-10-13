import { describe, expect, it } from 'vitest';
import { buildPushArgs, capabilitiesFromVersion, MULTITRACK_UNSUPPORTED, parseFfmpegMajor } from './ffmpeg-args.js';

const inputs = { landscape: 'rtmp://127.0.0.1:1935/live/landscape?user=internal&pass=p', vertical: 'rtmp://127.0.0.1:1935/live/vertical?user=internal&pass=p' };
const out = 'rtmps://ingest.example.com:443/app/streamkey';

describe('buildPushArgs', () => {
  it('builds passthrough args for copy mode', () => {
    expect(buildPushArgs({ url: out, mode: 'copy', feeds: ['landscape'] }, inputs)).toEqual([
      '-hide_banner', '-nostdin', '-loglevel', 'warning', '-progress', 'pipe:1', '-stats_period', '2',
      '-rw_timeout', '15000000', '-i', inputs.landscape,
      '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-f', 'flv', '-flvflags', 'no_duration_filesize',
      out,
    ]);
  });

  it('appends extra output args right before the URL', () => {
    const args = buildPushArgs({ url: out, mode: 'copy', feeds: ['vertical'], extraOutputArgs: ['-bufsize', '1M'] }, inputs);
    expect(args.slice(-3)).toEqual(['-bufsize', '1M', out]);
    expect(args).toContain(inputs.vertical);
  });

  it('validates copy plans', () => {
    expect(() => buildPushArgs({ url: out, mode: 'copy', feeds: [] }, inputs)).toThrow(/exactly one feed/);
    expect(() => buildPushArgs({ url: out, mode: 'copy', feeds: ['landscape', 'vertical'] }, inputs)).toThrow(/exactly one feed/);
    expect(() => buildPushArgs({ url: out, mode: 'copy', feeds: ['vertical'] }, { landscape: 'x' })).toThrow(/No input URL/);
    expect(() => buildPushArgs({ url: '', mode: 'copy', feeds: ['landscape'] }, inputs)).toThrow(/output URL/);
  });

  it('builds E-FLV v2 multitrack args: primary video+audio, secondary video', () => {
    const args = buildPushArgs({ url: out, mode: 'multitrack', feeds: ['landscape', 'vertical'] }, inputs);
    const i = args.indexOf('-i');
    expect(args[i + 1]).toBe(inputs.landscape);
    expect(args[args.indexOf('-i', i + 1) + 1]).toBe(inputs.vertical);
    expect(args.join(' ')).toContain('-map 0:v:0 -map 0:a:0? -map 1:v:0');
    expect(args).toContain('-rtmp_enhanced_codecs');
    expect(args.at(-1)).toBe(out);
  });

  it('omits RTMP-only options for non-RTMP outputs', () => {
    const args = buildPushArgs({ url: 'out.flv', mode: 'multitrack', feeds: ['vertical', 'landscape'] }, inputs);
    expect(args).not.toContain('-rtmp_enhanced_codecs');
    expect(args[args.indexOf('-i') + 1]).toBe(inputs.vertical);
  });

  it('rejects bad multitrack plans and unsupported builds', () => {
    expect(() => buildPushArgs({ url: out, mode: 'multitrack', feeds: ['landscape'] }, inputs)).toThrow(/two different feeds/);
    expect(() => buildPushArgs({ url: out, mode: 'multitrack', feeds: ['landscape', 'landscape'] }, inputs)).toThrow(/two different feeds/);
    expect(() => buildPushArgs({ url: out, mode: 'multitrack', feeds: ['landscape', 'vertical'] }, inputs, { multitrack: false })).toThrow(
      MULTITRACK_UNSUPPORTED,
    );
  });
});

describe('FFmpeg capability detection', () => {
  it('parses release, BtbN and distro version strings', () => {
    expect(parseFfmpegMajor('ffmpeg version n8.1.3-9-g29e619e767-20260930 Copyright (c) 2000-2026')).toBe(8);
    expect(parseFfmpegMajor('ffmpeg version 7.1.1-1ubuntu1 Copyright')).toBe(7);
    expect(parseFfmpegMajor('garbage')).toBeNull();
  });

  it('enables multitrack for FFmpeg >= 8 and master builds', () => {
    expect(capabilitiesFromVersion('ffmpeg version n8.1.3-9-g29e619e767').multitrack).toBe(true);
    expect(capabilitiesFromVersion('ffmpeg version 8.0 Copyright').multitrack).toBe(true);
    expect(capabilitiesFromVersion('ffmpeg version 7.1.1 Copyright').multitrack).toBe(false);
    expect(capabilitiesFromVersion('ffmpeg version N-121000-gabcdef').multitrack).toBe(true);
  });
});
