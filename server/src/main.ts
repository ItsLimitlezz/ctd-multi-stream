// Composition root: build every service, wire them together, start listening.

import fs from 'node:fs';
import type https from 'node:https';
import path from 'node:path';
import pino from 'pino';
import type { AppSettings } from '../../shared/api.js';
import { createChatHub } from './chat/chat-hub.js';
import { createBrowserManager } from './browser/browser-manager.js';
import { loadConfig, type AppConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { createRepos } from './db/repos.js';
import { EventBus } from './events.js';
import { buildApp } from './http/app.js';
import { createPushSupervisor } from './media/ffmpeg-supervisor.js';
import { createMediaServer } from './media/mediamtx.js';
import { createOrchestrator } from './orchestrator/orchestrator.js';
import { createPlatformRegistry } from './platforms/registry.js';
import type { DriverContext } from './platforms/types.js';
import { createSecretBox, loadMasterKey } from './security/secretbox.js';
import { announceSetupCodeIfNeeded } from './security/setup-code.js';
import type { AppServices } from './services.js';
import { createTlsManager } from './tls/tls-manager.js';

export const DEFAULT_APP_SETTINGS: AppSettings = {
  publicBaseUrl: '',
  ingestHost: '',
  disconnectGraceSec: 15,
};

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Hard deadline for a graceful shutdown. Keep it under the container's stop grace period
 * (stop_grace_period: 30s in docker-compose.yml and the TrueNAS app YAML). The orchestrator
 * teardown fits inside: push stop (<= ~7 s) + end() (DEFAULT_TIMINGS.shutdownEndTimeoutMs, 15 s),
 * leaving the rest for the browser session save and closing the listeners.
 */
export const SHUTDOWN_FORCE_EXIT_MS = 28_000;

async function saveBrowserSessions(services: AppServices): Promise<void> {
  let accounts: { id: string }[];
  try {
    accounts = services.repos.accounts.list();
  } catch {
    return;
  }
  await Promise.all(
    accounts.map((a) =>
      services.browser.save(a.id).catch((err: unknown) =>
        services.log.warn({ accountId: a.id, error: err instanceof Error ? err.message : String(err) }, 'saving browser session on shutdown failed'),
      ),
    ),
  );
}

function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export async function createServices(config: AppConfig): Promise<AppServices> {
  fs.mkdirSync(config.dataDir, { recursive: true });

  const log = pino({
    level: config.logLevel,
    redact: {
      paths: ['*.password', '*.streamKey', '*.accessToken', '*.refreshToken', '*.token', '*.url', 'req.headers.cookie'],
      censor: '[redacted]',
    },
  });
  const bus = new EventBus();
  const masterKey = loadMasterKey(config);
  const secretBox = createSecretBox(masterKey);
  const db = openDatabase(path.join(config.dataDir, 'app.db'));
  const repos = createRepos(db, secretBox);

  const tls = createTlsManager({ config, log: log.child({ mod: 'tls' }), settings: repos.settings });
  const media = createMediaServer({ config, bus, log: log.child({ mod: 'mediamtx' }), secrets: repos.secrets.scoped('ingest') });
  const pushes = createPushSupervisor({ config, bus, log: log.child({ mod: 'ffmpeg' }), media });
  const browser = createBrowserManager({ config, log: log.child({ mod: 'browser' }), secrets: repos.secrets });
  const chat = createChatHub({ bus, log: log.child({ mod: 'chat' }), secrets: repos.secrets.scoped('chat') });
  const platforms = createPlatformRegistry();

  const appSettings = (): AppSettings => ({ ...DEFAULT_APP_SETTINGS, ...repos.settings.get<Partial<AppSettings>>('app', {}) });

  const publicBaseUrl = (): string => {
    const override = appSettings().publicBaseUrl.trim();
    if (override) return override.replace(/\/+$/, '');
    if (config.tlsMode === 'off') return `http://localhost:${config.webPort}`;
    const host = config.publicHost ?? tls.status().publicIp ?? config.publicIp ?? 'localhost';
    const port = config.publicPort === 443 ? '' : `:${config.publicPort}`;
    return `https://${hostForUrl(host)}${port}`;
  };

  const services = {
    config,
    log,
    bus,
    repos,
    secretBox,
    media,
    pushes,
    browser,
    chat,
    platforms,
    tls,
    appSettings,
    publicBaseUrl,
  } as Omit<AppServices, 'orchestrator' | 'driverContext'> as AppServices;

  services.driverContext = async ({ platform, accountId, destinationId, signal }): Promise<DriverContext> => {
    const app = await repos.secrets.scoped(`app:${platform}`).getJson<Record<string, string>>('values');
    return {
      log: log.child({ mod: `platform:${platform}`, accountId, destinationId }),
      accountSecrets: accountId ? repos.secrets.scoped(`account:${accountId}`) : null,
      destinationSecrets: destinationId ? repos.secrets.scoped(`destination:${destinationId}`) : null,
      app: app && Object.keys(app).length > 0 ? app : null,
      browser,
      publicBaseUrl: publicBaseUrl(),
      signal: signal ?? new AbortController().signal,
      async updateAccount(patch) {
        if (!accountId) return;
        const updated = repos.accounts.update(accountId, patch);
        bus.emit('account', updated);
      },
    };
  };

  services.orchestrator = createOrchestrator(services);
  return services;
}

export async function main(): Promise<void> {
  const config = loadConfig(process.env, readVersion());
  const services = await createServices(config);
  const { log } = services;

  await services.media.start();
  await services.orchestrator.init();

  const tlsMaterial = await services.tls.init();
  const app = await buildApp(services, tlsMaterial);
  await app.listen({ host: '0.0.0.0', port: config.webPort });
  log.info(`Web UI listening on ${tlsMaterial ? 'https' : 'http'}://0.0.0.0:${config.webPort}`);

  await services.tls.start((material) => {
    if (tlsMaterial) {
      (app.server as https.Server).setSecureContext({ key: material.key, cert: material.cert });
      log.info('TLS certificate reloaded');
    }
  });

  announceSetupCodeIfNeeded(services.repos, log);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => {
      log.warn('shutdown took too long; exiting');
      process.exit(1);
    }, SHUTDOWN_FORCE_EXIT_MS);
    force.unref();
    try {
      // Save browser sessions up front (storage state only, contexts stay open for end()), so a
      // slow end() cannot cost the login. browser.shutdown() saves again and closes afterwards.
      const earlySave = saveBrowserSessions(services);
      await services.orchestrator.shutdown();
      await earlySave;
      await services.pushes.stopAll();
      await services.browser.shutdown();
      await services.media.stop();
      await services.tls.stop();
      await app.close();
    } catch (err) {
      log.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
