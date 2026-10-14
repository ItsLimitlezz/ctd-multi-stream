// TLS manager: picks and maintains the certificate the HTTPS server presents.
//
//   off          plain HTTP, nothing to do
//   manual       TLS_CERT_FILE / TLS_KEY_FILE, re-read every minute
//   self-signed  generated + persisted, regenerated when names change or it nears expiry
//   letsencrypt  ACME HTTP-01 for PUBLIC_HOST, else the public IP (shortlived IP cert);
//                serves the self-signed certificate until the first issuance succeeds
//   auto         letsencrypt when the public IP is reachable, else self-signed

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { Logger } from 'pino';
import type { TlsMode, TlsStatus } from '../../../shared/types.js';
import type { AppConfig } from '../config.js';
import type { LanHandler, SettingsRepo, TlsManager, TlsMaterial } from '../services.js';
import {
  acmeDirectoryUrl,
  AcmeIssueError,
  createAcmeApi,
  createEcKey,
  issueCertificate,
  LE_SUBSCRIBER_AGREEMENT,
  type AcmeApi,
  type AcmeIdentifier,
} from './acme.js';
import { backoffDelayMs, coversNames, keyMatchesCert, readCertInfo, renewalTime, subjectLabel, type CertInfo, type CertNames } from './cert-info.js';
import { loadOrCreateKey, readPemPair, writePemPair } from './cert-store.js';
import { createHttpListener, lanClientPolicy, type ChallengeStore, type HttpListener, type LanClientPolicy } from './http-listener.js';
import { classifyIp, describeIpClass, discoverPublicIp, localIPv4Addresses, normalizeIp } from './public-ip.js';
import { isValidHostname, loadOrCreateSelfSigned, selfSignedNames, SELF_SIGNED_MIN_REMAINING_MS } from './self-signed.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Settings key holding the ACME failure backoff, so restarts don't hammer Let's Encrypt. */
export const ACME_STATE_KEY = 'tls.acme';
/** A restart retries sooner (users restart after fixing port forwarding) but never in a tight loop. */
const RESTART_BACKOFF_CAP_MS = 15 * MINUTE;
const MAX_TIMER_MS = 2 ** 31 - 1;

interface AcmeState {
  identifier: string;
  failures: number;
  nextAttemptAt: string;
  lastError: string | null;
}

export interface TlsTimings {
  /** Delay before the first issuance attempt after start(). */
  firstCheckMs: number;
  /** Renewal / maintenance check interval. */
  checkIntervalMs: number;
  /** Public IP re-discovery interval. */
  ipRecheckMs: number;
  /** Manual certificate file re-read interval. */
  manualPollMs: number;
}

export interface TlsManagerDeps {
  createAcmeApi: (opts: { directoryUrl: string; accountKey: string }) => AcmeApi;
  discoverPublicIp: (signal: AbortSignal) => Promise<string | null>;
  lanAddresses: () => string[];
  /** Private key generator for issued certificates. */
  generateCertKey: () => Promise<string>;
  now: () => number;
  timings: TlsTimings;
  /** Which peers get /api/v1, /dock and /overlay over plain HTTP (default: LAN_HTTP / LAN_HTTP_CIDRS env). */
  lanPolicy: LanClientPolicy;
}

export const DEFAULT_TLS_TIMINGS: TlsTimings = {
  firstCheckMs: 3_000,
  checkIntervalMs: HOUR,
  ipRecheckMs: 30 * MINUTE,
  manualPollMs: MINUTE,
};

type Source = TlsStatus['source'];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function identifierKey(id: AcmeIdentifier): string {
  return `${id.type}:${id.value}`;
}

function namesFor(id: AcmeIdentifier): CertNames {
  return id.type === 'ip' ? { dns: [], ip: [id.value] } : { dns: [id.value], ip: [] };
}

function fingerprintOf(m: TlsMaterial): string {
  return crypto.createHash('sha256').update(m.key).update('\0').update(m.cert).digest('hex');
}

function validEmail(value: string | null): string | null {
  const email = value?.trim() ?? '';
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email : null;
}

class DefaultTlsManager implements TlsManager {
  readonly mode: TlsMode;

  private readonly config: AppConfig;
  private readonly log: Logger;
  private readonly settings: SettingsRepo;
  private readonly deps: TlsManagerDeps;
  private readonly tlsDir: string;
  private readonly leKeyFile: string;
  private readonly leCertFile: string;
  private readonly accountKeyFile: string;
  private readonly challenges: ChallengeStore = new Map();

