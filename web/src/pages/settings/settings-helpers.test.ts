import { describe, expect, it } from 'vitest';
import type { AuditEntry, FieldSpec } from '@shared/types';
import {
  appendAudit,
  appFormValues,
  appSubmitValues,
  auditCursor,
  expiryTone,
  fieldForMessage,
  generalChanges,
  generalDraft,
  hasErrors,
  instructionLines,
  overlayUrlWithParams,
  parseWholeNumber,
  relativeTime,
  settingsTab,
  validateGeneral,
  validateNewUser,
  validatePassword,
} from './settings-helpers';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const settings = { publicBaseUrl: '', ingestHost: '', disconnectGraceSec: 15 };

describe('settings helpers', () => {
  it('reads the tab from the query', () => {
    expect(settingsTab('apps')).toBe('apps');
    expect(settingsTab('nope')).toBe('general');
    expect(settingsTab(null)).toBe('general');
  });

  it('splits instructions and drops existing numbering', () => {
    expect(instructionLines('1. Open the console\n\n2) Create an app\n- Copy the ID\nStep 4: Paste it here\nNo prefix')).toEqual([
      'Open the console',
      'Create an app',
      'Copy the ID',
      'Paste it here',
      'No prefix',
    ]);
    expect(instructionLines('')).toEqual([]);
    expect(instructionLines(null)).toEqual([]);
    // A version number is not a list marker.
    expect(instructionLines('2.5 GHz is fine')).toEqual(['2.5 GHz is fine']);
  });

  it('formats relative times', () => {
    expect(relativeTime('2026-10-16T12:00:00Z', NOW)).toBe('in 5 days');
    expect(relativeTime('2026-10-11T09:00:00Z', NOW)).toBe('3 hours ago');
    expect(relativeTime('2026-10-11T12:00:10Z', NOW)).toBe('now');
    expect(relativeTime(null, NOW)).toBe('—');
    expect(relativeTime('garbage', NOW, 'never')).toBe('never');
  });

  it('validates general settings and sends only changes', () => {
    expect(validateGeneral({ publicBaseUrl: 'https://203.0.113.7', ingestHost: '192.168.1.20', disconnectGraceSec: '15' })).toEqual({});
    expect(validateGeneral({ publicBaseUrl: '', ingestHost: 'fe80::1', disconnectGraceSec: '0' })).toEqual({});
    const bad = validateGeneral({ publicBaseUrl: 'ftp://x', ingestHost: 'rtmp://nas:1935', disconnectGraceSec: '601' });
    expect(Object.keys(bad).sort()).toEqual(['disconnectGraceSec', 'ingestHost', 'publicBaseUrl']);
    expect(validateGeneral({ publicBaseUrl: 'https://u:p@x', ingestHost: 'nas.local:1935', disconnectGraceSec: '1.5' })).toEqual({
      publicBaseUrl: expect.any(String),
      ingestHost: expect.stringContaining('port'),
      disconnectGraceSec: expect.any(String),
    });
    const draft = { ...generalDraft(settings), ingestHost: ' 192.168.1.20 ' };
    expect(generalChanges(draft, settings)).toEqual({ ingestHost: '192.168.1.20' });
    expect(generalChanges(generalDraft(settings), settings)).toEqual({});
    expect(generalChanges({ ...generalDraft(settings), disconnectGraceSec: '30' }, settings)).toEqual({ disconnectGraceSec: 30 });
  });

  it('colors certificate expiry', () => {
    expect(expiryTone('2026-10-20T00:00:00Z', NOW)).toBe('success');
    expect(expiryTone('2026-10-12T00:00:00Z', NOW)).toBe('warn');
    expect(expiryTone('2026-10-01T00:00:00Z', NOW)).toBe('danger');
    expect(expiryTone(null, NOW)).toBe('neutral');
  });

  it('maps developer-app values both ways (secrets only when typed)', () => {
    const fields: FieldSpec[] = [
      { key: 'clientId', label: 'Client ID', type: 'text', required: true },
      { key: 'clientSecret', label: 'Client secret', type: 'secret', required: true },
      { key: 'pkce', label: 'Use PKCE', type: 'boolean' },
      { key: 'port', label: 'Port', type: 'number' },
    ];
    expect(appFormValues(fields, { values: { clientId: 'abc', pkce: 'true', port: '8080' } })).toEqual({ clientId: 'abc', pkce: true, port: 8080 });
    expect(appFormValues(fields, { values: {} })).toEqual({ pkce: false });
    expect(appSubmitValues(fields, { clientId: ' abc ', pkce: true, port: 8080 })).toEqual({ clientId: 'abc', pkce: 'true', port: '8080' });
    expect(appSubmitValues(fields, { clientId: '', clientSecret: ' s3cret ' })).toEqual({ clientId: '', clientSecret: 's3cret', pkce: '', port: '' });
  });

  it('validates new users and passwords like the server', () => {
    expect(validateNewUser({ username: 'ok_user', password: 'long enough!', confirm: 'long enough!' })).toEqual({});
    expect(validateNewUser({ username: 'a b', password: 'short', confirm: 'x' })).toEqual({
      username: expect.any(String),
      password: expect.stringContaining('10'),
      confirm: expect.any(String),
    });
    expect(validatePassword('x'.repeat(257), 'x'.repeat(257)).password).toMatch(/256/);
  });

  it('adds overlay options to the URL', () => {
    const base = 'https://203.0.113.7/overlay/chat?token=tok_1';
    expect(overlayUrlWithParams(base, { fade: 30, max: 10 })).toBe(`${base}&fade=30&max=10`);
    expect(overlayUrlWithParams(base, { fade: 0, max: 15 })).toBe(base);
    expect(overlayUrlWithParams(base, { fade: null, max: 1000 })).toBe(base);
    expect(overlayUrlWithParams(`${base}&fade=5`, { fade: null })).toBe(base);
    expect(overlayUrlWithParams('not a url', { fade: 5 })).toBe('not a url');
    expect(parseWholeNumber('')).toBeNull();
    expect(parseWholeNumber(' 12 ')).toBe(12);
    expect(parseWholeNumber('1e3')).toBeNaN();
  });

  it('pages the audit log', () => {
    const e = (id: number): AuditEntry => ({ id, ts: '2026-10-11T00:00:00Z', userId: null, username: null, action: 'x', detail: null, ip: null });
    const first = [e(10), e(9), e(8)];
    expect(auditCursor(first)).toBe(8);
    expect(auditCursor([])).toBeUndefined();
    expect(appendAudit(first, [e(8), e(7)]).map((x) => x.id)).toEqual([10, 9, 8, 7]);
  });

  it('matches server messages to fields by label', () => {
    const labels = { publicBaseUrl: 'Public base URL', ingestHost: 'Ingest host', key: 'Stream key', keyFile: 'Stream key file' };
    expect(fieldForMessage('Public base URL must start with http://', labels)).toBe('publicBaseUrl');
    expect(fieldForMessage('stream key file is missing', labels)).toBe('keyFile');
    expect(fieldForMessage('Something else', labels)).toBeNull();
    expect(hasErrors({ a: undefined })).toBe(false);
    expect(hasErrors({ a: 'x' })).toBe(true);
  });
});
