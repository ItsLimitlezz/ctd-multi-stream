// How other apps reach /api/v1 (Settings → API): public base URL, LAN URL, certificate pin.

import { localIPv4Addresses, classifyIp, normalizeIp } from '../tls/public-ip.js';
import type { ApiAccessInfo } from '../../../shared/api.js';
import type { TlsMode } from '../../../shared/types.js';

/** Settings key / env var overriding the LAN HTTP port (when the container port is mapped). */
export const LAN_HTTP_PORT_SETTING = 'api.lanHttpPort';
export const LAN_HTTP_PORT_ENV = 'LAN_HTTP_PORT';
/** Env var naming the address LAN apps use to reach this server (e.g. the NAS IP), when it can't be guessed. */
export const LAN_HTTP_HOST_ENV = 'LAN_HTTP_HOST';

export interface LanUrlInput {
  /** Host header of the admin's request (e.g. "192.168.1.20:30443"). */
  hostHeader: string | undefined;
  /** Whether the admin's request came in over TLS. */
  secure: boolean;
  tlsMode: TlsMode;
  webPort: number;
  httpPort: number;
  /** LAN_HTTP_PORT env / api.lanHttpPort setting, when set. */
  lanHttpPortOverride: number | null;
  /** LAN_HTTP_HOST env, when set (an IP or a host name). */
  lanHttpHostOverride?: string | null;
  /** Whether LAN clients get plain HTTP at all (LAN_HTTP / LAN_HTTP_CIDRS); default true. */
  lanHttpEnabled?: boolean;
  /** Running in a container: this machine's addresses are the container's, not the LAN's. */
  inContainer?: boolean;
  /** This machine's IPv4 addresses (inside Docker: the container's). */
  localAddresses: string[];
}

const NAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** Suffixes of names that only resolve on the local network. */
const LOCAL_SUFFIXES = ['.local', '.lan', '.home', '.home.arpa', '.internal', '.localdomain', '.intranet'];

/** A validated IP literal (canonical) or lower-case host name, or null. */
function hostValue(value: string | null | undefined): { kind: 'ip' | 'name'; host: string } | null {
  const raw = (value ?? '').trim().replace(/^\[(.*)\]$/, '$1');
  if (!raw) return null;
  const ip = normalizeIp(raw);
  if (ip) return { kind: 'ip', host: ip };
  const name = raw.toLowerCase().replace(/\.$/, '');
  return NAME_RE.test(name) ? { kind: 'name', host: name } : null;
}

/** A host name that only makes sense on the LAN (single label, .local, .lan…), never localhost. */
export function isLocalHostName(name: string): boolean {
  if (name === 'localhost' || name.endsWith('.localhost')) return false;
  return !name.includes('.') || LOCAL_SUFFIXES.some((s) => name.endsWith(s));
}

function validPort(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 65535;
}

/** Split a Host header into an IP literal (or null for names) and the port (or null when absent). */
export function parseHost(hostHeader: string | undefined): { ip: string | null; port: number | null } {
  const value = (hostHeader ?? '').trim();
  const m = /^(\[[0-9A-Fa-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(value);
  if (!m?.[1]) return { ip: null, port: null };
  const port = m[2] ? Number(m[2]) : null;
  return { ip: normalizeIp(m[1]), port: validPort(port) ? port : null };
}

function hostForUrl(ip: string): string {
  return ip.includes(':') ? `[${ip}]` : ip;
}

/**
 * LAN base URL of the API, or null when the LAN address can't be known.
 *
 * Host: LAN_HTTP_HOST when set; else the host the admin used, when it is a private (LAN) IP or a
 * LAN-only name (nas.local, truenas.lan, a single label); else, outside a container, the first
 * private IPv4 of this machine. Inside a container its own address is not the NAS address, so
 * there is no guess: null.
 *
 * Port (assumption, documented in docs/API.md): LAN HTTP is HTTP_PORT as seen from the LAN. Docker
 * maps it to another host port (compose 80:8080, TrueNAS 30080:8080). Without an override
 * (LAN_HTTP_PORT env or the api.lanHttpPort setting) we assume HTTP is mapped with the same shift
 * as HTTPS, read from the admin's Host header when it names a LAN address: 443 -> 80,
 * 30443 -> 30080, WEB_PORT -> HTTP_PORT.
 */
export function lanBaseUrl(input: LanUrlInput): string | null {
  const host = parseHost(input.hostHeader);
  const hostIsLan = host.ip !== null && ['private', 'cgnat', 'ula'].includes(classifyIp(host.ip));
  const headerName = host.ip === null ? hostValue((input.hostHeader ?? '').trim().replace(/:\d{1,5}$/, '')) : null;
  const nameIsLan = headerName?.kind === 'name' && isLocalHostName(headerName.host);
  const override = hostValue(input.lanHttpHostOverride);

  let target: string | null;
  if (override) target = override.host;
  else if (hostIsLan) target = host.ip;
  else if (nameIsLan && headerName) target = headerName.host;
  else if (!input.inContainer) target = input.localAddresses.find((a) => classifyIp(a) === 'private') ?? null;
  else target = null;
  if (!target) return null;
  // The port the admin used tells how ports are mapped, when it was a LAN address (not a public one).
  const requestPort = hostIsLan || nameIsLan ? (host.port ?? (input.secure ? 443 : 80)) : null;

  let scheme: 'http' | 'https';
  let port: number;
  if (input.tlsMode === 'off') {
    scheme = 'http';
    port = requestPort ?? input.webPort;
  } else if (input.httpPort > 0 && input.lanHttpEnabled !== false) {
    scheme = 'http';
    if (input.lanHttpPortOverride !== null) port = input.lanHttpPortOverride;
    else if (requestPort === null || requestPort === input.webPort) port = input.httpPort;
    else if (requestPort === 443) port = 80;
    else {
      const shifted = requestPort - (input.webPort - input.httpPort);
      port = validPort(shifted) ? shifted : input.httpPort;
    }
  } else {
    // No plain-HTTP listener (or LAN_HTTP=off): LAN apps use HTTPS (pin the certificate fingerprint).
    scheme = 'https';
    port = requestPort ?? input.webPort;
  }
  const defaultPort = scheme === 'http' ? 80 : 443;
  return `${scheme}://${hostForUrl(target)}${port === defaultPort ? '' : `:${port}`}/api/v1`;
}

export function parsePortOverride(...values: unknown[]): number | null {
  for (const v of values) {
    const n = typeof v === 'string' && /^\d{1,5}$/.test(v.trim()) ? Number(v.trim()) : v;
    if (validPort(n)) return n;
  }
  return null;
}

export function accessInfo(opts: { publicBaseUrl: string; lan: LanUrlInput; fingerprint256: string | null }): ApiAccessInfo {
  const baseUrl = `${opts.publicBaseUrl.replace(/\/+$/, '')}/api/v1`;
  return {
    baseUrl,
    lanBaseUrl: lanBaseUrl(opts.lan),
    tlsFingerprint256: opts.fingerprint256,
    openApiUrl: `${baseUrl}/openapi.json`,
  };
}

export { localIPv4Addresses };
