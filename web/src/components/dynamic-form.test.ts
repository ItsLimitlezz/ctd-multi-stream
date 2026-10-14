import { describe, expect, it } from 'vitest';
import type { Destination, FieldSpec, LinkItem } from '@shared/types';
import { LINK_TITLE_MAX, LINKS_MAX } from '@shared/types';
import {
  addLinkRow,
  cleanLinks,
  cleanValues,
  coerceNumber,
  destinationFormValues,
  destinationSecretsSet,
  initialValues,
  isBlankLink,
  isEmptyValue,
  isHttpUrl,
  isValidUrl,
  LINK_URL_MAX,
  linkRowErrors,
  moveLinkRow,
  removeLinkRow,
  splitDestinationValues,
  toLinkItems,
  updateLinkRow,
  validateLinks,
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

const KICK: LinkItem = { title: 'Kick - Live Stream', url: 'https://kick.com/dprtmnttoronto' };
const TWITCH: LinkItem = { title: 'Twitch - Live Stream', url: 'https://www.twitch.tv/dprtmnttoronto' };
const linksField: FieldSpec = { key: 'links', label: 'Links', type: 'links' };
const linkFields: FieldSpec[] = [
  linksField,
  {
    key: 'linkMode',
    label: 'Link mode',
    type: 'select',
    default: 'rotate',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'rotate', label: 'Rotate' },
    ],
  },
];
const many = (n: number): LinkItem[] => Array.from({ length: n }, (_, i) => ({ title: `Link ${i}`, url: `https://example.com/${i}` }));

