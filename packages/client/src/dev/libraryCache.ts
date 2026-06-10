/**
 * Tiny localStorage cache for the Library's entity lists (local + community), used
 * stale-while-revalidate: the Library paints the cached lists instantly on open,
 * then always revalidates in the background and repaints + re-caches. Survives a
 * page refresh, so the Library never shows an empty/loading grid on a warm cache.
 */
const PREFIX = "gorilator-lib-cache:";

export function readCache<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data: T; ts: number };
    return parsed?.data ?? null;
  } catch {
    return null;
  }
}

export function writeCache<T>(key: string, data: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ data, ts: Date.now() }));
  } catch {
    /* quota exceeded / storage disabled — caching is best-effort */
  }
}

export const CACHE_LOCAL = "local-v1";
export const CACHE_COMMUNITY = "community-v1";
