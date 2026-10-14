// End to end: real driver parsers -> ChatHub (normalization) -> EventBus -> EventHub envelopes.
// The other alert tests start from a ChatMessage that already carries `alert`; this one proves the
// alert survives the hub, which is the only path from a chat source to the bus.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Destination } from '../../../shared/types.js';
import { createChatHub } from '../chat/chat-hub.js';
import { EventBus } from '../events.js';
import { GIFTED_SUBS_EVENT, parseKickChatEvent } from '../platforms/kick/chat.js';
import { ircToChat, parseIrcLine } from '../platforms/twitch/irc.js';
import type { ChatSourceItem } from '../platforms/types.js';
import { toChatMessage } from '../platforms/youtube/chat.js';
import type { ScopedSecrets } from '../services.js';
import { EventHub } from './event-hub.js';
import { dest, platformInfo, session, silentLog } from './test-helpers.js';
import type { ApiAlert, ApiChatMessage, Envelope } from './types.js';

const secrets: ScopedSecrets = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  getJson: async () => null,
  setJson: async () => {},
};

let bus: EventBus;
let parent: AbortController;
let eventHub: EventHub;
let events: Envelope[];
const destinations: Destination[] = [
  dest('tw', { name: 'Twitch' }),
  dest('yt', { name: 'YouTube', platform: 'youtube' }),
  dest('ki', { name: 'Kick', platform: 'kick' }),
];

beforeEach(() => {
  bus = new EventBus();
  parent = new AbortController();
  events = [];
  eventHub = new EventHub({
    bus,
    log: silentLog,
    state: () => session(),
    destinations: () => destinations,
    destination: (id) => destinations.find((d) => d.id === id) ?? null,
    platformInfo,
  });
  eventHub.subscribe((e) => events.push(e));
});

afterEach(() => {
  parent.abort();
  eventHub.close();
});

/** Runs the items through a real ChatHub attached like a live destination's chat. */
async function throughHub(destinationId: string, platform: 'twitch' | 'youtube' | 'kick', items: (ChatSourceItem | null)[]): Promise<void> {
  const hub = createChatHub({ bus, log: silentLog, secrets });
  const list = items.filter((i): i is ChatSourceItem => i !== null);
  expect(list).toHaveLength(items.length);
  hub.attach(
    destinationId,
    platform,
    async function* (signal) {
      yield* list;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
    parent.signal,
  );
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
}

function alertsOf(): Envelope<ApiAlert>[] {
  return events.filter((e) => e.type.startsWith('alert.')) as Envelope<ApiAlert>[];
}

describe('driver alerts reach the external API', () => {
  it('Twitch resub USERNOTICE -> chat.message, then alert.subscription', async () => {
    const line =
      '@display-name=ronni;login=ronni;user-id=7;msg-id=resub;id=x1;msg-param-cumulative-months=6;msg-param-sub-plan=2000;' +
      'system-msg=ronni\\shas\\ssubscribed\\sfor\\s6\\smonths! :tmi.twitch.tv USERNOTICE #dallas :Great stream';
    await throughHub('tw', 'twitch', [ircToChat(parseIrcLine(line)!)]);

    expect(events.map((e) => e.type)).toEqual(['chat.message', 'alert.subscription']);
    const [chat, alert] = events as [Envelope<ApiChatMessage>, Envelope<ApiAlert>];
    expect(chat.data.kind).toBe('event');
    expect(alert.data).toMatchObject({
      kind: 'subscription',
      user: { id: 'twitch:7', name: 'ronni' },
      amount: { unit: 'months', value: 6 },
      tier: '2000',
      message: { text: 'Great stream' },
      platform: 'twitch',
      destinationId: 'tw',
      messageId: chat.data.id,
    });
  });

  it('YouTube Super Chat keeps its exact decimal amount', async () => {
    const item = toChatMessage({
      id: 'LCC.sc1',
      snippet: {
        type: 'superChatEvent',
        publishedAt: '2026-10-17T03:10:00Z',
        superChatDetails: { amountMicros: '5000000', currency: 'USD', amountDisplayString: '$5.00', userComment: 'play the remix!', tier: 2 },
      },
      authorDetails: { channelId: 'UCx9', displayName: 'Night Owl', profileImageUrl: 'https://yt3.ggpht.com/a.jpg' },
    });
    await throughHub('yt', 'youtube', [item]);

    const [alert] = alertsOf();
    expect(alert?.type).toBe('alert.superchat');
    expect(alert?.data).toMatchObject({
      kind: 'superchat',
      user: { id: 'youtube:UCx9', name: 'Night Owl', avatar: 'https://yt3.ggpht.com/a.jpg' },
      amount: { unit: 'currency', value: '5.00', currency: 'USD' },
      message: { text: 'play the remix!' },
      messageId: 'youtube:LCC.sc1',
    });
  });

  it('Kick gifted subscriptions -> alert.gift with recipients', async () => {
    const item = parseKickChatEvent(GIFTED_SUBS_EVENT, { gifter_username: 'Fan', gifted_usernames: ['a', 'b'], gifted_total: 2 });
    await throughHub('ki', 'kick', [item]);

    const [alert] = alertsOf();
    expect(alert?.type).toBe('alert.gift');
    expect(alert?.data).toMatchObject({
      user: { id: 'kick:name:Fan', name: 'Fan' },
      amount: { unit: 'count', value: 2 },
      gift: { recipients: ['a', 'b'], total: 2 },
      platform: 'kick',
      destinationId: 'ki',
    });
  });

  it('a plain chat message produces no alert', async () => {
    const line = '@display-name=Ann;user-id=9;id=m1 :ann!ann@ann.tmi.twitch.tv PRIVMSG #dallas :hello';
    await throughHub('tw', 'twitch', [ircToChat(parseIrcLine(line)!)]);
    expect(events.map((e) => e.type)).toEqual(['chat.message']);
  });
});