  private material: TlsMaterial | null = null;
  private materialId: string | null = null;
  private info: CertInfo | null = null;
  private source: Source = 'none';
  private publicIp: string | null = null;
  private lastError: string | null = null;
  private listenerError: string | null = null;
  private nextRenewalAt: Date | null = null;

  private onRenew: ((m: TlsMaterial) => void) | null = null;
  private listener: HttpListener | null = null;
  private lanHandler: LanHandler | null = null;
  private abort = new AbortController();
  private started = false;
  private stopped = false;
  private checkTimer: NodeJS.Timeout | null = null;
  private intervals: NodeJS.Timeout[] = [];
  private checking: Promise<void> | null = null;
  private recheckRequested = false;
  private acmeApi: AcmeApi | null = null;
  private acmeState: AcmeState | null = null;
  private agreementLogged = false;

  constructor(opts: { config: AppConfig; log: Logger; settings: SettingsRepo }, deps: TlsManagerDeps) {
    this.config = opts.config;
    this.log = opts.log;
    this.settings = opts.settings;
    this.deps = deps;
    this.mode = opts.config.tlsMode;
    this.tlsDir = path.join(opts.config.dataDir, 'tls');
    this.leKeyFile = path.join(this.tlsDir, 'le.key');
    this.leCertFile = path.join(this.tlsDir, 'le.crt');
    this.accountKeyFile = path.join(this.tlsDir, 'acme-account.key');
  }

  // -------------------------------------------------------------------------
  // TlsManager
  // -------------------------------------------------------------------------

  async init(): Promise<TlsMaterial | null> {
    switch (this.mode) {
      case 'off':
        return null;
      case 'manual': {
        const loaded = await this.readManual();
        this.setMaterial(loaded.material, loaded.info, 'manual');
        this.lastError = this.manualExpiryWarning(loaded.info);
        return loaded.material;
      }
      case 'self-signed':
        await fs.mkdir(this.tlsDir, { recursive: true, mode: 0o700 });
        await this.refreshPublicIp();
        await this.ensureSelfSigned();
        return this.material;
      case 'letsencrypt':
      case 'auto': {
        await fs.mkdir(this.tlsDir, { recursive: true, mode: 0o700 });
        this.restoreAcmeState();
        await this.refreshPublicIp();
        const target = this.acmeTarget();
        const loaded = 'identifier' in target ? await this.loadLe(target.identifier) : null;
        if (!loaded) await this.ensureSelfSigned();
        if ('error' in target) this.lastError = target.error;
        else if (!loaded) this.lastError = this.acmeStateFor(target.identifier)?.lastError ?? null;
        return this.material;
      }
    }
  }

  async start(onRenew: (m: TlsMaterial) => void): Promise<void> {
    if (this.mode === 'off' || this.started || this.stopped) return;
    if (!this.material) throw new Error('TlsManager.start() called before init()');
    this.started = true;
    this.onRenew = onRenew;

    await this.startListener();

    this.every(this.deps.timings.ipRecheckMs, () => this.onIpRecheck());
    if (this.mode === 'manual') {
      this.every(this.deps.timings.manualPollMs, () => this.pollManual());
      // Public IP is only informational here (public URLs); don't delay startup for it.
      if (!this.publicIp) void this.refreshPublicIp().catch(() => undefined);
    } else {
      this.scheduleCheck(this.mode === 'self-signed' ? this.deps.timings.checkIntervalMs : this.deps.timings.firstCheckMs);
    }
  }

  setLanHandler(handler: LanHandler | null): void {
    // Read by the HTTP listener per request, so this works before or after start().
    this.lanHandler = handler;
  }

