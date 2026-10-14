import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isChatModeration, type ChatMessageInput, type ChatSourceItem } from '../types.js';
import { API_BASE, STREAM_API_BASE, YouTubeClient, type LiveChatMessage } from './api.js';
import {
  createChatSource,
  DEFAULT_CHAT_TIMINGS,
  JsonStreamParser,
  pollGapMs,
  SseJsonParser,
  toChatItem,
  toChatMessage,
  toModeration,
  type ChatTimings,
} from './chat.js';
import { FetchStub, googleError, json, silentLog, streamingResponse } from './test-utils.js';

const LIST = `${API_BASE}/liveChat/messages`;
const STREAM = `${STREAM_API_BASE}/liveChat/messages/stream`;

const FAST: Partial<ChatTimings> = {
  minGapMs: 5,
  quietGapMs: 10,
  streamIdleMs: 300,
  quotaWaitMs: 50,
  rateLimitWaitMs: 5,
  pauseMs: 50,
  skewMs: 1_000,
};

const SINCE = Date.parse('2026-10-11T12:00:00.000Z');

function text(id: string, message: string, publishedAt: string, author: Partial<NonNullable<LiveChatMessage['authorDetails']>> = {}): LiveChatMessage {
  return {
    id,
    snippet: { type: 'textMessageEvent', publishedAt, displayMessage: message, textMessageDetails: { messageText: message } },
    authorDetails: { displayName: 'Viewer', profileImageUrl: 'https://yt3.ggpht.com/a.jpg', ...author },
  };
}

let stub: FetchStub;
const client = new YouTubeClient({ token: async () => 'tok', refresh: async () => 'tok2' });

