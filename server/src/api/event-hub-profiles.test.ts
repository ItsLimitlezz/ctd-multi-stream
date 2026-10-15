// The event hub with several profiles: src.profile, per-profile tracks, chat buffers, profile.status,
// reader visibility (profile views, token limits, directed app messages, apps.changed rendering).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ConnectedApp, Destination, ProfileSummary, SessionState } from '../../../shared/types.js';
import { EventBus, type AppMessage } from '../events.js';
import { EventHub, type EventReader } from './event-hub.js';
import { dest, dstate, offline, platformInfo, session, silentLog } from './test-helpers.js';
import type { ApiAppsChanged, Envelope } from './types.js';

const A = 'default';
const B = 'prof-b';
const T0 = Date.parse('2026-10-17T03:00:00.000Z');

let bus: EventBus;
let destinations: Destination[];
let states: Map<string, SessionState>;
let profiles: string[];
let apps: ConnectedApp[];
let hub: EventHub;
let events: Envelope[];

function summary(id: string): ProfileSummary {
  const s = states.get(id) ?? offline(id);
  const mine = destinations.filter((d) => (d.profileId ?? A) === id && d.enabled);
  const phases = new Map(s.destinations.map((st) => [st.destinationId, st.phase]));
  return {
    id,
    name: id.toUpperCase(),
    slug: id,
    color: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    status: s.status,
    startedAt: s.startedAt,
    testMode: s.testMode === true,
    destinations: mine.length,
    live: mine.filter((d) => phases.get(d.id) === 'live').length,
    down: 0,
  };
}

function makeHub(): EventHub {
  const h = new EventHub({
    bus,
    log: silentLog,
    state: (id) => {
      if (!profiles.includes(id)) throw new Error('unknown profile');
      return states.get(id) ?? offline(id);
    },
    destinations: () => destinations,
    destination: (id) => destinations.find((d) => d.id === id) ?? null,
    platformInfo,
    profiles: () => profiles.map((id) => ({ id })),
    summaries: () => profiles.map(summary),
    apps: () => apps,
  });
  h.subscribe((e) => events.push(e));
  return h;
}

function chat(id: string, destinationId: string, profileId?: string): ChatMessage {
  return {
    id: `twitch:${id}`,
    platform: 'twitch',
    destinationId,
    ...(profileId ? { profileId } : {}),
    author: { name: 'Ann', id: 'u1' },
    text: `msg ${id}`,
    ts: new Date().toISOString(),
    kind: 'message',
  };
}

function app(id: string, tokenId: string, profileId: string | null, resources: ConnectedApp['resources'] = []): ConnectedApp {
  return {
    id,
    name: id,
    kind: 'custom',
    version: null,
    baseUrl: null,
    capabilities: [],
    resources,
    tokenId,
    profileId,
    registeredAt: '2026-10-17T03:00:00.000Z',
    lastSeenAt: '2026-10-17T03:00:00.000Z',
    online: true,
  };
}

const reader = (over: Partial<EventReader> = {}): EventReader => ({ tokenId: 'tok', tokenProfile: null, profile: null, ...over });
const typesOf = (list: Envelope[]) => list.map((e) => e.type);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  bus = new EventBus();
  profiles = [A, B];
  destinations = [dest('a1', { name: 'Twitch A', profileId: A }), dest('b1', { name: 'Kick B', platform: 'kick', profileId: B }), dest('b2', { name: 'YouTube B', platform: 'youtube', profileId: B })];
  states = new Map([
    [A, offline()],
    [B, offline(B)],
  ]);
  apps = [];
  events = [];
  hub = makeHub();
});

afterEach(() => {
  hub.close();
  vi.useRealTimers();
});

