// MediaServer: supervises MediaMTX (RTMP ingest for the two OBS feeds), answers its auth
// requests, and turns its control API into 'feed' events.

import type { ChildProcess } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { FEEDS, type Feed, type FeedState } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import type { EventBus } from '../events.js';
import type { MediaMtxAuthRequest, MediaServer, ScopedSecrets } from '../services.js';
import { startAuthServer, type AuthServer } from './auth-server.js';
import { authorizeMediaRequest, generateKey, INGEST_SECRET_NAMES, isValidKey, type IngestSecrets } from './authorize.js';
import { FeedTracker, offlineFeedState, shouldEmitFeed, type MtxPath } from './feed-state.js';
import { createMediaMtxApi, type FetchFn } from './mediamtx-api.js';
import { buildMediaMtxConfig } from './mediamtx-config.js';
import { APP_NAME, feedPath, INTERNAL_READER_USER } from './paths.js';
import { defaultSpawn, onLines, terminate, type SpawnFn } from './process-utils.js';
import { redactSecretsInText } from './redact.js';

export interface MediaServerDeps {
  spawn?: SpawnFn;
  fetch?: FetchFn;
  now?: () => number;
  pollIntervalMs?: number;
  /** How long start() waits for the control API to answer (0 = don't wait). */
  readyTimeoutMs?: number;
}

const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 30_000;
const HEALTHY_AFTER_MS = 60_000;
const POLL_FAILURES_BEFORE_OFFLINE = 3;

