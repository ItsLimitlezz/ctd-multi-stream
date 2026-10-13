import { describe, expect, it } from 'vitest';
import {
  CHAT_MESSAGE_EVENT,
  chatroomChannel,
  GIFTED_SUBS_EVENT,
  HOST_EVENT,
  parseBadges,
  parseKickChatEvent,
  renderEmotes,
  SUBSCRIPTION_EVENT,
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

describe('renderEmotes', () => {
  it('renders [emote:id:name] as :name:', () => {
    expect(renderEmotes('hi [emote:1:KEKW]!')).toBe('hi :KEKW:!');
    expect(renderEmotes('[emote:1:a][emote:2:b]')).toBe(':a::b:');
    expect(renderEmotes('[emote:1:]')).toBe('');
    expect(renderEmotes('no emotes [emote:x:y]')).toBe('no emotes [emote:x:y]');
  });
});

describe('parseBadges', () => {
  it('uses the badge text, falls back to the type, dedupes and ignores junk', () => {
    expect(parseBadges(message.sender.identity.badges)).toEqual(['Moderator', 'Subscriber', 'og']);
    expect(parseBadges([{ text: 'VIP' }, { text: 'VIP' }, null, 7, {}])).toEqual(['VIP']);
    expect(parseBadges('nope')).toEqual([]);
  });
});

describe('parseKickChatEvent', () => {
  it('parses a chat message (data as JSON string, like Pusher sends it)', () => {
    const msg = parseKickChatEvent(CHAT_MESSAGE_EVENT, JSON.stringify(message));
    expect(msg).toEqual({
      id: message.id,
      kind: 'message',
      text: 'hello :KEKW: world :beeBobble:',
      ts: '2026-10-11T18:30:00.000Z',
      author: { name: 'Viewer_One', color: '#E9113C', badges: ['Moderator', 'Subscriber', 'og'] },
    });
  });

  it('parses an already-decoded object and tolerates missing identity / timestamp', () => {
    const msg = parseKickChatEvent(CHAT_MESSAGE_EVENT, { id: 5, content: 'yo', sender: { slug: 'someone' } });
    expect(msg).toEqual({ id: '5', kind: 'message', text: 'yo', author: { name: 'someone' } });
  });

  it('keeps replies as plain messages', () => {
    const reply = { ...message, type: 'reply', content: 'agreed', metadata: { original_sender: { id: 1, username: 'x' } } };
    expect(parseKickChatEvent(CHAT_MESSAGE_EVENT, reply)?.text).toBe('agreed');
  });

  it('drops messages without visible text and malformed data', () => {
    expect(parseKickChatEvent(CHAT_MESSAGE_EVENT, { ...message, content: '   ' })).toBeNull();
    expect(parseKickChatEvent(CHAT_MESSAGE_EVENT, { ...message, content: '[emote:1:]' })).toBeNull();
    expect(parseKickChatEvent(CHAT_MESSAGE_EVENT, '{not json')).toBeNull();
    expect(parseKickChatEvent(CHAT_MESSAGE_EVENT, null)).toBeNull();
    expect(parseKickChatEvent(CHAT_MESSAGE_EVENT, [1, 2])).toBeNull();
  });

  it('turns subscriptions, gifts and hosts into events', () => {
    expect(parseKickChatEvent(SUBSCRIPTION_EVENT, { chatroom_id: 1, username: 'sub1', months: 4 })).toEqual({
      author: { name: 'sub1' },
      text: 'subscribed for 4 months',
      kind: 'event',
    });
    expect(parseKickChatEvent(SUBSCRIPTION_EVENT, { username: 'sub2', months: 1 })?.text).toBe('subscribed');
    expect(parseKickChatEvent(GIFTED_SUBS_EVENT, { gifter_username: 'g', gifted_usernames: ['a', 'b'] })).toEqual({
      author: { name: 'g' },
      text: 'gifted 2 subs',
      kind: 'event',
    });
    expect(parseKickChatEvent(GIFTED_SUBS_EVENT, { gifted_usernames: ['a'] })?.text).toBe('gifted 1 sub');
    expect(parseKickChatEvent(GIFTED_SUBS_EVENT, { gifter_username: 'g', gifted_usernames: [] })).toBeNull();
    expect(parseKickChatEvent(HOST_EVENT, { host_username: 'h', number_viewers: 12, optional_message: 'gg' })?.text).toBe(
      'is hosting with 12 viewers: gg',
    );
    expect(parseKickChatEvent(SUBSCRIPTION_EVENT, { months: 3 })).toBeNull();
  });

  it('ignores other events', () => {
    expect(parseKickChatEvent('App\\Events\\MessageDeletedEvent', { id: 'x' })).toBeNull();
    expect(parseKickChatEvent('App\\Events\\UserBannedEvent', { user: { username: 'x' } })).toBeNull();
  });

  it('names the chatroom channel', () => {
    expect(chatroomChannel(668)).toBe('chatrooms.668.v2');
  });
});
