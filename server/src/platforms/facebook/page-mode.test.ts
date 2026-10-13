import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DriverError } from '../types.js';
import { appSecretProof, GRAPH_VERSION, graphError } from './graph.js';
import { createFacebookDriver } from './index.js';
import { PAGE_SCOPES, TITLE_MAX, type StoredPage } from './page-mode.js';
import { graphErr, graphPath, json, makeAccount, makeCtx, makeDest, param, stubFetch, type FakeContext, type StubCall } from './test-utils.js';
import { vi } from 'vitest';

const driver = createFacebookDriver({ page: { graphHost: 'https://graph.test', streamingHost: 'https://stream.test', commentPollMs: 20 } });

afterEach(() => {
  vi.unstubAllGlobals();
});

const PAGE: StoredPage = { id: '1001', name: 'My Page', accessToken: 'PAGE-TOKEN-1' };

async function connectedCtx(overrides: Partial<FakeContext> = {}): Promise<FakeContext> {
  const ctx = makeCtx(overrides);
  await ctx.accountSecrets.setJson('page', PAGE);
  await ctx.accountSecrets.setJson('oauth', { accessToken: 'USER-LL', refreshToken: null, expiresAt: Date.now() + 86_400_000, scope: null, tokenType: 'bearer' });
  return ctx;
}

