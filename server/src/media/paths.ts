import { FEEDS, type Feed } from '../../../shared/types.js';

/** RTMP application name. OBS server URL = rtmp://<host>:<port>/live, stream key = '<feed>?key=<k>'. */
export const APP_NAME = 'live';

/** MediaMTX user FFmpeg authenticates as when reading a feed (from loopback only). */
export const INTERNAL_READER_USER = 'internal';

/** MediaMTX path for a feed, e.g. 'live/landscape'. */
export function feedPath(feed: Feed): string {
  return `${APP_NAME}/${feed}`;
}

/** Inverse of feedPath; null for any other path. Tolerates a leading slash. */
export function feedForPath(path: string): Feed | null {
  const p = path.startsWith('/') ? path.slice(1) : path;
  return FEEDS.find((f) => feedPath(f) === p) ?? null;
}
