// Let's Encrypt issuance via acme-client, with HTTP-01 challenges served by the HTTP listener.
//
// IP certificates (RFC 8738 "ip" identifiers) are only issued with the `shortlived` profile
// (160 h validity): https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability
// Profiles are selected with a `profile` field in newOrder (draft-aaron-acme-profiles):
// https://letsencrypt.org/docs/profiles/
// acme-client 5.4's auto() hardcodes dns identifiers, so we drive the order flow ourselves;
// createOrder() forwards the payload as-is, and crypto.createCsr() encodes IPs as iPAddress SANs.

import * as acme from 'acme-client';
import type { Logger } from 'pino';
import type { TlsMaterial } from '../services.js';
import { coversNames, keyMatchesCert, readCertInfo } from './cert-info.js';
import type { ChallengeStore } from './http-listener.js';

export interface AcmeIdentifier {
  type: 'ip' | 'dns';
  value: string;
}

export interface AcmeChallenge {
  type: string;
  url: string;
  status: string;
  token?: string;
}

export interface AcmeAuthorization {
  url: string;
  status: string;
  identifier: { type: string; value: string };
  challenges: AcmeChallenge[];
}

export interface AcmeOrder {
  url: string;
  status: string;
  authorizations: string[];
  finalize: string;
  certificate?: string;
}

export interface NewOrderRequest {
  identifiers: AcmeIdentifier[];
  profile?: string;
}

/** The slice of acme-client's Client this module uses (faked in tests). */
export interface AcmeApi {
  createAccount(data: { termsOfServiceAgreed: boolean; contact?: string[] }): Promise<unknown>;
  createOrder(data: NewOrderRequest): Promise<AcmeOrder>;
  getAuthorizations(order: AcmeOrder): Promise<AcmeAuthorization[]>;
  getChallengeKeyAuthorization(challenge: AcmeChallenge): Promise<string>;
  completeChallenge(challenge: AcmeChallenge): Promise<unknown>;
  /** Polls until the challenge/order is valid (throws when it turns invalid). */
  waitForValidStatus<T extends { url: string }>(item: T): Promise<T>;
  finalizeOrder(order: AcmeOrder, csr: Buffer): Promise<AcmeOrder>;
  getCertificate(order: AcmeOrder): Promise<string>;
  deactivateAuthorization(authz: AcmeAuthorization): Promise<unknown>;
}

export const IP_CERT_PROFILE = 'shortlived';
export const LE_SUBSCRIBER_AGREEMENT = 'https://letsencrypt.org/repository/';

export type AcmeStage = 'account' | 'order' | 'challenge' | 'finalize';

/** Issuance failure with the step it happened in (the manager adds hints for 'challenge'). */
export class AcmeIssueError extends Error {
  constructor(
    message: string,
    readonly stage: AcmeStage,
  ) {
    super(message);
    this.name = 'AcmeIssueError';
  }
}

export function acmeDirectoryUrl(staging: boolean): string {
  return staging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production;
}

/** IP identifiers need the shortlived profile; domains use the CA's default profile. */
export function newOrderRequest(identifier: AcmeIdentifier): NewOrderRequest {
  return identifier.type === 'ip' ? { identifiers: [identifier], profile: IP_CERT_PROFILE } : { identifiers: [identifier] };
}

export async function createEcKey(): Promise<string> {
  return (await acme.crypto.createPrivateEcdsaKey('P-256')).toString();
}

/** CSR with the identifier as its only SAN. IPs get no CN (shortlived certs carry none). */
export async function buildCsr(identifier: AcmeIdentifier, keyPem: string): Promise<Buffer> {
  const data = identifier.type === 'ip' ? { altNames: [identifier.value] } : { commonName: identifier.value, altNames: [identifier.value] };
  const [, csr] = await acme.crypto.createCsr(data, keyPem);
  return csr;
}

let httpConfigured = false;

/**
 * acme-client's shared axios instance: add a request timeout and disable its internal retry
 * loop (it would sleep for a 429's Retry-After, possibly hours); our own backoff retries instead.
 */
function configureAcmeHttp(): void {
  if (httpConfigured) return;
  httpConfigured = true;
  acme.axios.defaults.timeout = 30_000;
  const defaults = acme.axios.defaults as unknown as { acmeSettings?: { retryMaxAttempts: number } };
  if (defaults.acmeSettings) defaults.acmeSettings.retryMaxAttempts = 0;
}

/**
 * acme-client turns transport errors (timeouts, DNS, refused connections) into an opaque
 * TypeError from its response interceptor; give them a readable message.
 */
function mapTransportError(err: unknown): unknown {
  if (err instanceof TypeError) return new Error("Could not reach Let's Encrypt (network error or timeout)");
  return err;
}

