import { describe, expect, it } from 'vitest';
import { backoffDelayMs, coversNames, DAY, needsRenewal, parseSubjectAltName, renewalTime } from './cert-info.js';

const HOUR = 3_600_000;

describe('renewalTime', () => {
  it('renews 160 h IP certificates with about 53 h left', () => {
    const notBefore = new Date('2026-10-01T00:00:00Z');
    const notAfter = new Date(notBefore.getTime() + 160 * HOUR);
    const at = renewalTime(notBefore, notAfter);
    expect((notAfter.getTime() - at.getTime()) / HOUR).toBeCloseTo(53.33, 1);
    expect(needsRenewal({ notBefore, notAfter }, at.getTime() - 1)).toBe(false);
    expect(needsRenewal({ notBefore, notAfter }, at.getTime())).toBe(true);
  });

  it('renews 90-day certificates with 30 days left', () => {
    const notBefore = new Date('2026-10-01T00:00:00Z');
    const notAfter = new Date(notBefore.getTime() + 90 * DAY);
    expect(notAfter.getTime() - renewalTime(notBefore, notAfter).getTime()).toBe(30 * DAY);
  });
});

describe('backoffDelayMs', () => {
  it('doubles from 5 minutes and caps at 6 hours', () => {
    const minutes = [1, 2, 3, 4, 5, 6, 7, 8, 50].map((n) => backoffDelayMs(n) / 60_000);
    expect(minutes).toEqual([5, 10, 20, 40, 80, 160, 320, 360, 360]);
    expect(backoffDelayMs(0)).toBe(0);
  });
});

describe('parseSubjectAltName', () => {
  it('parses Node subjectAltName strings including uncompressed IPv6', () => {
    const names = parseSubjectAltName('DNS:Localhost, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1, IP Address:2001:DB8:0:0:0:0:0:10, DNS:"a,b.example"');
    expect(names).toEqual({ dns: ['localhost', 'a,b.example'], ip: ['127.0.0.1', '::1', '2001:db8::10'] });
    expect(parseSubjectAltName(undefined)).toEqual({ dns: [], ip: [] });
  });

  it('coversNames compares case- and format-insensitively', () => {
    const have = { dns: ['localhost', 'nas.example.com'], ip: ['127.0.0.1', '::1'] };
    expect(coversNames(have, { dns: ['NAS.example.com'], ip: ['0:0:0:0:0:0:0:1'] })).toBe(true);
    expect(coversNames(have, { dns: [], ip: ['10.0.0.1'] })).toBe(false);
  });
});
