import { describe, expect, it } from 'vitest';
import { normalizeChatMessage } from '../../chat/normalize.js';
import { isChatModeration, type ChatMessageInput } from '../types.js';
import {
  CHANNEL_SUBSCRIPTION_EVENT,
  channelEventsChannel,
  CHAT_MESSAGE_EVENT,
  CHATROOM_CLEAR_EVENT,
  chatroomChannel,
  contentFragments,
  eventName,
  GIFTED_SUBS_EVENT,
  giftsChannel,
  HOST_EVENT,
  kickEventKey,
  KICKS_GIFTED_EVENT,
  MESSAGE_DELETED_EVENT,
  parseBadges,
  parseKickChatEvent,
  renderEmotes,
  SUBSCRIPTION_EVENT,
  USER_BANNED_EVENT,
} from './chat.js';

const message = {
  id: '6b2a7f3e-1111-4c1e-9a55-0f2b8e8c1a01',
  chatroom_id: 668,
  content: 'hello [emote:37226:KEKW] world [emote:39251:beeBobble]',
  type: 'message',
  created_at: '2026-10-11T18:30:00+00:00',
  sender: {
    id: 42,
    username: 'Viewer_One',
    slug: 'viewer-one',
    identity: {
      color: '#E9113C',
      badges: [
        { type: 'moderator', text: 'Moderator' },
        { type: 'subscriber', text: 'Subscriber', count: 3 },
        { type: 'og' },
      ],
    },
  },
};

const emote = (id: string, name: string) => ({ type: 'emote', text: name, image: `https://files.kick.com/emotes/${id}/fullsize` });

/** parseKickChatEvent for an event that must yield a chat message (not moderation). */
function chat(event: string, data: unknown): ChatMessageInput | null {
  const item = parseKickChatEvent(event, data);
  if (item && isChatModeration(item)) throw new Error(`expected a message, got ${item.kind}`);
  return item;
}

describe('emotes', () => {
  it('renders [emote:id:name] by name', () => {
    expect(renderEmotes('hi [emote:1:KEKW]!')).toBe('hi KEKW!');
    expect(renderEmotes('[emote:1:a] [emote:2:b]')).toBe('a b');
    expect(renderEmotes('[emote:1:]')).toBe('');
    expect(renderEmotes('no emotes [emote:x:y]')).toBe('no emotes [emote:x:y]');
  });

  it('builds emote fragments whose text joins to the rendered text', () => {
    const content = 'gg [emote:1:KEKW][emote:2:Pog] [emote:3:] end';
    const frags = contentFragments(content);
    expect(frags).toEqual([{ type: 'text', text: 'gg ' }, emote('1', 'KEKW'), emote('2', 'Pog'), { type: 'text', text: '  end' }]);
    expect(frags.map((f) => f.text).join('')).toBe(renderEmotes(content));
  });
});

describe('parseBadges', () => {
  it('uses the badge text, falls back to the type, dedupes and ignores junk', () => {
    expect(parseBadges(message.sender.identity.badges)).toEqual(['Moderator', 'Subscriber', 'og']);
    expect(parseBadges([{ text: 'VIP' }, { text: 'VIP' }, null, 7, {}])).toEqual(['VIP']);
    expect(parseBadges('nope')).toEqual([]);
  });
});

