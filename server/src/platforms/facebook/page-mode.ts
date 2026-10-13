// Facebook Page mode: Graph API with the user's own Meta app (Development mode, they are its admin).
//
// Login (manual flow):  https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow
// Long-lived tokens:    https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
//   (Page tokens obtained with a long-lived user token "do not have an expiration date".)
// Facebook Login for Business (optional config_id): https://developers.facebook.com/docs/facebook-login/facebook-login-for-business/
// Live videos:          https://developers.facebook.com/docs/live-video-api/guides/streaming
//   POST /{page-id}/live_videos?status=LIVE_NOW&title=... → { id, stream_url, secure_stream_url }
//   (Page token with pages_read_engagement + pages_manage_posts; title max 254 characters per
//   https://developers.facebook.com/docs/graph-api/reference/page/live_videos/)
//   POST /{live-video-id}?end_live_video=true ends it (status → VOD).
// Dev mode: "Apps in Development Mode can request any Permission from any app User who has a Role
// on the app" (https://developers.facebook.com/docs/pages-api/overview) — no App Review needed.

import { timingSafeEqual } from 'node:crypto';
import type { ConnectPoll, ConnectStart } from '../../../../shared/api.js';
import type { Account, AccountStatus, Destination } from '../../../../shared/types.js';
import type { ScopedSecrets } from '../../services.js';
import { truncateTitle } from '../common/http.js';
import { loadTokens, makeState, parseCallbackUrl, saveTokens } from '../common/oauth.js';
import { DriverError, type DriverContext, type PreparedLive } from '../types.js';
import { liveComments } from './comments.js';
import { GraphClient, OAUTH_DIALOG_URL } from './graph.js';

export const TITLE_MAX = 254;
/** Permissions requested in the login dialog (classic Facebook Login or Login for Business with scope). */
export const PAGE_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_read_user_content'];
/** Without these a Page live cannot be created. pages_read_user_content only affects chat names. */
const REQUIRED_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'];

const PENDING_KEY = 'pkce'; // pending OAuth state (docs/CONTRACTS.md storage conventions)
const PAGE_KEY = 'page';
const PENDING_TTL_MS = 30 * 60_000;
const MAX_PAGE_LISTS = 5;
const ENDED_STATUSES = new Set(['LIVE_STOPPED', 'VOD', 'PROCESSING', 'SCHEDULED_CANCELED', 'SCHEDULED_EXPIRED']);
const NOT_STARTED_STATUSES = new Set(['UNPUBLISHED', 'SCHEDULED_UNPUBLISHED', 'SCHEDULED_LIVE']);

export interface PageModeEnv {
  graphHost?: string;
  streamingHost?: string;
  commentPollMs?: number;
}

interface PendingAuth {
  state: string;
  redirectUri: string;
  createdAt: number;
}

export interface StoredPage {
  id: string;
  name: string;
  accessToken: string;
}

interface AppCredentials {
  clientId: string;
  clientSecret: string;
  configId: string | null;
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number | string;
}

