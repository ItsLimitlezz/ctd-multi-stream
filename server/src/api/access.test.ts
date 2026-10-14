import { describe, expect, it } from 'vitest';
import { accessInfo, isLocalHostName, lanBaseUrl, parseHost, parsePortOverride, type LanUrlInput } from './access.js';

const base: LanUrlInput = {
  hostHeader: '192.168.1.20:30443',
  secure: true,
  tlsMode: 'auto',
  webPort: 8443,
  httpPort: 8080,
  lanHttpPortOverride: null,
  localAddresses: ['172.17.0.2'],
};

describe('lanBaseUrl', () => {
  it.each<[string, Partial<LanUrlInput>, string | null]>([
    ['TrueNAS (30443 -> 30080)', {}, 'http://192.168.1.20:30080/api/v1'],
    ['docker compose (443 -> 80)', { hostHeader: '192.168.1.20' }, 'http://192.168.1.20/api/v1'],
    ['docker compose, explicit :443', { hostHeader: '192.168.1.20:443' }, 'http://192.168.1.20/api/v1'],
    ['unmapped ports', { hostHeader: '192.168.1.20:8443' }, 'http://192.168.1.20:8080/api/v1'],
    ['same shift (9443 -> 9080)', { hostHeader: '10.0.0.5:9443' }, 'http://10.0.0.5:9080/api/v1'],
    ['override wins', { lanHttpPortOverride: 9000 }, 'http://192.168.1.20:9000/api/v1'],
    ['override 80 drops the port', { lanHttpPortOverride: 80 }, 'http://192.168.1.20/api/v1'],
    ['public host header: first private address of this machine', { hostHeader: 'stream.example.com' }, 'http://172.17.0.2:8080/api/v1'],
    ['public IP host header', { hostHeader: '203.0.113.7' }, 'http://172.17.0.2:8080/api/v1'],
    ['loopback host header is not a LAN address', { hostHeader: 'localhost:8443' }, 'http://172.17.0.2:8080/api/v1'],
    ['no private address at all', { hostHeader: 'stream.example.com', localAddresses: ['203.0.113.9'] }, null],
    ['IPv6 ULA host', { hostHeader: '[fd00::5]:30443' }, 'http://[fd00::5]:30080/api/v1'],
    ['CGNAT (Tailscale) host', { hostHeader: '100.100.1.2:30443' }, 'http://100.100.1.2:30080/api/v1'],
    ['TLS off: the app itself is HTTP', { tlsMode: 'off', secure: false, hostHeader: '192.168.1.20:8443' }, 'http://192.168.1.20:8443/api/v1'],
    ['TLS off via a public reverse proxy', { tlsMode: 'off', secure: false, hostHeader: 'stream.example.com' }, 'http://172.17.0.2:8443/api/v1'],
    ['no HTTP listener: HTTPS on the LAN', { httpPort: 0 }, 'https://192.168.1.20:30443/api/v1'],
    ['shift out of range falls back to HTTP_PORT', { hostHeader: '192.168.1.20:300' }, 'http://192.168.1.20:8080/api/v1'],
    ['garbage host header', { hostHeader: 'a b:c' }, 'http://172.17.0.2:8080/api/v1'],
    // LAN-only names are used as they are, with the same port shift as LAN IPs.
    ['.local name', { hostHeader: 'nas.local:30443' }, 'http://nas.local:30080/api/v1'],
    ['single-label name', { hostHeader: 'truenas:30443' }, 'http://truenas:30080/api/v1'],
    ['.home.arpa name, default port', { hostHeader: 'nas.home.arpa' }, 'http://nas.home.arpa/api/v1'],
    // In a container this machine's address is the container's: no guess.
    ['container + public host header', { inContainer: true, hostHeader: 'stream.example.com' }, null],
    ['container + localhost', { inContainer: true, hostHeader: 'localhost:8443' }, null],
    ['container + LAN IP host header', { inContainer: true }, 'http://192.168.1.20:30080/api/v1'],
    ['container + .lan name', { inContainer: true, hostHeader: 'nas.lan:30443' }, 'http://nas.lan:30080/api/v1'],
    // LAN_HTTP_HOST wins.
    ['LAN_HTTP_HOST', { inContainer: true, hostHeader: 'stream.example.com', lanHttpHostOverride: '192.168.1.20' }, 'http://192.168.1.20:8080/api/v1'],
    ['LAN_HTTP_HOST + port override', { hostHeader: 'stream.example.com', lanHttpHostOverride: 'nas.local', lanHttpPortOverride: 30080 }, 'http://nas.local:30080/api/v1'],
    ['LAN_HTTP_HOST keeps the shift of a LAN request', { lanHttpHostOverride: '10.0.0.9' }, 'http://10.0.0.9:30080/api/v1'],
    ['invalid LAN_HTTP_HOST is ignored', { lanHttpHostOverride: 'not a host' }, 'http://192.168.1.20:30080/api/v1'],
    ['IPv6 LAN_HTTP_HOST', { lanHttpHostOverride: 'fd00::7' }, 'http://[fd00::7]:30080/api/v1'],
    // LAN_HTTP=off: LAN apps use HTTPS.
    ['LAN HTTP off', { lanHttpEnabled: false }, 'https://192.168.1.20:30443/api/v1'],
  ])('%s', (_name, over, expected) => {
    expect(lanBaseUrl({ ...base, ...over })).toBe(expected);
  });

  it('isLocalHostName', () => {
    expect(isLocalHostName('nas')).toBe(true);
    expect(isLocalHostName('nas.local')).toBe(true);
    expect(isLocalHostName('box.internal')).toBe(true);
    expect(isLocalHostName('localhost')).toBe(false);
    expect(isLocalHostName('a.localhost')).toBe(false);
    expect(isLocalHostName('stream.example.com')).toBe(false);
  });
});

describe('helpers', () => {
  it('parseHost', () => {
    expect(parseHost('192.168.1.20:30443')).toEqual({ ip: '192.168.1.20', port: 30443 });
    expect(parseHost('[FD00::5]')).toEqual({ ip: 'fd00::5', port: null });
    expect(parseHost('nas.local:8443')).toEqual({ ip: null, port: 8443 });
    expect(parseHost(undefined)).toEqual({ ip: null, port: null });
    expect(parseHost('1.2.3.4:99999')).toEqual({ ip: '1.2.3.4', port: null });
  });

  it('parsePortOverride takes the first valid port', () => {
    expect(parsePortOverride('9000')).toBe(9000);
    expect(parsePortOverride(undefined, 7000)).toBe(7000);
    expect(parsePortOverride('abc', null)).toBeNull();
    expect(parsePortOverride('70000', 0, -1, 1.5)).toBeNull();
    expect(parsePortOverride(' 30080 ')).toBe(30080);
  });

  it('accessInfo', () => {
    expect(accessInfo({ publicBaseUrl: 'https://203.0.113.7/', lan: base, fingerprint256: 'AB:CD' })).toEqual({
      baseUrl: 'https://203.0.113.7/api/v1',
      lanBaseUrl: 'http://192.168.1.20:30080/api/v1',
      tlsFingerprint256: 'AB:CD',
      openApiUrl: 'https://203.0.113.7/api/v1/openapi.json',
    });
  });
});