describe('profiles in envelopes', () => {
  it('stream.status per profile, with src.profile; a session event of B does not touch A', () => {
    const live = session({ profileId: B, destinations: [dstate('b1', 'live'), dstate('b2', 'live')] });
    states.set(B, live);
    bus.emit('session', live);
    const stream = events.filter((e) => e.type === 'stream.status');
    expect(stream).toHaveLength(1);
    expect(stream[0]!.src).toEqual({ connector: 'ctd-multi-stream', connection: 'core', platform: 'core', profile: B });
    // The destinations of B moved; A's didn't.
    const statuses = events.filter((e) => e.type === 'destination.status');
    expect(statuses.map((e) => e.src.connection).sort()).toEqual(['b1', 'b2']);
    expect(statuses.every((e) => e.src.profile === B)).toBe(true);

    // Same session again: nothing. A session event without profileId is the default profile's.
    events = [];
    bus.emit('session', live);
    expect(events.filter((e) => e.type === 'stream.status')).toEqual([]);
    bus.emit('session', { ...offline(), title: 'A title' });
    expect(events.find((e) => e.type === 'stream.status')!.src.profile).toBe(A);
  });

  it('feeds are tracked per profile', () => {
    const base = { ...session().feeds[0]!, online: false, since: null, video: null, bitrateKbps: null };
    bus.emit('feed', { ...base, profileId: B });
    bus.emit('feed', { ...base, profileId: A });
    bus.emit('feed', { ...base, profileId: B }); // unchanged for B
    expect(events.map((e) => [e.type, e.src.profile])).toEqual([
      ['feed.status', B],
      ['feed.status', A],
    ]);
    expect(events[0]!.data).not.toHaveProperty('profileId'); // the documented feed shape
  });

  it('down/up edges use the session of the destination’s own profile', () => {
    const b = session({ profileId: B, destinations: [dstate('b1', 'live'), dstate('b2', 'error', { message: 'boom' })] });
    states.set(B, b);
    bus.emit('session', b);
    const down = events.filter((e) => e.type === 'destination.down');
    expect(down).toHaveLength(1);
    expect(down[0]!.src).toMatchObject({ connection: 'b2', profile: B });
    // Profile A is offline: an error state there is never down.
    bus.emit('destination', dstate('a1', 'error', { profileId: A }));
    expect(events.filter((e) => e.type === 'destination.down')).toHaveLength(1);
  });

  it('notices carry their profile (null for the whole server)', () => {
    bus.emit('notice', { level: 'warn', message: 'DPRTMNT · Instagram ended the live', profileId: B });
    bus.emit('notice', { level: 'info', message: 'Certificate renewed' });
    expect(events.map((e) => e.src.profile)).toEqual([B, null]);
  });
});

describe('chat per profile', () => {
  it('keeps one backfill buffer per profile; moderation applies in its own profile', () => {
    bus.emit('chat', chat('1', 'a1', A));
    bus.emit('chat', chat('2', 'b1', B));
    bus.emit('chat', chat('3', 'b1')); // no profileId: taken from the destination
    expect(hub.chat(200).items.map((e) => e.data.id)).toEqual(['twitch:1']);
    expect(hub.chat(200, undefined, B).items.map((e) => e.data.id)).toEqual(['twitch:2', 'twitch:3']);
    expect(events.filter((e) => e.type === 'chat.message').map((e) => e.src.profile)).toEqual([A, B, B]);

    bus.emit('chat-moderation', { kind: 'cleared', platform: 'twitch', destinationId: 'b1', ts: '', profileId: B });
    expect(hub.chat(200, undefined, B).items).toEqual([]);
    expect(hub.chat(200, undefined, A).items).toHaveLength(1);
    expect(hub.chat(200, undefined, 'nope')).toEqual({ items: [], next: hub.cursor() });
  });
});

describe('profile.status and profiles.changed', () => {
  it('profile.status when a profile’s summary changes, once per change', () => {
    const b = session({ profileId: B, destinations: [dstate('b1', 'live'), dstate('b2', 'connecting')] });
    states.set(B, b);
    bus.emit('session', b);
    const ps = events.filter((e) => e.type === 'profile.status');
    expect(ps).toHaveLength(1);
    expect(ps[0]!.src.profile).toBe(B);
    expect(ps[0]!.data).toMatchObject({ id: B, status: 'live', destinations: 2, live: 1, down: 0 });
    expect(Object.keys(ps[0]!.data as object)).toEqual(['id', 'name', 'slug', 'color', 'status', 'startedAt', 'testMode', 'destinations', 'live', 'down', 'createdAt', 'updatedAt']);

    // A phase change that moves the counts.
    states.set(B, { ...b, destinations: [dstate('b1', 'live'), dstate('b2', 'live')] });
    bus.emit('destination', dstate('b2', 'live', { profileId: B }));
    expect(events.filter((e) => e.type === 'profile.status')).toHaveLength(2);
    // Stats-only updates don't recompute anything.
    bus.emit('destination', dstate('b2', 'live', { profileId: B, viewers: 5 }));
    expect(events.filter((e) => e.type === 'profile.status')).toHaveLength(2);
  });

  it('a deleted profile: profiles.changed, its chat is dropped and its down destinations close with destination.up', () => {
    const b = session({ profileId: B, destinations: [dstate('b1', 'error', { message: 'x' })] });
    states.set(B, b);
    bus.emit('session', b);
    bus.emit('chat', chat('1', 'b1', B));
    expect(events.some((e) => e.type === 'destination.down')).toBe(true);

    profiles = [A];
    destinations = destinations.filter((d) => d.profileId !== B);
    states.delete(B);
    events = [];
    bus.emit('profiles-changed');
    expect(events[0]).toMatchObject({ type: 'profiles.changed', data: {}, src: { profile: null } });
    expect(typesOf(events)).toContain('destination.up');
    expect(hub.chat(200, undefined, B).items).toEqual([]);
  });

  it('a new profile gets a track: its first session change is announced', () => {
    profiles = [A, B, 'prof-c'];
    bus.emit('profiles-changed');
    events = [];
    const c = session({ profileId: 'prof-c' });
    states.set('prof-c', c);
    bus.emit('session', c);
    expect(events.find((e) => e.type === 'stream.status')!.src.profile).toBe('prof-c');
  });
});

