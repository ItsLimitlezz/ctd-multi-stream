// Forwards chat moderation (deleted messages, banned users, cleared chat) to the OBS chat overlay
// sockets (/overlay/ws) as { type: 'chat-moderation', moderation }, so the overlay can take removed
// messages off the screen.
//
// The overlay route (routes/chat.ts) owns those sockets; this plugin observes them through the
// websocket server's 'connection' event (emitted by @fastify/websocket for every upgrade), checks
// the overlay token the same way the route does, and stops on close. Register after
// @fastify/websocket.

import type { IncomingMessage } from 'node:http';
import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from 'ws';
import type { WsServerMessage } from '../../../shared/api.js';
import type { RouteOptions } from '../http/guards.js';
import { safeErrorMessage } from './redact.js';
import { tokensEqual } from './token.js';

export const OVERLAY_WS_PATH = '/overlay/ws';
const MAX_TOKEN_LENGTH = 256;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

function overlayToken(req: IncomingMessage): string | null {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://overlay.invalid');
  } catch {
    return null;
  }
  if (url.pathname !== OVERLAY_WS_PATH) return null;
  const all = url.searchParams.getAll('token');
  const token = all.length === 1 ? all[0] : undefined;
  return token && token.length <= MAX_TOKEN_LENGTH ? token : null;
}

const overlayModeration: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  const log = services.log.child({ mod: 'overlay-moderation' });
  const wss = (app as { websocketServer?: { on(event: 'connection', fn: (ws: WebSocket, req: IncomingMessage) => void): unknown } })
    .websocketServer;
  if (!wss) {
    log.warn('websocket server not registered; overlay moderation disabled');
    return;
  }

  wss.on('connection', (socket, req) => {
    const token = overlayToken(req);
    if (token === null) return;
    let unsubscribe: (() => void) | null = null;
    let closed = false;
    socket.once('close', () => {
      closed = true;
      unsubscribe?.();
    });

    services.chat.overlayToken().then(
      (current) => {
        if (closed || socket.readyState !== socket.OPEN || !tokensEqual(token, current)) return;
        unsubscribe = services.bus.on('chat-moderation', (moderation) => {
          if (socket.readyState !== socket.OPEN) return;
          if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return; // the route terminates slow readers
          const msg: WsServerMessage = { type: 'chat-moderation', moderation };
          socket.send(JSON.stringify(msg));
        });
      },
      (err: unknown) => log.warn({ reason: safeErrorMessage(err) }, 'overlay token lookup failed'),
    );
  });
};

export default overlayModeration;
