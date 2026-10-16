// EXPERIMENTAL: relay both feeds to Twitch as Dual Format (Enhanced Broadcasting / multitrack E-RTMP).
//
// What was learned (Oct 2026):
// - OBS asks Twitch's config service before every Enhanced Broadcasting stream:
//   POST https://ingest.twitch.tv/api/v3/GetClientConfiguration (OBS plugins/rtmp-services/data/services.json,
//   "multitrack_video_configuration_url"), JSON body, only `Content-Type: application/json`, 5 s timeout
//   (obs-studio frontend/utility/GoLiveAPI_Network.cpp). Twitch runs on Amazon IVS; the same API is documented at
//   https://docs.aws.amazon.com/ivs/latest/BroadcastSWIntegAPIReference/actions-GetClientConfiguration.html
// - Request (frontend/utility/models/multitrack-video.hpp, GoLiveAPI_PostData.cpp): service "IVS",
//   schema_version "2025-01-25", authentication = the channel's stream key, client {name, version,
//   supported_codecs}, capabilities {cpu, memory, system, gpu?}, preferences {maximum_video_tracks,
//   vod_track_audio, audio_*, canvases: [{width, height, canvas_width, canvas_height, framerate}]}.
//   Canvas 0 is OBS's main canvas; Dual Format adds the vertical canvas (Aitum Vertical) as canvas 1.
// - Response: meta.config_id; status {result: success|warning|error, html_en_us}; ingest_endpoints
//   [{protocol: RTMP|RTMPS, url_template ".../app/{stream_key}", authentication}];
//   encoder_configurations [{type, width, height, framerate, settings{bitrate, keyint_sec...}, canvas_index}]
//   (index in the array = video track id); audio_configurations {live: [...], vod?: [...]}.
// - Connect (OBS MultitrackVideoOutput.cpp + IVS integration guide): url_template with {stream_key} replaced by
//   `authentication`, then the template's query, the user's key query (e.g. bandwidthtest), then
//   `clientConfigId=<config_id>`. Track 0 is sent as single-track E-RTMP, the others as Multitrack/OneTrack
//   packets (FFmpeg >= 8 flvenc does exactly this; see server/src/media/ffmpeg-args.ts).
// - IVS disconnects multitrack streams whose track count, codec, resolution, frame rate or BITRATE don't match
//   the returned configuration, whose IDRs aren't aligned across tracks, or that lack the "broadcast
//   performance metrics" SEI before every IDR. We pass the OBS feeds through untouched, so we can only check
//   count/codec/resolution/fps here; bitrate, IDR alignment and BPM SEI are up to OBS and may still get the
//   relay disconnected. That is why this mode is experimental and "OBS direct" is the safe choice.
// - Probed live on 2026-10-11 with this exact request (and a fake key): HTTP 200 with
//   status {result: "error", html_en_us: "Your broadcast software (ctd-multi-stream) did not send GPU Information
//   which is required by GetClientConfiguration ..."}, empty encoder_configurations, and ingest endpoints whose
//   `authentication` is the plain key. The GPU check comes before the key check. We describe this machine
//   honestly (the relay never encodes, so there is no encoder GPU to report), so Twitch currently rejects the
//   relay at this step; the driver (index.ts pushPlan) then streams the landscape feed alone and
//   shows Twitch's message plus the "OBS direct" hint as a warning on the card.

import os from 'node:os';
import { fetchJson, PlatformHttpError } from '../common/http.js';
import { DriverError, type PushPlan } from '../types.js';
import { appendQuery, formatToString, type VideoFormat } from './options.js';

export const CLIENT_CONFIG_URL = 'https://ingest.twitch.tv/api/v3/GetClientConfiguration';
const SCHEMA_VERSION = '2025-01-25';
const CONFIG_TIMEOUT_MS = 10_000;
const FALLBACK = 'Use "OBS sends Dual Format directly" instead.';

interface Framerate {
  numerator?: number;
  denominator?: number;
}

export interface ClientConfigResponse {
  meta?: { service?: string; schema_version?: string; config_id?: string } | null;
  status?: { result?: string | null; html_en_us?: string | null } | null;
  ingest_endpoints?: { protocol?: string; url_template?: string; authentication?: string | null }[] | null;
  encoder_configurations?:
    | { type?: string; width?: number; height?: number; framerate?: Framerate | null; canvas_index?: number }[]
    | null;
  audio_configurations?: { live?: unknown[] | null; vod?: unknown[] | null } | null;
}

export interface MultitrackInput {
  /** The channel's stream key from Helix (no query string). */
  streamKey: string;
  landscape: VideoFormat;
  vertical: VideoFormat;
  /** Ingest server override (rtmp/rtmps base URL), or null to use the endpoint Twitch returns. */
  ingestServer: string | null;
  bandwidthTest: boolean;
  clientVersion?: string;
  now?: Date;
}

