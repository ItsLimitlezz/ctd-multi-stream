// Pure decision logic for MediaMTX HTTP auth requests.
// Request fields (v1.21.2): user, password, token, ip, action, path, protocol, id, query, userAgent.
// For RTMP, MediaMTX takes user/password from the URL query (?user=..&pass=..) and passes the raw
// query string as `query`. https://github.com/bluenviron/mediamtx/blob/v1.21.2/docs/2-features/06-authentication.md

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Feed } from '../../../shared/types.js';
import type { MediaMtxAuthRequest } from '../services.js';
import { INTERNAL_READER_USER, parseFeedPath, type IngestRoute } from './paths.js';

/** One profile's publish keys (OBS stream keys), one per feed. */
export type ProfileIngestKeys = Record<Feed, string>;

/** The default profile's secrets in scope 'ingest': its publish keys + the internal reader password. */
export type IngestSecrets = Record<Feed | 'internalReader', string>;

/** Secret names of a profile's publish keys. The default profile's scope also holds 'internalReader'. */
export const FEED_KEY_NAMES = ['landscape', 'vertical'] as const satisfies readonly Feed[];
export const INTERNAL_READER_KEY = 'internalReader';
export const INGEST_SECRET_NAMES = [...FEED_KEY_NAMES, INTERNAL_READER_KEY] as const satisfies readonly (keyof IngestSecrets)[];

/** What the auth decision needs: the reader password and a lookup of publish keys by path. */
export interface IngestAuthState {
  /** Internal reader password; null = not loaded yet (deny everything). */
  readerPassword: string | null;
  /** The publish key for a path (default profile when slug is null); null = unknown profile. */
  publishKey(route: IngestRoute): string | null;
}

/** 24-char URL-safe random key (144 bits). */
export function generateKey(): string {
  return randomBytes(18).toString('base64url');
}

/** Keys must be URL-safe (they go into RTMP URLs unencoded) and reasonably long. */
export function isValidKey(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

/** Constant-time string comparison (hashing first hides the length). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** 127.0.0.0/8, ::1 and IPv4-mapped loopback. */
export function isLoopbackIp(ip: string): boolean {
  let addr = ip.trim();
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  const zone = addr.indexOf('%');
  if (zone >= 0) addr = addr.slice(0, zone);
  const lower = addr.toLowerCase();
  if (lower.startsWith('::ffff:')) addr = addr.slice(7);
  if (isIP(addr) === 4) return addr.startsWith('127.');
  if (isIP(addr) === 6) return lower === '::1' || lower === '0:0:0:0:0:0:0:1';
  return false;
}

/** Value of one query parameter from MediaMTX's raw `query` (may start with '?'). */
export function queryParam(query: string, name: string): string | null {
  const raw = query.startsWith('?') ? query.slice(1) : query;
  try {
    return new URLSearchParams(raw).get(name);
  } catch {
    return null;
  }
}

/** Auth state for the default profile alone (pre-profiles behaviour; handy in tests). */
export function singleProfileAuth(keys: IngestSecrets | null): IngestAuthState | null {
  if (!keys) return null;
  return {
    readerPassword: keys.internalReader,
    publishKey: (route) => (route.slug === null ? keys[route.feed] : null),
  };
}

/**
 * - publish: only to a known profile's feed path (`live/<feed>` for the default profile,
 *   `live/<slug>/<feed>` for the others) with `?key=` equal to that profile's key for that feed
 *   (any source IP — OBS is on the LAN). A key never works on another profile's path.
 * - read: only a known profile's feed paths, only from loopback, as user 'internal' with the internal
 *   reader password (shared by every profile; FFmpeg is the only reader).
 * - everything else (playback, api, metrics, pprof, unknown): deny.
 */
export function authorizeMediaRequest(req: MediaMtxAuthRequest, auth: IngestAuthState | null): boolean {
  if (!auth) return false;
  const route = parseFeedPath(req.path ?? '');
  if (!route) return false;

  switch (req.action) {
    case 'publish': {
      const expected = auth.publishKey(route);
      if (!expected) return false;
      const key = queryParam(req.query ?? '', 'key');
      return key !== null && key.length > 0 && safeEqual(key, expected);
    }
    case 'read': {
      const reader = auth.readerPassword;
      return (
        reader !== null &&
        reader.length > 0 &&
        auth.publishKey(route) !== null && // a known profile
        isLoopbackIp(req.ip ?? '') &&
        req.user === INTERNAL_READER_USER &&
        typeof req.password === 'string' &&
        req.password.length > 0 &&
        safeEqual(req.password, reader)
      );
    }
    default:
      return false;
  }
}
