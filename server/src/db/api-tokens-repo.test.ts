import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecretBox } from '../security/secretbox.js';
import type { ApiTokensRepo } from '../services.js';
import { API_TOKEN_RE, LAST_USED_WRITE_INTERVAL_MS, createApiTokensRepo, hashApiToken } from './api-tokens-repo.js';
import { openDatabase, type Db } from './database.js';
import { createRepos } from './repos.js';
import { statementCache } from './rows.js';

let db: Db;
let clock: number;
let repo: ApiTokensRepo;

beforeEach(() => {
  db = openDatabase(':memory:');
  clock = Date.parse('2026-10-13T12:00:00.000Z');
  repo = createApiTokensRepo(statementCache(db), () => clock);
});

afterEach(() => {
  db.close();
});

describe('api tokens repo', () => {
  it('is wired into createRepos', () => {
    const repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
    const { token, secret } = repos.apiTokens.create({ name: 'x', scopes: ['chat:read'], createdBy: null });
    expect(repos.apiTokens.verify(secret)?.id).toBe(token.id);
  });

  it('creates a token whose secret is returned once and stored only as a SHA-256 hash', () => {
    const { token, secret } = repo.create({ name: 'CTD Overlay', scopes: ['status:read', 'chat:read'], createdBy: 'admin' });
    expect(secret).toMatch(API_TOKEN_RE);
    expect(secret).toHaveLength('ctd_pat_'.length + 43);
    expect(token).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: 'CTD Overlay',
      scopes: ['chat:read', 'status:read'], // canonical order
      profileId: null, // every profile
      prefix: secret.slice(0, 12),
      createdAt: '2026-10-13T12:00:00.000Z',
      createdBy: 'admin',
      lastUsedAt: null,
    });
    expect(token.prefix.startsWith('ctd_pat_')).toBe(true);

    const rows = db.prepare('SELECT * FROM api_tokens').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.secret_hash).toBe(hashApiToken(secret));
    // The secret appears nowhere in the table (only its first 12 characters as the prefix).
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(secret.slice(12));
    expect(JSON.stringify(token)).not.toContain(secret.slice(12));
  });

  it('verifies only exact, well-formed secrets', () => {
    const { token, secret } = repo.create({ name: 'a', scopes: ['chat:read'], createdBy: null });
    expect(repo.verify(secret)?.id).toBe(token.id);
    for (const bad of ['', 'ctd_pat_', secret.slice(0, -1), `${secret}x`, secret.replace('ctd_pat_', 'ctd_xxx_'), ` ${secret}`, 'x'.repeat(10_000)]) {
      expect(repo.verify(bad)).toBeNull();
    }
    // Well-formed but unknown.
    const other = `ctd_pat_${crypto.randomBytes(32).toString('base64url')}`;
    expect(repo.verify(other)).toBeNull();
    expect(repo.verify(42 as unknown as string)).toBeNull();
  });

  it('updates lastUsedAt at most once a minute', () => {
    const { secret, token } = repo.create({ name: 'a', scopes: ['status:read'], createdBy: null });
    const t0 = clock;
    expect(repo.verify(secret)?.lastUsedAt).toBe(new Date(t0).toISOString());
    const stored = () => db.prepare('SELECT last_used_at FROM api_tokens WHERE id = ?').get(token.id)?.last_used_at;
    expect(stored()).toBe(new Date(t0).toISOString());

    clock = t0 + LAST_USED_WRITE_INTERVAL_MS - 1;
    expect(repo.verify(secret)?.lastUsedAt).toBe(new Date(t0).toISOString());
    expect(stored()).toBe(new Date(t0).toISOString());

    clock = t0 + LAST_USED_WRITE_INTERVAL_MS;
    expect(repo.verify(secret)?.lastUsedAt).toBe(new Date(clock).toISOString());
    expect(stored()).toBe(new Date(clock).toISOString());
    expect(repo.list()[0]?.lastUsedAt).toBe(new Date(clock).toISOString());
  });

  it('lists in creation order and deletes (revoked tokens stop verifying)', () => {
    const a = repo.create({ name: 'a', scopes: ['chat:read'], createdBy: null });
    clock += 1000;
    const b = repo.create({ name: 'b', scopes: ['status:read'], createdBy: 'bob' });
    expect(repo.list().map((t) => t.name)).toEqual(['a', 'b']);
    repo.delete(a.token.id);
    expect(repo.verify(a.secret)).toBeNull();
    expect(repo.verify(b.secret)?.name).toBe('b');
    expect(repo.list().map((t) => t.id)).toEqual([b.token.id]);
    repo.delete('missing'); // no-op
  });

  it('drops unknown scopes, also from a hand-edited row', () => {
    const { token } = repo.create({ name: 'a', scopes: ['chat:read', 'admin' as never], createdBy: null });
    expect(token.scopes).toEqual(['chat:read']);
    db.prepare('UPDATE api_tokens SET scopes = ? WHERE id = ?').run('{not json', token.id);
    expect(repo.list()[0]?.scopes).toEqual([]);
    db.prepare('UPDATE api_tokens SET scopes = ? WHERE id = ?').run('["status:read","nope"]', token.id);
    expect(repo.list()[0]?.scopes).toEqual(['status:read']);
  });

  it('stores the profile a token is limited to (null = every profile)', () => {
    const limited = repo.create({ name: 'Club overlay', scopes: ['chat:read', 'apps:read', 'apps:write'], createdBy: null, profileId: 'club-id' });
    const every = repo.create({ name: 'OBS', scopes: ['ingest:read'], createdBy: null, profileId: null });
    const omitted = repo.create({ name: 'Old client', scopes: ['status:read'], createdBy: null });
    expect(limited.token).toMatchObject({ profileId: 'club-id', scopes: ['chat:read', 'apps:read', 'apps:write'] });
    expect(every.token.profileId).toBeNull();
    expect(omitted.token.profileId).toBeNull();
    expect(repo.verify(limited.secret)?.profileId).toBe('club-id');
    expect(repo.verify(every.secret)?.profileId).toBeNull();
    expect(repo.list().map((t) => [t.name, t.profileId])).toEqual([
      ['Club overlay', 'club-id'],
      ['OBS', null],
      ['Old client', null],
    ]);
  });

  it('generates distinct secrets', () => {
    const secrets = new Set(Array.from({ length: 20 }, () => repo.create({ name: 'n', scopes: ['chat:read'], createdBy: null }).secret));
    expect(secrets.size).toBe(20);
  });
});
