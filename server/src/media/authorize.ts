// Pure decision logic for MediaMTX HTTP auth requests.
// Request fields (v1.21.2): user, password, token, ip, action, path, protocol, id, query, userAgent.
// For RTMP, MediaMTX takes user/password from the URL query (?user=..&pass=..) and passes the raw
// query string as `query`. https://github.com/bluenviron/mediamtx/blob/v1.21.2/docs/2-features/06-authentication.md

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Feed } from '../../../shared/types.js';
import type { MediaMtxAuthRequest } from '../services.js';
import { feedForPath, INTERNAL_READER_USER } from './paths.js';

/** Secrets the ingest needs: one publish key per feed + the internal reader password. */
export type IngestSecrets = Record<Feed | 'internalReader', string>;

export const INGEST_SECRET_NAMES = ['landscape', 'vertical', 'internalReader'] as const satisfies readonly (keyof IngestSecrets)[];

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

/**
 * - publish: only to live/<feed>, with `?key=` equal to that feed's key (any source IP — OBS is on the LAN).
 * - read: only live/<feed>, only from loopback, as user 'internal' with the internal reader password.
 * - everything else (playback, api, metrics, pprof, unknown): deny.
 */
export function authorizeMediaRequest(req: MediaMtxAuthRequest, keys: IngestSecrets | null): boolean {
  if (!keys) return false;
  const feed = feedForPath(req.path ?? '');
  if (!feed) return false;

  switch (req.action) {
    case 'publish': {
      const key = queryParam(req.query ?? '', 'key');
      return key !== null && key.length > 0 && safeEqual(key, keys[feed]);
    }
    case 'read':
      return (
        isLoopbackIp(req.ip ?? '') &&
        req.user === INTERNAL_READER_USER &&
        typeof req.password === 'string' &&
        req.password.length > 0 &&
        safeEqual(req.password, keys.internalReader)
      );
    default:
      return false;
  }
}
