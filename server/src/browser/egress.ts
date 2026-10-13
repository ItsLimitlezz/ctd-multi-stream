// Host policy for the login viewer: the admin-driven browser must not be usable to browse the
// server's own loopback services (MediaMTX API, media auth, the app) or the home LAN.
//
// Limits (by design, this is an up-front check, not a network filter): Chromium resolves names
// again on its own, so DNS rebinding and in-page subrequests/WebSockets are not covered. The
// viewer additionally checks every main-frame navigation it shows (catches redirects) and leaves
// a page that lands on a non-public host. A real egress filter would need a pinning proxy.

import dns from 'node:dns/promises';
import { classifyIp, describeIpClass, type IpClass } from '../tls/public-ip.js';
import { withTimeout } from './helpers.js';

export type HostLookup = (hostname: string) => Promise<string[]>;

export interface HostPolicyOptions {
  /** Skip the check entirely (tests that serve fixtures from 127.0.0.1). */
  allowPrivateNetwork?: boolean;
  /** Name resolution (default: dns.lookup with all addresses). */
  lookup?: HostLookup;
}

const LOOKUP_TIMEOUT_MS = 5_000;

const defaultLookup: HostLookup = async (hostname) => (await dns.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

function refusal(cls: IpClass | 'localhost'): string {
  const what = cls === 'localhost' ? 'this server (localhost)' : `a ${describeIpClass(cls)} address`;
  return `This address points to ${what} and can't be opened in the browser view`;
}

/**
 * Why `url` must not be opened by the viewer, or null when its host is public. IP literals are
 * classified directly (the WHATWG parser already normalized decimal/octal/hex IPv4 and IPv6
 * forms); names are resolved once and refused when any address is non-public. A name that
 * doesn't resolve is allowed (Chromium will fail to load it anyway).
 */
export async function nonPublicHostReason(url: URL, opts: HostPolicyOptions = {}): Promise<string | null> {
  if (opts.allowPrivateNetwork) return null;
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (!host) return null;
  if (host === 'localhost' || host.endsWith('.localhost')) return refusal('localhost');

  const literal = classifyIp(host);
  if (literal !== 'invalid') return literal === 'public' ? null : refusal(literal);

  let addresses: string[];
  try {
    addresses = await withTimeout((opts.lookup ?? defaultLookup)(host), LOOKUP_TIMEOUT_MS, 'DNS lookup timed out');
  } catch {
    return null;
  }
  for (const address of addresses) {
    const cls = classifyIp(address);
    if (cls !== 'public' && cls !== 'invalid') return refusal(cls);
  }
  return null;
}
