import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthTokens } from '../common/oauth.js';
import { DriverError, type PreparedLive } from '../types.js';
import { clearChatroomCache } from './chat-source.js';
import { KICK_TITLE_MAX, kickDriver } from './index.js';
import {
  fetchStub,
  json,
  makeAccount,
  makeCtx,
  makeDestination,
  MemorySecrets,
  type FakeCtx,
  type RecordedRequest,
} from './test-utils.js';

const TOKEN_URL = 'https://id.kick.com/oauth/token';
const API = 'https://api.kick.com/public/v1';
const KICK_WEB = 'https://kick.com/api/v2/channels/';
const IVS = 'fa723fc1b171.global-contribute.live-video.net';
const ALL_SCOPES = 'user:read channel:read channel:write streamkey:read';

const USER = { user_id: 77, name: 'StreamerName', email: 'private@example.com', profile_picture: 'https://x/y.png' };
function channel(patch: Record<string, unknown> = {}) {
  return {
    broadcaster_user_id: 77,
    slug: 'streamername',
    stream_title: 'Old title',
    category: { id: 15, name: 'Just Chatting' },
    stream: { url: `rtmps://${IVS}`, key: 'sk_us-west-2_apikey', is_live: false },
    ...patch,
  };
}

function tokens(patch: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: 'at-valid',
    refreshToken: 'rt-valid',
    expiresAt: Date.now() + 3600_000,
    scope: ALL_SCOPES,
    tokenType: 'Bearer',
    ...patch,
  };
}

function form(req: RecordedRequest | undefined): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(req?.body ?? ''));
}

const patches = (calls: RecordedRequest[]) => calls.filter((c) => c.method === 'PATCH');

/** A fresh run of the live's health watcher. */
const watch = (live: PreparedLive, signal: AbortSignal) => live.health!(signal)[Symbol.asyncIterator]();

let ctx: FakeCtx;