describe('page mode: connect', () => {
  it('requires the developer app', async () => {
    const ctx = makeCtx({ app: null });
    const err = await driver.startConnect!(makeAccount(), ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('misconfigured');
    expect((err as DriverError).message).toBe('Set up the Facebook developer app in Settings → Developer apps');
  });

  it('builds the authorize URL and stores the pending state', async () => {
    const ctx = makeCtx({ publicBaseUrl: 'https://203.0.113.7/' });
    const start = await driver.startConnect!(makeAccount(), ctx);
    expect(start.method).toBe('oauth-paste');
    if (start.method !== 'oauth-paste') return;
    expect(start.redirectUri).toBe('https://203.0.113.7/oauth/callback/facebook');
    const u = new URL(start.authorizeUrl);
    expect(`${u.origin}${u.pathname}`).toBe(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
    expect(u.searchParams.get('client_id')).toBe('app-123');
    expect(u.searchParams.get('redirect_uri')).toBe(start.redirectUri);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')?.split(',')).toEqual(PAGE_SCOPES);
    expect(u.searchParams.get('client_secret')).toBeNull();
    const state = u.searchParams.get('state')!;
    expect(state.startsWith('acc1.')).toBe(true);
    const pending = await ctx.accountSecrets.getJson<{ state: string; redirectUri: string }>('pkce');
    expect(pending).toMatchObject({ state, redirectUri: start.redirectUri });
  });

  it('uses config_id instead of scope for Facebook Login for Business', async () => {
    const ctx = makeCtx({ app: { clientId: 'app-123', clientSecret: 's', configId: ' 777 ' } });
    const start = await driver.startConnect!(makeAccount(), ctx);
    if (start.method !== 'oauth-paste') throw new Error('wrong method');
    const u = new URL(start.authorizeUrl);
    expect(u.searchParams.get('config_id')).toBe('777');
    expect(u.searchParams.get('scope')).toBeNull();
  });

  function connectStub(pages: unknown[], perms = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_read_user_content']) {
    return stubFetch((call) => {
      const path = graphPath(call.url);
      if (path === 'oauth/access_token' && param(call, 'code')) return json(200, { access_token: 'SHORT', token_type: 'bearer', expires_in: 5000 });
      if (path === 'oauth/access_token' && param(call, 'grant_type') === 'fb_exchange_token') {
        return json(200, { access_token: 'LONG', token_type: 'bearer', expires_in: 5_183_944 });
      }
      if (path === 'me/permissions') return json(200, { data: perms.map((permission) => ({ permission, status: 'granted' })) });
      if (path === 'me/accounts') return json(200, { data: pages, paging: { cursors: { before: 'a', after: 'b' } } });
      return graphErr(400, 100, `unexpected ${path}`);
    });
  }

  async function begin(ctx: FakeContext, account = makeAccount()): Promise<string> {
    const start = await driver.startConnect!(account, ctx);
    if (start.method !== 'oauth-paste') throw new Error('wrong method');
    return new URL(start.authorizeUrl).searchParams.get('state')!;
  }

  it('exchanges the code, picks the first Page and stores its token', async () => {
    const ctx = makeCtx();
    const state = await begin(ctx);
    const calls = connectStub([
      { id: '1001', name: 'My Page', access_token: 'PAGE-1', tasks: ['CREATE_CONTENT', 'MANAGE'] },
      { id: '1002', name: 'Other', access_token: 'PAGE-2', tasks: ['CREATE_CONTENT'] },
    ]);
    const res = await driver.completeConnect!(
      makeAccount(),
      { pastedUrl: `https://203.0.113.7/oauth/callback/facebook?code=CODE-1&state=${state}#_=_` },
      ctx,
    );
    expect(res).toMatchObject({ status: 'connected', account: { label: 'My Page', status: 'connected', options: { mode: 'page', pageId: '1001' } } });

    const exchange = calls.find((c) => param(c, 'code'))!;
    expect(param(exchange, 'client_id')).toBe('app-123');
    expect(param(exchange, 'client_secret')).toBe('app-secret-xyz');
    expect(param(exchange, 'redirect_uri')).toBe('https://203.0.113.7/oauth/callback/facebook');
    expect(exchange.url.pathname.startsWith(`/${GRAPH_VERSION}/`)).toBe(true);
    const longCall = calls.find((c) => param(c, 'grant_type') === 'fb_exchange_token')!;
    expect(param(longCall, 'fb_exchange_token')).toBe('SHORT');
    const accounts = calls.find((c) => graphPath(c.url) === 'me/accounts')!;
    expect(param(accounts, 'access_token')).toBe('LONG');
    expect(param(accounts, 'appsecret_proof')).toBe(appSecretProof('LONG', 'app-secret-xyz'));

    expect(await ctx.accountSecrets.getJson('page')).toEqual({ id: '1001', name: 'My Page', accessToken: 'PAGE-1' });
    expect(await ctx.accountSecrets.getJson('oauth')).toMatchObject({ accessToken: 'LONG', refreshToken: null });
    expect(await ctx.accountSecrets.get('pkce')).toBeNull();
    expect(ctx.updates.at(-1)).toMatchObject({ label: 'My Page', status: 'connected', statusMessage: null });
  });

  it('honours the Page ID option and skips Pages without CREATE_CONTENT', async () => {
    const ctx = makeCtx();
    const account = makeAccount({ options: { mode: 'page', pageId: '1002' } });
    const state = await begin(ctx, account);
    connectStub([
      { id: '1001', name: 'My Page', access_token: 'PAGE-1', tasks: ['CREATE_CONTENT'] },
      { id: '1002', name: 'Other', access_token: 'PAGE-2', tasks: ['CREATE_CONTENT'] },
    ]);
    const res = await driver.completeConnect!(account, { pastedUrl: `?code=C&state=${state}` }, ctx);
    expect(res).toMatchObject({ status: 'connected', account: { label: 'Other', options: { pageId: '1002' } } });

    const ctx2 = makeCtx();
    const state2 = await begin(ctx2, account);
    connectStub([{ id: '1002', name: 'Other', access_token: 'PAGE-2', tasks: ['ANALYZE'] }]);
    const res2 = await driver.completeConnect!(account, { pastedUrl: `?code=C&state=${state2}` }, ctx2);
    expect(res2.status).toBe('error');
    if (res2.status === 'error') expect(res2.message).toMatch(/No Facebook Page found/);
  });

  it('rejects a wrong or missing state, cancelled logins and expired attempts', async () => {
    const ctx = makeCtx();
    const calls = stubFetch(() => json(500, {}));
    expect(await driver.completeConnect!(makeAccount(), { pastedUrl: '?code=a&state=acc1.x' }, ctx)).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/No Facebook sign-in is in progress/),
    });

    const state = await begin(ctx);
    expect(await driver.completeConnect!(makeAccount(), { pastedUrl: `?code=a&state=${state}x` }, ctx)).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/older connection attempt/),
    });
    expect(await driver.completeConnect!(makeAccount(), { pastedUrl: 'https://203.0.113.7/oauth/callback/facebook' }, ctx)).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/full address/),
    });
    expect(
      await driver.completeConnect!(makeAccount(), { pastedUrl: `?error=access_denied&error_reason=user_denied&state=${state}` }, ctx),
    ).toMatchObject({ status: 'error', message: expect.stringMatching(/declined/) });
    expect(await ctx.accountSecrets.get('pkce')).toBeNull();

    await begin(ctx);
    const pending = (await ctx.accountSecrets.getJson<{ state: string; createdAt: number }>('pkce'))!;
    await ctx.accountSecrets.setJson('pkce', { ...pending, createdAt: Date.now() - 31 * 60_000 });
    expect(await driver.completeConnect!(makeAccount(), { pastedUrl: `?code=a&state=${pending.state}` }, ctx)).toEqual({ status: 'expired' });
    expect(calls).toHaveLength(0);
  });

  it('reports missing permissions and Graph errors without leaking secrets', async () => {
    const ctx = makeCtx();
    let state = await begin(ctx);
    connectStub([], ['pages_show_list']);
    const res = await driver.completeConnect!(makeAccount(), { pastedUrl: `?code=C&state=${state}` }, ctx);
    expect(res.status).toBe('error');
    if (res.status === 'error') expect(res.message).toMatch(/did not grant: pages_read_engagement, pages_manage_posts/);

    state = await begin(ctx);
    stubFetch(() => graphErr(400, 100, 'This authorization code has been used.', 36009));
    const res2 = await driver.completeConnect!(makeAccount(), { pastedUrl: `?code=C&state=${state}` }, ctx);
    expect(res2).toEqual({ status: 'error', message: 'Facebook error: This authorization code has been used.' });
    expect(JSON.stringify(res2)).not.toContain('app-secret-xyz');
  });

  it('switches to the browser flow for profile accounts', async () => {
    const start = await driver.startConnect!(makeAccount({ options: { mode: 'profile' } }), makeCtx({ app: null }));
    expect(start).toMatchObject({ method: 'browser', startUrl: 'https://www.facebook.com/login' });
  });
});

