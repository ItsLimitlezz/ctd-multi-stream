// Feed analysis: frame rate and keyframe interval of what OBS sends, which MediaMTX doesn't report.
// Platforms want a keyframe every 2 s (Twitch, YouTube, Kick, Instagram); OBS's default "0" (auto)
// gives longer intervals, which Kick flags as "misconfigured" and which adds latency everywhere.
// One ffprobe run per publish session: packet timestamps and key flags only, nothing is decoded.

import { spawn } from 'node:child_process';
import path from 'node:path';

/** Seconds of packets read (long enough to see two keyframes even with OBS's "auto" interval). */
export const PROBE_SECONDS = 13;
const PROBE_TIMEOUT_MS = (PROBE_SECONDS + 10) * 1000;
/** What platforms recommend. */
export const RECOMMENDED_KEYFRAME_SEC = 2;

export interface FeedAnalysis {
  /** Frames per second, rounded to 0.01 (null when unknown). */
  fps: number | null;
  /** Median seconds between keyframes, rounded to 0.1 (null when unknown). */
  keyframeSec: number | null;
  /** Fewer than two keyframes in the window: `keyframeSec` is a minimum ("over N s"). */
  keyframeSecIsMinimum: boolean;
}

/** ffprobe next to the configured ffmpeg ("/opt/ctd/tools/ffmpeg" → "/opt/ctd/tools/ffprobe"). */
export function ffprobePath(ffmpegBin: string): string {
  const dir = path.dirname(ffmpegBin);
  const base = path.basename(ffmpegBin).replace(/ffmpeg/i, 'ffprobe');
  return dir === '.' && !/[\\/]/.test(ffmpegBin) ? base : path.join(dir, base);
}

export function probeArgs(input: string): string[] {
  return [
    '-v', 'error',
    '-rw_timeout', '8000000',
    '-select_streams', 'v:0',
    '-read_intervals', `%+${PROBE_SECONDS}`,
    '-show_entries', 'packet=pts_time,flags',
    '-of', 'csv=p=0',
    input,
  ];
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Parse ffprobe's "pts_time,flags" lines (e.g. "12.345000,K__") into an analysis. */
export function analyzePackets(csv: string): FeedAnalysis {
  const times: number[] = [];
  const keys: number[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const [t, flags] = line.split(',');
    const pts = Number(t);
    if (!t || !Number.isFinite(pts)) continue;
    times.push(pts);
    if (flags?.includes('K')) keys.push(pts);
  }
  times.sort((a, b) => a - b);
  const span = times.length > 1 ? times.at(-1)! - times[0]! : 0;
  const fps = span >= 1 ? Math.round(((times.length - 1) / span) * 100) / 100 : null;
  keys.sort((a, b) => a - b);
  const gaps = keys.slice(1).map((k, i) => k - keys[i]!).filter((g) => g > 0);
  if (gaps.length > 0) return { fps, keyframeSec: Math.round(median(gaps) * 10) / 10, keyframeSecIsMinimum: false };
  // At most one keyframe in the whole window: the interval is at least the window (or unknown if short).
  if (span >= PROBE_SECONDS - 3) return { fps, keyframeSec: Math.floor(span), keyframeSecIsMinimum: true };
  return { fps, keyframeSec: null, keyframeSecIsMinimum: false };
}

/** Probe one feed (rejects on failure; never logs the URL: it holds the reader password). */
export function probeFeed(ffprobeBin: string, input: string): Promise<FeedAnalysis> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobeBin, probeArgs(input), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('feed probe timed out'));
    }, PROBE_TIMEOUT_MS);
    child.stdout.on('data', (b: Buffer) => {
      if (out.length < 2_000_000) out += b.toString();
    });
    child.stderr.on('data', (b: Buffer) => {
      if (err.length < 400) err += b.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || out.length > 0) resolve(analyzePackets(out));
      else reject(new Error(`feed probe failed (exit ${code ?? 'signal'}): ${err.replace(/rtmp:\/\/\S+/g, '<feed>').trim().slice(0, 200)}`));
    });
  });
}
