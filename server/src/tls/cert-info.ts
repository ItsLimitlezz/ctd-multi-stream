// Certificate inspection + renewal/backoff timing (pure helpers).

import crypto from 'node:crypto';
import { normalizeIp } from './public-ip.js';

export interface CertNames {
  dns: string[];
  ip: string[];
}

export interface CertInfo extends CertNames {
  commonName: string | null;
  notBefore: Date;
  notAfter: Date;
  fingerprint256: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const BACKOFF_MIN_MS = 5 * MINUTE;
export const BACKOFF_MAX_MS = 6 * HOUR;

/**
 * Parse Node's `X509Certificate.subjectAltName` ("DNS:a, IP Address:1.2.3.4"). Values with
 * special characters are JSON-quoted by Node.
 */
export function parseSubjectAltName(san: string | undefined): CertNames {
  const out: CertNames = { dns: [], ip: [] };
  if (!san) return out;
  const re = /\s*([A-Za-z ]+):("(?:[^"\\]|\\.)*"|[^,]*)(?:,|$)/g;
  for (const m of san.matchAll(re)) {
    const kind = m[1];
    let value = m[2] ?? '';
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        continue;
      }
    }
    if (kind === 'DNS') out.dns.push(value.toLowerCase());
    else if (kind === 'IP Address') {
      const ip = normalizeIp(value);
      if (ip) out.ip.push(ip);
    }
  }
  return out;
}

const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;

/** The leaf (first) certificate of a PEM chain. */
export function leafCertificate(certPem: string): string {
  const m = PEM_CERT_RE.exec(certPem);
  if (!m) throw new Error('No PEM certificate found');
  return `${m[0]}\n`;
}

/** Parse the first certificate of a PEM (chain). Throws on invalid input. */
export function readCertInfo(certPem: string): CertInfo {
  const x = new crypto.X509Certificate(leafCertificate(certPem));
  const cn = /^CN=(.*)$/m.exec(x.subject)?.[1] ?? null;
  return {
    ...parseSubjectAltName(x.subjectAltName),
    commonName: cn,
    notBefore: x.validFromDate,
    notAfter: x.validToDate,
    fingerprint256: x.fingerprint256,
  };
}

export function keyMatchesCert(keyPem: string, certPem: string): boolean {
  try {
    return new crypto.X509Certificate(leafCertificate(certPem)).checkPrivateKey(crypto.createPrivateKey(keyPem));
  } catch {
    return false;
  }
}

/** True when the certificate lists every wanted name. */
export function coversNames(info: CertNames, wanted: CertNames): boolean {
  const dns = new Set(info.dns);
  const ip = new Set(info.ip);
  return wanted.dns.every((d) => dns.has(d.toLowerCase())) && wanted.ip.every((i) => ip.has(normalizeIp(i) ?? i));
}

/** What the UI shows as the certificate's subject: its SANs, else the CN. */
export function subjectLabel(info: CertInfo): string | null {
  const names = [...info.dns, ...info.ip];
  return names.length > 0 ? names.join(', ') : info.commonName;
}

/** Renew once less than a third of the lifetime remains (≈53 h for 160 h IP certs, 30 days for 90-day certs). */
export function renewalTime(notBefore: Date, notAfter: Date): Date {
  const lifetime = notAfter.getTime() - notBefore.getTime();
  return new Date(notAfter.getTime() - Math.max(0, lifetime) / 3);
}

export function needsRenewal(info: Pick<CertInfo, 'notBefore' | 'notAfter'>, now: number): boolean {
  return now >= renewalTime(info.notBefore, info.notAfter).getTime();
}

/** Exponential backoff after `failures` consecutive failures: 5 min, 10, 20, ... capped at 6 h. */
export function backoffDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(failures - 1, 20));
}
