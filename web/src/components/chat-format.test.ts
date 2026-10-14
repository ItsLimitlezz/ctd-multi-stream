import { describe, expect, it } from 'vitest';
import type { ChatAlert, ChatMessage } from '@shared/types';
import {
  ALERT_KINDS,
  ALERT_LABEL,
  alertSummary,
  chatSegments,
  formatAlertAmount,
  formatMoney,
  formatTier,
  MAX_SEGMENTS,
  messageAlert,
  safeImageUrl,
} from './chat-format';

const US = 'en-US';

describe('formatMoney', () => {
  it('formats the decimal string with the currency', () => {
    expect(formatMoney('5.00', 'USD', US)).toBe('$5.00');
    expect(formatMoney('5', 'usd', US)).toBe('$5.00');
    expect(formatMoney('1234.5', 'USD', US)).toBe('$1,234.50');
    expect(formatMoney('500', 'JPY', US)).toBe('¥500');
    expect(formatMoney('5.00', 'EUR', 'de-DE')).toBe('5,00 €');
    expect(formatMoney('20.00', 'CAD', US)).toBe('CA$20.00');
  });

  it('is exact: no float rounding, extra decimals kept', () => {
    // 0.1 + 0.2-style float issues can't happen: the string goes to Intl as a decimal.
    expect(formatMoney('0.30', 'USD', US)).toBe('$0.30');
    expect(formatMoney('12345678901234567.89', 'USD', US)).toBe('$12,345,678,901,234,567.89');
    expect(formatMoney('5.005', 'USD', US)).toBe('$5.005');
  });

  it('falls back to "<value> <currency>" for anything invalid', () => {
    expect(formatMoney('5.00', 'DOLLARS', US)).toBe('5.00 DOLLARS');
    expect(formatMoney('5,00', 'EUR', US)).toBe('5,00 EUR');
    expect(formatMoney('1e3', 'USD', US)).toBe('1e3 USD');
    expect(formatMoney('', '', US)).toBe('');
    expect(formatMoney(5 as unknown as string, 'USD', US)).toBe('USD');
  });
});

describe('alert amounts and labels', () => {
  const alert = (over: Partial<ChatAlert>): ChatAlert => ({ kind: 'subscription', user: { name: 'Ann' }, ...over });

  it('formats every amount unit', () => {
    expect(formatAlertAmount(alert({ amount: { unit: 'months', value: 12 } }), US)).toBe('12 months');
    expect(formatAlertAmount(alert({ amount: { unit: 'months', value: 1 } }), US)).toBe('1 month');
    expect(formatAlertAmount(alert({ kind: 'gift', amount: { unit: 'count', value: 5 } }), US)).toBe('5 gifts');
    expect(formatAlertAmount(alert({ kind: 'gift', amount: { unit: 'count', value: 1 } }), US)).toBe('1 gift');
    expect(formatAlertAmount(alert({ kind: 'follow', amount: { unit: 'count', value: 3 } }), US)).toBe('×3');
    expect(formatAlertAmount(alert({ kind: 'cheer', amount: { unit: 'bits', value: 1500 } }), US)).toBe('1,500 bits');
    expect(formatAlertAmount(alert({ kind: 'kicks', amount: { unit: 'kicks', value: 100 } }), US)).toBe('100 Kicks');
    expect(formatAlertAmount(alert({ kind: 'raid', amount: { unit: 'viewers', value: 42 } }), US)).toBe('42 viewers');
    expect(formatAlertAmount(alert({ kind: 'superchat', amount: { unit: 'currency', value: '10.00', currency: 'GBP' } }), US)).toBe('£10.00');
    expect(formatAlertAmount(alert({}), US)).toBeNull();
    expect(formatAlertAmount(alert({ amount: { unit: 'months', value: -1 } }), US)).toBeNull();
    expect(formatAlertAmount(alert({ amount: { unit: 'months', value: Number.NaN } }), US)).toBeNull();
    expect(formatAlertAmount(alert({ amount: { unit: 'weird', value: 2 } as unknown as ChatAlert['amount'] }), US)).toBeNull();
  });

  it('formats tiers', () => {
    expect(formatTier('1000')).toBe('Tier 1');
    expect(formatTier('3000')).toBe('Tier 3');
    expect(formatTier('Prime')).toBe('Prime');
    expect(formatTier('prime')).toBe('Prime');
    expect(formatTier('2')).toBe('Tier 2');
    expect(formatTier('Gold Member')).toBe('Gold Member');
    expect(formatTier('x'.repeat(40))).toHaveLength(30);
    expect(formatTier('  ')).toBeNull();
    expect(formatTier(3)).toBeNull();
  });

  it('summarises an alert', () => {
    expect(alertSummary(alert({ amount: { unit: 'months', value: 12 }, tier: '1000' }), US)).toBe('Subscription · 12 months · Tier 1');
    expect(alertSummary(alert({ kind: 'superchat', amount: { unit: 'currency', value: '5.00', currency: 'USD' } }), US)).toBe('Super Chat · $5.00');
    expect(alertSummary(alert({ kind: 'follow' }), US)).toBe('Follow');
    expect(ALERT_KINDS.every((k) => typeof ALERT_LABEL[k] === 'string')).toBe(true);
  });

  it('only event lines with a known kind are alerts', () => {
    const a = alert({ kind: 'raid' });
    expect(messageAlert({ kind: 'event', alert: a })).toBe(a);
    expect(messageAlert({ kind: 'message', alert: a })).toBeNull();
    expect(messageAlert({ kind: 'event' })).toBeNull();
    expect(messageAlert({ kind: 'event', alert: { ...a, kind: 'hype-train' as ChatAlert['kind'] } })).toBeNull();
  });
});

