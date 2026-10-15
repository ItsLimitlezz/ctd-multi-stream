import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { createRepos } from '../db/repos.js';
import { EventBus } from '../events.js';
import { createSecretBox } from '../security/secretbox.js';
import type { Repos } from '../services.js';
import { ApiProblem } from './http.js';
import {
  MAX_PENDING_PAIRINGS,
  MAX_PENDING_PAIRINGS_INTERNET,
  MAX_PENDING_PAIRINGS_PER_ADDRESS,
  PAIRING_CODE_RE, PAIRING_TTL_MS, createPairingService, type PairingServiceHandle } from './pairing.js';
import { silentLog } from './test-helpers.js';

let clock: number;
const now = () => clock;
let repos: Repos;
let bus: EventBus;
let service: PairingServiceHandle;
let changes: number;
let db: ReturnType<typeof openDatabase>;

const ask = (over: Partial<Parameters<PairingServiceHandle['create']>[0]> = {}) =>
  service.create({
    appName: 'CTD OBS plugin (Studio PC)',
    kind: 'ctd-obs-plugin',
    requestedScopes: ['status:read', 'chat:read', 'ingest:read', 'apps:read', 'apps:write'],
    requestedProfileId: null,
    ip: '192.168.1.30',
    ...over,
  });

function problem(fn: () => unknown): ApiProblem {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiProblem) return err;
    throw err;
  }
  throw new Error('expected an ApiProblem');
}

beforeEach(() => {
  clock = Date.parse('2026-10-17T03:00:00.000Z');
  db = openDatabase(':memory:');
  repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
  bus = new EventBus();
  service = createPairingService({ repos, bus, log: silentLog, now });
  changes = 0;
  bus.on('pairings-changed', () => changes++);
});

afterEach(() => {
  service.close();
  db.close();
});