/** Collapse Twitch's HTML status message into plain text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function rejected(reason: string): DriverError {
  const text = reason.trim().replace(/[\s.!]+$/, '') || 'unknown reason';
  return new DriverError(`Twitch rejected relay Dual Format: ${text}. ${FALLBACK}`, 'misconfigured');
}

function canvas(f: VideoFormat): Record<string, unknown> {
  return { width: f.width, height: f.height, canvas_width: f.width, canvas_height: f.height, framerate: f.fps };
}

/** Honest description of this machine (no GPU encoder: the relay never encodes). */
function capabilities(): Record<string, unknown> {
  const cpus = os.cpus();
  const arch = os.arch();
  return {
    cpu: {
      physical_cores: cpus.length || 1,
      logical_cores: os.availableParallelism?.() ?? (cpus.length || 1),
      ...(cpus[0]?.speed ? { speed: cpus[0].speed } : {}),
      ...(cpus[0]?.model ? { name: cpus[0].model.trim() } : {}),
    },
    memory: { total: os.totalmem(), free: os.freemem() },
    system: {
      version: os.version(),
      name: os.type(),
      build: 0,
      release: os.release(),
      revision: '',
      bits: /64/.test(arch) ? 64 : 32,
      arm: arch.startsWith('arm'),
      armEmulation: false,
    },
  };
}

/** The GetClientConfiguration request for two canvases: landscape (0) and vertical (1). */
export function buildConfigRequest(input: MultitrackInput): Record<string, unknown> {
  return {
    service: 'IVS',
    schema_version: SCHEMA_VERSION,
    authentication: input.streamKey,
    stream_attempt_start_time: (input.now ?? new Date()).toISOString(),
    client: {
      name: 'ctd-multi-stream',
      version: input.clientVersion ?? process.env.npm_package_version ?? '0',
      supported_codecs: ['h264'],
    },
    capabilities: capabilities(),
    preferences: {
      // One rendition per canvas: the relay passes each OBS feed through as-is.
      maximum_video_tracks: 2,
      vod_track_audio: false,
      audio_samples_per_sec: 48_000,
      audio_channels: 2,
      audio_max_buffering_ms: 960,
      audio_fixed_buffering: false,
      canvases: [canvas(input.landscape), canvas(input.vertical)],
    },
  };
}

/** POST the request. HTTP/parse failures become DriverErrors (rejections are 'misconfigured'). */
export async function fetchClientConfig(
  body: Record<string, unknown>,
  signal: AbortSignal,
  url = CLIENT_CONFIG_URL,
): Promise<ClientConfigResponse> {
  try {
    const json = await fetchJson<ClientConfigResponse>(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal,
      timeoutMs: CONFIG_TIMEOUT_MS,
    });
    if (!json || typeof json !== 'object') throw rejected('empty configuration response');
    return json;
  } catch (err) {
    if (err instanceof DriverError || (err instanceof Error && err.name === 'AbortError')) throw err;
    if (err instanceof PlatformHttpError) {
      if (err.status >= 500 || err.status === 429) {
        throw new DriverError(`Twitch's Enhanced Broadcasting service is unavailable (HTTP ${err.status})`, 'platform-error');
      }
      throw rejected(statusText(err.body) || `HTTP ${err.status}`);
    }
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new DriverError("Twitch's Enhanced Broadcasting service did not respond in time", 'timeout');
    }
    throw new DriverError("Couldn't reach Twitch's Enhanced Broadcasting service", 'platform-error');
  }
}

/** status.html_en_us / message from an error body, as plain text. */
function statusText(body: string): string {
  try {
    const j = JSON.parse(body) as { status?: { html_en_us?: unknown } | unknown; message?: unknown; error?: unknown };
    const status = j.status && typeof j.status === 'object' ? (j.status as { html_en_us?: unknown }) : null;
    const text = status?.html_en_us ?? j.message ?? j.error;
    return typeof text === 'string' ? stripHtml(text) : '';
  } catch {
    return '';
  }
}

function codecOf(encoderType: string): 'h264' | 'hevc' | 'av1' {
  if (/hevc|h265|265/i.test(encoderType)) return 'hevc';
  if (/av1/i.test(encoderType)) return 'av1';
  return 'h264';
}

function sameFps(a: Framerate | null | undefined, b: VideoFormat['fps']): boolean {
  if (!a?.numerator || !a.denominator) return true; // not specified -> canvas rate
  return Math.abs(a.numerator / a.denominator - b.numerator / b.denominator) < 0.01;
}

const CANVAS_LABEL = ['landscape', 'vertical'] as const;

/**
 * Check that the configuration only asks for what a pass-through relay can send (one H.264 track
 * per feed at the feed's own size and rate, one audio track), then build the push plan.
 * `warn` receives non-fatal status warnings.
 */
