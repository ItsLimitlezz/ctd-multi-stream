// Derive FeedState from MediaMTX control API path items (pure, except for the tracker's samples).
// Path schema (v1.21.2): https://github.com/bluenviron/mediamtx/blob/v1.21.2/api/openapi.yaml
// `ready`/`readyTime`/`bytesReceived` are deprecated in favour of `online`/`onlineTime`/`inboundBytes`;
// both are read so a version bump doesn't silently break feed detection.

import { DEFAULT_PROFILE_ID, type Feed, type FeedState } from '../../../shared/types.js';

export interface MtxTrack {
  codec?: string;
  codecProps?: Record<string, unknown> | null;
}

export interface MtxPath {
  name: string;
  online?: boolean;
  onlineTime?: string | null;
  ready?: boolean;
  readyTime?: string | null;
  inboundBytes?: number;
  bytesReceived?: number;
  tracks2?: MtxTrack[];
  source?: { id?: string; type?: string } | null;
}

export interface MtxPathList {
  items?: MtxPath[];
}

const VIDEO_CODECS: Record<string, string> = {
  H264: 'h264',
  H265: 'hevc',
  AV1: 'av1',
  VP9: 'vp9',
  VP8: 'vp8',
  'MPEG-4 Video': 'mpeg4',
  'MPEG-1/2 Video': 'mpeg2video',
  'M-JPEG': 'mjpeg',
};

const AUDIO_CODECS: Record<string, string> = {
  'MPEG-4 Audio': 'aac',
  'MPEG-4 Audio LATM': 'aac_latm',
  Opus: 'opus',
  'MPEG-1/2 Audio': 'mp3',
  AC3: 'ac3',
  FLAC: 'flac',
  Vorbis: 'vorbis',
  Speex: 'speex',
  G711: 'g711',
  G722: 'g722',
  G726: 'g726',
  LPCM: 'pcm',
};

const BITRATE_WINDOW_MS = 2_500;
const BITRATE_EMIT_INTERVAL_MS = 2_000;

export function offlineFeedState(feed: Feed, profileId: string = DEFAULT_PROFILE_ID): FeedState {
  return { profileId, feed, online: false, since: null, video: null, audio: null, bitrateKbps: null };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** MediaMTX sends RFC 3339 with nanoseconds and a local offset; normalize to ISO UTC. */
function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function describeTracks(tracks: MtxTrack[] | undefined): Pick<FeedState, 'video' | 'audio'> {
  let video: FeedState['video'] = null;
  let audio: FeedState['audio'] = null;
  for (const t of tracks ?? []) {
    const codec = t.codec ?? '';
    const props = t.codecProps ?? {};
    if (!video && codec in VIDEO_CODECS) {
      video = compact({ codec: VIDEO_CODECS[codec] ?? codec.toLowerCase(), width: num(props.width), height: num(props.height) });
    } else if (!audio && codec in AUDIO_CODECS) {
      audio = compact({ codec: AUDIO_CODECS[codec] ?? codec.toLowerCase(), sampleRate: num(props.sampleRate), channels: num(props.channelCount) });
    }
  }
  return { video, audio };
}

/** Frame rate and keyframe interval measured from the feed (feed-probe.ts). */
export interface FeedMeasurements {
  fps: number | null;
  keyframeSec: number | null;
  keyframeSecIsMinimum: boolean;
}

/** Tracks one feed of one profile across polls; computes bitrate from inbound byte deltas over a short window. */
export class FeedTracker {
  private samples: { t: number; bytes: number }[] = [];
  private state: FeedState;
  /** Measurements of one publish session (keyed by its `since`): dropped when OBS reconnects. */
  private measured: { since: string; m: FeedMeasurements } | null = null;

  constructor(
    readonly feed: Feed,
    readonly profileId: string = DEFAULT_PROFILE_ID,
  ) {
    this.state = offlineFeedState(feed, profileId);
  }

  current(): FeedState {
    return this.state;
  }

  /** Feed the latest API item for this path (undefined = path missing / API down = offline). */
  update(item: MtxPath | undefined, nowMs: number): FeedState {
    const online = item ? (item.online ?? item.ready ?? false) : false;
    if (!item || !online) {
      this.samples = [];
      this.state = offlineFeedState(this.feed, this.profileId);
      return this.state;
    }

    const bytes = item.inboundBytes ?? item.bytesReceived ?? 0;
    const last = this.samples.at(-1);
    if (last && bytes < last.bytes) this.samples = []; // counter reset: publisher reconnected
    this.samples.push({ t: nowMs, bytes });
    this.samples = this.samples.filter((s) => nowMs - s.t <= BITRATE_WINDOW_MS);
    const first = this.samples[0];
    const dt = first ? nowMs - first.t : 0;
    const bitrateKbps = first && dt > 0 ? Math.round(((bytes - first.bytes) * 8) / dt) : this.state.online ? this.state.bitrateKbps : null;

    const reported = toIso(item.onlineTime ?? item.readyTime);
    const since = reported ?? (this.state.online ? this.state.since : new Date(nowMs).toISOString());
    this.state = this.withMeasurements({ profileId: this.profileId, feed: this.feed, online: true, since, ...describeTracks(item.tracks2), bitrateKbps });
    return this.state;
  }

  /** Store the measurements of the publish session that started at `since` (ignored once it ended). */
  setMeasurements(since: string, m: FeedMeasurements): FeedState {
    if (this.state.online && this.state.since === since) {
      this.measured = { since, m };
      this.state = this.withMeasurements(this.state);
    }
    return this.state;
  }

  private withMeasurements(state: FeedState): FeedState {
    if (!this.measured || this.measured.since !== state.since || !state.video) return state;
    const { fps, keyframeSec, keyframeSecIsMinimum } = this.measured.m;
    return {
      ...state,
      video: compact({
        ...state.video,
        fps: state.video.fps ?? fps ?? undefined,
        keyframeSec: keyframeSec ?? undefined,
        keyframeSecIsMinimum: keyframeSec !== null && keyframeSecIsMinimum ? true : undefined,
      }),
    };
  }

  /** Force offline (MediaMTX stopped). */
  reset(): FeedState {
    return this.update(undefined, 0);
  }
}

function sameMedia(a: FeedState, b: FeedState): boolean {
  return (
    a.online === b.online &&
    a.since === b.since &&
    JSON.stringify(a.video) === JSON.stringify(b.video) &&
    JSON.stringify(a.audio) === JSON.stringify(b.audio)
  );
}

/**
 * Emit immediately on online/offline/codec/resolution changes; bitrate-only changes at most
 * every 2 s.
 */
export function shouldEmitFeed(prev: FeedState | null, next: FeedState, lastEmitAt: number, nowMs: number): boolean {
  if (!prev || !sameMedia(prev, next)) return true;
  if (prev.bitrateKbps === next.bitrateKbps) return false;
  return nowMs - lastEmitAt >= BITRATE_EMIT_INTERVAL_MS;
}
