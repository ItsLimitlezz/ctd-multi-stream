import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { isChatModeration, type ChatSourceItem } from '../types.js';
import { clearChatroomCache, kickChat, RecentEventKeys, resolveChatroom, resolveChatroomId } from './chat-source.js';
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

  it('resolveChatroom also returns the channel id (account cache, then lookups)', async () => {
    const lookup = vi.fn(async () => ({ chatroomId: 1, channelId: 2 }));
    const cachedAccount = makeAccount({ options: { slug: 'a', chatroomId: 668, channelId: 4242 } });
    expect(await resolveChatroom({ ctx, account: cachedAccount, slug: 'a', signal: ctl.signal, lookup })).toEqual({ chatroomId: 668, channelId: 4242 });
    expect(await resolveChatroom({ ctx, account: makeAccount({ options: { slug: 'b', chatroomId: 7 } }), slug: 'b', signal: ctl.signal, lookup })).toEqual({
      chatroomId: 7,
      channelId: null,
    });
    expect(await resolveChatroom({ ctx, account: makeAccount(), slug: 'c', signal: ctl.signal, lookup })).toEqual({ chatroomId: 1, channelId: 2 });
    expect(await resolveChatroom({ ctx, account: makeAccount(), slug: 'C', signal: ctl.signal, lookup })).toEqual({ chatroomId: 1, channelId: 2 });
    expect(lookup).toHaveBeenCalledTimes(1);
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

describe('RecentEventKeys', () => {
  it('reports repeats within the window only, and stays bounded', () => {
    const keys = new RecentEventKeys(1000, 3);
    expect(keys.repeat('a', 0)).toBe(false);
    expect(keys.repeat('a', 500)).toBe(true);
    expect(keys.repeat('a', 1500)).toBe(false); // expired, recorded again
    expect(keys.repeat('b', 1600)).toBe(false);
    expect(keys.repeat('c', 1700)).toBe(false);
    expect(keys.repeat('d', 1800)).toBe(false); // evicts the oldest ('a')
    expect(keys.repeat('a', 1900)).toBe(false);
    expect(keys.repeat('d', 1900)).toBe(true);
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
        if (channel !== 'chatrooms.668.v2') return;
        ws.send(
          JSON.stringify({
            event: 'App\\Events\\ChatMessageEvent',
            channel,
            data: JSON.stringify({
              id: 'msg-1',
              content: 'gg [emote:1:KEKW]',
              created_at: '2026-10-11T18:30:00+00:00',
              sender: { id: 9, username: 'fan', slug: 'fan', identity: { color: '#00FF00', badges: [{ type: 'vip', text: 'VIP' }] } },
            }),
          }),
        );
        ws.send(JSON.stringify({ event: 'App\\Events\\MessageDeletedEvent', data: '{"id":"e1","message":{"id":"msg-1"}}', channel }));
      });
    });

    const account = makeAccount({ options: { slug: 'chan', chatroomId: 668 } });
    const out: ChatSourceItem[] = [];
    for await (const item of kickChat({ ctx, account, slug: 'chan', signal: ctl.signal, pusherUrl: url })) {
      out.push(item);
      if (out.length === 2) ctl.abort();
    }
    // No channel id known: no channel_<id> subscription.
    expect(subscribed).toEqual([
      { auth: '', channel: 'chatrooms.668.v2' },
      { auth: '', channel: 'chatroom_668' },
    ]);
    expect(out).toEqual([
      {
        id: 'msg-1',
        platformMessageId: 'msg-1',
        kind: 'message',
        text: 'gg KEKW',
        fragments: [
          { type: 'text', text: 'gg ' },
          { type: 'emote', text: 'KEKW', image: 'https://files.kick.com/emotes/1/fullsize' },
        ],
        ts: '2026-10-11T18:30:00.000Z',
        author: { name: 'fan', color: '#00FF00', badges: ['VIP'], id: '9', login: 'fan' },
      },
      { kind: 'message-deleted', platformMessageId: 'msg-1' },
    ]);
  });

  it('also listens for gifts and channel events, drops repeats, and survives a refused extra channel', async () => {
    const subscribed: string[] = [];
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ event: 'pusher:connection_established', data: '{"socket_id":"1.2"}' }));
      const send = (event: string, channel: string, data: unknown) => ws.send(JSON.stringify({ event, channel, data: JSON.stringify(data) }));
      ws.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as { event: string; data: { channel: string } };
        if (frame.event !== 'pusher:subscribe') return;
        const channel = frame.data.channel;
        subscribed.push(channel);
        if (channel === 'channel_4242') {
          // Kick refused this one: the chat must go on.
          ws.send(JSON.stringify({ event: 'pusher:subscription_error', channel, data: { type: 'AuthError', status: 401 } }));
          return;
        }
        if (channel === 'chatroom_668') {
          const gift = { gifter_username: 'g', gifted_usernames: ['a', 'b'], gifted_total: 4, correlation_id: 'c1' };
          send('GiftedSubscriptionsEvent', channel, gift);
          send('GiftedSubscriptionsEvent', channel, { ...gift, gifted_usernames: ['c', 'd'] }); // second chunk
          send('App\\Events\\GiftedSubscriptionsEvent', 'chatrooms.668.v2', gift); // same gift, other channel
          send('App\\Events\\SubscriptionEvent', 'chatrooms.668.v2', { username: 'sub1', months: 2 });
          send('App\\Events\\ChannelSubscriptionEvent', 'channel_4242', { username: 'sub1', user_ids: [5] }); // repeat
          send('App\\Events\\ChatroomClearEvent', 'chatrooms.668.v2', { id: 'x' });
        }
      });
    });

    const account = makeAccount({ options: { slug: 'chan', chatroomId: 668, channelId: 4242 } });
    const out: ChatSourceItem[] = [];
    for await (const item of kickChat({ ctx, account, slug: 'chan', signal: ctl.signal, pusherUrl: url })) {
      out.push(item);
      if (isChatModeration(item) && item.kind === 'cleared') ctl.abort();
    }
    expect(subscribed).toEqual(['chatrooms.668.v2', 'chatroom_668', 'channel_4242']);
    expect(out.map((i) => (isChatModeration(i) ? i.kind : `${i.author.name}: ${i.text}`))).toEqual([
      'g: gifted 4 subs',
      'sub1: subscribed for 2 months',
      'cleared',
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
