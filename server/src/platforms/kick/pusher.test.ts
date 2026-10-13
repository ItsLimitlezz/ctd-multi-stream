import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { kickPusherUrl, PusherError, pusherEvents, type PusherEvent } from './pusher.js';

interface Server {
  url: string;
  wss: WebSocketServer;
  /** Client frames received by the server, parsed. */
  received: { event: string; data: unknown }[];
  next(): Promise<WsSocket>;
}

async function startServer(onConnect?: (ws: WsSocket) => void): Promise<Server> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const received: Server['received'] = [];
  const waiting: ((ws: WsSocket) => void)[] = [];
  const sockets: WsSocket[] = [];
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => received.push(JSON.parse(String(raw)) as { event: string; data: unknown }));
    onConnect?.(ws);
    const w = waiting.shift();
    if (w) w(ws);
    else sockets.push(ws);
  });
  const port = (wss.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}/app/testkey?protocol=7`,
    wss,
    received,
    next: () => {
      const ready = sockets.shift();
      return ready ? Promise.resolve(ready) : new Promise((resolve) => waiting.push(resolve));
    },
  };
}

function establish(ws: WsSocket, activityTimeout = 120): void {
  ws.send(
    JSON.stringify({
      event: 'pusher:connection_established',
      data: JSON.stringify({ socket_id: '123.456', activity_timeout: activityTimeout }),
    }),
  );
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let server: Server;
let ctl: AbortController;

beforeEach(() => {
  ctl = new AbortController();
});

afterEach(async () => {
  ctl.abort();
  for (const c of server?.wss.clients ?? []) c.terminate();
  await new Promise<void>((resolve) => server?.wss.close(() => resolve()) ?? resolve());
});

describe('kickPusherUrl', () => {
  it('uses the built-in key and cluster, overridable by env', () => {
    expect(kickPusherUrl({})).toBe(
      'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false',
    );
    expect(kickPusherUrl({ KICK_PUSHER_KEY: ' newkey ', KICK_PUSHER_CLUSTER: 'eu' })).toMatch(/^wss:\/\/ws-eu\.pusher\.com\/app\/newkey\?/);
  });
});

describe('pusherEvents', () => {
  it('subscribes after connecting, answers pings and yields channel events with parsed data', async () => {
    server = await startServer(establish);
    const events = pusherEvents({ url: server.url, channels: ['chatrooms.668.v2'], signal: ctl.signal });
    const firstP = events.next();
    const ws = await server.next();
    await until(() => server.received.some((f) => f.event === 'pusher:subscribe'));
    expect(server.received.find((f) => f.event === 'pusher:subscribe')?.data).toEqual({ auth: '', channel: 'chatrooms.668.v2' });

    ws.send(JSON.stringify({ event: 'pusher_internal:subscription_succeeded', data: '{}', channel: 'chatrooms.668.v2' }));
    ws.send(JSON.stringify({ event: 'pusher:ping', data: '{}' }));
    ws.send(JSON.stringify({ event: 'App\\Events\\ChatMessageEvent', data: JSON.stringify({ id: 'm1', content: 'hi' }), channel: 'chatrooms.668.v2' }));
    ws.send('not json');
    ws.send(JSON.stringify({ event: 'App\\Events\\ChatMessageEvent', data: { id: 'm2' }, channel: 'chatrooms.668.v2' }));

    const first = await firstP;
    expect(first.value).toEqual<PusherEvent>({
      event: 'App\\Events\\ChatMessageEvent',
      channel: 'chatrooms.668.v2',
      data: { id: 'm1', content: 'hi' },
    });
    expect((await events.next()).value).toMatchObject({ data: { id: 'm2' } });
    await until(() => server.received.some((f) => f.event === 'pusher:pong'));
    await events.return(undefined);
  });

  it('ends quietly and closes the socket when the signal aborts', async () => {
    server = await startServer(establish);
    const events = pusherEvents({ url: server.url, channels: ['c'], signal: ctl.signal });
    const pending = events.next();
    const ws = await server.next();
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    await until(() => server.received.length > 0);
    ctl.abort();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(await closed).toBe(1000);
  });

  it('throws when the server closes the connection', async () => {
    server = await startServer(establish);
    const events = pusherEvents({ url: server.url, channels: ['c'], signal: ctl.signal });
    const pending = events.next();
    const ws = await server.next();
    await until(() => server.received.length > 0);
    ws.close(4201, 'Pong reply not received');
    await expect(pending).rejects.toThrow(/closed \(code 4201: Pong reply not received\)/);
  });

  it('reports pusher:error 4001 as fatal with a hint about the key', async () => {
    server = await startServer((ws) => ws.send(JSON.stringify({ event: 'pusher:error', data: { code: 4001, message: 'App key x not in this cluster' } })));
    const events = pusherEvents({ url: server.url, channels: ['c'], signal: ctl.signal });
    const err = await events.next().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PusherError);
    expect((err as PusherError).fatal).toBe(true);
    expect((err as PusherError).code).toBe(4001);
    expect((err as Error).message).toMatch(/KICK_PUSHER_KEY/);
  });

  it('times out when the server never establishes the connection', async () => {
    server = await startServer();
    const events = pusherEvents({ url: server.url, channels: ['c'], signal: ctl.signal, connectTimeoutMs: 200 });
    await expect(events.next()).rejects.toThrow(/Timed out connecting/);
  });

  it('pings after inactivity and fails when no pong comes back', async () => {
    server = await startServer(establish);
    const events = pusherEvents({
      url: server.url,
      channels: ['c'],
      signal: ctl.signal,
      activityTimeoutMs: 150,
      pongTimeoutMs: 150,
    });
    const pending = events.next();
    await expect(pending).rejects.toThrow(/went silent/);
    expect(server.received.some((f) => f.event === 'pusher:ping')).toBe(true);
  });

  it('stays connected while the server answers pings', async () => {
    server = await startServer((ws) => {
      establish(ws);
      ws.on('message', (raw) => {
        if ((JSON.parse(String(raw)) as { event: string }).event === 'pusher:ping') {
          ws.send(JSON.stringify({ event: 'pusher:pong', data: '{}' }));
        }
      });
    });
    const events = pusherEvents({
      url: server.url,
      channels: ['c'],
      signal: ctl.signal,
      activityTimeoutMs: 100,
      pongTimeoutMs: 100,
    });
    const pending = events.next();
    const ws = await server.next();
    await until(() => server.received.filter((f) => f.event === 'pusher:ping').length >= 3, 5000);
    ws.send(JSON.stringify({ event: 'App\\Events\\StreamHostEvent', data: '{"host_username":"h"}', channel: 'c' }));
    expect((await pending).value).toMatchObject({ event: 'App\\Events\\StreamHostEvent', data: { host_username: 'h' } });
    await events.return(undefined);
  });

  it('returns immediately when already aborted', async () => {
    server = await startServer(establish);
    ctl.abort();
    const events = pusherEvents({ url: server.url, channels: ['c'], signal: ctl.signal });
    expect(await events.next()).toEqual({ done: true, value: undefined });
  });
});
