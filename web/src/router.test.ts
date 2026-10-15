import { describe, expect, it } from 'vitest';
import { buildSearch, matchRoute, normalizePath, ROUTES, safeReturnPath, withStickyParams } from './router';

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
    expect(admin).toEqual(['destinations', 'accounts', 'settings', 'profiles']);
  });

  it('has a profiles page outside the main nav (reached from the switcher and Settings)', () => {
    expect(matchRoute('/profiles').name).toBe('profiles');
    expect(matchRoute('/profile').name).toBe('profile'); // the user's own page is unchanged
    expect(ROUTES.find((r) => r.name === 'profiles')?.nav).toBe(false);
  });

  it('keeps the current profile on in-app links', () => {
    const here = '?profile=p2&tab=api';
    expect(withStickyParams('/chat', here)).toBe('/chat?profile=p2');
    expect(withStickyParams('/settings?tab=obs', here)).toBe('/settings?tab=obs&profile=p2');
    expect(withStickyParams('/settings?tab=obs#x', here)).toBe('/settings?tab=obs&profile=p2#x');
    // An explicit profile wins (switching through a link).
    expect(withStickyParams('/accounts?profile=other', here)).toBe('/accounts?profile=other');
    // Nothing to carry, or not an app path.
    expect(withStickyParams('/chat', '?tab=api')).toBe('/chat');
    expect(withStickyParams('/chat', '')).toBe('/chat');
    expect(withStickyParams('https://example.com/x', here)).toBe('https://example.com/x');
    expect(withStickyParams('//evil.example', here)).toBe('//evil.example');
    expect(withStickyParams('?tab=x', here)).toBe('?tab=x');
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
