import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import type { SecretsRepo } from '../services.js';
import { createBrowserManager } from './browser-manager.js';
import { nonPublicHostReason, type HostLookup } from './egress.js';

const lookupTable =
  (table: Record<string, string[]>): HostLookup =>
  async (host) => {
    const addresses = table[host];
    if (!addresses) throw new Error('ENOTFOUND');
    return addresses;
  };

const check = (url: string, lookup: HostLookup = lookupTable({})) => nonPublicHostReason(new URL(url), { lookup });

describe('nonPublicHostReason', () => {
  it('refuses loopback, LAN, link-local, CGNAT, ULA and unspecified IP literals', async () => {
    for (const url of [
      'http://127.0.0.1:9997/v3/config/global/get',
      'http://[::1]/',
      'http://192.168.1.1/',
      'http://10.0.0.5/',
      'http://172.16.3.4/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://[fd00::1]/',
      'http://0.0.0.0/',
      'http://[::ffff:127.0.0.1]/', // IPv4-mapped IPv6
      'http://2130706433/', // decimal 127.0.0.1 (normalized by the URL parser)
      'http://0x7f.1/',
      'http://0177.0.0.1/', // octal
    ]) {
      expect(await check(url), url).toMatch(/can't be opened in the browser view/);
    }
    expect(await check('http://192.168.1.1/')).toContain('private (LAN)');
  });

  it('refuses localhost names and names that resolve to private addresses', async () => {
    expect(await check('http://localhost:8443/')).toContain('localhost');
    expect(await check('http://app.localhost/')).toContain('localhost');
    const lookup = lookupTable({ 'truenas.lan': ['192.168.1.20'], 'mixed.example': ['93.184.216.34', '10.1.1.1'] });
    expect(await check('https://truenas.lan/', lookup)).toContain('private (LAN)');
    expect(await check('https://mixed.example/', lookup)).toContain('private (LAN)');
  });

  it('allows public hosts and names that do not resolve', async () => {
    const lookup = lookupTable({ 'www.instagram.com': ['157.240.1.174', '2a03:2880:f12f:83:face:b00c:0:25de'] });
    expect(await check('https://www.instagram.com/accounts/login/', lookup)).toBeNull();
    expect(await check('https://8.8.8.8/')).toBeNull();
    expect(await check('https://nope.invalid/')).toBeNull();
  });

  it('can be disabled (test fixtures on 127.0.0.1)', async () => {
    expect(await nonPublicHostReason(new URL('http://127.0.0.1/'), { allowPrivateNetwork: true })).toBeNull();
  });

  it('is exposed by the browser manager, on by default', async () => {
    const deps = { config: { browserHeadless: true } as AppConfig, log: pino({ level: 'silent' }), secrets: {} as SecretsRepo };
    const strict = createBrowserManager(deps);
    expect(await strict.checkViewerUrl?.(new URL('http://127.0.0.1:9997/'))).toMatch(/loopback/);
    const relaxed = createBrowserManager({ ...deps, allowPrivateNetwork: true });
    expect(await relaxed.checkViewerUrl?.(new URL('http://127.0.0.1:9997/'))).toBeNull();
  });
});
