// Kick's realtime chat connection (since Oct 2026). kick.com no longer uses a fixed Pusher key: its
// frontend asks web.kick.com which provider serves a channel's chat, and today the answer is a
// Centrifugo websocket (the old Pusher key is gone: "App key … not in this cluster" on every cluster).
// Seen in kick.com's frontend (Realtime.postChatroomConnection / postAuthConnection) and probed live:
//
//   POST https://web.kick.com/api/v1/realtime/channels/{channelId}/chat/connection
//        { client: { id: <uuid>, type: 'web' }, capabilities: { accepted_providers: [{ provider: 'pusher' }, { provider: 'centrifugo' }] } }
//     → { data: { connections: [{ provider: 'centrifugo', credentials: { url: 'wss://realtime.<region>.platform.kick.com/connection/websocket' } }] } }
//        (or provider 'pusher' with credentials { app_key, cluster })
//   POST https://web.kick.com/api/v1/realtime/auth/connection { client_id: <same uuid> }
//     → { data: { token: <guest JWT, ~45 min> } }
//
// Centrifugo's JSON protocol (https://centrifugal.dev/docs/transports/client_protocol): send
// { id, connect: { token, name } }, then { id, subscribe: { channel } } for the same channel names as
// before (chatrooms.<id>.v2, chatroom_<id>, channel_<id>); publications arrive as
// { push: { channel, pub: { data: { event: 'App\\Events\\ChatMessageEvent', data: '<json>' } } } } — the
// same events and payloads the Pusher feed carried, so chat.ts parses them unchanged. The server
// pings with {} and expects {} back; frames may hold several newline-separated messages.

import { PusherError, type PusherEvent } from './pusher.js';

export const KICK_WEB_API = 'https://web.kick.com/api';

const CONNECT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_QUEUE = 1000;
/** Refresh the guest token this long before it expires. */
const REFRESH_AHEAD_MS = 120_000;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

export type RealtimeTarget =
  | { provider: 'centrifugo'; url: string; clientId: string }
  | { provider: 'pusher'; appKey: string; cluster: string };

type FetchLike = typeof fetch;

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

async function postJson(url: string, body: unknown, signal: AbortSignal, fetchImpl: FetchLike): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA, origin: 'https://kick.com', referer: 'https://kick.com/' },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
  if (!res.ok) throw new PusherError(`Kick's realtime service answered HTTP ${res.status}`, res.status, res.status === 404);
  return res.json();
}

/** Which provider serves this channel's chat (what kick.com's frontend asks before connecting). */
export async function kickRealtimeTarget(
  channelId: number,
  signal: AbortSignal,
  opts: { fetchImpl?: FetchLike; base?: string } = {},
): Promise<RealtimeTarget> {
  const clientId = crypto.randomUUID();
  const json = await postJson(
    `${opts.base ?? KICK_WEB_API}/v1/realtime/channels/${channelId}/chat/connection`,
    { client: { id: clientId, type: 'web' }, capabilities: { accepted_providers: [{ provider: 'pusher' }, { provider: 'centrifugo' }] } },
    signal,
    opts.fetchImpl ?? fetch,
  );
  const connections = asRecord(asRecord(json)?.data)?.connections;
  for (const c of Array.isArray(connections) ? connections : []) {
    const rec = asRecord(c);
    const cred = asRecord(rec?.credentials);
    if (rec?.provider === 'centrifugo' && typeof cred?.url === 'string' && /^wss:\/\//i.test(cred.url)) {
      return { provider: 'centrifugo', url: cred.url, clientId };
    }
    if (rec?.provider === 'pusher' && typeof cred?.app_key === 'string' && typeof cred.cluster === 'string') {
      return { provider: 'pusher', appKey: cred.app_key, cluster: cred.cluster };
    }
  }
  throw new PusherError("Kick's realtime service offered no chat connection this app understands", null, false);
}

/** A guest connection token for `clientId` (kick.com does this for viewers who aren't logged in). */
export async function kickGuestToken(clientId: string, signal: AbortSignal, opts: { fetchImpl?: FetchLike; base?: string } = {}): Promise<string> {
  const json = await postJson(`${opts.base ?? KICK_WEB_API}/v1/realtime/auth/connection`, { client_id: clientId }, signal, opts.fetchImpl ?? fetch);
  const token = asRecord(asRecord(json)?.data)?.token;
  if (typeof token !== 'string' || !token) throw new PusherError("Kick's realtime service gave no guest token");
  return token;
}

export function pusherUrlFor(appKey: string, cluster: string): string {
  const query = new URLSearchParams({ protocol: '7', client: 'js', version: '8.4.0', flash: 'false' });
  return `wss://ws-${encodeURIComponent(cluster)}.pusher.com/app/${encodeURIComponent(appKey)}?${query.toString()}`;
}

