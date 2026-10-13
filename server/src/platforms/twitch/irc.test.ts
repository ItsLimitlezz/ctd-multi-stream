import { describe, expect, it } from 'vitest';
import {
  ircToChat,
  nickFromPrefix,
  parseBadges,
  parseIrcLine,
  parseSentTs,
  stripAction,
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

describe('ircToChat', () => {
  it('maps a PRIVMSG with tags', () => {
    const msg = parseIrcLine(
      '@badges=moderator/1,subscriber/6;color=#1E90FF;display-name=Some\\sName;id=abc-123;tmi-sent-ts=1700000000000 ' +
        ':somename!somename@somename.tmi.twitch.tv PRIVMSG #chan :hi chat',
    )!;
    expect(ircToChat(msg)).toEqual({
      author: { name: 'Some Name', color: '#1E90FF', badges: ['moderator', 'subscriber'] },
      text: 'hi chat',
      kind: 'message',
      id: 'abc-123',
      ts: new Date(1700000000000).toISOString(),
    });
  });

  it('falls back to the prefix nick and ignores bad colors', () => {
    const msg = parseIrcLine('@color=red;display-name= :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #c :yo')!;
    const chat = ircToChat(msg)!;
    expect(chat.author).toEqual({ name: 'viewer' });
    expect(chat.id).toBeUndefined();
    expect(chat.ts).toBeUndefined();
  });

  it('unwraps ACTION and drops empty messages', () => {
    const me = parseIrcLine(':a!a@a.tmi.twitch.tv PRIVMSG #c :\u0001ACTION jumps\u0001')!;
    expect(ircToChat(me)!.text).toBe('jumps');
    expect(ircToChat(parseIrcLine(':a!a@a.tmi.twitch.tv PRIVMSG #c :   ')!)).toBeNull();
  });

  it('maps a raid USERNOTICE to an event with system-msg', () => {
    const msg = parseIrcLine(
      '@badges=turbo/1;color=#9ACD32;display-name=TestChannel;id=3d830f12;login=testchannel;msg-id=raid;' +
        'msg-param-viewerCount=15;system-msg=15\\sraiders\\sfrom\\sTestChannel\\shave\\sjoined!;tmi-sent-ts=1507246572675 ' +
        ':tmi.twitch.tv USERNOTICE #othertestchannel',
    )!;
    expect(ircToChat(msg)).toMatchObject({
      author: { name: 'TestChannel', color: '#9ACD32', badges: ['turbo'] },
      text: '15 raiders from TestChannel have joined!',
      kind: 'event',
      id: '3d830f12',
    });
  });

  it('appends the user message of a resub', () => {
    const msg = parseIrcLine(
      '@display-name=ronni;login=ronni;msg-id=resub;id=x1;system-msg=ronni\\shas\\ssubscribed\\sfor\\s6\\smonths! ' +
        ':tmi.twitch.tv USERNOTICE #dallas :Great stream -- keep it up!',
    )!;
    expect(ircToChat(msg)!.text).toBe('ronni has subscribed for 6 months! — Great stream -- keep it up!');
  });

  it('uses the login when display-name is missing on USERNOTICE', () => {
    const msg = parseIrcLine('@login=someone;msg-id=announcement :tmi.twitch.tv USERNOTICE #c :Hello everyone')!;
    expect(ircToChat(msg)).toMatchObject({ author: { name: 'someone' }, text: 'Hello everyone', kind: 'event' });
  });

  it('ignores other commands', () => {
    expect(ircToChat(parseIrcLine('PING :tmi.twitch.tv')!)).toBeNull();
    expect(ircToChat(parseIrcLine('@room-id=1 :tmi.twitch.tv ROOMSTATE #c')!)).toBeNull();
    expect(ircToChat(parseIrcLine('@login=x;target-msg-id=y :tmi.twitch.tv CLEARMSG #c :bye')!)).toBeNull();
  });
});
