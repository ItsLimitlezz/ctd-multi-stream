// Parser for FFmpeg `-progress pipe:1` output (pure). Each block is a run of key=value lines
// terminated by `progress=continue` or `progress=end`, e.g.
//   frame=120  fps=30.00  bitrate=2510.3kbits/s  total_size=1254400  out_time_us=4000000
//   speed=1.00x  progress=continue
// https://ffmpeg.org/ffmpeg.html#Advanced-options (-progress)

import type { PushStats } from '../../../shared/types.js';

export interface ProgressBlock {
  /** Average output bitrate since start, as FFmpeg reports it (N/A -> 0). */
  bitrateKbps: number;
  fps: number;
  speed: number;
  /** Output media time in microseconds (N/A -> 0). */
  outTimeUs: number;
  /** Bytes written so far, null when unknown. */
  totalSize: number | null;
  frame: number;
  dropFrames: number;
  end: boolean;
}

function toNumber(value: string | undefined): number {
  if (value === undefined) return 0;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** `2510.3kbits/s` -> 2510.3 ; also accepts bits/s and Mbits/s. */
export function parseBitrate(value: string | undefined): number {
  const m = /^\s*([\d.]+)\s*([kKmM]?)bits\/s/.exec(value ?? '');
  if (!m) return 0;
  const n = Number.parseFloat(m[1] ?? '');
  if (!Number.isFinite(n)) return 0;
  const unit = (m[2] ?? '').toLowerCase();
  return unit === 'm' ? n * 1000 : unit === 'k' ? n : n / 1000;
}

/** Parse one complete block of key=value pairs. */
export function parseProgressBlock(fields: Record<string, string>): ProgressBlock {
  const outTimeUs = toNumber(fields.out_time_us ?? (fields.out_time_ms !== undefined ? fields.out_time_ms : undefined));
  const size = fields.total_size;
  return {
    bitrateKbps: parseBitrate(fields.bitrate),
    fps: toNumber(fields.fps),
    speed: toNumber(fields.speed?.replace(/x$/, '')),
    outTimeUs,
    totalSize: size !== undefined && /^\d+$/.test(size) ? Number(size) : null,
    frame: toNumber(fields.frame),
    dropFrames: toNumber(fields.drop_frames),
    end: fields.progress === 'end',
  };
}

/** Parse a whole text chunk (one or more lines) as a single block. */
export function parseProgressText(text: string): ProgressBlock {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0) fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return parseProgressBlock(fields);
}

/** Convert a block to the UI's PushStats. uptimeSec = media time pushed (≈ wall clock for live input). */
export function toPushStats(block: ProgressBlock, bitrateKbps = block.bitrateKbps): PushStats {
  return {
    bitrateKbps: Math.round(bitrateKbps),
    fps: Math.round(block.fps * 100) / 100,
    speed: Math.round(block.speed * 100) / 100,
    uptimeSec: Math.floor(block.outTimeUs / 1_000_000),
  };
}

/**
 * Line-oriented streaming parser. Feed it stdout lines; it returns a block (with the *current*
 * bitrate computed from total_size deltas when possible) each time one completes.
 */
export class ProgressParser {
  private fields: Record<string, string> = {};
  private prev: { size: number; outTimeUs: number } | null = null;

  push(line: string): { block: ProgressBlock; stats: PushStats } | null {
    const eq = line.indexOf('=');
    if (eq <= 0) return null;
    const key = line.slice(0, eq).trim();
    this.fields[key] = line.slice(eq + 1).trim();
    if (key !== 'progress') return null;

    const block = parseProgressBlock(this.fields);
    this.fields = {};
    let current = block.bitrateKbps;
    if (block.totalSize !== null) {
      const p = this.prev;
      if (p && block.outTimeUs > p.outTimeUs && block.totalSize >= p.size) {
        // bytes*8 / µs * 1000 = kbit/s
        current = ((block.totalSize - p.size) * 8 * 1000) / (block.outTimeUs - p.outTimeUs);
      }
      this.prev = { size: block.totalSize, outTimeUs: block.outTimeUs };
    }
    return { block, stats: toPushStats(block, current) };
  }
}