describe("'links' fields", () => {
  it('accepts only absolute http(s) URLs', () => {
    expect(isHttpUrl('https://kick.com/x')).toBe(true);
    expect(isHttpUrl(' http://example.com ')).toBe(true);
    expect(isHttpUrl('rtmp://example.com/app')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('kick.com/x')).toBe(false);
    expect(isHttpUrl('https://')).toBe(false);
  });

  it('reads option values defensively', () => {
    expect(toLinkItems(undefined)).toEqual([]);
    expect(toLinkItems('[{"title":"a","url":"b"}]')).toEqual([]);
    expect(toLinkItems([KICK, null, 'x', 3, { title: 5, url: 'https://a.b' }, { url: 'https://c.d' }])).toEqual([
      KICK,
      { title: '', url: 'https://a.b' },
      { title: '', url: 'https://c.d' },
    ]);
  });

  it('starts from the stored array (copied) or []', () => {
    expect(initialValues(linkFields)).toEqual({ links: [], linkMode: 'rotate' });
    const stored = [KICK, TWITCH];
    const v = initialValues(linkFields, { links: stored, linkMode: 'off' });
    expect(v).toEqual({ links: stored, linkMode: 'off' });
    expect(v.links).not.toBe(stored);
    expect(initialValues(linkFields, { links: 'garbage' }).links).toEqual([]);

    const dest: Destination = {
      id: 'ig',
      platform: 'instagram',
      accountId: 'a',
      name: 'DPRTMNT',
      feed: 'vertical',
      enabled: true,
      options: { links: [TWITCH], linkMode: 'rotate' },
      ingestUrl: null,
      hasStreamKey: false,
      createdAt: '',
      updatedAt: '',
    };
    expect(destinationFormValues(linkFields, dest)).toEqual({ links: [TWITCH], linkMode: 'rotate' });
    expect(destinationFormValues(linkFields, { ...dest, options: {} })).toEqual({ links: [], linkMode: 'rotate' });
  });

  it('trims rows and drops empty ones', () => {
    expect(isBlankLink({ title: '  ', url: '' })).toBe(true);
    expect(isBlankLink({ title: '', url: ' x ' })).toBe(false);
    expect(cleanLinks([{ title: ' Kick - Live Stream ', url: ' https://kick.com/dprtmnttoronto ' }, { title: ' ', url: '  ' }, TWITCH])).toEqual([
      KICK,
      TWITCH,
    ]);
    expect(cleanLinks(undefined)).toEqual([]);
  });

  it('flags rows: missing title / URL, non-http URLs, too long', () => {
    expect(linkRowErrors(KICK)).toEqual({});
    expect(linkRowErrors({ title: '', url: '' })).toEqual({});
    expect(linkRowErrors({ title: '', url: 'https://a.b' })).toEqual({ title: 'Title is required' });
    expect(linkRowErrors({ title: 'A', url: ' ' })).toEqual({ url: 'URL is required' });
    expect(linkRowErrors({ title: 'A', url: 'javascript:alert(1)' }).url).toMatch(/http:\/\/ or https:\/\//);
    expect(linkRowErrors({ title: 'A', url: 'ftp://a.b/c' }).url).toMatch(/http:\/\/ or https:\/\//);
    expect(linkRowErrors({ title: 'x'.repeat(LINK_TITLE_MAX + 1), url: 'https://a.b' }).title).toMatch(String(LINK_TITLE_MAX));
    expect(linkRowErrors({ title: 'x'.repeat(LINK_TITLE_MAX), url: 'https://a.b' })).toEqual({});
    expect(linkRowErrors({ title: 'A', url: `https://a.b/${'x'.repeat(LINK_URL_MAX)}` }).url).toMatch(String(LINK_URL_MAX));
  });

  it('validates the whole list with numbered messages', () => {
    expect(validateLinks(linksField, [KICK, TWITCH])).toBeNull();
    expect(validateLinks(linksField, undefined)).toBeNull();
    expect(validateLinks(linksField, [])).toBeNull();
    // Blank rows are ignored (dropped on save), but rows stay numbered as shown.
    expect(validateLinks(linksField, [KICK, { title: '', url: '' }, { title: 'Bad', url: 'kick.com' }])).toBe(
      'Link 3: URL must start with http:// or https://',
    );
    expect(validateLinks(linksField, [{ title: '', url: 'https://a.b' }])).toBe('Link 1: Title is required');
    expect(validateLinks(linksField, 'https://a.b')).toBe('Links must be a list of links');
    expect(validateLinks(linksField, many(LINKS_MAX))).toBeNull();
    expect(validateLinks(linksField, many(LINKS_MAX + 1))).toBe(`Use at most ${LINKS_MAX} links`);
    expect(validateLinks({ ...linksField, required: true }, [{ title: ' ', url: '' }])).toBe('Links is required');
  });

  it('plugs into validateValues / cleanValues / splitDestinationValues', () => {
    expect(validateValues(linkFields, { links: [{ title: 'A', url: 'nope' }], linkMode: 'rotate' })).toEqual({
      links: 'Link 1: URL must start with http:// or https://',
    });
    expect(validateValues(linkFields, { linkMode: 'rotate' })).toEqual({});
    expect(validateValues([{ ...linksField, required: true }], { links: [] })).toEqual({ links: 'Links is required' });

    // The whole array is sent as the option value (never stringified); an emptied list is [].
    const values = { links: [{ title: ' Kick - Live Stream ', url: 'https://kick.com/dprtmnttoronto ' }, { title: '', url: '' }], linkMode: 'rotate' };
    expect(cleanValues(linkFields, values)).toEqual({ links: [KICK], linkMode: 'rotate' });
    expect(splitDestinationValues(linkFields, values)).toEqual({ options: { links: [KICK], linkMode: 'rotate' } });
    expect(splitDestinationValues(linkFields, { links: [{ title: '', url: '' }] })).toEqual({ options: { links: [] } });
    expect(isEmptyValue([])).toBe(true);
  });

  it('edits rows immutably: add (max), remove, move, update', () => {
    const list = [KICK, TWITCH];
    expect(addLinkRow(list)).toEqual([KICK, TWITCH, { title: '', url: '' }]);
    expect(addLinkRow(many(LINKS_MAX))).toHaveLength(LINKS_MAX);
    expect(removeLinkRow(list, 0)).toEqual([TWITCH]);
    expect(removeLinkRow(list, 5)).toEqual(list);
    expect(moveLinkRow(list, 1, -1)).toEqual([TWITCH, KICK]);
    expect(moveLinkRow(list, 0, 1)).toEqual([TWITCH, KICK]);
    expect(moveLinkRow(list, 0, -1)).toEqual(list);
    expect(moveLinkRow(list, 1, 1)).toEqual(list);
    expect(moveLinkRow(many(4), 0, 3).map((l) => l.title)).toEqual(['Link 1', 'Link 2', 'Link 3', 'Link 0']);
    expect(updateLinkRow(list, 1, { url: 'https://twitch.tv/x' })).toEqual([KICK, { ...TWITCH, url: 'https://twitch.tv/x' }]);
    expect(list).toEqual([KICK, TWITCH]);
  });
});