describe('chatSegments', () => {
  const EMOTE = 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0';
  const msg = (text: string, fragments?: ChatMessage['fragments']) => ({ text, fragments });

  it('splits emotes and mentions, merging neighbouring text', () => {
    const out = chatSegments(
      msg('hi Kappa @bob !', [
        { type: 'text', text: 'hi ' },
        { type: 'emote', text: 'Kappa', image: EMOTE },
        { type: 'text', text: ' ' },
        { type: 'mention', text: '@bob', userId: '7' },
        { type: 'link', text: ' ', url: 'https://x' },
        { type: 'text', text: '!' },
      ]),
    );
    expect(out).toEqual([
      { kind: 'text', text: 'hi ' },
      { kind: 'emote', text: 'Kappa', src: EMOTE },
      { kind: 'text', text: ' ' },
      { kind: 'mention', text: '@bob' },
      { kind: 'text', text: ' !' },
    ]);
  });

  it('falls back to the plain text when fragments are missing, malformed or disagree with it', () => {
    expect(chatSegments(msg('hello'))).toEqual([{ kind: 'text', text: 'hello' }]);
    expect(chatSegments(msg('hello', []))).toEqual([{ kind: 'text', text: 'hello' }]);
    expect(chatSegments(msg('hello', [{ type: 'text', text: 'bye' }]))).toEqual([{ kind: 'text', text: 'hello' }]);
    expect(chatSegments(msg('hello', [null as unknown as { type: 'text'; text: string }]))).toEqual([{ kind: 'text', text: 'hello' }]);
    const many = Array.from({ length: MAX_SEGMENTS + 1 }, () => ({ type: 'text' as const, text: 'a' }));
    expect(chatSegments(msg('a'.repeat(MAX_SEGMENTS + 1), many))).toHaveLength(1);
  });

  it('renders emotes with unsafe image URLs as text', () => {
    const text = 'Kappa';
    for (const image of ['http://example.com/e.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', undefined]) {
      expect(chatSegments(msg(text, [{ type: 'emote', text, image }]))).toEqual([{ kind: 'text', text }]);
    }
    expect(safeImageUrl(EMOTE)).toBe(EMOTE);
    expect(safeImageUrl('not a url')).toBeNull();
    expect(safeImageUrl(`https://e.example/${'a'.repeat(3000)}`)).toBeNull();
  });
});