describe('parseKickChatEvent: chat messages', () => {
  it('parses a chat message (data as JSON string, like Pusher sends it) with ids and emote fragments', () => {
    expect(chat(CHAT_MESSAGE_EVENT, JSON.stringify(message))).toEqual({
      id: message.id,
      platformMessageId: message.id,
      kind: 'message',
      text: 'hello KEKW world beeBobble',
      fragments: [{ type: 'text', text: 'hello ' }, emote('37226', 'KEKW'), { type: 'text', text: ' world ' }, emote('39251', 'beeBobble')],
      ts: '2026-10-11T18:30:00.000Z',
      author: { name: 'Viewer_One', color: '#E9113C', badges: ['Moderator', 'Subscriber', 'og'], id: '42', login: 'viewer-one' },
    });
  });

  it('parses an already-decoded object and tolerates missing identity / timestamp', () => {
    expect(chat(CHAT_MESSAGE_EVENT, { id: 5, content: 'yo', sender: { slug: 'someone' } })).toEqual({
      id: '5',
      platformMessageId: '5',
      kind: 'message',
      text: 'yo',
      author: { name: 'someone', login: 'someone' },
    });
  });

  it('trims around emotes and keeps fragments consistent', () => {
    const m = chat(CHAT_MESSAGE_EVENT, { ...message, content: '  [emote:1:KEKW]  ' })!;
    expect(m.text).toBe('KEKW');
    expect(m.fragments).toEqual([emote('1', 'KEKW')]);
  });

  it('keeps reply context', () => {
    const reply = {
      ...message,
      type: 'reply',
      content: 'agreed',
      metadata: { original_sender: { id: '1', username: 'x' }, original_message: { id: 'orig-1', content: 'first [emote:1:KEKW]' } },
    };
    const m = chat(CHAT_MESSAGE_EVENT, reply)!;
    expect(m.text).toBe('agreed');
    expect(m.reply).toEqual({ messageId: 'orig-1', userName: 'x', text: 'first KEKW' });
    expect(chat(CHAT_MESSAGE_EVENT, { ...message, metadata: null })!.reply).toBeUndefined();
  });

  it('marks /me messages as actions', () => {
    const m = chat(CHAT_MESSAGE_EVENT, { ...message, content: '/me dances [emote:1:KEKW]' })!;
    expect(m.action).toBe(true);
    expect(m.text).toBe('dances KEKW');
    expect(m.fragments?.map((f) => f.text).join('')).toBe(m.text);
    expect(chat(CHAT_MESSAGE_EVENT, message)!.action).toBeUndefined();
  });

  it('drops messages without visible text and malformed data', () => {
    expect(parseKickChatEvent(CHAT_MESSAGE_EVENT, { ...message, content: '   ' })).toBeNull();
    expect(parseKickChatEvent(CHAT_MESSAGE_EVENT, { ...message, content: '[emote:1:]' })).toBeNull();
    expect(parseKickChatEvent(CHAT_MESSAGE_EVENT, '{not json')).toBeNull();
    expect(parseKickChatEvent(CHAT_MESSAGE_EVENT, null)).toBeNull();
    expect(parseKickChatEvent(CHAT_MESSAGE_EVENT, [1, 2])).toBeNull();
  });

  it('accepts event names with or without the Laravel namespace', () => {
    expect(eventName('App\\Events\\ChatMessageEvent')).toBe('ChatMessageEvent');
    expect(eventName('KicksGifted')).toBe('KicksGifted');
    expect(chat('ChatMessageEvent', message)?.text).toBe('hello KEKW world beeBobble');
  });
});