beforeEach(async () => {
  ctx = makeCtx();
  clearChatroomCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('info', () => {
  it('describes the platform accurately', () => {
    const { info } = kickDriver;
    expect(info.id).toBe('kick');
    expect(info.feeds).toEqual(['landscape', 'vertical']);
    expect(info.defaultFeed).toBe('landscape');
    expect(info.connectMethod).toBe('oauth-paste');
    expect(info.titleSupport).toBe('api');
    expect(info.chatSupport).toBe('unofficial');
    expect(info.keyPerSession).toBe(false);
    expect(info.developerApp?.consoleUrl).toBe('https://kick.com/settings/developer');
    expect(info.developerApp?.fields.map((f) => [f.key, f.type, f.required])).toEqual([
      ['clientId', 'text', true],
      ['clientSecret', 'secret', true],
    ]);
    expect(info.developerApp?.instructions).toMatch(/Redirect URL: copy it from this page/);
    expect(info.developerApp?.instructions.split('\n').every((l) => /^\d+\. /.test(l))).toBe(true);
    const ingest = info.destinationFields.find((f) => f.target === 'ingestUrl');
    const key = info.destinationFields.find((f) => f.target === 'streamKey');
    expect(ingest?.default).toBe(`rtmps://${IVS}/app`);
    expect(key).toMatchObject({ type: 'secret', required: false });
    expect(info.testMode).toEqual({ supported: false, description: 'Kick has no test mode — skipped while testing' });
  });
});

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

describe('startConnect', () => {
  it('needs the developer app', async () => {
    const err = await kickDriver.startConnect!(makeAccount(), makeCtx({ app: null })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect(err).toMatchObject({ code: 'misconfigured', message: 'Set up the Kick developer app in Settings → Developer apps' });
  });

  it('builds the authorize URL (PKCE S256 + state) and stores the pending state', async () => {
    const start = await kickDriver.startConnect!(makeAccount(), ctx);
    expect(start.method).toBe('oauth-paste');
    if (start.method !== 'oauth-paste') return;
    expect(start.redirectUri).toBe('https://203.0.113.7/oauth/callback/kick');
    const url = new URL(start.authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://id.kick.com/oauth/authorize');
    const p = url.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe('client-123');
    expect(p.get('redirect_uri')).toBe('https://203.0.113.7/oauth/callback/kick');
    expect(p.get('scope')).toBe(ALL_SCOPES);
    expect(p.get('code_challenge_method')).toBe('S256');

    const pending = await ctx.accountSecrets.getJson<{ verifier: string; state: string }>('pkce');
    expect(pending?.state).toBe(p.get('state'));
    expect(pending?.state.startsWith('acc1.')).toBe(true);
    const challenge = crypto.createHash('sha256').update(pending!.verifier).digest('base64url');
    expect(p.get('code_challenge')).toBe(challenge);
    expect(p.has('redirect')).toBe(false);
    expect(start.authorizeUrl).not.toContain('secret-456');
  });

  it('adds the documented 127.0.0.1 workaround parameter before redirect_uri', async () => {
    const start = await kickDriver.startConnect!(makeAccount(), makeCtx({ publicBaseUrl: 'http://127.0.0.1:8443/' }));
    const url = new URL((start as { authorizeUrl: string }).authorizeUrl);
    expect([...url.searchParams.keys()].slice(0, 4)).toEqual(['redirect', 'response_type', 'client_id', 'redirect_uri']);
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8443/oauth/callback/kick');
  });
});

describe('completeConnect', () => {
  async function begin(): Promise<string> {
    const start = await kickDriver.startConnect!(makeAccount(), ctx);
    return new URL((start as { authorizeUrl: string }).authorizeUrl).searchParams.get('state')!;
  }

  function connectRoutes(tokenResponse: () => Response = () =>
    json({ access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, scope: ALL_SCOPES, token_type: 'Bearer' })) {
    return fetchStub({
      [`POST ${TOKEN_URL}`]: tokenResponse,
      [`GET ${API}/users`]: () => json({ data: [USER], message: 'OK' }),
      [`GET ${API}/channels`]: () => json({ data: [channel()], message: 'OK' }),
      [`GET ${KICK_WEB}`]: () => json({ id: 4242, slug: 'streamername', chatroom: { id: 668 } }),
    });
  }

  it('exchanges the code with PKCE, stores tokens and fills the account', async () => {
    const state = await begin();
    const { verifier } = (await ctx.accountSecrets.getJson<{ verifier: string }>('pkce'))!;
    const stub = connectRoutes();
    vi.stubGlobal('fetch', stub.fetch);

    const result = await kickDriver.completeConnect!(
      makeAccount({ status: 'pending' }),
      { pastedUrl: `https://203.0.113.7/oauth/callback/kick?code=the-code&state=${encodeURIComponent(state)}` },
      ctx,
    );

    expect(result.status).toBe('connected');
    if (result.status !== 'connected') return;
    expect(result.account).toMatchObject({
      label: 'StreamerName',
      status: 'connected',
      statusMessage: null,
      options: { userId: 77, slug: 'streamername', chatroomId: 668, channelId: 4242 },
    });

    const tokenReq = stub.calls.find((c) => c.url === TOKEN_URL);
    expect(tokenReq?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(form(tokenReq)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'client-123',
      client_secret: 'secret-456',
      code: 'the-code',
      redirect_uri: 'https://203.0.113.7/oauth/callback/kick',
      code_verifier: verifier,
    });
    for (const c of stub.calls.filter((x) => x.url.startsWith(API))) expect(c.headers.authorization).toBe('Bearer at1');
    // the unofficial lookup never carries the token
    expect(stub.calls.find((c) => c.url.startsWith(KICK_WEB))?.headers.authorization).toBeUndefined();

    expect(await ctx.accountSecrets.get('pkce')).toBeNull();
    expect(await ctx.accountSecrets.getJson<OAuthTokens>('oauth')).toMatchObject({ accessToken: 'at1', refreshToken: 'rt1' });
    expect(ctx.updates).toEqual([
      { label: 'StreamerName', status: 'connected', statusMessage: null, options: { userId: 77, slug: 'streamername' } },
      { options: { userId: 77, slug: 'streamername', chatroomId: 668, channelId: 4242 } },
    ]);
    expect(JSON.stringify(ctx.updates)).not.toContain('private@example.com');
  });

  it('reports an API failure after the token exchange as a connection error', async () => {
    const state = await begin();
    vi.stubGlobal(
      'fetch',
      fetchStub({
        [`POST ${TOKEN_URL}`]: () => json({ access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, scope: ALL_SCOPES }),
        [`GET ${API}/`]: () => json({ message: 'Internal server error' }, 500),
      }).fetch,
    );
    const result = await kickDriver.completeConnect!(makeAccount(), { pastedUrl: `?code=c&state=${state}` }, ctx);
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.message).toMatch(/Kick API error while reading your Kick profile/);
  });

  it('reports a Kick outage during the token exchange without blaming the code', async () => {
    const state = await begin();
    vi.stubGlobal('fetch', fetchStub({ [`POST ${TOKEN_URL}`]: () => json({ message: 'Bad gateway' }, 502) }).fetch);
    const result = await kickDriver.completeConnect!(makeAccount(), { pastedUrl: `?code=c&state=${state}` }, ctx);
    expect(result).toMatchObject({ status: 'error', message: expect.stringMatching(/Kick API error while exchanging/) });
  });

  it('accepts a bare query string and still connects when the chatroom prefetch is blocked', async () => {
    const state = await begin();
    vi.stubGlobal(
      'fetch',
      fetchStub({
        [`POST ${TOKEN_URL}`]: () => json({ access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, scope: ALL_SCOPES }),
        [`GET ${API}/users`]: () => json({ data: [USER] }),
        [`GET ${API}/channels`]: () => json({ data: [channel()] }),
        [`GET ${KICK_WEB}`]: () => new Response('<html>Just a moment</html>', { status: 403 }),
      }).fetch,
    );
    const result = await kickDriver.completeConnect!(makeAccount(), { pastedUrl: `?code=c&state=${state}` }, ctx);
    expect(result).toMatchObject({ status: 'connected', account: { options: { userId: 77, slug: 'streamername' } } });
    if (result.status === 'connected') expect(result.account.options.chatroomId).toBeUndefined();
  });

  it('rejects a state that does not match (CSRF) without calling Kick', async () => {
    await begin();
    const stub = connectRoutes();
    vi.stubGlobal('fetch', stub.fetch);
    const result = await kickDriver.completeConnect!(
      makeAccount(),
      { pastedUrl: 'https://203.0.113.7/oauth/callback/kick?code=x&state=acc1.forged' },
      ctx,
    );
    expect(result.status).toBe('error');
    expect(stub.calls).toHaveLength(0);
    expect(await ctx.accountSecrets.get('pkce')).not.toBeNull();
  });

  it('reports expired without a pending connection or after the TTL', async () => {
    expect(await kickDriver.completeConnect!(makeAccount(), { pastedUrl: '?code=x&state=acc1.y' }, ctx)).toEqual({ status: 'expired' });
    const state = await begin();
    const pending = (await ctx.accountSecrets.getJson<Record<string, unknown>>('pkce'))!;
    await ctx.accountSecrets.setJson('pkce', { ...pending, createdAt: Date.now() - 31 * 60_000 });
    expect(await kickDriver.completeConnect!(makeAccount(), { pastedUrl: `?code=x&state=${state}` }, ctx)).toEqual({ status: 'expired' });
    expect(await ctx.accountSecrets.get('pkce')).toBeNull();
  });

  it('surfaces a denied authorization', async () => {
    const state = await begin();
    const result = await kickDriver.completeConnect!(
      makeAccount(),
      { pastedUrl: `https://203.0.113.7/oauth/callback/kick?error=access_denied&error_description=User+denied&state=${state}` },
      ctx,
    );
    expect(result).toEqual({ status: 'error', message: 'Kick did not authorize the app: User denied' });
    expect(await ctx.accountSecrets.get('pkce')).toBeNull();
  });

  it('asks for the full URL when nothing or no code was pasted', async () => {
    const state = await begin();
    expect((await kickDriver.completeConnect!(makeAccount(), {}, ctx)).status).toBe('error');
    expect((await kickDriver.completeConnect!(makeAccount(), { pastedUrl: `?state=${state}` }, ctx)).status).toBe('error');
  });

  it('maps a rejected code to an actionable error and consumes the pending state', async () => {
    const state = await begin();
    vi.stubGlobal('fetch', connectRoutes(() => json({ error: 'Invalid request' }, 400)).fetch);
    const result = await kickDriver.completeConnect!(makeAccount(), { pastedUrl: `?code=used&state=${state}` }, ctx);
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.message).toMatch(/Start the connection again/);
    expect(await ctx.accountSecrets.get('pkce')).toBeNull();
    expect(await ctx.accountSecrets.get('oauth')).toBeNull();
  });

  it('warns about permissions that were not granted', async () => {
    const state = await begin();
    vi.stubGlobal(
      'fetch',
      connectRoutes(() => json({ access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, scope: 'user:read channel:read channel:write' })).fetch,
    );
    const result = await kickDriver.completeConnect!(makeAccount(), { pastedUrl: `?code=c&state=${state}` }, ctx);
    expect(result.status).toBe('connected');
    if (result.status === 'connected') expect(result.account.statusMessage).toMatch(/Missing Kick permissions: streamkey:read/);
  });
});

describe('checkAccount', () => {
  it('refreshes an expiring token, then validates against the users endpoint', async () => {
    await ctx.accountSecrets.setJson('oauth', tokens({ accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: Date.now() + 1000 }));
    const stub = fetchStub({
      [`POST ${TOKEN_URL}`]: () => json({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600, scope: ALL_SCOPES }),
      [`GET ${API}/users`]: () => json({ data: [USER] }),
      [`GET ${API}/channels`]: () => json({ data: [channel({ slug: 'renamed' })] }),
    });
    vi.stubGlobal('fetch', stub.fetch);
    const account = makeAccount({ options: { userId: 77, slug: 'streamername', chatroomId: 668 } });
    const result = await kickDriver.checkAccount!(account, ctx);
    expect(result).toEqual({ status: 'connected', label: 'StreamerName' });
    expect(form(stub.calls[0])).toEqual({
      grant_type: 'refresh_token',
      client_id: 'client-123',
      client_secret: 'secret-456',
      refresh_token: 'rt-old',
    });
    expect(stub.calls.filter((c) => c.url.startsWith(API)).every((c) => c.headers.authorization === 'Bearer at-new')).toBe(true);
    expect(await ctx.accountSecrets.getJson<OAuthTokens>('oauth')).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new' });
    // a renamed channel drops the cached chatroom id
    expect(ctx.updates).toEqual([
      { label: 'StreamerName', status: 'connected', statusMessage: null, options: { userId: 77, slug: 'renamed' } },
    ]);
  });

  it('throws needs-login when Kick rejects the token and the refresh', async () => {
    await ctx.accountSecrets.setJson('oauth', tokens());
    vi.stubGlobal(
      'fetch',
      fetchStub({
        [`GET ${API}/`]: () => json({ message: 'Unauthorized' }, 401),
        [`POST ${TOKEN_URL}`]: () => json({ error: 'Invalid request' }, 400),
      }).fetch,
    );
    const err = await kickDriver.checkAccount!(makeAccount(), ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect(err).toMatchObject({ code: 'needs-login' });
  });

  it('reports a missing connection', async () => {
    const err = await kickDriver.checkAccount!(makeAccount(), ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'not-connected' });
  });
});

// ---------------------------------------------------------------------------
// Destination
// ---------------------------------------------------------------------------

describe('validateDestination', () => {
  it('needs an account or a pasted key, and a usable server URL', async () => {
    const v = (d: Parameters<NonNullable<typeof kickDriver.validateDestination>>[0], a = makeAccount() as ReturnType<typeof makeAccount> | null) =>
      kickDriver.validateDestination!(d, a, ctx);
    expect(await v(makeDestination())).toEqual([]);
    expect(await v(makeDestination({ accountId: null }), null)).toHaveLength(1);
    expect(await v(makeDestination({ accountId: null, hasStreamKey: true }), null)).toEqual([]);
    expect(await v(makeDestination({ ingestUrl: 'rtmps://host/app?x=1' }))).toHaveLength(1);
  });
});

describe('prepare', () => {
  beforeEach(async () => {
    await ctx.accountSecrets.setJson('oauth', tokens());
  });

  function routes(extra: Record<string, (req: RecordedRequest) => Response> = {}) {
    return fetchStub({
      [`GET ${API}/channels`]: () => json({ data: [channel()] }),
      [`PATCH ${API}/channels`]: () => new Response(null, { status: 204 }),
      ...extra,
    });
  }

  it('sets the title (stream_title only), reads the key from the API and builds the IVS URL', async () => {
    const stub = routes();
    vi.stubGlobal('fetch', stub.fetch);
    const account = makeAccount({ options: { userId: 77, slug: 'streamername' } });
    const prepared = await kickDriver.prepare(makeDestination(), account, 'New title', ctx);

    expect(prepared.push).toEqual({ url: `rtmps://${IVS}/app/sk_us-west-2_apikey`, mode: 'copy', feeds: ['landscape'] });
    expect(prepared.watchUrl).toBe('https://kick.com/streamername');
    expect(typeof prepared.setTitle).toBe('function');
    expect(typeof prepared.chat).toBe('function');
    expect(prepared.end).toBeUndefined();

    const [patch] = patches(stub.calls);
    expect(JSON.parse(patch!.body!)).toEqual({ stream_title: 'New title' });
    expect(patch!.headers['content-type']).toBe('application/json');
    expect(patch!.headers.authorization).toBe('Bearer at-valid');
  });

  it('truncates long titles and never sends category fields', async () => {
    const stub = routes();
    vi.stubGlobal('fetch', stub.fetch);
    const long = `${'🎮'.repeat(10)}${'x'.repeat(200)}`;
    const prepared = await kickDriver.prepare(makeDestination(), makeAccount(), long, ctx);
    await prepared.setTitle!('Live title');
    const bodies = patches(stub.calls).map((c) => JSON.parse(c.body!) as Record<string, unknown>);
    expect(bodies).toHaveLength(2);
    for (const b of bodies) expect(Object.keys(b)).toEqual(['stream_title']);
    expect([...(bodies[0]!.stream_title as string)]).toHaveLength(KICK_TITLE_MAX);
    expect((bodies[0]!.stream_title as string).startsWith('🎮'.repeat(10))).toBe(true);
    expect(bodies[1]).toEqual({ stream_title: 'Live title' });
  });

  it('skips the title update when unchanged or empty', async () => {
    const stub = routes();
    vi.stubGlobal('fetch', stub.fetch);
    await kickDriver.prepare(makeDestination(), makeAccount(), 'Old title', ctx);
    await kickDriver.prepare(makeDestination(), makeAccount(), '   ', ctx);
    expect(patches(stub.calls)).toHaveLength(0);
  });

  it('streams anyway when the title update fails', async () => {
    vi.stubGlobal('fetch', routes({ [`PATCH ${API}/channels`]: () => json({ message: 'boom' }, 500) }).fetch);
    const prepared = await kickDriver.prepare(makeDestination(), makeAccount(), 'New title', ctx);
    expect(prepared.push?.url).toContain('sk_us-west-2_apikey');
  });

  it('falls back to the pasted key when the API returns none', async () => {
    await ctx.destinationSecrets.set('streamKey', 'sk_manual');
    vi.stubGlobal('fetch', routes({ [`GET ${API}/channels`]: () => json({ data: [channel({ stream: { url: null, key: '' } })] }) }).fetch);
    const prepared = await kickDriver.prepare(makeDestination({ hasStreamKey: true }), makeAccount(), 'T', ctx);
    expect(prepared.push?.url).toBe(`rtmps://${IVS}/app/sk_manual`);
  });

  it('is misconfigured when no key is available at all', async () => {
    vi.stubGlobal('fetch', routes({ [`GET ${API}/channels`]: () => json({ data: [channel({ stream: null })] }) }).fetch);
    const err = await kickDriver.prepare(makeDestination(), makeAccount(), 'T', ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect(err).toMatchObject({ code: 'misconfigured' });
    expect((err as Error).message).toMatch(/stream key permission/);
  });

  it('uses an explicit non-default server from the destination', async () => {
    vi.stubGlobal('fetch', routes().fetch);
    const prepared = await kickDriver.prepare(makeDestination({ ingestUrl: 'rtmps://regional.example.net:443/app' }), makeAccount(), 'T', ctx);
    expect(prepared.push?.url).toBe('rtmps://regional.example.net:443/app/sk_us-west-2_apikey');
  });

  it('streams with the pasted key when the login expired, and flags the account', async () => {
    await ctx.destinationSecrets.set('streamKey', 'sk_manual');
    vi.stubGlobal(
      'fetch',
      fetchStub({
        [`GET ${API}/`]: () => json({ message: 'Unauthorized' }, 401),
        [`POST ${TOKEN_URL}`]: () => json({ error: 'Invalid request' }, 400),
      }).fetch,
    );
    const prepared = await kickDriver.prepare(
      makeDestination({ hasStreamKey: true }),
      makeAccount({ options: { slug: 'streamername' } }),
      'T',
      ctx,
    );
    expect(prepared.push?.url).toBe(`rtmps://${IVS}/app/sk_manual`);
    expect(prepared.watchUrl).toBe('https://kick.com/streamername');
    expect(ctx.updates).toContainEqual({ status: 'needs-login', statusMessage: 'Kick login expired — reconnect the account in Accounts' });
  });

  it('fails with needs-login when the login expired and there is no pasted key', async () => {
    vi.stubGlobal(
      'fetch',
      fetchStub({
        [`GET ${API}/`]: () => json({ message: 'Unauthorized' }, 401),
        [`POST ${TOKEN_URL}`]: () => json({ error: 'Invalid request' }, 400),
      }).fetch,
    );
    const err = await kickDriver.prepare(makeDestination(), makeAccount(), 'T', ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'needs-login' });
  });

  it('retries once with a refreshed token after a 401', async () => {
    let n = 0;
    const stub = fetchStub({
      [`GET ${API}/channels`]: (req) =>
        req.headers.authorization === 'Bearer at-valid' ? json({ message: 'Unauthorized' }, 401) : json({ data: [channel()] }),
      [`PATCH ${API}/channels`]: () => new Response(null, { status: 204 }),
      [`POST ${TOKEN_URL}`]: () => {
        n++;
        return json({ access_token: 'at-fresh', refresh_token: 'rt-fresh', expires_in: 3600 });
      },
    });
    vi.stubGlobal('fetch', stub.fetch);
    const prepared = await kickDriver.prepare(makeDestination(), makeAccount(), 'New title', ctx);
    expect(prepared.push?.url).toContain('sk_us-west-2_apikey');
    expect(n).toBe(1);
    expect(patches(stub.calls)[0]?.headers.authorization).toBe('Bearer at-fresh');
    expect(await ctx.accountSecrets.getJson<OAuthTokens>('oauth')).toMatchObject({ accessToken: 'at-fresh', refreshToken: 'rt-fresh' });
  });

  it('maps rate limits and server errors to retryable platform errors', async () => {
    vi.stubGlobal('fetch', routes({ [`GET ${API}/channels`]: () => json({ message: 'Too Many Requests' }, 429) }).fetch);
    expect(await kickDriver.prepare(makeDestination(), makeAccount(), 'T', ctx).catch((e: unknown) => e)).toMatchObject({
      code: 'platform-error',
    });
  });

  it('works without an account from the pasted key alone (no API calls)', async () => {
    const stub = routes();
    vi.stubGlobal('fetch', stub.fetch);
    const keyCtx = makeCtx({ accountSecrets: null });
    await keyCtx.destinationSecrets.set('streamKey', ' sk_manual ');
    const prepared = await kickDriver.prepare(makeDestination({ accountId: null, hasStreamKey: true }), null, 'T', keyCtx);
    expect(prepared).toEqual({ push: { url: `rtmps://${IVS}/app/sk_manual`, mode: 'copy', feeds: ['landscape'] }, watchUrl: null });
    expect(stub.calls).toHaveLength(0);
  });

  it('asks for the stream key without account or key', async () => {
    const keyCtx = makeCtx({ accountSecrets: null });
    const err = await kickDriver.prepare(makeDestination({ accountId: null }), null, 'T', keyCtx).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'misconfigured',
      message: 'Paste your Kick stream key in this destination (Kick dashboard → Settings → Stream URL & Key)',
    });
  });

  it('honours the vertical feed', async () => {
    vi.stubGlobal('fetch', routes().fetch);
    const prepared = await kickDriver.prepare(makeDestination({ feed: 'vertical' }), makeAccount(), 'T', ctx);
    expect(prepared.push?.feeds).toEqual(['vertical']);
  });

  it('never streams in test mode (Kick has none), without calling Kick', async () => {
    const stub = routes();
    vi.stubGlobal('fetch', stub.fetch);
    const testCtx = makeCtx({ testMode: true });
    await testCtx.accountSecrets.setJson('oauth', tokens());
    const err = await kickDriver.prepare(makeDestination(), makeAccount(), 'T', testCtx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect(err).toMatchObject({ message: 'Kick has no test mode — skipped while testing' });
    expect(stub.calls).toHaveLength(0);
  });

  it('health reports viewers from the channel endpoint (null while not live)', async () => {
    let live = false;
    const stub = routes({
      [`GET ${API}/channels`]: () =>
        json({ data: [channel({ stream: { url: `rtmps://${IVS}`, key: 'sk_us-west-2_apikey', is_live: live, viewer_count: live ? 321 : 0 } })] }),
    });
    vi.stubGlobal('fetch', stub.fetch);
    const prepared = await kickDriver.prepare(makeDestination(), makeAccount(), 'Old title', ctx);
    expect(typeof prepared.health).toBe('function');
    expect(prepared.recovery).toBeUndefined();

    const ctl = new AbortController();
    expect((await watch(prepared, ctl.signal).next()).value).toEqual({ type: 'viewers', count: null });
    live = true;
    expect((await watch(prepared, ctl.signal).next()).value).toEqual({ type: 'viewers', count: 321 });
    ctl.abort();
    expect(stub.calls.filter((c) => c.method === 'GET').every((c) => c.headers.authorization === 'Bearer at-valid')).toBe(true);
  });

  it('health keeps the last count through one failed read', async () => {
    let fail = false;
    vi.stubGlobal(
      'fetch',
      routes({
        [`GET ${API}/channels`]: () => (fail ? json({ message: 'boom' }, 500) : json({ data: [channel({ stream: { is_live: true, viewer_count: 5 } })] })),
      }).fetch,
    );
    await ctx.destinationSecrets.set('streamKey', 'sk_manual');
    const prepared = await kickDriver.prepare(makeDestination({ hasStreamKey: true }), makeAccount(), 'Old title', ctx);
    fail = true;
    const ctl = new AbortController();
    const next = watch(prepared, ctl.signal).next();
    setTimeout(() => ctl.abort(), 50);
    // First failure yields nothing; the abort during the 30 s wait ends the watcher.
    expect(await next).toEqual({ done: true, value: undefined });
  });

  it('passes a caller abort through unchanged', async () => {
    const ctl = new AbortController();
    ctl.abort(new Error('stopped'));
    const abortCtx = makeCtx({ signal: ctl.signal });
    await abortCtx.accountSecrets.setJson('oauth', tokens());
    vi.stubGlobal('fetch', routes().fetch);
    await expect(kickDriver.prepare(makeDestination(), makeAccount(), 'T', abortCtx)).rejects.toThrow('stopped');
  });
});

describe('token refresh', () => {
  it('refreshes once when two destinations of one account need a new token at the same time', async () => {
    const shared = new Map<string, string>();
    const a = makeCtx({ accountSecrets: new MemorySecrets(shared) });
    const b = makeCtx({ accountSecrets: new MemorySecrets(shared) });
    await a.accountSecrets.setJson('oauth', tokens({ accessToken: 'at-old', refreshToken: 'rt-old', expiresAt: Date.now() - 1 }));
    let refreshes = 0;
    const stub = fetchStub({
      [`POST ${TOKEN_URL}`]: async (req) => {
        refreshes++;
        await new Promise((r) => setTimeout(r, 30));
        // Kick rotates refresh tokens: an already-used one is rejected
        return form(req).refresh_token === 'rt-old' && refreshes === 1
          ? json({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 })
          : json({ error: 'Invalid request' }, 400);
      },
      [`PATCH ${API}/channels`]: () => new Response(null, { status: 204 }),
    });
    vi.stubGlobal('fetch', stub.fetch);
    await Promise.all([
      kickDriver.setTitleOffline!(makeDestination(), makeAccount(), 'A', a),
      kickDriver.setTitleOffline!(makeDestination({ id: 'dest2', feed: 'vertical' }), makeAccount(), 'B', b),
    ]);
    expect(refreshes).toBe(1);
    expect(patches(stub.calls).map((c) => c.headers.authorization)).toEqual(['Bearer at-new', 'Bearer at-new']);
  });
});

describe('setTitleOffline', () => {
  it('patches only the title, and does nothing without an account', async () => {
    await ctx.accountSecrets.setJson('oauth', tokens());
    const stub = fetchStub({ [`PATCH ${API}/channels`]: () => new Response(null, { status: 204 }) });
    vi.stubGlobal('fetch', stub.fetch);
    await kickDriver.setTitleOffline!(makeDestination(), makeAccount(), '  Next stream  ', ctx);
    await kickDriver.setTitleOffline!(makeDestination({ accountId: null }), null, 'ignored', ctx);
    expect(stub.calls.map((c) => JSON.parse(c.body!) as unknown)).toEqual([{ stream_title: 'Next stream' }]);
  });

  it('explains a missing permission', async () => {
    await ctx.accountSecrets.setJson('oauth', tokens());
    vi.stubGlobal('fetch', fetchStub({ [`PATCH ${API}/channels`]: () => json({ message: 'Forbidden' }, 403) }).fetch);
    const err = await kickDriver.setTitleOffline!(makeDestination(), makeAccount(), 'T', ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'needs-login' });
    expect((err as Error).message).toMatch(/approve every permission/);
  });
});
