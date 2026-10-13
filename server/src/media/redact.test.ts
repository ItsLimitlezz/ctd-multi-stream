import { describe, expect, it } from 'vitest';
import { redactFragments, redactSecretsInText, redactUrl, redactUrlsInText, urlSecretFragments } from './redact.js';

describe('redactUrl', () => {
  it('keeps scheme + host + port only', () => {
    expect(redactUrl('rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl')).toBe('rtmp://a.rtmp.youtube.com');
    expect(redactUrl('rtmps://live-api-s.facebook.com:443/rtmp/FB-1?s_bl=1&a=xyz')).toBe('rtmps://live-api-s.facebook.com:443');
    expect(redactUrl('srt://host:9000?streamid=secret&passphrase=p')).toBe('srt://host:9000');
    expect(redactUrl('rtmp://user:pass@127.0.0.1:1935/live/landscape?user=internal&pass=x')).toBe('rtmp://127.0.0.1:1935');
    expect(redactUrl('rtmp://[::1]:1935/live/x')).toBe('rtmp://[::1]:1935');
  });

  it('never returns the input for garbage', () => {
    expect(redactUrl('not a url secretkey')).toBe('[redacted url]');
    expect(redactUrl('')).toBe('[redacted url]');
  });
});

describe('redactUrlsInText', () => {
  it('replaces every media URL token and keeps trailing punctuation', () => {
    const line = "[out#0/flv] Error opening output rtmp://live.twitch.tv/app/live_123_secret: I/O error, retry 'srt://x:1/?streamid=s'";
    const out = redactUrlsInText(line);
    expect(out).toBe("[out#0/flv] Error opening output rtmp://live.twitch.tv: I/O error, retry 'srt://x:1'");
    expect(out).not.toContain('secret');
  });

  it('handles rtmps/rtmpt/rtsp variants and leaves other text alone', () => {
    expect(redactUrlsInText('a RTMPS://H:443/app/k b')).toBe('a rtmps://H:443 b');
    expect(redactUrlsInText('rtmpt://h/app/key.')).toBe('rtmpt://h.');
    expect(redactUrlsInText('rtsp://cam/stream?token=1')).toBe('rtsp://cam');
    expect(redactUrlsInText('nothing to see')).toBe('nothing to see');
  });
});

describe('redactSecretsInText', () => {
  it('also hides loose key=/pass= parameters', () => {
    const out = redactSecretsInText("failed to authenticate: query 'key=abc123&foo=1&pass=hunter2'");
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('foo=1');
  });
});

describe('urlSecretFragments / redactFragments', () => {
  it('extracts long path segments, query values and userinfo', () => {
    const f = urlSecretFragments('rtmps://u:longpassword@host/app/live_123456_abcdef?s_bl=1&a=verylongtoken');
    expect(f).toEqual(expect.arrayContaining(['live_123456_abcdef', 'verylongtoken', 'longpassword']));
    expect(f).not.toContain('app');
    expect(f).not.toContain('1');
  });

  it('replaces echoed keys', () => {
    expect(redactFragments('Stream key live_123456_abcdef rejected', ['live_123456_abcdef'])).toBe('Stream key [redacted] rejected');
  });
});
