// GET /api/v1/clock (docs/API.md §4.1): the server's clock as a shared timecode reference, so apps
// on other machines (over the LAN or the internet) can line up overlays, recordings and videos on
// the same time code. NTP-style: the client sends its own send time `t0`, the reply carries when the
// server received the request and when it answered, and the client derives its clock offset and the
// network delay. Clients then run the clock locally (frame-accurate) and re-sync now and then.

import type { ApiFeed, ApiSession } from './types.js';

export const DEFAULT_FPS = 30;
const MAX_FPS = 120;

export interface ApiClock {
  /** The client's `t0` echoed back (epoch ms), or null when it sent none. */
  t0: number | null;
  /** Server time when the request arrived (epoch ms). */
  receivedAt: number;
  /** Server time when the reply was built (epoch ms). */
  sentAt: number;
  /** `sentAt` as ISO 8601 (UTC). */
  iso: string;
  /** The server's local time zone offset from UTC in minutes (e.g. -240 for EDT). */
  utcOffsetMinutes: number;
  profileId: string;
  session: {
    status: ApiSession['status'];
    /** Epoch ms the session started, or null when offline. */
    startedAt: number | null;
    /** Run time of the session at `sentAt`, or null when offline. */
    elapsedMs: number | null;
  };
  /** Nominal integer frame rate of the timecodes (non-drop-frame). */
  fps: number;
  /** Where `fps` comes from: the landscape / vertical feed as OBS sends it, else the default (30). */
  fpsSource: 'landscape' | 'vertical' | 'default';
  timecode: {
    /** Session run time "HH:MM:SS:FF" (hours keep counting past 24), or null when offline. */
    run: string | null;
    /** Time of day in UTC "HH:MM:SS:FF" — the one to use across machines and time zones. */
    utc: string;
    /** Time of day in the server's time zone "HH:MM:SS:FF". */
    local: string;
  };
}

/** Nominal integer rate for timecode frames: 29.97 → 30, 59.94 → 60; nonsense → null. */
export function nominalFps(fps: unknown): number | null {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) return null;
  return Math.min(MAX_FPS, Math.max(1, Math.round(fps)));
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** "HH:MM:SS:FF" for a duration or time of day in ms (non-drop-frame; negative counts as 0). */
export function formatTimecode(ms: number, fps: number): string {
  const total = Math.max(0, Math.floor(ms));
  const frames = Math.min(fps - 1, Math.floor(((total % 1000) * fps) / 1000));
  const secs = Math.floor(total / 1000);
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}:${pad(frames)}`;
}

const DAY_MS = 86_400_000;

/** The frame rate the profile's feeds run at (landscape first), else the default. */
export function clockFps(feeds: readonly ApiFeed[]): { fps: number; source: ApiClock['fpsSource'] } {
  for (const feed of ['landscape', 'vertical'] as const) {
    const f = feeds.find((x) => x.feed === feed);
    const fps = f?.online ? nominalFps(f.video?.fps) : null;
    if (fps) return { fps, source: feed };
  }
  return { fps: DEFAULT_FPS, source: 'default' };
}

export function buildClock(input: {
  t0: number | null;
  receivedAt: number;
  sentAt: number;
  profileId: string;
  session: Pick<ApiSession, 'status' | 'startedAt'>;
  feeds: readonly ApiFeed[];
}): ApiClock {
  const { sentAt } = input;
  const { fps, source } = clockFps(input.feeds);
  const running = input.session.status === 'live' || input.session.status === 'starting';
  const parsed = running && input.session.startedAt ? Date.parse(input.session.startedAt) : Number.NaN;
  const startedAt = Number.isFinite(parsed) ? parsed : null;
  const elapsedMs = startedAt === null ? null : Math.max(0, sentAt - startedAt);
  const offsetMinutes = -new Date(sentAt).getTimezoneOffset();
  const utcOfDay = ((sentAt % DAY_MS) + DAY_MS) % DAY_MS;
  const localOfDay = (((sentAt + offsetMinutes * 60_000) % DAY_MS) + DAY_MS) % DAY_MS;
  return {
    t0: input.t0,
    receivedAt: input.receivedAt,
    sentAt,
    iso: new Date(sentAt).toISOString(),
    utcOffsetMinutes: offsetMinutes,
    profileId: input.profileId,
    session: { status: input.session.status, startedAt, elapsedMs },
    fps,
    fpsSource: source,
    timecode: {
      run: elapsedMs === null ? null : formatTimecode(elapsedMs, fps),
      utc: formatTimecode(utcOfDay, fps),
      local: formatTimecode(localOfDay, fps),
    },
  };
}

/** `?t0=`: absent → null; a finite epoch-ms number → it; anything else → undefined (invalid). */
export function parseT0(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || !/^\d{1,16}(?:\.\d{1,6})?$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