  status(): TlsStatus {
    const errors = [this.listenerError, this.lastError].filter((e): e is string => !!e);
    return {
      mode: this.mode,
      source: this.source,
      subject: this.info ? subjectLabel(this.info) : null,
      notAfter: this.info ? this.info.notAfter.toISOString() : null,
      fingerprint256: this.info?.fingerprint256 ?? null,
      publicIp: this.publicIp,
      lastError: errors.length > 0 ? errors.join(' ') : null,
      nextRenewalAt: this.nextRenewalAt ? this.nextRenewalAt.toISOString() : null,
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = null;
    for (const t of this.intervals) clearInterval(t);
    this.intervals = [];
    this.challenges.clear();
    const listener = this.listener;
    this.listener = null;
    await listener?.close();
  }

  // -------------------------------------------------------------------------
  // Material bookkeeping
  // -------------------------------------------------------------------------

  /** Swap the served certificate; notifies onRenew when it actually changed. */
  private setMaterial(material: TlsMaterial, info: CertInfo, source: Source): void {
    const id = fingerprintOf(material);
    this.info = info;
    this.source = source;
    if (id === this.materialId) return;
    const hadMaterial = this.materialId !== null;
    this.material = material;
    this.materialId = id;
    if (hadMaterial) this.log.info({ source, subject: subjectLabel(info), notAfter: info.notAfter.toISOString() }, 'TLS certificate changed');
    if (this.onRenew && !this.stopped) {
      try {
        this.onRenew(material);
      } catch (err) {
        this.log.error({ err }, 'applying the new TLS certificate failed');
      }
    }
  }

  private every(ms: number, fn: () => Promise<void>): void {
    const t = setInterval(() => {
      if (!this.stopped) fn().catch((err: unknown) => this.log.error({ err }, 'TLS background task failed'));
    }, ms);
    t.unref();
    this.intervals.push(t);
  }

  private async startListener(): Promise<void> {
    const port = this.config.httpPort;
    if (port <= 0) return;
    const policy = this.deps.lanPolicy;
    for (const warning of policy.warnings) this.log.warn(warning);
    const listener = createHttpListener({
      port,
      publicPort: this.config.publicPort,
      challenges: this.challenges,
      log: this.log,
      lanHandler: () => (policy.enabled ? this.lanHandler : null),
      isLanClient: (remoteAddress) => policy.isLanClient(remoteAddress),
    });
    try {
      await listener.listen();
      if (this.stopped) {
        await listener.close();
        return;
      }
      this.listener = listener;
      this.listenerError = null;
      this.log.info(
        policy.enabled
          ? `HTTP listener on http://0.0.0.0:${port} (ACME challenges, redirect to HTTPS; plain-HTTP /api/v1, /dock, /overlay for ${policy.description})`
          : `HTTP listener on http://0.0.0.0:${port} (ACME challenges, redirect to HTTPS; LAN plain HTTP ${policy.description})`,
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? errorMessage(err);
      this.listenerError = `HTTP port ${port} is unavailable (${code}); Let's Encrypt validation and the HTTPS redirect won't work.`;
      this.log.error({ port, code }, 'could not start the HTTP listener');
    }
  }

  // -------------------------------------------------------------------------
  // Public IP
  // -------------------------------------------------------------------------

  /** Resolve the public IP (PUBLIC_IP override wins). Keeps the last known IP when discovery fails. */
  private async refreshPublicIp(): Promise<boolean> {
    const before = this.publicIp;
    if (this.config.publicIp) {
      const ip = normalizeIp(this.config.publicIp);
      if (!ip && !before) this.log.warn('PUBLIC_IP is not a valid IP address; ignoring it');
      this.publicIp = ip;
    } else {
      const ip = await this.deps.discoverPublicIp(this.abort.signal).catch(() => null);
      if (ip) this.publicIp = ip;
      else if (!before) this.log.warn('could not discover the public IP address');
    }
    const changed = this.publicIp !== before;
    if (changed && before) this.log.info({ from: before, to: this.publicIp }, 'public IP changed');
    return changed;
  }

  private async onIpRecheck(): Promise<void> {
    if (this.config.publicIp) return;
    const changed = await this.refreshPublicIp();
    if (changed && !this.stopped && (this.mode === 'auto' || this.mode === 'letsencrypt' || this.mode === 'self-signed')) {
      this.scheduleCheck(0);
    }
  }

  // -------------------------------------------------------------------------
  // Manual mode
  // -------------------------------------------------------------------------

  private async readManual(): Promise<{ material: TlsMaterial; info: CertInfo }> {
    const { tlsCertFile, tlsKeyFile } = this.config;
    if (!tlsCertFile || !tlsKeyFile) {
      throw new Error('TLS_MODE=manual requires TLS_CERT_FILE and TLS_KEY_FILE (PEM files).');
    }
    const read = async (file: string, name: string) => {
      try {
        return await fs.readFile(file, 'utf8');
      } catch (err) {
        throw new Error(`Cannot read ${name} (${file}): ${(err as NodeJS.ErrnoException).code ?? errorMessage(err)}`);
      }
    };
    const cert = await read(tlsCertFile, 'TLS_CERT_FILE');
    const key = await read(tlsKeyFile, 'TLS_KEY_FILE');
    let info: CertInfo;
    try {
      info = readCertInfo(cert);
    } catch {
      throw new Error(`TLS_CERT_FILE (${tlsCertFile}) is not a valid PEM certificate.`);
    }
    if (!keyMatchesCert(key, cert)) {
      throw new Error(`TLS_KEY_FILE (${tlsKeyFile}) is not the private key for TLS_CERT_FILE (${tlsCertFile}).`);
    }
    return { material: { key, cert }, info };
  }

  private manualExpiryWarning(info: CertInfo): string | null {
    return info.notAfter.getTime() <= this.deps.now() ? `The certificate in TLS_CERT_FILE expired on ${info.notAfter.toISOString()}.` : null;
  }

  private async pollManual(): Promise<void> {
    try {
      const loaded = await this.readManual();
      this.setMaterial(loaded.material, loaded.info, 'manual');
      this.lastError = this.manualExpiryWarning(loaded.info);
    } catch (err) {
      // Files may be mid-update (e.g. certbot replacing them); keep serving the previous pair.
      const msg = errorMessage(err);
      if (msg !== this.lastError) this.log.warn({ err: msg }, 'manual TLS files not reloaded; keeping the current certificate');
      this.lastError = msg;
    }
  }

  // -------------------------------------------------------------------------
  // Self-signed
  // -------------------------------------------------------------------------

  private selfSignedNames(): CertNames {
    return selfSignedNames({ publicIp: this.publicIp, publicHost: this.config.publicHost, lanIps: this.deps.lanAddresses() });
  }

  private async ensureSelfSigned(): Promise<void> {
    const names = this.selfSignedNames();
    const now = this.deps.now();
    const fresh =
      this.source === 'self-signed' &&
      this.info &&
      coversNames(this.info, names) &&
      this.info.notAfter.getTime() - now > SELF_SIGNED_MIN_REMAINING_MS;
    if (!fresh) {
      const result = await loadOrCreateSelfSigned({ tlsDir: this.tlsDir, names, now });
      if (result.created) this.log.info({ names: [...names.dns, ...names.ip] }, 'generated a self-signed TLS certificate');
      this.setMaterial(result.material, result.info, 'self-signed');
    }
    if (this.mode === 'self-signed' && this.info) {
      this.nextRenewalAt = new Date(this.info.notAfter.getTime() - SELF_SIGNED_MIN_REMAINING_MS);
    }
  }

  // -------------------------------------------------------------------------
  // Let's Encrypt
  // -------------------------------------------------------------------------

  /** What to request from Let's Encrypt, or why we can't. */
  private acmeTarget(): { identifier: AcmeIdentifier } | { error: string } {
    const fallback = 'Using a self-signed certificate.';
    if (this.config.httpPort <= 0) {
      return { error: `HTTP_PORT is 0, so Let's Encrypt HTTP-01 validation is disabled. ${fallback}` };
    }
    const host = this.config.publicHost?.trim().toLowerCase();
    if (host) {
      const asIp = normalizeIp(host);
      if (asIp) return this.ipTarget(asIp, 'PUBLIC_HOST');
      if (!isValidHostname(host)) return { error: `PUBLIC_HOST "${host}" is not a valid host name. ${fallback}` };
      return { identifier: { type: 'dns', value: host } };
    }
    if (!this.publicIp) {
      return { error: `No public IP: it could not be discovered. Set PUBLIC_IP or PUBLIC_HOST, or check internet access. ${fallback}` };
    }
    return this.ipTarget(this.publicIp, this.config.publicIp ? 'PUBLIC_IP' : 'the detected IP');
  }

  private ipTarget(ip: string, label: string): { identifier: AcmeIdentifier } | { error: string } {
    const cls = classifyIp(ip);
    if (cls !== 'public') {
      return {
        error: `No public IP: ${label} ${ip} is not reachable from the internet (${describeIpClass(cls)} address). Using a self-signed certificate.`,
      };
    }
    return { identifier: { type: 'ip', value: ip } };
  }

  private leSource(id: AcmeIdentifier): Source {
    return id.type === 'ip' ? 'letsencrypt-ip' : 'letsencrypt-domain';
  }

  /** Serve the persisted LE certificate if it covers the identifier and isn't expired. */
  private async loadLe(id: AcmeIdentifier): Promise<boolean> {
    const pair = await readPemPair(this.leKeyFile, this.leCertFile).catch(() => null);
    if (!pair) return false;
    try {
      const info = readCertInfo(pair.cert);
      if (info.notAfter.getTime() <= this.deps.now() + 5 * MINUTE) return false;
      if (!coversNames(info, namesFor(id)) || !keyMatchesCert(pair.key, pair.cert)) return false;
      this.setMaterial(pair, info, this.leSource(id));
      this.nextRenewalAt = renewalTime(info.notBefore, info.notAfter);
      return true;
    } catch {
      return false;
    }
  }

  private servesLeFor(id: AcmeIdentifier): boolean {
    return this.source === this.leSource(id) && !!this.info && coversNames(this.info, namesFor(id));
  }

  /** Restore the persisted failure backoff, capping the wait so a restart retries reasonably soon. */
  private restoreAcmeState(): void {
    const saved = this.settings.get<Partial<AcmeState> | null>(ACME_STATE_KEY, null);
    if (!saved || typeof saved.identifier !== 'string' || typeof saved.failures !== 'number' || !(saved.failures > 0)) return;
    const due = Math.min(Date.parse(saved.nextAttemptAt ?? '') || 0, this.deps.now() + RESTART_BACKOFF_CAP_MS);
    this.acmeState = {
      identifier: saved.identifier,
      failures: saved.failures,
      nextAttemptAt: new Date(due).toISOString(),
      lastError: typeof saved.lastError === 'string' ? saved.lastError : null,
    };
  }

  private acmeStateFor(id: AcmeIdentifier): AcmeState | null {
    return this.acmeState?.identifier === identifierKey(id) ? this.acmeState : null;
  }

  private async getAcmeApi(): Promise<AcmeApi> {
    if (!this.acmeApi) {
      const { key, created } = await loadOrCreateKey(this.accountKeyFile, createEcKey);
      if (created) this.log.info('created a new ACME account key');
      this.acmeApi = this.deps.createAcmeApi({ directoryUrl: acmeDirectoryUrl(this.config.acmeStaging), accountKey: key });
    }
    return this.acmeApi;
  }

  private describeFailure(err: unknown, id: AcmeIdentifier): string {
    const msg = errorMessage(err).replace(/\s+/g, ' ').trim().slice(0, 500);
    if (err instanceof AcmeIssueError && err.stage === 'challenge') {
      const where = id.type === 'ip' && net.isIPv6(id.value) ? `[${id.value}]` : id.value;
      return `Let's Encrypt validation failed: ${msg}. Make sure http://${where}/ (port 80) reaches this server's HTTP port ${this.config.httpPort}.`;
    }
    return `Let's Encrypt request failed: ${msg}`;
  }

  private async issue(id: AcmeIdentifier): Promise<void> {
    const previous = this.acmeStateFor(id);
    if (previous) {
      const due = Date.parse(previous.nextAttemptAt);
      if (due > this.deps.now()) {
        this.lastError = previous.lastError;
        this.nextRenewalAt = new Date(due);
        return;
      }
    }

    if (!this.agreementLogged) {
      this.agreementLogged = true;
      this.log.info(`Requesting Let's Encrypt certificates implies accepting the Subscriber Agreement: ${LE_SUBSCRIBER_AGREEMENT}`);
    }
    this.log.info({ identifier: id.value, staging: this.config.acmeStaging }, "requesting a Let's Encrypt certificate");

    try {
      const material = await issueCertificate({
        api: await this.getAcmeApi(),
        identifier: id,
        email: validEmail(this.config.acmeEmail),
        challenges: this.challenges,
        signal: this.abort.signal,
        log: this.log,
        generateKey: this.deps.generateCertKey,
      });
      if (this.stopped) return;
      // Serve it even if saving fails (a restart would then just re-issue).
      await writePemPair(this.leKeyFile, this.leCertFile, material).catch((err: unknown) =>
        this.log.error({ err: errorMessage(err) }, "could not save the Let's Encrypt certificate"),
      );
      const info = readCertInfo(material.cert);
      this.acmeState = null;
      this.settings.delete(ACME_STATE_KEY);
      this.lastError = null;
      this.nextRenewalAt = renewalTime(info.notBefore, info.notAfter);
      this.setMaterial(material, info, this.leSource(id));
      this.log.info({ identifier: id.value, notAfter: info.notAfter.toISOString() }, "Let's Encrypt certificate issued");
    } catch (err) {
      if (this.stopped) return;
      const failures = (previous?.failures ?? 0) + 1;
      const nextAttemptAt = new Date(this.deps.now() + backoffDelayMs(failures));
      this.lastError = this.describeFailure(err, id);
      this.nextRenewalAt = nextAttemptAt;
      const state: AcmeState = { identifier: identifierKey(id), failures, nextAttemptAt: nextAttemptAt.toISOString(), lastError: this.lastError };
      this.acmeState = state;
      this.settings.set(ACME_STATE_KEY, state);
      const level = this.mode === 'letsencrypt' ? 'error' : 'warn';
      this.log[level]({ identifier: id.value, failures, retryAt: state.nextAttemptAt, err: this.lastError }, "Let's Encrypt issuance failed");
    }
  }

  // -------------------------------------------------------------------------
  // Check loop (self-signed maintenance, LE issuance + renewal)
  // -------------------------------------------------------------------------

  private scheduleCheck(delayMs: number): void {
    if (this.stopped) return;
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      this.triggerCheck();
    }, Math.max(0, Math.min(delayMs, MAX_TIMER_MS)));
    this.checkTimer.unref();
  }