describe('parseKickChatEvent: alerts', () => {
  it('subscriptions', () => {
    expect(chat(SUBSCRIPTION_EVENT, { chatroom_id: 1, username: 'sub1', months: 4 })).toEqual({
      author: { name: 'sub1' },
      text: 'subscribed for 4 months',
      kind: 'event',
      alert: { kind: 'subscription', user: { name: 'sub1' }, amount: { unit: 'months', value: 4 } },
    });
    expect(chat(SUBSCRIPTION_EVENT, { username: 'sub2', months: 1 })?.text).toBe('subscribed');
    expect(chat(SUBSCRIPTION_EVENT, { username: 'sub3' })?.alert?.amount).toEqual({ unit: 'months', value: 1 });
    expect(parseKickChatEvent(SUBSCRIPTION_EVENT, { months: 3 })).toBeNull();
  });

  it('channel subscriptions when they name the subscriber', () => {
    expect(chat(CHANNEL_SUBSCRIPTION_EVENT, { user_ids: [894845], channel_id: 603664, username: 'Paid' })).toEqual({
      author: { name: 'Paid', id: '894845' },
      text: 'subscribed',
      kind: 'event',
      alert: { kind: 'subscription', user: { id: '894845', name: 'Paid' }, amount: { unit: 'months', value: 1 } },
    });
    expect(parseKickChatEvent(CHANNEL_SUBSCRIPTION_EVENT, { user_ids: [894845], channel_id: 603664 })).toBeNull();
  });

  it('gifted subs (named and anonymous, chunked totals)', () => {
    expect(chat(GIFTED_SUBS_EVENT, { gifter_username: 'g', gifted_usernames: ['a', 'b'] })).toEqual({
      author: { name: 'g' },
      text: 'gifted 2 subs',
      kind: 'event',
      alert: { kind: 'gift', user: { name: 'g' }, amount: { unit: 'count', value: 2 }, gift: { recipients: ['a', 'b'], total: 2 } },
    });
    const anon = chat('GiftedSubscriptionsEvent', { gifted_usernames: ['a'] })!;
    expect(anon.text).toBe('gifted 1 sub');
    expect(anon.author.name).toBe('Anonymous');
    expect(anon.alert?.user).toEqual({ name: 'Anonymous', anonymous: true });
    const chunk = chat(GIFTED_SUBS_EVENT, { gifter_username: 'big', gifted_usernames: ['a', 'b'], gifted_total: 50, correlation_id: 'c1' })!;
    expect(chunk.text).toBe('gifted 50 subs');
    expect(chunk.alert?.gift).toEqual({ recipients: ['a', 'b'], total: 50 });
    expect(parseKickChatEvent(GIFTED_SUBS_EVENT, { gifter_username: 'g', gifted_usernames: [] })).toBeNull();
  });

  it('hosts become raids', () => {
    expect(chat(HOST_EVENT, { host_username: 'h', number_viewers: 12, optional_message: 'gg' })).toEqual({
      author: { name: 'h' },
      text: 'is hosting with 12 viewers: gg',
      kind: 'event',
      alert: { kind: 'raid', user: { name: 'h' }, amount: { unit: 'viewers', value: 12 }, message: { text: 'gg' } },
    });
    expect(chat(HOST_EVENT, { host_username: 'h' })?.alert).toEqual({ kind: 'raid', user: { name: 'h' } });
    expect(parseKickChatEvent(HOST_EVENT, {})).toBeNull();
  });

  it('Kicks: a highlighted event line without an alert (alert.kicks is reserved in docs/API.md)', () => {
    const line = chat(KICKS_GIFTED_EVENT, {
      message: 'love the set',
      sender: { id: 7, username: 'Fan', username_color: '#fff' },
      gift: { gift_id: 'hell_yeah', name: 'Hell Yeah', amount: 100, type: 'LEVEL_UP' },
    });
    expect(line).toEqual({
      author: { name: 'Fan', id: '7' },
      text: 'sent 100 Kicks (Hell Yeah): love the set',
      kind: 'event',
      highlighted: true,
    });
    expect(line).not.toHaveProperty('alert');
    expect(chat(KICKS_GIFTED_EVENT, { sender: { username: 'Fan' }, gift: { amount: 1 } })?.text).toBe('sent 1 Kick');
    expect(parseKickChatEvent(KICKS_GIFTED_EVENT, { sender: { username: 'Fan' }, gift: {} })).toBeNull();
  });
});

