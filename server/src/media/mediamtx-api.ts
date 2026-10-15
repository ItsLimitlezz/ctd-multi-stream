// Minimal MediaMTX control API client (v3, loopback only).
// https://github.com/bluenviron/mediamtx/blob/v1.21.2/api/openapi.yaml

import type { MtxPath, MtxPathList } from './feed-state.js';

export type FetchFn = typeof fetch;

const REQUEST_TIMEOUT_MS = 2_000;

/** Source type -> kick endpoint prefix. */
const KICK_ROUTES: Record<string, string> = {
  rtmpConn: 'rtmp/conns',
  rtmpsConn: 'rtmps/conns',
  srtConn: 'srt/conns',
  rtspSession: 'rtsp/sessions',
  rtspsSession: 'rtsps/sessions',
  webRTCSession: 'webrtc/sessions',
};

export interface MediaMtxApi {
  listPaths(signal?: AbortSignal): Promise<MtxPath[]>;
  /** Disconnect whoever is publishing to `pathName`. Returns false when nobody was. */
  kickPublisher(pathName: string): Promise<boolean>;
}

export function createMediaMtxApi(port: number, fetchImpl: FetchFn = fetch): MediaMtxApi {
  const base = `http://127.0.0.1:${port}/v3`;

  const call = async (method: 'GET' | 'POST', route: string, signal?: AbortSignal): Promise<Response> => {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const res = await fetchImpl(`${base}/${route}`, {
      method,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`MediaMTX API ${method} /${route.split('/').slice(0, 2).join('/')} -> HTTP ${res.status}`);
    }
    return res;
  };

  const listPaths = async (signal?: AbortSignal): Promise<MtxPath[]> => {
    // Two static paths + the active paths of every other profile; one page is plenty.
    const res = await call('GET', 'paths/list?itemsPerPage=1000', signal);
    const body = (await res.json()) as MtxPathList;
    return Array.isArray(body.items) ? body.items : [];
  };

  return {
    listPaths,
    async kickPublisher(pathName) {
      const item = (await listPaths()).find((p) => p.name === pathName);
      const source = item?.source;
      const route = source?.type ? KICK_ROUTES[source.type] : undefined;
      if (!source?.id || !route) return false;
      const res = await call('POST', `${route}/kick/${encodeURIComponent(source.id)}`);
      await res.body?.cancel().catch(() => {});
      return true;
    },
  };
}
