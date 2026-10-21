// "Connect a phone" (docs/API.md §11): an admin shows a QR code in Settings → API; CTD Live mobile
// scans it — over the LAN or mobile data — and claims a read-only token with the one-time code in
// it. Offers live in memory only, expire after CONNECT_OFFER_TTL_MS and work once.

import crypto from 'node:crypto';
import QRCode from 'qrcode';
import type { ApiScope, ApiTokenInfo } from '../../../shared/types.js';
import type { Repos } from '../services.js';

export const CONNECT_OFFER_TTL_MS = 5 * 60_000;
/** Offers open at once (several phones, or a code shown twice). */
export const MAX_CONNECT_OFFERS = 5;
/** What a phone may do: read status (incl. OBS state, previews) and chat. Never stream keys or the hub. */
export const MOBILE_SCOPES: readonly ApiScope[] = ['status:read', 'chat:read'];
export const DEVICE_NAME_MAX = 60;
/** URI scheme in the QR code (CTD Live mobile registers it, so a camera app can open it too). */
export const CONNECT_URI_SCHEME = 'ctdrelay';
const RETAIN_MS = 10 * 60_000;

export type ConnectOfferState = 'waiting' | 'connected' | 'expired';

interface Offer {
  id: string;
  codeHash: Buffer;
  profileId: string | null;
  createdBy: string | null;
  expiresAtMs: number;
  state: ConnectOfferState;
  deviceName: string | null;
  tokenId: string | null;
  finalAtMs: number | null;
}

export interface ConnectTarget {
  /** Public HTTPS address of the API (what phones on mobile data use). */
  apiUrl: string;
  /** LAN address of the API, tried first on the same network (null when unknown). */
  lanApiUrl: string | null;
  /** SHA-256 fingerprint of the served certificate (pin it when it's self-signed). */
  fingerprint256: string | null;
}

/** The text in the QR code: ctdrelay://connect?v=1&api=…&lan=…&fp=…&code=… */
export function connectUri(target: ConnectTarget, code: string): string {
  const q = new URLSearchParams({ v: '1', api: target.apiUrl });
  if (target.lanApiUrl) q.set('lan', target.lanApiUrl);
  if (target.fingerprint256) q.set('fp', target.fingerprint256);
  q.set('code', code);
  return `${CONNECT_URI_SCHEME}://connect?${q.toString()}`;
}

/** The QR code as an SVG document (dark modules on white, quiet zone included). */
export function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#000000', light: '#ffffff' } });
}

function hash(code: string): Buffer {
  return crypto.createHash('sha256').update(code, 'utf8').digest();
}

export class ConnectOffers {
  private readonly offers = new Map<string, Offer>();

  constructor(
    private readonly repos: Pick<Repos, 'apiTokens' | 'profiles' | 'audit'>,
    private readonly now: () => number = Date.now,
  ) {}

  /** A new offer: its id (for status polling) and the one-time code that goes in the QR code. */
  create(opts: { profileId: string | null; createdBy: string | null }): { id: string; code: string; expiresAt: string } {
    this.sweep();
    const open = [...this.offers.values()].filter((o) => o.state === 'waiting');
    if (open.length >= MAX_CONNECT_OFFERS) {
      // Showing the code again replaces the oldest unused one.
      const oldest = open.sort((a, b) => a.expiresAtMs - b.expiresAtMs)[0]!;
      this.finish(oldest, 'expired');
    }
    const id = crypto.randomUUID();
    const code = crypto.randomBytes(32).toString('base64url');
    const expiresAtMs = this.now() + CONNECT_OFFER_TTL_MS;
    this.offers.set(id, {
      id,
      codeHash: hash(code),
      profileId: opts.profileId,
      createdBy: opts.createdBy,
      expiresAtMs,
      state: 'waiting',
      deviceName: null,
      tokenId: null,
      finalAtMs: null,
    });
    return { id, code, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  status(id: string): { state: ConnectOfferState; deviceName: string | null; expiresAt: string } | null {
    this.sweep();
    const o = this.offers.get(id);
    return o ? { state: o.state, deviceName: o.deviceName, expiresAt: new Date(o.expiresAtMs).toISOString() } : null;
  }

  cancel(id: string): void {
    const o = this.offers.get(id);
    if (o && o.state === 'waiting') this.finish(o, 'expired');
  }

  /**
   * Exchange a code for a token (once). Null for an unknown, used or expired code — the same
   * answer for all three, so the endpoint is no oracle.
   */
  claim(code: string, deviceName: string): { token: ApiTokenInfo; secret: string } | null {
    this.sweep();
    if (typeof code !== 'string' || code.length < 20 || code.length > 100) return null;
    const h = hash(code);
    const offer = [...this.offers.values()].find((o) => o.state === 'waiting' && crypto.timingSafeEqual(o.codeHash, h));
    if (!offer) return null;
    // Its profile may have been deleted since the code was shown.
    if (offer.profileId !== null && !this.repos.profiles.get(offer.profileId)) {
      this.finish(offer, 'expired');
      return null;
    }
    const name = deviceName.slice(0, DEVICE_NAME_MAX);
    const created = this.repos.apiTokens.create({ name, scopes: [...MOBILE_SCOPES], createdBy: offer.createdBy, profileId: offer.profileId });
    offer.deviceName = name;
    offer.tokenId = created.token.id;
    this.finish(offer, 'connected');
    this.repos.audit.log({
      userId: null,
      username: offer.createdBy,
      action: 'api_token.create',
      detail: `${name} (${MOBILE_SCOPES.join(', ')}) connected by QR code ${created.token.prefix}…`,
    });
    return { token: { ...created.token, profileId: created.token.profileId ?? offer.profileId }, secret: created.secret };
  }

  private finish(o: Offer, state: 'connected' | 'expired'): void {
    o.state = state;
    o.finalAtMs = this.now();
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, o] of this.offers) {
      if (o.state === 'waiting' && t >= o.expiresAtMs) this.finish(o, 'expired');
      if (o.finalAtMs !== null && t >= o.finalAtMs + RETAIN_MS) this.offers.delete(id);
    }
  }
}

const registry = new WeakMap<object, ConnectOffers>();

/** The connect offers of these services (one per process, shared by the web UI and /api/v1 routes). */
export function connectOffersFor(services: { repos: Pick<Repos, 'apiTokens' | 'profiles' | 'audit'> }): ConnectOffers {
  let offers = registry.get(services);
  if (!offers) {
    offers = new ConnectOffers(services.repos);
    registry.set(services, offers);
  }
  return offers;
}