interface PageListResponse {
  data?: { id?: string; name?: string; access_token?: string; tasks?: string[] }[];
  paging?: { cursors?: { after?: string }; next?: string };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireApp(ctx: DriverContext): AppCredentials {
  const clientId = ctx.app?.clientId?.trim();
  const clientSecret = ctx.app?.clientSecret?.trim();
  if (!clientId || !clientSecret) {
    throw new DriverError('Set up the Facebook developer app in Settings → Developer apps', 'misconfigured');
  }
  return { clientId, clientSecret, configId: ctx.app?.configId?.trim() || null };
}

function requireSecrets(ctx: DriverContext): ScopedSecrets {
  if (!ctx.accountSecrets) throw new DriverError('No Facebook account linked to this destination', 'not-connected');
  return ctx.accountSecrets;
}

function graphFor(ctx: DriverContext, env: PageModeEnv): GraphClient {
  return new GraphClient({ host: env.graphHost, appSecret: ctx.app?.clientSecret?.trim() || null });
}

export function redirectUriFor(ctx: DriverContext): string {
  return `${ctx.publicBaseUrl.replace(/\/+$/, '')}/oauth/callback/facebook`;
}

function pageIdOption(account: Account): string {
  const v = account.options.pageId;
  return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
}

function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** All Pages the user token can manage (follows cursors, bounded). */
async function listPages(graph: GraphClient, userToken: string, signal?: AbortSignal): Promise<StoredPage[]> {
  const pages: StoredPage[] = [];
  let after: string | undefined;
  for (let i = 0; i < MAX_PAGE_LISTS; i++) {
    const params: Record<string, string> = { fields: 'id,name,access_token,tasks', limit: '100' };
    if (after) params.after = after;
    const res = await graph.get<PageListResponse>('me/accounts', userToken, params, signal);
    for (const p of res?.data ?? []) {
      if (!p.id || !p.access_token) continue;
      // Pages where the user can't create content can't host a live; skip them when tasks are reported.
      if (Array.isArray(p.tasks) && p.tasks.length > 0 && !p.tasks.includes('CREATE_CONTENT')) continue;
      pages.push({ id: p.id, name: p.name?.trim() || `Page ${p.id}`, accessToken: p.access_token });
    }
    after = res?.paging?.next ? res.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return pages;
}

function pickPage(pages: StoredPage[], wanted: string): StoredPage | null {
  if (!wanted) return pages[0] ?? null;
  const lower = wanted.toLowerCase();
  return pages.find((p) => p.id === wanted) ?? pages.find((p) => p.name.toLowerCase() === lower) ?? null;
}

function describePages(pages: StoredPage[]): string {
  return pages
    .slice(0, 10)
    .map((p) => `${p.name} (${p.id})`)
    .join(', ');
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

export async function startPageConnect(account: Account, ctx: DriverContext): Promise<ConnectStart> {
  const app = requireApp(ctx);
  const secrets = requireSecrets(ctx);
  const redirectUri = redirectUriFor(ctx);
  const state = makeState(account.id);
  await secrets.setJson(PENDING_KEY, { state, redirectUri, createdAt: Date.now() } satisfies PendingAuth);

  const params = new URLSearchParams({ client_id: app.clientId, redirect_uri: redirectUri, state, response_type: 'code' });
  if (app.configId) {
    // Facebook Login for Business: the configuration carries the permissions.
    params.set('config_id', app.configId);
  } else {
    params.set('scope', PAGE_SCOPES.join(','));
    params.set('auth_type', 'rerequest'); // ask again for permissions declined earlier
  }
  return {
    method: 'oauth-paste',
    authorizeUrl: `${OAUTH_DIALOG_URL}?${params.toString()}`,
    redirectUri,
    instructions: [
      'Sign in with the Facebook account that manages your Page, select the Page and allow every permission.',
      'Facebook then sends you back to this app. If that page does not load, copy its full address from the browser bar and paste it here.',
    ].join('\n'),
  };
}

export async function completePageConnect(
  account: Account,
  input: { pastedUrl?: string; fields?: Record<string, string> },
  ctx: DriverContext,
  env: PageModeEnv,
): Promise<ConnectPoll> {
  const app = requireApp(ctx);
  const secrets = requireSecrets(ctx);
  const pending = await secrets.getJson<PendingAuth>(PENDING_KEY);
  if (!pending?.state) {
    return { status: 'error', message: 'No Facebook sign-in is in progress — click Connect to start again.' };
  }
  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    await secrets.delete(PENDING_KEY);
    return { status: 'expired' };
  }

  const cb = parseCallbackUrl(input.pastedUrl ?? '');
  if (cb.error) {
    await secrets.delete(PENDING_KEY);
    const reason = cb.error === 'access_denied' ? 'you cancelled or declined the request' : (cb.errorDescription ?? cb.error);
    return { status: 'error', message: `Facebook sign-in failed: ${reason}` };
  }
  if (!cb.code || !cb.state) {
    return { status: 'error', message: 'Paste the full address of the page Facebook sent you to (it contains "code=" and "state=").' };
  }
  if (!sameState(cb.state, pending.state)) {
    return { status: 'error', message: 'This sign-in link belongs to an older connection attempt — click Connect and try again.' };
  }
  await secrets.delete(PENDING_KEY); // one-time use

  const graph = graphFor(ctx, env);
  try {
    const short = await graph.get<TokenResponse>(
      'oauth/access_token',
      null,
      { client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: pending.redirectUri, code: cb.code },
      ctx.signal,
    );
    if (!short?.access_token) return { status: 'error', message: 'Facebook did not return an access token' };
    // Exchange for a long-lived (~60 day) user token: Page tokens derived from it never expire.
    const long = await graph.get<TokenResponse>(
      'oauth/access_token',
      null,
      { grant_type: 'fb_exchange_token', client_id: app.clientId, client_secret: app.clientSecret, fb_exchange_token: short.access_token },
      ctx.signal,
    );
    if (!long?.access_token) return { status: 'error', message: 'Facebook did not return a long-lived access token' };
    const userToken = long.access_token;

    const perms = await graph.get<{ data?: { permission?: string; status?: string }[] }>('me/permissions', userToken, {}, ctx.signal);
    const granted = new Set((perms?.data ?? []).filter((p) => p.status === 'granted').map((p) => p.permission));
    const missing = REQUIRED_SCOPES.filter((s) => !granted.has(s));
    if (missing.length > 0) {
      return {
        status: 'error',
        message: `Facebook did not grant: ${missing.join(', ')}. Add them to your Meta app's use case if needed, click Connect again and allow every permission.`,
      };
    }
    if (!granted.has('pages_read_user_content')) {
      ctx.log.warn('pages_read_user_content not granted: chat will show commenters as "Facebook user"');
    }

    const pages = await listPages(graph, userToken, ctx.signal);
    if (pages.length === 0) {
      return {
        status: 'error',
        message:
          'No Facebook Page found that this account can post to. In the Facebook dialog, choose your Page (and give it "create content" access), then connect again.',
      };
    }
    const wanted = pageIdOption(account);
    const page = pickPage(pages, wanted);
    if (!page) {
      return { status: 'error', message: `Page "${wanted}" is not available to this Facebook account. Available: ${describePages(pages)}` };
    }

    const expiresIn = Number(long.expires_in);
    await saveTokens(secrets, {
      accessToken: userToken,
      refreshToken: null,
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
      scope: [...granted].filter(Boolean).join(' ') || null,
      tokenType: long.token_type ?? 'bearer',
    });
    await secrets.setJson(PAGE_KEY, page satisfies StoredPage);

    const options = { ...account.options, mode: 'page', pageId: page.id };
    await ctx.updateAccount({ label: page.name, status: 'connected', statusMessage: null, options });
    ctx.log.info({ pageId: page.id }, 'Facebook Page connected');
    return { status: 'connected', account: { ...account, label: page.name, status: 'connected', statusMessage: null, options } };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    if (err instanceof DriverError) return { status: 'error', message: err.message };
    throw err;
  }
}

/**
 * The Page to stream to. When the Page ID option was changed after connecting, the new Page is
 * looked up with the stored long-lived user token.
 */
async function resolvePage(account: Account, ctx: DriverContext, graph: GraphClient): Promise<StoredPage> {
  const secrets = requireSecrets(ctx);
  const stored = await secrets.getJson<StoredPage>(PAGE_KEY);
  if (!stored?.accessToken) {
    throw new DriverError('Facebook Page is not connected — connect the account in Accounts', 'not-connected');
  }
  const wanted = pageIdOption(account);
  if (!wanted || wanted === stored.id) return stored;

  const user = await loadTokens(secrets);
  if (!user?.accessToken || (user.expiresAt !== null && user.expiresAt <= Date.now())) {
    throw new DriverError('The Page ID was changed — reconnect the Facebook account in Accounts to use the new Page', 'needs-login');
  }
  const pages = await listPages(graph, user.accessToken, ctx.signal);
  const page = pickPage(pages, wanted);
  if (!page) {
    throw new DriverError(`Page "${wanted}" is not available to this Facebook account — check the Page ID or reconnect`, 'misconfigured');
  }
  await secrets.setJson(PAGE_KEY, page);
  await ctx.updateAccount({ label: page.name });
  return page;
}

export async function checkPageAccount(
  account: Account,
  ctx: DriverContext,
  env: PageModeEnv,
): Promise<{ status: AccountStatus; label?: string; message?: string }> {
  const secrets = requireSecrets(ctx);
  if (!(await secrets.getJson<StoredPage>(PAGE_KEY))) {
    return { status: 'pending', message: 'Not connected yet — click Connect' };
  }
  const graph = graphFor(ctx, env);
  const page = await resolvePage(account, ctx, graph);
  const info = await graph.get<{ id?: string; name?: string }>(page.id, page.accessToken, { fields: 'id,name' }, ctx.signal);
  const name = info?.name?.trim() || page.name;
  if (name !== page.name) await secrets.setJson(PAGE_KEY, { ...page, name });
  return { status: 'connected', label: name };
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

interface CreatedLive {
  id?: string;
  stream_url?: string;
  secure_stream_url?: string;
}

function absoluteFacebookUrl(permalink: string): string | null {
  try {
    return new URL(permalink, 'https://www.facebook.com').toString();
  } catch {
    return null;
  }
}

function privacyParam(dest: Destination): string | null {
  // Pages are public by default; only send privacy for "Only me" test lives.
  return dest.options.privacy === 'self' ? JSON.stringify({ value: 'SELF' }) : null;
}

export async function preparePageLive(
  dest: Destination,
  account: Account | null,
  title: string,
  ctx: DriverContext,
  env: PageModeEnv,
): Promise<PreparedLive> {
  if (!account) throw new DriverError('Choose a connected Facebook account for this destination', 'not-connected');
  const graph = graphFor(ctx, env);
  const page = await resolvePage(account, ctx, graph);

  // Only the title (never a category/topic/tags).
  const form: Record<string, string> = { status: 'LIVE_NOW' };
  const cleanTitle = truncateTitle(title, TITLE_MAX);
  if (cleanTitle) form.title = cleanTitle;
  const privacy = privacyParam(dest);
  if (privacy) form.privacy = privacy;

  const live = await graph.post<CreatedLive>(`${page.id}/live_videos`, page.accessToken, form, ctx.signal);
  const liveId = live?.id;
  if (!liveId) throw new DriverError('Facebook did not return a live video id', 'platform-error');
  const end = () => endLiveVideo(graph, liveId, page.accessToken, ctx);
  if (!live.secure_stream_url) {
    await end().catch(() => {});
    throw new DriverError('Facebook did not return an RTMPS stream URL for the live video', 'platform-error');
  }
  ctx.log.info({ pageId: page.id, liveVideoId: liveId }, 'Facebook live video created');

  // Best effort: a failure here must not lose the live that now exists (the caller ends it on abort).
  let watchUrl: string | null = null;
  try {
    const res = await graph.get<{ permalink_url?: string }>(liveId, page.accessToken, { fields: 'permalink_url' }, ctx.signal);
    if (res?.permalink_url) watchUrl = absoluteFacebookUrl(res.permalink_url);
  } catch (err) {
    ctx.log.debug({ error: errorText(err) }, 'reading the live video permalink failed');
  }

  return {
    push: { url: live.secure_stream_url, mode: 'copy', feeds: [dest.feed] },
    watchUrl: watchUrl ?? `https://www.facebook.com/${encodeURIComponent(page.id)}`,
    async setTitle(next: string) {
      const t = truncateTitle(next, TITLE_MAX);
      if (!t) return; // Facebook needs a non-empty title; keep the current one
      await graph.post(liveId, page.accessToken, { title: t });
    },
    end,
    chat: (signal) =>
      liveComments(
        { graph, liveVideoId: liveId, token: page.accessToken, log: ctx.log, streamingHost: env.streamingHost, pollMs: env.commentPollMs },
        signal,
      ),
  };
}

/** End the live; "already ended / never started" is not an error. */
async function endLiveVideo(graph: GraphClient, liveId: string, token: string, ctx: DriverContext): Promise<void> {
  try {
    await graph.post(liveId, token, { end_live_video: 'true' });
    ctx.log.info({ liveVideoId: liveId }, 'Facebook live video ended');
    return;
  } catch (err) {
    let status: string | null = null;
    try {
      status = (await graph.get<{ status?: string }>(liveId, token, { fields: 'status' }))?.status ?? null;
    } catch {
      // Gone (deleted) or unreachable: stopping the stream ends the broadcast anyway.
      ctx.log.warn({ liveVideoId: liveId, error: errorText(err) }, 'ending the Facebook live failed; it ends when the stream stops');
      return;
    }
    if (status && (ENDED_STATUSES.has(status) || NOT_STARTED_STATUSES.has(status))) {
      ctx.log.debug({ liveVideoId: liveId, status }, 'Facebook live already ended or never started');
      return;
    }
    throw err;
  }
}
