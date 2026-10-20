// /api/v1 since v1.4: OBS events into the hub, OBS state per profile, feed previews.

import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE_ID, type Feed, type Profile } from '../../../shared/types.js';
import { PROBLEM_TYPE } from './http.js';
import { OBS_STATS_EMIT_MS } from './obs.js';
import { PreviewService, previewArgs } from './previews.js';
import { createTestApi, type TestApi } from './test-helpers.js';
import type { Envelope } from './types.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

let t: TestApi;
let club: Profile;
let obs: string;
let reader: string;
let online: Record<string, boolean>;
let grabs: string[];
let clock: number;

beforeEach(async () => {
  online = { [`${DEFAULT_PROFILE_ID}:landscape`]: true };
  grabs = [];
  clock = Date.now();
  const previews = new PreviewService({
    online: (p, f) => online[`${p}:${f}`] === true,
    grab: async (p: string, f: Feed) => {
      grabs.push(`${p}:${f}`);
      if (online[`${p}:${f}:fail`]) throw new Error('decoder error');
      return JPEG;
    },
    now: () => clock,
  });
  t = await createTestApi({ previews });
  club = t.addProfile('DPRTMNT', '#E11D48');
  obs = t.token(['apps:read', 'apps:write', 'obs:write', 'status:read'], 'obs plugin');
  reader = t.token(['status:read'], 'ctd live mobile');
});
afterEach(async () => {
  await t.close();
});

type Body = Record<string, unknown>;
const call = (method: 'GET' | 'POST' | 'PUT', url: string, token: string | null, body?: Body) =>
  t.app.inject({
    method,
    url,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { payload: JSON.stringify(body) } : {}),
  });

function expectProblem(res: LightMyRequestResponse, status: number, code: string) {
  expect(res.statusCode, res.body).toBe(status);
  expect(res.json()).toEqual({ type: PROBLEM_TYPE, title: expect.any(String), status, detail: expect.any(String), code });
}

const register = (token = obs, id = 'ctd-obs-plugin-studio') =>
  call('PUT', `/api/v1/apps/${id}`, token, { name: 'CTD OBS plugin', kind: 'ctd-obs-plugin' });

const ev = (id: string, type: string, data: Body, ts = Date.now()) => ({ id, type, ts, data });