describe('parseKickChatEvent: moderation', () => {
  it('deleted messages (message.id, falling back to id)', () => {
    expect(parseKickChatEvent(MESSAGE_DELETED_EVENT, { id: 'evt-1', message: { id: 'msg-1' }, aiModerated: false })).toEqual({
      kind: 'message-deleted',
      platformMessageId: 'msg-1',
    });
    expect(parseKickChatEvent('MessageDeletedEvent', JSON.stringify({ id: 'msg-2' }))).toEqual({
      kind: 'message-deleted',
      platformMessageId: 'msg-2',
    });
    expect(parseKickChatEvent(MESSAGE_DELETED_EVENT, {})).toBeNull();
  });

  it('bans and timeouts clear the user', () => {
    expect(
      parseKickChatEvent(USER_BANNED_EVENT, {
        id: 'b1',
        user: { id: 42, username: 'Viewer_One', slug: 'viewer-one' },
        banned_by: { id: 1, username: 'mod', slug: 'mod' },
        permanent: false,
        duration: 10,
        expires_at: '2026-10-11T18:40:00+00:00',
      }),
    ).toEqual({ kind: 'user-cleared', userId: '42', userName: 'Viewer_One' });
    expect(parseKickChatEvent(USER_BANNED_EVENT, { user: { slug: 'only-slug' } })).toEqual({ kind: 'user-cleared', userName: 'only-slug' });
    expect(parseKickChatEvent(USER_BANNED_EVENT, { user: {} })).toBeNull();
  });

  it('cleared chat', () => {
    expect(parseKickChatEvent(CHATROOM_CLEAR_EVENT, { id: 'x' })).toEqual({ kind: 'cleared' });
  });

  it('ignores other events', () => {
    expect(parseKickChatEvent('App\\Events\\UserUnbannedEvent', { user: { username: 'x' } })).toBeNull();
    expect(parseKickChatEvent('App\\Events\\PinnedMessageCreatedEvent', { message })).toBeNull();
    expect(parseKickChatEvent('App\\Events\\LuckyUsersWhoGotGiftSubscriptionsEvent', { user_ids: [1] })).toBeNull();
  });
});

describe('kickEventKey', () => {
  it('identifies alerts that can arrive twice', () => {
    expect(kickEventKey(SUBSCRIPTION_EVENT, { username: 'Sub1' })).toBe('sub:sub1');
    expect(kickEventKey(CHANNEL_SUBSCRIPTION_EVENT, { username: 'SUB1', user_ids: [1] })).toBe('sub:sub1');
    expect(kickEventKey(CHANNEL_SUBSCRIPTION_EVENT, { user_ids: [1] })).toBeNull();
    expect(kickEventKey(GIFTED_SUBS_EVENT, { correlation_id: 'c1', gifted_usernames: ['a'] })).toBe('gift:c1');
    expect(kickEventKey(GIFTED_SUBS_EVENT, { chunk_details: { correlation_id: 'c2' } })).toBe('gift:c2');
    expect(kickEventKey(GIFTED_SUBS_EVENT, { gifter_username: 'G', gifted_usernames: ['a', 'B'] })).toBe('gift:g:a,b');
    expect(kickEventKey(HOST_EVENT, { host_username: 'H' })).toBe('host:h');
    expect(kickEventKey(KICKS_GIFTED_EVENT, { gift_transaction_id: 't1' })).toBe('kicks:t1');
    expect(kickEventKey(KICKS_GIFTED_EVENT, { gift: { amount: 1 } })).toBeNull();
    expect(kickEventKey(CHAT_MESSAGE_EVENT, message)).toBeNull();
  });
});

describe('through the ChatHub normalizer', () => {
  it('keeps ids, login and emote fragments', () => {
    const msg = normalizeChatMessage(chat(CHAT_MESSAGE_EVENT, message)!, 'kick', 'd1')!;
    expect(msg).toMatchObject({
      id: `kick:${message.id}`,
      platformMessageId: message.id,
      author: { id: '42', login: 'viewer-one', name: 'Viewer_One' },
      text: 'hello KEKW world beeBobble',
    });
    expect(msg.fragments?.map((f) => f.type)).toEqual(['text', 'emote', 'text', 'emote']);
  });
});

describe('channels', () => {
  it('names the chatroom, gifts and channel-event channels', () => {
    expect(chatroomChannel(668)).toBe('chatrooms.668.v2');
    expect(giftsChannel(668)).toBe('chatroom_668');
    expect(channelEventsChannel(4242)).toBe('channel_4242');
  });
});
