import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { generate } from 'selfsigned';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AcmeIssueError,
  buildCsr,
  createAcmeApi,
  issueCertificate,
  newOrderRequest,
  type AcmeApi,
  type AcmeAuthorization,
  type AcmeChallenge,
  type AcmeIdentifier,
  type AcmeOrder,
  type NewOrderRequest,
} from './acme.js';
import { createHttpListener, type HttpListener } from './http-listener.js';

const log = pino({ level: 'silent' });
const IP = '93.184.216.34';

function ecKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** A certificate for `keys` (stands in for the CA's issued leaf + an intermediate). */
async function leafFor(keys: { privateKey: string; publicKey: string }, id: AcmeIdentifier, hours = 160): Promise<string> {
  const altName = id.type === 'ip' ? { type: 7 as const, ip: id.value } : { type: 2 as const, value: id.value };
  const leaf = await generate(undefined, {
    keyType: 'ec',
    keyPair: keys,
    algorithm: 'sha256',
    notBeforeDate: new Date(),
    notAfterDate: new Date(Date.now() + hours * 3_600_000),
    extensions: [{ name: 'subjectAltName', altNames: [altName] }],
  });
  const intermediate = await generate([{ name: 'commonName', value: 'Fake Intermediate' }], { keyType: 'ec', algorithm: 'sha256' });
  return `${leaf.cert.trim()}\n${intermediate.cert.trim()}\n`;
}

interface FakeOpts {
  /** Called when the "CA" validates: return the body it fetched for the token. */
  fetchChallenge: (token: string) => Promise<string>;
  certificate: () => Promise<string>;
}

class FakeAcme implements AcmeApi {
  accounts: unknown[] = [];
  orders: NewOrderRequest[] = [];
  csrs: Buffer[] = [];
  validatedBodies: string[] = [];
  deactivated = 0;
  private keyAuth = '';

  constructor(private readonly opts: FakeOpts) {}

  async createAccount(data: { termsOfServiceAgreed: boolean; contact?: string[] }) {
    this.accounts.push(data);
    return {};
  }
  async createOrder(data: NewOrderRequest): Promise<AcmeOrder> {
    this.orders.push(data);
    return { url: 'https://ca.test/order/1', status: 'pending', authorizations: ['https://ca.test/authz/1'], finalize: 'https://ca.test/finalize/1' };
  }
  async getAuthorizations(): Promise<AcmeAuthorization[]> {
    const id = this.orders.at(-1)!.identifiers[0]!;
    return [
      {
        url: 'https://ca.test/authz/1',
        status: 'pending',
        identifier: id,
        challenges: [
          { type: 'tls-alpn-01', url: 'https://ca.test/chall/alpn', status: 'pending', token: 'alpn' },
          { type: 'http-01', url: 'https://ca.test/chall/http', status: 'pending', token: 'tok_http-01' },
        ],
      },
    ];
  }
  async getChallengeKeyAuthorization(ch: AcmeChallenge) {
    this.keyAuth = `${ch.token}.thumbprint`;
    return this.keyAuth;
  }
  async completeChallenge(ch: AcmeChallenge) {
    this.validatedBodies.push(await this.opts.fetchChallenge(ch.token!));
    return ch;
  }
  async waitForValidStatus<T extends { url: string }>(item: T): Promise<T> {
    if (this.validatedBodies.at(-1) !== this.keyAuth) throw new Error(`Invalid response from http://${IP}/.well-known/acme-challenge/x: 404`);
    return item;
  }
  async finalizeOrder(order: AcmeOrder, csr: Buffer): Promise<AcmeOrder> {
    this.csrs.push(csr);
    return { ...order, status: 'valid', certificate: 'https://ca.test/cert/1' };
  }
  async getCertificate() {
    return this.opts.certificate();
  }
  async deactivateAuthorization() {
    this.deactivated++;
    return {};
  }
}

function csrDer(csr: Buffer): Buffer {
  return Buffer.from(csr.toString().replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
}

describe('newOrderRequest', () => {
  it('uses the shortlived profile for IP identifiers only', () => {
    expect(newOrderRequest({ type: 'ip', value: IP })).toEqual({ identifiers: [{ type: 'ip', value: IP }], profile: 'shortlived' });
    expect(newOrderRequest({ type: 'dns', value: 'nas.example.com' })).toEqual({ identifiers: [{ type: 'dns', value: 'nas.example.com' }] });
  });
});

describe('buildCsr', () => {
  it('encodes an IP identifier as an iPAddress SAN (tag [7]), not a dNSName', async () => {
    const { privateKey } = ecKeyPair();
    const der = csrDer(await buildCsr({ type: 'ip', value: IP }, privateKey));
    expect(der.includes(Buffer.from([0x87, 4, 93, 184, 216, 34]))).toBe(true);
    expect(der.includes(Buffer.from(IP))).toBe(false); // no textual dNSName / CN
  });

  it('encodes IPv6 as a 16-byte iPAddress SAN', async () => {
    const { privateKey } = ecKeyPair();
    const der = csrDer(await buildCsr({ type: 'ip', value: '2606:4700::1' }, privateKey));
    const bytes = Buffer.from('26064700000000000000000000000001', 'hex');
    expect(der.includes(Buffer.concat([Buffer.from([0x87, 16]), bytes]))).toBe(true);
  });

  it('encodes a domain as a dNSName SAN', async () => {
    const { privateKey } = ecKeyPair();
    const der = csrDer(await buildCsr({ type: 'dns', value: 'nas.example.com' }, privateKey));
    expect(der.includes(Buffer.concat([Buffer.from([0x82, 15]), Buffer.from('nas.example.com')]))).toBe(true);
  });
});

describe('issueCertificate', () => {
  const challenges = new Map<string, string>();
  let listener: HttpListener;
  let port: number;

  beforeAll(async () => {
    listener = createHttpListener({ port: 0, host: '127.0.0.1', publicPort: 443, challenges, log });
    port = await listener.listen();
  });
  afterAll(async () => {
    await listener.close();
  });

  /** The fake CA validates by fetching the token from our real HTTP listener. */
  const fetchChallenge = async (token: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/acme-challenge/${token}`);
    return res.ok ? res.text() : `HTTP ${res.status}`;
  };

  it('orders an IP certificate with the shortlived profile and serves the http-01 challenge', async () => {
    const keys = ecKeyPair();
    const id: AcmeIdentifier = { type: 'ip', value: IP };
    const api = new FakeAcme({ fetchChallenge, certificate: () => leafFor(keys, id) });

    const material = await issueCertificate({
      api,
      identifier: id,
      email: 'me@example.com',
      challenges,
      signal: new AbortController().signal,
      log,
      generateKey: async () => keys.privateKey,
    });

    expect(api.accounts).toEqual([{ termsOfServiceAgreed: true, contact: ['mailto:me@example.com'] }]);
    expect(api.orders).toEqual([{ identifiers: [{ type: 'ip', value: IP }], profile: 'shortlived' }]);
    expect(api.validatedBodies).toEqual(['tok_http-01.thumbprint']);
    expect(challenges.size).toBe(0); // cleaned up after validation
    expect(csrDer(api.csrs[0]!).includes(Buffer.from([0x87, 4, 93, 184, 216, 34]))).toBe(true);
    expect(material.key).toBe(keys.privateKey);
    expect(material.cert.match(/BEGIN CERTIFICATE/g)).toHaveLength(2); // full chain kept
  });

  it('fails in the challenge stage (and deactivates the authz) when validation fails', async () => {
    const keys = ecKeyPair();
    const id: AcmeIdentifier = { type: 'ip', value: IP };
    const api = new FakeAcme({ fetchChallenge: async () => 'HTTP 404', certificate: () => leafFor(keys, id) });
    const err = await issueCertificate({ api, identifier: id, email: null, challenges, signal: new AbortController().signal, log }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AcmeIssueError);
    expect((err as AcmeIssueError).stage).toBe('challenge');
    expect((err as Error).message).toContain('Invalid response');
    expect(api.deactivated).toBe(1);
    expect(api.accounts).toEqual([{ termsOfServiceAgreed: true }]);
    expect(challenges.size).toBe(0);
  });

  it('rejects a certificate that does not cover the identifier', async () => {
    const keys = ecKeyPair();
    const api = new FakeAcme({ fetchChallenge, certificate: () => leafFor(keys, { type: 'ip', value: '93.184.216.99' }) });
    await expect(
      issueCertificate({
        api,
        identifier: { type: 'ip', value: IP },
        email: null,
        challenges,
        signal: new AbortController().signal,
        log,
        generateKey: async () => keys.privateKey,
      }),
    ).rejects.toThrow(/does not cover/);
  });

  it('stops when aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const api = new FakeAcme({ fetchChallenge, certificate: async () => '' });
    await expect(issueCertificate({ api, identifier: { type: 'ip', value: IP }, email: null, challenges, signal: ac.signal, log })).rejects.toThrow();
    expect(api.orders).toHaveLength(0);
  });
});

describe('createAcmeApi (real acme-client against a local server)', () => {
  let server: http.Server;
  let base: string;
  const requests: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.url === '/dir') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ newNonce: `${base}/nonce`, newAccount: `${base}/acct`, newOrder: `${base}/order`, meta: {} }));
        return;
      }
      if (req.url === '/nonce') {
        res.writeHead(200, { 'replay-nonce': `n${requests.length}` });
        res.end();
        return;
      }
      req.resume();
      res.writeHead(429, { 'content-type': 'application/problem+json', 'retry-after': '3600', 'replay-nonce': 'x' });
      res.end(JSON.stringify({ type: 'urn:ietf:params:acme:error:rateLimited', detail: 'too many failed authorizations recently' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  it('surfaces rate limits immediately instead of sleeping for Retry-After', async () => {
    const accountKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const api = createAcmeApi({ directoryUrl: `${base}/dir`, accountKey });
    const started = Date.now();
    await expect(api.createAccount({ termsOfServiceAgreed: true })).rejects.toThrow(/too many failed authorizations/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(requests.filter((r) => r === 'POST /acct')).toHaveLength(1);
  });

  it('maps transport failures to a readable error', async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((r) => closed.close(r));
    const accountKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const api = createAcmeApi({ directoryUrl: `http://127.0.0.1:${port}/dir`, accountKey });
    await expect(api.createAccount({ termsOfServiceAgreed: true })).rejects.toThrow(/Could not reach Let's Encrypt/);
  });
});
