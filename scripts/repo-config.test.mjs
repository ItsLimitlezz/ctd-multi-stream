// Guards for repository configuration that fails silently when wrong: Vitest projects that collect no
// files, and a Docker build context that ships local data folders (database, master.key) to the daemon.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import vitestConfig from '../vitest.config.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('vitest.config.ts', () => {
  const projects = /** @type {Array<{ test: { name: string, include: string[] } }>} */ (vitestConfig.test?.projects ?? []);

  it('defines the server and web projects', () => {
    expect(projects.map((p) => p.test.name).sort()).toEqual(['server', 'web']);
  });

  // Inline projects resolve `include` against the repository root (not an extended Vite `root`).
  it.each(projects.map((p) => [p.test.name, p.test.include]))('project %s collects test files', (_name, include) => {
    const files = include.flatMap((pattern) => fs.globSync(pattern, { cwd: root, exclude: (f) => f.includes('node_modules') }));
    expect(files.length).toBeGreaterThan(0);
  });

  it('web project covers web/src', () => {
    const web = projects.find((p) => p.test.name === 'web');
    const files = (web?.test.include ?? []).flatMap((pattern) => fs.globSync(pattern, { cwd: root }));
    expect(files.some((f) => f.replaceAll('\\', '/').startsWith('web/src/'))).toBe(true);
  });
});

describe('.dockerignore', () => {
  const patterns = fs
    .readFileSync(path.join(root, '.dockerignore'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  /** Docker semantics for top-level paths: last matching pattern wins, `!` re-includes. */
  function ignored(/** @type {string} */ rel) {
    let result = false;
    for (const p of patterns) {
      const negate = p.startsWith('!');
      const glob = negate ? p.slice(1) : p;
      if (path.posix.matchesGlob(rel, glob)) result = !negate;
    }
    return result;
  }

  it.each(['data', 'data-dev', 'data-test', 'tools', '.env', '.env.local', 'node_modules', 'dist', '.git'])(
    'excludes %s',
    (rel) => {
      expect(ignored(rel)).toBe(true);
    },
  );

  it.each([
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'vite.config.ts',
    'LICENSE',
    'server',
    'shared',
    'web',
    'scripts/setup-tools.mjs',
    'scripts/healthcheck.mjs',
  ])('keeps %s (needed by the Dockerfile)', (rel) => {
    expect(ignored(rel)).toBe(false);
  });
});
