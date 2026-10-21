// GET /api/v1/obs/socket (WebSocket, obs:control): the OBS socket relay CTD Live mobile connects
// to from anywhere (obs-relay.ts, docs/API.md §12).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sendProblem } from './http.js';
import { MAX_SOCKETS_PER_TOKEN, obsRelayFor } from './obs-relay.js';
import type { V1Context } from './v1.js';

export function registerObsSocketRoute(app: FastifyInstance, ctx: V1Context): void {
  const relay = obsRelayFor(ctx.services);

  const socketSlot = async (req: FastifyRequest, reply: FastifyReply) => {
    const { token } = ctx.authOf(req);
    if (relay.socketsFor(token.id) >= MAX_SOCKETS_PER_TOKEN) {
      reply.header('retry-after', '30');
      return sendProblem(reply, 429, 'rate_limited', `At most ${MAX_SOCKETS_PER_TOKEN} OBS sockets per token; close one first.`);
    }
  };

  app.get('/obs/socket', { websocket: true, preHandler: [ctx.requireToken('obs:control'), socketSlot] }, (socket, req) => {
    relay.accept(socket, ctx.authOf(req).token, req.ip ?? null);
  });

  app.addHook('preClose', async () => {
    relay.closeAll();
  });
}
