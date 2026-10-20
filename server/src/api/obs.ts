// OBS events relayed by the hub (docs/API.md §10, v1.4): the CTD OBS plugin POSTs batches of
// events about its sources, outputs and scenes to POST /api/v1/apps/{appId}/events; the hub keeps
// the latest state per profile and app (GET /api/v1/profiles/{id}/obs) and re-emits them on /events
// for readers like CTD Live mobile. In memory only: state is rebuilt from the plugin's next events.

import { z } from 'zod';
import { jsonBytes } from './json.js';

export const OBS_EVENT_TYPES = ['obs.feed.state', 'obs.feed.stats', 'obs.output', 'obs.scene'] as const;
export type ObsEventType = (typeof OBS_EVENT_TYPES)[number];

export const OBS_MAX_EVENTS = 50;
export const OBS_DATA_MAX_BYTES = 8 * 1024;
export const OBS_BODY_LIMIT = 64 * 1024;
export const OBS_POSTS_PER_MINUTE = 120;
/** A ts further than this from the server's clock is replaced by the server's time. */
export const OBS_TS_SKEW_MS = 5 * 60_000;
/** Event ids seen within this window are dropped as duplicates. */
const DEDUPE_MS = 10 * 60_000;
const DEDUPE_MAX = 2000;
/** obs.feed.stats is re-emitted at most this often per source (state is always kept). */
export const OBS_STATS_EMIT_MS = 5_000;
/** Most sources/outputs/canvases kept per app (oldest updates dropped first). */
const MAX_ENTRIES = 100;

const NAME_MAX = 120;

const EventItem = z.object({
  id: z.string().min(1).max(64),
  type: z.string().min(1).max(64),
  ts: z.number().finite().nonnegative(),
  data: z.record(z.string(), z.unknown()).refine((d) => !Array.isArray(d), 'must be an object'),
});

export const ObsEventsBody = z.object({
  events: z.array(z.unknown()).min(1, 'send at least one event').max(OBS_MAX_EVENTS, `at most ${OBS_MAX_EVENTS} events per request`),
});

export interface ParsedObsEvent {
  id: string;
  type: ObsEventType;
  ts: number;
  data: Record<string, unknown>;
}

/** Known, well-formed events of a batch; the rest are counted as ignored (never a refusal). */
export function parseObsEvents(raw: unknown[], now: number): { events: ParsedObsEvent[]; ignored: number } {
  const events: ParsedObsEvent[] = [];
  let ignored = 0;
  for (const item of raw) {
    const p = EventItem.safeParse(item);
    if (!p.success || !(OBS_EVENT_TYPES as readonly string[]).includes(p.data.type) || jsonBytes(p.data.data) > OBS_DATA_MAX_BYTES || !keyOf(p.data.type as ObsEventType, p.data.data)) {
      ignored++;
      continue;
    }
    const ts = Math.abs(p.data.ts - now) > OBS_TS_SKEW_MS ? now : p.data.ts;
    events.push({ id: p.data.id, type: p.data.type as ObsEventType, ts, data: p.data.data });
  }
  return { events, ignored };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, NAME_MAX) : null;
}

/** What an event is about: a source name, an output, or a canvas (null = malformed). */
function keyOf(type: ObsEventType, data: Record<string, unknown>): string | null {
  switch (type) {
    case 'obs.feed.state':
    case 'obs.feed.stats': {
      const source = data.source;
      return typeof source === 'object' && source !== null ? str((source as { name?: unknown }).name) : str(source);
    }
    case 'obs.output':
      return str(data.output);
    case 'obs.scene':
      return str(data.canvas) ?? 'landscape';
  }
}

export interface ObsFeedState {
  source: string;
  state: unknown;
  previous: unknown;
  gapMs: unknown;
  /** Last obs.feed.stats data, or null. */
  stats: Record<string, unknown> | null;
  /** The source object as last sent (name, path, server…). */
  info: Record<string, unknown> | null;
  updatedAt: number;
}

export interface ObsAppState {
  appId: string;
  feeds: ObsFeedState[];
  outputs: (Record<string, unknown> & { updatedAt: number })[];
  scenes: { canvas: string; scene: unknown; updatedAt: number }[];
  updatedAt: number;
}