export function createMediaServer(
  { config, bus, log, secrets }: { config: AppConfig; bus: EventBus; log: Logger; secrets: ScopedSecrets },
  deps: MediaServerDeps = {},
): MediaServer {
  const spawn = deps.spawn ?? defaultSpawn;
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? 1_000;
  const readyTimeoutMs = deps.readyTimeoutMs ?? 5_000;
  const api = createMediaMtxApi(config.mediamtxApiPort, deps.fetch);
  const workDir = path.join(config.dataDir, 'mediamtx');
  const configPath = path.join(workDir, 'mediamtx.yml');
  const bin = config.mediamtxBin;
  const notFound = `MediaMTX not found at ${bin}; run \`npm run setup-tools\` (or set MEDIAMTX_BIN). Feeds stay offline.`;

  let keys: IngestSecrets | null = null;
  let keysLoading: Promise<IngestSecrets> | null = null;
  let auth: AuthServer | null = null;
  let running = false;
  let proc: ChildProcess | null = null;
  let procStartedAt = 0;
  let restartAttempt = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let pollAbort = new AbortController();
  let pollFailures = 0;
  let lastError: string | null = null;

  const trackers = new Map<Feed, FeedTracker>(FEEDS.map((f) => [f, new FeedTracker(f)]));
  const emitted = new Map<Feed, { state: FeedState; at: number }>(FEEDS.map((f) => [f, { state: offlineFeedState(f), at: 0 }]));

  // ---- keys -------------------------------------------------------------

  async function loadKeys(): Promise<IngestSecrets> {
    const out: Partial<IngestSecrets> = {};
    for (const name of INGEST_SECRET_NAMES) {
      let value = await secrets.get(name);
      if (!isValidKey(value)) {
        value = generateKey();
        await secrets.set(name, value);
        log.info({ key: name }, 'Generated new ingest secret');
      }
      out[name] = value;
    }
    return out as IngestSecrets;
  }

  function ensureKeys(): Promise<IngestSecrets> {
    if (keys) return Promise.resolve(keys);
    keysLoading ??= loadKeys()
      .then((k) => (keys = k))
      .finally(() => {
        keysLoading = null;
      });
    return keysLoading;
  }

  // ---- feed state -------------------------------------------------------

  function publish(feed: Feed, state: FeedState): void {
    const prev = emitted.get(feed);
    const t = now();
    if (!shouldEmitFeed(prev?.state ?? null, state, prev?.at ?? 0, t)) return;
    emitted.set(feed, { state, at: t });
    bus.emit('feed', { ...state });
  }

  function applyPaths(items: MtxPath[]): void {
    const t = now();
    for (const [feed, tracker] of trackers) {
      publish(feed, tracker.update(items.find((p) => p.name === feedPath(feed)), t));
    }
  }

  function markAllOffline(): void {
    for (const [feed, tracker] of trackers) publish(feed, tracker.reset());
  }

  // ---- polling ----------------------------------------------------------

  function schedulePoll(): void {
    if (!running || pollTimer) return;
    pollTimer = setTimeout(() => void pollOnce(), pollIntervalMs);
  }

  async function pollOnce(): Promise<void> {
    pollTimer = null;
    if (!running) return;
    if (proc) {
      try {
        const items = await api.listPaths(pollAbort.signal);
        pollFailures = 0;
        if (running && proc) applyPaths(items);
      } catch (err) {
        pollFailures++;
        if (pollFailures === POLL_FAILURES_BEFORE_OFFLINE) {
          log.debug({ err: err instanceof Error ? err.message : String(err) }, 'MediaMTX API not answering; marking feeds offline');
        }
        if (pollFailures >= POLL_FAILURES_BEFORE_OFFLINE) markAllOffline();
      }
    }
    schedulePoll();
  }

  async function waitForApi(timeoutMs: number): Promise<boolean> {
    const deadline = now() + timeoutMs;
    while (running && proc && now() < deadline) {
      try {
        await api.listPaths(pollAbort.signal);
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    return false;
  }

  // ---- process ----------------------------------------------------------

  function onLogLine(line: string): void {
    // "2026/10/11 17:01:26 INF [RTMP] ..." -> "INF [RTMP] ..."
    const text = redactSecretsInText(line.replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}(\.\d+)? /, '').trim());
    if (!text) return;
    if (text.startsWith('ERR ')) {
      lastError = text.slice(4);
      log.warn(`mediamtx: ${text}`);
    } else {
      log.debug(`mediamtx: ${text}`);
    }
  }

  function killOnExit(): void {
    // Don't leave an orphaned MediaMTX holding the ports if Node dies without stop().
    try {
      proc?.kill();
    } catch {
      // ignore
    }
  }

  async function binaryAvailable(): Promise<boolean> {
    // Bare command names (resolved through PATH) are checked by spawn itself.
    if (!bin.includes('/') && !bin.includes('\\')) return true;
    try {
      await fs.access(bin, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  function spawnProcess(): void {
    lastError = null;
    let child: ChildProcess;
    try {
      child = spawn(bin, [configPath], { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      log.error({ err }, notFound);
      return;
    }
    proc = child;
    procStartedAt = now();
    onLines(child.stdout, onLogLine);
    onLines(child.stderr, onLogLine);

    let ended = false;
    const onEnd = (code: number | null, signal: NodeJS.Signals | null, spawnError?: NodeJS.ErrnoException) => {
      if (ended) return;
      ended = true;
      if (proc !== child) return;
      proc = null;
      markAllOffline();
      if (!running) return;
      if (spawnError && (spawnError.code === 'ENOENT' || spawnError.code === 'EACCES')) {
        log.error(notFound);
        return; // nothing to retry until the binary is installed
      }
      if (now() - procStartedAt >= HEALTHY_AFTER_MS) restartAttempt = 0;
      const delay = Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** restartAttempt);
      restartAttempt++;
      log.warn(
        { code, signal, lastError, attempt: restartAttempt },
        `MediaMTX exited unexpectedly; restarting in ${Math.round(delay / 1000)} s`,
      );
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (running && !proc) spawnProcess();
      }, delay);
    };
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (child.pid === undefined) onEnd(null, null, err);
      else log.warn({ err }, 'MediaMTX process error');
    });
    child.on('exit', (code, signal) => onEnd(code, signal));
    if (child.pid !== undefined) log.info({ pid: child.pid, rtmpPort: config.rtmpPort }, 'MediaMTX started');
  }

  // ---- MediaServer ------------------------------------------------------

  const server: MediaServer = {
    appName: APP_NAME,

    async start() {
      if (running) return;
      running = true;
      restartAttempt = 0;
      pollAbort = new AbortController();
      try {
        await ensureKeys();
        auth ??= await startAuthServer({ authorize: (req) => server.authorize(req), log });
        await fs.mkdir(workDir, { recursive: true });
        await fs.writeFile(
          configPath,
          buildMediaMtxConfig({ rtmpPort: config.rtmpPort, apiPort: config.mediamtxApiPort, authPort: auth.port }),
          { mode: 0o600 },
        );
      } catch (err) {
        running = false;
        await auth?.close();
        auth = null;
        throw err;
      }

      if (!(await binaryAvailable())) {
        log.error(notFound);
        return;
      }
      process.once('exit', killOnExit);
      spawnProcess();
      schedulePoll();
      if (readyTimeoutMs > 0 && proc && !(await waitForApi(readyTimeoutMs))) {
        log.warn('MediaMTX control API did not answer yet; feeds will appear once it does');
      }
    },

    async stop() {
      running = false;
      pollAbort.abort();
      if (pollTimer) clearTimeout(pollTimer);
      if (restartTimer) clearTimeout(restartTimer);
      pollTimer = null;
      restartTimer = null;
      process.off('exit', killOnExit);
      const child = proc;
      if (child) await terminate(child, 5_000);
      proc = null;
      await auth?.close();
      auth = null;
      markAllOffline();
    },

    feeds() {
      return FEEDS.map((f) => server.feed(f));
    },

    feed(feed) {
      const state = trackers.get(feed)?.current() ?? offlineFeedState(feed);
      return { ...state };
    },

    readUrl(feed) {
      if (!keys) throw new Error('Media server not started');
      const pass = encodeURIComponent(keys.internalReader);
      return `rtmp://127.0.0.1:${config.rtmpPort}/${feedPath(feed)}?user=${INTERNAL_READER_USER}&pass=${pass}`;
    },

    authorize(req: MediaMtxAuthRequest) {
      return authorizeMediaRequest(req, keys);
    },

    async ingestKeys() {
      const k = await ensureKeys();
      return { landscape: k.landscape, vertical: k.vertical };
    },

    async rotateIngestKey(feed) {
      const current = await ensureKeys();
      const next = generateKey();
      await secrets.set(feed, next);
      keys = { ...current, [feed]: next };
      log.info({ feed }, 'Ingest key rotated');
      if (proc) {
        // The old key stops working immediately; also drop a publisher that is still connected with it.
        try {
          if (await api.kickPublisher(feedPath(feed))) log.info({ feed }, 'Disconnected the publisher using the old key');
        } catch (err) {
          log.warn({ feed, err: err instanceof Error ? err.message : String(err) }, 'Could not disconnect the current publisher');
        }
      }
      return next;
    },
  };

  return server;
}
