// Local end-to-end rig for CTD Relay (dev only): test-pattern "OBS" feeds into a running dev Relay,
// and a fake RTMP platform that receives what Relay relays. Lets Relay go live on one machine with
// no OBS, no platform account and nobody watching.
//
//   npm run dev:sim        (the dev server must be running: .claude/launch.json "ctd-dev")
//
// It signs in to the dev Relay, reads the OBS stream keys, makes sure a Custom RTMP destination
// "Local sink (dev-sim)" points at the fake platform, then publishes landscape (1920x1080@60) and
// vertical (1080x1920@30) test patterns with 2 s keyframes, restarting them if they stop. Press
// Ctrl+C to stop everything. Start a session in the web UI to go live.
//
// Env: SIM_BASE (default http://localhost:8443), SIM_USER / SIM_PASS (default: the local
// data-dev/TEST-CREDENTIALS.txt), SIM_SINK_PORT (19400), SIM_VERTICAL=0 (landscape only),
// FFMPEG_BIN (default tools/ffmpeg).

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeIngest } from '../server/src/media/rtmp-test-server.js';

const base = (process.env.SIM_BASE ?? 'http://localhost:8443').replace(/\/+$/, '');
const sinkPort = Number(process.env.SIM_SINK_PORT ?? 19400);
const withVertical = process.env.SIM_VERTICAL !== '0';
const ffmpeg = process.env.FFMPEG_BIN ?? path.resolve('tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const SINK_NAME = 'Local sink (dev-sim)';

function credentials(): { username: string; password: string } {
  if (process.env.SIM_USER && process.env.SIM_PASS) return { username: process.env.SIM_USER, password: process.env.SIM_PASS };
  const text = fs.readFileSync(path.resolve('data-dev', 'TEST-CREDENTIALS.txt'), 'utf8');
  const username = /username:\s*(\S+)/.exec(text)?.[1];
  const password = /password:\s*(\S+)/.exec(text)?.[1];
  if (!username || !password) throw new Error('Set SIM_USER and SIM_PASS (no data-dev/TEST-CREDENTIALS.txt)');
  return { username, password };
}

let cookie = '';
let csrf = '';
async function api<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: { cookie, ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0]!;
  if (!res.ok) throw new Error(`${method} ${route} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

const children = new Set<ChildProcess>();
let stopping = false;

/** Publish a test pattern to `url`, restarting it whenever it stops. */
function publish(name: string, url: string, size: string, fps: number, kbps: number): void {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-re',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${fps}`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps}k`,
    '-g', String(fps * 2), '-keyint_min', String(fps * 2), '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-f', 'flv', url,
  ];
  const run = () => {
    if (stopping) return;
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    children.add(child);
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[${name}] ${d}`));
    child.on('close', (code) => {
      children.delete(child);
      if (stopping) return;
      console.log(`[${name}] stopped (code ${code}); restarting in 3 s`);
      setTimeout(run, 3000);
    });
    console.log(`[${name}] publishing ${size}@${fps} ${kbps} kbps`);
  };
  run();
}

const { username, password } = credentials();
const me = await api<{ csrfToken: string }>('POST', '/api/auth/login', { username, password });
csrf = me.csrfToken;
console.log(`signed in to ${base} as ${username}`);

const ingest = await api<{ feeds: { feed: string; fullUrl: string }[] }>('GET', '/api/ingest');
const local = (u: string) => u.replace(/^rtmp:\/\/[^/]+/, (m) => m.replace(/\/\/[^:/]+/, '//127.0.0.1'));

const sink = await startFakeIngest({ port: sinkPort });
const sinkUrl = `rtmp://127.0.0.1:${sink.port}/live`;
const dests = await api<{ id: string; name: string; platform: string }[]>('GET', '/api/destinations');
const existing = dests.find((d) => d.name === SINK_NAME);
if (existing) {
  await api('PATCH', `/api/destinations/${existing.id}`, { ingestUrl: sinkUrl, streamKey: 'sim' });
  console.log(`"${SINK_NAME}" now points at ${sinkUrl}`);
} else {
  await api('POST', '/api/destinations', { platform: 'custom', name: SINK_NAME, feed: 'landscape', ingestUrl: sinkUrl, streamKey: 'sim' });
  console.log(`created "${SINK_NAME}" -> ${sinkUrl}`);
}

for (const f of ingest.feeds) {
  if (f.feed === 'vertical' && !withVertical) continue;
  if (f.feed === 'landscape') publish('landscape', local(f.fullUrl), '1920x1080', 60, 6000);
  if (f.feed === 'vertical') publish('vertical', local(f.fullUrl), '1080x1920', 30, 4000);
}

let lastCount = 0;
const report = setInterval(() => {
  const n = sink.messages.length;
  const bytes = sink.messages.reduce((s, m) => s + m.payload.length, 0);
  if (n !== lastCount) console.log(`fake platform: ${n} messages, ${(bytes / 1e6).toFixed(1)} MB received`);
  lastCount = n;
  // Keep memory flat on long runs: the count is all this rig needs.
  if (sink.messages.length > 5000) sink.messages.splice(0, sink.messages.length - 100);
}, 5000);

const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(report);
  for (const c of children) c.kill();
  await sink.close();
  console.log('dev-sim stopped');
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
