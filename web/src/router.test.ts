import { describe, expect, it } from 'vitest';
import { buildSearch, matchRoute, normalizePath, ROUTES, safeReturnPath } from './router';

describe('router helpers', () => {
  it('matches known routes and falls back to the dashboard', () => {
    expect(matchRoute('/').name).toBe('dashboard');
    expect(matchRoute('/chat').name).toBe('chat');
    expect(matchRoute('/chat/').name).toBe('chat');
    expect(matchRoute('//settings').name).toBe('settings');
    expect(matchRoute('/Accounts').name).toBe('accounts');
    expect(matchRoute('/nope').name).toBe('dashboard');
    expect(matchRoute('/destinations/123').name).toBe('dashboard');
  });

  it('marks admin routes', () => {
    const admin = ROUTES.filter((r) => r.adminOnly).map((r) => r.name);
    expect(admin).toEqual(['destinations', 'accounts', 'settings']);
  });

  it('normalizes paths', () => {
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('/a//b/')).toBe('/a/b');
  });

  it('only allows same-origin app paths as return targets', () => {
    expect(safeReturnPath('/accounts?connected=abc')).toBe('/accounts?connected=abc');
    expect(safeReturnPath('/settings?tab=users')).toBe('/settings?tab=users');
    expect(safeReturnPath('https://evil.example')).toBeNull();
    expect(safeReturnPath('//evil.example')).toBeNull();
    expect(safeReturnPath('/\\evil.example')).toBeNull();
    expect(safeReturnPath('/login')).toBeNull();
    expect(safeReturnPath('/setup?x=1')).toBeNull();
    expect(safeReturnPath('/chat\n')).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
  });

  it('builds query strings', () => {
    expect(buildSearch({ tab: 'users', empty: '', none: null, n: 2 })).toBe('?tab=users&n=2');
    expect(buildSearch({})).toBe('');
  });
});
