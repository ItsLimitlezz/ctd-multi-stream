import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DriverError, type ChatMessageInput } from '../platforms/types.js';
import {
  abortable,
  clickWhenEnabled,
  fillField,
  humanPause,
  readTextValue,
  requireLoggedIn,
  scrapeChat,
  waitForAny,
  withTimeout,
} from './helpers.js';

describe('promise helpers', () => {
  it('withTimeout rejects with a timeout DriverError', async () => {
    const never = new Promise<void>(() => {});
    const err = await withTimeout(never, 30, 'too slow').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('timeout');
    expect((err as DriverError).message).toBe('too slow');
    await expect(withTimeout(Promise.resolve(5), 1000, 'x')).resolves.toBe(5);
  });

  it('abortable rejects on abort and passes values through', async () => {
    const ac = new AbortController();
    const p = abortable(new Promise<number>(() => {}), ac.signal);
    ac.abort(new Error('stopped'));
    await expect(p).rejects.toThrow('stopped');
    await expect(abortable(Promise.resolve(1), new AbortController().signal)).resolves.toBe(1);
    await expect(abortable(Promise.resolve(2))).resolves.toBe(2);
    const pre = new AbortController();
    pre.abort();
    await expect(abortable(Promise.reject(new Error('ignored')), pre.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('humanPause waits and can be aborted', async () => {
    const t0 = Date.now();
    await humanPause(20, 40);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
    const ac = new AbortController();
    const p = humanPause(5000, 6000, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

const EXTRACT = `(el) => ({ id: el.dataset.id || null, author: el.dataset.author, text: el.textContent, color: el.dataset.color })`;

interface ChatItem {
  author: string;
  text: string;
  id?: string;
}

function chatHtml(items: ChatItem[]): string {
  const lis = items
    .map((i) => `<li data-author="${i.author}"${i.id ? ` data-id="${i.id}"` : ''} data-color="#ff0000">${i.text}</li>`)
    .join('');
  return `<!doctype html><html><body><ul id="chat">${lis}</ul></body></html>`;
}

async function next(it: AsyncIterator<ChatMessageInput>, ms = 5000): Promise<ChatMessageInput> {
  const r = await withTimeout(it.next(), ms, 'no chat message');
  if (r.done) throw new Error('iterator ended');
  return r.value;
}

async function appendItem(page: Page, item: ChatItem): Promise<void> {
  await page.evaluate(`(() => {
    const li = document.createElement('li');
    li.dataset.author = ${JSON.stringify(item.author)};
    ${item.id ? `li.dataset.id = ${JSON.stringify(item.id)};` : ''}
    li.textContent = ${JSON.stringify(item.text)};
    document.getElementById('chat').appendChild(li);
  })()`);
}

describe.skipIf(!!process.env.CI_NO_BROWSER)('browser helpers (Chromium)', () => {
  let browser: Browser;
  let page: Page;
  let server: http.Server;
  let origin = '';
  let serverItems: ChatItem[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/slow.css') {
        // Holds the page's load event back for a while.
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/css' });
          res.end('');
        }, 1000);
        return;
      }
      if (req.url === '/loading-chat') {
        // Empty list at DOMContentLoaded; the backlog renders while the page is still loading.
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><html><body><ul id="chat"></ul>
          <script>setTimeout(() => { for (const t of ['backlog 1', 'backlog 2']) {
            const li = document.createElement('li'); li.dataset.author = 'old'; li.textContent = t;
            document.getElementById('chat').appendChild(li); } }, 300);</script>
          <link rel="stylesheet" href="/slow.css"></body></html>`);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(chatHtml(serverItems));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it('waitForAny picks the visible candidate', async () => {
    await page.setContent('<div id="a" style="display:none">A</div><div id="b">B</div><div id="c">C</div>');
    const key = await waitForAny(page, { a: page.locator('#a'), b: page.locator('#b'), c: page.locator('#c') }, { timeoutMs: 2000 });
    expect(key).toBe('b');
  });

  it('waitForAny waits for an element that appears later', async () => {
    await page.setContent(`<div id="a" style="display:none">A</div><script>setTimeout(() => { document.getElementById('a').style.display = 'block' }, 300)</script>`);
    const key = await waitForAny(page, { missing: page.locator('#nope'), a: page.locator('#a') }, { timeoutMs: 3000 });
    expect(key).toBe('a');
  });

  it('waitForAny times out and honours abort', async () => {
    await page.setContent('<div>nothing</div>');
    const err = await waitForAny(page, { x: page.locator('#x') }, { timeoutMs: 300 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('timeout');

    const ac = new AbortController();
    const p = waitForAny(page, { x: page.locator('#x') }, { timeoutMs: 10_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('clickWhenEnabled waits until the button is enabled', async () => {
    await page.setContent(`
      <button id="go" disabled onclick="window.clicked = (window.clicked || 0) + 1">Go</button>
      <script>setTimeout(() => { document.getElementById('go').disabled = false }, 300)</script>`);
    await clickWhenEnabled(page.getByRole('button', { name: 'Go' }), { timeoutMs: 5000 });
    expect(await page.evaluate('window.clicked')).toBe(1);

    await page.setContent('<button disabled>Never</button>');
    const err = await clickWhenEnabled(page.getByRole('button', { name: 'Never' }), { timeoutMs: 300, what: 'the button' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DriverError);
    expect((err as Error).message).toContain('the button');
  });

  it('fillField clears and types into inputs and contenteditable', async () => {
    await page.setContent('<input id="t" value="old title"><div id="ce" contenteditable="true">old</div>');
    await fillField(page.locator('#t'), 'New title ✓', { minDelayMs: 0, maxDelayMs: 5 });
    expect(await page.inputValue('#t')).toBe('New title ✓');
    await fillField(page.locator('#ce'), 'hello', { minDelayMs: 0, maxDelayMs: 5 });
    expect(await page.locator('#ce').innerText()).toBe('hello');
  });

  it('readTextValue reads input values and text nodes', async () => {
    await page.setContent(`
      <input id="key" value="  sk_live_123  " readonly>
      <span id="url">rtmps://live-upload.example.com:443/rtmp/</span>
      <div id="wrap"><label></label><input value="inner-key"></div>`);
    expect(await readTextValue(page.locator('#key'))).toBe('sk_live_123');
    expect(await readTextValue(page.locator('#url'))).toBe('rtmps://live-upload.example.com:443/rtmp/');
    expect(await readTextValue(page.locator('#wrap'))).toBe('inner-key');
  });

  it('requireLoggedIn throws needs-login when logged out', async () => {
    await expect(requireLoggedIn(page, async () => true, 'Instagram')).resolves.toBeUndefined();
    const err = await requireLoggedIn(page, async () => false, 'Instagram').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('needs-login');
    expect((err as DriverError).message).toBe('Instagram session expired — log in again from Accounts');
  });

  it('scrapeChat yields only new messages and dedupes across reloads', async () => {
    serverItems = [
      { author: 'alice', text: 'hello' },
      { author: 'bob', text: 'hi' },
    ];
    const chatPage = await browser.newPage();
    await chatPage.goto(`${origin}/chat`);
    const ac = new AbortController();
    const it = scrapeChat(chatPage, { containerSelector: '#chat', itemSelector: 'li', extract: EXTRACT, pollMs: 200 }, ac.signal)[
      Symbol.asyncIterator
    ]();
    const first = it.next(); // starts the scraper (baseline = existing items)
    await new Promise((r) => setTimeout(r, 400));

    await appendItem(chatPage, { author: 'carol', text: 'new one' });
    const m1 = (await withTimeout(first, 5000, 'no message')).value as ChatMessageInput;
    expect(m1.author.name).toBe('carol');
    expect(m1.text).toBe('new one');
    expect(m1.kind).toBe('message');
    expect(typeof m1.ts).toBe('string');

    // A legit repeat in the same document is a new message.
    await appendItem(chatPage, { author: 'carol', text: 'new one' });
    expect((await next(it)).text).toBe('new one');

    // After a reload the old items are re-rendered: only the genuinely new one is yielded.
    serverItems = [...serverItems, { author: 'carol', text: 'new one' }, { author: 'carol', text: 'new one' }, { author: 'dave', text: 'after reload' }];
    await chatPage.reload();
    const m3 = await next(it);
    expect(m3.author.name).toBe('dave');
    expect(m3.text).toBe('after reload');
    expect(m3.author.color).toBe('#ff0000');

    await appendItem(chatPage, { author: 'erin', text: 'last' });
    expect((await next(it)).text).toBe('last');

    ac.abort();
    const end = await withTimeout(it.next(), 3000, 'did not stop');
    expect(end.done).toBe(true);
    await chatPage.close();
  });

  it('scrapeChat dedupes by stable id', async () => {
    serverItems = [{ author: 'a', text: 'old', id: '1' }];
    const chatPage = await browser.newPage();
    await chatPage.goto(`${origin}/chat`);
    const ac = new AbortController();
    const it = scrapeChat(chatPage, { containerSelector: '#chat', itemSelector: 'li', extract: EXTRACT, pollMs: 200 }, ac.signal)[
      Symbol.asyncIterator
    ]();
    const first = it.next();
    await new Promise((r) => setTimeout(r, 400));
    await appendItem(chatPage, { author: 'b', text: 'two', id: '2' });
    await appendItem(chatPage, { author: 'b', text: 'two (re-rendered)', id: '2' });
    await appendItem(chatPage, { author: 'c', text: 'three', id: '3' });
    const m = (await withTimeout(first, 5000, 'no message')).value as ChatMessageInput;
    expect(m.id).toBe('2');
    const m2 = await next(it);
    expect(m2.id).toBe('3');
    ac.abort();
    await it.return?.(undefined);
    await chatPage.close();
  });

  it('scrapeChat does not replay a backlog that renders while the page is still loading', async () => {
    // A restarted source re-opens the page: the list exists first, the old comments arrive later.
    const chatPage = await browser.newPage();
    await chatPage.goto(`${origin}/loading-chat`, { waitUntil: 'domcontentloaded' });
    const ac = new AbortController();
    const it = scrapeChat(chatPage, { containerSelector: '#chat', itemSelector: 'li', extract: EXTRACT, pollMs: 200 }, ac.signal)[
      Symbol.asyncIterator
    ]();
    const first = it.next();
    await chatPage.waitForLoadState('load');
    await new Promise((r) => setTimeout(r, 500)); // baseline taken after the load
    await appendItem(chatPage, { author: 'new', text: 'fresh' });
    const m = (await withTimeout(first, 5000, 'no message')).value as ChatMessageInput;
    expect(m.text).toBe('fresh');
    ac.abort();
    await it.return?.(undefined);
    await chatPage.close();
  });

  it('scrapeChat rejects invalid extract source and closed pages', async () => {
    const ac = new AbortController();
    const bad = scrapeChat(page, { itemSelector: 'li', extract: '(el) => {' }, ac.signal)[Symbol.asyncIterator]();
    await expect(bad.next()).rejects.toThrow('extract is not valid JavaScript');

    const closed = await browser.newPage();
    await closed.close();
    const it = scrapeChat(closed, { itemSelector: 'li', extract: EXTRACT }, ac.signal)[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toBeInstanceOf(DriverError);
  });
});