interface AppTrack {
  feeds: Map<string, ObsFeedState>;
  outputs: Map<string, Record<string, unknown> & { updatedAt: number }>;
  scenes: Map<string, { canvas: string; scene: unknown; updatedAt: number }>;
  updatedAt: number;
  seen: Map<string, number>;
  statsEmitted: Map<string, number>;
}

function bounded<V extends { updatedAt: number }>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/** Latest OBS state per profile and app, with event dedupe and the stats re-emit throttle. */
export class ObsStateStore {
  private readonly profiles = new Map<string, Map<string, AppTrack>>();

  /**
   * Record one event. Returns whether it should be re-emitted on /events (false for a duplicate id
   * or a throttled obs.feed.stats).
   */
  apply(profileId: string, appId: string, ev: ParsedObsEvent, now: number): boolean {
    const track = this.track(profileId, appId);
    for (const [id, at] of track.seen) {
      if (now - at < DEDUPE_MS) break;
      track.seen.delete(id);
    }
    if (track.seen.has(ev.id)) return false;
    track.seen.set(ev.id, now);
    while (track.seen.size > DEDUPE_MAX) {
      const oldest = track.seen.keys().next().value;
      if (oldest === undefined) break;
      track.seen.delete(oldest);
    }

    const key = keyOf(ev.type, ev.data)!;
    track.updatedAt = ev.ts;
    switch (ev.type) {
      case 'obs.feed.state': {
        const prev = track.feeds.get(key);
        const info = typeof ev.data.source === 'object' && ev.data.source !== null ? (ev.data.source as Record<string, unknown>) : null;
        bounded(track.feeds, key, {
          source: key,
          state: ev.data.state ?? null,
          previous: ev.data.previous ?? null,
          gapMs: ev.data.gapMs ?? null,
          stats: prev?.stats ?? null,
          info,
          updatedAt: ev.ts,
        });
        return true;
      }
      case 'obs.feed.stats': {
        const prev = track.feeds.get(key);
        const { source: _source, ...stats } = ev.data;
        bounded(track.feeds, key, {
          source: key,
          state: prev?.state ?? null,
          previous: prev?.previous ?? null,
          gapMs: prev?.gapMs ?? null,
          stats,
          info: prev?.info ?? null,
          updatedAt: ev.ts,
        });
        const last = track.statsEmitted.get(key);
        if (last !== undefined && now - last < OBS_STATS_EMIT_MS) return false;
        track.statsEmitted.set(key, now);
        return true;
      }
      case 'obs.output':
        bounded(track.outputs, key, { ...ev.data, output: key, updatedAt: ev.ts });
        return true;
      case 'obs.scene':
        bounded(track.scenes, key, { canvas: key, scene: ev.data.scene ?? null, updatedAt: ev.ts });
        return true;
    }
  }

  /** Every app's state for a profile (newest first). */
  view(profileId: string): ObsAppState[] {
    const apps = this.profiles.get(profileId);
    if (!apps) return [];
    return [...apps.entries()]
      .map(([appId, t]) => ({
        appId,
        feeds: [...t.feeds.values()],
        outputs: [...t.outputs.values()],
        scenes: [...t.scenes.values()],
        updatedAt: t.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Forget an app (it unregistered) or a profile (deleted). */
  forgetApp(appId: string): void {
    for (const apps of this.profiles.values()) apps.delete(appId);
  }

  forgetProfile(profileId: string): void {
    this.profiles.delete(profileId);
  }

  private track(profileId: string, appId: string): AppTrack {
    let apps = this.profiles.get(profileId);
    if (!apps) {
      apps = new Map();
      this.profiles.set(profileId, apps);
    }
    let t = apps.get(appId);
    if (!t) {
      t = { feeds: new Map(), outputs: new Map(), scenes: new Map(), updatedAt: 0, seen: new Map(), statsEmitted: new Map() };
      apps.set(appId, t);
    }
    return t;
  }
}

const stores = new WeakMap<object, ObsStateStore>();

/** The OBS state store of these services (one per process). */
export function obsStoreFor(services: object): ObsStateStore {
  let s = stores.get(services);
  if (!s) {
    s = new ObsStateStore();
    stores.set(services, s);
  }
  return s;
}
