// Public IP discovery and IP classification (which addresses Let's Encrypt can validate).

import net from 'node:net';
import os from 'node:os';
import type { Logger } from 'pino';

/** Tried in order; each returns the caller's address as plain text. */
export const PUBLIC_IP_SOURCES: readonly string[] = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];

export type IpClass = 'public' | 'private' | 'cgnat' | 'loopback' | 'link-local' | 'ula' | 'reserved' | 'invalid';

type Range = [address: string, prefix: number, type: 'ipv4' | 'ipv6'];

const RANGES: [Exclude<IpClass, 'public' | 'invalid'>, Range[]][] = [
  ['private', [['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4']]],
  ['cgnat', [['100.64.0.0', 10, 'ipv4']]],
  ['loopback', [['127.0.0.0', 8, 'ipv4'], ['::1', 128, 'ipv6']]],
  ['link-local', [['169.254.0.0', 16, 'ipv4'], ['fe80::', 10, 'ipv6']]],
  ['ula', [['fc00::', 7, 'ipv6']]],
  [
    'reserved',
    [
      ['0.0.0.0', 8, 'ipv4'],
      ['192.0.0.0', 24, 'ipv4'],
      ['192.0.2.0', 24, 'ipv4'], // TEST-NET-1
      ['198.18.0.0', 15, 'ipv4'], // benchmarking
      ['198.51.100.0', 24, 'ipv4'], // TEST-NET-2
      ['203.0.113.0', 24, 'ipv4'], // TEST-NET-3
      ['224.0.0.0', 4, 'ipv4'], // multicast
      ['240.0.0.0', 4, 'ipv4'], // reserved + broadcast
      ['::', 128, 'ipv6'],
      ['ff00::', 8, 'ipv6'], // multicast
      ['2001:db8::', 32, 'ipv6'], // documentation
      ['64:ff9b::', 96, 'ipv6'], // NAT64
      ['100::', 64, 'ipv6'], // discard
    ],
  ],
];

const LISTS: [IpClass, net.BlockList][] = RANGES.map(([cls, ranges]) => {
  const list = new net.BlockList();
  for (const [address, prefix, type] of ranges) list.addSubnet(address, prefix, type);
  return [cls, list];
});

/** Only 2000::/3 is globally routable unicast IPv6. */
const GLOBAL_V6 = new net.BlockList();
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');

/** Canonical text form (IPv6 compressed + lowercase), or null when not an IP. */
export function normalizeIp(value: string): string | null {
  const ip = value.trim().replace(/^\[(.*)\]$/, '$1');
  const v = net.isIP(ip);
  if (v === 4) return ip;
  if (v === 6) {
    try {
      return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    } catch {
      return null;
    }
  }
  return null;
}

/** IPv4 behind an IPv4-mapped IPv6 address (::ffff:a.b.c.d, or ::ffff:XXXX:XXXX once canonicalized). */
function unmapIpv4(ip: string): string | null {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (dotted) return dotted;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (!hex?.[1] || !hex[2]) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** Canonical address (IPv4-mapped IPv6 unwrapped to IPv4) and its family, or null when not an IP. */
export function canonicalIp(value: string): { ip: string; type: 'ipv4' | 'ipv6' } | null {
  let ip = normalizeIp(value);
  if (!ip) return null;
  ip = unmapIpv4(ip) ?? ip;
  return { ip, type: net.isIPv6(ip) ? 'ipv6' : 'ipv4' };
}

export function classifyIp(value: string): IpClass {
  const canonical = canonicalIp(value);
  if (!canonical) return 'invalid';
  const { ip, type } = canonical;
  for (const [cls, list] of LISTS) if (list.check(ip, type)) return cls;
  if (type === 'ipv6' && !GLOBAL_V6.check(ip, 'ipv6')) return 'reserved';
  return 'public';
}

export function isPublicIp(ip: string): boolean {
  return classifyIp(ip) === 'public';
}

export function describeIpClass(cls: IpClass): string {
  switch (cls) {
    case 'public':
      return 'public';
    case 'private':
      return 'private (LAN)';
    case 'cgnat':
      return 'carrier-grade NAT (CGNAT)';
    case 'loopback':
      return 'loopback';
    case 'link-local':
      return 'link-local';
    case 'ula':
      return 'IPv6 unique-local (ULA)';
    case 'reserved':
      return 'reserved / non-routable';
    case 'invalid':
      return 'invalid';
  }
}

export interface DiscoverOptions {
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  sources?: readonly string[];
  timeoutMs?: number;
  log?: Pick<Logger, 'debug'>;
}

/** Ask public "what is my IP" services in order. Returns null when none answers with a valid IP. */
export async function discoverPublicIp(opts: DiscoverOptions = {}): Promise<string | null> {
  const { signal, fetchFn = fetch, sources = PUBLIC_IP_SOURCES, timeoutMs = 5_000, log } = opts;
  for (const url of sources) {
    if (signal?.aborted) return null;
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetchFn(url, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { accept: 'text/plain' },
        redirect: 'error',
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        log?.debug({ source: url, status: res.status }, 'public IP lookup failed');
        continue;
      }
      const text = (await res.text()).trim();
      const ip = text.length <= 64 ? normalizeIp(text) : null;
      if (ip) return ip;
      log?.debug({ source: url }, 'public IP lookup returned an invalid answer');
    } catch (err) {
      log?.debug({ source: url, err: (err as Error).message }, 'public IP lookup failed');
    }
  }
  return null;
}

/** Non-internal IPv4 addresses of this machine (LAN addresses for the self-signed certificate). */
export function localIPv4Addresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const list of Object.values(ifaces)) {
    for (const addr of list ?? []) {
      if (addr.family === 'IPv4' && !addr.internal && net.isIPv4(addr.address)) out.add(addr.address);
    }
  }
  return [...out];
}
