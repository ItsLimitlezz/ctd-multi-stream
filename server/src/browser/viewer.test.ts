import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserServerMessage } from '../../../shared/api.js';
import { MOD_ALT, MOD_CTRL, MOD_SHIFT } from './keys.js';
import { BrowserViewer, type BrowserViewerOptions } from './viewer.js';

async function waitUntil(fn: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!!process.env.CI_NO_BROWSER)('BrowserViewer', () => {
  let browser: Browser;
  let context: BrowserContext;
  let viewer: BrowserViewer | null = null;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterEach(async () => {
    await viewer?.stop();
    viewer = null;
    await context?.close();
  });

  afterAll(async () => {
    await browser?.close();
  });

  async function setup(html: string, opts: Partial<BrowserViewerOptions> = {}): Promise<{ page: Page; messages: BrowserServerMessage[] }> {
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.setContent(html);
    const messages: BrowserServerMessage[] = [];
    viewer = new BrowserViewer(page, { ...opts, send: (m) => messages.push(m) });
    await viewer.start();
    return { page, messages };
  }

  const key = (k: string, code: string, modifiers = 0, text?: string) => [
    { type: 'key' as const, action: 'down' as const, key: k, code, modifiers, ...(text ? { text } : {}) },
    { type: 'key' as const, action: 'up' as const, key: k, code, modifiers },
  ];

  it('streams frames and relays mouse, text and keys', async () => {
    const { page, messages } = await setup(
      `<input id="a" style="position:absolute;left:100px;top:100px;width:300px;height:30px">
       <script>window.keys = []; document.addEventListener('keydown', (e) => window.keys.push(e.key));</script>`,
    );
    await waitUntil(() => messages.some((m) => m.type === 'frame'));
    const frame = messages.find((m) => m.type === 'frame');
    expect(frame).toMatchObject({ type: 'frame', width: 1280, height: 800 });
    expect(typeof (frame as { data: string }).data).toBe('string');
    expect(messages.some((m) => m.type === 'url')).toBe(true);

    // Click into the input, then paste-style text.
    await viewer!.handle({ type: 'mouse', action: 'move', x: 150, y: 115 });
    await viewer!.handle({ type: 'mouse', action: 'down', x: 150, y: 115, button: 'left', clickCount: 1 });
    await viewer!.handle({ type: 'mouse', action: 'up', x: 150, y: 115, button: 'left', clickCount: 1 });
    await viewer!.handle({ type: 'type', text: 'hello' });
    expect(await page.inputValue('#a')).toBe('hello');

    // Named key + printable key.
    for (const m of key('Backspace', 'Backspace')) await viewer!.handle(m);
    for (const m of key('x', 'KeyX', 0, 'x')) await viewer!.handle(m);
    expect(await page.inputValue('#a')).toBe('hellx');

    // Ctrl+A then typing replaces the selection.
    for (const m of [...key('Control', 'ControlLeft', MOD_CTRL).slice(0, 1), ...key('a', 'KeyA', MOD_CTRL)]) await viewer!.handle(m);
    await viewer!.handle({ type: 'key', action: 'up', key: 'Control', code: 'ControlLeft', modifiers: 0 });
    await viewer!.handle({ type: 'type', text: 'new' });
    expect(await page.inputValue('#a')).toBe('new');

    for (const m of key('Enter', 'Enter')) await viewer!.handle(m);
    const keys = (await page.evaluate('window.keys')) as string[];
    expect(keys).toContain('Enter');
    expect(keys).toContain('Backspace');
  });

  it('resizes within limits and rejects non-http navigation', async () => {
    const { page, messages } = await setup('<p>hi</p>');
    await viewer!.handle({ type: 'resize', width: 100, height: 5000 });
    expect(page.viewportSize()).toEqual({ width: 320, height: 1200 });

    await viewer!.handle({ type: 'navigate', url: 'javascript:alert(1)' });
    await waitUntil(() => messages.some((m) => m.type === 'error'));
    expect(page.url()).toBe('about:blank');
  });

  it('types macOS Option characters only for Mac viewers', async () => {
    const html = `<input id="a" autofocus>`;
    const option2 = key('@', 'Digit2', MOD_ALT, '@'); // '@' on a Spanish Mac layout
    const { page } = await setup(html, { macOptionText: true });
    await page.focus('#a');
    for (const m of option2) await viewer!.handle(m);
    for (const m of key('|', 'Digit1', MOD_ALT | MOD_SHIFT, '|')) await viewer!.handle(m);
    expect(await page.inputValue('#a')).toBe('@|');
    await viewer!.stop();
    await context.close();

    // Windows/Linux viewer: Alt+key is a shortcut and types nothing.
    const other = await setup(html);
    await other.page.focus('#a');
    for (const m of option2) await viewer!.handle(m);
    expect(await other.page.inputValue('#a')).toBe('');
  });

  it('refuses navigation to hosts the policy rejects, also after a redirect', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/go') {
        res.writeHead(302, { location: `http://localhost:${(server.address() as AddressInfo).port}/secret` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<p>secret admin page</p>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      // Pretend 'localhost' is a LAN host and 127.0.0.1 is "public".
      const checkUrl = async (url: URL) => (url.hostname === 'localhost' ? 'blocked host' : null);
      const { page, messages } = await setup('<p>start</p>', { checkUrl });

      await viewer!.handle({ type: 'navigate', url: `http://localhost:${port}/direct` });
      await waitUntil(() => messages.some((m) => m.type === 'error'));
      expect(messages.find((m) => m.type === 'error')).toEqual({ type: 'error', message: 'blocked host' });
      expect(page.url()).toBe('about:blank');

      messages.length = 0;
      await viewer!.handle({ type: 'navigate', url: `http://127.0.0.1:${port}/go` });
      await waitUntil(() => messages.some((m) => m.type === 'error') && page.url() === 'about:blank');
      expect(messages.filter((m) => m.type === 'error')).toEqual([{ type: 'error', message: 'blocked host' }]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('follows popups and reports when the page closes', async () => {
    const { page, messages } = await setup('<p>root</p>');
    await page.evaluate(`window.open('about:blank', '_blank', 'popup')`);
    await waitUntil(() => viewer!.page !== page);
    const popup = viewer!.page;
    expect(context.pages()).toContain(popup);

    await popup.close();
    await waitUntil(() => viewer!.page === page);

    let closedCalled = false;
    // Replace viewer to observe onClosed.
    await viewer!.stop();
    viewer = new BrowserViewer(page, { send: (m) => messages.push(m), onClosed: () => (closedCalled = true) });
    await viewer.start();
    await page.close();
    await waitUntil(() => messages.some((m) => m.type === 'closed'));
    expect(closedCalled).toBe(true);
    expect(viewer.isStopped).toBe(true);
  });

  it('caps the frame rate and holds frames while backpressured', async () => {
    context = await browser.newContext({ viewport: { width: 640, height: 480 } });
    const page = await context.newPage();
    await page.setContent(
      `<div id="box" style="width:100px;height:100px;background:red"></div>
       <script>let i = 0; setInterval(() => { document.getElementById('box').style.marginLeft = (i++ % 300) + 'px' }, 16)</script>`,
    );
    const frames: number[] = [];
    let open = false;
    viewer = new BrowserViewer(page, {
      send: (m) => {
        if (m.type === 'frame') frames.push(Date.now());
      },
      canSendFrame: () => open,
      maxFps: 10,
    });
    await viewer.start();
    await new Promise((r) => setTimeout(r, 400));
    expect(frames.length).toBe(0);
    open = true;
    await new Promise((r) => setTimeout(r, 1200));
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(14);
  });
});
