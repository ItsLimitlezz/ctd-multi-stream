import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import type { ChatMessageInput } from '../types.js';
import { readTwitchChat } from './chat.js';

/** A tiny fake of irc-ws.chat.twitch.tv on 127.0.0.1. */
class FakeIrc {
  readonly server: WebSocketServer;
  readonly received: string[] = [];
  readonly sockets: ServerSocket[] = [];
  private waiters: (() => void)[] = [];

  constructor() {
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.server.on('connection', (socket) => {
      this.sockets.push(socket);
      socket.on('message', (data) => {
        for (const line of data.toString().split('\r\n')) if (line) this.received.push(line);
        this.notify();
      });
      this.notify();
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  private notify(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  /** Resolve once `pred` holds (re-checked on every event). */
  async until(pred: () => boolean, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the fake IRC server');
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  send(text: string): void {
    for (const s of this.sockets) s.send(text);
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

let irc: FakeIrc;

beforeEach(async () => {
  irc = new FakeIrc();
  await new Promise<void>((resolve) => irc.server.once('listening', () => resolve()));
});

afterEach(async () => {
  await irc.close();
});

/** Collect messages into an array in the background; resolves with the error/end. */
function consume(it: AsyncIterable<ChatMessageInput>, into: ChatMessageInput[]): Promise<unknown> {
  return (async () => {
    try {
      for await (const m of it) into.push(m);
      return 'ended';
    } catch (err) {
      return err;
    }
  })();
}

describe('readTwitchChat', () => {
  it('logs in anonymously, answers PING and yields chat messages', async () => {
    const ctl = new AbortController();
    const messages: ChatMessageInput[] = [];
    const done = consume(readTwitchChat('TwitchDev', ctl.signal, { url: irc.url }), messages);

    await irc.until(() => irc.received.length >= 4);
    expect(irc.received[0]).toBe('CAP REQ :twitch.tv/tags twitch.tv/commands');
    expect(irc.received[1]).toBe('PASS SCHMOOPIIE');
    expect(irc.received[2]).toMatch(/^NICK justinfan\d+$/);
    expect(irc.received[3]).toBe('JOIN #twitchdev');

    irc.send('PING :tmi.twitch.tv\r\n');
    await irc.until(() => irc.received.includes('PONG :tmi.twitch.tv'));

    irc.send(
      ':tmi.twitch.tv 001 justinfan1 :Welcome, GLHF!\r\n' +
        '@badges=subscriber/6;color=#1E90FF;display-name=Viewer;id=m1;tmi-sent-ts=1700000000000 ' +
        ':viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #twitchdev :hello\r\n' +
        '@display-name=Raider;id=m2;login=raider;msg-id=raid;system-msg=5\\sraiders\\sfrom\\sRaider\\shave\\sjoined! ' +
        ':tmi.twitch.tv USERNOTICE #twitchdev\r\n',
    );
    await irc.until(() => messages.length >= 2);
    expect(messages[0]).toEqual({
      author: { name: 'Viewer', color: '#1E90FF', badges: ['subscriber'] },
      text: 'hello',
      kind: 'message',
      id: 'm1',
      ts: new Date(1700000000000).toISOString(),
    });
    expect(messages[1]).toMatchObject({ text: '5 raiders from Raider have joined!', kind: 'event', id: 'm2' });

    ctl.abort();
    expect(await done).toBe('ended');
    await irc.until(() => irc.sockets[0]?.readyState === 3);
  });

  it('throws when the server closes the connection (the ChatHub reconnects)', async () => {
    const ctl = new AbortController();
    const done = consume(readTwitchChat('chan', ctl.signal, { url: irc.url }), []);
    await irc.until(() => irc.received.length >= 4);
    irc.sockets[0]!.close(4000, 'bye');
    const err = await done;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/disconnected/);
  });

  it('throws on RECONNECT', async () => {
    const done = consume(readTwitchChat('chan', new AbortController().signal, { url: irc.url }), []);
    await irc.until(() => irc.received.length >= 4);
    irc.send(':tmi.twitch.tv RECONNECT\r\n');
    expect(((await done) as Error).message).toMatch(/reconnect/);
  });

  it('closes a silent connection', async () => {
    const done = consume(
      readTwitchChat('chan', new AbortController().signal, { url: irc.url, pingIntervalMs: 50, idleTimeoutMs: 120 }),
      [],
    );
    // The fake never answers our PINGs.
    const err = (await done) as Error;
    expect(err.message).toMatch(/silent/);
    expect(irc.received.some((l) => l === 'PING :tmi.twitch.tv')).toBe(true);
  });

  it('fails fast when the server is unreachable', async () => {
    const url = irc.url;
    await irc.close();
    const err = (await consume(readTwitchChat('chan', new AbortController().signal, { url }), [])) as Error;
    expect(err.message).toMatch(/connect/i);
  });

  it('rejects invalid channel names and returns at once when already aborted', async () => {
    const bad = (await consume(readTwitchChat('bad name\r\nJOIN #x', new AbortController().signal, { url: irc.url }), [])) as Error;
    expect(bad.message).toMatch(/Invalid Twitch channel/);
    const ctl = new AbortController();
    ctl.abort();
    expect(await consume(readTwitchChat('chan', ctl.signal, { url: irc.url }), [])).toBe('ended');
  });
});
