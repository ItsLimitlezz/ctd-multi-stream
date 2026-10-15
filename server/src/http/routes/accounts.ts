// Platform accounts: CRUD, connect flows (device code, OAuth paste-back, token paste, browser)
// and the OAuth redirect landing page. Each account belongs to one profile (lists take
// `?profile=`, creates take `profileId`); developer apps (/api/platform-apps) are shared, so every
// profile logs its accounts in with the same app credentials.

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ConnectPoll } from '../../../../shared/api.js';
import type { Account, AccountStatus } from '../../../../shared/types.js';
import { accountInUse, ACCOUNT_LIVE_MESSAGE } from '../../browser/account-in-use.js';
import { DriverError, type DriverContext, type PlatformDriver } from '../../platforms/types.js';
import { audit, requireAdmin, type RouteOptions } from '../guards.js';
import { accountIdFromState, sameSiteBouncePage } from '../oauth-state.js';
import {
  badRequest,
  HttpError,
  idParams,
  installErrorHandler,
  MAX_NAME,
  normalizeFields,
  notFound,
  optionsSchema,
  platformIdSchema,
  profileFromQuery,
  profileIdField,
  profileOf,
  requireDriver,
  resolveProfileId,
  findDriver,
  truncate,
} from '../validation.js';

/** Upper bound for one connect/check call (token exchange, browser session check...). */
const CONNECT_TIMEOUT_MS = 90_000;

const labelSchema = z.string().trim().max(MAX_NAME);

const createBody = z.object({
  profileId: profileIdField,
  platform: platformIdSchema,
  label: labelSchema.optional(),
  options: optionsSchema.nullish(),
});

const updateBody = z.object({
  label: labelSchema.optional(),
  options: optionsSchema.nullish(),
});

const completeBody = z.object({
  pastedUrl: z.string().max(8192).optional(),
  fields: z.record(z.string().max(100), z.string().max(8192)).optional(),
});

type AccountPatch = Partial<{ label: string; status: AccountStatus; statusMessage: string | null; options: Record<string, unknown> }>;

const accountRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  const { repos, bus } = services;
  installErrorHandler(app);

  function getAccount(id: string): Account {
    const account = repos.accounts.get(id);
    if (!account) throw notFound('Account');
    return account;
  }

  /** Persist an account change and notify connected UIs. */
  function saveAccount(id: string, patch: AccountPatch): Account {
    getAccount(id);
    const updated = repos.accounts.update(id, patch);
    bus.emit('account', updated);
    return updated;
  }

  function connectContext(account: Account): Promise<DriverContext> {
    return services.driverContext({
      platform: account.platform,
      accountId: account.id,
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
  }

  /** Common handling of a driver's ConnectPoll (poll, complete, OAuth landing). */
  function finishConnect(req: FastifyRequest, account: Account, result: ConnectPoll): ConnectPoll {
    if (result.status === 'connected') {
      // Drivers update the account through ctx.updateAccount; reload to return the stored state.
      let current = getAccount(account.id);
      if (current.status !== 'connected') current = saveAccount(account.id, { status: 'connected', statusMessage: null });
      audit(services, req, 'account.connect', `${current.platform} id=${current.id}`);
      return { status: 'connected', account: current };
    }
    if (result.status === 'error') {
      const message = truncate(result.message || 'Connection failed', 500);
      saveAccount(account.id, { status: 'error', statusMessage: message });
      audit(services, req, 'account.connect-failed', `${account.platform} id=${account.id}`);
      return { status: 'error', message };
    }
    return result;
  }

  function unsupported(driver: PlatformDriver, what: string): HttpError {
    return badRequest(`${driver.info.name} does not support ${what}`, 'unsupported');
  }

  /** 409 for a browser-login account that a running live is using. */
  function refuseIfBrowserLive(driver: PlatformDriver, account: Account): void {
    if (driver.info.connectMethod === 'browser' && accountInUse(services, account.id)) {
      throw new HttpError(409, ACCOUNT_LIVE_MESSAGE, 'account_live');
    }
  }

  // ---- CRUD ----

  app.get('/api/accounts', { preHandler: requireAdmin }, async (req) => repos.accounts.list(profileFromQuery(services, req.query)));

  app.post('/api/accounts', { preHandler: requireAdmin }, async (req, reply) => {
    const body = createBody.parse(req.body);
    const profileId = resolveProfileId(services, body.profileId);
    const driver = requireDriver(services, body.platform);
    if (driver.info.connectMethod === 'none') throw badRequest(`${driver.info.name} does not use accounts`);
    const options = normalizeFields(driver.info.accountFields, body.options);
    let account = repos.accounts.create({ profileId, platform: body.platform, label: body.label || driver.info.name, options });
    if (account.status !== 'pending') account = repos.accounts.update(account.id, { status: 'pending', statusMessage: null });
    bus.emit('account', account);
    audit(services, req, 'account.create', `${account.platform} id=${account.id} profile=${profileOf(account)}`);
    return reply.code(201).send(account);
  });

  app.patch('/api/accounts/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParams.parse(req.params);
    const body = updateBody.parse(req.body);
    const account = getAccount(id);
    const patch: AccountPatch = {};
    if (body.label !== undefined) patch.label = body.label || (findDriver(services, account.platform)?.info.name ?? account.label);
    if (body.options != null) {
      const fields = findDriver(services, account.platform)?.info.accountFields ?? [];
      // Keep driver-owned metadata (e.g. channel ids) that isn't a user-editable field.
      const declared = new Set(fields.map((f) => f.key));
      const driverOwned = Object.fromEntries(Object.entries(account.options).filter(([k]) => !declared.has(k)));
      patch.options = { ...driverOwned, ...normalizeFields(fields, body.options, account.options) };
    }
    if (Object.keys(patch).length === 0) return account;
    const updated = saveAccount(id, patch);
    audit(services, req, 'account.update', `${account.platform} id=${id} fields=${Object.keys(patch).join(',')}`);
    return updated;
  });

  app.delete('/api/accounts/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = idParams.parse(req.params);
    const account = getAccount(id);

    // 1. Detach, then let each destination's profile orchestrator retire the affected runners.
    //    Their end() still has the browser session and account tokens (it captured this account);
    //    replacements fail fast with no account. destinationChanged resolves once the old
    //    runner's teardown is done. (Every profile is searched: ids are global.)
    const affected = repos.destinations.list().filter((d) => d.accountId === id);
    repos.destinations.detachAccount(id);
    await Promise.all(
      affected.map(async (dest) => {
        try {
          await services.orchestrators.get(profileOf(dest)).destinationChanged(dest.id);
        } catch (err) {
          req.log.warn({ err, destinationId: dest.id }, 'orchestrator.destinationChanged failed');
        }
      }),
    );

    // 2. Only then drop the browser session (clear() last: an end() may just have saved it) and
    //    the secrets. Best effort: a browser that fails to close must not keep the tokens around.
    try {
      await services.browser.close(id, { save: false });
    } catch (err) {
      req.log.warn({ err, accountId: id }, 'closing browser context failed');
    }
    try {
      await services.browser.clear(id);
    } catch (err) {
      req.log.warn({ err, accountId: id }, 'clearing browser session failed');
    }
    repos.secrets.deleteScope(`account:${id}`);
    repos.secrets.deleteScope(`browser:${id}`);
    repos.accounts.delete(id);
    for (const profileId of new Set([profileOf(account), ...affected.map(profileOf)])) {
      bus.emit('destinations-changed', { profileId });
    }
    audit(services, req, 'account.delete', `${account.platform} id=${id} profile=${profileOf(account)}`);
    return {};
  });

  // ---- connect flows ----

  app.post('/api/accounts/:id/connect', { preHandler: requireAdmin }, async (req) => {
    const account = getAccount(idParams.parse(req.params).id);
    const driver = requireDriver(services, account.platform);
    if (!driver.startConnect) throw unsupported(driver, 'connecting accounts');
    // A browser login takes over (and the dialog later closes) the context a running live uses.
    // Checked before anything marks the account pending.
    refuseIfBrowserLive(driver, account);
    const start = await driver.startConnect(account, await connectContext(account));
    saveAccount(account.id, { status: 'pending', statusMessage: null });
    return start;
  });

  app.post('/api/accounts/:id/connect/poll', { preHandler: requireAdmin }, async (req) => {
    const account = getAccount(idParams.parse(req.params).id);
    const driver = requireDriver(services, account.platform);
    if (!driver.pollConnect) throw unsupported(driver, 'polling a connection');
    const result = await driver.pollConnect(account, await connectContext(account));
    return finishConnect(req, account, result);
  });

  app.post('/api/accounts/:id/connect/complete', { preHandler: requireAdmin }, async (req) => {
    const account = getAccount(idParams.parse(req.params).id);
    const body = completeBody.parse(req.body ?? {});
    const driver = requireDriver(services, account.platform);
    if (!driver.completeConnect) throw unsupported(driver, 'completing a connection');
    // A live may have started while the login dialog was open: completing would hand the UI a
    // 'connected' that makes it close (and save) the live's browser context.
    refuseIfBrowserLive(driver, account);
    const input: { pastedUrl?: string; fields?: Record<string, string> } = {};
    if (body.pastedUrl !== undefined) input.pastedUrl = body.pastedUrl.trim();
    if (body.fields !== undefined) input.fields = body.fields;
    const result = await driver.completeConnect(account, input, await connectContext(account));
    return finishConnect(req, account, result);
  });

  app.post('/api/accounts/:id/check', { preHandler: requireAdmin }, async (req) => {
    const account = getAccount(idParams.parse(req.params).id);
    const driver = requireDriver(services, account.platform);
    if (!driver.checkAccount) throw unsupported(driver, 'checking accounts');
    let result: Awaited<ReturnType<NonNullable<PlatformDriver['checkAccount']>>>;
    try {
      result = await driver.checkAccount(account, await connectContext(account));
    } catch (err) {
      // Record user-fixable failures on the account, then let the error reach the client.
      if (err instanceof DriverError) {
        saveAccount(account.id, {
          status: err.code === 'needs-login' ? 'needs-login' : 'error',
          statusMessage: truncate(err.message, 500),
        });
      }
      throw err;
    }
    const patch: AccountPatch = { status: result.status, statusMessage: result.message ? truncate(result.message, 500) : null };
    const label = result.label?.trim();
    if (label) patch.label = truncate(label, MAX_NAME);
    return saveAccount(account.id, patch);
  });

  // ---- OAuth redirect landing (outside /api) ----

  /** Complete an oauth-paste connection from the platform's redirect. Returns the redirect target. */
  async function landOAuthCallback(req: FastifyRequest, platformParam: string): Promise<string> {
    const fail = (message: string) => `/accounts?error=${encodeURIComponent(message)}`;
    if (req.user?.role !== 'admin') return fail('Only admins can connect accounts');

    const platform = platformIdSchema.safeParse(platformParam);
    const query = new URL(req.url, 'http://localhost').searchParams;
    const accountId = accountIdFromState(query.get('state'));
    const account = accountId ? repos.accounts.get(accountId) : null;
    if (!platform.success || !account || account.platform !== platform.data) {
      return fail('This sign-in link is invalid or expired. Start the connection again.');
    }

    // From here on the account is known: land on its profile's accounts page.
    const profile = `&profile=${encodeURIComponent(profileOf(account))}`;
    const failFor = (message: string) => `${fail(message)}${profile}`;

    const oauthError = query.get('error');
    if (oauthError) {
      return failFor(`Authorization failed: ${truncate(query.get('error_description') || oauthError, 200)}`);
    }

    const driver = findDriver(services, platform.data);
    if (driver?.info.connectMethod !== 'oauth-paste' || !driver.completeConnect) {
      return failFor('This platform cannot be connected this way');
    }

    // Rebuild the exact URL the platform redirected to (the driver checks code + state).
    const pastedUrl = `${services.publicBaseUrl()}${req.url}`;
    try {
      const result = finishConnect(req, account, await driver.completeConnect(account, { pastedUrl }, await connectContext(account)));
      switch (result.status) {
        case 'connected':
          return `/accounts?connected=${encodeURIComponent(account.id)}${profile}`;
        case 'error':
          return failFor(result.message);
        case 'expired':
          return failFor('The authorization expired. Start the connection again.');
        default:
          return failFor('The connection did not complete. Try again.');
      }
    } catch (err) {
      if (err instanceof DriverError || err instanceof HttpError) return failFor(err.message);
      req.log.error({ err, platform: platform.data, accountId: account.id }, 'OAuth callback failed');
      return failFor('Connecting the account failed. Check the server logs.');
    }
  }

  app.get('/oauth/callback/:platform', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const platformParam = (req.params as { platform?: string }).platform ?? '';
    if (!req.user) {
      // The SameSite=Strict session cookie is not sent on the cross-site redirect from the
      // platform; bounce once through our own origin so it is. Otherwise: log in first.
      const platform = platformIdSchema.safeParse(platformParam);
      if (platform.success && req.headers['sec-fetch-site'] === 'cross-site') {
        const query = new URL(req.url, 'http://localhost').searchParams;
        const target = `/oauth/callback/${platform.data}?${new URLSearchParams(query).toString()}`;
        return reply.type('text/html; charset=utf-8').send(sameSiteBouncePage(target));
      }
      return reply.redirect('/login');
    }
    return reply.redirect(await landOAuthCallback(req, platformParam));
  });
};

export default accountRoutes;
