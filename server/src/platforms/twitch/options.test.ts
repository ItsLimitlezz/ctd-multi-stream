import { describe, expect, it } from 'vitest';
import {
  appendQuery,
  buildIngestUrl,
  DEFAULT_INGEST,
  formatToString,
  isValidIngestServer,
  normalizeIngestServer,
  parseVideoFormat,
  readOptions,
} from './options.js';

describe('parseVideoFormat', () => {
  it('parses integer, NTSC and rational frame rates', () => {
    expect(parseVideoFormat('1920x1080@60')).toEqual({ width: 1920, height: 1080, fps: { numerator: 60, denominator: 1 } });
    expect(parseVideoFormat('1280 x 720 @ 29.97')).toEqual({
      width: 1280,
      height: 720,
      fps: { numerator: 30000, denominator: 1001 },
    });
    expect(parseVideoFormat('1080x1920@60000/1001')!.fps).toEqual({ numerator: 60000, denominator: 1001 });
    expect(parseVideoFormat('1080x1920')!.fps).toEqual({ numerator: 30, denominator: 1 });
  });

  it('rejects nonsense', () => {
    for (const bad of ['', 'abc', '1920x1080@0', '1920x1080@500', '10x10@30', '1920*1080@30', '99999x1080@30']) {
      expect(parseVideoFormat(bad), bad).toBeNull();
    }
  });

  it('formats back to text', () => {
    expect(formatToString(parseVideoFormat('1920x1080@60')!)).toBe('1920x1080@60');
    expect(formatToString(parseVideoFormat('1280x720@29.97')!)).toBe('1280x720@29.97');
  });
});

describe('ingest URLs', () => {
  it('joins server and key with exactly one slash', () => {
    expect(buildIngestUrl(`${DEFAULT_INGEST}/`, '/live_1_abc', false)).toBe(`${DEFAULT_INGEST}/live_1_abc`);
    expect(buildIngestUrl(DEFAULT_INGEST, 'live_1_abc', false)).toBe(`${DEFAULT_INGEST}/live_1_abc`);
  });

  it('appends the bandwidth test flag', () => {
    expect(buildIngestUrl(DEFAULT_INGEST, 'live_1_abc', true)).toBe(`${DEFAULT_INGEST}/live_1_abc?bandwidthtest=true`);
    expect(appendQuery('rtmp://h/app/k?a=1', [['b', '2']])).toBe('rtmp://h/app/k?a=1&b=2');
    expect(appendQuery('rtmp://h/app/k', [])).toBe('rtmp://h/app/k');
  });

  it('validates ingest server overrides', () => {
    expect(isValidIngestServer('rtmps://use20.contribute.live-video.net/app')).toBe(true);
    expect(isValidIngestServer('rtmp://live-fra.twitch.tv/app')).toBe(true);
    expect(isValidIngestServer('https://example.com/app')).toBe(false);
    expect(isValidIngestServer('rtmp://h/app?key=1')).toBe(false);
    expect(isValidIngestServer('rtmp://user:pw@h/app')).toBe(false);
    expect(isValidIngestServer('not a url')).toBe(false);
    expect(isValidIngestServer('rtmp://h/app/{stream_key}')).toBe(false);
    expect(isValidIngestServer('rtmp://h/app/%7Bstream_key%7D')).toBe(false);
    expect(isValidIngestServer('rtmp://h/{x}/app')).toBe(false);
  });

  it('drops the {stream_key} placeholder of ingest.twitch.tv templates', () => {
    expect(normalizeIngestServer(' rtmps://use20.contribute.live-video.net/app/{stream_key} ')).toBe(
      'rtmps://use20.contribute.live-video.net/app',
    );
    expect(normalizeIngestServer('rtmp://h/app/%7Bstream_key%7D')).toBe('rtmp://h/app');
    expect(normalizeIngestServer('rtmp://h/app')).toBe('rtmp://h/app');
  });
});

describe('readOptions', () => {
  it('applies defaults', () => {
    const { options, problems } = readOptions({ options: {} });
    expect(problems).toEqual([]);
    expect(options.dualFormat).toBe('off');
    expect(options.ingestServer).toBeNull();
    expect(options.bandwidthTest).toBe(false);
    expect(options.landscapeFormat.width).toBe(1920);
    expect(options.verticalFormat.height).toBe(1920);
  });

  it('reports invalid values', () => {
    const { options, problems } = readOptions({
      options: { dualFormat: 'weird', ingestServer: 'http://x', landscapeFormat: 'big' },
    });
    expect(options.dualFormat).toBe('off');
    expect(options.ingestServer).toBeNull();
    expect(problems).toHaveLength(2); // format hints only matter for relay-multitrack
  });

  it('checks feed formats in relay mode', () => {
    const { problems } = readOptions({ options: { dualFormat: 'relay-multitrack', verticalFormat: 'tall' } });
    expect(problems).toEqual(['Vertical feed format must look like 1920x1080@60']);
  });

  it('accepts a boolean bandwidth test and a valid override', () => {
    const { options } = readOptions({
      options: { bandwidthTest: true, ingestServer: ' rtmps://use20.contribute.live-video.net/app ' },
    });
    expect(options.bandwidthTest).toBe(true);
    expect(options.ingestServer).toBe('rtmps://use20.contribute.live-video.net/app');
  });

  it('accepts a pasted ingest template and rejects http(s) and other placeholders', () => {
    const template = readOptions({ options: { ingestServer: 'rtmps://use20.contribute.live-video.net/app/{stream_key}' } });
    expect(template.problems).toEqual([]);
    expect(template.options.ingestServer).toBe('rtmps://use20.contribute.live-video.net/app');

    for (const bad of ['https://use20.contribute.live-video.net/app', 'http://h/app', 'rtmp://h/{stream_key}/app']) {
      const { options, problems } = readOptions({ options: { ingestServer: bad } });
      expect(options.ingestServer, bad).toBeNull();
      expect(problems, bad).toHaveLength(1);
    }
  });
});