  private triggerCheck(): void {
    if (this.stopped) return;
    if (this.checking) {
      this.recheckRequested = true;
      return;
    }
    this.checking = this.runCheck()
      .catch((err: unknown) => {
        this.log.error({ err }, 'TLS check failed');
        this.scheduleCheck(this.deps.timings.checkIntervalMs);
      })
      .finally(() => {
        this.checking = null;
        if (this.recheckRequested && !this.stopped) {
          this.recheckRequested = false;
          this.scheduleCheck(0);
        }
      });
  }

  /** Run a check now and wait for it (tests). */
  async checkNow(): Promise<void> {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = null;
    while (this.checking) await this.checking;
    this.triggerCheck();
    await this.checking;
  }

  private async runCheck(): Promise<void> {
    const interval = this.deps.timings.checkIntervalMs;

    if (this.mode === 'self-signed') {
      await this.ensureSelfSigned();
      this.scheduleCheck(interval);
      return;
    }

    if (!this.publicIp && !this.config.publicIp && !this.config.publicHost) await this.refreshPublicIp();
    const target = this.acmeTarget();
    if ('error' in target) {
      this.lastError = target.error;
      this.nextRenewalAt = null;
      if (this.source === 'self-signed' || !this.material) await this.ensureSelfSigned();
      this.scheduleCheck(interval);
      return;
    }

    const id = target.identifier;
    if (!this.servesLeFor(id)) await this.loadLe(id);

    if (this.servesLeFor(id) && this.info) {
      const renewAt = renewalTime(this.info.notBefore, this.info.notAfter);
      if (this.deps.now() < renewAt.getTime()) {
        this.nextRenewalAt = renewAt;
        this.lastError = null;
        this.scheduleCheck(Math.min(renewAt.getTime() - this.deps.now(), interval));
        return;
      }
    }

    // Keep the self-signed fallback's names current while we wait for Let's Encrypt.
    if (this.source === 'self-signed') await this.ensureSelfSigned();
    await this.issue(id);
    if (this.stopped) return;
    const next = this.nextRenewalAt ? this.nextRenewalAt.getTime() - this.deps.now() : interval;
    this.scheduleCheck(Math.min(Math.max(next, 1_000), interval));
  }
}

/** Create the TLS manager. `deps` exists for tests (fake ACME, clock, timings). */
export function createTlsManager(
  { config, log, settings }: { config: AppConfig; log: Logger; settings: SettingsRepo },
  deps: Partial<TlsManagerDeps> = {},
): TlsManager & { checkNow(): Promise<void> } {
  const full: TlsManagerDeps = {
    createAcmeApi: deps.createAcmeApi ?? createAcmeApi,
    discoverPublicIp: deps.discoverPublicIp ?? ((signal) => discoverPublicIp({ signal, log })),
    lanAddresses: deps.lanAddresses ?? (() => localIPv4Addresses()),
    generateCertKey: deps.generateCertKey ?? createEcKey,
    now: deps.now ?? Date.now,
    timings: { ...DEFAULT_TLS_TIMINGS, ...deps.timings },
    lanPolicy: deps.lanPolicy ?? lanClientPolicy(process.env),
  };
  return new DefaultTlsManager({ config, log, settings }, full);
}
