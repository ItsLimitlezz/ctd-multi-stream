import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { generate } from 'selfsigned';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import type { SettingsRepo, TlsMaterial } from '../services.js';
import type { AcmeApi, AcmeAuthorization, AcmeChallenge, AcmeOrder, NewOrderRequest } from './acme.js';
import { readCertInfo, renewalTime } from './cert-info.js';
import { ACME_STATE_KEY, createTlsManager, type TlsManagerDeps } from './tls-manager.js';

const log = pino({ level: 'silent' });
const IP = '93.184.216.34';
const HOUR = 3_600_000;

let dataDir: string;
const managers: { stop(): Promise<void> }[] = [];

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctd-tls-mgr-'));
});
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stop()));
  await fs.rm(dataDir, { recursive: true, force: true });
});

function config(over: Partial<AppConfig>): AppConfig {
  return {
    dataDir,
    webPort: 8443,
    httpPort: 0,
    rtmpPort: 1935,
    mediamtxApiPort: 9997,
    publicPort: 443,
    tlsMode: 'auto',
    publicIp: null,
    publicHost: null,
    acmeEmail: null,
    acmeStaging: true,
    tlsCertFile: null,
    tlsKeyFile: null,
    masterKey: null,
    mediamtxBin: 'mediamtx',
    ffmpegBin: 'ffmpeg',
    browserHeadless: true,
    trustProxy: false,
    logLevel: 'silent',
    version: 'test',
    ...over,
  };
}

function memorySettings(): SettingsRepo & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: <T>(key: string, fallback: T) => (data.has(key) ? (structuredClone(data.get(key)) as T) : fallback),
    set: (key, value) => void data.set(key, structuredClone(value)),
    delete: (key) => void data.delete(key),
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function ecKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

async function certFor(keys: { privateKey: string; publicKey: string }, ip: string, hours = 160, notBefore = new Date()): Promise<string> {
  const pems = await generate(undefined, {
    keyType: 'ec',
    keyPair: keys,
    algorithm: 'sha256',
    notBeforeDate: notBefore,
    notAfterDate: new Date(notBefore.getTime() + hours * HOUR),
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip }] }],
  });
  return pems.cert;
}

/** Fake Let's Encrypt: validates by fetching the token from the manager's real HTTP listener. */
class FakeCa implements AcmeApi {
  orders: NewOrderRequest[] = [];
  csrs: Buffer[] = [];
  fail = false;
  private keyAuth = '';
  private body = '';
  constructor(
    private readonly httpPort: () => number,
    private readonly keys: () => { privateKey: string; publicKey: string },
  ) {}
  async createAccount() {
    return {};
  }
  async createOrder(data: NewOrderRequest): Promise<AcmeOrder> {
    this.orders.push(data);
    return { url: 'https://ca.test/o', status: 'pending', authorizations: ['https://ca.test/a'], finalize: 'https://ca.test/f' };
  }
  async getAuthorizations(): Promise<AcmeAuthorization[]> {
    const id = this.orders.at(-1)!.identifiers[0]!;
    return [{ url: 'https://ca.test/a', status: 'pending', identifier: id, challenges: [{ type: 'http-01', url: 'https://ca.test/c', status: 'pending', token: 'tok1' }] }];
  }
  async getChallengeKeyAuthorization(ch: AcmeChallenge) {
    this.keyAuth = `${ch.token}.thumb`;
    return this.keyAuth;
  }
  async completeChallenge(ch: AcmeChallenge) {
    const res = await fetch(`http://127.0.0.1:${this.httpPort()}/.well-known/acme-challenge/${ch.token}`);
    this.body = await res.text();
    return ch;
  }
  async waitForValidStatus<T extends { url: string }>(item: T): Promise<T> {
    if (this.fail || this.body !== this.keyAuth) throw new Error('Timeout during connect (likely firewall problem)');
    return item;
  }
  async finalizeOrder(order: AcmeOrder, csr: Buffer): Promise<AcmeOrder> {
    this.csrs.push(csr);
    return { ...order, status: 'valid', certificate: 'https://ca.test/cert' };
  }
  async getCertificate(): Promise<string> {
    const id = this.orders.at(-1)!.identifiers[0]!;
    return certFor(this.keys(), id.value);
  }
  async deactivateAuthorization() {
    return {};
  }
}

