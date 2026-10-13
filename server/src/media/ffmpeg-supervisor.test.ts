import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config.js';
import { EventBus, type PushEvent } from '../events.js';
import type { PushPlan } from '../platforms/types.js';
import type { MediaServer } from '../services.js';
import { MULTITRACK_UNSUPPORTED } from './ffmpeg-args.js';
import {
  backoffDelay,
  createPushSupervisor,
  explainFfmpegError,
  pickMessage,
  type PushSupervisorDeps,
} from './ffmpeg-supervisor.js';
import { captureLogger, fakeSpawn, flush, type FakeChild } from './test-helpers.js';

const SECRET = 'sk_live_SECRET123456';
const READER_PASS = 'readerpass123456';
const config = { ffmpegBin: '/opt/tools/ffmpeg' } as AppConfig;
const media = {
  readUrl: (feed: string) => `rtmp://127.0.0.1:1935/live/${feed}?user=internal&pass=${READER_PASS}`,
} as unknown as MediaServer;
const plan: PushPlan = { url: `rtmp://live.example.com/app/${SECRET}`, mode: 'copy', feeds: ['landscape'] };

function setup(deps: PushSupervisorDeps = {}) {
  const bus = new EventBus();
  const events: PushEvent[] = [];
  bus.on('push', (e) => events.push(e));
  const sp = fakeSpawn();
  const cap = captureLogger();
  const sup = createPushSupervisor(
    { config, bus, log: cap.log, media },
    { spawn: sp.spawn, now: () => Date.now(), probeCapabilities: async () => ({ multitrack: true }), ...deps },
  );
  const child = (): FakeChild => {
    const c = sp.last()?.child;
    if (!c) throw new Error('no process spawned');
    return c;
  };
  return { sup, events, sp, child, logs: cap.text, last: () => events.at(-1) };
}

async function progress(child: FakeChild, outTimeUs: number, totalSize = 0): Promise<void> {
  child.stdout.write(`fps=30.00\nbitrate=2500.0kbits/s\ntotal_size=${totalSize}\nout_time_us=${outTimeUs}\nspeed=1.00x\nprogress=continue\n`);
  await flush();
}

async function crash(child: FakeChild, stderr: string, code = 1): Promise<void> {
  child.stderr.write(stderr);
  await flush();
  child.exit(code);
  await flush();
}

const ERR_OUTPUT = `[rtmp @ 0000021f] Server error: invalid stream key ${SECRET}\n[out#0/flv @ 0x55] Error opening output rtmp://live.example.com/app/${SECRET}: I/O error\nConversion failed!\n`;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('helpers', () => {
  it('backs off 1, 2, 4 ... 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it('picks the most specific stderr line', () => {
    expect(pickMessage(['[tcp @ 0x1] Connection refused', 'Conversion failed!'])).toBe('Connection refused');
    expect(pickMessage(['Exiting normally, received signal 15.'])).toBe('Exiting normally, received signal 15.');
    expect(pickMessage([])).toBeNull();
  });

  it('explains common network failures in plain words', () => {
    const cases: [string, RegExp][] = [
      ['Error opening output files: Error number -138 occurred', /^Timed out connecting/],
      ['Connection to tcp://live.example.com:1935 failed: Connection timed out', /^Timed out connecting/],
      ['Error number -10060 occurred', /^Timed out connecting/],
      ['Connection to tcp://live.example.com:1935 failed: Connection refused', /refused the connection/],
      ['Error opening output files: Error number -107 occurred', /refused the connection/],
      ['Error number -10061 occurred', /refused the connection/],
      ['Failed to resolve hostname live.example.com: Name or service not known', /^Can't find the platform's server/],
      ['Error number -11001 occurred', /^Can't find the platform's server/],
      ['Error number -110 occurred', /^Can't reach the platform's server/],
      ['No route to host', /^Can't reach the platform's server/],
      ['Error opening output rtmp://live.example.com: I/O error', /closed the connection/],
      ['av_interleaved_write_frame(): Broken pipe', /closed the connection/],
      ['Error writing trailer: Connection reset by peer', /closed the connection/],
      ['Error number -10054 occurred', /closed the connection/],
      ['Server error: invalid stream key [redacted]', /rejected the stream/],
      ['HTTP error 403 Forbidden: Server returned 403 Forbidden (access denied)', /rejected the stream/],
    ];
    for (const [line, expected] of cases) expect(explainFfmpegError(line), line).toMatch(expected);
  });

  it('leaves unrelated or local-feed errors alone', () => {
    expect(explainFfmpegError('Codec not supported')).toBeNull();
    // Bare numbers (ports, bitrates, timestamps) are not errno codes.
    expect(explainFfmpegError('frame=  401 fps= 30 bitrate=-5.0kbits/s size=403kB time=00:00:13.36')).toBeNull();
    expect(explainFfmpegError('Error number -5 happened elsewhere')).toBeNull();
    // The local MediaMTX feed failing is not the platform's fault.
    expect(explainFfmpegError('rtmp://127.0.0.1:1935/live/landscape: Input/output error')).toBeNull();
    expect(explainFfmpegError('Error during demuxing: Input/output error')).toBeNull();
  });
});