/** Real ACME client bound to an account key. */
export function createAcmeApi(opts: { directoryUrl: string; accountKey: string }): AcmeApi {
  configureAcmeHttp();
  const client = new acme.Client({
    directoryUrl: opts.directoryUrl,
    accountKey: opts.accountKey,
    backoffAttempts: 12,
    backoffMin: 3_000,
    backoffMax: 20_000,
  });
  type Challenge = Parameters<acme.Client['completeChallenge']>[0];
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw mapTransportError(err);
    }
  };
  return {
    createAccount: (data) => call(() => client.createAccount(data)),
    createOrder: (data) => call(async () => (await client.createOrder(data as Parameters<acme.Client['createOrder']>[0])) as unknown as AcmeOrder),
    getAuthorizations: (order) =>
      call(async () => (await client.getAuthorizations(order as unknown as acme.Order)) as unknown as AcmeAuthorization[]),
    getChallengeKeyAuthorization: (ch) => call(() => client.getChallengeKeyAuthorization(ch as unknown as Challenge)),
    completeChallenge: (ch) => call(() => client.completeChallenge(ch as unknown as Challenge)),
    waitForValidStatus: (item) => call(() => client.waitForValidStatus(item)),
    finalizeOrder: (order, csr) => call(async () => (await client.finalizeOrder(order as unknown as acme.Order, csr)) as unknown as AcmeOrder),
    getCertificate: (order) => call(() => client.getCertificate(order as unknown as acme.Order)),
    deactivateAuthorization: (authz) => call(() => client.deactivateAuthorization(authz as unknown as acme.Authorization)),
  };
}

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.trim() || 'Unknown error';
}

async function step<T>(stage: AcmeStage, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AcmeIssueError) throw err;
    signal.throwIfAborted();
    throw new AcmeIssueError(message(err), stage);
  }
}

export interface IssueOptions {
  api: AcmeApi;
  identifier: AcmeIdentifier;
  email: string | null;
  challenges: ChallengeStore;
  signal: AbortSignal;
  log: Logger;
  /** Private key for the certificate (default: new EC P-256 key per issuance). */
  generateKey?: () => Promise<string>;
}

/** Run one ACME order end to end. Returns the new key + full-chain certificate. */
export async function issueCertificate(opts: IssueOptions): Promise<TlsMaterial> {
  const { api, identifier, signal, log } = opts;

  await step('account', signal, () =>
    api.createAccount({ termsOfServiceAgreed: true, ...(opts.email ? { contact: [`mailto:${opts.email}`] } : {}) }),
  );
  const order = await step('order', signal, () => api.createOrder(newOrderRequest(identifier)));
  const authorizations = await step('order', signal, () => api.getAuthorizations(order));

  for (const authz of authorizations) {
    if (authz.status === 'valid') continue;
    const challenge = authz.challenges.find((c) => c.type === 'http-01');
    if (!challenge?.token) {
      throw new AcmeIssueError(`No http-01 challenge offered for ${authz.identifier.value}`, 'challenge');
    }
    const keyAuthorization = await step('challenge', signal, () => api.getChallengeKeyAuthorization(challenge));
    opts.challenges.set(challenge.token, keyAuthorization);
    try {
      log.info({ identifier: authz.identifier.value }, 'answering ACME HTTP-01 challenge');
      await step('challenge', signal, () => api.completeChallenge(challenge));
      await step('challenge', signal, () => api.waitForValidStatus(challenge));
    } catch (err) {
      // Free the pending authorization so the next attempt starts clean (best effort).
      await api.deactivateAuthorization(authz).catch(() => undefined);
      throw err;
    } finally {
      opts.challenges.delete(challenge.token);
    }
  }

  const key = await step('finalize', signal, () => (opts.generateKey ?? createEcKey)());
  const csr = await step('finalize', signal, () => buildCsr(identifier, key));
  const finalized = await step('finalize', signal, () => api.finalizeOrder(order, csr));
  const cert = await step('finalize', signal, () => api.getCertificate(finalized));

  const info = (() => {
    try {
      return readCertInfo(cert);
    } catch {
      throw new AcmeIssueError('The CA returned an unreadable certificate', 'finalize');
    }
  })();
  const wanted = identifier.type === 'ip' ? { dns: [], ip: [identifier.value] } : { dns: [identifier.value], ip: [] };
  if (!coversNames(info, wanted)) throw new AcmeIssueError(`Issued certificate does not cover ${identifier.value}`, 'finalize');
  if (!keyMatchesCert(key, cert)) throw new AcmeIssueError('Issued certificate does not match its private key', 'finalize');
  return { key, cert };
}
