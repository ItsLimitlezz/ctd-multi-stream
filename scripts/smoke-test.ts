// End-to-end media relay smoke test with the real binaries in ./tools (npm run smoke).
//
//   OBS stand-in (FFmpeg test pattern) -> MediaMTX (auth via our loopback server)
//     -> PushSupervisor (FFmpeg -c copy) -> fake platform (FFmpeg -listen 1)
//
// Uses a temp DATA_DIR and free non-default ports. Prints PASS/FAIL, exit code 0/1.
// Options: --no-multitrack (skip the experimental E-RTMP multitrack check), SMOKE_LOG=debug.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import type { FeedState } from '../shared/types.js';
import { loadConfig } from '../server/src/config.js';
import { EventBus, type PushEvent } from '../server/src/events.js';
import { createPushSupervisor } from '../server/src/media/ffmpeg-supervisor.js';
import { createMediaServer } from '../server/src/media/mediamtx.js';
import type { ScopedSecrets } from '../server/src/services.js';

const OVERALL_TIMEOUT_MS = 150_000;
const withMultitrack = !process.argv.includes('--no-multitrack');

const children = new Set<ChildProcess>();

function memorySecrets(): ScopedSecrets {
  const data = new Map<string, string>();
  return {
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
    getJson: async <T>(k: string) => (data.has(k) ? (JSON.parse(data.get(k)!) as T) : null),
    setJson: async (k, v) => void data.set(k, JSON.stringify(v)),
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** Spawn FFmpeg, keeping the last stderr lines for diagnostics. */
function ffmpeg(bin: string, args: string[]): ChildProcess & { tail: string[] } {
  const child = spawn(bin, ['-hide_banner', '-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }) as ChildProcess & {
    tail: string[];
  };
  child.tail = [];
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (d: string) => {
    child.tail.push(...d.split(/\r?\n/).filter(Boolean));
    child.tail.splice(0, Math.max(0, child.tail.length - 40));
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

function exitCode(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process did not exit within ${timeoutMs / 1000} s`)), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function waitFor<T>(bus: EventBus, event: 'feed' | 'push', match: (v: T) => boolean, timeoutMs: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`));
    }, timeoutMs);
    const off = bus.on(event, ((v: T) => {
      if (!match(v)) return;
      clearTimeout(timer);
      off();
      resolve(v);
    }) as never);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  process.stdout.write(`- ${name} ... `);
  try {
    const result = await fn();
    console.log(`ok (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    return result;
  } catch (err) {
    console.log('FAILED');
    throw err;
  }
}

function testPattern(size: string, freq: number, url: string): string[] {
  return [
    '-loglevel', 'error', '-re',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30`,
    '-f', 'lavfi', '-i', `sine=frequency=${freq}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-g', '60', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-f', 'flv', url,
  ];
}

async function run(): Promise<void> {
  const [rtmpPort, apiPort, platformPort, platformPort2] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctd-smoke-'));
  const config = loadConfig({
    DATA_DIR: dataDir,
    RTMP_PORT: String(rtmpPort),
    MEDIAMTX_API_PORT: String(apiPort),
    MEDIAMTX_BIN: process.env.MEDIAMTX_BIN,
    FFMPEG_BIN: process.env.FFMPEG_BIN,
    TLS_MODE: 'off',
  });
  for (const bin of [config.mediamtxBin, config.ffmpegBin]) {
    if (!existsSync(bin)) throw new Error(`${bin} not found; run \`npm run setup-tools\` first`);
  }

  const log = pino({ level: process.env.SMOKE_LOG ?? 'warn' });
  const bus = new EventBus();
  const media = createMediaServer({ config, bus, log: log.child({ mod: 'mediamtx' }), secrets: memorySecrets() });
  const pushes = createPushSupervisor({ config, bus, log: log.child({ mod: 'ffmpeg' }), media });
  const rtmp = `rtmp://127.0.0.1:${rtmpPort}`;

  try {
    console.log(`MediaMTX ${config.mediamtxBin}\nFFmpeg   ${config.ffmpegBin}\nRTMP :${rtmpPort}, API :${apiPort}, data ${dataDir}\n`);
    await step('start MediaServer', () => media.start());
    const keys = await media.ingestKeys();

    const feed = await step('publish landscape test pattern, wait for the feed (h264)', async () => {
      const online = waitFor<FeedState>(bus, 'feed', (f) => f.feed === 'landscape' && f.online && f.video?.codec === 'h264', 30_000, 'landscape online');
      const publisher = ffmpeg(config.ffmpegBin, testPattern('1280x720', 1000, `${rtmp}/live/landscape?key=${keys.landscape}`));
      const state = await Promise.race([
        online,
        exitCode(publisher, 30_000).then((c) => {
          throw new Error(`publisher exited (${c}): ${publisher.tail.slice(-3).join(' | ')}`);
        }),
      ]);
      return state;
    });
    console.log(`  feed: ${feed.video?.codec} ${feed.video?.width}x${feed.video?.height}, audio ${feed.audio?.codec ?? 'none'}`);

    await step('reject a publish with a wrong key', async () => {
      const bad = ffmpeg(config.ffmpegBin, ['-t', '3', ...testPattern('320x240', 500, `${rtmp}/live/landscape?key=wrongkey`)]);
      const code = await exitCode(bad, 20_000);
      if (code === 0) throw new Error('publish with a wrong key was accepted');
      if (!media.feed('landscape').online) throw new Error('the real publisher was kicked out');
    });

    await step('reject a publish to an unknown path', async () => {
      const bad = ffmpeg(config.ffmpegBin, ['-t', '3', ...testPattern('320x240', 500, `${rtmp}/live/other?key=${keys.landscape}`)]);
      if ((await exitCode(bad, 20_000)) === 0) throw new Error('publish to live/other was accepted');
    });

    await step('reject a read without internal credentials', async () => {
      const reader = ffmpeg(config.ffmpegBin, ['-loglevel', 'error', '-rw_timeout', '5000000', '-i', `${rtmp}/live/landscape`, '-t', '2', '-f', 'null', '-']);
      if ((await exitCode(reader, 20_000)) === 0) throw new Error('unauthenticated read was accepted');
    });

    const platformUrl = `rtmp://127.0.0.1:${platformPort}/app/testkey`;
    const platform = ffmpeg(config.ffmpegBin, ['-loglevel', 'error', '-listen', '1', '-i', platformUrl, '-f', 'null', '-']);
    await sleep(1500); // no readiness signal; a probe connection would consume the single accept

    const running = await step('relay to a fake platform (copy), wait for running with bitrate > 0', async () => {
      const ev = waitFor<PushEvent>(bus, 'push', (e) => e.id === 'smoke' && e.status === 'running' && (e.stats?.bitrateKbps ?? 0) > 0, 30_000, 'push running');
      pushes.start('smoke', { url: platformUrl, mode: 'copy', feeds: ['landscape'] });
      return Promise.race([
        ev,
        waitFor<PushEvent>(bus, 'push', (e) => e.id === 'smoke' && e.status === 'failed', 30_000, 'push failure').then((e) => {
          throw new Error(`push failed: ${e.message}`);
        }),
      ]);
    });
    console.log(`  push: ${running.stats?.bitrateKbps} kbit/s, ${running.stats?.fps} fps, speed ${running.stats?.speed}x`);
    if (platform.exitCode !== null) throw new Error(`fake platform exited: ${platform.tail.slice(-3).join(' | ')}`);

    if (withMultitrack) {
      await step('EXPERIMENTAL multitrack: landscape + vertical in one E-RTMP connection', async () => {
        const vOnline = waitFor<FeedState>(bus, 'feed', (f) => f.feed === 'vertical' && f.online && !!f.video, 30_000, 'vertical online');
        ffmpeg(config.ffmpegBin, testPattern('720x1280', 600, `${rtmp}/live/vertical?key=${keys.vertical}`));
        await vOnline;

        const url2 = `rtmp://127.0.0.1:${platformPort2}/app/dualkey`;
        const receiver = ffmpeg(config.ffmpegBin, ['-loglevel', 'info', '-listen', '1', '-i', url2, '-map', '0', '-c', 'copy', '-t', '6', '-f', 'null', '-']);
        await sleep(1500);
        const ev = waitFor<PushEvent>(bus, 'push', (e) => e.id === 'dual' && e.status === 'running', 30_000, 'multitrack push running');
        pushes.start('dual', { url: url2, mode: 'multitrack', feeds: ['landscape', 'vertical'] });
        await ev;
        await exitCode(receiver, 30_000);
        const videos = receiver.tail.filter((l) => /Stream #0:\d+.*Video:/.test(l));
        if (videos.length < 2) throw new Error(`receiver saw ${videos.length} video track(s): ${receiver.tail.slice(-5).join(' | ')}`);
        await pushes.stop('dual');
      });
    }

    await step('stop everything', async () => {
      const stopped = waitFor<PushEvent>(bus, 'push', (e) => e.id === 'smoke' && e.status === 'stopped', 15_000, 'push stopped');
      await pushes.stopAll();
      await stopped;
      if (pushes.isRunning('smoke')) throw new Error('push still marked running');
    });

    await step('rotate the landscape key: the publisher using the old key is disconnected', async () => {
      const offline = waitFor<FeedState>(bus, 'feed', (f) => f.feed === 'landscape' && !f.online, 15_000, 'landscape offline');
      const next = await media.rotateIngestKey('landscape');
      if (next === keys.landscape) throw new Error('key did not change');
      await offline;
    });
  } finally {
    await pushes.stopAll().catch(() => {});
    for (const c of children) c.kill();
    await media.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

const timer = setTimeout(() => {
  console.error(`\nFAIL: smoke test exceeded ${OVERALL_TIMEOUT_MS / 1000} s`);
  for (const c of children) c.kill('SIGKILL');
  process.exit(1);
}, OVERALL_TIMEOUT_MS);

run()
  .then(() => {
    clearTimeout(timer);
    console.log('\nPASS');
    process.exit(0);
  })
  .catch((err: unknown) => {
    clearTimeout(timer);
    console.error(`\nFAIL: ${err instanceof Error ? err.message : String(err)}`);
    for (const c of children) c.kill('SIGKILL');
    process.exit(1);
  });
