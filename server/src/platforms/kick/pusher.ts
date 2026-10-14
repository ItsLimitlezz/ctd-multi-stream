// Minimal read-only Pusher Channels client (protocol 7) for Kick's public chat websocket.
// Protocol: https://pusher.com/docs/channels/library_auth_reference/pusher-websockets-protocol/
// Kick's web chat uses the public app key below on cluster us2 (seen in kick.com's frontend and
// community clients, e.g. https://github.com/236sec/streamer-chat/pull/5, Sep 2026). The key is not an
// official API and has changed before: KICK_PUSHER_KEY / KICK_PUSHER_CLUSTER override it without a rebuild.

export const KICK_PUSHER_KEY = '32cbd69e4b950bf97679';
export const KICK_PUSHER_CLUSTER = 'us2';

const CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_ACTIVITY_MS = 120_000;
const PONG_TIMEOUT_MS = 30_000;
const MAX_QUEUE = 1000;

export function kickPusherUrl(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.KICK_PUSHER_KEY?.trim() || KICK_PUSHER_KEY;
  const cluster = env.KICK_PUSHER_CLUSTER?.trim() || KICK_PUSHER_CLUSTER;
  // Same client parameters as kick.com's own pusher-js build.
  const query = new URLSearchParams({ protocol: '7', client: 'js', version: '8.4.0-rc2', flash: 'false' });
  return `wss://ws-${encodeURIComponent(cluster)}.pusher.com/app/${encodeURIComponent(key)}?${query.toString()}`;
}

export interface PusherEvent {
  event: string;
  channel: string | null;
  /** `data` with JSON strings already parsed (Pusher double-encodes it). */
  data: unknown;
}

export interface PusherOptions {
  url: string;
  channels: string[];
  /**
   * Also subscribed, but a refused subscription is ignored (extra event channels that Kick may
   * rename); a refusal on one of `channels` ends the connection.
   */
  optionalChannels?: string[];
  signal: AbortSignal;
  connectTimeoutMs?: number;
  /** Client-side inactivity before we ping. Default: the server's activity_timeout (120 s). */
  activityTimeoutMs?: number;
  pongTimeoutMs?: number;
}

/** Error from the Pusher connection. `fatal`: reconnecting with the same settings won't help. */
export class PusherError extends Error {
  constructor(
    message: string,
    readonly code: number | null = null,
    readonly fatal = false,
  ) {
    super(message);
    this.name = 'PusherError';
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Pusher error codes: 4000-4099 = don't reconnect, 4100-4199 = back off, 4200-4299 = reconnect. */
function pusherError(data: unknown): PusherError | null {
  const d = asRecord(data);
  const code = typeof d?.code === 'number' ? d.code : null;
  const message = typeof d?.message === 'string' ? d.message.slice(0, 200) : 'unknown error';
  if (code !== null && code >= 4300) return null; // client-event rejections etc.: not fatal
  const fatal = code !== null && code >= 4000 && code < 4100;
  const hint = fatal ? ' — Kick may have changed its chat key; set KICK_PUSHER_KEY / KICK_PUSHER_CLUSTER to update it' : '';
  return new PusherError(`Kick chat server error${code !== null ? ` ${code}` : ''}: ${message}${hint}`, code, fatal);
}

/**
 * Connect, subscribe to `channels` and yield every non-protocol event until `signal` aborts
 * (then it returns quietly). Throws PusherError when the connection fails, closes or goes
 * silent, so the caller (ChatHub) can reconnect with backoff. Answers server pings and pings the
 * server after inactivity, as the protocol requires.
 */
export async function* pusherEvents(opts: PusherOptions): AsyncGenerator<PusherEvent> {
  const { signal } = opts;
  if (signal.aborted) return;

  const optional = (opts.optionalChannels ?? []).filter((c) => !opts.channels.includes(c));
  const queue: PusherEvent[] = [];
  let failure: Error | null = null;
  let notify: (() => void) | null = null;
  let activityMs = opts.activityTimeoutMs ?? DEFAULT_ACTIVITY_MS;
  let activityTimer: NodeJS.Timeout | undefined;
  let pongTimer: NodeJS.Timeout | undefined;

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
  const send = (event: string, data: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event, data }));
  };

  const connectTimer = setTimeout(
    () => fail(new PusherError('Timed out connecting to Kick chat')),
    opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
  );

  const armActivity = (): void => {
    clearTimeout(activityTimer);
    clearTimeout(pongTimer);
    activityTimer = setTimeout(() => {
      send('pusher:ping', {});
      pongTimer = setTimeout(
        () => fail(new PusherError('Kick chat connection went silent')),
        opts.pongTimeoutMs ?? PONG_TIMEOUT_MS,
      );
    }, activityMs);
  };

  const onFrame = (raw: string): void => {
    let frame: Record<string, unknown> | null;
    try {
      frame = asRecord(JSON.parse(raw));
    } catch {
      return;
    }
    const event = typeof frame?.event === 'string' ? frame.event : null;
    if (!frame || !event) return;
    armActivity();
    const data = parseMaybeJson(frame.data);
    switch (event) {
      case 'pusher:connection_established': {
        clearTimeout(connectTimer);
        const timeoutSec = asRecord(data)?.activity_timeout;
        if (opts.activityTimeoutMs === undefined && typeof timeoutSec === 'number' && timeoutSec > 0) {
          activityMs = Math.min(timeoutSec, 120) * 1000;
          armActivity();
        }
        for (const channel of [...opts.channels, ...optional]) send('pusher:subscribe', { auth: '', channel });
        return;
      }
      case 'pusher:ping':
        send('pusher:pong', {});
        return;
      case 'pusher:error': {
        const err = pusherError(data);
        if (err) fail(err);
        return;
      }
      case 'pusher:subscription_error':
        if (typeof frame.channel === 'string' && optional.includes(frame.channel)) return;
        fail(new PusherError('Kick chat refused the chatroom subscription', null, true));
        return;
      default:
        if (event.startsWith('pusher:') || event.startsWith('pusher_internal:')) return;
        if (queue.length >= MAX_QUEUE) queue.shift();
        queue.push({ event, channel: typeof frame.channel === 'string' ? frame.channel : null, data });
        wake();
    }
  };

  const onMessage = (ev: MessageEvent): void => {
    if (typeof ev.data === 'string') onFrame(ev.data);
  };
  const onClose = (ev: CloseEvent): void => {
    const reason = ev.reason ? `: ${ev.reason.slice(0, 200)}` : '';
    const fatal = ev.code >= 4000 && ev.code < 4100;
    fail(new PusherError(`Kick chat connection closed (code ${ev.code}${reason})`, ev.code, fatal));
  };
  const onError = (): void => fail(new PusherError('Kick chat connection error'));
  const onAbort = (): void => wake();

  ws.addEventListener('message', onMessage);
  ws.addEventListener('close', onClose);
  ws.addEventListener('error', onError);
  signal.addEventListener('abort', onAbort, { once: true });
  armActivity();

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
    clearTimeout(activityTimer);
    clearTimeout(pongTimer);
    signal.removeEventListener('abort', onAbort);
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