describe('snapshot', () => {
  it('one profile, or every profile', () => {
    expect(hub.snapshot(B).map((e) => [e.type, e.src.profile, e.src.connection])).toEqual([
      ['stream.status', B, 'core'],
      ['destination.status', B, 'b1'],
      ['destination.status', B, 'b2'],
    ]);
    expect(typesOf(hub.snapshot())).toEqual(['stream.status', 'destination.status', 'stream.status', 'destination.status', 'destination.status']);
    expect(hub.status(B).destinations.map((d) => d.id)).toEqual(['b1', 'b2']);
    expect(hub.status().destinations.map((d) => d.id)).toEqual(['a1']);
  });
});

describe('visibility', () => {
  it('profile views and token limits', () => {
    bus.emit('chat', chat('1', 'a1', A));
    bus.emit('chat', chat('2', 'b1', B));
    bus.emit('notice', { level: 'info', message: 'everyone' });
    const all = hub.since(hub.floor).items;
    const seen = (r: EventReader) => all.filter((e) => hub.visible(e, r)).map((e) => e.src.profile);
    expect(seen(reader())).toEqual([A, B, null]);
    expect(seen(reader({ profile: B }))).toEqual([B, null]);
    expect(seen(reader({ tokenProfile: A, profile: A }))).toEqual([A, null]);
    // A limited token never sees another profile, whatever view it asks for.
    expect(seen(reader({ tokenProfile: A, profile: null }))).toEqual([A, null]);
  });

  it('app.message: broadcasts reach everyone (but not tokens of another profile); directed ones only the recipient’s token', () => {
    apps = [app('ctd-overlay', 'tok-overlay', null), app('obs', 'tok-obs', B)];
    const msg = (over: Partial<AppMessage>): AppMessage => ({
      id: '01JA7Q8M9X2V4C6B8N0P2R4T6W',
      from: 'obs',
      fromTokenId: 'tok-obs',
      to: null,
      type: 'overlay.create',
      profileId: null,
      replyTo: null,
      data: { template: 'takeover' },
      ts: new Date(T0).toISOString(),
      ...over,
    });
    bus.emit('app-message', msg({ to: 'ctd-overlay', profileId: B }));
    bus.emit('app-message', msg({ to: null, profileId: A }));
    bus.emit('app-message', msg({ to: null, profileId: null }));
    bus.emit('app-message', msg({ to: 'gone', profileId: null }));
    const [direct, broadcastA, broadcastAll, nobody] = events as [Envelope, Envelope, Envelope, Envelope];
    expect(direct.data).toEqual({
      id: '01JA7Q8M9X2V4C6B8N0P2R4T6W',
      from: 'obs',
      to: 'ctd-overlay',
      type: 'overlay.create',
      profileId: B,
      replyTo: null,
      data: { template: 'takeover' },
      ts: T0,
    });
    expect(direct.src).toMatchObject({ connection: 'core', platform: 'core', profile: B });

    const overlay = reader({ tokenId: 'tok-overlay' });
    const obsB = reader({ tokenId: 'tok-obs', tokenProfile: B, profile: B });
    expect(hub.visible(direct, overlay)).toBe(direct);
    expect(hub.visible(direct, reader({ tokenId: 'someone-else' }))).toBeNull();
    expect(hub.visible(broadcastA, overlay)).toBe(broadcastA);
    expect(hub.visible(broadcastA, obsB)).toBeNull(); // limited to another profile
    expect(hub.visible(broadcastAll, obsB)).toBe(broadcastAll);
    expect(hub.visible(nobody, overlay)).toBeNull();
    expect(hub.visible(nobody, reader({ tokenId: '' }))).toBeNull();
  });

  it('apps.changed lists the apps as seen from the reader’s profile, without token ids', () => {
    apps = [
      app('ctd-overlay', 'tok-1', null, [
        { type: 'overlay', id: 'oa', name: 'A overlay', profileId: A, url: 'http://x/a' },
        { type: 'overlay', id: 'ob', name: 'B overlay', profileId: B, url: 'http://x/b' },
        { type: 'overlay', id: 'on', name: 'Any', profileId: null, url: 'http://x/n' },
      ]),
      app('ctd-overlay-b', 'tok-2', B),
    ];
    bus.emit('apps-changed');
    const env = events[0]! as Envelope<ApiAppsChanged>;
    expect(env).toMatchObject({ type: 'apps.changed', src: { profile: null } });
    expect(env.data.apps.map((a) => a.id)).toEqual(['ctd-overlay', 'ctd-overlay-b']);
    expect(env.data.apps[0]).not.toHaveProperty('tokenId');

    const asA = hub.visible(env, reader({ profile: A })) as Envelope<ApiAppsChanged>;
    expect(asA.id).toBe(env.id);
    expect(asA.data.apps.map((a) => a.id)).toEqual(['ctd-overlay']); // the B-limited app is left out
    expect(asA.data.apps[0]!.resources.map((r) => r.id)).toEqual(['oa', 'on']);
    const asLimitedB = hub.visible(env, reader({ tokenProfile: B, profile: B })) as Envelope<ApiAppsChanged>;
    expect(asLimitedB.data.apps.map((a) => a.id)).toEqual(['ctd-overlay', 'ctd-overlay-b']);
    expect(asLimitedB.data.apps[0]!.resources.map((r) => r.id)).toEqual(['ob', 'on']);
    expect(hub.visible(env, reader())).toBe(env); // every profile: unfiltered
  });

  it('a reader only resets for lost events it would have received', () => {
    hub.close();
    events = [];
    hub = new EventHub({
      bus,
      log: silentLog,
      state: (id) => states.get(id) ?? offline(id),
      destinations: () => destinations,
      destination: (id) => destinations.find((d) => d.id === id) ?? null,
      platformInfo,
      profiles: () => profiles.map((id) => ({ id })),
      bufferMax: 10,
    });
    bus.emit('chat', chat('0', 'a1', A));
    const cursor = hub.cursor();
    for (let i = 0; i < 20; i++) bus.emit('chat', chat(`b${i}`, 'b1', B));
    const chatTypes = new Set(['chat.message', 'system.reset'] as const);
    expect(hub.since(cursor, chatTypes, reader({ profile: A })).reset).toBe(false);
    expect(hub.since(cursor, chatTypes, reader({ tokenProfile: A, profile: A })).reset).toBe(false);
    expect(hub.since(cursor, chatTypes, reader({ profile: B })).reset).toBe(true);
    expect(hub.since(cursor, chatTypes, reader()).reset).toBe(true);
    expect(hub.since(cursor, chatTypes).reset).toBe(true);

    // A directed app message lost from the buffer only resets its recipient.
    apps = [app('obs', 'tok-obs', null)];
    hub.close();
    events = [];
    hub = new EventHub({
      bus,
      log: silentLog,
      state: (id) => states.get(id) ?? offline(id),
      destinations: () => destinations,
      destination: (id) => destinations.find((d) => d.id === id) ?? null,
      platformInfo,
      apps: () => apps,
      bufferMax: 3,
    });
    const c2 = hub.cursor();
    bus.emit('app-message', { id: '01JA7Q8M9X2V4C6B8N0P2R4T6W', from: null, fromTokenId: 't', to: 'obs', type: 'x', profileId: null, replyTo: null, data: {}, ts: '' });
    for (let i = 0; i < 5; i++) bus.emit('notice', { level: 'info', message: String(i), profileId: B });
    const msgTypes = new Set(['app.message', 'system.reset'] as const);
    expect(hub.since(c2, msgTypes, reader({ tokenId: 'tok-obs' })).reset).toBe(true);
    expect(hub.since(c2, msgTypes, reader({ tokenId: 'other' })).reset).toBe(false);
  });
});
