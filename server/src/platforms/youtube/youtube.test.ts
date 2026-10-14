import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriverError, type PreparedLive } from '../types.js';
import {
  API_BASE,
  apiError,
  APP_MISSING,
  buildUrl,
  GOOGLE_DEVICE_CODE_URL,
  GOOGLE_TOKEN_URL,
  YOUTUBE_SCOPE,
  YouTubeClient,
} from './api.js';
import { BROADCAST_KEY, confirmLive, finishBroadcast, LEFTOVER_BROADCASTS_KEY, LIVE_STREAM_KEY } from './broadcast.js';
import { youtubeDriver } from './index.js';
import { readOptions, youtubeTitle } from './info.js';
import {
  FetchStub,
  googleError,
  json,
  makeAccount,
  makeCtx,
  makeDestination,
  oauthError,
  silentLog,
  validTokens,
} from './test-utils.js';

const CHANNELS = `${API_BASE}/channels`;
const STREAMS = `${API_BASE}/liveStreams`;
const BROADCASTS = `${API_BASE}/liveBroadcasts`;
const BIND = `${API_BASE}/liveBroadcasts/bind`;
const TRANSITION = `${API_BASE}/liveBroadcasts/transition`;
const VIDEOS = `${API_BASE}/videos`;

const STREAM = {
  id: 'stream-1',
  snippet: { channelId: 'UC123', title: 'CTD landscape' },
  cdn: {
    ingestionType: 'rtmp',
    ingestionInfo: {
      streamName: 'abcd-efgh-ijkl',
      ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2',
      rtmpsIngestionAddress: 'rtmps://a.rtmps.youtube.com/live2/',
    },
  },
  status: { streamStatus: 'ready' },
};

const BROADCAST = {
  id: 'bc-1',
  snippet: { title: 'My stream', liveChatId: 'chat-1', scheduledStartTime: '2026-10-11T10:00:00.000Z' },
  status: { lifeCycleStatus: 'ready', privacyStatus: 'public' },
};

let stub: FetchStub;

