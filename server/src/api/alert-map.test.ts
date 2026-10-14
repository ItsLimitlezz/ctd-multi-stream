import { describe, expect, it } from 'vitest';
import type { ChatAlert, ChatMessage } from '../../../shared/types.js';
import { alertAmount, alertEventData } from './alert-map.js';

const TS = '2026-10-17T03:10:00.000Z';

function msg(alert: unknown, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'twitch:abc',
    platform: 'twitch',
    destinationId: 'd1',
    author: { name: 'DJFan', id: '144552210' },
    text: 'DJFan subscribed for 12 months',
    ts: TS,
    kind: 'event',
    alert: alert as ChatAlert,
    ...over,
  };
}

describe('alertEventData', () => {
  it('maps a subscription: type alert.<kind>, prefixed user id, source fields, epoch ts', () => {
    const out = alertEventData(
      msg({ kind: 'subscription', user: { id: '144552210', name: 'DJFan' }, amount: { unit: 'months', value: 12 }, tier: '1000', message: { text: 'love the sets' } }),
    );
    expect(out).toEqual({
      type: 'alert.subscription',
      data: {
        kind: 'subscription',
        user: { id: 'twitch:144552210', name: 'DJFan' },
        amount: { unit: 'months', value: 12 },
        tier: '1000',
        message: { text: 'love the sets' },
        platform: 'twitch',
        destinationId: 'd1',
        messageId: 'twitch:abc',
        ts: Date.parse(TS),
      },
    });
    // Field order follows the ChatAlert shape, source fields last.
    expect(Object.keys(out!.data)).toEqual(['kind', 'user', 'amount', 'tier', 'message', 'platform', 'destinationId', 'messageId', 'ts']);
  });

  it('no alert, or an unknown kind: nothing', () => {
    expect(alertEventData(msg(undefined))).toBeNull();
    expect(alertEventData(msg(null))).toBeNull();
    expect(alertEventData(msg('subscription'))).toBeNull();
    expect(alertEventData(msg({ kind: 'donation', user: { name: 'x' } }))).toBeNull();
    expect(alertEventData(msg({ user: { name: 'x' } }))).toBeNull();
  });

  it('super chat money stays an exact decimal string with an upper-case ISO currency', () => {
    const out = alertEventData(
      msg({ kind: 'superchat', user: { id: 'UCabc', name: 'Fan', avatar: 'https://yt3.ggpht.com/a.jpg' }, amount: { unit: 'currency', value: '5.00', currency: 'usd' } }, { platform: 'youtube', id: 'youtube:m1' }),
    );
    expect(out?.type).toBe('alert.superchat');
    expect(out?.data.amount).toEqual({ unit: 'currency', value: '5.00', currency: 'USD' });
    expect(out?.data.user).toEqual({ id: 'youtube:UCabc', name: 'Fan', avatar: 'https://yt3.ggpht.com/a.jpg' });
  });

  it('gift: anonymous gifter has no id; recipients cleaned and bounded; total an integer', () => {
    const recipients = Array.from({ length: 150 }, (_, i) => `viewer${i}`);
    const out = alertEventData(
      msg({ kind: 'gift', user: { id: '999', name: '', anonymous: true }, amount: { unit: 'count', value: 5 }, gift: { recipients: ['a‮b', '', 7, ...recipients], total: 42 } }),
    );
    expect(out?.data.user).toEqual({ name: 'Anonymous', anonymous: true });
    expect(out?.data.gift?.recipients?.[0]).toBe('ab'); // bidi override removed
    expect(out?.data.gift?.recipients).toHaveLength(100);
    expect(out?.data.gift?.total).toBe(42);
    // Empty gift info is left out, not sent as {}.
    expect(alertEventData(msg({ kind: 'gift', user: { name: 'x' }, gift: { recipients: [], total: -1 } }))?.data).not.toHaveProperty('gift');
    expect(alertEventData(msg({ kind: 'gift', user: { name: 'x' }, gift: null }))?.data).not.toHaveProperty('gift');
  });

  it('falls back to the chat author for the user name; name-only users get the name id form', () => {
    const out = alertEventData(msg({ kind: 'raid', user: {}, amount: { unit: 'viewers', value: 31 } }, { author: { name: 'Raider' } }));
    expect(out?.data.user).toEqual({ id: 'twitch:name:Raider', name: 'Raider' });
    expect(out?.data.amount).toEqual({ unit: 'viewers', value: 31 });
    const numeric = alertEventData(msg({ kind: 'follow', user: { id: 12345, name: 'N' } }));
    expect(numeric?.data.user.id).toBe('twitch:12345');
  });

  it('drops unsafe or malformed optional parts instead of passing them on', () => {
    const out = alertEventData(
      msg({
        kind: 'cheer',
        user: { name: 'B\nob', avatar: 'javascript:alert(1)' },
        amount: { unit: 'bits', value: 100.5 },
        tier: { evil: true },
        message: { text: '   ' },
      }),
    );
    expect(out?.data).toEqual({
      kind: 'cheer',
      user: { id: 'twitch:name:B ob', name: 'B ob' },
      platform: 'twitch',
      destinationId: 'd1',
      messageId: 'twitch:abc',
      ts: Date.parse(TS),
    });
  });

  it('an unparsable message time falls back to now', () => {
    const before = Date.now();
    const out = alertEventData(msg({ kind: 'follow', user: { name: 'x' } }, { ts: 'not a date' }));
    expect(out!.data.ts).toBeGreaterThanOrEqual(before);
  });
});

describe('alertAmount', () => {
  it.each<[unknown, unknown]>([
    [{ unit: 'months', value: 3 }, { unit: 'months', value: 3 }],
    [{ unit: 'count', value: 0 }, { unit: 'count', value: 0 }],
    [{ unit: 'kicks', value: 500 }, { unit: 'kicks', value: 500 }],
    [{ unit: 'bits', value: -1 }, undefined],
    [{ unit: 'bits', value: 1.5 }, undefined],
    [{ unit: 'bits', value: '100' }, undefined],
    [{ unit: 'bits', value: Number.MAX_SAFE_INTEGER + 2 }, undefined],
    [{ unit: 'seconds', value: 3 }, undefined],
    [{ unit: 'currency', value: '0.99', currency: 'EUR' }, { unit: 'currency', value: '0.99', currency: 'EUR' }],
    [{ unit: 'currency', value: ' 1000 ', currency: ' jpy ' }, { unit: 'currency', value: '1000', currency: 'JPY' }],
    [{ unit: 'currency', value: 5, currency: 'USD' }, undefined], // a float/number is never guessed at
    [{ unit: 'currency', value: '5,00', currency: 'EUR' }, undefined],
    [{ unit: 'currency', value: '1e3', currency: 'USD' }, undefined],
    [{ unit: 'currency', value: '-5.00', currency: 'USD' }, undefined],
    [{ unit: 'currency', value: '5.00', currency: 'US' }, undefined],
    [{ unit: 'currency', value: '5.00', currency: 'US$' }, undefined],
    [{ unit: 'currency', value: '5.00' }, undefined],
    [null, undefined],
    [[1], undefined],
  ])('alertAmount(%j) = %j', (input, expected) => {
    expect(alertAmount(input)).toEqual(expected);
  });
});
