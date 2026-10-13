import { describe, expect, it } from 'vitest';
import { classifyIp, discoverPublicIp, isPublicIp, localIPv4Addresses, normalizeIp } from './public-ip.js';

describe('classifyIp', () => {
  it.each([
    ['93.184.216.34', 'public'],
    ['8.8.8.8', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.20', 'private'],
    ['100.64.0.1', 'cgnat'],
    ['100.127.255.254', 'cgnat'],
    ['127.0.0.1', 'loopback'],
    ['::1', 'loopback'],
    ['169.254.10.10', 'link-local'],
    ['fe80::1', 'link-local'],
    ['fd12:3456::1', 'ula'],
    ['fc00::1', 'ula'],
    ['0.0.0.0', 'reserved'],
    ['203.0.113.5', 'reserved'],
    ['224.0.0.1', 'reserved'],
    ['2001:db8::1', 'reserved'],
    ['::', 'reserved'],
    ['::ffff:192.168.1.1', 'private'],
    ['::ffff:8.8.8.8', 'public'],
    ['not-an-ip', 'invalid'],
    ['', 'invalid'],
  ])('%s -> %s', (ip, cls) => {
    expect(classifyIp(ip)).toBe(cls);
  });

  it('edges of the private/CGNAT ranges are public', () => {
    expect(isPublicIp('172.32.0.1')).toBe(true);
    expect(isPublicIp('100.128.0.1')).toBe(true);
    expect(isPublicIp('11.0.0.1')).toBe(true);
  });
});

describe('normalizeIp', () => {
  it('canonicalizes IPv6 and strips brackets', () => {
    expect(normalizeIp('2001:DB8:0:0:0:0:0:10')).toBe('2001:db8::10');
    expect(normalizeIp('[::1]')).toBe('::1');
    expect(normalizeIp(' 1.2.3.4\n')).toBe('1.2.3.4');
    expect(normalizeIp('1.2.3')).toBeNull();
  });
});

describe('discoverPublicIp', () => {
  const sources = ['https://a.test', 'https://b.test', 'https://c.test'];

  it('falls through failing sources and validates the answer', async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      const u = String(url);
      seen.push(u);
      if (u === 'https://a.test') return new Response('oops', { status: 503 });
      if (u === 'https://b.test') return new Response('<html>not an ip</html>');
      return new Response('93.184.216.34\n');
    }) as typeof fetch;
    await expect(discoverPublicIp({ fetchFn, sources })).resolves.toBe('93.184.216.34');
    expect(seen).toEqual(sources);
  });

  it('returns null when every source fails, including timeouts', async () => {
    const fetchFn = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    await expect(discoverPublicIp({ fetchFn, sources, timeoutMs: 20 })).resolves.toBeNull();
  });

  it('stops when the caller aborts', async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response('1.1.1.1');
    }) as typeof fetch;
    await expect(discoverPublicIp({ fetchFn, sources, signal: ac.signal })).resolves.toBeNull();
    expect(calls).toBe(0);
  });
});

describe('localIPv4Addresses', () => {
  it('returns non-internal IPv4 addresses only', () => {
    const base = { netmask: '', mac: '00:00:00:00:00:00', cidr: null };
    const ips = localIPv4Addresses({
      lo: [{ ...base, address: '127.0.0.1', family: 'IPv4', internal: true }],
      eth0: [
        { ...base, address: '192.168.1.20', family: 'IPv4', internal: false },
        { ...base, address: 'fe80::1', family: 'IPv6', internal: false, scopeid: 1 },
      ],
      eth1: [{ ...base, address: '192.168.1.20', family: 'IPv4', internal: false }],
    });
    expect(ips).toEqual(['192.168.1.20']);
  });
});
