import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY, keyMatchesCert, readCertInfo } from './cert-info.js';
import { loadOrCreateSelfSigned, selfSignedFiles, selfSignedNames } from './self-signed.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ctd-tls-ss-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('selfSignedNames', () => {
  it('orders PUBLIC_HOST, public IP, localhost, loopbacks, LAN IPs and dedupes', () => {
    const names = selfSignedNames({ publicIp: '93.184.216.34', publicHost: 'NAS.Example.com', lanIps: ['192.168.1.20', '127.0.0.1'] });
    expect(names).toEqual({ dns: ['nas.example.com', 'localhost'], ip: ['93.184.216.34', '127.0.0.1', '::1', '192.168.1.20'] });
  });

  it('treats an IP PUBLIC_HOST as an IP SAN and skips invalid host names', () => {
    expect(selfSignedNames({ publicIp: null, publicHost: '[2606:4700::1]', lanIps: [] }).ip[0]).toBe('2606:4700::1');
    expect(selfSignedNames({ publicIp: null, publicHost: 'bad host!', lanIps: [] }).dns).toEqual(['localhost']);
  });
});

describe('loadOrCreateSelfSigned', () => {
  const names = selfSignedNames({ publicIp: '93.184.216.34', publicHost: null, lanIps: ['192.168.1.20'] });

  it('generates an EC certificate with the SANs as dNSName/iPAddress entries, valid ~1 year', async () => {
    const now = Date.now();
    const r = await loadOrCreateSelfSigned({ tlsDir: dir, names, now });
    expect(r.created).toBe(true);

    const x = new crypto.X509Certificate(r.material.cert);
    expect(x.subjectAltName).toContain('DNS:localhost');
    expect(x.subjectAltName).toContain('IP Address:93.184.216.34');
    expect(x.subjectAltName).toContain('IP Address:192.168.1.20');
    expect(x.subjectAltName).toContain('IP Address:127.0.0.1');
    expect(x.subjectAltName).toContain('IP Address:0:0:0:0:0:0:0:1');
    expect(x.checkIP('93.184.216.34')).toBe('93.184.216.34');
    expect(x.publicKey.asymmetricKeyType).toBe('ec');
    expect(keyMatchesCert(r.material.key, r.material.cert)).toBe(true);

    const days = (x.validToDate.getTime() - now) / DAY;
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThan(366);

    const files = selfSignedFiles(dir);
    await expect(fs.readFile(files.certFile, 'utf8')).resolves.toBe(r.material.cert);
    await expect(fs.readFile(files.keyFile, 'utf8')).resolves.toBe(r.material.key);
    expect(r.info.ip).toEqual(['93.184.216.34', '127.0.0.1', '::1', '192.168.1.20']);
  });

  it('reuses the persisted certificate while it covers the names and has >30 days left', async () => {
    const first = await loadOrCreateSelfSigned({ tlsDir: dir, names });
    const again = await loadOrCreateSelfSigned({ tlsDir: dir, names: { dns: ['localhost'], ip: ['127.0.0.1'] } });
    expect(again.created).toBe(false);
    expect(again.info.fingerprint256).toBe(first.info.fingerprint256);
  });

  it('regenerates when a new name is needed', async () => {
    const first = await loadOrCreateSelfSigned({ tlsDir: dir, names });
    const moved = selfSignedNames({ publicIp: '93.184.216.35', publicHost: null, lanIps: ['192.168.1.20'] });
    const next = await loadOrCreateSelfSigned({ tlsDir: dir, names: moved });
    expect(next.created).toBe(true);
    expect(next.info.fingerprint256).not.toBe(first.info.fingerprint256);
    expect(next.info.ip).toContain('93.184.216.35');
  });

  it('regenerates when fewer than 30 days remain', async () => {
    const first = await loadOrCreateSelfSigned({ tlsDir: dir, names });
    const later = first.info.notAfter.getTime() - 29 * DAY;
    const next = await loadOrCreateSelfSigned({ tlsDir: dir, names, now: later });
    expect(next.created).toBe(true);
    expect(readCertInfo(next.material.cert).notAfter.getTime()).toBeGreaterThan(later + 364 * DAY);
  });

  it('regenerates when the stored key does not match the certificate', async () => {
    await loadOrCreateSelfSigned({ tlsDir: dir, names });
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    await fs.writeFile(selfSignedFiles(dir).keyFile, other);
    const next = await loadOrCreateSelfSigned({ tlsDir: dir, names });
    expect(next.created).toBe(true);
    expect(keyMatchesCert(next.material.key, next.material.cert)).toBe(true);
  });
});
