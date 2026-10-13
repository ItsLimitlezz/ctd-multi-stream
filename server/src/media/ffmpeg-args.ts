// FFmpeg argument builder for pushes (pure).
//
// Multitrack / Twitch Dual Format — what was found (Oct 2026, FFmpeg n8.1.3 BtbN build):
// - FFmpeg 8.0 changelog: "Enhanced FLV v2: Multitrack audio/video, modern codec support".
// - libavformat/flvenc.c (n8.1.3) maps the 2nd, 3rd... video stream to E-FLV v2 track ids 1, 2...
//   and writes them as `PacketTypeMultitrack` / `MultitrackTypeOneTrack` packets (H.264 on a
//   non-zero track is sent as an extended `avc1` packet). Track 0 stays a legacy/extended packet.
//   `-flvflags add_keyframe_index` is incompatible with multiple video streams (not used here).
// - The rtmp protocol has `-rtmp_enhanced_codecs` (fourCcList in the connect command), which we
//   send so the server knows the client speaks Enhanced RTMP.
// - `ffmpeg -h muxer=flv` shows no dedicated multitrack switch: mapping two video streams is enough.
// Whether Twitch accepts a relayed multitrack stream (without its client-config handshake) is not
// verified — this mode is EXPERIMENTAL (see docs/ARCHITECTURE.md §5.3).

import type { Feed } from '../../../shared/types.js';
import type { PushPlan } from '../platforms/types.js';

export const MULTITRACK_UNSUPPORTED = 'Multitrack (Twitch Dual Format) is not supported by this FFmpeg build';

/** Input read timeout: FFmpeg exits (and we retry) if the local feed stalls for 15 s. */
const RW_TIMEOUT_US = '15000000';

export interface FfmpegCapabilities {
  /** Enhanced FLV v2 multitrack muxing (FFmpeg >= 8.0). The pinned build has it. */
  multitrack: boolean;
}

/** FFmpeg major version from `ffmpeg -version` output ("ffmpeg version n8.1.3-..." / "8.0.1"). */
export function parseFfmpegMajor(versionOutput: string): number | null {
  const m = /ffmpeg version\s+n?(\d+)\.(\d+)/i.exec(versionOutput);
  return m ? Number(m[1]) : null;
}

/** Git master builds ("N-12345-g...") are newer than any release: treat as capable. */
export function capabilitiesFromVersion(versionOutput: string): FfmpegCapabilities {
  if (/ffmpeg version\s+N-\d+/i.test(versionOutput)) return { multitrack: true };
  const major = parseFfmpegMajor(versionOutput);
  return { multitrack: major !== null && major >= 8 };
}

function isRtmpUrl(url: string): boolean {
  return /^rtmps?:\/\//i.test(url);
}

function inputArgs(url: string): string[] {
  return ['-rw_timeout', RW_TIMEOUT_US, '-i', url];
}

function inputFor(feed: Feed | undefined, inputUrls: Partial<Record<Feed, string>>): string {
  const url = feed ? inputUrls[feed] : undefined;
  if (!feed || !url) throw new Error(`No input URL for feed ${feed ?? '(none)'}`);
  return url;
}

export function buildPushArgs(
  plan: PushPlan,
  inputUrls: Partial<Record<Feed, string>>,
  caps: FfmpegCapabilities = { multitrack: true },
): string[] {
  if (!plan.url) throw new Error('Push plan has no output URL');
  const head = ['-hide_banner', '-nostdin', '-loglevel', 'warning', '-progress', 'pipe:1', '-stats_period', '2'];
  const tail = ['-c', 'copy', '-f', 'flv', '-flvflags', 'no_duration_filesize', ...(plan.extraOutputArgs ?? []), plan.url];

  if (plan.mode === 'copy') {
    if (plan.feeds.length !== 1) throw new Error(`Copy mode needs exactly one feed (got ${plan.feeds.length})`);
    return [...head, ...inputArgs(inputFor(plan.feeds[0], inputUrls)), '-map', '0:v:0', '-map', '0:a:0?', ...tail];
  }

  if (plan.mode === 'multitrack') {
    if (!caps.multitrack) throw new Error(MULTITRACK_UNSUPPORTED);
    const [primary, secondary] = plan.feeds;
    if (plan.feeds.length !== 2 || primary === secondary) {
      throw new Error('Multitrack mode needs two different feeds (primary first)');
    }
    return [
      ...head,
      ...inputArgs(inputFor(primary, inputUrls)),
      ...inputArgs(inputFor(secondary, inputUrls)),
      // Track 0: primary video + its audio. Track 1: secondary video (E-FLV v2 multitrack).
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-map', '1:v:0',
      ...(isRtmpUrl(plan.url) ? ['-rtmp_enhanced_codecs', 'avc1,hvc1,av01'] : []),
      ...tail,
    ];
  }

  throw new Error(`Unknown push mode: ${String((plan as { mode: unknown }).mode)}`);
}
