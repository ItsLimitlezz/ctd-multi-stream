import { describe, expect, it } from 'vitest';
import { normalizeChatMessage } from '../../chat/normalize.js';
import { isChatModeration, type ChatMessageInput } from '../types.js';
import {
  cheermoteFragments,
  emoteFragments,
  GiftBombFilter,
  ircToChat,
  ircToModeration,
  nickFromPrefix,
  parseBadges,
  parseEmotesTag,
  parseIrcLine,
  parseSentTs,
  stripAction,
  subTier,
  trimFragments,
  unescapeTagValue,
} from './irc.js';

describe('unescapeTagValue', () => {
  it('handles every IRCv3 escape', () => {
    expect(unescapeTagValue('a\\sb\\:c\\\\d\\re\\nf')).toBe('a b;c\\d\re\nf');
  });
  it('drops a trailing lone backslash and keeps unknown escapes as the char', () => {
    expect(unescapeTagValue('abc\\')).toBe('abc');
    expect(unescapeTagValue('\\x\\y')).toBe('xy');
  });
  it('returns plain values unchanged', () => {
    expect(unescapeTagValue('plain')).toBe('plain');
    expect(unescapeTagValue('')).toBe('');
  });
});

describe('parseIrcLine', () => {
  it('parses tags, prefix, command and trailing param', () => {
    const msg = parseIrcLine(
      '@badge-info=;badges=broadcaster/1,premium/1;color=#FF4500;display-name=Ronni;id=b34ccfc7;tmi-sent-ts=1642696567751 ' +
        ':ronni!ronni@ronni.tmi.twitch.tv PRIVMSG #ronni :Hello there :) everyone\r\n',
    );
    expect(msg).not.toBeNull();
    expect(msg!.command).toBe('PRIVMSG');
    expect(msg!.prefix).toBe('ronni!ronni@ronni.tmi.twitch.tv');
    expect(msg!.params).toEqual(['#ronni', 'Hello there :) everyone']);
    expect(msg!.tags['display-name']).toBe('Ronni');
    expect(msg!.tags['badge-info']).toBe('');
    expect(msg!.tags.color).toBe('#FF4500');
  });

  it('parses PING without tags or prefix', () => {
    expect(parseIrcLine('PING :tmi.twitch.tv')).toEqual({
      tags: {},
      prefix: null,
      command: 'PING',
      params: ['tmi.twitch.tv'],
    });
  });

  it('parses numerics and middle params', () => {
    const msg = parseIrcLine(':tmi.twitch.tv 001 justinfan123 :Welcome, GLHF!');
    expect(msg!.command).toBe('001');
    expect(msg!.params).toEqual(['justinfan123', 'Welcome, GLHF!']);
  });

  it('parses CAP ACK', () => {
    const msg = parseIrcLine(':tmi.twitch.tv CAP * ACK :twitch.tv/tags twitch.tv/commands');
    expect(msg!.command).toBe('CAP');
    expect(msg!.params).toEqual(['*', 'ACK', 'twitch.tv/tags twitch.tv/commands']);
  });

  it('keeps an empty trailing param', () => {
    expect(parseIrcLine(':a!a@a PRIVMSG #c :')!.params).toEqual(['#c', '']);
  });

  it('tolerates tags without values and repeated spaces', () => {
    const msg = parseIrcLine('@flag;k=v  :src   NOTICE  #c :hi');
    expect(msg!.tags).toEqual({ flag: '', k: 'v' });
    expect(msg!.command).toBe('NOTICE');
    expect(msg!.params).toEqual(['#c', 'hi']);
  });

  it('rejects empty or truncated lines', () => {
    expect(parseIrcLine('')).toBeNull();
    expect(parseIrcLine('\r\n')).toBeNull();
    expect(parseIrcLine('@onlytags')).toBeNull();
    expect(parseIrcLine(':onlyprefix')).toBeNull();
  });

  it('does not let a __proto__ tag touch the prototype', () => {
    const msg = parseIrcLine('@__proto__=x;a=b :s PRIVMSG #c :t');
    expect(msg!.tags.a).toBe('b');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('small helpers', () => {
  it('nickFromPrefix', () => {
    expect(nickFromPrefix('foo!foo@foo.tmi.twitch.tv')).toBe('foo');
    expect(nickFromPrefix('tmi.twitch.tv')).toBeNull();
    expect(nickFromPrefix(null)).toBeNull();
  });
  it('parseBadges keeps names, drops versions and duplicates', () => {
    expect(parseBadges('broadcaster/1,subscriber/12,subscriber/3000')).toEqual(['broadcaster', 'subscriber']);
    expect(parseBadges('')).toEqual([]);
    expect(parseBadges(undefined)).toEqual([]);
  });
  it('parseSentTs', () => {
    expect(parseSentTs('1642696567751')).toBe(new Date(1642696567751).toISOString());
    expect(parseSentTs('abc')).toBeUndefined();
    expect(parseSentTs('0')).toBeUndefined();
    expect(parseSentTs(undefined)).toBeUndefined();
  });
  it('stripAction unwraps /me messages', () => {
    expect(stripAction('\u0001ACTION waves hello\u0001')).toBe('waves hello');
    expect(stripAction('\u0001ACTION dances')).toBe('dances');
    expect(stripAction('normal text')).toBe('normal text');
  });
});

/** ircToChat for a line that must yield a chat message (not moderation). */
function chat(line: string): ChatMessageInput | null {
  const item = ircToChat(parseIrcLine(line)!);
  if (item && isChatModeration(item)) throw new Error(`expected a message, got ${item.kind}`);
  return item;
}

const fragText = (m: ChatMessageInput | null) => m?.fragments?.map((f) => f.text).join('');

describe('ircToChat', () => {
  it('maps a PRIVMSG with tags (ids, login, platform message id)', () => {
    expect(
      chat(
        '@badges=moderator/1,subscriber/6;color=#1E90FF;display-name=Some\\sName;id=abc-123;tmi-sent-ts=1700000000000;user-id=144552210 ' +
          ':somename!somename@somename.tmi.twitch.tv PRIVMSG #chan :hi chat',
      ),
    ).toEqual({
      author: { name: 'Some Name', color: '#1E90FF', badges: ['moderator', 'subscriber'], id: '144552210', login: 'somename' },
      text: 'hi chat',
      kind: 'message',
      id: 'abc-123',
      platformMessageId: 'abc-123',
      ts: new Date(1700000000000).toISOString(),
    });
  });

  it('falls back to the prefix nick and ignores bad colors', () => {
    const m = chat('@color=red;display-name= :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #c :yo')!;
    expect(m.author).toEqual({ name: 'viewer', login: 'viewer' });
    expect(m.id).toBeUndefined();
    expect(m.platformMessageId).toBeUndefined();
    expect(m.ts).toBeUndefined();
    expect(m.fragments).toBeUndefined();
  });

  it('unwraps ACTION (/me) and drops empty messages', () => {
    const me = chat(':a!a@a.tmi.twitch.tv PRIVMSG #c :\u0001ACTION jumps\u0001')!;
    expect(me.text).toBe('jumps');
    expect(me.action).toBe(true);
    expect(chat(':a!a@a.tmi.twitch.tv PRIVMSG #c :plain')!.action).toBeUndefined();
    expect(chat(':a!a@a.tmi.twitch.tv PRIVMSG #c :   ')).toBeNull();
  });

  it('splits emotes into fragments (Twitch documentation example)', () => {
    const m = chat('@emotes=25:0-4,12-16/1902:6-10;id=e1 :a!a@a.tmi.twitch.tv PRIVMSG #c :Kappa Keepo Kappa')!;
    const img = (id: string) => `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;
    expect(m.text).toBe('Kappa Keepo Kappa');
    expect(m.fragments).toEqual([
      { type: 'emote', text: 'Kappa', image: img('25') },
      { type: 'text', text: ' ' },
      { type: 'emote', text: 'Keepo', image: img('1902') },
      { type: 'text', text: ' ' },
      { type: 'emote', text: 'Kappa', image: img('25') },
    ]);
  });

  it('counts emote positions in code points (emoji before an emote)', () => {
    // 👋🏽 is 2 code points (4 UTF-16 units); Kappa starts at code point 3.
    const m = chat('@emotes=25:3-7 :a!a@a.tmi.twitch.tv PRIVMSG #c :👋🏽 Kappa hi')!;
    expect(m.fragments).toEqual([
      { type: 'text', text: '👋🏽 ' },
      { type: 'emote', text: 'Kappa', image: expect.stringContaining('/25/') },
      { type: 'text', text: ' hi' },
    ]);
    expect(fragText(m)).toBe(m.text);
  });

  it('keeps fragments consistent with the trimmed text, and /me emote offsets', () => {
    // Offsets start after "\x01ACTION " (one space): ' hey  Kappa  ' has Kappa at 6-10.
    const m = chat('@emotes=emotesv2_abc:6-10 :a!a@a.tmi.twitch.tv PRIVMSG #c :\u0001ACTION  hey  Kappa  \u0001')!;
    expect(m.action).toBe(true);
    expect(m.text).toBe('hey  Kappa');
    expect(m.fragments).toEqual([
      { type: 'text', text: 'hey  ' },
      { type: 'emote', text: 'Kappa', image: 'https://static-cdn.jtvnw.net/emoticons/v2/emotesv2_abc/default/dark/2.0' },
    ]);
  });

  it('ignores bad emote ranges instead of breaking the text', () => {
    for (const emotes of ['25:6-20', '25:2-6', '25:x-y', 'bad-id:0-4', '25:4-0', '25:0-4,1-3']) {
      const m = chat(`@emotes=${emotes} :a!a@a.tmi.twitch.tv PRIVMSG #c :Kappa hey`)!;
      expect(m.text).toBe('Kappa hey');
      if (m.fragments) expect(fragText(m)).toBe('Kappa hey');
    }
    // A range covering a space (an offset bug) is not an emote.
    expect(chat('@emotes=25:3-7 :a!a@a.tmi.twitch.tv PRIVMSG #c :Kappa hey')!.fragments).toBeUndefined();
  });

  it('marks highlighted and paid messages', () => {
    expect(chat('@msg-id=highlighted-message :a!a@a.tmi.twitch.tv PRIVMSG #c :look at me')!.highlighted).toBe(true);
    expect(chat('@pinned-chat-paid-amount=500;pinned-chat-paid-currency=USD :a!a@a.tmi.twitch.tv PRIVMSG #c :hype')!.highlighted).toBe(true);
    expect(chat(':a!a@a.tmi.twitch.tv PRIVMSG #c :normal')!.highlighted).toBeUndefined();
  });

  it('keeps reply context', () => {
    const m = chat(
      '@reply-parent-msg-id=p1;reply-parent-user-login=bob;reply-parent-display-name=Bob;reply-parent-msg-body=first\\smessage ' +
        ':a!a@a.tmi.twitch.tv PRIVMSG #c :@Bob agreed',
    )!;
    expect(m.reply).toEqual({ messageId: 'p1', userName: 'Bob', text: 'first message' });
  });

  it('turns a cheer into an event line with a cheer alert and cheermote fragments', () => {
    const m = chat(
      '@bits=150;display-name=DJFan;id=c1;user-id=42;emotes=25:17-21 :djfan!djfan@djfan.tmi.twitch.tv PRIVMSG #c :Cheer100 Cheer50 Kappa test1',
    )!;
    expect(m.kind).toBe('event');
    expect(m.text).toBe('DJFan cheered 150 bits — Cheer100 Cheer50 Kappa test1');
    expect(m.highlighted).toBe(true);
    expect(m.platformMessageId).toBe('c1');
    expect(m.alert).toEqual({
      kind: 'cheer',
      user: { id: '42', name: 'DJFan' },
      amount: { unit: 'bits', value: 150 },
      message: { text: 'Cheer100 Cheer50 Kappa test1' },
    });
    expect(m.fragments).toEqual([
      { type: 'text', text: 'DJFan cheered 150 bits — ' },
      { type: 'cheermote', text: 'Cheer100', amount: 100 },
      { type: 'text', text: ' ' },
      { type: 'cheermote', text: 'Cheer50', amount: 50 },
      { type: 'text', text: ' ' },
      { type: 'emote', text: 'Kappa', image: expect.stringContaining('/25/') },
      { type: 'text', text: ' test1' },
    ]);
    expect(fragText(m)).toBe(m.text);
  });

  it('cheers: custom cheermote prefixes when they add up, anonymous cheerers, 1 bit', () => {
    const custom = chat('@bits=101 :a!a@a.tmi.twitch.tv PRIVMSG #c :BibleThump100 uni1 yay')!;
    expect(custom.fragments?.filter((f) => f.type === 'cheermote').map((f) => f.text)).toEqual(['BibleThump100', 'uni1']);
    const none = chat('@bits=5 :a!a@a.tmi.twitch.tv PRIVMSG #c :nothing here2')!;
    expect(none.fragments).toBeUndefined();
    expect(none.text).toBe('a cheered 5 bits — nothing here2');
    const anon = chat('@bits=1;login=ananonymouscheerer;display-name=AnAnonymousCheerer;user-id=9 :x!x@x PRIVMSG #c :Cheer1')!;
    expect(anon.text).toBe('AnAnonymousCheerer cheered 1 bit — Cheer1');
    expect(anon.alert?.user).toEqual({ name: 'AnAnonymousCheerer', anonymous: true });
  });

  it('maps a raid USERNOTICE to an event with system-msg and a raid alert', () => {
    const m = chat(
      '@badges=turbo/1;color=#9ACD32;display-name=TestChannel;id=3d830f12;login=testchannel;msg-id=raid;user-id=1337;' +
        'msg-param-displayName=TestChannel;msg-param-login=testchannel;' +
        'msg-param-viewerCount=15;system-msg=15\\sraiders\\sfrom\\sTestChannel\\shave\\sjoined!;tmi-sent-ts=1507246572675 ' +
        ':tmi.twitch.tv USERNOTICE #othertestchannel',
    );
    expect(m).toMatchObject({
      author: { name: 'TestChannel', color: '#9ACD32', badges: ['turbo'], id: '1337', login: 'testchannel' },
      text: '15 raiders from TestChannel have joined!',
      kind: 'event',
      id: '3d830f12',
      platformMessageId: '3d830f12',
      alert: { kind: 'raid', user: { id: '1337', name: 'TestChannel' }, amount: { unit: 'viewers', value: 15 } },
    });
  });

  it('appends the user message of a resub (with its emotes) and alerts the subscription', () => {
    const m = chat(
      '@display-name=ronni;login=ronni;user-id=7;msg-id=resub;id=x1;msg-param-cumulative-months=6;msg-param-sub-plan=2000;' +
        'emotes=25:13-17;system-msg=ronni\\shas\\ssubscribed\\sfor\\s6\\smonths! ' +
        ':tmi.twitch.tv USERNOTICE #dallas :Great stream Kappa',
    )!;
    expect(m.text).toBe('ronni has subscribed for 6 months! — Great stream Kappa');
    expect(m.fragments).toEqual([
      { type: 'text', text: 'ronni has subscribed for 6 months! — Great stream ' },
      { type: 'emote', text: 'Kappa', image: expect.stringContaining('/25/') },
    ]);
    expect(m.alert).toEqual({
      kind: 'subscription',
      user: { id: '7', name: 'ronni' },
      amount: { unit: 'months', value: 6 },
      tier: '2000',
      message: { text: 'Great stream Kappa' },
    });
  });

  it('sub (Prime, first month) and gift alerts', () => {
    const sub = chat('@display-name=New;user-id=1;msg-id=sub;msg-param-sub-plan=Prime;system-msg=New\\ssubscribed\\swith\\sPrime. :tmi.twitch.tv USERNOTICE #c')!;
    expect(sub.alert).toEqual({ kind: 'subscription', user: { id: '1', name: 'New' }, amount: { unit: 'months', value: 1 }, tier: 'Prime' });

    const gift = chat(
      '@display-name=Giver;user-id=2;msg-id=subgift;msg-param-recipient-display-name=Lucky;msg-param-recipient-user-name=lucky;' +
        'msg-param-sub-plan=1000;system-msg=Giver\\sgifted\\sa\\sTier\\s1\\ssub\\sto\\sLucky! :tmi.twitch.tv USERNOTICE #c',
    )!;
    expect(gift.text).toBe('Giver gifted a Tier 1 sub to Lucky!');
    expect(gift.alert).toEqual({
      kind: 'gift',
      user: { id: '2', name: 'Giver' },
      amount: { unit: 'count', value: 1 },
      tier: '1000',
      gift: { recipients: ['Lucky'], total: 1 },
    });

    const bomb = chat(
      '@display-name=AnAnonymousGifter;login=ananonymousgifter;user-id=274598607;msg-id=submysterygift;msg-param-mass-gift-count=5;' +
        'msg-param-sub-plan=3000;system-msg=An\\sanonymous\\suser\\sis\\sgifting\\s5\\sTier\\s3\\sSubs! :tmi.twitch.tv USERNOTICE #c',
    )!;
    expect(bomb.alert).toEqual({
      kind: 'gift',
      user: { name: 'AnAnonymousGifter', anonymous: true },
      amount: { unit: 'count', value: 5 },
      tier: '3000',
      gift: { total: 5 },
    });
  });

  it('announcements are highlighted events without an alert', () => {
    const m = chat('@login=someone;msg-id=announcement :tmi.twitch.tv USERNOTICE #c :Hello everyone')!;
    expect(m).toMatchObject({ author: { name: 'someone', login: 'someone' }, text: 'Hello everyone', kind: 'event', highlighted: true });
    expect(m.alert).toBeUndefined();
  });

  it('maps CLEARMSG and CLEARCHAT to moderation', () => {
    expect(ircToChat(parseIrcLine('@login=x;target-msg-id=y;tmi-sent-ts=1 :tmi.twitch.tv CLEARMSG #c :bye')!)).toEqual({
      kind: 'message-deleted',
      platformMessageId: 'y',
    });
    expect(ircToChat(parseIrcLine('@ban-duration=600;room-id=1;target-user-id=42 :tmi.twitch.tv CLEARCHAT #c :ronni')!)).toEqual({
      kind: 'user-cleared',
      userId: '42',
      userName: 'ronni',
    });
    expect(ircToChat(parseIrcLine('@room-id=1;tmi-sent-ts=1 :tmi.twitch.tv CLEARCHAT #c')!)).toEqual({ kind: 'cleared' });
    expect(ircToChat(parseIrcLine('@room-id=1 :tmi.twitch.tv CLEARMSG #c :bye')!)).toBeNull();
  });

  it('ignores other commands', () => {
    expect(ircToChat(parseIrcLine('PING :tmi.twitch.tv')!)).toBeNull();
    expect(ircToChat(parseIrcLine('@room-id=1 :tmi.twitch.tv ROOMSTATE #c')!)).toBeNull();
    expect(ircToModeration(parseIrcLine(':a!a@a.tmi.twitch.tv PRIVMSG #c :hi')!)).toBeNull();
  });
});

describe('through the ChatHub normalizer', () => {
  it('keeps ids, action and emote/cheermote fragments', () => {
    const input = chat(
      '@bits=100;display-name=DJFan;id=c1;user-id=42;emotes=25:9-13 :djfan!djfan@djfan.tmi.twitch.tv PRIVMSG #c :Cheer100 Kappa  nice',
    )!;
    const msg = normalizeChatMessage(input, 'twitch', 'd1')!;
    expect(msg).toMatchObject({ id: 'twitch:c1', platformMessageId: 'c1', author: { id: '42', login: 'djfan' }, kind: 'event' });
    expect(msg.text).toBe('DJFan cheered 100 bits — Cheer100 Kappa nice');
    expect(msg.fragments?.map((f) => f.type)).toEqual(['text', 'cheermote', 'text', 'emote', 'text']);
    expect(msg.fragments?.map((f) => f.text).join('')).toBe(msg.text);

    const me = normalizeChatMessage(chat('@id=m2;emotes=25:0-4 :a!a@a.tmi.twitch.tv PRIVMSG #c :\u0001ACTION Kappa\u0001')!, 'twitch', 'd1')!;
    expect(me).toMatchObject({ text: 'Kappa', action: true, fragments: [{ type: 'emote', text: 'Kappa' }] });
  });
});

describe('fragment helpers', () => {
  it('parseEmotesTag sorts ranges and skips junk', () => {
    expect(parseEmotesTag('1902:6-10/25:0-4,12-16')).toEqual([
      { id: '25', start: 0, end: 4 },
      { id: '1902', start: 6, end: 10 },
      { id: '25', start: 12, end: 16 },
    ]);
    expect(parseEmotesTag('')).toEqual([]);
    expect(parseEmotesTag(':0-4/x/25:a-b')).toEqual([]);
  });

  it('emoteFragments + trimFragments always join back to the text', () => {
    const text = ' Kappa 🎉 x ';
    const frags = emoteFragments(text, parseEmotesTag('25:1-5'));
    expect(frags.map((f) => f.text).join('')).toBe(text);
    expect(trimFragments(frags).map((f) => f.text).join('')).toBe(text.trim());
    expect(trimFragments([{ type: 'text', text: '   ' }])).toEqual([]);
  });

  it('cheermoteFragments leaves the text alone when amounts do not add up', () => {
    const frags = [{ type: 'text' as const, text: 'Cheer10 hi' }];
    expect(cheermoteFragments(frags, 11)).toEqual(frags);
  });

  it('subTier', () => {
    expect(subTier('Prime')).toBe('Prime');
    expect(subTier('prime')).toBe('Prime');
    expect(subTier('3000')).toBe('3000');
    expect(subTier('4000')).toBeUndefined();
    expect(subTier(undefined)).toBeUndefined();
  });
});

describe('GiftBombFilter', () => {
  const line = (tags: string) => parseIrcLine(`@${tags} :tmi.twitch.tv USERNOTICE #c`)!;
  const gift = (extra = '') =>
    line(`display-name=G;user-id=5;msg-id=subgift;msg-param-recipient-display-name=R;system-msg=G\\sgifted${extra}`);

  it('keeps the alert on the mystery gift only, and every chat line', () => {
    const filter = new GiftBombFilter();
    const bomb = line('display-name=G;user-id=5;msg-id=submysterygift;msg-param-mass-gift-count=2;system-msg=G\\sis\\sgifting\\s2');
    const t = 1000;
    expect((filter.apply(bomb, ircToChat(bomb), t) as ChatMessageInput).alert?.amount).toEqual({ unit: 'count', value: 2 });
    for (let i = 0; i < 2; i++) {
      const out = filter.apply(gift(), ircToChat(gift()), t + i) as ChatMessageInput;
      expect(out.text).toBe('G gifted');
      expect(out.alert).toBeUndefined();
    }
    // The bomb is used up: a later direct gift alerts again.
    expect((filter.apply(gift(), ircToChat(gift()), t + 5) as ChatMessageInput).alert?.kind).toBe('gift');
  });

  it('recognises community gifts by tag, and forgets old bombs', () => {
    const filter = new GiftBombFilter();
    const tagged = gift(';msg-param-community-gift-id=123');
    expect((filter.apply(tagged, ircToChat(tagged)) as ChatMessageInput).alert).toBeUndefined();

    const bomb = line('display-name=G;user-id=5;msg-id=submysterygift;msg-param-mass-gift-count=3;system-msg=x');
    filter.apply(bomb, ircToChat(bomb), 0);
    expect((filter.apply(gift(), ircToChat(gift()), 120_000) as ChatMessageInput).alert?.kind).toBe('gift');
  });

  it('passes everything else through', () => {
    const filter = new GiftBombFilter();
    const msg = parseIrcLine(':a!a@a PRIVMSG #c :hi')!;
    const item = ircToChat(msg);
    expect(filter.apply(msg, item)).toBe(item);
    expect(filter.apply(msg, null)).toBeNull();
  });
});
