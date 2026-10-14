// Event hub for the external API: turns EventBus events into v1 envelopes (docs/API.md §3, §5),
// keeps a replay buffer for /events and /events/poll (last 2000 envelopes or 15 minutes) and a
// chat backfill buffer for GET /chat that mirrors the ChatHub ring (500) with moderation applied.
//
// One hub per AppServices (eventHubFor). main.ts creates it at startup so nothing is missed.

import type { Logger } from 'pino';
import type { ChatMessage, ChatModeration, Destination, DestinationState, Feed, FeedState, PlatformInfo, SessionState } from '../../../shared/types.js';
import type { EventBus } from '../events.js';
import type { AppServices } from '../services.js';
import { apiMessageFromUser, chatMessageData, moderationEvent } from './chat-map.js';
import { apiDestination, apiFeed, apiSession, buildStatus, type StatusSources } from './status.js';
import {
  CONNECTOR,
  CORE,
  type ApiChatMessage,
  type ApiDestination,
  type ApiDestinationDown,
  type ApiDestinationUp,
  type ApiEventType,
  type ApiFeed,
  type ApiNotice,
  type ApiSession,
  type ApiStatus,
  type Envelope,
  type EnvelopeSource,
} from './types.js';
import { createUlidGenerator, ulidFloor, type UlidGenerator } from './ulid.js';

export const BUFFER_MAX_EVENTS = 2000;
export const BUFFER_MAX_AGE_MS = 15 * 60_000;
export const CHAT_BUFFER_SIZE = 500;
/** feed.status for bitrate-only changes and destination.status for stats/viewers-only changes. */
export const STATS_THROTTLE_MS = 2000;

export type EnvelopeListener = (env: Envelope) => void;

export interface EventHubDeps extends StatusSources {
  bus: EventBus;
  /** One destination from the repo (names, enabled flag), or null once deleted. */
  destination(id: string): Destination | null;
  log: Pick<Logger, 'warn'>;
  now?: () => number;
  ulid?: UlidGenerator;
  bufferMax?: number;
  bufferMaxAgeMs?: number;
  chatBufferSize?: number;
  throttleMs?: number;
}

