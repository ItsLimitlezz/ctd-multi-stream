import { describe, expect, it } from 'vitest';
import type { Account, Destination, PlatformInfo } from '@shared/types';
import {
  accountOptions,
  buildCreateRequest,
  buildUpdateRequest,
  defaultAccountId,
  defaultFeed,
  destinationErrorField,
  destinationProblems,
  draftSecretsSet,
  feedOptions,
  feedRestriction,
  groupByFeed,
  ingestHostLabel,
  initialDraft,
  sortAccounts,
  sortPlatforms,
  validateDraft,
} from './destination-form';

const info = (over: Partial<PlatformInfo> = {}): PlatformInfo => ({
  id: 'kick',
  name: 'Kick',
  feeds: ['landscape'],
  defaultFeed: 'landscape',
  connectMethod: 'oauth-paste',
  accountFields: [],
  destinationFields: [
    { key: 'server', label: 'Server URL', type: 'url', target: 'ingestUrl', required: true },
    { key: 'key', label: 'Stream key', type: 'secret', target: 'streamKey', required: true },
    { key: 'lowLatency', label: 'Low latency', type: 'boolean' },
    { key: 'note', label: 'Note', type: 'text' },
  ],
  developerApp: null,
  titleSupport: 'api',
  chatSupport: 'api',
  keyPerSession: false,
  experimental: false,
  ...over,
});

const account = (id: string, platform: Account['platform'], status: Account['status'] = 'connected', label = id): Account => ({
  id,
  platform,
  label,
  status,
  statusMessage: null,
  options: {},
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
});

const dest = (over: Partial<Destination> = {}): Destination => ({
  id: 'd1',
  platform: 'kick',
  accountId: 'a1',
  name: 'Kick main',
  feed: 'landscape',
  enabled: true,
  options: { lowLatency: true, note: 'hi' },
  ingestUrl: 'rtmps://fa723fc1b171.global-contribute.live-video.net/app',
  hasStreamKey: true,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  ...over,
});

