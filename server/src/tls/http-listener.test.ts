import http from 'node:http';
import net from 'node:net';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpListener, parseHostHeader, routeHttpRequest, type HttpListener } from './http-listener.js';

const log = pino({ level: 'silent' });

function get(port: number, path: string, host: string, method = 'GET') {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Send a raw request (lets us use Host values a well-behaved client would refuse). */
function raw(port: number, request: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (c: string) => (data += c));
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
    socket.setTimeout(3_000, () => socket.destroy(new Error('timeout')));
  });
}

describe('parseHostHeader', () => {
  it.each([
    ['example.com', 'example.com'],
    ['Example.COM:8080', 'example.com'],
    ['93.184.216.34:80', '93.184.216.34'],
    ['[2001:DB8::1]:80', '[2001:db8::1]'],
    ['[::1]', '[::1]'],
  ])('%s -> %s', (input, out) => {
    expect(parseHostHeader(input)).toBe(out);
  });

  it.each([
    undefined,
    '',
    'evil.com/path',
    'evil.com@attacker.test',
    'a b',
    'exa_mple.com',
    'example.com:',
    'example.com:80:80',
    '[not-ipv6]',
    '[::1',
    'evil.com\r\nSet-Cookie: x=1',
    '.example.com',
    'example..com',
    'x'.repeat(300),
  ])('rejects %j', (input) => {
    expect(parseHostHeader(input)).toBeNull();
  });
});

describe('routeHttpRequest', () => {
  const challenges = new Map([['tok_ABC-123', 'tok_ABC-123.thumbprint']]);

  it('redirects to https on the public port, keeping path and query', () => {
    const r = routeHttpRequest({ method: 'GET', url: '/login?next=%2Fdash', host: 'nas.example.com:80' }, { publicPort: 8443, challenges });
    expect(r.status).toBe(301);
    expect(r.headers.location).toBe('https://nas.example.com:8443/login?next=%2Fdash');
  });

  it('omits the port for 443 and handles IPv6 hosts and absolute-form targets', () => {
    expect(routeHttpRequest({ method: 'GET', url: '/', host: '93.184.216.34' }, { publicPort: 443, challenges }).headers.location).toBe(
      'https://93.184.216.34/',
    );
    expect(routeHttpRequest({ method: 'GET', url: '/x', host: '[2001:db8::1]:80' }, { publicPort: 443, challenges }).headers.location).toBe(
      'https://[2001:db8::1]/x',
    );
    expect(
      routeHttpRequest({ method: 'GET', url: 'http://other.test/abs?q=1', host: 'nas.example.com' }, { publicPort: 443, challenges }).headers
        .location,
    ).toBe('https://nas.example.com/abs?q=1');
  });

  it('rejects unvalidated hosts with 400 and never reflects them', () => {
    const r = routeHttpRequest({ method: 'GET', url: '/', host: 'evil.com/phish' }, { publicPort: 443, challenges });
    expect(r.status).toBe(400);
    expect(r.headers.location).toBeUndefined();
    expect(r.body).not.toContain('evil');
    expect(routeHttpRequest({ method: 'GET', url: '/', host: undefined }, { publicPort: 443, challenges }).status).toBe(400);
  });

  it('serves known challenge tokens only', () => {
    expect(routeHttpRequest({ method: 'GET', url: '/.well-known/acme-challenge/tok_ABC-123', host: undefined }, { publicPort: 443, challenges })).toMatchObject({
      status: 200,
      body: 'tok_ABC-123.thumbprint',
    });
    expect(routeHttpRequest({ method: 'GET', url: '/.well-known/acme-challenge/nope', host: 'x' }, { publicPort: 443, challenges }).status).toBe(404);
    expect(routeHttpRequest({ method: 'GET', url: '/.well-known/acme-challenge/../etc', host: 'x' }, { publicPort: 443, challenges }).status).toBe(404);
    expect(routeHttpRequest({ method: 'POST', url: '/.well-known/acme-challenge/tok_ABC-123', host: 'x' }, { publicPort: 443, challenges }).status).toBe(405);
  });
});

describe('createHttpListener (real socket)', () => {
  const challenges = new Map<string, string>();
  let listener: HttpListener;
  let port: number;

  beforeAll(async () => {
    listener = createHttpListener({ port: 0, host: '127.0.0.1', publicPort: 8443, challenges, log });
    port = await listener.listen();
  });
  afterAll(async () => {
    await listener.close();
  });

  it('answers a challenge with the key authorization as text/plain', async () => {
    challenges.set('token123', 'token123.thumb');
    const r = await get(port, '/.well-known/acme-challenge/token123', '93.184.216.34');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
    expect(r.body).toBe('token123.thumb');
    challenges.delete('token123');
    expect((await get(port, '/.well-known/acme-challenge/token123', '93.184.216.34')).status).toBe(404);
  });

  it('redirects with the non-443 public port', async () => {
    const r = await get(port, '/dashboard?tab=1', 'nas.example.com:8080');
    expect(r.status).toBe(301);
    expect(r.headers.location).toBe('https://nas.example.com:8443/dashboard?tab=1');
  });

  it('HEAD gets headers without a body', async () => {
    const r = await get(port, '/', 'nas.example.com', 'HEAD');
    expect(r.status).toBe(301);
    expect(r.body).toBe('');
  });

  it('rejects Host header injection', async () => {
    const res = await raw(port, 'GET / HTTP/1.1\r\nHost: evil.test/x?\r\nConnection: close\r\n\r\n');
    expect(res.startsWith('HTTP/1.1 400')).toBe(true);
    expect(res.toLowerCase()).not.toContain('location:');

    const res2 = await raw(port, 'GET / HTTP/1.1\r\nHost: evil.test%0d%0aX:1\r\nConnection: close\r\n\r\n');
    expect(res2.startsWith('HTTP/1.1 400')).toBe(true);
  });

  it('close() stops listening', async () => {
    const other = createHttpListener({ port: 0, host: '127.0.0.1', publicPort: 443, challenges, log });
    const p = await other.listen();
    await other.close();
    await expect(get(p, '/', 'x.test')).rejects.toThrow();
  });
});