interface Harness {
  ca: FakeCa;
  clock: { now: number };
  renewals: TlsMaterial[];
  settings: ReturnType<typeof memorySettings>;
  keys: { privateKey: string; publicKey: string };
  deps: Partial<TlsManagerDeps>;
  createdApis: number;
}

async function harness(httpPort: number): Promise<Harness> {
  const h = {
    clock: { now: Date.now() },
    renewals: [] as TlsMaterial[],
    settings: memorySettings(),
    keys: ecKeyPair(),
    createdApis: 0,
  } as Harness;
  h.ca = new FakeCa(() => httpPort, () => h.keys);
  h.deps = {
    createAcmeApi: () => {
      h.createdApis++;
      return h.ca;
    },
    discoverPublicIp: async () => {
      throw new Error('no network in tests');
    },
    lanAddresses: () => ['192.168.1.20'],
    generateCertKey: async () => h.keys.privateKey,
    now: () => h.clock.now,
    timings: { firstCheckMs: 3_600_000, checkIntervalMs: 3_600_000, ipRecheckMs: 3_600_000, manualPollMs: 3_600_000 },
  };
  return h;
}

function make(cfg: AppConfig, h: Harness) {
  const m = createTlsManager({ config: cfg, log, settings: h.settings }, h.deps);
  managers.push(m);
  return m;
}

describe('mode off', () => {
  it('has no certificate and starts nothing', async () => {
    const h = await harness(0);
    const m = make(config({ tlsMode: 'off', httpPort: await freePort() }), h);
    await expect(m.init()).resolves.toBeNull();
    await m.start(() => h.renewals.push());
    expect(m.status()).toMatchObject({ mode: 'off', source: 'none', fingerprint256: null });
    expect(h.createdApis).toBe(0);
  });
});

describe('mode self-signed', () => {
  it('serves a persisted self-signed certificate with status fields', async () => {
    const h = await harness(0);
    const m = make(config({ tlsMode: 'self-signed', publicIp: IP }), h);
    const material = await m.init();
    expect(material).not.toBeNull();
    const x = new crypto.X509Certificate(material!.cert);
    expect(x.subjectAltName).toContain(`IP Address:${IP}`);
    expect(x.subjectAltName).toContain('IP Address:192.168.1.20');

    const s = m.status();
    expect(s).toMatchObject({ mode: 'self-signed', source: 'self-signed', publicIp: IP, lastError: null, fingerprint256: x.fingerprint256 });
    expect(s.subject).toContain(IP);
    expect(s.notAfter).toBe(x.validToDate.toISOString());
    expect(Date.parse(s.nextRenewalAt!)).toBe(x.validToDate.getTime() - 30 * 24 * HOUR);

    // A second instance reuses the same certificate.
    const again = make(config({ tlsMode: 'self-signed', publicIp: IP }), h);
    await again.init();
    expect(again.status().fingerprint256).toBe(x.fingerprint256);
  });
});

describe('mode manual', () => {
  async function writePair(dir: string, ip: string) {
    const keys = ecKeyPair();
    const cert = await certFor(keys, ip, 24 * 90);
    await fs.writeFile(path.join(dir, 'cert.pem'), cert);
    await fs.writeFile(path.join(dir, 'key.pem'), keys.privateKey);
    return { key: keys.privateKey, cert };
  }

  it('requires both files', async () => {
    const h = await harness(0);
    await expect(make(config({ tlsMode: 'manual' }), h).init()).rejects.toThrow(/TLS_CERT_FILE and TLS_KEY_FILE/);
    await expect(
      make(config({ tlsMode: 'manual', tlsCertFile: path.join(dataDir, 'nope.pem'), tlsKeyFile: path.join(dataDir, 'nope.key') }), h).init(),
    ).rejects.toThrow(/Cannot read TLS_CERT_FILE/);
  });

  it('rejects a key that does not match the certificate', async () => {
    const h = await harness(0);
    await writePair(dataDir, IP);
    await fs.writeFile(path.join(dataDir, 'key.pem'), ecKeyPair().privateKey);
    const cfg = config({ tlsMode: 'manual', tlsCertFile: path.join(dataDir, 'cert.pem'), tlsKeyFile: path.join(dataDir, 'key.pem') });
    await expect(make(cfg, h).init()).rejects.toThrow(/not the private key/);
  });

  it('loads the files and calls onRenew when they change', async () => {
    const h = await harness(0);
    h.deps.timings = { ...h.deps.timings!, manualPollMs: 25 };
    const first = await writePair(dataDir, IP);
    const cfg = config({ tlsMode: 'manual', tlsCertFile: path.join(dataDir, 'cert.pem'), tlsKeyFile: path.join(dataDir, 'key.pem') });
    const m = make(cfg, h);
    await expect(m.init()).resolves.toEqual(first);
    expect(m.status().source).toBe('manual');

    const renewed = new Promise<TlsMaterial>((resolve) => void m.start(resolve));
    await new Promise((r) => setTimeout(r, 60));
    const second = await writePair(dataDir, '93.184.216.35');
    await expect(renewed).resolves.toEqual(second);
    expect(m.status().subject).toBe('93.184.216.35');
  });
});