describe('destination form helpers', () => {
  it('orders platforms and accounts in the standard order', () => {
    expect(sortPlatforms([{ id: 'custom' }, { id: 'tiktok' }, { id: 'twitch' }, { id: 'mystery' }]).map((p) => p.id)).toEqual([
      'twitch',
      'tiktok',
      'custom',
      'mystery',
    ]);
    const sorted = sortAccounts([account('b', 'youtube', 'connected', 'Zed'), account('c', 'twitch', 'connected', 'Beta'), account('a', 'twitch', 'connected', 'Alpha')]);
    expect(sorted.map((a) => a.id)).toEqual(['a', 'c', 'b']);
  });

  it('groups destinations by feed', () => {
    const g = groupByFeed([dest({ id: '1' }), dest({ id: '2', feed: 'vertical' }), dest({ id: '3' })]);
    expect(g.landscape.map((d) => d.id)).toEqual(['1', '3']);
    expect(g.vertical.map((d) => d.id)).toEqual(['2']);
  });

  it('limits feeds to what the platform accepts', () => {
    const ig = info({ id: 'instagram', name: 'Instagram', feeds: ['vertical'], defaultFeed: 'vertical' });
    expect(feedOptions(ig).map((o) => o.value)).toEqual(['vertical']);
    expect(feedRestriction(ig)).toBe('Instagram only accepts the vertical feed.');
    expect(feedRestriction(info({ feeds: ['landscape', 'vertical'] }))).toBeNull();
    // A defaultFeed outside `feeds` falls back to the first accepted feed.
    expect(defaultFeed(info({ feeds: ['vertical'], defaultFeed: 'landscape' }))).toBe('vertical');
  });

  it('picks a connected account of the same platform by default', () => {
    const accounts = [account('t1', 'twitch'), account('k1', 'kick', 'error'), account('k2', 'kick')];
    expect(defaultAccountId(accounts, 'kick')).toBe('k2');
    expect(defaultAccountId([account('k1', 'kick', 'error')], 'kick')).toBe('k1');
    expect(defaultAccountId(accounts, 'youtube')).toBe('');
    expect(accountOptions(accounts, 'kick')).toEqual([
      { value: 'k1', label: 'k1 (error)' },
      { value: 'k2', label: 'k2' },
    ]);
  });

  it('builds a new draft from the platform defaults and never prefills secrets', () => {
    const d = initialDraft(info(), [account('k1', 'kick')], null);
    expect(d).toMatchObject({ name: 'Kick', feed: 'landscape', accountId: 'k1', clearStreamKey: false });
    expect(d.values).toEqual({ lowLatency: false });
    const edit = initialDraft(info(), [], dest());
    expect(edit.values).toEqual({ server: dest().ingestUrl, lowLatency: true, note: 'hi' });
    expect(edit.values).not.toHaveProperty('key');
    // Platforms without accounts never preselect one.
    expect(initialDraft(info({ connectMethod: 'none' }), [account('k1', 'kick')], null).accountId).toBe('');
  });

  it('validates name, feed and driver fields (a stored key satisfies "required")', () => {
    const i = info();
    const draft = { ...initialDraft(i, [], null), name: '  ' };
    expect(validateDraft(i, draft, {})).toEqual({
      name: expect.any(String),
      server: expect.any(String),
      key: expect.any(String),
    });
    const editing = { ...initialDraft(i, [], dest()) };
    expect(validateDraft(i, editing, draftSecretsSet(i, dest(), editing))).toEqual({});
    // Asking to remove the stored key makes the required key missing again.
    const clearing = { ...editing, clearStreamKey: true };
    expect(validateDraft(i, clearing, draftSecretsSet(i, dest(), clearing))).toHaveProperty('key');
    expect(validateDraft(i, { ...editing, feed: 'vertical' }, { key: true })).toHaveProperty('feed');
    // Server URL fields must be RTMP(S), like the server requires.
    const https = { ...editing, values: { ...editing.values, server: 'https://ingest.example/app' } };
    expect(validateDraft(i, https, { key: true })).toEqual({ server: 'Server URL must start with rtmp:// or rtmps://' });
  });

  it('builds create requests by field target', () => {
    const i = info();
    const draft = {
      ...initialDraft(i, [account('k1', 'kick')], null),
      name: ' My Kick ',
      values: { server: ' rtmps://x.example/app ', key: 'sk_live_1', lowLatency: true, note: '' },
    };
    expect(buildCreateRequest(i, draft)).toEqual({
      platform: 'kick',
      name: 'My Kick',
      feed: 'landscape',
      accountId: 'k1',
      enabled: true,
      options: { lowLatency: true },
      ingestUrl: 'rtmps://x.example/app',
      streamKey: 'sk_live_1',
    });
    // No account for platforms that don't use accounts, even if one is set in the draft.
    expect(buildCreateRequest(info({ connectMethod: 'none' }), draft).accountId).toBeNull();
  });

  it('builds update requests: keep / replace / clear the key, null clears options', () => {
    const i = info({ destinationFields: info().destinationFields.map((f) => (f.key === 'key' ? { ...f, required: false } : f)) });
    const base = initialDraft(i, [], dest());
    const keep = buildUpdateRequest(i, { ...base, values: { ...base.values, note: '' } });
    expect(keep).not.toHaveProperty('streamKey');
    expect(keep.options).toEqual({ lowLatency: true, note: null });
    expect(keep.ingestUrl).toBe(dest().ingestUrl);
    expect(keep.accountId).toBe('a1');
    expect(buildUpdateRequest(i, { ...base, values: { ...base.values, key: 'new' } }).streamKey).toBe('new');
    expect(buildUpdateRequest(i, { ...base, clearStreamKey: true }).streamKey).toBe('');
    // A typed key wins over "remove".
    expect(buildUpdateRequest(i, { ...base, clearStreamKey: true, values: { ...base.values, key: 'k2' } }).streamKey).toBe('k2');
    expect(buildUpdateRequest(i, { ...base, accountId: '' }).accountId).toBeNull();
  });

  it('maps server validation messages to fields', () => {
    const i = info();
    expect(destinationErrorField(i, 'Name is required')).toBe('name');
    expect(destinationErrorField(i, 'Stream key must not contain spaces or control characters')).toBe('key');
    expect(destinationErrorField(i, 'Server URL must be an rtmp:// or rtmps:// URL')).toBe('server');
    expect(destinationErrorField(i, 'Kick does not accept the vertical feed')).toBe('feed');
    expect(destinationErrorField(i, 'That account is not a Kick account')).toBe('accountId');
    expect(destinationErrorField(i, 'Note must be at most 2048 characters')).toBe('note');
    expect(destinationErrorField(i, 'Internal error')).toBeNull();
  });

  it('lists what a destination is missing', () => {
    const i = info();
    expect(destinationProblems(i, dest(), account('a1', 'kick'))).toEqual([]);
    expect(destinationProblems(i, dest({ accountId: null, hasStreamKey: false, ingestUrl: null }), undefined)).toEqual([
      'No account linked',
      'No stream key',
      'Server URL missing',
    ]);
    expect(destinationProblems(i, dest(), account('a1', 'kick', 'needs-login'))).toEqual(['Account needs login']);
    expect(destinationProblems(undefined, dest(), undefined)).toHaveLength(1);
    expect(destinationProblems(info({ connectMethod: 'none' }), dest({ accountId: null }), undefined)).toEqual([]);
  });

  it('shows only the host of an RTMP server URL', () => {
    expect(ingestHostLabel('rtmps://live.example.com:443/app')).toBe('live.example.com:443');
    expect(ingestHostLabel('not a url')).toBeNull();
    expect(ingestHostLabel(null)).toBeNull();
  });
});