export function planFromConfig(config: ClientConfigResponse, input: MultitrackInput, warn: (msg: string) => void = () => {}): PushPlan {
  const status = config.status ?? null;
  const statusMsg = status?.html_en_us ? stripHtml(status.html_en_us) : '';
  const encoders = config.encoder_configurations ?? [];
  if (status?.result === 'error') throw rejected(statusMsg || 'the configuration request failed');
  if (status?.result === 'warning') {
    if (encoders.length === 0) throw rejected(statusMsg || 'no encoder configuration returned');
    if (statusMsg) warn(statusMsg);
  }
  if (encoders.length === 0) throw rejected('no encoder configuration returned');

  // Track layout first: exactly one track on canvas 0 (landscape) and one on canvas 1 (vertical).
  const formats = [input.landscape, input.vertical];
  const perCanvas: number[] = [0, 0];
  for (const enc of encoders) {
    const idx = enc.canvas_index ?? 0;
    if (!formats[idx]) throw rejected(`it asked for an unknown canvas (${idx})`);
    perCanvas[idx] = (perCanvas[idx] ?? 0) + 1;
  }
  if (perCanvas.some((n) => n > 1)) {
    throw rejected(`it asks for an encoding ladder (${encoders.length} video tracks) but the relay can only pass one track per feed through`);
  }
  if (perCanvas[0] === 0) throw rejected('it returned no track for the landscape feed');
  if (perCanvas[1] === 0) throw rejected('it returned no track for the vertical feed (is Dual Format enabled for this channel?)');

  // Then each track must match its feed as OBS sends it (we cannot re-encode).
  for (const enc of encoders) {
    const idx = (enc.canvas_index ?? 0) as 0 | 1;
    const format = formats[idx]!;
    const label = CANVAS_LABEL[idx];
    const codec = codecOf(enc.type ?? '');
    if (codec !== 'h264') throw rejected(`it asked for ${codec.toUpperCase()} video; the feeds are H.264`);
    if (enc.width !== format.width || enc.height !== format.height || !sameFps(enc.framerate, format.fps)) {
      const fps = enc.framerate?.numerator && enc.framerate.denominator ? enc.framerate.numerator / enc.framerate.denominator : null;
      const wanted = `${enc.width ?? '?'}x${enc.height ?? '?'}${fps ? `@${Math.round(fps * 100) / 100}` : ''}`;
      throw rejected(`it wants ${wanted} for the ${label} track but the ${label} feed is set to ${formatToString(format)} (check the feed formats in this destination)`);
    }
  }
  const liveAudio = config.audio_configurations?.live ?? [];
  if (liveAudio.length !== 1) throw rejected(`it asks for ${liveAudio.length} audio tracks; the relay sends exactly one`);

  return { url: ingestUrl(config, input), mode: 'multitrack', feeds: ['landscape', 'vertical'] };
}

/** Pick an endpoint (RTMPS preferred) and build `<server>/<authentication>?...&clientConfigId=<id>`. */
function ingestUrl(config: ClientConfigResponse, input: MultitrackInput): string {
  const wantRtmps = input.ingestServer ? input.ingestServer.toLowerCase().startsWith('rtmps:') : true;
  const endpoints = (config.ingest_endpoints ?? []).filter(
    (e) => typeof e.url_template === 'string' && /^rtmp/i.test(e.protocol ?? '') && e.url_template.includes('{stream_key}'),
  );
  const endpoint =
    endpoints.find((e) => (e.protocol ?? '').toUpperCase() === (wantRtmps ? 'RTMPS' : 'RTMP')) ?? endpoints[0] ?? null;
  if (!endpoint && !input.ingestServer) throw rejected('it returned no RTMP ingest endpoint');

  const key = endpoint?.authentication?.trim() || input.streamKey;
  let base: string;
  if (input.ingestServer) {
    base = `${input.ingestServer.replace(/\/+$/, '')}/${key}`;
  } else {
    const template = endpoint!.url_template!;
    const cut = template.indexOf('/{stream_key}');
    const server = cut >= 0 ? template.slice(0, cut) : template.replace('{stream_key}', '').replace(/\/+$/, '');
    const templateQuery = template.includes('?') ? template.slice(template.indexOf('?')) : '';
    base = `${server}/${key}${templateQuery}`;
  }
  const query: [string, string][] = [];
  if (input.bandwidthTest) query.push(['bandwidthtest', 'true']);
  const configId = config.meta?.config_id?.trim();
  if (configId) query.push(['clientConfigId', configId]);
  return appendQuery(base, query);
}

/** Full flow: ask Twitch for a configuration describing both feeds and turn it into a push plan. */
export async function prepareMultitrack(
  input: MultitrackInput,
  signal: AbortSignal,
  warn?: (msg: string) => void,
  url?: string,
): Promise<PushPlan> {
  const config = await fetchClientConfig(buildConfigRequest(input), signal, url);
  return planFromConfig(config, input, warn);
}
