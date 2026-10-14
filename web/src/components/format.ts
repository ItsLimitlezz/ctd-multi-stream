// Display formatting for durations, bitrates, video specs and timestamps.

import type { FeedState } from '@shared/types';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 75 -> "01:15", 3725 -> "1:02:05". */
export function formatDuration(totalSec: number): string {
  const s = Number.isFinite(totalSec) && totalSec > 0 ? Math.floor(totalSec) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${pad2(m)}:${pad2(sec)}`;
}

/** Seconds elapsed since an ISO timestamp (0 when missing/invalid/in the future). */
export function elapsedSeconds(sinceIso: string | null | undefined, now: number): number {
  if (!sinceIso) return 0;
  const t = Date.parse(sinceIso);
  return Number.isNaN(t) ? 0 : Math.max(0, (now - t) / 1000);
}

/** 850 -> "850 kbps", 4500 -> "4.5 Mbps", 12000 -> "12 Mbps". */
export function formatBitrate(kbps: number | null | undefined): string {
  if (kbps === null || kbps === undefined || !Number.isFinite(kbps) || kbps < 0) return '—';
  if (kbps >= 1000) {
    const mbps = kbps / 1000;
    return `${mbps >= 10 ? Math.round(mbps) : Number(mbps.toFixed(1))} Mbps`;
  }
  return `${Math.round(kbps)} kbps`;
}

/** 30 -> "30 fps", 29.97 -> "29.97 fps". */
export function formatFps(fps: number | null | undefined): string {
  if (fps === null || fps === undefined || !Number.isFinite(fps) || fps < 0) return '—';
  return `${Number(fps.toFixed(2))} fps`;
}

export function formatResolution(width?: number, height?: number): string {
  return width && height ? `${width}×${height}` : '—';
}

/** "H264 / AAC" style codec summary for a feed. */
export function formatCodecs(feed: Pick<FeedState, 'video' | 'audio'>): string {
  const parts = [feed.video?.codec, feed.audio?.codec].filter((c): c is string => !!c);
  return parts.length ? parts.map((c) => c.toUpperCase()).join(' / ') : '—';
}

/** "48 kHz stereo" style audio summary. */
export function formatAudio(audio: FeedState['audio']): string {
  if (!audio) return '—';
  const parts: string[] = [audio.codec.toUpperCase()];
  if (audio.sampleRate) parts.push(`${Number((audio.sampleRate / 1000).toFixed(1))} kHz`);
  if (audio.channels) parts.push(audio.channels === 1 ? 'mono' : audio.channels === 2 ? 'stereo' : `${audio.channels} ch`);
  return parts.join(' · ');
}

/** Local "14:05" for an ISO timestamp. */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Local date + time, or `fallback` when missing. */
export function formatDateTime(iso: string | null | undefined, fallback = 'Never'): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? fallback : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

/** "just now", "45 s ago", "3 min ago", "2 h ago", "4 d ago" (empty for a missing/invalid time). */
export function formatAgo(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
