// Browser login viewer routes [admin]: open/close an account's browser and stream it over WebSocket.

import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { BrowserServerMessage } from '../../../../shared/api.js';
import { accountInUse, ACCOUNT_LIVE_MESSAGE } from '../../browser/account-in-use.js';
import { isMacUserAgent } from '../../browser/keys.js';
import { decodeBrowserClientMessage } from '../../browser/protocol.js';
import { navErrorMessage, parseHttpUrl, redactUrl, safeErrorMessage } from '../../browser/util.js';
import { BrowserViewer } from '../../browser/viewer.js';
import { SESSION_RECHECK_MS, sessionRevalidator, WS_SESSION_ENDED } from '../auth-plugin.js';
import { audit, requireAdmin, sendError, type RouteOptions } from '../guards.js';

/** Frames are dropped while this much data is still queued on the socket. */
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

/** Tunables (mutable for tests). */
export const viewerTimings = { sessionRecheckMs: SESSION_RECHECK_MS };

const ParamsSchema = z.object({ accountId: z.string().min(1).max(128) });
const OpenSchema = z.object({ url: z.string().max(4096).optional() });
const CloseSchema = z.object({ save: z.boolean() });

interface ViewerSlot {
  accountId: string;
  socket: WebSocket;
  viewer: BrowserViewer | null;
  ended: boolean;
  /** Periodic re-check of the admin session the socket was opened with. */
  recheck: NodeJS.Timeout | null;
}

const browserRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  const log = services.log.child({ mod: 'browser-viewer' });
  /** One live viewer per account; a new connection replaces the old one. */
  const viewers = new Map<string, ViewerSlot>();

  async function endViewer(slot: ViewerSlot, opts: { save: boolean; closeCode?: number; reason?: string }): Promise<void> {
    if (slot.ended) return;
    slot.ended = true;
    if (slot.recheck) clearInterval(slot.recheck);
    slot.recheck = null;
    if (viewers.get(slot.accountId) === slot) viewers.delete(slot.accountId);
    if (opts.closeCode !== undefined && slot.socket.readyState === slot.socket.OPEN) {
      slot.socket.close(opts.closeCode, opts.reason);
    }
    await slot.viewer?.stop().catch(() => {});
    if (opts.save) {
      await services.browser
        .save(slot.accountId)
        .catch((err: unknown) => log.warn({ accountId: slot.accountId, err: safeErrorMessage(err) }, 'could not save browser session'));
    }
  }

  app.addHook('onClose', async () => {
    await Promise.all([...viewers.values()].map((slot) => endViewer(slot, { save: false, closeCode: 1001, reason: 'Server shutting down' })));
  });

  app.post('/api/browser/:accountId/open', { preHandler: requireAdmin }, async (req, reply) => {
    const params = ParamsSchema.safeParse(req.params);
    const account = params.success ? services.repos.accounts.get(params.data.accountId) : null;
    if (!account) return sendError(reply, 404, 'Account not found', 'not_found');

    const body = OpenSchema.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'Invalid request body', 'invalid');
    let url: string | undefined;
    if (body.data.url !== undefined && body.data.url.trim() !== '') {
      const parsed = parseHttpUrl(body.data.url);
      if (!parsed) return sendError(reply, 400, 'url must be an http:// or https:// address', 'invalid');
      // Navigating would take over the page a running live is using.
      if (accountInUse(services, account.id)) return sendError(reply, 409, ACCOUNT_LIVE_MESSAGE, 'account_live');
      const refused = await services.browser.checkViewerUrl?.(parsed);
      if (refused) return sendError(reply, 400, refused, 'blocked_host');
      url = parsed.href;
    }

    try {
      await services.browser.viewerPage(account.id, url);
    } catch (err) {
      log.warn({ accountId: account.id, err: safeErrorMessage(err) }, 'browser open failed');
      return sendError(reply, 502, navErrorMessage(err), 'browser_error');
    }
    audit(services, req, 'browser.open', `${account.platform}:${account.id} ${url ? redactUrl(url) : '(current page)'}`);
    return {};
  });

  app.post('/api/browser/:accountId/close', { preHandler: requireAdmin }, async (req, reply) => {
    const params = ParamsSchema.safeParse(req.params);
    const account = params.success ? services.repos.accounts.get(params.data.accountId) : null;
    if (!account) return sendError(reply, 404, 'Account not found', 'not_found');

    const body = CloseSchema.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'Body must be { save: boolean }', 'invalid');

    const slot = viewers.get(account.id);
    // Don't let the viewer's own on-close save overrule { save: false }.
    if (slot) await endViewer(slot, { save: false, closeCode: 1000, reason: 'Browser closed' });
    if (accountInUse(services, account.id)) {
      // A live is using this context: only detach the viewer (and save if asked), never close it.
      if (body.data.save) {
        await services.browser
          .save(account.id)
          .catch((err: unknown) => log.warn({ accountId: account.id, err: safeErrorMessage(err) }, 'could not save browser session'));
      }
      audit(services, req, 'browser.close', `${account.platform}:${account.id} save=${body.data.save} kept-open=live`);
      return {};
    }
    await services.browser.close(account.id, { save: body.data.save });
    audit(services, req, 'browser.close', `${account.platform}:${account.id} save=${body.data.save}`);
    return {};
  });

  app.get('/api/browser/:accountId/ws', { websocket: true, preHandler: requireAdmin }, async (socket, req) => {
    const send = (msg: BrowserServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    const params = ParamsSchema.safeParse(req.params);
    const account = params.success ? services.repos.accounts.get(params.data.accountId) : null;
    if (!account) {
      send({ type: 'error', message: 'Account not found' });
      socket.close(4404, 'Account not found');
      return;
    }

    const previous = viewers.get(account.id);
    if (previous) await endViewer(previous, { save: false, closeCode: 4000, reason: 'Opened in another window' });

    const slot: ViewerSlot = { accountId: account.id, socket, viewer: null, ended: false, recheck: null };
    viewers.set(account.id, slot);
    // The upgrade was authorized once; keep checking so logout, password change, user deletion
    // or demotion ends the viewer (also covers CLI resets and expiry, which fire no event).
    const sessionValid = sessionRevalidator(services, req, { admin: true });
    slot.recheck = setInterval(() => {
      let valid = true;
      try {
        valid = sessionValid();
      } catch (err) {
        log.debug({ err: safeErrorMessage(err) }, 'viewer session re-check failed');
      }
      if (!valid) void endViewer(slot, { save: true, closeCode: WS_SESSION_ENDED, reason: 'Session ended' });
    }, viewerTimings.sessionRecheckMs);
    slot.recheck.unref();
    socket.on('close', () => void endViewer(slot, { save: true }));
    socket.on('message', (data, isBinary) => {
      if (isBinary || !slot.viewer) return;
      const msg = decodeBrowserClientMessage(data);
      if (msg) void slot.viewer.handle(msg);
    });

    try {
      const page = await services.browser.viewerPage(account.id);
      if (slot.ended) return;
      const viewer = new BrowserViewer(page, {
        send,
        canSendFrame: () => socket.bufferedAmount <= MAX_BUFFERED_BYTES,
        onClosed: () => void endViewer(slot, { save: true, closeCode: 1000, reason: 'Browser closed' }),
        log,
        ...(services.browser.checkViewerUrl ? { checkUrl: (url: URL) => services.browser.checkViewerUrl!(url) } : {}),
        macOptionText: isMacUserAgent(req.headers['user-agent']),
      });
      slot.viewer = viewer;
      await viewer.start();
      log.info({ accountId: account.id }, 'browser viewer attached');
    } catch (err) {
      log.error({ accountId: account.id, err: safeErrorMessage(err) }, 'browser viewer failed to start');
      send({ type: 'error', message: 'Could not start the browser' });
      await endViewer(slot, { save: false, closeCode: 1011, reason: 'Browser error' });
    }
  });
};

export default browserRoutes;