describe('POST /apps/{appId}/events', () => {
  it('accepts a batch, keeps the latest state and re-emits obs.* on /events', async () => {
    expect((await register()).statusCode).toBe(200);
    const start = t.hub.cursor();
    const res = await call('POST', '/api/v1/apps/ctd-obs-plugin-studio/events', obs, {
      events: [
        ev('e1', 'obs.feed.state', { source: { name: 'Club cam', path: 'live/club', server: 'srt://x' }, state: 'NO_SIGNAL', previous: 'LIVE', gapMs: 0 }),
        ev('e2', 'obs.output', { output: 'main', canvas: 'landscape', state: 'live' }),
        ev('e3', 'obs.scene', { canvas: 'vertical', scene: 'Takeover' }),
        ev('e4', 'obs.feed.stats', { source: { name: 'Club cam' }, fps: 59.9, width: 1920, height: 1080 }),
        ev('e5', 'obs.something.new', { x: 1 }), // unknown: ignored, not refused
        { id: 'bad' }, // malformed: ignored
      ],
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toEqual({ accepted: 4, ignored: 2 });

    const state = (await call('GET', `/api/v1/profiles/${DEFAULT_PROFILE_ID}/obs`, reader)).json();
    expect(state.apps).toHaveLength(1);
    expect(state.apps[0]).toMatchObject({
      appId: 'ctd-obs-plugin-studio',
      online: true,
      feeds: [{ source: 'Club cam', state: 'NO_SIGNAL', previous: 'LIVE', info: { name: 'Club cam', path: 'live/club' }, stats: { fps: 59.9, width: 1920 } }],
      outputs: [{ output: 'main', canvas: 'landscape', state: 'live' }],
      scenes: [{ canvas: 'vertical', scene: 'Takeover' }],
    });

    const items = (await call('GET', `/api/v1/events/poll?after=${start}&types=obs.*`, reader)).json().items as Envelope<Body>[];
    expect(items.map((e) => e.type)).toEqual(['obs.feed.state', 'obs.output', 'obs.scene', 'obs.feed.stats']);
    expect(items[0]).toMatchObject({
      src: { connection: 'ctd-obs-plugin-studio', platform: 'obs', profile: DEFAULT_PROFILE_ID },
      data: { state: 'NO_SIGNAL', appId: 'ctd-obs-plugin-studio', eventId: 'e1', at: expect.any(Number) },
    });
  });

  it('drops duplicate ids and throttles stats re-emits (state still updates)', async () => {
    await register();
    const start = t.hub.cursor();
    const post = (events: unknown[]) => call('POST', '/api/v1/apps/ctd-obs-plugin-studio/events', obs, { events });
    expect((await post([ev('a', 'obs.scene', { canvas: 'landscape', scene: 'One' })])).json()).toEqual({ accepted: 1, ignored: 0 });
    expect((await post([ev('a', 'obs.scene', { canvas: 'landscape', scene: 'One' })])).json()).toEqual({ accepted: 0, ignored: 1 });
    await post([ev('s1', 'obs.feed.stats', { source: { name: 'Cam' }, fps: 30 })]);
    await post([ev('s2', 'obs.feed.stats', { source: { name: 'Cam' }, fps: 29 })]); // within 5 s: not re-emitted
    const types = (await call('GET', `/api/v1/events/poll?after=${start}&types=obs.*`, reader)).json().items.map((e: Envelope) => e.type);
    expect(types).toEqual(['obs.scene', 'obs.feed.stats']);
    expect(OBS_STATS_EMIT_MS).toBe(5000);
    const feeds = (await call('GET', `/api/v1/profiles/${DEFAULT_PROFILE_ID}/obs`, reader)).json().apps[0].feeds;
    expect(feeds[0].stats).toEqual({ fps: 29 });
  });

  it('the plugin\'s 60 s full-state resend refreshes the state but only changes are re-emitted', async () => {
    await register();
    const start = t.hub.cursor();
    const post = (events: unknown[]) => call('POST', '/api/v1/apps/ctd-obs-plugin-studio/events', obs, { events });
    const vertical = { output: 'Aitum Stream Suite Output Vertical Stream', canvas: 'vertical', state: 'live' };
    await post([ev('b-1', 'obs.output', vertical), ev('b-2', 'obs.scene', { canvas: 'landscape', scene: 'Main' })]);
    await post([ev('b-3', 'obs.output', { ...vertical }), ev('b-4', 'obs.scene', { canvas: 'landscape', scene: 'Main' })]); // resend: same
    await post([ev('b-5', 'obs.output', { ...vertical, state: 'reconnecting' })]); // a change
    const items = (await call('GET', `/api/v1/events/poll?after=${start}&types=obs.*`, reader)).json().items as Envelope<Body>[];
    expect(items.map((e) => `${e.type}:${String(e.data.state ?? e.data.scene)}`)).toEqual(['obs.output:live', 'obs.scene:Main', 'obs.output:reconnecting']);
    const outputs = (await call('GET', `/api/v1/profiles/${DEFAULT_PROFILE_ID}/obs`, reader)).json().apps[0].outputs;
    expect(outputs).toEqual([{ ...vertical, state: 'reconnecting', updatedAt: expect.any(Number) }]);
  });

  it('needs obs:write, a registered app owned by the token, and a valid body', async () => {
    await register();
    const noScope = t.token(['apps:write'], 'old plugin token');
    expectProblem(await call('POST', '/api/v1/apps/ctd-obs-plugin-studio/events', noScope, { events: [ev('x', 'obs.scene', { scene: 'A' })] }), 403, 'missing_scope');
    expectProblem(await call('POST', '/api/v1/apps/nobody/events', obs, { events: [ev('x', 'obs.scene', { scene: 'A' })] }), 404, 'not_found');
    const other = t.token(['apps:write', 'obs:write'], 'other');
    expectProblem(await call('POST', '/api/v1/apps/ctd-obs-plugin-studio/events', other, { events: [ev('x', 'obs.scene', { scene: 'A' })] }), 409, 'app_owned');
    expectProblem(await call('POST', '/api/v1/apps/ctd-obs-plugin-studio/events', obs, { events: [] }), 400, 'invalid');
    const many = Array.from({ length: 51 }, (_, i) => ev(`m${i}`, 'obs.scene', { scene: 'A' }));
    expectProblem(await call('POST', '/api/v1/apps/ctd-obs-plugin-studio/events', obs, { events: many }), 400, 'invalid');
  });

  it('a profile-limited token sends for its own profile only; readers of other profiles never see it', async () => {
    const clubObs = t.token(['apps:write', 'obs:write'], 'club obs', club.id);
    await register(clubObs, 'ctd-obs-plugin-club');
    const start = t.hub.cursor();
    expect((await call('POST', '/api/v1/apps/ctd-obs-plugin-club/events', clubObs, { events: [ev('c1', 'obs.output', { output: 'main', state: 'live' })] })).statusCode).toBe(202);
    expectProblem(
      await call('POST', `/api/v1/apps/ctd-obs-plugin-club/events?profile=${DEFAULT_PROFILE_ID}`, clubObs, { events: [ev('c2', 'obs.output', { output: 'main', state: 'live' })] }),
      403,
      'profile_forbidden',
    );
    expect((await call('GET', `/api/v1/profiles/${club.id}/obs`, reader)).json().apps).toHaveLength(1);
    expect((await call('GET', `/api/v1/profiles/${DEFAULT_PROFILE_ID}/obs`, reader)).json().apps).toEqual([]);
    const mainOnly = t.token(['status:read'], 'main reader', DEFAULT_PROFILE_ID);
    expect((await call('GET', `/api/v1/events/poll?after=${start}&types=obs.*`, mainOnly)).json().items).toEqual([]);
  });
});

describe('GET /profiles/{id}/previews/{feed}', () => {
  it('serves a JPEG of an online feed, cached for a few seconds; ?access_token= works', async () => {
    const res = await call('GET', `/api/v1/profiles/${DEFAULT_PROFILE_ID}/previews/landscape`, reader);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-preview-at']).toMatch(/^\d{4}-/);
    expect(res.rawPayload.equals(JPEG)).toBe(true);
    await t.app.inject({ method: 'GET', url: `/api/v1/profiles/${DEFAULT_PROFILE_ID}/previews/landscape?access_token=${reader}` });
    expect(grabs).toEqual([`${DEFAULT_PROFILE_ID}:landscape`]); // second request served from the cache
    clock += 6_000;
    await call('GET', `/api/v1/profiles/${DEFAULT_PROFILE_ID}/previews/landscape`, reader);
    expect(grabs).toHaveLength(2);
  });

  it('offline feed → 404 feed_offline; failed grab → 503 (or the last frame); bad feed → 404', async () => {
    expectProblem(await call('GET', `/api/v1/profiles/${DEFAULT_PROFILE_ID}/previews/vertical`, reader), 404, 'feed_offline');
    online[`${club.id}:landscape`] = true;
    online[`${club.id}:landscape:fail`] = true;
    const failed = await call('GET', `/api/v1/profiles/${club.id}/previews/landscape`, reader);
    expectProblem(failed, 503, 'unavailable');
    expect(failed.headers['retry-after']).toBe('5');
    expectProblem(await call('GET', `/api/v1/profiles/${DEFAULT_PROFILE_ID}/previews/sideways`, reader), 404, 'not_found');
    expectProblem(await call('GET', `/api/v1/profiles/${DEFAULT_PROFILE_ID}/previews/landscape`, t.token(['chat:read'], 'chat only')), 403, 'missing_scope');
  });

  it('FFmpeg decodes one keyframe and writes a 640 px JPEG to stdout', () => {
    const args = previewArgs('rtmp://127.0.0.1:1935/live/landscape?user=u&pass=p');
    expect(args.slice(args.indexOf('-skip_frame'), args.indexOf('-skip_frame') + 2)).toEqual(['-skip_frame', 'nokey']);
    expect(args.indexOf('-skip_frame')).toBeLessThan(args.indexOf('-i')); // an input option
    expect(args).toEqual(expect.arrayContaining(['-frames:v', '1', 'scale=640:-2', 'pipe:1']));
  });
});
