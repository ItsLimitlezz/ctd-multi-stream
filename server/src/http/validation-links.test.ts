import { describe, expect, it } from 'vitest';
import { LINK_TITLE_MAX, LINKS_MAX, type FieldSpec } from '../../../shared/types.js';
import { coerceField, coerceLinks, HttpError, normalizeFields } from './validation.js';

const links: FieldSpec = { key: 'links', label: 'Links', type: 'links' };
const mode: FieldSpec = {
  key: 'linkMode',
  label: 'Link mode',
  type: 'select',
  default: 'rotate',
  options: [
    { value: 'off', label: 'Off' },
    { value: 'rotate', label: 'Rotate' },
  ],
};

const KICK = { title: 'Kick - Live Stream', url: 'https://kick.com/dprtmnttoronto' };
const TWITCH = { title: 'Twitch - Live Stream', url: 'https://www.twitch.tv/dprtmnttoronto' };

function expect400(fn: () => unknown, message?: RegExp): void {
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

describe('coerceLinks', () => {
  it('accepts a good list, trims and drops unknown keys, keeps the order', () => {
    expect(
      coerceLinks(links, [
        { title: '  Kick - Live Stream ', url: ' https://kick.com/dprtmnttoronto ', extra: 'x' },
        { ...TWITCH, index: 3 },
        { title: 'Plain http', url: 'http://example.com/a?b=1#c' },
      ]),
    ).toEqual([KICK, TWITCH, { title: 'Plain http', url: 'http://example.com/a?b=1#c' }]);
    expect(coerceLinks(links, [])).toEqual([]);
  });

  it('treats null, undefined and blank as no value', () => {
    expect(coerceLinks(links, undefined)).toBeUndefined();
    expect(coerceLinks(links, null)).toBeUndefined();
    expect(coerceLinks(links, '  ')).toBeUndefined();
  });

  it('allows up to LINKS_MAX links and titles up to LINK_TITLE_MAX characters', () => {
    const many = Array.from({ length: LINKS_MAX }, (_, i) => ({ title: `L${i}`, url: `https://example.com/${i}` }));
    expect(coerceLinks(links, many)).toHaveLength(LINKS_MAX);
    const title = '😀'.repeat(LINK_TITLE_MAX); // counted in characters, not UTF-16 units
    expect(coerceLinks(links, [{ title, url: 'https://example.com' }])?.[0]?.title).toBe(title);
  });

  it('rejects too many links', () => {
    const many = Array.from({ length: LINKS_MAX + 1 }, (_, i) => ({ title: `L${i}`, url: `https://example.com/${i}` }));
    expect400(() => coerceLinks(links, many), /Links can have at most 20 links/);
  });

  it('rejects bad URLs, including javascript: and other schemes', () => {
    const bad = [
      'not a url',
      'kick.com/dprtmnttoronto',
      'javascript:alert(1)',
      'JavaScript:alert(document.cookie)',
      'data:text/html,<script>alert(1)</script>',
      'ftp://example.com/file',
      'rtmp://live.example.com/app',
      'https://',
      'https://exa mple.com',
      `https://example.com/${'a'.repeat(2048)}`,
      '',
    ];
    for (const url of bad) {
      expect400(() => coerceLinks(links, [KICK, { title: 'Bad', url }]), /^Links: link 2 /);
    }
    expect400(() => coerceLinks(links, [{ title: 'X', url: 'javascript:alert(1)' }]), /http:\/\/ or https:\/\//);
    expect400(() => coerceLinks(links, [{ title: 'X', url: 42 }]), /needs a URL/);
  });

  it('rejects empty, too long and multi-line titles', () => {
    expect400(() => coerceLinks(links, [{ title: '', url: KICK.url }]), /Links: link 1 needs a title/);
    expect400(() => coerceLinks(links, [{ title: '   ', url: KICK.url }]), /needs a title/);
    expect400(() => coerceLinks(links, [{ url: KICK.url }]), /needs a title/);
    expect400(() => coerceLinks(links, [{ title: 7, url: KICK.url }]), /needs a title/);
    expect400(() => coerceLinks(links, [{ title: 'x'.repeat(LINK_TITLE_MAX + 1), url: KICK.url }]), /at most 100 characters/);
    expect400(() => coerceLinks(links, [{ title: 'two\nlines', url: KICK.url }]), /single line/);
  });

  it('rejects non-list values and non-object items', () => {
    expect400(() => coerceLinks(links, 'https://kick.com'), /Links must be a list of links/);
    expect400(() => coerceLinks(links, { title: 'Kick', url: KICK.url }), /must be a list/);
    expect400(() => coerceLinks(links, [KICK, 'https://kick.com']), /link 2 must have a title and a URL/);
    expect400(() => coerceLinks(links, [null]), /link 1 must have a title and a URL/);
  });

  it('coerceField refuses a links field (lists go through coerceLinks)', () => {
    expect400(() => coerceField(links, [KICK]), /must be a list of links/);
  });
});

describe('normalizeFields with a links field', () => {
  const fields = [links, mode];

  it('missing → [] ; submitted list is validated', () => {
    expect(normalizeFields(fields, {})).toEqual({ links: [], linkMode: 'rotate' });
    expect(normalizeFields(fields, { links: [KICK, TWITCH] })).toEqual({ links: [KICK, TWITCH], linkMode: 'rotate' });
    expect400(() => normalizeFields(fields, { links: [{ title: '', url: KICK.url }] }), /Links: link 1 needs a title/);
  });

  it('patching keeps the existing list unless submitted; null clears it', () => {
    const base = { links: [KICK, TWITCH], linkMode: 'off' };
    expect(normalizeFields(fields, { linkMode: 'rotate' }, base)).toEqual({ links: [KICK, TWITCH], linkMode: 'rotate' });
    expect(normalizeFields(fields, { links: [TWITCH] }, base)).toEqual({ links: [TWITCH], linkMode: 'off' });
    expect(normalizeFields(fields, { links: null }, base)).toEqual({ links: [], linkMode: 'off' });
  });

  it('a required links field needs at least one link', () => {
    const required: FieldSpec = { ...links, required: true };
    expect400(() => normalizeFields([required], {}), /Links needs at least one link/);
    expect(normalizeFields([required], { links: [KICK] })).toEqual({ links: [KICK] });
  });
});
