// Self-signed fallback certificate, persisted to <dataDir>/tls/self-signed.{key,crt}.

import net from 'node:net';
import path from 'node:path';
import { generate } from 'selfsigned';
import type { TlsMaterial } from '../services.js';
import { coversNames, DAY, keyMatchesCert, readCertInfo, type CertInfo, type CertNames } from './cert-info.js';
import { readPemPair, writePemPair } from './cert-store.js';
import { normalizeIp } from './public-ip.js';

export const SELF_SIGNED_VALIDITY_MS = 365 * DAY;
/** Regenerate when less than this is left. */
export const SELF_SIGNED_MIN_REMAINING_MS = 30 * DAY;

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function isValidHostname(host: string): boolean {
  return HOSTNAME_RE.test(host.toLowerCase());
}

export function selfSignedFiles(tlsDir: string): { keyFile: string; certFile: string } {
  return { keyFile: path.join(tlsDir, 'self-signed.key'), certFile: path.join(tlsDir, 'self-signed.crt') };
}

/** SANs: PUBLIC_HOST, public IP, localhost, loopbacks and the LAN IPv4 addresses (deduplicated, stable order). */
export function selfSignedNames(opts: { publicIp: string | null; publicHost: string | null; lanIps: string[] }): CertNames {
  const dns: string[] = [];
  const ip: string[] = [];
  const addIp = (value: string | null) => {
    const n = value ? normalizeIp(value) : null;
    if (n && !ip.includes(n)) ip.push(n);
  };
  const host = opts.publicHost?.trim().toLowerCase() ?? '';
  if (host && net.isIP(host.replace(/^\[(.*)\]$/, '$1'))) addIp(host);
  else if (host && isValidHostname(host)) dns.push(host);
  addIp(opts.publicIp);
  if (!dns.includes('localhost')) dns.push('localhost');
  addIp('127.0.0.1');
  addIp('::1');
  for (const lan of opts.lanIps) addIp(lan);
  return { dns, ip };
}

/** Reusable when the key matches, every wanted name is covered and enough validity is left. */
export function isReusable(m: TlsMaterial, info: CertInfo, names: CertNames, now: number): boolean {
  return (
    info.notBefore.getTime() <= now + 5 * 60_000 &&
    info.notAfter.getTime() - now > SELF_SIGNED_MIN_REMAINING_MS &&
    coversNames(info, names) &&
    keyMatchesCert(m.key, m.cert)
  );
}

export async function generateSelfSigned(names: CertNames, now = Date.now()): Promise<TlsMaterial> {
  const pems = await generate([{ name: 'commonName', value: 'CTD Relay (self-signed)' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate: new Date(now - 60 * 60_000), // tolerate small clock skew on clients
    notAfterDate: new Date(now + SELF_SIGNED_VALIDITY_MS),
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [...names.dns.map((value) => ({ type: 2 as const, value })), ...names.ip.map((ip) => ({ type: 7 as const, ip }))],
      },
    ],
  });
  return { key: pems.private, cert: pems.cert };
}

export interface SelfSignedResult {
  material: TlsMaterial;
  info: CertInfo;
  created: boolean;
}

/** Reuse the persisted self-signed certificate when it still fits, else generate and persist a new one. */
export async function loadOrCreateSelfSigned(opts: { tlsDir: string; names: CertNames; now?: number }): Promise<SelfSignedResult> {
  const now = opts.now ?? Date.now();
  const { keyFile, certFile } = selfSignedFiles(opts.tlsDir);
  const existing = await readPemPair(keyFile, certFile);
  if (existing) {
    try {
      const info = readCertInfo(existing.cert);
      if (isReusable(existing, info, opts.names, now)) return { material: existing, info, created: false };
    } catch {
      // unreadable: regenerate
    }
  }
  const material = await generateSelfSigned(opts.names, now);
  await writePemPair(keyFile, certFile, material);
  return { material, info: readCertInfo(material.cert), created: true };
}
