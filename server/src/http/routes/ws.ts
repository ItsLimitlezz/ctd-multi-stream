import type { FastifyPluginAsync } from 'fastify';
import type { Logger } from 'pino';
import type { WsServerMessage } from '../../../../shared/api.js';
import type { EventBus } from '../../events.js';
import { sessionRevalidator, WS_SESSION_ENDED } from '../auth-plugin.js';
import { requireUser, type RouteOptions } from '../guards.js';

export const WS_PING_INTERVAL_MS = 30_000;
/** Skip sends to clients that aren't keeping up (slow network, backgrounded tab). */
export const WS_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

const OPEN = 1; // WebSocket.OPEN

/** The subset of a `ws` WebSocket the hub uses (keeps the hub testable with fakes). */
export interface HubSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, cb?: (err?: Error) => void): void;
  ping(): void;
  terminate(): void;
  /** Graceful close with a code (falls back to terminate() when absent). */
  close?(code?: number, reason?: string): void;
  on(event: 'pong' | 'close', listener: () => void): unknown;
}

interface Client {
  socket: HubSocket;
  alive: boolean;
  /** False once the session the socket was opened with is no longer valid. */
  isValid: (() => boolean) | null;
}

/**
 * Fans bus events out to every connected UI socket (one bus subscription per event type,
 * however many clients) and runs the ping/pong heartbeat.
 */
export class WsHub {
  private readonly clients = new Set<Client>();
  private readonly unsubscribers: (() => void)[];

  constructor(
    bus: EventBus,
    private readonly log: Pick<Logger, 'debug'>,
  ) {
    this.unsubscribers = [
      bus.on('session', (session) => this.broadcast({ type: 'session', session })),
      bus.on('feed', (feed) => this.broadcast({ type: 'feed', feed })),
      bus.on('destination', (state) => this.broadcast({ type: 'destination', state })),
      bus.on('chat', (message) => this.broadcast({ type: 'chat', message })),
      bus.on('chat-moderation', (moderation) => this.broadcast({ type: 'chat-moderation', moderation })),
      bus.on('account', (account) => this.broadcast({ type: 'account', account })),
      bus.on('destinations-changed', () => this.broadcast({ type: 'destinations-changed' })),
      bus.on('notice', (n) => this.broadcast({ type: 'notice', level: n.level, message: n.message })),
    ];
  }

  get size(): number {
    return this.clients.size;
  }

  /**
   * Register a socket; `hello` is sent first so it always precedes forwarded events.
   * `isValid` is re-checked on every heartbeat; the socket is closed with 4401 once it fails.
   */
  add(socket: HubSocket, hello: WsServerMessage, isValid?: () => boolean): void {
    const client: Client = { socket, alive: true, isValid: isValid ?? null };
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('close', () => this.clients.delete(client));
    this.send(client, JSON.stringify(hello));
    if (socket.readyState === OPEN) this.clients.add(client);
  }

  broadcast(msg: WsServerMessage): void {
    if (this.clients.size === 0) return;
    const data = JSON.stringify(msg);
    for (const client of this.clients) this.send(client, data);
  }

  /** One heartbeat round: close revoked sessions, terminate clients that missed the previous ping, ping the rest. */
  heartbeat(): void {
    for (const client of this.clients) {
      if (!this.stillValid(client)) {
        this.clients.delete(client);
        if (client.socket.close) client.socket.close(WS_SESSION_ENDED, 'Session ended');
        else client.socket.terminate();
        continue;
      }
      if (!client.alive) {
        this.clients.delete(client);
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      try {
        client.socket.ping();
      } catch {
        this.clients.delete(client);
        client.socket.terminate();
      }
    }
  }

  close(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    for (const client of this.clients) client.socket.terminate();
    this.clients.clear();
  }

  private stillValid(client: Client): boolean {
    if (!client.isValid) return true;
    try {
      return client.isValid();
    } catch (err) {
      // A transient DB error must not sign everyone out; the next round checks again.
      this.log.debug({ error: (err as Error).message }, 'ws session re-check failed');
      return true;
    }
  }

  private send(client: Client, data: string): void {
    const { socket } = client;
    if (socket.readyState !== OPEN || socket.bufferedAmount > WS_MAX_BUFFERED_BYTES) return;
    try {
      socket.send(data, (err) => {
        if (err) this.log.debug({ error: err.message }, 'ws send failed');
      });
    } catch (err) {
      this.log.debug({ error: (err as Error).message }, 'ws send failed');
    }
  }
}

/** GET /api/ws [user]: live events for the web UI (see WsServerMessage). Client messages are ignored. */
const wsRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  const log = services.log.child({ mod: 'ws' });
  const hub = new WsHub(services.bus, log);
  const timer = setInterval(() => hub.heartbeat(), WS_PING_INTERVAL_MS);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    hub.close();
  });

  app.get('/api/ws', { websocket: true, preHandler: requireUser }, (socket, req) => {
    socket.on('message', () => {
      // Read-only channel: ignore anything the client sends.
    });
    let hello: WsServerMessage;
    try {
      hello = { type: 'hello', session: services.orchestrator.state(), chat: services.chat.recent(200) };
    } catch (err) {
      log.error({ error: (err as Error).message }, 'building ws hello failed');
      socket.close(1011, 'Internal error');
      return;
    }
    hub.add(socket, hello, sessionRevalidator(services, req));
  });
};

export default wsRoutes;
