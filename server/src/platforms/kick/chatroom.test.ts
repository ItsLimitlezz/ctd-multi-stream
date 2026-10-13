import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BrowserManager } from '../../services.js';
import {
  channelApiUrl,
  ChatroomNotFoundError,
  fetchChatroomDirect,
  fetchChatroomViaBrowser,
  lookupChatroom,
  parseChatroomResponse,
} from './chatroom.js';
import { fetchStub, json, unusedBrowser } from './test-utils.js';

const CHANNEL_JSON = { id: 4242, user_id: 77, slug: 'testchan', chatroom: { id: 668, channel_id: 4242 } };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseChatroomResponse', () => {
  it('reads chatroom.id and the channel id', () => {
    expect(parseChatroomResponse(CHANNEL_JSON)).toEqual({ chatroomId: 668, channelId: 4242 });
    expect(parseChatroomResponse({ chatroom: { id: '669' } })).toEqual({ chatroomId: 669, channelId: null });
  });

  it('returns null without a usable chatroom id', () => {
    expect(parseChatroomResponse({ id: 1 })).toBeNull();
    expect(parseChatroomResponse({ id: 1, chatroom: null })).toBeNull();
    expect(parseChatroomResponse({ chatroom: { id: -3 } })).toBeNull();
    expect(parseChatroomResponse('x')).toBeNull();
  });

  it('builds the kick.com channel URL with an encoded slug', () => {
    expect(channelApiUrl('my-chan')).toBe('https://kick.com/api/v2/channels/my-chan');
    expect(channelApiUrl('a/b')).toBe('https://kick.com/api/v2/channels/a%2Fb');
  });
});

describe('fetchChatroomDirect', () => {
  const signal = new AbortController().signal;

  it('returns the chatroom on a JSON answer, with browser-like headers', async () => {
    const stub = fetchStub({ 'GET https://kick.com/api/v2/channels/testchan': () => json(CHANNEL_JSON) });
    vi.stubGlobal('fetch', stub.fetch);
    expect(await fetchChatroomDirect('testchan', { signal })).toEqual({ chatroomId: 668, channelId: 4242 });
    expect(stub.calls[0]?.headers['user-agent']).toMatch(/Chrome/);
  });

  it('returns null when Cloudflare blocks the request (403 or HTML with 200)', async () => {
    vi.stubGlobal('fetch', fetchStub({ 'GET https://kick.com/': () => new Response('<html>Just a moment...</html>', { status: 403 }) }).fetch);
    expect(await fetchChatroomDirect('testchan', { signal })).toBeNull();
    vi.stubGlobal('fetch', fetchStub({ 'GET https://kick.com/': () => new Response('<html>challenge</html>', { status: 200 }) }).fetch);
    expect(await fetchChatroomDirect('testchan', { signal })).toBeNull();
  });

  it('returns null on network errors', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    expect(await fetchChatroomDirect('testchan', { signal })).toBeNull();
  });

  it('throws ChatroomNotFoundError on 404 or a channel without chatroom', async () => {
    vi.stubGlobal('fetch', fetchStub({ 'GET https://kick.com/': () => json({ message: 'Not found' }, 404) }).fetch);
    await expect(fetchChatroomDirect('nobody', { signal })).rejects.toBeInstanceOf(ChatroomNotFoundError);
    vi.stubGlobal('fetch', fetchStub({ 'GET https://kick.com/': () => json({ id: 1, chatroom: null }) }).fetch);
    await expect(fetchChatroomDirect('nochat', { signal })).rejects.toBeInstanceOf(ChatroomNotFoundError);
  });

  it('propagates the caller abort', async () => {
    const ctl = new AbortController();
    ctl.abort();
    vi.stubGlobal('fetch', fetchStub({ 'GET https://kick.com/': () => json(CHANNEL_JSON) }).fetch);
    await expect(fetchChatroomDirect('testchan', { signal: ctl.signal })).rejects.toThrow();
  });
});

describe.skipIf(!!process.env.CI_NO_BROWSER)('chatroom lookup through the browser (Chromium)', () => {
  let browser: Browser;
  let server: http.Server;
  let base: string;
  let hits = 0;
  const contexts: BrowserContext[] = [];

  // Mimics Cloudflare: the first visit gets a 403 challenge page that sets a clearance cookie and
  // reloads itself; with the cookie, the JSON comes back.
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits++;
      const url = req.url ?? '';
      if (url.startsWith('/hang/')) return; // never answers
      if (url.startsWith('/api/v2/channels/missing')) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"Not found"}');
        return;
      }
      if (!url.startsWith('/api/v2/channels/testchan')) {
        res.writeHead(404).end();
        return;
      }
      if (!(req.headers.cookie ?? '').includes('cf_clearance=ok')) {
        res.writeHead(403, { 'content-type': 'text/html', 'set-cookie': 'cf_clearance=ok; Path=/' });
        res.end('<html><body>Just a moment...<script>setTimeout(() => location.reload(), 300)</script></body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(CHANNEL_JSON));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2/channels/`;
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  function manager(): BrowserManager & { closed: { accountId: string; save?: boolean }[] } {
    const closed: { accountId: string; save?: boolean }[] = [];
    let ctx: BrowserContext | null = null;
    return {
      ...unusedBrowser(),
      async context() {
        ctx ??= await browser.newContext();
        contexts.push(ctx);
        return ctx;
      },
      async close(accountId, opts) {
        closed.push({ accountId, save: opts?.save });
        await ctx?.close();
        ctx = null;
      },
      closed,
    };
  }

  it('waits through a challenge page and reads the JSON', async () => {
    const bm = manager();
    const info = await fetchChatroomViaBrowser(bm, 'acc1', 'testchan', { signal: new AbortController().signal, base, timeoutMs: 15_000 });
    expect(info).toEqual({ chatroomId: 668, channelId: 4242 });
    // the tab it opened is closed again
    expect(contexts.at(-1)?.pages()).toHaveLength(0);
  });

  it('maps a 404 to ChatroomNotFoundError', async () => {
    const bm = manager();
    await expect(
      fetchChatroomViaBrowser(bm, 'acc1', 'missing', { signal: new AbortController().signal, base, timeoutMs: 15_000 }),
    ).rejects.toBeInstanceOf(ChatroomNotFoundError);
  });

  it('lookupChatroom falls back to the browser, shares parallel lookups and closes the context with save', async () => {
    vi.stubGlobal('fetch', async () => new Response('blocked', { status: 403 }));
    const bm = manager();
    const signal = new AbortController().signal;
    const before = hits;
    const [a, b] = await Promise.all([
      lookupChatroom('testchan', { browser: bm, accountId: 'acc1', signal, base, browserTimeoutMs: 15_000 }),
      lookupChatroom('TestChan', { browser: bm, accountId: 'acc1', signal, base, browserTimeoutMs: 15_000 }),
    ]);
    expect(a).toEqual({ chatroomId: 668, channelId: 4242 });
    expect(b).toEqual(a);
    expect(hits - before).toBe(2); // one challenge + one JSON answer: a single browser visit
    expect(bm.closed).toEqual([{ accountId: 'acc1', save: true }]);
  });

  it('stops promptly when aborted', async () => {
    const bm = manager();
    const ctl = new AbortController();
    const hangBase = base.replace('/api/v2/channels/', '/hang/');
    const p = fetchChatroomViaBrowser(bm, 'acc1', 'never', { signal: ctl.signal, base: hangBase, timeoutMs: 30_000 });
    setTimeout(() => ctl.abort(new Error('stopped')), 300);
    const started = Date.now();
    await expect(p).rejects.toThrow('stopped');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