beforeEach(() => {
  stub = new FetchStub();
  vi.stubGlobal('fetch', stub.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Collect `n` items from the source (or until `ms` elapse), then abort it. */
async function take(
  source: (signal: AbortSignal) => AsyncIterable<ChatSourceItem>,
  n: number,
  ms = 3_000,
): Promise<ChatMessageInput[]> {
  return (await takeItems(source, n, ms)) as ChatMessageInput[];
}

async function takeItems(
  source: (signal: AbortSignal) => AsyncIterable<ChatSourceItem>,
  n: number,
  ms = 3_000,
): Promise<ChatSourceItem[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const out: ChatSourceItem[] = [];
  try {
    for await (const m of source(ctl.signal)) {
      out.push(m);
      if (out.length >= n) break;
    }
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
  return out;
}

function source(liveChatId: string | null = 'chat-1') {
  return createChatSource({ client, since: SINCE, log: silentLog, timings: FAST, liveChatId: async () => liveChatId });
}

// ---------------------------------------------------------------------------

describe('toChatMessage', () => {
  it('maps text messages with author, avatar and badges', () => {
    const m = toChatMessage(
      text('m1', 'hello', '2026-10-11T12:00:05Z', { isChatOwner: true, isChatModerator: true, isChatSponsor: true, isVerified: true }),
    );
    expect(m).toEqual({
      id: 'm1',
      platformMessageId: 'm1',
      kind: 'message',
      text: 'hello',
      ts: '2026-10-11T12:00:05Z',
      author: { name: 'Viewer', avatarUrl: 'https://yt3.ggpht.com/a.jpg', badges: ['owner', 'moderator', 'member', 'verified'] },
    });
  });

  it('sets the author id from the channel id (authorDetails, else snippet.authorChannelId)', () => {
    expect(toChatMessage(text('m1', 'hi', '2026-10-11T12:00:05Z', { channelId: ' UCviewer ' }))?.author.id).toBe('UCviewer');
    const fallback = text('m2', 'hi', '2026-10-11T12:00:05Z');
    fallback.snippet!.authorChannelId = 'UCsnippet';
    expect(toChatMessage(fallback)).toMatchObject({ platformMessageId: 'm2', author: { id: 'UCsnippet' } });
    expect(toChatMessage(text('m3', 'hi', '2026-10-11T12:00:05Z'))?.author.id).toBeUndefined();
  });

  it('maps paid and membership events', () => {
    const ev = (snippet: NonNullable<LiveChatMessage['snippet']>) => toChatMessage({ id: 'e', snippet, authorDetails: { displayName: 'Fan' } });
    expect(ev({ type: 'superChatEvent', superChatDetails: { amountDisplayString: '$5.00', userComment: 'great stream' } })).toMatchObject({
      kind: 'event',
      text: 'Super Chat $5.00: great stream',
    });
    expect(ev({ type: 'superStickerEvent', superStickerDetails: { amountDisplayString: '€2.00', superStickerMetadata: { altText: 'Cat' } } })?.text).toBe(
      'Super Sticker €2.00: Cat',
    );
    expect(ev({ type: 'newSponsorEvent', newSponsorDetails: { memberLevelName: 'Gold' } })?.text).toBe('New member (Gold)');
    expect(ev({ type: 'newSponsorEvent', newSponsorDetails: { memberLevelName: 'Gold', isUpgrade: true } })?.text).toBe('Upgraded membership to Gold');
    expect(ev({ type: 'memberMilestoneChatEvent', memberMilestoneChatDetails: { memberMonth: 12, userComment: 'a year!' } })?.text).toBe(
      'Member for 12 months: a year!',
    );
    expect(ev({ type: 'membershipGiftingEvent', membershipGiftingDetails: { giftMembershipsCount: 5 } })?.text).toBe('Gifted 5 memberships');
    expect(ev({ type: 'giftEvent', giftEventDetails: { giftMetadata: { giftName: 'Rose', comboCount: 3 } } })?.text).toBe('Sent Rose ×3');
  });

  it('drops types we do not show and malformed items', () => {
    expect(toChatMessage({ id: 't', snippet: { type: 'tombstone' } })).toBeNull();
    expect(toChatMessage({ id: 'b', snippet: { type: 'userBannedEvent', displayMessage: 'x was banned' } })).toBeNull();
    expect(toChatMessage({ id: 'd', snippet: { type: 'messageDeletedEvent', messageDeletedDetails: { deletedMessageId: 'm1' } } })).toBeNull();
    expect(toChatMessage({ id: 'g', snippet: { type: 'giftMembershipReceivedEvent', giftMembershipReceivedDetails: { memberLevelName: 'Gold' } } })).toBeNull();
    expect(toChatMessage({ snippet: { type: 'textMessageEvent', displayMessage: 'no id' } })).toBeNull();
    expect(toChatMessage(null)).toBeNull();
    expect(toChatMessage({ id: 'n', snippet: { type: 'textMessageEvent' } })).toBeNull();
    expect(toChatMessage({ id: 'a', snippet: { type: 'textMessageEvent', displayMessage: 'hi' } })?.author).toEqual({ name: 'YouTube user' });
  });

  it('plain messages carry no alert and are not highlighted', () => {
    const m = toChatMessage(text('m1', 'hello', '2026-10-11T12:00:05Z', { channelId: 'UC1' }))!;
    expect(m.alert).toBeUndefined();
    expect(m.highlighted).toBeUndefined();
  });
});

describe('alerts', () => {
  const author = { channelId: 'UCfan', displayName: 'Fan', profileImageUrl: 'https://yt3.ggpht.com/fan.jpg' };
  const user = { id: 'UCfan', name: 'Fan', avatar: 'https://yt3.ggpht.com/fan.jpg' };
  const ev = (snippet: NonNullable<LiveChatMessage['snippet']>, a: NonNullable<LiveChatMessage['authorDetails']> = author) =>
    toChatMessage({ id: 'e1', snippet: { publishedAt: '2026-10-11T12:00:05Z', ...snippet }, authorDetails: a });

  it('Super Chat → superchat with the exact amount as a decimal string, tier and comment', () => {
    const m = ev({
      type: 'superChatEvent',
      superChatDetails: { amountMicros: '5000000', currency: 'USD', amountDisplayString: '$5.00', userComment: ' great stream ', tier: 2 },
    });
    expect(m).toEqual({
      id: 'e1',
      platformMessageId: 'e1',
      kind: 'event',
      text: 'Super Chat $5.00: great stream',
      ts: '2026-10-11T12:00:05Z',
      highlighted: true,
      author: { id: 'UCfan', name: 'Fan', avatarUrl: 'https://yt3.ggpht.com/fan.jpg' },
      alert: { kind: 'superchat', user, amount: { unit: 'currency', value: '5.00', currency: 'USD' }, tier: '2', message: { text: 'great stream' } },
    });
    // Never a float, whatever the currency's minor units are.
    expect(ev({ type: 'superChatEvent', superChatDetails: { amountMicros: '500000000', currency: 'JPY' } })?.alert?.amount).toEqual({
      unit: 'currency',
      value: '500',
      currency: 'JPY',
    });
    expect(ev({ type: 'superChatEvent', superChatDetails: { amountMicros: 1_990_000, currency: 'eur' } })?.alert?.amount).toEqual({
      unit: 'currency',
      value: '1.99',
      currency: 'EUR',
    });
  });

  it('Super Chat without a usable amount still alerts, without amount', () => {
    const m = ev({ type: 'superChatEvent', superChatDetails: { amountDisplayString: '$5.00' } });
    expect(m?.alert).toEqual({ kind: 'superchat', user });
    expect(ev({ type: 'superChatEvent', superChatDetails: { amountMicros: '-5', currency: 'USD' } })?.alert?.amount).toBeUndefined();
  });

  it('Super Sticker → superchat (the sticker alt text is not a viewer message)', () => {
    const m = ev({
      type: 'superStickerEvent',
      superStickerDetails: { amountMicros: '2000000', currency: 'EUR', amountDisplayString: '€2.00', tier: 1, superStickerMetadata: { altText: 'Cat' } },
    });
    expect(m).toMatchObject({ kind: 'event', text: 'Super Sticker €2.00: Cat', highlighted: true });
    expect(m?.alert).toEqual({ kind: 'superchat', user, amount: { unit: 'currency', value: '2.00', currency: 'EUR' }, tier: '1' });
  });

  it('new members and upgrades → membership (1 month, level as tier)', () => {
    expect(ev({ type: 'newSponsorEvent', newSponsorDetails: { memberLevelName: 'Gold' } })?.alert).toEqual({
      kind: 'membership',
      user,
      amount: { unit: 'months', value: 1 },
      tier: 'Gold',
    });
    expect(ev({ type: 'newSponsorEvent', newSponsorDetails: { isUpgrade: true } })?.alert).toEqual({
      kind: 'membership',
      user,
      amount: { unit: 'months', value: 1 },
    });
    expect(ev({ type: 'newSponsorEvent' })?.highlighted).toBeUndefined();
  });

  it('member milestones → membership with the months and the comment', () => {
    const m = ev({ type: 'memberMilestoneChatEvent', memberMilestoneChatDetails: { memberMonth: 12, memberLevelName: 'Gold', userComment: 'a year!' } });
    expect(m?.alert).toEqual({ kind: 'membership', user, amount: { unit: 'months', value: 12 }, tier: 'Gold', message: { text: 'a year!' } });
    expect(ev({ type: 'memberMilestoneChatEvent', memberMilestoneChatDetails: { memberMonth: 1.5 } })?.alert).toEqual({ kind: 'membership', user });
  });

  it('gifted memberships → gift with an integer count', () => {
    expect(ev({ type: 'membershipGiftingEvent', membershipGiftingDetails: { giftMembershipsCount: 5, giftMembershipsLevelName: 'Gold' } })?.alert).toEqual({
      kind: 'gift',
      user,
      amount: { unit: 'count', value: 5 },
      tier: 'Gold',
      gift: { total: 5 },
    });
    expect(ev({ type: 'membershipGiftingEvent' })?.alert).toMatchObject({ amount: { unit: 'count', value: 1 }, gift: { total: 1 } });
  });

  it('paid gifts (giftEvent) are plain event lines without an alert (alert.gift means gifted memberships)', () => {
    const m = ev({ type: 'giftEvent', giftEventDetails: { giftMetadata: { giftName: 'Rose', comboCount: 3 } } });
    expect(m).toMatchObject({ kind: 'event', text: 'Sent Rose ×3' });
    expect(m?.alert).toBeUndefined();
    expect(m?.highlighted).toBeUndefined();
  });

  it('anonymous authors get a name but no id', () => {
    expect(ev({ type: 'newSponsorEvent' }, {})?.alert?.user).toEqual({ name: 'YouTube user' });
  });
});

describe('moderation', () => {
  it('messageDeletedEvent → message-deleted with the deleted message id', () => {
    const item: LiveChatMessage = { id: 'x1', snippet: { type: 'messageDeletedEvent', messageDeletedDetails: { deletedMessageId: 'm1' } } };
    expect(toModeration(item)).toEqual({ kind: 'message-deleted', platformMessageId: 'm1' });
    expect(toChatItem(item)).toEqual({ kind: 'message-deleted', platformMessageId: 'm1' });
    expect(toModeration({ id: 'x2', snippet: { type: 'messageDeletedEvent' } })).toBeNull();
  });

  it('userBannedEvent (ban or timeout) → user-cleared with channel id and name', () => {
    const item: LiveChatMessage = {
      id: 'x3',
      snippet: {
        type: 'userBannedEvent',
        userBannedDetails: { banType: 'temporary', banDurationSeconds: '300', bannedUserDetails: { channelId: 'UCbad', displayName: 'Troll' } },
      },
    };
    expect(toChatItem(item)).toEqual({ kind: 'user-cleared', userId: 'UCbad', userName: 'Troll' });
    expect(toModeration({ id: 'x4', snippet: { type: 'userBannedEvent', userBannedDetails: { bannedUserDetails: { displayName: 'Troll' } } } })).toEqual({
      kind: 'user-cleared',
      userName: 'Troll',
    });
    expect(toModeration({ id: 'x5', snippet: { type: 'userBannedEvent', userBannedDetails: {} } })).toBeNull();
  });

  it('chat messages are not moderation', () => {
    const item = text('m1', 'hi', '2026-10-11T12:00:05Z');
    expect(toModeration(item)).toBeNull();
    expect(isChatModeration(toChatItem(item)!)).toBe(false);
  });
});

describe('stream parsers', () => {
  const pages = [
    { nextPageToken: 'p1', items: [{ id: 'a', snippet: { displayMessage: 'brace } and "quote" and \\ backslash [' } }] },
    { nextPageToken: 'p2', items: [] },
  ];

  it('splits a streamed JSON array however it is chunked', () => {
    const body = `)]}'\n[${JSON.stringify(pages[0], null, 2)}\n,\n${JSON.stringify(pages[1])}]`;
    for (const size of [1, 3, 7, body.length]) {
      const parser = new JsonStreamParser();
      const out: unknown[] = [];
      for (let i = 0; i < body.length; i += size) out.push(...parser.push(body.slice(i, i + size)));
      out.push(...parser.end());
      expect(out).toEqual(pages);
    }
  });

  it('accepts a bare object and rejects garbage or truncation', () => {
    expect(new JsonStreamParser().push('{"a":1}')).toEqual([{ a: 1 }]);
    expect(() => new JsonStreamParser().push('<html>')).toThrow();
    const p = new JsonStreamParser();
    p.push('[{"a":');
    expect(() => p.end()).toThrow();
  });

  it('parses server-sent events with JSON data', () => {
    const p = new SseJsonParser();
    expect(p.push('data: {"a":1}\r\n\r\ndata: {"b"')).toEqual([{ a: 1 }]);
    expect(p.push(':2}\n\n')).toEqual([{ b: 2 }]);
    expect(p.push('data: {"c":3}')).toEqual([]);
    expect(p.end()).toEqual([{ c: 3 }]);
  });
});

describe('pollGapMs', () => {
  const t = DEFAULT_CHAT_TIMINGS;
  it('never polls faster than every 8 s and honors a longer server interval', () => {
    expect(pollGapMs(1_000, 0, 1, t)).toBe(8_000);
    expect(pollGapMs(undefined, 0, 1, t)).toBe(8_000);
    expect(pollGapMs(12_000, 0, 1, t)).toBe(12_000);
  });

  it('slows down when the chat is quiet and when several chats share the quota', () => {
    expect(pollGapMs(1_000, 2, 1, t)).toBe(12_000);
    expect(pollGapMs(1_000, 50, 1, t)).toBe(20_000);
    expect(pollGapMs(1_000, 0, 2, t)).toBe(16_000);
    expect(pollGapMs(30_000, 50, 1, t)).toBe(30_000);
  });
});

describe('chat source', () => {
  it('reads the streaming endpoint, skips the backlog and resumes with the page token', async () => {
    const first = streamingResponse();
    const second = streamingResponse();
    stub.on('GET', STREAM, () => first.response, () => second.response);
    const src = source();

    const done = take(src, 3);
    first.write('[{"nextPageToken":"tok-1","items":[');
    first.write(`${JSON.stringify(text('old', 'backlog', '2026-10-11T11:00:00Z'))},`);
    first.write(`${JSON.stringify(text('m1', 'one', '2026-10-11T12:00:01Z'))}]}`);
    await new Promise((r) => setTimeout(r, 20));
    first.write(`,{"nextPageToken":"tok-2","items":[${JSON.stringify(text('m2', 'two', '2026-10-11T12:00:02Z'))}]}`);
    first.write(']');
    first.close();
    // The server closed the stream: we reconnect from tok-2.
    await vi.waitFor(() => expect(stub.callsTo('GET', STREAM)).toHaveLength(2));
    second.write(`[{"items":[${JSON.stringify(text('m3', 'three', '2026-10-11T12:00:03Z'))}]}`);
    const msgs = await done;

    expect(msgs.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    const [c1, c2] = stub.callsTo('GET', STREAM);
    expect(c1!.url.searchParams.get('liveChatId')).toBe('chat-1');
    expect(c1!.url.searchParams.getAll('part')).toEqual(['snippet', 'authorDetails']);
    expect(c1!.url.searchParams.has('pageToken')).toBe(false);
    expect(c2!.url.searchParams.get('pageToken')).toBe('tok-2');
    expect(c1!.headers.authorization).toBe('Bearer tok');
    expect(stub.callsTo('GET', LIST)).toHaveLength(0);
  });

  it('falls back to polling when the streaming endpoint is unavailable', async () => {
    stub
      .on('GET', STREAM, new Response('Not Found', { status: 404, headers: { 'content-type': 'text/html' } }))
      .on(
        'GET',
        LIST,
        json({ nextPageToken: 'n1', pollingIntervalMillis: 1, items: [text('old', 'backlog', '2026-10-11T11:00:00Z'), text('p1', 'one', '2026-10-11T12:00:01Z')] }),
        json({ nextPageToken: 'n2', pollingIntervalMillis: 1, items: [text('p2', 'two', '2026-10-11T12:00:02Z')] }),
      );
    const msgs = await take(source(), 2);
    expect(msgs.map((m) => m.text)).toEqual(['one', 'two']);
    const polls = stub.callsTo('GET', LIST);
    expect(polls[0]!.url.searchParams.get('pageToken')).toBeNull();
    expect(polls[1]!.url.searchParams.get('pageToken')).toBe('n1');
    expect(polls[0]!.url.searchParams.get('part')).toBe('snippet,authorDetails');
  });

  it('switches to polling after repeated stream failures without data', async () => {
    stub
      .on('GET', STREAM, () => new Response('{"oops"', { status: 200, headers: { 'content-type': 'application/json' } }))
      .on('GET', LIST, json({ nextPageToken: 'n1', items: [text('p1', 'polled', '2026-10-11T12:00:01Z')] }));
    const src = source();
    // Each failed run throws (the ChatHub restarts the source); state survives restarts.
    for (let i = 0; i < 2; i++) await expect(take(src, 1)).rejects.toThrow();
    const msgs = await take(src, 1);
    expect(msgs.map((m) => m.text)).toEqual(['polled']);
    expect(stub.callsTo('GET', STREAM)).toHaveLength(3);
  });

  it('stops requesting once the chat ended', async () => {
    stub.on('GET', STREAM, googleError(403, 'liveChatEnded'));
    const msgs = await take(source(), 1, 150);
    expect(msgs).toEqual([]);
    expect(stub.calls).toHaveLength(1);
  });

  it('yields moderation and alerts in stream order, skipping backlog moderation', async () => {
    const at = (s: string) => `2026-10-11T12:00:0${s}Z`;
    const items: LiveChatMessage[] = [
      { id: 'old-del', snippet: { type: 'messageDeletedEvent', publishedAt: '2026-10-11T11:00:00Z', messageDeletedDetails: { deletedMessageId: 'x' } } },
      text('m1', 'one', at('1'), { channelId: 'UCa' }),
      { id: 'd1', snippet: { type: 'messageDeletedEvent', publishedAt: at('2'), messageDeletedDetails: { deletedMessageId: 'm1' } } },
      {
        id: 'sc',
        snippet: { type: 'superChatEvent', publishedAt: at('3'), superChatDetails: { amountMicros: '10000000', currency: 'GBP', amountDisplayString: '£10.00' } },
        authorDetails: { channelId: 'UCb', displayName: 'Bee' },
      },
      { id: 'b1', snippet: { type: 'userBannedEvent', publishedAt: at('4'), userBannedDetails: { bannedUserDetails: { channelId: 'UCa', displayName: 'Viewer' } } } },
    ];
    stub.on('GET', STREAM, json([{ nextPageToken: 't1', items }]));
    const out = await takeItems(source(), 4);
    expect(out.map((i) => (isChatModeration(i) ? i.kind : `${i.kind}:${i.platformMessageId}`))).toEqual([
      'message:m1',
      'message-deleted',
      'event:sc',
      'user-cleared',
    ]);
    expect(out[1]).toEqual({ kind: 'message-deleted', platformMessageId: 'm1' });
    expect((out[2] as ChatMessageInput).alert).toMatchObject({ kind: 'superchat', user: { id: 'UCb' }, amount: { value: '10.00', currency: 'GBP' } });
    expect(out[3]).toEqual({ kind: 'user-cleared', userId: 'UCa', userName: 'Viewer' });
  });

  it('stops on a chatEndedEvent', async () => {
    stub.on('GET', STREAM, json([{ items: [text('m1', 'bye', '2026-10-11T12:00:01Z'), { id: 'end', snippet: { type: 'chatEndedEvent' } }] }]));
    const msgs = await take(source(), 5, 150);
    expect(msgs.map((m) => m.id)).toEqual(['m1']);
    expect(stub.calls).toHaveLength(1);
  });

  it('waits out an exhausted quota instead of hammering the API', async () => {
    stub
      .on('GET', STREAM, new Response('nope', { status: 404 }))
      .on('GET', LIST, googleError(403, 'quotaExceeded'), json({ items: [text('p1', 'back', '2026-10-11T12:00:01Z')] }));
    const started = Date.now();
    const msgs = await take(source(), 1);
    expect(msgs.map((m) => m.text)).toEqual(['back']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(stub.callsTo('GET', LIST)).toHaveLength(2);
  });

  it('pauses while chat is turned off and checks again later', async () => {
    stub
      .on('GET', STREAM, new Response('nope', { status: 404 }))
      .on('GET', LIST, googleError(403, 'liveChatDisabled'), json({ items: [text('p1', 'on again', '2026-10-11T12:00:01Z')] }));
    const started = Date.now();
    const msgs = await take(source(), 1);
    expect(msgs.map((m) => m.text)).toEqual(['on again']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it('drops a rejected page token on a stream that worked before, without replaying older messages', async () => {
    const first = streamingResponse();
    const third = streamingResponse();
    stub.on('GET', STREAM, () => first.response, googleError(400, 'invalidPageToken'), () => third.response);
    const done = take(source(), 2);
    first.write(`[{"nextPageToken":"t1","items":[${JSON.stringify(text('m1', 'one', '2026-10-11T12:00:05Z'))}]}]`);
    first.close();
    await vi.waitFor(() => expect(stub.callsTo('GET', STREAM)).toHaveLength(3));
    third.write(`[{"items":[${JSON.stringify(text('m0', 'older', '2026-10-11T12:00:02Z'))},${JSON.stringify(text('m2', 'two', '2026-10-11T12:00:06Z'))}]}`);
    expect((await done).map((m) => m.id)).toEqual(['m1', 'm2']);
    const calls = stub.callsTo('GET', STREAM);
    expect(calls[1]!.url.searchParams.get('pageToken')).toBe('t1');
    expect(calls[2]!.url.searchParams.has('pageToken')).toBe(false);
    expect(stub.callsTo('GET', LIST)).toHaveLength(0);
  });

  it('idles when the broadcast has no chat, and ends promptly on abort', async () => {
    const msgs = await take(source(null), 1, 50);
    expect(msgs).toEqual([]);
    expect(stub.calls).toHaveLength(0);

    const live = streamingResponse();
    stub.on('GET', STREAM, () => live.response);
    const ctl = new AbortController();
    const it = source()(ctl.signal)[Symbol.asyncIterator]();
    const next = it.next();
    await vi.waitFor(() => expect(stub.calls).toHaveLength(1));
    ctl.abort();
    await expect(next).resolves.toMatchObject({ done: true });
  });

  it('reconnects a stream that went idle, resuming from the page token', async () => {
    const first = streamingResponse();
    const second = streamingResponse();
    stub.on('GET', STREAM, () => first.response, () => second.response);
    const done = take(source(), 2);
    first.write(`[{"nextPageToken":"t1","items":[${JSON.stringify(text('m1', 'one', '2026-10-11T12:00:01Z'))}]}`);
    // No more data: the idle timeout (300 ms) reconnects.
    await vi.waitFor(() => expect(stub.callsTo('GET', STREAM)).toHaveLength(2), { timeout: 2_000 });
    expect(stub.callsTo('GET', STREAM)[1]!.url.searchParams.get('pageToken')).toBe('t1');
    second.write(`[{"items":[${JSON.stringify(text('m2', 'two', '2026-10-11T12:00:02Z'))}]}`);
    expect((await done).map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});
