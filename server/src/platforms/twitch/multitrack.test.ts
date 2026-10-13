import { afterEach, describe, expect, it, vi } from 'vitest';
import { DriverError } from '../types.js';
import {
  buildConfigRequest,
  CLIENT_CONFIG_URL,
  fetchClientConfig,
  planFromConfig,
  prepareMultitrack,
  stripHtml,
  type ClientConfigResponse,
  type MultitrackInput,
} from './multitrack.js';
import { parseVideoFormat } from './options.js';

const AUTH = 'v1_abc_123_def_live_1_KEY';

function input(over: Partial<MultitrackInput> = {}): MultitrackInput {
  return {
    streamKey: 'live_1_KEY',
    landscape: parseVideoFormat('1920x1080@60')!,
    vertical: parseVideoFormat('1080x1920@60')!,
    ingestServer: null,
    bandwidthTest: false,
    now: new Date('2026-10-11T12:00:00Z'),
    ...over,
  };
}

function config(over: Partial<ClientConfigResponse> = {}): ClientConfigResponse {
  return {
    meta: { service: 'IVS', schema_version: '2025-01-25', config_id: 'cfg-1' },
    status: { result: 'success', html_en_us: null },
    ingest_endpoints: [
      { protocol: 'RTMP', url_template: 'rtmp://iad05.contribute.live-video.net/app/{stream_key}', authentication: AUTH },
      { protocol: 'RTMPS', url_template: 'rtmps://iad05.contribute.live-video.net/app/{stream_key}', authentication: AUTH },
    ],
    encoder_configurations: [
      { type: 'obs_x264', width: 1920, height: 1080, framerate: { numerator: 60, denominator: 1 }, canvas_index: 0 },
      { type: 'obs_x264', width: 1080, height: 1920, framerate: { numerator: 60, denominator: 1 }, canvas_index: 1 },
    ],
    audio_configurations: { live: [{ codec: 'ffmpeg_aac', track_id: 1, channels: 2, settings: { bitrate: 160 } }] },
    ...over,
  };
}

function expectRejected(fn: () => unknown, text: RegExp): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).code).toBe('misconfigured');
    expect((err as DriverError).message).toMatch(/^Twitch rejected relay Dual Format: /);
    expect((err as DriverError).message).toMatch(/Use "OBS sends Dual Format directly" instead\.$/);
    expect((err as DriverError).message).toMatch(text);
    return;
  }
  throw new Error('expected a rejection');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildConfigRequest', () => {
  it('describes both canvases and one track each', () => {
    const body = buildConfigRequest(input({ clientVersion: '1.2.3' }));
    expect(body).toMatchObject({
      service: 'IVS',
      schema_version: '2025-01-25',
      authentication: 'live_1_KEY',
      stream_attempt_start_time: '2026-10-11T12:00:00.000Z',
      client: { name: 'ctd-multi-stream', version: '1.2.3', supported_codecs: ['h264'] },
      preferences: {
        maximum_video_tracks: 2,
        vod_track_audio: false,
        canvases: [
          { width: 1920, height: 1080, canvas_width: 1920, canvas_height: 1080, framerate: { numerator: 60, denominator: 1 } },
          { width: 1080, height: 1920, canvas_width: 1080, canvas_height: 1920, framerate: { numerator: 60, denominator: 1 } },
        ],
      },
    });
    const caps = body.capabilities as { cpu: { logical_cores: number }; memory: { total: number }; gpu?: unknown };
    expect(caps.cpu.logical_cores).toBeGreaterThan(0);
    expect(caps.memory.total).toBeGreaterThan(0);
    expect(caps.gpu).toBeUndefined();
  });
});