describe('pairing', () => {
  it('create → pending → approve → the token once → expired', () => {
    const { pairing, pollSecret } = ask();
    expect(pairing.code).toMatch(PAIRING_CODE_RE);
    expect(pairing.expiresAt).toBe(new Date(clock + PAIRING_TTL_MS).toISOString());
    expect(pollSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(changes).toBe(1);
    expect(service.list()).toEqual([pairing]);
    expect(service.poll(pairing.id, pollSecret)).toEqual({ status: 'pending' });

    const dprtmnt = repos.profiles.create({ name: 'DPRTMNT', color: null });
    const info = service.approve(pairing.id, { scopes: ['status:read', 'ingest:read'], profileId: dprtmnt.id, approvedBy: 'admin' });
    expect(info).toMatchObject({ name: 'CTD OBS plugin (Studio PC)', scopes: ['status:read', 'ingest:read'], profileId: dprtmnt.id, createdBy: 'admin' });
    expect(changes).toBe(2);
    expect(service.list()).toEqual([]);

    const got = service.poll(pairing.id, pollSecret);
    expect(got).toMatchObject({ status: 'approved', token: { id: info.id } });
    const secret = (got as { secret: string }).secret;
    expect(repos.apiTokens.verify(secret)).toMatchObject({ id: info.id, profileId: dprtmnt.id });
    // Once only.
    expect(service.poll(pairing.id, pollSecret)).toEqual({ status: 'expired' });
  });

  it('a wrong pollSecret or an unknown id look expired (no oracle)', () => {
    const { pairing } = ask();
    expect(service.poll(pairing.id, 'wrong')).toEqual({ status: 'expired' });
    expect(service.poll('nope', 'wrong')).toEqual({ status: 'expired' });
    service.approve(pairing.id, { scopes: ['chat:read'], profileId: null, approvedBy: null });
    expect(service.poll(pairing.id, 'x'.repeat(43))).toEqual({ status: 'expired' });
  });

  it('deny: the app is told, the request leaves the list', () => {
    const { pairing, pollSecret } = ask();
    service.deny(pairing.id);
    expect(service.poll(pairing.id, pollSecret)).toEqual({ status: 'denied' });
    expect(service.list()).toEqual([]);
    expect(changes).toBe(2);
    expect(problem(() => service.approve(pairing.id, { scopes: ['chat:read'], profileId: null, approvedBy: null }))).toMatchObject({ statusCode: 409 });
    expect(problem(() => service.deny('nope'))).toMatchObject({ statusCode: 404 });
  });

  it('expires after 10 minutes; finished requests are forgotten later', () => {
    const { pairing, pollSecret } = ask();
    clock += PAIRING_TTL_MS - 1;
    expect(service.poll(pairing.id, pollSecret)).toEqual({ status: 'pending' });
    clock += 1;
    service.sweep();
    expect(changes).toBe(2); // the banner disappears
    expect(service.list()).toEqual([]);
    expect(service.poll(pairing.id, pollSecret)).toEqual({ status: 'expired' });
    expect(problem(() => service.approve(pairing.id, { scopes: ['chat:read'], profileId: null, approvedBy: null }))).toMatchObject({ statusCode: 410, code: 'expired' });
    clock += 60 * 60_000;
    expect(problem(() => service.approve(pairing.id, { scopes: ['chat:read'], profileId: null, approvedBy: null }))).toMatchObject({ statusCode: 404 });
  });

  it('an approved token nobody collects is revoked when the request expires', () => {
    const { pairing } = ask();
    const info = service.approve(pairing.id, { scopes: ['chat:read'], profileId: null, approvedBy: 'admin' });
    expect(repos.apiTokens.list().map((t) => t.id)).toEqual([info.id]);
    clock += PAIRING_TTL_MS;
    service.sweep();
    expect(repos.apiTokens.list()).toEqual([]);
    expect(repos.audit.list({ limit: 10 })[0]).toMatchObject({ action: 'pairing.expire' });
  });

  it('a token revoked before the app collects it is never handed out; the sweep does not re-revoke or audit it', () => {
    const { pairing, pollSecret } = ask();
    const info = service.approve(pairing.id, { scopes: ['chat:read'], profileId: null, approvedBy: 'admin' });
    // What DELETE /api/tokens/:id (and deleting the token's profile) does.
    repos.connectedApps.deleteByToken(info.id);
    repos.apiTokens.delete(info.id);
    expect(service.poll(pairing.id, pollSecret)).toEqual({ status: 'expired' });
    expect(service.poll(pairing.id, pollSecret)).toEqual({ status: 'expired' });

    // Same when nobody polls before the request expires: no "never collected; revoked" audit row.
    const second = ask();
    const info2 = service.approve(second.pairing.id, { scopes: ['chat:read'], profileId: null, approvedBy: 'admin' });
    repos.apiTokens.delete(info2.id);
    clock += PAIRING_TTL_MS;
    service.sweep();
    expect(service.poll(second.pairing.id, second.pollSecret)).toEqual({ status: 'expired' });
    expect(repos.audit.list({ limit: 10 }).filter((a) => a.action === 'pairing.expire')).toEqual([]);
  });

  it('at most 10 pending at once (429 with the wait until one expires); codes are unique', () => {
    const codes = new Set<string>();
    for (let i = 0; i < MAX_PENDING_PAIRINGS; i++) {
      clock += 1000;
      codes.add(ask({ ip: `192.168.1.${30 + i}` }).pairing.code);
    }
    expect(codes.size).toBe(MAX_PENDING_PAIRINGS);
    const p = problem(() => ask({ ip: '192.168.1.99' }));
    expect(p).toMatchObject({ statusCode: 429, code: 'rate_limited' });
    expect(p.retryAfterSec).toBe(Math.ceil((PAIRING_TTL_MS - 9000) / 1000));
    expect(service.list()).toHaveLength(MAX_PENDING_PAIRINGS);
    expect(service.list()[0]!.createdAt > service.list()[9]!.createdAt).toBe(true); // newest first
  });

  it(`at most ${MAX_PENDING_PAIRINGS_PER_ADDRESS} pending per address (IPv6 by /64)`, () => {
    for (let i = 0; i < MAX_PENDING_PAIRINGS_PER_ADDRESS; i++) {
      clock += 1000;
      ask({ ip: '192.168.1.7' });
    }
    const p = problem(() => ask({ ip: '192.168.1.7' }));
    expect(p).toMatchObject({ statusCode: 429, code: 'rate_limited' });
    // The wait is until this address's oldest request expires.
    expect(p.retryAfterSec).toBe(Math.ceil((PAIRING_TTL_MS - (MAX_PENDING_PAIRINGS_PER_ADDRESS - 1) * 1000) / 1000));
    expect(problem(() => ask({ ip: '::ffff:192.168.1.7' }))).toMatchObject({ statusCode: 429 });
    // Another address still can.
    expect(ask({ ip: '192.168.1.8' }).pairing.code).toMatch(PAIRING_CODE_RE);

    for (let i = 0; i < MAX_PENDING_PAIRINGS_PER_ADDRESS; i++) ask({ ip: `fd00:1:2:3::${i + 1}` });
    expect(problem(() => ask({ ip: 'fd00:1:2:3:ffff::9' }))).toMatchObject({ statusCode: 429 });
    expect(ask({ ip: 'fd00:1:2:4::1' }).pairing.code).toMatch(PAIRING_CODE_RE);
  });

  it(`internet peers get at most ${MAX_PENDING_PAIRINGS_INTERNET} slots: they can never block LAN pairing`, () => {
    for (let i = 0; i < MAX_PENDING_PAIRINGS_INTERNET; i++) ask({ ip: `198.51.100.${i + 1}` });
    expect(problem(() => ask({ ip: '198.51.100.200' }))).toMatchObject({ statusCode: 429, code: 'rate_limited' });
    expect(problem(() => ask({ ip: '2001:db8::1' }))).toMatchObject({ statusCode: 429 });
    // The LAN keeps the rest.
    for (let i = 0; i < MAX_PENDING_PAIRINGS - MAX_PENDING_PAIRINGS_INTERNET; i++) ask({ ip: `192.168.1.${i + 10}` });
    expect(service.list()).toHaveLength(MAX_PENDING_PAIRINGS);
    expect(problem(() => ask({ ip: '192.168.1.200' }))).toMatchObject({ statusCode: 429 });
  });

  it('LAN means the LAN_HTTP policy (injectable): with no LAN peers every request is in the internet pool', () => {
    service.close();
    service = createPairingService({ repos, bus, log: silentLog, now, isLanClient: () => false });
    for (let i = 0; i < MAX_PENDING_PAIRINGS_INTERNET; i++) ask({ ip: `192.168.1.${i + 1}` });
    expect(problem(() => ask({ ip: '192.168.1.100' }))).toMatchObject({ statusCode: 429 });
  });

  it('approve validates scopes and the profile; the name defaults to the app name', () => {
    const { pairing } = ask({ appName: 'X'.repeat(60) });
    expect(problem(() => service.approve(pairing.id, { scopes: [], profileId: null, approvedBy: null }))).toMatchObject({ statusCode: 400 });
    expect(problem(() => service.approve(pairing.id, { scopes: ['chat:read'], profileId: 'nope', approvedBy: null }))).toMatchObject({
      statusCode: 404,
      code: 'unknown_profile',
    });
    expect(service.approve(pairing.id, { name: ' Studio ', scopes: ['chat:read'], profileId: null, approvedBy: null }).name).toBe('Studio');
  });
});
