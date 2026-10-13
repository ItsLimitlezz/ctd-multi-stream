import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { ChatMessageInput } from '../types.js';
import { clearChatroomCache, kickChat, resolveChatroomId } from './chat-source.js';
import type { ChatroomInfo } from './chatroom.js';
import { makeAccount, makeCtx, type FakeCtx } from './test-utils.js';

let ctx: FakeCtx;
let ctl: AbortController;

beforeEach(() => {
  clearChatroomCache();
  ctx = makeCtx();
  ctl = new AbortController();
});

afterEach(() => {
  ctl.abort();
});

describe('resolveChatroomId', () => {
  it('uses the id cached on the account for the same slug', async () => {
    const lookup = vi.fn<(slug: string, signal: AbortSignal) => Promise<ChatroomInfo>>();
    const account = makeAccount({ options: { slug: 'StreamerName', chatroomId: 668 } });
    expect(await resolveChatroomId({ ctx, account, slug: 'streamername', signal: ctl.signal, lookup })).toBe(668);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('looks up (retrying with backoff), stores the id on the account and caches it in memory', async () => {
    const lookup = vi
      .fn<(slug: string, signal: AbortSignal) => Promise<ChatroomInfo>>()
      .mockRejectedValueOnce(new Error('blocked by Cloudflare'))
      .mockResolvedValueOnce({ chatroomId: 900, channelId: 12 });
    const account = makeAccount({ options: { userId: 1, slug: 'chan', chatroomId: 5 } });
    const id = await resolveChatroomId({ ctx, account, slug: 'newslug', signal: ctl.signal, lookup, backoffMs: [10] });
    expect(id).toBe(900);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(ctx.updates).toEqual([{ options: { userId: 1, slug: 'newslug', chatroomId: 900, channelId: 12 } }]);

    // second resolution comes from memory, even with an account snapshot that lacks it
    const again = await resolveChatroomId({ ctx, account: makeAccount(), slug: 'NewSlug', signal: ctl.signal, lookup });
    expect(again).toBe(900);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('returns null promptly when aborted during the backoff', async () => {
    const lookup = vi.fn(async () => {
      throw new Error('blocked');
    });
    const p = resolveChatroomId({ ctx, account: makeAccount(), slug: 's', signal: ctl.signal, lookup, backoffMs: [60_000] });
    setTimeout(() => ctl.abort(), 50);
    const started = Date.now();
    expect(await p).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('kickChat', () => {
  let wss: WebSocketServer;
  let url: string;

  beforeEach(async () => {
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/app/key`;
  });

  afterEach(async () => {
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('subscribes to the chatroom channel and yields parsed chat messages', async () => {
    const subscribed: unknown[] = [];
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ event: 'pusher:connection_established', data: '{"socket_id":"1.2","activity_timeout":120}' }));
      ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as { event: string; data: { channel: string } };
        if (frame.event !== 'pusher:subscribe') return;
        subscribed.push(frame.data);
        const channel = frame.data.channel;
        ws.send(JSON.stringify({ event: 'App\\Events\\MessageDeletedEvent', data: '{"id":"x"}', channel }));
        ws.send(
          JSON.stringify({
            event: 'App\\Events\\ChatMessageEvent',
            channel,
            data: JSON.stringify({
              id: 'msg-1',
              content: 'gg [emote:1:KEKW]',
              created_at: '2026-10-11T18:30:00+00:00',
              sender: { username: 'fan', identity: { color: '#00FF00', badges: [{ type: 'vip', text: 'VIP' }] } },
            }),
          }),
        );
      });
    });

    const account = makeAccount({ options: { slug: 'chan', chatroomId: 668 } });
    const out: ChatMessageInput[] = [];
    for await (const msg of kickChat({ ctx, account, slug: 'chan', signal: ctl.signal, pusherUrl: url })) {
      out.push(msg);
      ctl.abort();
    }
    expect(subscribed).toEqual([{ auth: '', channel: 'chatrooms.668.v2' }]);
    expect(out).toEqual([
      {
        id: 'msg-1',
        kind: 'message',
        text: 'gg :KEKW:',
        ts: '2026-10-11T18:30:00.000Z',
        author: { name: 'fan', color: '#00FF00', badges: ['VIP'] },
      },
    ]);
  });

  it('throws when the chat connection drops, so the ChatHub restarts it', async () => {
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ event: 'pusher:connection_established', data: '{"socket_id":"1.2"}' }));
      setTimeout(() => ws.close(4200, 'Generic reconnect'), 50);
    });
    const account = makeAccount({ options: { slug: 'chan', chatroomId: 668 } });
    const it = kickChat({ ctx, account, slug: 'chan', signal: ctl.signal, pusherUrl: url });
    await expect(it.next()).rejects.toThrow(/closed \(code 4200/);
  });

  it('ends without connecting when aborted before the chatroom is known', async () => {
    const connections = vi.fn();
    wss.on('connection', connections);
    ctl.abort();
    const it = kickChat({ ctx, account: makeAccount(), slug: 'chan', signal: ctl.signal, pusherUrl: url, lookup: async () => ({ chatroomId: 1, channelId: null }) });
    expect(await it.next()).toEqual({ done: true, value: undefined });
    expect(connections).not.toHaveBeenCalled();
  });
});