describe('PushSupervisor', () => {
  it('spawns FFmpeg with the media read URL and reports starting -> running -> stats', async () => {
    const { sup, events, sp, child, last } = setup();
    sup.start('d1', plan);
    await flush();

    expect(sp.calls).toHaveLength(1);
    const call = sp.calls[0]!;
    expect(call.command).toBe('/opt/tools/ffmpeg');
    expect(call.args).toContain(media.readUrl('landscape'));
    expect(call.args.at(-1)).toBe(plan.url);
    expect(events).toEqual([{ id: 'd1', status: 'starting', message: null, stats: null, attempt: 0 }]);
    expect(sup.isRunning('d1')).toBe(true);

    await progress(child(), 0); // connected but nothing written yet
    expect(events).toHaveLength(1);

    await progress(child(), 2_000_000, 625_000);
    expect(last()).toMatchObject({ status: 'running', attempt: 0, stats: { bitrateKbps: 2500, fps: 30, speed: 1, uptimeSec: 2 } });

    vi.advanceTimersByTime(1000);
    await progress(child(), 3_000_000, 1_000_000);
    expect(events).toHaveLength(2); // rate limited

    vi.advanceTimersByTime(1000);
    await progress(child(), 4_000_000, 1_375_000);
    expect(events).toHaveLength(3);
    expect(last()?.stats?.bitrateKbps).toBe(3000); // (1_375_000 - 1_000_000) * 8 / 1 s

    await sup.stop('d1');
  });

  it('retries unexpected exits with exponential backoff and a redacted message', async () => {
    const { sup, sp, child, last, logs, events } = setup();
    sup.start('d1', plan);
    await flush();

    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const [i, delay] of delays.entries()) {
      await crash(child(), ERR_OUTPUT);
      expect(last()).toMatchObject({ status: 'retrying', attempt: i + 1, stats: null });
      expect(last()?.message).toBe('The platform closed the connection. Check the stream key and server URL.');

      const count = sp.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sp.calls).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(sp.calls).toHaveLength(count + 1);
      expect(last()).toMatchObject({ status: 'starting', attempt: i + 1 });
    }

    expect(logs()).not.toContain(SECRET);
    expect(logs()).not.toContain(READER_PASS);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    await sup.stop('d1');
  });

  it('redacts a stream key echoed without its URL', async () => {
    const { sup, child, last, logs } = setup();
    sup.start('d1', plan);
    await flush();
    await crash(child(), `[rtmp @ 0x1] Server error: invalid stream key ${SECRET}\n`);
    // The card gets the plain sentence; the (redacted) raw line stays in the logs.
    expect(last()?.message).toBe('The platform rejected the stream. Check the stream key.');
    expect(logs()).toContain('Server error: invalid stream key [redacted]');
    expect(logs()).not.toContain(SECRET);
    await sup.stop('d1');
  });

  it('shows unrecognised FFmpeg errors unchanged', async () => {
    const { sup, child, last } = setup();
    sup.start('d1', plan);
    await flush();
    await crash(child(), '[flv @ 0x1] Codec not supported\n');
    expect(last()?.message).toBe('Codec not supported');
    await sup.stop('d1');
  });

  it('resets the attempt counter after 60 s of healthy streaming', async () => {
    const { sup, child, last } = setup({ stallTimeoutMs: 10 * 60_000 });
    sup.start('d1', plan);
    await flush();
    await crash(child(), 'boom\n');
    await vi.advanceTimersByTimeAsync(1000);
    await crash(child(), 'boom\n');
    expect(last()).toMatchObject({ status: 'retrying', attempt: 2 });

    await vi.advanceTimersByTimeAsync(2000);
    await progress(child(), 1_000_000);
    expect(last()).toMatchObject({ status: 'running', attempt: 2 });
    await vi.advanceTimersByTimeAsync(61_000);
    await crash(child(), 'boom\n');
    expect(last()).toMatchObject({ status: 'retrying', attempt: 1, message: 'boom' });
    await sup.stop('d1');
  });

  it('stop() terminates FFmpeg, emits stopped and never respawns', async () => {
    const { sup, sp, child, last } = setup();
    sup.start('d1', plan);
    await flush();
    await progress(child(), 1_000_000);

    const proc = child();
    await sup.stop('d1');
    expect(proc.signals).toEqual([process.platform === 'win32' ? undefined : 'SIGTERM']);
    expect(last()).toMatchObject({ id: 'd1', status: 'stopped' });
    expect(sup.isRunning('d1')).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(sp.calls).toHaveLength(1);
    await sup.stop('d1'); // idempotent
  });

  it('escalates to SIGKILL when FFmpeg ignores SIGTERM for 5 s', async () => {
    const { sup, child } = setup();
    sup.start('d1', plan);
    await flush();
    const proc = child();
    proc.ignore.add('SIGTERM');

    let done = false;
    const stopping = sup.stop('d1').then(() => (done = true));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(proc.signals.at(-1)).toBe('SIGKILL');
  });

  it('concurrent stop() calls both wait for the exit and emit stopped once', async () => {
    const { sup, child, events } = setup();
    sup.start('d1', plan);
    await flush();
    child().ignore.add('SIGTERM');
    let a = false;
    let b = false;
    const s1 = sup.stop('d1').then(() => (a = true));
    const s2 = sup.stop('d1').then(() => (b = true));
    await flush();
    expect([a, b]).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([s1, s2]);
    expect(events.filter((e) => e.status === 'stopped')).toHaveLength(1);
  });

  it('stop() during the retry wait cancels the retry', async () => {
    const { sup, sp, child, events } = setup();
    sup.start('d1', plan);
    await flush();
    await crash(child(), 'boom\n');
    await sup.stop('d1');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sp.calls).toHaveLength(1);
    expect(events.map((e) => e.status)).toEqual(['starting', 'retrying', 'stopped']);
  });

  it('start() on a running id restarts it without a stopped event', async () => {
    const { sup, sp, events } = setup();
    sup.start('d1', plan);
    await flush();
    const first = sp.calls[0]!.child;

    const plan2: PushPlan = { ...plan, url: 'rtmp://other.example.com/app/anotherkey99' };
    sup.start('d1', plan2);
    await flush();
    expect(first.signals).toHaveLength(1);
    expect(sp.calls).toHaveLength(2);
    expect(sp.calls[1]!.args.at(-1)).toBe(plan2.url);
    expect(events.map((e) => e.status)).toEqual(['starting', 'starting']);
    expect(sup.isRunning('d1')).toBe(true);
    await sup.stopAll();
    expect(sup.isRunning('d1')).toBe(false);
  });

  it('fails (no retry) when FFmpeg is missing', async () => {
    const { sup, sp, child, last } = setup();
    sup.start('d1', plan);
    await flush();
    child().failToSpawn('ENOENT');
    await flush();
    expect(last()).toMatchObject({ status: 'failed' });
    expect(last()?.message).toContain('npm run setup-tools');
    expect(sup.isRunning('d1')).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sp.calls).toHaveLength(1);
  });

  it('fails multitrack plans when the FFmpeg build cannot mux them', async () => {
    const { sup, sp, last } = setup({ probeCapabilities: async () => ({ multitrack: false }) });
    sup.start('d1', { ...plan, mode: 'multitrack', feeds: ['landscape', 'vertical'] });
    await flush();
    expect(sp.calls).toHaveLength(0);
    expect(last()).toMatchObject({ status: 'failed', message: MULTITRACK_UNSUPPORTED });
  });

  it('builds multitrack pushes from both feeds when supported', async () => {
    const { sup, sp } = setup();
    sup.start('d1', { ...plan, mode: 'multitrack', feeds: ['landscape', 'vertical'] });
    await flush();
    expect(sp.calls[0]?.args).toEqual(expect.arrayContaining([media.readUrl('landscape'), media.readUrl('vertical'), '1:v:0']));
    await sup.stop('d1');
  });

  it('kills and retries a stalled FFmpeg', async () => {
    const { sup, child, last } = setup({ stallTimeoutMs: 30_000 });
    sup.start('d1', plan);
    await flush();
    const proc = child();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(proc.signals).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(proc.signals).toEqual(['SIGKILL']);
    expect(last()).toMatchObject({ status: 'retrying', attempt: 1, message: 'No progress from FFmpeg for 30 s' });
    await sup.stop('d1');
  });
});