interface Throttled<T> {
  /** Last value sent (null = never sent). */
  sent: T | null;
  sentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface DestinationTrack extends Throttled<ApiDestination> {
  down: boolean;
  downSince: number | null;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b as object, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function withoutKeys<T extends object>(value: T, keys: readonly (keyof T)[]): Partial<T> {
  const copy: Partial<T> = { ...value };
  for (const k of keys) delete copy[k];
  return copy;
}

const DESTINATION_STATS_KEYS: readonly (keyof ApiDestination)[] = ['stats', 'viewers'];
const FEED_STATS_KEYS: readonly (keyof ApiFeed)[] = ['bitrateKbps'];

function source(connection: string, platform: EnvelopeSource['platform']): EnvelopeSource {
  return { connector: CONNECTOR, connection, platform };
}
const CORE_SOURCE = source(CORE, CORE);

export class EventHub {
  /** Smallest id this process can have produced: an older cursor predates this run (reset). */
  readonly floor: string;

  private readonly deps: EventHubDeps;
  private readonly now: () => number;
  private readonly ulid: UlidGenerator;
  private readonly bufferMax: number;
  private readonly bufferMaxAgeMs: number;
  private readonly chatBufferSize: number;
  private readonly throttleMs: number;

  private buffer: Envelope[] = [];
  private chatBuffer: Envelope<ApiChatMessage>[] = [];
  private lastEvicted: string | null = null;
  /** Newest evicted id per event type: a filtered reader only resets when a type it reads was lost. */
  private readonly lastEvictedByType = new Map<ApiEventType, string>();
  private lastId: string | null = null;
  private readonly listeners = new Set<EnvelopeListener>();
  private readonly unsubscribers: (() => void)[] = [];

  private session: Pick<SessionState, 'status' | 'startedAt' | 'title' | 'autoGoLive' | 'testMode'>;
  private sentSession: ApiSession;
  private readonly states = new Map<string, DestinationState>();
  private readonly destinations = new Map<string, DestinationTrack>();
  private readonly feeds = new Map<Feed, Throttled<ApiFeed>>();
  private readonly latestFeeds = new Map<Feed, ApiFeed>();
  private closed = false;

  constructor(deps: EventHubDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.ulid = deps.ulid ?? createUlidGenerator(this.now);
    this.bufferMax = deps.bufferMax ?? BUFFER_MAX_EVENTS;
    this.bufferMaxAgeMs = deps.bufferMaxAgeMs ?? BUFFER_MAX_AGE_MS;
    this.chatBufferSize = deps.chatBufferSize ?? CHAT_BUFFER_SIZE;
    this.throttleMs = deps.throttleMs ?? STATS_THROTTLE_MS;
    this.floor = ulidFloor(this.now());

    // Baseline: what clients would see right now, so the first real change is detected as one.
    let state: SessionState;
    try {
      state = deps.state();
    } catch (err) {
      deps.log.warn({ error: (err as Error).message }, 'api event hub: reading the initial session state failed');
      state = { status: 'offline', sessionId: null, startedAt: null, title: '', autoGoLive: true, feeds: [], destinations: [] };
    }
    this.session = state;
    this.sentSession = apiSession(state);
    for (const st of state.destinations) this.states.set(st.destinationId, st);
    for (const f of state.feeds) {
      this.feeds.set(f.feed, { sent: apiFeed(f), sentAt: 0, timer: null });
      this.latestFeeds.set(f.feed, apiFeed(f));
    }
    for (const dest of this.safeDestinations() ?? []) {
      const item = this.buildDestination(dest);
      this.destinations.set(dest.id, { sent: item, sentAt: 0, timer: null, down: item.down, downSince: item.down ? this.now() : null });
    }

    const { bus } = deps;
    this.unsubscribers.push(
      bus.on('chat', (m) => this.guard(() => this.onChat(m))),
      bus.on('chat-moderation', (m) => this.guard(() => this.onModeration(m))),
      bus.on('session', (s) => this.guard(() => this.onSession(s))),
      bus.on('destination', (st) => this.guard(() => this.onDestination(st))),
      bus.on('destinations-changed', () => this.guard(() => this.refreshAll())),
      bus.on('feed', (f) => this.guard(() => this.onFeed(f))),
      bus.on('notice', (n) => this.guard(() => this.publish<ApiNotice>('system.notice', CORE_SOURCE, { level: n.level, message: n.message }))),
    );
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** The current position: pass it as `after` to get only what happens from now on. */
  cursor(): string {
    return this.lastId ?? this.floor;
  }

  /**
   * Buffered envelopes after `after` (oldest first, unfiltered), or reset when something the reader
   * would receive was lost: `after` predates this process, is newer than anything this process
   * produced (a cursor from an earlier run with the clock set back), or an envelope after it of one
   * of `types` (default: any type) has left the buffer.
   */
  since(after: string, types?: ReadonlySet<ApiEventType>): { items: Envelope[]; reset: boolean } {
    this.evictOld();
    if (after < this.floor || after > this.cursor() || this.lostAfter(after, types)) return { items: [], reset: true };
    return { items: this.buffer.slice(this.firstAfter(this.buffer, after)), reset: false };
  }

  private lostAfter(after: string, types: ReadonlySet<ApiEventType> | undefined): boolean {
    if (!types) return this.lastEvicted !== null && after < this.lastEvicted;
    for (const type of types) {
      const evicted = this.lastEvictedByType.get(type);
      if (evicted !== undefined && after < evicted) return true;
    }
    return false;
  }

  /** Recent chat still visible after moderation, oldest first. */
  chat(limit: number, after?: string): { items: Envelope<ApiChatMessage>[]; next: string } {
    // A cursor newer than anything this process produced (earlier run, clock set back) means nothing: treat it as absent.
    if (after !== undefined && after <= this.cursor()) {
      const items = this.chatBuffer.slice(this.firstAfter(this.chatBuffer, after)).slice(0, limit);
      return { items, next: items.at(-1)?.id ?? after };
    }
    const items = limit > 0 ? this.chatBuffer.slice(-limit) : [];
    return { items, next: items.at(-1)?.id ?? this.cursor() };
  }

  status(): ApiStatus {
    return buildStatus(this.deps);
  }

  /** Current state as fresh (unbuffered) envelopes: one stream.status + one destination.status per destination. */
  snapshot(): Envelope[] {
    const status = this.status();
    const ts = this.now();
    return [
      this.envelope('stream.status', CORE_SOURCE, status.session, ts),
      ...status.destinations.map((d) => this.envelope('destination.status', source(d.id, d.platform), d, ts)),
    ];
  }

  /** A fresh system.reset envelope (not buffered). */
  resetEnvelope(): Envelope<Record<string, never>> {
    return this.envelope('system.reset', CORE_SOURCE, {}, this.now());
  }

  subscribe(listener: EnvelopeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Live subscribers (open event streams); for diagnostics and tests. */
  listenerCount(): number {
    return this.listeners.size;
  }

  close(): void {
    this.closed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    for (const t of [...this.destinations.values(), ...this.feeds.values()]) if (t.timer) clearTimeout(t.timer);
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Publishing
  // -------------------------------------------------------------------------

  private envelope<T>(type: ApiEventType, src: EnvelopeSource, data: T, ts: number): Envelope<T> {
    const id = this.ulid();
    this.lastId = id;
    return { id, type, ts, src, data };
  }

  private publish<T>(type: ApiEventType, src: EnvelopeSource, data: T): Envelope<T> {
    const env = this.envelope(type, src, data, this.now());
    this.buffer.push(env);
    this.evictOld();
    for (const listener of this.listeners) {
      try {
        listener(env);
      } catch (err) {
        this.deps.log.warn({ error: (err as Error).message }, 'api event listener failed');
      }
    }
    return env;
  }

  private evictOld(): void {
    const oldest = this.now() - this.bufferMaxAgeMs;
    let drop = Math.max(0, this.buffer.length - this.bufferMax);
    while (drop < this.buffer.length && (this.buffer[drop]?.ts ?? Infinity) < oldest) drop++;
    if (drop === 0) return;
    for (const env of this.buffer.splice(0, drop)) {
      this.lastEvicted = env.id;
      this.lastEvictedByType.set(env.type, env.id);
    }
  }

  /** Index of the first envelope with id > after (buffers are sorted by id). */
  private firstAfter(list: readonly Envelope[], after: string): number {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((list[mid]?.id ?? '') <= after) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private guard(fn: () => void): void {
    if (this.closed) return;
    try {
      fn();
    } catch (err) {
      this.deps.log.warn({ error: (err as Error).message }, 'api event hub failed to handle an event');
    }
  }

  // -------------------------------------------------------------------------
  // Chat
  // -------------------------------------------------------------------------

  private channelName(destinationId: string, platform: ChatMessage['platform']): string {
    const dest = this.safeDestination(destinationId);
    if (dest) return dest.name;
    return this.safePlatformInfo(platform)?.name ?? platform;
  }

  private onChat(msg: ChatMessage): void {
    const data = chatMessageData(msg, this.channelName(msg.destinationId, msg.platform));
    const env = this.publish('chat.message', source(msg.destinationId, msg.platform), data);
    this.chatBuffer.push(env);
    if (this.chatBuffer.length > this.chatBufferSize) this.chatBuffer.splice(0, this.chatBuffer.length - this.chatBufferSize);
  }

  private onModeration(m: ChatModeration): void {
    const event = moderationEvent(m);
    this.publish(event.type, source(m.destinationId, m.platform), event.data);
    const sameDest = (e: Envelope<ApiChatMessage>) => e.data.destinationId === m.destinationId;
    let remove: (e: Envelope<ApiChatMessage>) => boolean;
    switch (m.kind) {
      case 'message-deleted': {
        const prefixed = `${m.platform}:${m.platformMessageId}`;
        remove = (e) =>
          sameDest(e) && ((m.messageId !== null && e.data.id === m.messageId) || e.data.platformMessageId === m.platformMessageId || e.data.id === prefixed);
        break;
      }
      case 'user-cleared':
        remove = (e) => sameDest(e) && apiMessageFromUser(e.data, m);
        break;
      case 'cleared':
        remove = sameDest;
        break;
    }
    this.chatBuffer = this.chatBuffer.filter((e) => !remove(e));
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  private onSession(s: SessionState): void {
    this.session = s;
    const session = apiSession(s);
    if (!deepEqual(session, this.sentSession)) {
      this.sentSession = session;
      this.publish('stream.status', CORE_SOURCE, session);
    }
    const listed = new Set<string>();
    for (const st of s.destinations) {
      this.states.set(st.destinationId, st);
      listed.add(st.destinationId);
    }
    for (const id of [...this.states.keys()]) if (!listed.has(id)) this.states.delete(id);
    this.refreshAll();
  }

  private onDestination(st: DestinationState): void {
    this.states.set(st.destinationId, st);
    const dest = this.safeDestination(st.destinationId);
    if (dest) this.refreshDestination(dest);
  }

  private refreshAll(): void {
    const list = this.safeDestinations();
    // A failed listing is not an empty one: keep the tracks (and their down state) until it works again.
    if (list === null) return;
    const present = new Set<string>();
    for (const dest of list) {
      present.add(dest.id);
      this.refreshDestination(dest);
    }
    for (const [id, track] of this.destinations) {
      if (present.has(id)) continue;
      if (track.timer) clearTimeout(track.timer);
      this.destinations.delete(id);
      // A deleted destination isn't down any more: close its down edge so clients don't keep a red row.
      if (track.down && track.sent) {
        const now = this.now();
        this.publish<ApiDestinationUp>('destination.up', source(id, track.sent.platform), {
          destinationId: id,
          name: track.sent.name,
          platform: track.sent.platform,
          downForSec: Math.max(0, Math.round((now - (track.downSince ?? now)) / 1000)),
          recoveries: track.sent.recoveries,
        });
      }
    }
  }

  private buildDestination(dest: Destination): ApiDestination {
    return apiDestination(dest, this.states.get(dest.id), this.session, this.safePlatformInfo(dest.platform));
  }

  private refreshDestination(dest: Destination): void {
    let track = this.destinations.get(dest.id);
    if (!track) {
      track = { sent: null, sentAt: 0, timer: null, down: false, downSince: null };
      this.destinations.set(dest.id, track);
    }
    const item = this.buildDestination(dest);
    const src = source(dest.id, dest.platform);
    this.update(track, item, DESTINATION_STATS_KEYS, (d) => this.publish('destination.status', src, d), () => {
      const current = this.deps.destination(dest.id);
      return current ? this.buildDestination(current) : null;
    });

    if (item.down !== track.down) {
      const now = this.now();
      if (item.down) {
        track.downSince = now;
        this.publish<ApiDestinationDown>('destination.down', src, {
          destinationId: dest.id,
          name: dest.name,
          platform: dest.platform,
          phase: item.phase,
          reason: item.message,
        });
      } else {
        const since = track.downSince ?? now;
        track.downSince = null;
        this.publish<ApiDestinationUp>('destination.up', src, {
          destinationId: dest.id,
          name: dest.name,
          platform: dest.platform,
          downForSec: Math.max(0, Math.round((now - since) / 1000)),
          recoveries: item.recoveries,
        });
      }
      track.down = item.down;
    }
  }

  private onFeed(f: FeedState): void {
    let track = this.feeds.get(f.feed);
    if (!track) {
      track = { sent: null, sentAt: 0, timer: null };
      this.feeds.set(f.feed, track);
    }
    const item = apiFeed(f);
    this.latestFeeds.set(f.feed, item);
    // A trailing (throttled) send uses the newest state of that feed.
    this.update(track, item, FEED_STATS_KEYS, (value) => this.publish('feed.status', CORE_SOURCE, value), () => this.latestFeeds.get(f.feed) ?? null);
  }

  /**
   * Send `item` now when something other than `statsKeys` changed (or it was never sent); when only
   * stats changed, send at most once per throttle window (trailing send with the latest value).
   */
  private update<T extends object>(
    track: Throttled<T>,
    item: T,
    statsKeys: readonly (keyof T)[],
    send: (item: T) => void,
    latest: () => T | null,
  ): void {
    const sendNow = (value: T) => {
      if (track.timer) clearTimeout(track.timer);
      track.timer = null;
      track.sent = value;
      track.sentAt = this.now();
      send(value);
    };
    if (track.sent === null) return sendNow(item);
    if (deepEqual(track.sent, item)) return;
    if (!deepEqual(withoutKeys(track.sent, statsKeys), withoutKeys(item, statsKeys))) return sendNow(item);
    // Stats-only change.
    const wait = track.sentAt + this.throttleMs - this.now();
    if (wait <= 0 && !track.timer) return sendNow(item);
    if (track.timer) return;
    track.timer = setTimeout(() => {
      track.timer = null;
      // Timer callbacks run outside the bus handlers' guard: a throwing repo read here would
      // otherwise be an uncaught exception that takes the whole process down.
      this.guard(() => {
        const value = latest();
        if (value && !deepEqual(value, track.sent)) sendNow(value);
      });
    }, Math.max(0, wait));
    track.timer.unref?.();
  }

  // -------------------------------------------------------------------------
  // Defensive accessors (a failing repo must not break the bus)
  // -------------------------------------------------------------------------

  /** The destinations, or null when listing them failed (never mistake a failure for "none"). */
  private safeDestinations(): Destination[] | null {
    try {
      return this.deps.destinations();
    } catch (err) {
      this.deps.log.warn({ error: (err as Error).message }, 'api event hub: listing destinations failed');
      return null;
    }
  }

  private safeDestination(id: string): Destination | null {
    try {
      return this.deps.destination(id);
    } catch {
      return null;
    }
  }

  private safePlatformInfo(platform: Destination['platform']): PlatformInfo | null {
    try {
      return this.deps.platformInfo(platform);
    } catch {
      return null;
    }
  }
}

const hubs = new WeakMap<AppServices, EventHub>();

/** The API event hub of these services (created on first use; main.ts calls it at startup). */
export function eventHubFor(services: AppServices): EventHub {
  let hub = hubs.get(services);
  if (!hub) {
    hub = new EventHub({
      bus: services.bus,
      log: services.log.child({ mod: 'api-events' }),
      state: () => services.orchestrator.state(),
      destinations: () => services.repos.destinations.list(),
      destination: (id) => services.repos.destinations.get(id),
      platformInfo: (platform) => {
        try {
          return services.platforms.get(platform).info;
        } catch {
          return null;
        }
      },
    });
    hubs.set(services, hub);
  }
  return hub;
}
