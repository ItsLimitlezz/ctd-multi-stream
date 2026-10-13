import type { FastifyPluginAsync } from 'fastify';
import type { RouteOptions } from '../guards.js';

const healthRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  app.get('/healthz', async () => ({ ok: true, version: services.config.version }));
};

export default healthRoutes;
