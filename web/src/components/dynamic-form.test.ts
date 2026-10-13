import { describe, expect, it } from 'vitest';
import type { Destination, FieldSpec } from '@shared/types';
import {
  cleanValues,
  coerceNumber,
  destinationFormValues,
  destinationSecretsSet,
  initialValues,
  isValidUrl,
  splitDestinationValues,
  validateValues,
} from './dynamic-form';

const fields: FieldSpec[] = [
  { key: 'server', label: 'Server URL', type: 'url', target: 'ingestUrl', required: true },
  { key: 'key', label: 'Stream key', type: 'secret', target: 'streamKey', required: true },
  { key: 'mode', label: 'Mode', type: 'select', options: [{ value: 'page', label: 'Page' }, { value: 'profile', label: 'Profile' }], default: 'page' },
  { key: 'private', label: 'Private', type: 'boolean' },
  { key: 'delay', label: 'Delay', type: 'number' },
  { key: 'note', label: 'Note', type: 'text' },
];

const dest: Destination = {
  id: 'd1',
  platform: 'custom',
  accountId: null,
  name: 'Custom',
  feed: 'landscape',
  enabled: true,
  options: { mode: 'profile', private: true, note: 'hi' },
  ingestUrl: 'rtmps://live.example.com/app',
  hasStreamKey: true,
  createdAt: '',
  updatedAt: '',
};

describe('dynamic form helpers', () => {
  it('validates URLs', () => {
    expect(isValidUrl('rtmps://live.example.com:443/app')).toBe(true);
    expect(isValidUrl('rtmp://1.2.3.4/live')).toBe(true);
    expect(isValidUrl('https://example.com')).toBe(true);
    expect(isValidUrl('javascript:alert(1)')).toBe(false);
    expect(isValidUrl('rtmp://')).toBe(false);
    expect(isValidUrl('not a url')).toBe(false);
  });

  it('builds initial values with defaults and never prefills secrets', () => {
    expect(initialValues(fields)).toEqual({ mode: 'page', private: false });
    expect(initialValues(fields, { key: 'leak', note: 'x', mode: 'profile' })).toEqual({ mode: 'profile', private: false, note: 'x' });
  });

  it('coerces numbers', () => {
    expect(coerceNumber('')).toBeUndefined();
    expect(coerceNumber(' 42 ')).toBe(42);
    expect(coerceNumber('4.5')).toBe(4.5);
    expect(coerceNumber('abc')).toBe('abc');
  });

  it('validates required fields, types and stored secrets', () => {
    const errors = validateValues(fields, { server: 'nope', mode: 'other', delay: 'abc' });
    expect(Object.keys(errors).sort()).toEqual(['delay', 'key', 'mode', 'server']);
    expect(errors.key).toBe('Stream key is required');
    // A stored secret satisfies "required".
    expect(validateValues(fields, { server: 'rtmp://a.b/c' }, { key: true })).toEqual({});
  });

  it('cleans values (trim, drop empty)', () => {
    expect(cleanValues(fields, { server: ' rtmp://a.b/c ', key: ' k ', note: '   ', delay: 3 })).toEqual({
      server: 'rtmp://a.b/c',
      key: ' k ',
      delay: 3,
    });
  });

  it('maps destinations to form values and back', () => {
    expect(destinationFormValues(fields, dest)).toEqual({
      server: 'rtmps://live.example.com/app',
      mode: 'profile',
      private: true,
      note: 'hi',
    });
    expect(destinationSecretsSet(fields, dest)).toEqual({ key: true });
    expect(destinationSecretsSet(fields, null)).toEqual({ key: false });

    expect(splitDestinationValues(fields, { server: 'rtmp://a.b/c', mode: 'page', private: false })).toEqual({
      options: { mode: 'page', private: false },
      ingestUrl: 'rtmp://a.b/c',
    });
    expect(splitDestinationValues(fields, { key: 'secret', server: '' })).toEqual({
      options: {},
      ingestUrl: null,
      streamKey: 'secret',
    });
  });
});
