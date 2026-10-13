// After a container update the old build's lazily loaded chunks are gone (404). React.lazy caches
// the failed import, so retrying the render can't help: the page has to be reloaded.

const RELOAD_KEY = 'ctd.chunkReloadAt';
/** Don't reload again within this window (the new build is broken too, or the server is down). */
export const CHUNK_RELOAD_GUARD_MS = 30_000;

/** A failed dynamic import / preload of a build chunk (wording differs per browser and Vite). */
export function isChunkLoadError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (?:CSS )?chunk .* failed/i.test(
    message,
  );
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function safeStorage(): StorageLike | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Reload the page to pick up the new build, at most once per CHUNK_RELOAD_GUARD_MS (per tab).
 * Returns false when it didn't reload (the caller shows the error, whose button reloads by hand).
 * Without session storage there is no loop guard, so it never reloads by itself.
 */
export function reloadForNewBuild(
  now = Date.now(),
  storage: StorageLike | null = safeStorage(),
  reload: () => void = () => location.reload(),
): boolean {
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(RELOAD_KEY) ?? '');
    if (last > 0 && now - last >= 0 && now - last < CHUNK_RELOAD_GUARD_MS) return false;
    storage.setItem(RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}

/** Wrap a lazy page import: on a chunk load error, reload once instead of failing. */
export function reloadingImport<T>(load: () => Promise<T>): () => Promise<T> {
  return () =>
    load().catch((err: unknown) => {
      // While the page reloads, stay suspended rather than flashing the error boundary.
      if (isChunkLoadError(err) && reloadForNewBuild()) return new Promise<T>(() => undefined);
      throw err;
    });
}
