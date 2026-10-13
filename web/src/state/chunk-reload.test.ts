import { describe, expect, it, vi } from 'vitest';
import { CHUNK_RELOAD_GUARD_MS, isChunkLoadError, reloadForNewBuild } from './chunk-reload';

const memoryStorage = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

describe('chunk load errors', () => {
  it('recognizes failed dynamic imports in every browser', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://h/assets/AccountsPage-abc.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: https://h/assets/x.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/admin.css'))).toBe(true);
    expect(isChunkLoadError(new Error("Cannot read properties of undefined (reading 'x')"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });

  it('reloads once, then lets the error show for a while', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    expect(reloadForNewBuild(1_000_000, storage, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    // The reloaded page fails too: don't loop.
    expect(reloadForNewBuild(1_000_000 + 2000, storage, reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    // A later update in the same tab reloads again.
    expect(reloadForNewBuild(1_000_000 + CHUNK_RELOAD_GUARD_MS + 1, storage, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('never reloads by itself without session storage (no loop guard)', () => {
    const reload = vi.fn();
    expect(reloadForNewBuild(1, null, reload)).toBe(false);
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => undefined,
    };
    expect(reloadForNewBuild(1, throwing, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
