import { describe, expect, it } from 'vitest';
import { buildPushUrl, chooseIngestServer, KICK_DEFAULT_INGEST, normalizeIngestServer, usableStreamKey } from './ingest.js';

const HOST = 'fa723fc1b171.global-contribute.live-video.net';

describe('normalizeIngestServer', () => {
  it('adds the IVS /app path when the URL has none', () => {
    expect(normalizeIngestServer(`rtmps://${HOST}`)).toBe(`rtmps://${HOST}/app`);
    expect(normalizeIngestServer(`rtmps://${HOST}/`)).toBe(`rtmps://${HOST}/app`);
    expect(normalizeIngestServer(`rtmps://${HOST}:443`)).toBe(`rtmps://${HOST}:443/app`);
  });

  it('keeps an existing path and strips trailing slashes', () => {
    expect(normalizeIngestServer(`rtmps://${HOST}/app/`)).toBe(`rtmps://${HOST}/app`);
    expect(normalizeIngestServer(` rtmp://ingest.example.com/live `)).toBe('rtmp://ingest.example.com/live');
  });

  it('rejects non-RTMP URLs, credentials, queries and garbage', () => {
    expect(normalizeIngestServer('https://kick.com')).toBeNull();
    expect(normalizeIngestServer('rtmps://user:pw@host/app')).toBeNull();
    expect(normalizeIngestServer('rtmps://host/app?x=1')).toBeNull();
    expect(normalizeIngestServer('not a url')).toBeNull();
    expect(normalizeIngestServer('')).toBeNull();
    expect(normalizeIngestServer(null)).toBeNull();
  });
});

describe('chooseIngestServer', () => {
  it('uses the API URL when the destination keeps the default', () => {
    expect(chooseIngestServer(KICK_DEFAULT_INGEST, 'rtmps://other.contribute.live-video.net')).toBe(
      'rtmps://other.contribute.live-video.net/app',
    );
    expect(chooseIngestServer(null, `rtmps://${HOST}`)).toBe(`rtmps://${HOST}/app`);
  });

  it('prefers an explicit non-default server on the destination', () => {
    expect(chooseIngestServer('rtmps://regional.example.net/app', `rtmps://${HOST}`)).toBe('rtmps://regional.example.net/app');
  });

  it('falls back to the default server', () => {
    expect(chooseIngestServer(null, null)).toBe(KICK_DEFAULT_INGEST);
    expect(chooseIngestServer(null, 'garbage')).toBe(KICK_DEFAULT_INGEST);
  });
});

describe('buildPushUrl / usableStreamKey', () => {
  it('joins server and key with exactly one slash', () => {
    expect(buildPushUrl(`rtmps://${HOST}/app`, 'sk_us-west-2_abc')).toBe(`rtmps://${HOST}/app/sk_us-west-2_abc`);
    expect(buildPushUrl(`rtmps://${HOST}/app/`, '/sk_x')).toBe(`rtmps://${HOST}/app/sk_x`);
  });

  it('accepts only keys that are safe in a URL path', () => {
    expect(usableStreamKey('  sk_us-west-2_abc ')).toBe('sk_us-west-2_abc');
    expect(usableStreamKey('')).toBeNull();
    expect(usableStreamKey(null)).toBeNull();
    expect(usableStreamKey('a b')).toBeNull();
    expect(usableStreamKey('a/b')).toBeNull();
    expect(usableStreamKey('a?b')).toBeNull();
  });
});