describe('planFromConfig', () => {
  it('builds an RTMPS multitrack plan with the returned authentication and config id', () => {
    expect(planFromConfig(config(), input())).toEqual({
      url: `rtmps://iad05.contribute.live-video.net/app/${AUTH}?clientConfigId=cfg-1`,
      mode: 'multitrack',
      feeds: ['landscape', 'vertical'],
    });
  });

  it('keeps bandwidthtest before clientConfigId and honors an rtmp:// override', () => {
    const plan = planFromConfig(config(), input({ ingestServer: 'rtmp://live-fra.twitch.tv/app/', bandwidthTest: true }));
    expect(plan.url).toBe(`rtmp://live-fra.twitch.tv/app/${AUTH}?bandwidthtest=true&clientConfigId=cfg-1`);
  });

  it('picks RTMP when only RTMP is offered and keeps a template query', () => {
    const plan = planFromConfig(
      config({ ingest_endpoints: [{ protocol: 'RTMP', url_template: 'rtmp://h/app/{stream_key}?x=1', authentication: AUTH }] }),
      input(),
    );
    expect(plan.url).toBe(`rtmp://h/app/${AUTH}?x=1&clientConfigId=cfg-1`);
  });

  it('falls back to the stream key when no authentication is returned', () => {
    const plan = planFromConfig(
      config({ ingest_endpoints: [{ protocol: 'RTMPS', url_template: 'rtmps://h/app/{stream_key}' }] }),
      input(),
    );
    expect(plan.url).toBe('rtmps://h/app/live_1_KEY?clientConfigId=cfg-1');
  });

  it('rejects an error status with Twitch’s message as text', () => {
    expectRejected(
      () =>
        planFromConfig(
          config({
            status: { result: 'error', html_en_us: '<p>Your channel is not enabled for <b>Enhanced Broadcasting</b> &amp; Dual Format.</p>' },
            encoder_configurations: [],
          }),
          input(),
        ),
      /Your channel is not enabled for Enhanced Broadcasting & Dual Format\./,
    );
  });

  it("surfaces Twitch's real GPU-information error (response captured 2026-10-11)", () => {
    const captured: ClientConfigResponse = {
      meta: { schema_version: '2025-01-25', service: 'IVS', config_id: 'acb7671e-9d18-4382-939d-1f9108ee1e87' },
      status: {
        result: 'error',
        html_en_us:
          'Your broadcast software (ctd-multi-stream) did not send GPU Information which is required by GetClientConfiguration provided by Amazon IVS Multitrack Video. Try installing or updating the driver for your GPU.',
      },
      ingest_endpoints: [
        { protocol: 'RTMP', url_template: 'rtmp://ingest.global-contribute.live-video.net/app/{stream_key}', authentication: 'live_x' },
        { protocol: 'RTMPS', url_template: 'rtmps://ingest.global-contribute.live-video.net/app/{stream_key}', authentication: 'live_x' },
      ],
      encoder_configurations: [],
      audio_configurations: { live: [], vod: [] },
    };
    expectRejected(() => planFromConfig(captured, input()), /did not send GPU Information/);
  });

  it('passes warnings on and continues', () => {
    const warn = vi.fn();
    planFromConfig(config({ status: { result: 'warning', html_en_us: 'Driver <i>old</i>' } }), input(), warn);
    expect(warn).toHaveBeenCalledWith('Driver old');
  });

  it('rejects an encoding ladder', () => {
    const ladder = config().encoder_configurations!.concat([
      { type: 'obs_x264', width: 1280, height: 720, framerate: { numerator: 60, denominator: 1 }, canvas_index: 0 },
    ]);
    expectRejected(() => planFromConfig(config({ encoder_configurations: ladder }), input()), /encoding ladder \(3 video tracks\)/);
  });

  it('rejects a resolution or frame-rate mismatch with an actionable hint', () => {
    const enc = config().encoder_configurations!;
    expectRejected(
      () =>
        planFromConfig(
          config({ encoder_configurations: [{ ...enc[0]!, width: 1280, height: 720 }, enc[1]!] }),
          input(),
        ),
      /wants 1280x720@60 for the landscape track but the landscape feed is set to 1920x1080@60/,
    );
    expectRejected(
      () =>
        planFromConfig(
          config({ encoder_configurations: [enc[0]!, { ...enc[1]!, framerate: { numerator: 30, denominator: 1 } }] }),
          input(),
        ),
      /vertical track/,
    );
  });

  it('rejects missing vertical track, unknown canvases, non-H.264 and audio mismatches', () => {
    const enc = config().encoder_configurations!;
    expectRejected(() => planFromConfig(config({ encoder_configurations: [enc[0]!] }), input()), /no track for the vertical feed/);
    expectRejected(
      () => planFromConfig(config({ encoder_configurations: [enc[0]!, { ...enc[1]!, canvas_index: 2 }] }), input()),
      /unknown canvas/,
    );
    expectRejected(
      () => planFromConfig(config({ encoder_configurations: [{ ...enc[0]!, type: 'jim_hevc_nvenc' }, enc[1]!] }), input()),
      /HEVC/,
    );
    expectRejected(() => planFromConfig(config({ audio_configurations: { live: [] } }), input()), /0 audio tracks/);
    expectRejected(() => planFromConfig(config({ ingest_endpoints: [] }), input()), /no RTMP ingest endpoint/);
  });
});

describe('fetchClientConfig / prepareMultitrack', () => {
  it('POSTs JSON to Twitch and returns a plan', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(config()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const plan = await prepareMultitrack(input(), new AbortController().signal);
    expect(plan.mode).toBe('multitrack');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CLIENT_CONFIG_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string).authentication).toBe('live_1_KEY');
  });

  it('maps a 4xx to misconfigured with the server message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: { result: 'error', html_en_us: 'Invalid <b>stream key</b>' } }), { status: 400 })),
    );
    await expect(fetchClientConfig({}, new AbortController().signal)).rejects.toMatchObject({
      code: 'misconfigured',
      message: expect.stringMatching(/Invalid stream key/),
    });
  });

  it('maps 5xx and network failures to retryable errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 503 })));
    await expect(fetchClientConfig({}, new AbortController().signal)).rejects.toMatchObject({ code: 'platform-error' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(fetchClientConfig({}, new AbortController().signal)).rejects.toMatchObject({ code: 'platform-error' });
  });

  it('passes aborts through', async () => {
    const ctl = new AbortController();
    ctl.abort();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: RequestInit) => {
        init.signal?.throwIfAborted();
        return new Response('{}');
      }),
    );
    await expect(fetchClientConfig({}, ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('stripHtml', () => {
  it('removes tags and decodes entities', () => {
    expect(stripHtml('<a href="x">Learn&nbsp;more</a><br/>now &lt;3')).toBe('Learn more now <3');
  });
});