export interface CentrifugoOptions {
  url: string;
  /** Connection token; called again to refresh it before it expires. */
  token: () => Promise<string>;
  channels: string[];
  /** Also subscribed; a refused subscription is ignored (a refusal on `channels` ends the connection). */
  optionalChannels?: string[];
  signal: AbortSignal;
  connectTimeoutMs?: number;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/**
 * Connect to Kick's Centrifugo chat, subscribe, and yield every publication as a PusherEvent
 * (`event` = the Laravel event name, `data` parsed) until `signal` aborts. Throws PusherError when
 * the connection fails, is refused, closes or goes silent, so the ChatHub reconnects with backoff.
 */
export async function* centrifugoEvents(opts: CentrifugoOptions): AsyncGenerator<PusherEvent> {
  const { signal } = opts;
  if (signal.aborted) return;
  const optional = (opts.optionalChannels ?? []).filter((c) => !opts.channels.includes(c));
  const token = await opts.token();
  if (signal.aborted) return;

  const queue: PusherEvent[] = [];
  let failure: Error | null = null;
  let notify: (() => void) | null = null;
  let nextId = 1;
  const pending = new Map<number, { kind: 'connect' | 'subscribe' | 'refresh'; channel?: string }>();
  let silenceTimer: NodeJS.Timeout | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let silenceMs = 60_000;

  const wake = (): void => {
    const n = notify;
    notify = null;
    n?.();
  };
  const fail = (err: Error): void => {
    failure ??= err;
    wake();
  };

  const ws = new WebSocket(opts.url);
  const send = (msg: Record<string, unknown>, kind: 'connect' | 'subscribe' | 'refresh', channel?: string): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const id = nextId++;
    pending.set(id, { kind, ...(channel ? { channel } : {}) });
    ws.send(JSON.stringify({ id, ...msg }));
  };
  const connectTimer = setTimeout(() => fail(new PusherError('Timed out connecting to Kick chat')), opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
  // Anything from the server (pings included) proves the connection is alive.
  const armSilence = (): void => {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => fail(new PusherError('Kick chat connection went silent')), silenceMs);
  };
  const scheduleRefresh = (ttlSec: number): void => {
    clearTimeout(refreshTimer);
    const ms = Math.max(30_000, ttlSec * 1000 - REFRESH_AHEAD_MS);
    refreshTimer = setTimeout(() => {
      opts.token().then(
        (fresh) => send({ refresh: { token: fresh } }, 'refresh'),
        (err: unknown) => fail(err instanceof Error ? err : new PusherError('Refreshing the Kick chat token failed')),
      );
    }, ms);
  };

  const onReply = (msg: Record<string, unknown>): void => {
    const id = typeof msg.id === 'number' ? msg.id : null;
    const req = id !== null ? pending.get(id) : undefined;
    if (id !== null) pending.delete(id);
    if (!req) return;
    const error = asRecord(msg.error);
    if (error) {
      const text = `${typeof error.code === 'number' ? `${error.code} ` : ''}${typeof error.message === 'string' ? error.message.slice(0, 200) : 'error'}`;
      if (req.kind === 'subscribe' && req.channel && optional.includes(req.channel)) return;
      fail(new PusherError(`Kick chat refused the ${req.kind === 'subscribe' ? 'chatroom subscription' : req.kind}: ${text}`, null, req.kind === 'subscribe'));
      return;
    }
    if (req.kind === 'connect') {
      clearTimeout(connectTimer);
      const connect = asRecord(msg.connect);
      const ping = typeof connect?.ping === 'number' && connect.ping > 0 ? connect.ping : 25;
      silenceMs = (ping + 20) * 1000;
      armSilence();
      if (connect?.expires === true && typeof connect.ttl === 'number' && connect.ttl > 0) scheduleRefresh(connect.ttl);
      for (const channel of [...opts.channels, ...optional]) send({ subscribe: { channel } }, 'subscribe', channel);
    } else if (req.kind === 'refresh') {
      const refresh = asRecord(msg.refresh);
      if (refresh?.expires === true && typeof refresh.ttl === 'number' && refresh.ttl > 0) scheduleRefresh(refresh.ttl);
    }
  };

  const onLine = (line: string): void => {
    let msg: Record<string, unknown> | null;
    try {
      msg = asRecord(JSON.parse(line));
    } catch {
      return;
    }
    if (!msg) return;
    armSilence();
    if (Object.keys(msg).length === 0) {
      if (ws.readyState === WebSocket.OPEN) ws.send('{}'); // ping → pong
      return;
    }
    if ('id' in msg) return onReply(msg);
    const push = asRecord(msg.push);
    if (!push) return;
    if (asRecord(push.disconnect)) {
      const d = asRecord(push.disconnect)!;
      fail(new PusherError(`Kick chat disconnected us: ${typeof d.reason === 'string' ? d.reason.slice(0, 200) : 'no reason'}`, typeof d.code === 'number' ? d.code : null));
      return;
    }
    const data = asRecord(asRecord(push.pub)?.data);
    if (!data || typeof data.event !== 'string') return;
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({ event: data.event, channel: typeof push.channel === 'string' ? push.channel : null, data: parseMaybeJson(data.data) });
    wake();
  };

  const onOpen = (): void => send({ connect: { token, name: 'js' } }, 'connect');
  const onMessage = (ev: MessageEvent): void => {
    if (typeof ev.data !== 'string') return;
    for (const line of ev.data.split('\n')) if (line.trim()) onLine(line);
  };
  const onClose = (ev: CloseEvent): void => {
    const reason = ev.reason ? `: ${ev.reason.slice(0, 200)}` : '';
    fail(new PusherError(`Kick chat connection closed (code ${ev.code}${reason})`, ev.code));
  };
  const onError = (): void => fail(new PusherError('Kick chat connection error'));
  const onAbort = (): void => wake();

  ws.addEventListener('open', onOpen);
  ws.addEventListener('message', onMessage);
  ws.addEventListener('close', onClose);
  ws.addEventListener('error', onError);
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      if (signal.aborted) return;
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (failure) throw failure;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(silenceTimer);
    clearTimeout(refreshTimer);
    signal.removeEventListener('abort', onAbort);
    ws.removeEventListener('open', onOpen);
    ws.removeEventListener('message', onMessage);
    ws.removeEventListener('close', onClose);
    ws.removeEventListener('error', onError);
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
      try {
        ws.close(1000);
      } catch {
        /* already closing */
      }
    }
  }
}
