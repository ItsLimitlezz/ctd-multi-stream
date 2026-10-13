import { describe, expect, it } from 'vitest';
import type { FieldSpec } from '../../../shared/types.js';
import { accountIdFromState, sameSiteBouncePage } from './oauth-state.js';
import {
  coerceField,
  HttpError,
  normalizeFields,
  normalizeIngestHost,
  normalizePublicBaseUrl,
  parseIngestUrl,
  parseStreamKey,
} from './validation.js';

const select: FieldSpec = {
  key: 'mode',
  label: 'Mode',
  type: 'select',
  options: [
    { value: 'page', label: 'Page' },
    { value: 'profile', label: 'Profile' },
  ],
  default: 'page',
};
const num: FieldSpec = { key: 'bitrate', label: 'Bitrate', type: 'number' };
const bool: FieldSpec = { key: 'lowLatency', label: 'Low latency', type: 'boolean' };
const text: FieldSpec = { key: 'note', label: 'Note', type: 'text', required: true };
const url: FieldSpec = { key: 'site', label: 'Site', type: 'url' };

function expectHttp400(fn: () => unknown, message?: RegExp): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(400);
    if (message) expect((err as HttpError).message).toMatch(message);
    return;
  }
  throw new Error('expected an HttpError');
}

describe('coerceField', () => {
  it('coerces by type', () => {
    expect(coerceField(num, '4500')).toBe(4500);
    expect(coerceField(num, 12.5)).toBe(12.5);
    expect(coerceField(bool, 'true')).toBe(true);
    expect(coerceField(bool, 0)).toBe(false);
    expect(coerceField(text, '  hi  ')).toBe('hi');
    expect(coerceField(text, 42)).toBe('42');
    expect(coerceField(select, 'profile')).toBe('profile');
    expect(coerceField(url, 'https://example.com/x')).toBe('https://example.com/x');
  });

  it('treats null, undefined and blank as no value', () => {
    expect(coerceField(text, null)).toBeUndefined();
    expect(coerceField(text, undefined)).toBeUndefined();
    expect(coerceField(num, '  ')).toBeUndefined();
  });

  it('rejects invalid values', () => {
    expectHttp400(() => coerceField(num, 'abc'), /Bitrate must be a number/);
    expectHttp400(() => coerceField(num, Infinity));
    expectHttp400(() => coerceField(bool, 'maybe'));
    expectHttp400(() => coerceField(select, 'group'), /not a valid choice/);
    expectHttp400(() => coerceField(text, { a: 1 }));
    expectHttp400(() => coerceField(url, 'not a url'));
    expectHttp400(() => coerceField(url, 'javascript:alert(1)'));
  });
});

describe('normalizeFields', () => {
  const fields = [select, num, bool, text];

  it('applies defaults and drops empty optional values', () => {
    expect(normalizeFields(fields, { note: 'x', bitrate: '' })).toEqual({ mode: 'page', note: 'x' });
  });

  it('rejects unknown keys and missing required fields', () => {
    expectHttp400(() => normalizeFields(fields, { note: 'x', extra: 1 }), /Unknown option: extra/);
    expectHttp400(() => normalizeFields(fields, {}), /Note is required/);
  });

  it('merges over base values; null removes a value', () => {
    const base = { mode: 'profile', note: 'old', bitrate: 3000, stale: 'gone' };
    expect(normalizeFields(fields, { bitrate: null, lowLatency: true }, base)).toEqual({
      mode: 'profile',
      note: 'old',
      lowLatency: true,
    });
  });
});

describe('destination values', () => {
  it('parses ingest URLs', () => {
    expect(parseIngestUrl(' rtmps://live.example.com:443/app ')).toBe('rtmps://live.example.com:443/app');
    expect(parseIngestUrl('rtmp://192.168.1.2/live')).toBe('rtmp://192.168.1.2/live');
    expectHttp400(() => parseIngestUrl('http://example.com/app'));
    expectHttp400(() => parseIngestUrl('rtmp://'));
    expectHttp400(() => parseIngestUrl('rtmp://host/a b'));
    expectHttp400(() => parseIngestUrl(`rtmp://host/${'a'.repeat(2048)}`));
  });

  it('parses stream keys', () => {
    expect(parseStreamKey('  live_123?bw=1  ')).toBe('live_123?bw=1');
    expect(parseStreamKey('   ')).toBe('');
    expectHttp400(() => parseStreamKey('two words'));
    expectHttp400(() => parseStreamKey('a\u0000b'));
  });
});

describe('settings values', () => {
  it('normalizes the public base URL', () => {
    expect(normalizePublicBaseUrl('')).toBe('');
    expect(normalizePublicBaseUrl(' https://Example.com/ ')).toBe('https://example.com');
    expect(normalizePublicBaseUrl('https://example.com:8443/ctd//')).toBe('https://example.com:8443/ctd');
    expect(normalizePublicBaseUrl('http://[2001:db8::1]:8443')).toBe('http://[2001:db8::1]:8443');
    expectHttp400(() => normalizePublicBaseUrl('ftp://example.com'));
    expectHttp400(() => normalizePublicBaseUrl('example.com'));
    expectHttp400(() => normalizePublicBaseUrl('https://user:pw@example.com'));
    expectHttp400(() => normalizePublicBaseUrl('https://example.com/?a=1'));
  });

  it('normalizes the ingest host', () => {
    expect(normalizeIngestHost('')).toBe('');
    expect(normalizeIngestHost(' 192.168.1.20 ')).toBe('192.168.1.20');
    expect(normalizeIngestHost('My-NAS.lan.')).toBe('my-nas.lan');
    expect(normalizeIngestHost('[2001:DB8::1]')).toBe('2001:db8::1');
    expect(normalizeIngestHost('::1')).toBe('::1');
    expectHttp400(() => normalizeIngestHost('rtmp://nas'));
    expectHttp400(() => normalizeIngestHost('nas:1935'));
    expectHttp400(() => normalizeIngestHost('999.1.1.1'));
    expectHttp400(() => normalizeIngestHost('bad_host'));
    expectHttp400(() => normalizeIngestHost('-nas'));
  });
});

describe('oauth state', () => {
  it('extracts the account id', () => {
    expect(accountIdFromState('acc-1.abcDEF_-')).toBe('acc-1');
    expect(accountIdFromState('a.b.c')).toBe('a.b');
    expect(accountIdFromState('noseparator')).toBeNull();
    expect(accountIdFromState('.x')).toBeNull();
    expect(accountIdFromState('x.')).toBeNull();
    expect(accountIdFromState(null)).toBeNull();
    expect(accountIdFromState(`${'a'.repeat(600)}.x`)).toBeNull();
  });

  it('escapes the bounce target', () => {
    const html = sameSiteBouncePage(`/oauth/callback/kick?code=a"><script>&state=x'y`);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&#34;&#62;&#60;script&#62;&#38;state=x&#39;y');
    expect(html).toContain('http-equiv="refresh"');
  });
});
