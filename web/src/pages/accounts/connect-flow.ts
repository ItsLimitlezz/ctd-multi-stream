// Pure helpers for the accounts page and its connect flows.

import type { ConnectStart, PlatformAppStatus } from '@shared/api';
import type { AccountStatus, ConnectMethod, Destination, PlatformId, PlatformInfo } from '@shared/types';
import { safeHttpUrl, type Tone } from '../../components/utils';
import { isApiError } from '../../state/errors';

export const ACCOUNT_STATUS_META: Record<AccountStatus, { label: string; tone: Tone }> = {
  connected: { label: 'Connected', tone: 'success' },
  pending: { label: 'Not connected', tone: 'neutral' },
  'needs-login': { label: 'Needs login', tone: 'warn' },
  error: { label: 'Error', tone: 'danger' },
};

export type DeviceCodeStart = Extract<ConnectStart, { method: 'device-code' }>;

/** Link to open for a device code (prefilled code when the platform offers it). Null if unsafe. */
export function verificationLink(start: Pick<DeviceCodeStart, 'verificationUri' | 'verificationUriComplete'>): string | null {
  return safeHttpUrl(start.verificationUriComplete) ?? safeHttpUrl(start.verificationUri);
}

/** "twitch.tv/activate" style label for a URL (host + path, no scheme/query). */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
    return `${u.host.replace(/^www\./, '')}${path}`;
  } catch {
    return url;
  }
}

const MIN_POLL_MS = 1000;
const MAX_POLL_MS = 60_000;
const DEFAULT_POLL_MS = 5000;

/** Device-code poll interval in ms from the server's `interval` seconds (clamped 1–60 s, default 5 s). */
export function pollIntervalMs(intervalSec: number): number {
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) return DEFAULT_POLL_MS;
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.round(intervalSec * 1000)));
}

/** Delay after a failed poll (network / server error): double the delay, at most 30 s. */
export function pollBackoffMs(currentMs: number): number {
  return Math.min(30_000, Math.max(MIN_POLL_MS, currentMs * 2));
}

/** Whole seconds left until `expiresAt` (ms epoch), never negative. */
export function remainingSeconds(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/** 245 -> "4:05". */
export function formatCountdown(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Poll errors that won't fix themselves (stop polling). Network/timeouts/5xx/429 keep polling. */
export function isFatalPollError(err: unknown): boolean {
  if (!isApiError(err)) return false;
  return err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
}

/** The developer app for this platform is missing (server DriverError code 'misconfigured'). */
export function isMisconfigured(err: unknown): boolean {
  return isApiError(err) && err.code === 'misconfigured';
}

/** Validate the address the user pasted after approving an OAuth login. */
export function checkPastedUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const s = raw.trim();
  if (!s) return { ok: false, error: 'Paste the full address from the browser tab you were sent to.' };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: 'That is not a full address. Copy everything in the address bar, starting with http.' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'The address must start with http:// or https://.' };
  }
  const params = new URLSearchParams(`${u.search.replace(/^\?/, '')}&${u.hash.replace(/^#/, '')}`);
  if (!['code', 'error', 'state', 'access_token', 'oauth_token'].some((k) => params.has(k))) {
    return { ok: false, error: "That address has no authorization code in it. Make sure you approved access and copied the address you landed on." };
  }
  return { ok: true, url: s };
}

/** Query parameters the accounts page reacts to (OAuth landing redirects + deep links). */
export function readAccountsQuery(params: URLSearchParams): { connected: string | null; error: string | null; add: string | null } {
  const pick = (k: string) => {
    const v = params.get(k);
    return v && v.trim() ? v.trim().slice(0, 500) : null;
  };
  return { connected: pick('connected'), error: pick('error'), add: pick('add') };
}

/** Platforms that use accounts. */
export function connectablePlatforms(platforms: readonly PlatformInfo[]): PlatformInfo[] {
  return platforms.filter((p) => p.connectMethod !== 'none');
}

/**
 * Account types that connect without the platform's developer app, and how they connect instead.
 * PlatformInfo can't describe this yet (Facebook's profile mode logs in through the built-in browser
 * and never reads the Meta app), so it lives here until the contract grows a field for it.
 */
const APP_FREE_ACCOUNTS: Partial<Record<PlatformId, { field: string; value: string; connectMethod: ConnectMethod }>> = {
  facebook: { field: 'mode', value: 'profile', connectMethod: 'browser' },
};

function appFreeAccount(info: PlatformInfo, options: Readonly<Record<string, unknown>> | undefined) {
  const v = APP_FREE_ACCOUNTS[info.id];
  return v && options?.[v.field] === v.value ? v : null;
}

/** The platform's developer app is required but isn't configured yet (whatever the account type). */
export function developerAppMissing(info: PlatformInfo | undefined, apps: readonly PlatformAppStatus[] | undefined): boolean {
  if (!info?.developerApp || !apps) return false;
  const status = apps.find((a) => a.platform === info.id);
  return status ? !status.configured : false;
}

/** Some account types of this platform work without its developer app. */
export function developerAppOptional(info: PlatformInfo): boolean {
  return APP_FREE_ACCOUNTS[info.id] !== undefined;
}

/**
 * True when connecting needs a developer app that isn't configured yet.
 * Unknown (apps not loaded) counts as configured so nothing is blocked by a slow request.
 * Without `options` (no account type chosen yet) it is only true when every account type needs the app.
 */
export function needsDeveloperApp(
  info: PlatformInfo | undefined,
  apps: readonly PlatformAppStatus[] | undefined,
  options?: Readonly<Record<string, unknown>>,
): boolean {
  if (!info || !developerAppMissing(info, apps)) return false;
  if (!developerAppOptional(info)) return true;
  return options !== undefined && !appFreeAccount(info, options);
}

/** Picker badge for a platform whose developer app isn't set up. */
export function developerAppBadge(info: PlatformInfo, apps: readonly PlatformAppStatus[] | undefined): string | null {
  if (!developerAppMissing(info, apps)) return null;
  return developerAppOptional(info) ? 'Some account types need a developer app' : 'Needs developer app';
}

/** How an account with these options connects (an app-free account type may connect differently). */
export function connectMethodFor(info: PlatformInfo, options: Readonly<Record<string, unknown>> | undefined): ConnectMethod {
  return appFreeAccount(info, options)?.connectMethod ?? info.connectMethod;
}

export function destinationsUsing(destinations: readonly Destination[] | undefined, accountId: string): number {
  return destinations?.filter((d) => d.accountId === accountId).length ?? 0;
}

export function deleteConfirmLabel(linked: number): string {
  return linked > 0 ? `Delete and unlink ${linked}?` : 'Delete?';
}

/** "Connect" for accounts that never connected, "Reconnect" otherwise. */
export function connectLabel(status: AccountStatus): string {
  return status === 'pending' ? 'Connect' : 'Reconnect';
}