describe("mode letsencrypt / auto", () => {
  it('serves self-signed first, then issues an IP certificate via HTTP-01 and persists it', async () => {
    const httpPort = await freePort();
    const h = await harness(httpPort);
    const m = make(config({ tlsMode: 'letsencrypt', publicIp: IP, httpPort }), h);

    const initial = await m.init();
    expect(m.status().source).toBe('self-signed');
    await m.start((mat) => h.renewals.push(mat));
    await m.checkNow();

    expect(h.ca.orders).toEqual([{ identifiers: [{ type: 'ip', value: IP }], profile: 'shortlived' }]);
    expect(h.renewals).toHaveLength(1);
    expect(h.renewals[0]!.key).toBe(h.keys.privateKey);
    expect(h.renewals[0]!.cert).not.toBe(initial!.cert);

    const s = m.status();
    const info = readCertInfo(h.renewals[0]!.cert);
    expect(s).toMatchObject({ source: 'letsencrypt-ip', subject: IP, publicIp: IP, lastError: null, fingerprint256: info.fingerprint256 });
    expect(s.nextRenewalAt).toBe(renewalTime(info.notBefore, info.notAfter).toISOString());

    const tls = path.join(dataDir, 'tls');
    await expect(fs.readFile(path.join(tls, 'le.crt'), 'utf8')).resolves.toBe(h.renewals[0]!.cert);
    await expect(fs.readFile(path.join(tls, 'le.key'), 'utf8')).resolves.toBe(h.keys.privateKey);
    await expect(fs.stat(path.join(tls, 'acme-account.key'))).resolves.toBeTruthy();

    // Not due yet: no new order.
    await m.checkNow();
    expect(h.ca.orders).toHaveLength(1);

    // A restart loads the persisted LE certificate directly.
    const restarted = make(config({ tlsMode: 'letsencrypt', publicIp: IP, httpPort }), h);
    await expect(restarted.init()).resolves.toEqual(h.renewals[0]);
  });

  it('renews when less than a third of the lifetime remains', async () => {
    const httpPort = await freePort();
    const h = await harness(httpPort);
    const oldKeys = ecKeyPair();
    const old = { key: oldKeys.privateKey, cert: await certFor(oldKeys, IP) };
    await fs.mkdir(path.join(dataDir, 'tls'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'tls', 'le.crt'), old.cert);
    await fs.writeFile(path.join(dataDir, 'tls', 'le.key'), old.key);

    const m = make(config({ tlsMode: 'auto', publicIp: IP, httpPort }), h);
    await expect(m.init()).resolves.toEqual(old);
    await m.start((mat) => h.renewals.push(mat));
    await m.checkNow();
    expect(h.ca.orders).toHaveLength(0);

    h.clock.now += 107 * HOUR; // 53 h left of 160 h
    await m.checkNow();
    expect(h.ca.orders).toHaveLength(1);
    expect(h.renewals).toHaveLength(1);
    expect(m.status().source).toBe('letsencrypt-ip');
  });

  it('backs off exponentially after failures and records lastError', async () => {
    const httpPort = await freePort();
    const h = await harness(httpPort);
    h.ca.fail = true;
    const m = make(config({ tlsMode: 'letsencrypt', publicIp: IP, httpPort }), h);
    await m.init();
    await m.start((mat) => h.renewals.push(mat));

    await m.checkNow();
    let s = m.status();
    expect(s.source).toBe('self-signed');
    expect(s.lastError).toMatch(/validation failed: Timeout during connect.*port 80.*HTTP port/);
    expect(Date.parse(s.nextRenewalAt!) - h.clock.now).toBe(5 * 60_000);
    expect(h.settings.data.get(ACME_STATE_KEY)).toMatchObject({ identifier: `ip:${IP}`, failures: 1 });

    await m.checkNow(); // still backing off
    expect(h.ca.orders).toHaveLength(1);

    h.clock.now += 5 * 60_000;
    await m.checkNow();
    expect(h.ca.orders).toHaveLength(2);
    s = m.status();
    expect(Date.parse(s.nextRenewalAt!) - h.clock.now).toBe(10 * 60_000);

    h.ca.fail = false;
    h.clock.now += 10 * 60_000;
    await m.checkNow();
    expect(m.status()).toMatchObject({ source: 'letsencrypt-ip', lastError: null });
    expect(h.settings.data.has(ACME_STATE_KEY)).toBe(false);
    expect(h.renewals).toHaveLength(1);
  });

  it('restores a persisted backoff on restart, capped at 15 minutes', async () => {
    const h = await harness(0);
    h.settings.set(ACME_STATE_KEY, {
      identifier: `ip:${IP}`,
      failures: 6,
      nextAttemptAt: new Date(h.clock.now + 5 * HOUR).toISOString(),
      lastError: 'previous failure',
    });
    const httpPort = await freePort();
    const m = make(config({ tlsMode: 'letsencrypt', publicIp: IP, httpPort }), h);
    await m.init();
    expect(m.status().lastError).toBe('previous failure');
    await m.start(() => undefined);
    await m.checkNow();
    expect(h.ca.orders).toHaveLength(0);
    expect(Date.parse(m.status().nextRenewalAt!) - h.clock.now).toBe(15 * 60_000);
  });

  it('auto: stays self-signed with a helpful error behind CGNAT / private IPs', async () => {
    const h = await harness(0);
    h.deps.discoverPublicIp = async () => '100.64.12.34';
    const m = make(config({ tlsMode: 'auto', httpPort: await freePort() }), h);
    await m.init();
    await m.start(() => undefined);
    await m.checkNow();
    const s = m.status();
    expect(s).toMatchObject({ source: 'self-signed', publicIp: '100.64.12.34' });
    expect(s.lastError).toMatch(/No public IP.*CGNAT.*self-signed/);
    expect(h.createdApis).toBe(0);
  });

  it('auto: stays self-signed when the public IP cannot be discovered', async () => {
    const h = await harness(0);
    const m = make(config({ tlsMode: 'auto', httpPort: await freePort() }), h);
    await m.init();
    expect(m.status().lastError).toMatch(/could not be discovered/);
    expect(m.status().publicIp).toBeNull();
  });

  it('re-issues when the public IP changes', async () => {
    const httpPort = await freePort();
    const h = await harness(httpPort);
    let ip = IP;
    h.deps.discoverPublicIp = async () => ip;
    h.deps.timings = { ...h.deps.timings!, ipRecheckMs: 30 };
    const m = make(config({ tlsMode: 'auto', httpPort }), h);
    await m.init();

    let resolveSecond!: (m: TlsMaterial) => void;
    const second = new Promise<TlsMaterial>((r) => (resolveSecond = r));
    await m.start((mat) => {
      h.renewals.push(mat);
      if (h.renewals.length === 2) resolveSecond(mat);
    });
    await m.checkNow();
    expect(h.renewals).toHaveLength(1);

    h.keys = ecKeyPair();
    ip = '93.184.216.35';
    const mat = await second;
    expect(readCertInfo(mat.cert).ip).toEqual(['93.184.216.35']);
    expect(h.ca.orders.at(-1)).toEqual({ identifiers: [{ type: 'ip', value: '93.184.216.35' }], profile: 'shortlived' });
    expect(m.status()).toMatchObject({ publicIp: '93.184.216.35', subject: '93.184.216.35' });
  });

  it('requests a domain certificate without a profile when PUBLIC_HOST is set', async () => {
    const httpPort = await freePort();
    const h = await harness(httpPort);
    const m = make(config({ tlsMode: 'letsencrypt', publicHost: 'NAS.example.com', httpPort }), h);
    await m.init();
    await m.start(() => undefined);
    await m.checkNow();
    expect(h.ca.orders[0]).toEqual({ identifiers: [{ type: 'dns', value: 'nas.example.com' }] });
  });

  it('reports a busy HTTP port without crashing', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '0.0.0.0', () => r()));
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      const h = await harness(port);
      h.ca.fail = true;
      const m = make(config({ tlsMode: 'letsencrypt', publicIp: IP, httpPort: port }), h);
      await m.init();
      await m.start(() => undefined);
      expect(m.status().lastError).toMatch(new RegExp(`HTTP port ${port} is unavailable`));
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });
});
