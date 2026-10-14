import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { Destination } from '../../../../shared/types.js';
import type { BrowserManager, ScopedSecrets } from '../../services.js';
import { DriverError, type DriverContext } from '../types.js';
import { customDriver } from './index.js';
import { joinIngestUrl, rtmpUrlProblem, safeHost, streamKeyProblem } from './url.js';

function secrets(values: Record<string, string>): ScopedSecrets {
  const map = new Map(Object.entries(values));
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
    getJson: async <T>(k: string) => (map.has(k) ? (JSON.parse(map.get(k)!) as T) : null),
    setJson: async (k, v) => void map.set(k, JSON.stringify(v)),
  };
}

function ctx(streamKey?: string): DriverContext {
  return {
    log: pino({ level: 'silent' }),
    accountSecrets: null,
    destinationSecrets: secrets(streamKey === undefined ? {} : { streamKey }),
    app: null,
    browser: {} as BrowserManager,
    publicBaseUrl: 'https://127.0.0.1',
    updateAccount: async () => {},
    signal: new AbortController().signal,
  };
}

function dest(ingestUrl: string | null, feed: Destination['feed'] = 'landscape'): Destination {
  const now = new Date().toISOString();
  return {
    id: 'd1',
    platform: 'custom',
    accountId: null,
    name: 'Owncast',
    feed,
    enabled: true,
    options: {},
    ingestUrl,
    hasStreamKey: false,
    createdAt: now,
    updatedAt: now,
  };
}

describe('URL helpers', () => {
  it('joins server and key with exactly one slash', () => {
    expect(joinIngestUrl('rtmp://live.example.com/app', 'abc')).toBe('rtmp://live.example.com/app/abc');
    expect(joinIngestUrl('rtmp://live.example.com/app/', 'abc')).toBe('rtmp://live.example.com/app/abc');
    expect(joinIngestUrl('rtmp://live.example.com/app//', '/abc')).toBe('rtmp://live.example.com/app/abc');
    expect(joinIngestUrl(' rtmps://de.pscp.tv:443/x ', ' key123 ')).toBe('rtmps://de.pscp.tv:443/x/key123');
  });

  it('keeps the URL as-is without a key and does not encode keys', () => {
    expect(joinIngestUrl('rtmp://h/app/key-in-url/', '')).toBe('rtmp://h/app/key-in-url/');
    expect(joinIngestUrl('rtmp://h/app', null)).toBe('rtmp://h/app');
    expect(joinIngestUrl('rtmp://h:1935/live', 'landscape?key=a&b=c')).toBe('rtmp://h:1935/live/landscape?key=a&b=c');
  });

  it('validates rtmp(s) URLs', () => {
    expect(rtmpUrlProblem('rtmp://live.example.com/app')).toBeNull();
    expect(rtmpUrlProblem('rtmps://live.example.com:443/app')).toBeNull();
    expect(rtmpUrlProblem('')).toBe('Server URL is missing');
    expect(rtmpUrlProblem(null)).toBe('Server URL is missing');
    expect(rtmpUrlProblem('https://example.com/app')).toMatch(/rtmp:\/\/ or rtmps:\/\//);
    expect(rtmpUrlProblem('srt://example.com:9000')).toMatch(/rtmp/);
    expect(rtmpUrlProblem('rtmp://exa mple.com/app')).toMatch(/spaces/);
    expect(rtmpUrlProblem('not a url')).toMatch(/spaces|rtmp/);
    expect(rtmpUrlProblem('rtmp:///app')).not.toBeNull();
    expect(rtmpUrlProblem(`rtmp://h/${'a'.repeat(3000)}`)).toMatch(/too long/);
    expect(rtmpUrlProblem('ftp://x', 'Source URL')).toMatch(/^Source URL/);
  });

  it('validates stream keys and redacts URLs for logs', () => {
    expect(streamKeyProblem('abc-123')).toBeNull();
    expect(streamKeyProblem('a b')).toMatch(/spaces/);
    expect(streamKeyProblem('a\u0001b')).toMatch(/control/);
    expect(safeHost('rtmps://de.pscp.tv:443/x/secret-key')).toBe('rtmps://de.pscp.tv:443');
    expect(safeHost('nope')).toBe('[invalid url]');
  });
});

describe('customDriver', () => {
  it('describes itself for the UI', () => {
    const { info } = customDriver;
    expect(info.id).toBe('custom');
    expect(info.feeds).toEqual(['landscape', 'vertical']);
    expect(info.connectMethod).toBe('none');
    expect(info.developerApp).toBeNull();
    expect(info.titleSupport).toBe('none');
    expect(info.chatSupport).toBe('none');
    expect(info.keyPerSession).toBe(false);
    expect(info.experimental).toBe(false);
    const url = info.destinationFields.find((f) => f.key === 'ingestUrl');
    const key = info.destinationFields.find((f) => f.key === 'streamKey');
    expect(url).toMatchObject({ target: 'ingestUrl', type: 'url', required: true, help: 'rtmp:// or rtmps:// server URL' });
    expect(key).toMatchObject({ target: 'streamKey', type: 'secret', required: false });
    expect(customDriver.startConnect).toBeUndefined();
  });

  it('prepares a copy push to <server>/<key>', async () => {
    const prepared = await customDriver.prepare(dest('rtmp://live.example.com/app/'), null, 'ignored title', ctx('sk_1'));
    expect(prepared.push).toEqual({ url: 'rtmp://live.example.com/app/sk_1', mode: 'copy', feeds: ['landscape'] });
    expect(prepared.confirm).toBeUndefined();
    expect(prepared.setTitle).toBeUndefined();
    expect(prepared.chat).toBeUndefined();
  });

  it('uses the URL alone when no key is stored, and the destination feed', async () => {
    const prepared = await customDriver.prepare(dest('rtmps://ingest.example.com/live/abc', 'vertical'), null, '', ctx());
    expect(prepared.push).toEqual({ url: 'rtmps://ingest.example.com/live/abc', mode: 'copy', feeds: ['vertical'] });
  });

  it('rejects bad configuration as misconfigured', async () => {
    expect(await customDriver.validateDestination!(dest('rtmp://ok.example.com/app'), null, ctx('k'))).toEqual([]);
    expect(await customDriver.validateDestination!(dest(null), null, ctx())).toEqual(['Server URL is missing']);

    const err = await customDriver.prepare(dest('http://example.com/app'), null, '', ctx('k')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('misconfigured');
    expect((err as DriverError).message).toMatch(/rtmp:\/\/ or rtmps:\/\//);

    const badKey = await customDriver.prepare(dest('rtmp://h/app'), null, '', ctx('a b')).catch((e: unknown) => e);
    expect((badKey as DriverError).code).toBe('misconfigured');
    expect((badKey as DriverError).message).not.toContain('a b');
  });

  it('has no test mode: skipped while testing, and never pushes if prepared in test mode', async () => {
    expect(customDriver.info.testMode).toEqual({ supported: false, description: 'Custom servers are skipped while testing' });
    expect(customDriver.supportsTestMode).toBeUndefined();
    const testing = { ...ctx('sk_1'), testMode: true };
    const err = await customDriver.prepare(dest('rtmp://live.example.com/app/'), null, '', testing).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('not-eligible');
    expect((err as DriverError).message).toBe('Custom servers are skipped while testing');
    // Test mode off (or unset): unchanged.
    const prepared = await customDriver.prepare(dest('rtmp://live.example.com/app/'), null, '', { ...ctx('sk_1'), testMode: false });
    expect(prepared.push?.url).toBe('rtmp://live.example.com/app/sk_1');
  });
});
