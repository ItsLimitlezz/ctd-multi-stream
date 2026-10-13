// Shared request validation for the config API routes (platforms, accounts, destinations, settings).

import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FEEDS, PLATFORM_IDS, type FieldSpec, type PlatformId } from '../../../shared/types.js';
import type { PlatformDriver } from '../platforms/types.js';
import type { AppServices } from '../services.js';
import { sendError } from './guards.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** An error with an HTTP status and a machine-readable code (see installErrorHandler). */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code: string = statusCode === 404 ? 'not_found' : 'invalid',
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, code = 'invalid'): HttpError => new HttpError(400, message, code);
export const notFound = (what: string): HttpError => new HttpError(404, `${what} not found`, 'not_found');

/**
 * Scoped error handler for a route plugin: HttpError -> ApiError with its code. Anything else
 * (ZodError, DriverError, crashes) is rethrown to the app-level handler in app.ts.
 */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return sendError(reply, err.statusCode, err.message, err.code);
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Common schemas
// ---------------------------------------------------------------------------

export const platformIdSchema = z.enum(PLATFORM_IDS);
export const feedSchema = z.enum(FEEDS);
export const idParams = z.object({ id: z.string().min(1).max(128) });
export const platformParams = z.object({ platform: platformIdSchema });
/** Free-form option values; checked against the platform's FieldSpecs by normalizeFields(). */
export const optionsSchema = z.record(z.string().max(100), z.unknown());

export const MAX_NAME = 100;
export const MAX_URL = 2048;
const MAX_TEXT = 2048;

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

/** Registry lookup that returns null instead of throwing for unregistered platforms. */
export function findDriver(services: AppServices, id: PlatformId): PlatformDriver | null {
  return services.platforms.all().find((d) => d.info.id === id) ?? null;
}

export function requireDriver(services: AppServices, id: PlatformId): PlatformDriver {
  const driver = findDriver(services, id);
  if (!driver) throw badRequest(`Unknown platform: ${id}`);
  return driver;
}

// ---------------------------------------------------------------------------
// Generic form fields (FieldSpec)
// ---------------------------------------------------------------------------

function fieldError(field: FieldSpec, problem: string): HttpError {
  return badRequest(`${field.label} ${problem}`);
}

export function isUrlWithProtocol(value: string, protocols: readonly string[]): boolean {
  try {
    const u = new URL(value);
    return protocols.includes(u.protocol) && u.hostname !== '';
  } catch {
    return false;
  }
}

/**
 * Coerce one submitted value to its field type. Returns undefined for "no value"
 * (undefined, null, empty string). Throws HttpError(400) when the value is invalid.
 */
export function coerceField(field: FieldSpec, value: unknown): string | number | boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;

  switch (field.type) {
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === '1' || value === 1) return true;
      if (value === 'false' || value === '0' || value === 0) return false;
      throw fieldError(field, 'must be true or false');
    case 'number': {
      const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
      if (!Number.isFinite(n)) throw fieldError(field, 'must be a number');
      return n;
    }
    default: {
      if (typeof value !== 'string' && typeof value !== 'number') throw fieldError(field, 'must be text');
      const s = String(value).trim();
      if (s.length > MAX_TEXT) throw fieldError(field, `must be at most ${MAX_TEXT} characters`);
      if (field.type === 'select' && !field.options?.some((o) => o.value === s)) {
        throw fieldError(field, 'is not a valid choice');
      }
      if (field.type === 'url' && !isUrlWithProtocol(s, ['http:', 'https:', 'rtmp:', 'rtmps:'])) {
        throw fieldError(field, 'must be a valid URL');
      }
      return s;
    }
  }
}

/**
 * Validate option values against field specs: unknown keys are rejected, values are coerced by
 * type, `null`/'' removes a value, defaults fill gaps and required fields are enforced.
 * `base` holds the current values when patching (submitted keys override it).
 */
export function normalizeFields(
  fields: readonly FieldSpec[],
  input: Record<string, unknown> | null | undefined,
  base: Record<string, unknown> = {},
): Record<string, unknown> {
  const known = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(input ?? {})) {
    if (!known.has(key)) throw badRequest(`Unknown option: ${key}`);
  }
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = input && Object.hasOwn(input, field.key) ? input[field.key] : base[field.key];
    const value = coerceField(field, raw) ?? field.default;
    if (value === undefined) {
      if (field.required) throw fieldError(field, 'is required');
      continue;
    }
    out[field.key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

/** RTMP(S) server URL entered by the user. Returns the trimmed URL. */
export function parseIngestUrl(value: string): string {
  const s = value.trim();
  if (s.length > MAX_URL) throw badRequest(`Server URL must be at most ${MAX_URL} characters`);
  if (/\s/.test(s) || !isUrlWithProtocol(s, ['rtmp:', 'rtmps:'])) {
    throw badRequest('Server URL must be an rtmp:// or rtmps:// URL');
  }
  return s;
}

/** Stream key pasted by the user. Returns the trimmed key ('' = none). */
export function parseStreamKey(value: string): string {
  const s = value.trim();
  if (s.length > MAX_URL) throw badRequest(`Stream key must be at most ${MAX_URL} characters`);
  if (/[\s\u0000-\u001f\u007f]/.test(s)) throw badRequest('Stream key must not contain spaces or control characters');
  return s;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** '' or an http(s) base URL without credentials/query/fragment; trailing slashes removed. */
export function normalizePublicBaseUrl(value: string): string {
  const s = value.trim();
  if (!s) return '';
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw badRequest('Public base URL must be a full URL, e.g. https://203.0.113.7');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw badRequest('Public base URL must start with http:// or https://');
  if (u.username || u.password) throw badRequest('Public base URL must not contain a username or password');
  if (u.search || u.hash) throw badRequest('Public base URL must not contain a query string or fragment');
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME_RE = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})*$`);

/** '' or a bare hostname / IPv4 / IPv6 (brackets accepted and removed). No scheme, no port. */
export function normalizeIngestHost(value: string): string {
  let s = value.trim();
  if (!s) return '';
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (isIP(s) !== 0) return s.toLowerCase();
  const host = s.toLowerCase().replace(/\.$/, '');
  const tld = host.split('.').at(-1) ?? '';
  // An all-numeric last label is never a hostname (e.g. 999.1.1.1 is a bad IPv4, not a name).
  if (host.length <= 253 && HOSTNAME_RE.test(host) && !/^\d+$/.test(tld)) return host;
  throw badRequest('Ingest host must be a hostname or IP address without scheme or port, e.g. 192.168.1.20');
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Truncate a user-visible message (code points). */
export function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('')}…`;
}