beforeEach(() => {
  stub = new FetchStub();
  vi.stubGlobal('fetch', stub.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function connectedCtx() {
  const c = makeCtx();
  await c.accountSecrets.setJson('oauth', validTokens());
  return c;
}

async function expectDriverError(p: Promise<unknown>, code: DriverError['code'], text?: RegExp): Promise<DriverError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DriverError);
  const de = err as DriverError;
  expect(de.code).toBe(code);
  if (text) expect(de.message).toMatch(text);
  return de;
}

function allBodiesText(): string {
  return JSON.stringify(stub.calls.map((c) => c.body ?? null));
}

// ---------------------------------------------------------------------------

describe('info', () => {
  it('describes the platform completely', () => {
    const info = youtubeDriver.info;
    expect(info).toMatchObject({
      id: 'youtube',
      feeds: ['landscape', 'vertical'],
      defaultFeed: 'landscape',
      connectMethod: 'device-code',
      titleSupport: 'api',
      chatSupport: 'api',
      keyPerSession: false,
      experimental: false,
    });
    expect(info.developerApp?.consoleUrl).toBe('https://console.cloud.google.com/apis/credentials');
    expect(info.developerApp?.fields.map((f) => [f.key, f.type, f.required])).toEqual([
      ['clientId', 'text', true],
      ['clientSecret', 'secret', true],
    ]);
    const steps = info.developerApp!.instructions.split('\n');
    expect(steps.every((s, i) => s.startsWith(`${i + 1}. `))).toBe(true);
    expect(info.developerApp!.instructions).toMatch(/TVs and Limited Input devices/);
    expect(info.developerApp!.instructions).toMatch(/In production/);
    expect(Object.fromEntries(info.destinationFields.map((f) => [f.key, f.default]))).toEqual({
      privacy: 'public',
      latency: 'low',
      madeForKids: false,
      enableChat: true,
    });
    expect(info.notes).toMatch(/quota/);
    expect(info.testMode).toEqual({ supported: true, description: 'Private broadcast — only you can see it' });
    // Default (no supportsTestMode): every YouTube destination can stream privately.
    expect(youtubeDriver.supportsTestMode).toBeUndefined();
  });

  it('reads options defensively and builds valid titles', () => {
    expect(readOptions({})).toEqual({ privacy: 'public', latency: 'low', madeForKids: false, enableChat: true });
    expect(readOptions({ privacy: 'public', latency: 'normal' }, true)).toEqual({ privacy: 'private', latency: 'normal', madeForKids: false, enableChat: true });
    expect(readOptions({ privacy: 'unlisted' }, false).privacy).toBe('unlisted');
    expect(readOptions({ privacy: 'bogus', latency: 'ultraLow', madeForKids: true, enableChat: false })).toEqual({
      privacy: 'public',
      latency: 'ultraLow',
      madeForKids: true,
      enableChat: false,
    });
    expect(youtubeTitle('a <b> c\nd', 'x')).toBe('a ‹b› c d');
    expect([...youtubeTitle('😀'.repeat(150), 'x')]).toHaveLength(100);
    expect(youtubeTitle('   ', 'Fallback name')).toBe('Fallback name');
    expect(youtubeTitle('', '')).toBe('Live stream');
  });
});

describe('API errors', () => {
  const body = (reason: string, where: 'errors' | 'details' = 'errors') =>
    JSON.stringify({ error: { code: 403, message: 'msg', status: 'PERMISSION_DENIED', [where]: [{ reason }] } });

  it('maps Google reasons to actionable driver errors', () => {
    expect(apiError(403, body('liveStreamingNotEnabled'), 'x')).toMatchObject({ code: 'not-eligible', status: 403 });
    expect(apiError(403, body('livePermissionBlocked'), 'x').code).toBe('not-eligible');
    expect(apiError(403, body('quotaExceeded'), 'x').message).toMatch(/quota/);
    expect(apiError(403, body('SERVICE_DISABLED', 'details'), 'x')).toMatchObject({ code: 'misconfigured' });
    expect(apiError(403, body('ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'details'), 'x').code).toBe('needs-login');
    expect(apiError(401, '{}', 'x').code).toBe('needs-login');
    const other = apiError(500, body('backendError'), 'creating the broadcast');
    expect(other).toMatchObject({ code: 'platform-error', message: 'YouTube API error while creating the broadcast: msg' });
    expect(other.has('backendError', 'nope')).toBe(true);
    expect(apiError(502, '<html>', 'x').message).toMatch(/HTTP 502/);
  });

  it('builds URLs with repeated parameters and without empty ones', () => {
    expect(buildUrl('https://h/v3', 'p', { a: 'x y', b: ['1', '2'], c: null, d: '', e: undefined })).toBe('https://h/v3/p?a=x+y&b=1&b=2');
    expect(buildUrl('https://h/v3', 'p')).toBe('https://h/v3/p');
  });
});

describe('connect (device flow)', () => {
  it('requires the developer app', async () => {
    const { ctx } = makeCtx({ app: null });
    await expectDriverError(youtubeDriver.startConnect!(makeAccount(), ctx), 'misconfigured', new RegExp(APP_MISSING));
    expect(stub.calls).toHaveLength(0);
  });

  it('starts the device flow with the youtube scope and stores the pending state', async () => {
    stub.on(
      'POST',
      GOOGLE_DEVICE_CODE_URL,
      json({
        device_code: 'dev-code',
        user_code: 'ABC-DEF',
        verification_url: 'https://www.google.com/device',
        expires_in: 1800,
        interval: 5,
      }),
    );
    const { ctx, accountSecrets } = makeCtx();
    const start = await youtubeDriver.startConnect!(makeAccount(), ctx);
    expect(start).toEqual({
      method: 'device-code',
      userCode: 'ABC-DEF',
      verificationUri: 'https://www.google.com/device',
      expiresIn: 1800,
      interval: 5,
    });
    expect(stub.calls[0]!.form).toEqual({ client_id: 'client-id.apps.googleusercontent.com', scope: YOUTUBE_SCOPE });
    expect(await accountSecrets.getJson('device')).toMatchObject({ deviceCode: 'dev-code', interval: 5 });
  });

  it('explains a rejected client', async () => {
    stub.on('POST', GOOGLE_DEVICE_CODE_URL, oauthError(401, 'invalid_client'));
    const { ctx } = makeCtx();
    await expectDriverError(youtubeDriver.startConnect!(makeAccount(), ctx), 'misconfigured', /TVs and Limited Input devices/);
  });

  async function pendingCtx(interval = 5) {
    const c = makeCtx();
    await c.accountSecrets.setJson('device', { deviceCode: 'dev-code', interval, expiresAt: Date.now() + 600_000, nextPollAt: 0 });
    return c;
  }

  it('reports pending and does not poll Google faster than the interval', async () => {
    stub.on('POST', GOOGLE_TOKEN_URL, oauthError(428, 'authorization_pending'));
    const { ctx } = await pendingCtx();
    expect(await youtubeDriver.pollConnect!(makeAccount(), ctx)).toEqual({ status: 'pending' });
    expect(stub.calls[0]!.form).toEqual({
      client_id: 'client-id.apps.googleusercontent.com',
      client_secret: 'client-secret',
      device_code: 'dev-code',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    expect(await youtubeDriver.pollConnect!(makeAccount(), ctx)).toEqual({ status: 'pending' });
    expect(stub.calls).toHaveLength(1);
  });

  it('slows down when Google asks to', async () => {
    stub.on('POST', GOOGLE_TOKEN_URL, oauthError(403, 'slow_down'));
    const { ctx, accountSecrets } = await pendingCtx(5);
    expect(await youtubeDriver.pollConnect!(makeAccount(), ctx)).toEqual({ status: 'pending' });
    const device = await accountSecrets.getJson<{ interval: number; nextPollAt: number }>('device');
    expect(device?.interval).toBe(10);
    expect(device!.nextPollAt).toBeGreaterThan(Date.now() + 8_000);
  });

  it('handles denial, expiry and missing state', async () => {
    stub.on('POST', GOOGLE_TOKEN_URL, oauthError(403, 'access_denied'));
    let c = await pendingCtx();
    expect(await youtubeDriver.pollConnect!(makeAccount(), c.ctx)).toMatchObject({ status: 'error', message: expect.stringMatching(/denied/) });
    expect(await c.accountSecrets.getJson('device')).toBeNull();

    stub.on('POST', GOOGLE_TOKEN_URL, oauthError(400, 'expired_token'));
    c = await pendingCtx();
    expect(await youtubeDriver.pollConnect!(makeAccount(), c.ctx)).toEqual({ status: 'expired' });

    stub.on('POST', GOOGLE_TOKEN_URL, oauthError(400, 'invalid_grant'));
    c = await pendingCtx();
    expect(await youtubeDriver.pollConnect!(makeAccount(), c.ctx)).toEqual({ status: 'expired' });
    expect(await c.accountSecrets.getJson('device')).toBeNull();

    expect(await youtubeDriver.pollConnect!(makeAccount(), makeCtx().ctx)).toEqual({ status: 'expired' });
  });

  it('keeps polling through temporary Google and network errors', async () => {
    let n = 0;
    stub.on('POST', GOOGLE_TOKEN_URL, () => {
      n++;
      if (n === 1) return oauthError(503, 'backend_error');
      if (n === 2) throw new TypeError('fetch failed');
      if (n === 3) return oauthError(403, 'rate_limit_exceeded');
      return json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3599, scope: YOUTUBE_SCOPE });
    });
    stub.on('GET', CHANNELS, json({ items: [{ id: 'UCabc', snippet: { title: 'My Channel' } }] }));
    const { ctx, accountSecrets } = await pendingCtx();
    const ready = async () => {
      const d = (await accountSecrets.getJson<{ nextPollAt: number }>('device'))!;
      await accountSecrets.setJson('device', { ...d, nextPollAt: 0 });
    };
    for (let i = 0; i < 3; i++) {
      expect(await youtubeDriver.pollConnect!(makeAccount(), ctx)).toEqual({ status: 'pending' });
      const device = await accountSecrets.getJson<{ deviceCode: string; nextPollAt: number }>('device');
      expect(device?.deviceCode).toBe('dev-code');
      expect(device!.nextPollAt).toBeGreaterThan(Date.now());
      await ready();
    }
    expect(await youtubeDriver.pollConnect!(makeAccount(), ctx)).toMatchObject({ status: 'connected' });
    expect(n).toBe(4);
  });

  it('still stops on a misconfigured client while polling', async () => {
    stub.on('POST', GOOGLE_TOKEN_URL, oauthError(401, 'invalid_client'));
    const { ctx } = await pendingCtx();
    await expectDriverError(youtubeDriver.pollConnect!(makeAccount(), ctx), 'misconfigured');
  });

  it('stores tokens and links the channel on success', async () => {
    stub
      .on('POST', GOOGLE_TOKEN_URL, json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3599, scope: YOUTUBE_SCOPE, token_type: 'Bearer' }))
      .on('GET', CHANNELS, json({ items: [{ id: 'UCabc', snippet: { title: 'My Channel' } }] }));
    const { ctx, accountSecrets, updateAccount } = await pendingCtx();
    const result = await youtubeDriver.pollConnect!(makeAccount({ options: {} }), ctx);
    expect(result).toMatchObject({ status: 'connected', account: { label: 'My Channel', status: 'connected', options: { channelId: 'UCabc' } } });
    expect(await accountSecrets.getJson('oauth')).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh' });
    expect(await accountSecrets.getJson('device')).toBeNull();
    const channels = stub.callsTo('GET', CHANNELS)[0]!;
    expect(channels.headers.authorization).toBe('Bearer new-access');
    expect(channels.url.searchParams.get('mine')).toBe('true');
    expect(updateAccount).toHaveBeenCalledWith({ label: 'My Channel', status: 'connected', statusMessage: null, options: { channelId: 'UCabc' } });
  });

  it('fails clearly when the account has no channel or YouTube was not granted', async () => {
    stub
      .on('POST', GOOGLE_TOKEN_URL, json({ access_token: 'a', refresh_token: 'r', expires_in: 3599, scope: YOUTUBE_SCOPE }))
      .on('GET', CHANNELS, json({ items: [] }));
    let c = await pendingCtx();
    expect(await youtubeDriver.pollConnect!(makeAccount(), c.ctx)).toEqual({ status: 'error', message: 'This Google account has no YouTube channel' });

    stub.on('POST', GOOGLE_TOKEN_URL, json({ access_token: 'a', refresh_token: 'r', expires_in: 3599, scope: 'openid' }));
    c = await pendingCtx();
    expect(await youtubeDriver.pollConnect!(makeAccount(), c.ctx)).toMatchObject({ status: 'error', message: expect.stringMatching(/YouTube/) });
    expect(await c.accountSecrets.getJson('oauth')).toBeNull();
  });
});

describe('checkAccount + token refresh', () => {
  it('refreshes an expiring token with the client secret', async () => {
    stub
      .on('POST', GOOGLE_TOKEN_URL, json({ access_token: 'fresh', expires_in: 3599, scope: YOUTUBE_SCOPE }))
      .on('GET', CHANNELS, json({ items: [{ id: 'UC123', snippet: { title: 'Chan' } }] }));
    const { ctx, accountSecrets } = makeCtx();
    await accountSecrets.setJson('oauth', validTokens({ expiresAt: Date.now() + 1000 }));
    expect(await youtubeDriver.checkAccount!(makeAccount(), ctx)).toEqual({ status: 'connected', label: 'Chan' });
    expect(stub.callsTo('POST', GOOGLE_TOKEN_URL)[0]!.form).toEqual({
      grant_type: 'refresh_token',
      client_id: 'client-id.apps.googleusercontent.com',
      client_secret: 'client-secret',
      refresh_token: 'refresh-1',
    });
    expect(await accountSecrets.getJson('oauth')).toMatchObject({ accessToken: 'fresh', refreshToken: 'refresh-1' });
    expect(stub.callsTo('GET', CHANNELS)[0]!.headers.authorization).toBe('Bearer fresh');
  });

  it('asks to reconnect when the refresh token is revoked', async () => {
    stub.on('POST', GOOGLE_TOKEN_URL, oauthError(400, 'invalid_grant'));
    const { ctx, accountSecrets } = makeCtx();
    await accountSecrets.setJson('oauth', validTokens({ expiresAt: Date.now() - 1000 }));
    await expectDriverError(youtubeDriver.checkAccount!(makeAccount(), ctx), 'needs-login', /In production/);
  });

  it('reports a missing connection', async () => {
    await expectDriverError(youtubeDriver.checkAccount!(makeAccount(), makeCtx().ctx), 'not-connected');
  });

  it('retries once with a refreshed token after a 401', async () => {
    stub
      .on('GET', CHANNELS, googleError(401, 'authError'), json({ items: [{ id: 'UC123', snippet: { title: 'Chan' } }] }))
      .on('POST', GOOGLE_TOKEN_URL, json({ access_token: 'after-401', expires_in: 3599 }));
    const { ctx } = await connectedCtx();
    expect(await youtubeDriver.checkAccount!(makeAccount(), ctx)).toEqual({ status: 'connected', label: 'Chan' });
    expect(stub.callsTo('GET', CHANNELS).map((c) => c.headers.authorization)).toEqual(['Bearer access-1', 'Bearer after-401']);
  });
});

describe('validateDestination', () => {
  it('lists missing app and account', async () => {
    const problems = await youtubeDriver.validateDestination!(makeDestination(), null, makeCtx({ app: null }).ctx);
    expect(problems).toEqual([APP_MISSING, 'Choose a connected YouTube account for this destination']);
    expect(await youtubeDriver.validateDestination!(makeDestination({ feed: 'vertical' }), makeAccount(), makeCtx().ctx)).toEqual([]);
  });
});

describe('prepare', () => {
  function happyRoutes() {
    stub
      .on('POST', STREAMS, json(STREAM))
      .on('POST', BROADCASTS, json(BROADCAST))
      .on('POST', BIND, json({ id: 'bc-1', contentDetails: { boundStreamId: 'stream-1' } }));
  }

  it('creates the stream and a broadcast, and returns the push plan', async () => {
    happyRoutes();
    const { ctx, destinationSecrets } = await connectedCtx();
    const dest = makeDestination({ feed: 'vertical', options: { privacy: 'unlisted', latency: 'ultraLow', madeForKids: false, enableChat: true } });
    const longTitle = `Speedrun <any%> ${'x'.repeat(200)}`;
    const prepared = await youtubeDriver.prepare(dest, makeAccount(), longTitle, ctx);

    expect(prepared.push).toEqual({ url: 'rtmps://a.rtmps.youtube.com/live2/abcd-efgh-ijkl', mode: 'copy', feeds: ['vertical'] });
    expect(prepared.watchUrl).toBe('https://www.youtube.com/watch?v=bc-1');
    expect(typeof prepared.chat).toBe('function');
    expect(await destinationSecrets.get(LIVE_STREAM_KEY)).toBe('stream-1');
    expect(await destinationSecrets.get(BROADCAST_KEY)).toBe('bc-1');

    const streamInsert = stub.callsTo('POST', STREAMS)[0]!;
    expect(streamInsert.url.searchParams.get('part')).toBe('snippet,cdn,contentDetails,status');
    expect(streamInsert.body).toEqual({
      snippet: { title: 'CTD vertical' },
      cdn: { frameRate: 'variable', resolution: 'variable', ingestionType: 'rtmp' },
      contentDetails: { isReusable: true },
    });

    const insert = stub.callsTo('POST', BROADCASTS)[0]!;
    expect(insert.url.searchParams.get('part')).toBe('snippet,status,contentDetails');
    const body = insert.body as { snippet: { title: string; scheduledStartTime: string }; status: unknown; contentDetails: unknown };
    expect([...body.snippet.title]).toHaveLength(100);
    expect(body.snippet.title.startsWith('Speedrun ‹any%›')).toBe(true);
    expect(Math.abs(Date.parse(body.snippet.scheduledStartTime) - Date.now())).toBeLessThan(10_000);
    expect(body.status).toEqual({ privacyStatus: 'unlisted', selfDeclaredMadeForKids: false });
    expect(body.contentDetails).toEqual({
      enableAutoStart: true,
      // Auto stop would complete the broadcast during the offline grace period / relay retries.
      enableAutoStop: false,
      latencyPreference: 'ultraLow',
      enableDvr: true,
      monitorStream: { enableMonitorStream: false },
    });
    expect(allBodiesText()).not.toMatch(/categoryId|gameId|topic/i);

    const bind = stub.callsTo('POST', BIND)[0]!;
    expect(Object.fromEntries(bind.url.searchParams)).toEqual({ id: 'bc-1', part: 'id,contentDetails', streamId: 'stream-1' });
    expect(stub.calls.every((c) => c.url.host === 'oauth2.googleapis.com' || c.headers.authorization === 'Bearer access-1')).toBe(true);
  });

  it('test mode forces a private broadcast whatever the destination privacy', async () => {
    happyRoutes();
    // The second prepare reuses the stream and ends the first broadcast (leftover).
    stub.on('GET', STREAMS, json({ items: [STREAM] })).on('POST', TRANSITION, json({ id: 'bc-1', status: { lifeCycleStatus: 'complete' } }));
    const { ctx } = await connectedCtx();
    const dest = makeDestination({ options: { privacy: 'public', latency: 'low', madeForKids: false, enableChat: true } });
    await youtubeDriver.prepare(dest, makeAccount(), 'Testing', { ...ctx, testMode: true });
    const body = stub.callsTo('POST', BROADCASTS)[0]!.body as { status: unknown };
    expect(body.status).toEqual({ privacyStatus: 'private', selfDeclaredMadeForKids: false });

    await youtubeDriver.prepare(dest, makeAccount(), 'Real', { ...ctx, testMode: false });
    expect((stub.callsTo('POST', BROADCASTS)[1]!.body as { status: unknown }).status).toEqual({ privacyStatus: 'public', selfDeclaredMadeForKids: false });
  });

  it('health reports the broadcast viewer count from videos.list', async () => {
    happyRoutes();
    stub.on('GET', VIDEOS, json({ items: [{ id: 'bc-1', liveStreamingDetails: { concurrentViewers: '42' } }] }));
    const { ctx } = await connectedCtx();
    const prepared = await youtubeDriver.prepare(makeDestination(), makeAccount(), 'Title', ctx);
    expect(prepared.recovery).toBeUndefined(); // viewers only: YouTube lives are not auto-recovered
    const ctl = new AbortController();
    const it = prepared.health!(ctl.signal)[Symbol.asyncIterator]();
    expect((await it.next()).value).toEqual({ type: 'viewers', count: 42 });
    ctl.abort();
    await it.return?.(undefined);
    const call = stub.callsTo('GET', VIDEOS)[0]!;
    expect(call.url.searchParams.get('id')).toBe('bc-1');
    expect(call.url.searchParams.get('part')).toBe('liveStreamingDetails');
  });

  it('reuses the stored stream and skips chat when disabled or made for kids', async () => {
    stub
      .on('GET', STREAMS, json({ items: [STREAM] }))
      .on('POST', BROADCASTS, json(BROADCAST))
      .on('POST', BIND, json({ id: 'bc-1' }))
      // The second prepare ends the first one's broadcast.
      .on('POST', TRANSITION, json({ id: 'bc-1', status: { lifeCycleStatus: 'complete' } }));
    const { ctx, destinationSecrets } = await connectedCtx();
    await destinationSecrets.set(LIVE_STREAM_KEY, 'stream-1');
    const prepared = await youtubeDriver.prepare(
      makeDestination({ options: { enableChat: false } }),
      makeAccount(),
      'Title',
      ctx,
    );
    expect(stub.callsTo('POST', STREAMS)).toHaveLength(0);
    expect(stub.callsTo('GET', STREAMS)[0]!.url.searchParams.get('id')).toBe('stream-1');
    expect(prepared.chat).toBeUndefined();

    const kids = await youtubeDriver.prepare(makeDestination({ options: { madeForKids: true } }), makeAccount(), 'Title', ctx);
    expect(kids.chat).toBeUndefined();
    const lastInsert = stub.callsTo('POST', BROADCASTS).at(-1)!.body as { status: unknown };
    expect(lastInsert.status).toEqual({ privacyStatus: 'public', selfDeclaredMadeForKids: true });
  });

  it('replaces a stored stream that is gone or belongs to another channel', async () => {
    stub
      .on('GET', STREAMS, json({ items: [] }), json({ items: [{ ...STREAM, snippet: { channelId: 'UCother' } }] }))
      .on('POST', STREAMS, json({ ...STREAM, id: 'stream-2' }))
      .on('POST', BROADCASTS, json(BROADCAST))
      .on('POST', BIND, json({ id: 'bc-1' }))
      .on('POST', TRANSITION, json({ id: 'bc-1', status: { lifeCycleStatus: 'complete' } }));
    const { ctx, destinationSecrets } = await connectedCtx();
    await destinationSecrets.set(LIVE_STREAM_KEY, 'stream-old');
    await youtubeDriver.prepare(makeDestination(), makeAccount(), 'Title', ctx);
    expect(await destinationSecrets.get(LIVE_STREAM_KEY)).toBe('stream-2');

    await destinationSecrets.set(LIVE_STREAM_KEY, 'stream-1');
    await youtubeDriver.prepare(makeDestination(), makeAccount(), 'Title', ctx);
    expect(stub.callsTo('POST', STREAMS)).toHaveLength(2);
  });

  it('ends a leftover broadcast before creating a new one', async () => {
    happyRoutes();
    stub.on('POST', TRANSITION, json({ id: 'old-bc', status: { lifeCycleStatus: 'complete' } }));
    const { ctx, destinationSecrets } = await connectedCtx();
    await destinationSecrets.set(BROADCAST_KEY, 'old-bc');
    await youtubeDriver.prepare(makeDestination(), makeAccount(), 'Title', ctx);
    const transition = stub.callsTo('POST', TRANSITION)[0]!;
    expect(Object.fromEntries(transition.url.searchParams)).toEqual({ broadcastStatus: 'complete', id: 'old-bc', part: 'status' });
    expect(await destinationSecrets.get(BROADCAST_KEY)).toBe('bc-1');
    expect(await destinationSecrets.getJson(LEFTOVER_BROADCASTS_KEY)).toBeNull();
  });

  describe('a leftover broadcast that cannot be ended', () => {
    /** The leftover 'old-bc' as liveBroadcasts.list returns it. */
    const leftover = (status: string, boundStreamId = 'stream-1') =>
      json({ items: [{ id: 'old-bc', status: { lifeCycleStatus: status }, contentDetails: { boundStreamId } }] });

    function routes() {
      stub
        .on('POST', TRANSITION, googleError(503, 'backendError'))
        .on('GET', STREAMS, json({ items: [STREAM] }))
        .on('POST', BROADCASTS, json(BROADCAST))
        .on('POST', BIND, json({ id: 'bc-1' }));
    }

    async function leftoverCtx() {
      const c = await connectedCtx();
      await c.destinationSecrets.set(LIVE_STREAM_KEY, 'stream-1');
      await c.destinationSecrets.set(BROADCAST_KEY, 'old-bc');
      return c;
    }

    it('blocks a test-mode live while it is still live on the same stream, keeps its id, and goes ahead once it ends', async () => {
      routes();
      stub.on('GET', BROADCASTS, leftover('live'));
      const { ctx, destinationSecrets } = await leftoverCtx();
      const test = { ...ctx, testMode: true };
      // Retryable (not fatal): the runner tries again; a lasting failure tells the user what to do.
      await expectDriverError(youtubeDriver.prepare(makeDestination(), makeAccount(), 'T', test), 'platform-error', /still live.*YouTube Studio/);
      expect(stub.callsTo('POST', BROADCASTS)).toHaveLength(0);
      expect(stub.callsTo('POST', BIND)).toHaveLength(0);
      expect(stub.callsTo('GET', BROADCASTS)[0]!.url.searchParams.get('part')).toBe('status,contentDetails');
      expect(await destinationSecrets.getJson(LEFTOVER_BROADCASTS_KEY)).toEqual(['old-bc']);

      stub.on('POST', TRANSITION, json({ id: 'old-bc', status: { lifeCycleStatus: 'complete' } }));
      await youtubeDriver.prepare(makeDestination(), makeAccount(), 'T', test);
      expect(stub.callsTo('POST', TRANSITION).at(-1)!.url.searchParams.get('id')).toBe('old-bc');
      expect(await destinationSecrets.getJson(LEFTOVER_BROADCASTS_KEY)).toBeNull();
      expect(await destinationSecrets.get(BROADCAST_KEY)).toBe('bc-1');
    });

    it('blocks normal lives too while it is starting or testing on the same stream', async () => {
      for (const status of ['liveStarting', 'testing', 'testStarting']) {
        routes();
        stub.on('GET', BROADCASTS, leftover(status));
        const { ctx } = await leftoverCtx();
        await expectDriverError(youtubeDriver.prepare(makeDestination(), makeAccount(), 'T', ctx), 'platform-error', new RegExp(`still ${status}`));
      }
      expect(stub.callsTo('POST', BROADCASTS)).toHaveLength(0);
    });

    it('fails closed when YouTube cannot say whether it is still live', async () => {
      routes();
      stub.on('GET', BROADCASTS, googleError(503, 'backendError'));
      const { ctx, destinationSecrets } = await leftoverCtx();
      await expectDriverError(youtubeDriver.prepare(makeDestination(), makeAccount(), 'T', { ...ctx, testMode: true }), 'platform-error', /make sure it is off air/);
      expect(stub.callsTo('POST', BROADCASTS)).toHaveLength(0);
      expect(await destinationSecrets.getJson(LEFTOVER_BROADCASTS_KEY)).toEqual(['old-bc']);
    });

    it('deletes an upcoming (auto-start) leftover on the same stream and goes ahead', async () => {
      routes();
      stub.on('GET', BROADCASTS, leftover('ready')).on('DELETE', BROADCASTS, new Response(null, { status: 204 }));
      const { ctx, destinationSecrets } = await leftoverCtx();
      await youtubeDriver.prepare(makeDestination(), makeAccount(), 'T', { ...ctx, testMode: true });
      expect(stub.callsTo('DELETE', BROADCASTS).map((c) => c.url.searchParams.get('id'))).toEqual(['old-bc']);
      expect(stub.callsTo('POST', BROADCASTS)).toHaveLength(1);
      expect(await destinationSecrets.getJson(LEFTOVER_BROADCASTS_KEY)).toBeNull();
      expect(await destinationSecrets.get(BROADCAST_KEY)).toBe('bc-1');

      // If it can't be deleted either, it could auto-start with the new live: retry later.
      stub.on('DELETE', BROADCASTS, googleError(503, 'backendError'));
      await destinationSecrets.set(BROADCAST_KEY, 'old-bc');
      await expectDriverError(youtubeDriver.prepare(makeDestination(), makeAccount(), 'T', ctx), 'platform-error');
      expect(stub.callsTo('POST', BROADCASTS)).toHaveLength(1);
      expect(await destinationSecrets.getJson(LEFTOVER_BROADCASTS_KEY)).toEqual(['old-bc']);
    });

    it('goes ahead when it is bound to another stream, and retries it on the next prepare', async () => {
      routes();
      stub.on('GET', BROADCASTS, leftover('live', 'stream-other'));
      const { ctx, destinationSecrets } = await leftoverCtx();
      await youtubeDriver.prepare(makeDestination(), makeAccount(), 'T', { ...ctx, testMode: true });
      // The new broadcast takes BROADCAST_KEY; the leftover's id is not lost.
      expect(await destinationSecrets.get(BROADCAST_KEY)).toBe('bc-1');
      expect(await destinationSecrets.getJson(LEFTOVER_BROADCASTS_KEY)).toEqual(['old-bc']);

      stub.on('POST', TRANSITION, json({ status: { lifeCycleStatus: 'complete' } }));
      stub.calls.length = 0;
      await youtubeDriver.prepare(makeDestination(), makeAccount(), 'T', ctx);
      expect(stub.callsTo('POST', TRANSITION).map((c) => c.url.searchParams.get('id'))).toEqual(['old-bc', 'bc-1']);
      expect(await destinationSecrets.getJson(LEFTOVER_BROADCASTS_KEY)).toBeNull();
    });

    it("goes ahead (keeping the id) when it isn't readable by this account, and forgets one that is gone", async () => {
      routes();
      stub.on('POST', TRANSITION, googleError(403, 'forbidden')).on('GET', BROADCASTS, googleError(403, 'forbidden'));
      const { ctx, destinationSecrets } = await leftoverCtx();
      await youtubeDriver.prepare(makeDestination(), makeAccount(), 'T', ctx);
      expect(await destinationSecrets.getJson(LEFTOVER_BROADCASTS_KEY)).toEqual(['old-bc']);

      stub.on('POST', TRANSITION, googleError(503, 'backendError')).on('GET', BROADCASTS, json({ items: [] }));
      await youtubeDriver.prepare(makeDestination(), makeAccount(), 'T', ctx);
      expect(await destinationSecrets.getJson(LEFTOVER_BROADCASTS_KEY)).toBeNull();
    });

    it('keeps the leftover id when binding the new broadcast fails', async () => {
      routes();
      stub
        .on('GET', BROADCASTS, leftover('live', 'stream-other'))
        .on('POST', BIND, googleError(500, 'backendError'))
        .on('DELETE', BROADCASTS, new Response(null, { status: 204 }));
      const { ctx, destinationSecrets } = await leftoverCtx();
      await expectDriverError(youtubeDriver.prepare(makeDestination(), makeAccount(), 'T', ctx), 'platform-error');
      expect(await destinationSecrets.getJson(LEFTOVER_BROADCASTS_KEY)).toEqual(['old-bc']);
    });
  });

  it('maps "live streaming not enabled" to not-eligible with the features link', async () => {
    stub.on('POST', STREAMS, googleError(403, 'liveStreamingNotEnabled'));
    const { ctx } = await connectedCtx();
    await expectDriverError(youtubeDriver.prepare(makeDestination(), makeAccount(), 'T', ctx), 'not-eligible', /youtube\.com\/features/);
  });

  it('maps quota exhaustion to an actionable platform error', async () => {
    stub.on('POST', STREAMS, googleError(403, 'quotaExceeded'));
    const { ctx } = await connectedCtx();
    await expectDriverError(youtubeDriver.prepare(makeDestination(), makeAccount(), 'T', ctx), 'platform-error', /quota/);
  });

  it('deletes the broadcast when binding fails', async () => {
    stub
      .on('POST', STREAMS, json(STREAM))
      .on('POST', BROADCASTS, json(BROADCAST))
      .on('POST', BIND, googleError(403, 'liveBroadcastBindingNotAllowed'))
      .on('DELETE', BROADCASTS, new Response(null, { status: 204 }));
    const { ctx } = await connectedCtx();
    await expectDriverError(youtubeDriver.prepare(makeDestination(), makeAccount(), 'T', ctx), 'platform-error', /liveBroadcastBindingNotAllowed/);
    expect(stub.callsTo('DELETE', BROADCASTS)[0]!.url.searchParams.get('id')).toBe('bc-1');
  });

  it('needs an account and the developer app', async () => {
    const { ctx } = await connectedCtx();
    await expectDriverError(youtubeDriver.prepare(makeDestination(), null, 'T', ctx), 'not-connected');
    await expectDriverError(youtubeDriver.prepare(makeDestination(), makeAccount(), 'T', { ...ctx, app: null }), 'misconfigured');
  });
});

describe('live controls', () => {
  async function prepared(): Promise<{ live: PreparedLive; destinationSecrets: ReturnType<typeof makeCtx>['destinationSecrets'] }> {
    stub
      .on('POST', STREAMS, json(STREAM))
      .on('POST', BROADCASTS, json(BROADCAST))
      .on('POST', BIND, json({ id: 'bc-1' }));
    const { ctx, destinationSecrets } = await connectedCtx();
    const live = await youtubeDriver.prepare(makeDestination(), makeAccount(), 'Old title', ctx);
    stub.calls.length = 0;
    return { live, destinationSecrets };
  }

  const SNIPPET = {
    title: 'Old title',
    description: 'My description',
    scheduledStartTime: '2026-10-11T10:00:00.000Z',
    categoryId: '20',
    liveChatId: 'chat-1',
    channelId: 'UC123',
  };

  it('setTitle sends the current snippet back with only the title changed', async () => {
    const { live } = await prepared();
    stub.on('GET', BROADCASTS, json({ items: [{ id: 'bc-1', snippet: SNIPPET }] })).on('PUT', BROADCASTS, json({ id: 'bc-1' }));
    await live.setTitle!('New <title>');
    const put = stub.callsTo('PUT', BROADCASTS)[0]!;
    expect(put.url.searchParams.get('part')).toBe('snippet');
    expect(put.body).toEqual({
      id: 'bc-1',
      snippet: {
        title: 'New ‹title›',
        scheduledStartTime: '2026-10-11T10:00:00.000Z',
        description: 'My description',
        // Echoed unchanged: omitting it from a part=snippet update would reset it.
        categoryId: '20',
      },
    });
  });

  it('setTitle skips an unchanged title and retries a rejected schedule', async () => {
    const { live } = await prepared();
    stub.on('GET', BROADCASTS, json({ items: [{ id: 'bc-1', snippet: { ...SNIPPET, title: 'Same' } }] }));
    await live.setTitle!('Same');
    expect(stub.callsTo('PUT', BROADCASTS)).toHaveLength(0);

    stub
      .on('GET', BROADCASTS, json({ items: [{ id: 'bc-1', snippet: { title: 'Old', scheduledStartTime: '2026-10-11T10:00:00.000Z' } }] }))
      .on('PUT', BROADCASTS, googleError(400, 'invalidScheduledStartTime'), json({ id: 'bc-1' }));
    await live.setTitle!('New');
    const puts = stub.callsTo('PUT', BROADCASTS);
    expect(puts).toHaveLength(2);
    const retried = puts[1]!.body as { snippet: { scheduledStartTime: string } };
    expect(Date.parse(retried.snippet.scheduledStartTime)).toBeGreaterThan(Date.now());
    expect(JSON.stringify(puts.map((p) => p.body))).not.toMatch(/categoryId/);
  });

  it('end completes the broadcast and forgets it', async () => {
    const { live, destinationSecrets } = await prepared();
    stub.on('POST', TRANSITION, json({ id: 'bc-1', status: { lifeCycleStatus: 'complete' } }));
    await live.end!();
    expect(Object.fromEntries(stub.callsTo('POST', TRANSITION)[0]!.url.searchParams)).toEqual({
      broadcastStatus: 'complete',
      id: 'bc-1',
      part: 'status',
    });
    expect(await destinationSecrets.get(BROADCAST_KEY)).toBeNull();
  });

  it('end ignores an already completed or missing broadcast', async () => {
    const { live } = await prepared();
    stub.on('POST', TRANSITION, googleError(403, 'redundantTransition'));
    await expect(live.end!()).resolves.toBeUndefined();
    stub.on('POST', TRANSITION, googleError(404, 'liveBroadcastNotFound'));
    await expect(live.end!()).resolves.toBeUndefined();
  });

  it('setTitle passes the orchestrator signal to the API calls', async () => {
    const { live } = await prepared();
    stub.on('GET', BROADCASTS, json({ items: [{ id: 'bc-1', snippet: SNIPPET }] })).on('PUT', BROADCASTS, json({ id: 'bc-1' }));
    const ctl = new AbortController();
    ctl.abort(new Error('title budget exceeded'));
    await expect(live.setTitle!('New', ctl.signal)).rejects.toThrow();
    expect(stub.callsTo('PUT', BROADCASTS)).toHaveLength(0);
  });

  it('end keeps the broadcast id for the next prepare when it cannot be ended yet', async () => {
    const { live, destinationSecrets } = await prepared();
    stub
      .on('POST', TRANSITION, googleError(403, 'invalidTransition'))
      .on('GET', BROADCASTS, json({ items: [{ id: 'bc-1', status: { lifeCycleStatus: 'testing' } }] }));
    await expect(live.end!()).rejects.toThrow(/testing/);
    expect(await destinationSecrets.get(BROADCAST_KEY)).toBe('bc-1');
  });

  it('end deletes a broadcast that never went live', async () => {
    const { live, destinationSecrets } = await prepared();
    stub
      .on('POST', TRANSITION, googleError(403, 'invalidTransition'))
      .on('GET', BROADCASTS, json({ items: [{ id: 'bc-1', status: { lifeCycleStatus: 'ready' } }] }))
      .on('DELETE', BROADCASTS, new Response(null, { status: 204 }));
    await live.end!();
    expect(stub.callsTo('DELETE', BROADCASTS)[0]!.url.searchParams.get('id')).toBe('bc-1');
    expect(await destinationSecrets.get(BROADCAST_KEY)).toBeNull();
  });
});

describe('finishBroadcast', () => {
  const client = new YouTubeClient({ token: async () => 'tok', refresh: async () => 'tok2' });

  it('waits for a starting broadcast to go live and then completes it (there is no auto stop)', async () => {
    stub
      .on('POST', TRANSITION, googleError(403, 'invalidTransition'), json({ id: 'bc-1', status: { lifeCycleStatus: 'complete' } }))
      .on('GET', BROADCASTS, json({ items: [{ id: 'bc-1', status: { lifeCycleStatus: 'liveStarting' } }] }));
    await finishBroadcast(client, 'bc-1', undefined, { pollMs: 5, waitMs: 1_000 });
    expect(stub.callsTo('POST', TRANSITION)).toHaveLength(2);
    expect(stub.callsTo('DELETE', BROADCASTS)).toHaveLength(0);
  });

  it('gives up after the wait and honors abort', async () => {
    stub
      .on('POST', TRANSITION, googleError(403, 'invalidTransition'))
      .on('GET', BROADCASTS, json({ items: [{ id: 'bc-1', status: { lifeCycleStatus: 'liveStarting' } }] }));
    await expect(finishBroadcast(client, 'bc-1', undefined, { pollMs: 5, waitMs: 20 })).rejects.toThrow(/liveStarting/);

    const ctl = new AbortController();
    const p = finishBroadcast(client, 'bc-1', ctl.signal, { pollMs: 10_000, waitMs: 60_000 });
    setTimeout(() => ctl.abort(), 20);
    await expect(p).rejects.toThrow();
  });
});

describe('confirmLive', () => {
  const client = new YouTubeClient({ token: async () => 'tok', refresh: async () => 'tok2' });
  const fast = { pollMs: 5, autoStartGraceMs: 20, maxMs: 2_000 };

  function statuses(...list: string[]) {
    stub.on('GET', BROADCASTS, ...list.map((s) => json({ items: [{ id: 'bc-1', status: { lifeCycleStatus: s } }] })));
  }

  it('resolves once YouTube reports the broadcast live', async () => {
    statuses('ready', 'liveStarting', 'live');
    await confirmLive(client, 'bc-1', silentLog, new AbortController().signal, fast);
    expect(stub.callsTo('GET', BROADCASTS)).toHaveLength(3);
  });

  it('asks for the transition when auto start does not happen', async () => {
    stub.on('POST', TRANSITION, googleError(403, 'errorStreamInactive'));
    stub.on('GET', BROADCASTS, (() => {
      let n = 0;
      return () => json({ items: [{ id: 'bc-1', status: { lifeCycleStatus: ++n > 8 ? 'live' : 'ready' } }] });
    })());
    await confirmLive(client, 'bc-1', silentLog, new AbortController().signal, fast);
    expect(stub.callsTo('POST', TRANSITION)).toHaveLength(1);
    expect(stub.callsTo('POST', TRANSITION)[0]!.url.searchParams.get('broadcastStatus')).toBe('live');
  });

  it('fails when the broadcast is ended, gives up quietly at the deadline, and honors abort', async () => {
    statuses('complete');
    await expect(confirmLive(client, 'bc-1', silentLog, new AbortController().signal, fast)).rejects.toThrow(/ended the broadcast/);

    statuses('ready');
    stub.on('POST', TRANSITION, googleError(403, 'errorStreamInactive'));
    await expect(confirmLive(client, 'bc-1', silentLog, new AbortController().signal, { ...fast, maxMs: 40 })).resolves.toBeUndefined();

    const ctl = new AbortController();
    const p = confirmLive(client, 'bc-1', silentLog, ctl.signal, { ...fast, pollMs: 10_000 });
    setTimeout(() => ctl.abort(), 20);
    await expect(p).rejects.toThrow();
  });
});
