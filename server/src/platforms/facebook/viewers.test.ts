import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveHealthEvent } from '../types.js';
import { GraphClient } from './graph.js';
import { graphErr, graphPath, json, param, stubFetch } from './test-utils.js';
import { parseLiveViews, watchLiveViews, type LiveViewsOptions, type LiveViewsTimings } from './viewers.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const FAST: Partial<LiveViewsTimings> = { pollMs: 5, pauseMs: 60, rateLimitWaitMs: 60 };

function options(timings: Partial<LiveViewsTimings> = FAST): LiveViewsOptions {
  return {
    graph: new GraphClient({ host: 'https://graph.test', appSecret: 'sek' }),
    liveVideoId: '5555',
    token: 'PAGE-TOKEN',
    log: pino({ level: 'silent' }),
    timings,
  };
}

/** Responses in order; the last one repeats. */
function sequence(...responses: Response[]) {
  let i = 0;
  return stubFetch(() => (responses[Math.min(i++, responses.length - 1)] as Response).clone());
}

async function events(n: number, opts = options(), ms = 2_000): Promise<LiveHealthEvent[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const out: LiveHealthEvent[] = [];
  try {
    for await (const ev of watchLiveViews(opts, ctl.signal)) {
      out.push(ev);
      if (out.length >= n) break;
    }
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
  return out;
}

describe('parseLiveViews', () => {
  it('reads integer counts, null otherwise', () => {
    expect(parseLiveViews(12)).toBe(12);
    expect(parseLiveViews('7')).toBe(7);
    expect(parseLiveViews(0)).toBe(0);
    expect(parseLiveViews(undefined)).toBeNull();
    expect(parseLiveViews(-1)).toBeNull();
    expect(parseLiveViews(2.5)).toBeNull();
    expect(parseLiveViews('many')).toBeNull();
  });
});

describe('watchLiveViews', () => {
  it('reads live_views with the Page token and reports changes only', async () => {
    const calls = sequence(json(200, { id: '5555' }), json(200, { live_views: 4, id: '5555' }), json(200, { live_views: 4 }), json(200, { live_views: 9 }));
    expect(await events(3)).toEqual([
      { type: 'viewers', count: null },
      { type: 'viewers', count: 4 },
      { type: 'viewers', count: 9 },
    ]);
    expect(calls).toHaveLength(4);
    const call = calls[0]!;
    expect(call.method).toBe('GET');
    expect(graphPath(call.url)).toBe('5555');
    expect(param(call, 'fields')).toBe('live_views');
    expect(param(call, 'access_token')).toBe('PAGE-TOKEN');
    expect(param(call, 'appsecret_proof')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the last count through one transient failure, then reports unknown', async () => {
    const calls = sequence(json(200, { live_views: 3 }), graphErr(500, 2, 'temporary'), json(200, { live_views: 3 }), graphErr(500, 2, 'temporary'));
    expect(await events(2)).toEqual([
      { type: 'viewers', count: 3 },
      { type: 'viewers', count: null },
    ]);
    expect(calls).toHaveLength(5);
  });

  it('reports unknown at once and slows down on a token problem or a rate limit', async () => {
    sequence(json(200, { live_views: 2 }), graphErr(400, 190, 'Error validating access token'), json(200, { live_views: 6 }));
    const started = Date.now();
    expect(await events(3)).toEqual([
      { type: 'viewers', count: 2 },
      { type: 'viewers', count: null },
      { type: 'viewers', count: 6 },
    ]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);

    sequence(graphErr(400, 32, 'Page request limit reached'), json(200, { live_views: 1 }));
    expect(await events(2)).toEqual([
      { type: 'viewers', count: null },
      { type: 'viewers', count: 1 },
    ]);
  });

  it('polls every 30 s by default and stops promptly on abort', async () => {
    const calls = sequence(json(200, { live_views: 1 }));
    const ctl = new AbortController();
    const it = watchLiveViews(options({}), ctl.signal)[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ type: 'viewers', count: 1 });
    const next = it.next();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(1);
    ctl.abort();
    await expect(next).resolves.toMatchObject({ done: true });
  });
});
