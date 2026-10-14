import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveHealthEvent } from '../types.js';
import { API_BASE, YouTubeClient } from './api.js';
import { FetchStub, googleError, json, silentLog } from './test-utils.js';
import { parseConcurrentViewers, watchViewers, type ViewerTimings } from './viewers.js';

const VIDEOS = `${API_BASE}/videos`;
const FAST: Partial<ViewerTimings> = { pollMs: 5, quotaWaitMs: 60, pauseMs: 60 };

let stub: FetchStub;
const client = new YouTubeClient({ token: async () => 'tok', refresh: async () => 'tok2' });

beforeEach(() => {
  stub = new FetchStub();
  vi.stubGlobal('fetch', stub.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const live = (concurrentViewers?: string | number) =>
  json({ items: [{ id: 'bc-1', liveStreamingDetails: { actualStartTime: '2026-10-11T12:00:00Z', ...(concurrentViewers === undefined ? {} : { concurrentViewers }) } }] });

/** Collect `n` events (or until `ms` elapse), then abort the watcher. */
async function events(n: number, timings: Partial<ViewerTimings> = FAST, ms = 2_000): Promise<LiveHealthEvent[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const out: LiveHealthEvent[] = [];
  try {
    for await (const ev of watchViewers(client, 'bc-1', silentLog, timings)(ctl.signal)) {
      out.push(ev);
      if (out.length >= n) break;
    }
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
  return out;
}

describe('parseConcurrentViewers', () => {
  it('reads uint64 strings and numbers, null otherwise', () => {
    expect(parseConcurrentViewers('1234')).toBe(1234);
    expect(parseConcurrentViewers(' 0 ')).toBe(0);
    expect(parseConcurrentViewers(17)).toBe(17);
    expect(parseConcurrentViewers(undefined)).toBeNull();
    expect(parseConcurrentViewers('')).toBeNull();
    expect(parseConcurrentViewers('-3')).toBeNull();
    expect(parseConcurrentViewers('12abc')).toBeNull();
    expect(parseConcurrentViewers(1.5)).toBeNull();
  });
});

describe('watchViewers', () => {
  it('reads videos.list liveStreamingDetails for the broadcast and reports changes only', async () => {
    stub.on('GET', VIDEOS, live(), live('10'), live('10'), live('12'));
    const out = await events(3);
    expect(out).toEqual([
      { type: 'viewers', count: null }, // not live yet: concurrentViewers absent
      { type: 'viewers', count: 10 },
      { type: 'viewers', count: 12 },
    ]);
    const call = stub.callsTo('GET', VIDEOS)[0]!;
    expect(Object.fromEntries(call.url.searchParams)).toEqual({ part: 'liveStreamingDetails', id: 'bc-1' });
    expect(call.headers.authorization).toBe('Bearer tok');
    expect(stub.callsTo('GET', VIDEOS)).toHaveLength(4);
  });

  it('reports null when the video is gone', async () => {
    stub.on('GET', VIDEOS, live('3'), json({ items: [] }));
    expect(await events(2)).toEqual([
      { type: 'viewers', count: 3 },
      { type: 'viewers', count: null },
    ]);
  });

  it('keeps the last count through one transient failure, then reports unknown', async () => {
    stub.on('GET', VIDEOS, live('5'), googleError(500, 'backendError'), live('5'), googleError(503, 'backendError'), googleError(503, 'backendError'));
    const out = await events(2);
    expect(out).toEqual([
      { type: 'viewers', count: 5 },
      { type: 'viewers', count: null },
    ]);
    expect(stub.callsTo('GET', VIDEOS)).toHaveLength(5);
  });

  it('waits out an exhausted quota (count unknown meanwhile)', async () => {
    stub.on('GET', VIDEOS, live('8'), googleError(403, 'quotaExceeded'), live('9'));
    const started = Date.now();
    const out = await events(3);
    expect(out).toEqual([
      { type: 'viewers', count: 8 },
      { type: 'viewers', count: null },
      { type: 'viewers', count: 9 },
    ]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });

  it('polls once a minute by default and ends promptly on abort, without throwing', async () => {
    stub.on('GET', VIDEOS, live('1'));
    const ctl = new AbortController();
    const it = watchViewers(client, 'bc-1', silentLog)(ctl.signal)[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ type: 'viewers', count: 1 });
    const next = it.next();
    await new Promise((r) => setTimeout(r, 30));
    expect(stub.callsTo('GET', VIDEOS)).toHaveLength(1); // the next read is a minute away
    ctl.abort();
    await expect(next).resolves.toMatchObject({ done: true });
  });
});
