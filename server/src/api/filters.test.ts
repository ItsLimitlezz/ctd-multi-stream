import { describe, expect, it } from 'vitest';
import type { ApiScope } from '../../../shared/types.js';
import { globMatch, resolveTypes } from './filters.js';

const ALL: ApiScope[] = ['chat:read', 'status:read'];

function types(raw: string, scopes: ApiScope[] = ALL): string[] {
  const r = resolveTypes(raw, scopes);
  if (!r.ok) throw new Error(`${r.status} ${r.detail}`);
  return [...r.types].sort();
}

describe('globMatch', () => {
  it.each<[string, string, boolean]>([
    ['chat.*', 'chat.message', true],
    ['chat.*', 'chat.message.deleted', true], // * crosses dots
    ['chat.*', 'chat', false],
    ['*.down', 'destination.down', true],
    ['*', 'stream.status', true],
    ['**', 'stream.status', true],
    ['destination.*', 'destination.up', true],
    ['d*n.d*n', 'destination.down', true],
    ['chat.message', 'chat.message', true],
    ['chat.message', 'chat.message.deleted', false],
    ['*x', 'chat.message.deleted', false],
    ['', '', true],
    ['', 'a', false],
  ])('globMatch(%s, %s) = %s', (glob, s, ok) => {
    expect(globMatch(glob, s)).toBe(ok);
  });
});

describe('resolveTypes', () => {
  it('keeps the documented glob semantics', () => {
    expect(types('chat.*')).toEqual(['chat.cleared', 'chat.message', 'chat.message.deleted', 'chat.user.cleared', 'system.reset']);
    expect(types('*.down')).toEqual(['destination.down', 'system.reset']);
    expect(types('destination.*')).toEqual(['destination.down', 'destination.status', 'destination.up', 'system.reset']);
    expect(types('chat.message')).toEqual(['chat.message', 'system.reset']);
    expect(types('*', ['chat:read'])).toEqual(['chat.cleared', 'chat.message', 'chat.message.deleted', 'chat.user.cleared', 'system.reset']);
  });

  it('pathological globs are answered in milliseconds (no regex backtracking)', () => {
    const evil = [
      '*'.repeat(63) + 'x',
      '*e'.repeat(31) + 'x',
      '*.'.repeat(31) + 'x',
      '*a*e*s*t'.repeat(7) + 'x',
    ];
    for (const glob of evil) {
      const start = performance.now();
      expect(resolveTypes(glob, ALL)).toMatchObject({ ok: false, status: 400, detail: 'types matches no event type' });
      expect(performance.now() - start).toBeLessThan(50);
    }
    // The most a request may carry: 20 such globs.
    const start = performance.now();
    expect(resolveTypes(Array.from({ length: 20 }, () => '*'.repeat(63) + 'x').join(','), ALL)).toMatchObject({ ok: false, status: 400 });
    expect(performance.now() - start).toBeLessThan(100);
  });
});