describe('page mode: live', () => {
  function liveStub(over: (call: StubCall) => Response | null = () => null): StubCall[] {
    return stubFetch((call) => {
      const o = over(call);
      if (o) return o;
      const path = graphPath(call.url);
      if (call.method === 'POST' && path === '1001/live_videos') {
        return json(200, { id: '5555', stream_url: 'rtmp://rtmp-api.facebook.com:80/rtmp/FB-5555-0?s=1', secure_stream_url: 'rtmps://live-api-s.facebook.com:443/rtmp/FB-5555-0?s=1' });
      }
      if (call.method === 'GET' && path === '5555') {
        if (param(call, 'fields') === 'permalink_url') return json(200, { permalink_url: '/mypage/videos/7777/', id: '5555' });
        if (param(call, 'fields') === 'status') return json(200, { status: 'LIVE', id: '5555' });
      }
      if (call.method === 'POST' && path === '5555') return json(200, { id: '5555' });
      if (call.method === 'GET' && path === '1001') return json(200, { id: '1001', name: 'Renamed Page' });
      return graphErr(400, 100, `unexpected ${call.method} ${path}`);
    });
  }

  it('creates a LIVE_NOW live video with only status + title and pushes to the RTMPS URL', async () => {
    const ctx = await connectedCtx();
    const calls = liveStub();
    const longTitle = `${'é'.repeat(250)}🎮🎮🎮🎮🎮🎮`;
    const prepared = await driver.prepare(makeDest({ feed: 'vertical' }), makeAccount({ options: { mode: 'page', pageId: '1001' } }), longTitle, ctx);

    const create = calls.find((c) => c.method === 'POST' && graphPath(c.url) === '1001/live_videos')!;
    expect(new Set(create.form!.keys())).toEqual(new Set(['status', 'title', 'access_token', 'appsecret_proof']));
    expect(param(create, 'status')).toBe('LIVE_NOW');
    expect([...param(create, 'title')!]).toHaveLength(TITLE_MAX);
    expect(param(create, 'access_token')).toBe('PAGE-TOKEN-1');
    expect(param(create, 'appsecret_proof')).toBe(createHmac('sha256', 'app-secret-xyz').update('PAGE-TOKEN-1').digest('hex'));
    expect(create.url.search).toBe(''); // token in the body, not the URL

    expect(prepared.push).toEqual({ url: 'rtmps://live-api-s.facebook.com:443/rtmp/FB-5555-0?s=1', mode: 'copy', feeds: ['vertical'] });
    expect(prepared.watchUrl).toBe('https://www.facebook.com/mypage/videos/7777/');
  });

  it('sends privacy only for "Only me" and falls back to the Page URL without a permalink', async () => {
    const ctx = await connectedCtx();
    const calls = liveStub((call) => (call.method === 'GET' && graphPath(call.url) === '5555' ? graphErr(500, 2, 'Service temporarily unavailable') : null));
    const prepared = await driver.prepare(makeDest({ options: { privacy: 'self' } }), makeAccount(), 'Hi', ctx);
    const create = calls.find((c) => graphPath(c.url) === '1001/live_videos')!;
    expect(JSON.parse(param(create, 'privacy')!)).toEqual({ value: 'SELF' });
    expect(prepared.watchUrl).toBe('https://www.facebook.com/1001');
  });

  it('updates the title and ends the live', async () => {
    const ctx = await connectedCtx();
    const calls = liveStub();
    const prepared = await driver.prepare(makeDest(), makeAccount(), 'Start', ctx);
    await prepared.setTitle!('  New title  ');
    const titleCall = calls.filter((c) => c.method === 'POST' && graphPath(c.url) === '5555').at(-1)!;
    expect(param(titleCall, 'title')).toBe('New title');
    expect([...titleCall.form!.keys()].sort()).toEqual(['access_token', 'appsecret_proof', 'title']);

    await prepared.end!();
    const endCall = calls.filter((c) => c.method === 'POST' && graphPath(c.url) === '5555').at(-1)!;
    expect(param(endCall, 'end_live_video')).toBe('true');
  });

  it('treats "already ended" as success but surfaces other end failures', async () => {
    const ctx = await connectedCtx();
    let status = 'VOD';
    liveStub((call) => {
      const path = graphPath(call.url);
      if (call.method === 'POST' && path === '5555' && param(call, 'end_live_video')) return graphErr(400, 100, 'Live video is not live');
      if (call.method === 'GET' && path === '5555' && param(call, 'fields') === 'status') return json(200, { status });
      return null;
    });
    const prepared = await driver.prepare(makeDest(), makeAccount(), 'x', ctx);
    await expect(prepared.end!()).resolves.toBeUndefined();
    status = 'UNPUBLISHED';
    await expect(prepared.end!()).resolves.toBeUndefined();
    status = 'LIVE';
    await expect(prepared.end!()).rejects.toThrow('Facebook error: Live video is not live');
  });

  it('maps Graph errors to driver error codes', async () => {
    const cases: [Response, DriverError['code'], RegExp][] = [
      [graphErr(400, 190, 'Error validating access token: Session has expired', 463), 'needs-login', /reconnect the account/],
      [graphErr(403, 200, '(#200) Requires pages_manage_posts permission'), 'misconfigured', /Requires pages_manage_posts permission/],
      [graphErr(400, 100, 'This Page is not eligible to go live'), 'not-eligible', /can't go live/],
      [graphErr(400, 368, 'The action attempted has been deemed abusive'), 'not-eligible', /temporarily blocked/],
      [graphErr(400, 32, 'Page request limit reached'), 'platform-error', /rate limit/],
      [new Response('<html>bad gateway</html>', { status: 502 }), 'platform-error', /Facebook error: HTTP 502/],
    ];
    for (const [response, code, message] of cases) {
      const ctx = await connectedCtx();
      stubFetch(() => response.clone());
      const err = await driver.prepare(makeDest(), makeAccount(), 'x', ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DriverError);
      expect((err as DriverError).code).toBe(code);
      expect((err as DriverError).message).toMatch(message);
      expect((err as DriverError).message).not.toContain('PAGE-TOKEN-1');
    }
    expect(graphError(400, '{"error":{"message":"(#10) Application does not have permission","code":10}}').message).toMatch(
      /^Facebook refused the request: Application does not have permission\./,
    );
  });

  it('requires a connected account and Page', async () => {
    stubFetch(() => json(500, {}));
    const noAccount = await driver.prepare(makeDest({ accountId: null }), null, 'x', makeCtx()).catch((e: unknown) => e);
    expect(noAccount).toMatchObject({ code: 'misconfigured' }); // no account and no persistent key
    const notConnected = await driver.prepare(makeDest(), makeAccount(), 'x', makeCtx()).catch((e: unknown) => e);
    expect(notConnected).toMatchObject({ code: 'not-connected', message: 'Facebook Page is not connected — connect the account in Accounts' });
    expect(await driver.validateDestination!(makeDest(), makeAccount(), makeCtx())).toEqual([]);
    expect(await driver.validateDestination!(makeDest({ accountId: null }), null, makeCtx())).toEqual([
      'Choose a connected Facebook account for this destination (or paste a persistent stream key)',
    ]);
  });

  it('switches Pages when the Page ID option changes after connecting', async () => {
    const ctx = await connectedCtx();
    const calls = stubFetch((call) => {
      const path = graphPath(call.url);
      if (path === 'me/accounts') return json(200, { data: [{ id: '2002', name: 'Second', access_token: 'PAGE-2', tasks: ['CREATE_CONTENT'] }] });
      if (call.method === 'POST' && path === '2002/live_videos') return json(200, { id: '9', secure_stream_url: 'rtmps://h/rtmp/k' });
      if (path === '9') return json(200, { permalink_url: 'https://www.facebook.com/second/videos/9/' });
      return graphErr(400, 100, 'unexpected');
    });
    const prepared = await driver.prepare(makeDest(), makeAccount({ options: { mode: 'page', pageId: '2002' } }), 'x', ctx);
    expect(prepared.push?.url).toBe('rtmps://h/rtmp/k');
    expect(param(calls.find((c) => graphPath(c.url) === 'me/accounts')!, 'access_token')).toBe('USER-LL');
    expect(await ctx.accountSecrets.getJson('page')).toEqual({ id: '2002', name: 'Second', accessToken: 'PAGE-2' });
    expect(ctx.updates).toContainEqual({ label: 'Second' });

    const missing = await driver.prepare(makeDest(), makeAccount({ options: { mode: 'page', pageId: '3003' } }), 'x', ctx).catch((e: unknown) => e);
    expect(missing).toMatchObject({ code: 'misconfigured' });
  });

  it('checks the account with the Page token', async () => {
    const ctx = await connectedCtx();
    liveStub();
    expect(await driver.checkAccount!(makeAccount({ options: { mode: 'page', pageId: '1001' } }), ctx)).toEqual({ status: 'connected', label: 'Renamed Page' });
    expect(await driver.checkAccount!(makeAccount(), makeCtx())).toMatchObject({ status: 'pending' });
    stubFetch(() => graphErr(400, 190, 'The user has not authorized application', 458));
    await expect(driver.checkAccount!(makeAccount(), ctx)).rejects.toMatchObject({ code: 'needs-login' });
  });
});
