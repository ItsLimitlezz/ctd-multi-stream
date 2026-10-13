import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import type { BrowserManager, ScopedSecrets, SecretsRepo } from '../services.js';
import { createBrowserManager, desktopUserAgent } from './browser-manager.js';

/** In-memory SecretsRepo with a toy (non-plaintext) box, enough to verify what gets stored. */
function fakeSecrets() {
  const store = new Map<string, string>();
  const encrypt = (s: string) => `enc:${Buffer.from(s, 'utf8').toString('base64')}`;
  const decrypt = (s: string) => Buffer.from(s.slice(4), 'base64').toString('utf8');
  const repo: SecretsRepo = {
    scoped(scope: string): ScopedSecrets {
      const k = (key: string) => `${scope}\u0000${key}`;
      const api: ScopedSecrets = {
        async get(key) {
          const v = store.get(k(key));
          return v === undefined ? null : decrypt(v);
        },
        async set(key, value) {
          store.set(k(key), encrypt(value));
        },
        async delete(key) {
          store.delete(k(key));
        },
        async getJson<T>(key: string) {
          const v = await api.get(key);
          return v === null ? null : (JSON.parse(v) as T);
        },
        async setJson(key, value) {
          await api.set(key, JSON.stringify(value));
        },
      };
      return api;
    },
    deleteScope(scope) {
      for (const key of [...store.keys()]) if (key.startsWith(`${scope}\u0000`)) store.delete(key);
    },
  };
  return { repo, store };
}

const PAGE_SET = `<!doctype html><html><body><script>
  localStorage.setItem('ls-key', 'ls-value');
  const req = indexedDB.open('ctd-test', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('kv');
  req.onsuccess = () => {
    const tx = req.result.transaction('kv', 'readwrite');
    tx.objectStore('kv').put('idb-value', 'token');
    tx.oncomplete = () => { window.done = true; };
  };
</script></body></html>`;

const READ_IDB = `new Promise((resolve) => {
  const req = indexedDB.open('ctd-test', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('kv');
  req.onsuccess = () => {
    const tx = req.result.transaction('kv', 'readonly');
    const get = tx.objectStore('kv').get('token');
    get.onsuccess = () => resolve(get.result ?? null);
    get.onerror = () => resolve(null);
  };
  req.onerror = () => resolve(null);
})`;

describe('desktopUserAgent', () => {
  it('builds a Chrome UA without Headless', () => {
    const ua = desktopUserAgent('156.0.8078.4', 'linux');
    expect(ua).toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36');
    expect(desktopUserAgent('156.0.1', 'win32')).toContain('Windows NT 10.0; Win64; x64');
    expect(desktopUserAgent('156.0.1', 'darwin')).toContain('Macintosh');
  });
});

describe.skipIf(!!process.env.CI_NO_BROWSER)('BrowserManager (Chromium)', () => {
  let server: http.Server;
  let origin = '';
  let manager: BrowserManager;
  const secrets = fakeSecrets();

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/set') {
        res.writeHead(200, {
          'content-type': 'text/html',
          'set-cookie': 'sid=cookie-secret-123; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600',
        });
        res.end(PAGE_SET);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html><body>check</body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const config = { browserHeadless: true } as AppConfig;
    manager = createBrowserManager({ config, log: pino({ level: 'silent' }), secrets: secrets.repo });
  }, 60_000);

  afterAll(async () => {
    await manager?.shutdown();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it('serializes context creation and reuses one page per account', async () => {
    const [a, b] = await Promise.all([manager.context('acc-a'), manager.context('acc-a')]);
    expect(a).toBe(b);
    const [p1, p2] = await Promise.all([manager.page('acc-a'), manager.viewerPage('acc-a')]);
    expect(p1).toBe(p2);
    expect(a.pages()).toHaveLength(1);
    const other = await manager.context('acc-b');
    expect(other).not.toBe(a);

    const ua = (await p1.evaluate('navigator.userAgent')) as string;
    expect(ua).not.toMatch(/headless/i);
    expect(await p1.evaluate('navigator.webdriver')).toBe(false);
    expect(p1.viewportSize()).toEqual({ width: 1280, height: 800 });

    await manager.close('acc-a');
    await manager.close('acc-b');
    expect(await manager.hasSavedSession('acc-a')).toBe(false); // close() without save stores nothing
  });

  it('round-trips cookies, localStorage and IndexedDB through encrypted storage', async () => {
    const page = await manager.page('acc1', `${origin}/set`);
    await page.waitForFunction('window.done === true');
    expect(await manager.hasSavedSession('acc1')).toBe(false);

    await manager.save('acc1');
    expect(await manager.hasSavedSession('acc1')).toBe(true);
    const stored = secrets.store.get('browser:acc1\u0000storageState');
    expect(stored).toBeDefined();
    expect(stored).not.toContain('cookie-secret-123');

    await manager.close('acc1');
    expect(page.isClosed()).toBe(true);

    const restored = await manager.page('acc1', `${origin}/check`);
    const cookies = await restored.context().cookies();
    expect(cookies.find((c) => c.name === 'sid')?.value).toBe('cookie-secret-123');
    expect(await restored.evaluate(`localStorage.getItem('ls-key')`)).toBe('ls-value');
    expect(await restored.evaluate(READ_IDB)).toBe('idb-value');

    // close({ save: true }) persists changes; close() without save does not.
    await restored.evaluate(`localStorage.setItem('ls-key', 'changed')`);
    await manager.close('acc1', { save: true });
    const again = await manager.page('acc1', `${origin}/check`);
    expect(await again.evaluate(`localStorage.getItem('ls-key')`)).toBe('changed');
    await again.evaluate(`localStorage.setItem('ls-key', 'discarded')`);
    await manager.close('acc1', { save: false });
    const third = await manager.page('acc1', `${origin}/check`);
    expect(await third.evaluate(`localStorage.getItem('ls-key')`)).toBe('changed');

    // clear() closes without saving and deletes the stored session.
    await manager.clear('acc1');
    expect(third.isClosed()).toBe(true);
    expect(await manager.hasSavedSession('acc1')).toBe(false);
    const fresh = await manager.page('acc1', `${origin}/check`);
    expect(await fresh.context().cookies()).toHaveLength(0);
    await manager.close('acc1');
  });

  it('starts fresh when the stored session is corrupt', async () => {
    await secrets.repo.scoped('browser:bad').set('storageState', '{not json');
    const page = await manager.page('bad', `${origin}/check`);
    expect(await page.context().cookies()).toHaveLength(0);
    await manager.close('bad');
  });

  it('saves open sessions on shutdown and refuses new work afterwards', async () => {
    const local = fakeSecrets();
    const m = createBrowserManager({ config: { browserHeadless: true } as AppConfig, log: pino({ level: 'silent' }), secrets: local.repo });
    const page = await m.page('s1', `${origin}/set`);
    await page.waitForFunction('window.done === true');
    await m.shutdown();
    expect(await m.hasSavedSession('s1')).toBe(true);
    await expect(m.page('s1')).rejects.toThrow('shut down');
  });
});
