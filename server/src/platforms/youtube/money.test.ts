import { describe, expect, it } from 'vitest';
import { currencyDigits, microsToDecimal, moneyAmount } from './money.js';

describe('currencyDigits', () => {
  it('uses the ISO 4217 minor units, 2 when unknown', () => {
    expect(currencyDigits('USD')).toBe(2);
    expect(currencyDigits('JPY')).toBe(0);
    expect(currencyDigits('KWD')).toBe(3);
    expect(currencyDigits('not a currency')).toBe(2);
  });
});

describe('microsToDecimal', () => {
  it('converts exactly, on the digits (no floating point)', () => {
    expect(microsToDecimal('5000000', 'USD')).toBe('5.00');
    expect(microsToDecimal('1990000', 'EUR')).toBe('1.99');
    expect(microsToDecimal('500000000', 'JPY')).toBe('500');
    expect(microsToDecimal('1500000', 'KWD')).toBe('1.500');
    expect(microsToDecimal('990000', 'USD')).toBe('0.99');
    expect(microsToDecimal('0', 'USD')).toBe('0.00');
    // Precision beyond the minor units is kept rather than rounded.
    expect(microsToDecimal('1234567', 'USD')).toBe('1.234567');
    // 0.1 + 0.2 style float errors can't happen, and huge amounts stay exact.
    expect(microsToDecimal('300000', 'USD')).toBe('0.30');
    expect(microsToDecimal('123456789012345678000000', 'USD')).toBe('123456789012345678.00');
    expect(microsToDecimal(' 0005000000 ', 'USD')).toBe('5.00');
  });

  it('accepts safe integer numbers and rejects malformed values', () => {
    expect(microsToDecimal(2_500_000, 'USD')).toBe('2.50');
    expect(microsToDecimal(-1, 'USD')).toBeNull();
    expect(microsToDecimal(1.5, 'USD')).toBeNull();
    expect(microsToDecimal('1e6', 'USD')).toBeNull();
    expect(microsToDecimal('', 'USD')).toBeNull();
    expect(microsToDecimal(undefined, 'USD')).toBeNull();
    expect(microsToDecimal(null, 'USD')).toBeNull();
  });
});

describe('moneyAmount', () => {
  it('builds a ChatAlert currency amount', () => {
    expect(moneyAmount('5000000', 'usd')).toEqual({ unit: 'currency', value: '5.00', currency: 'USD' });
    expect(moneyAmount('5000000', 'US')).toBeNull();
    expect(moneyAmount('5000000', undefined)).toBeNull();
    expect(moneyAmount(undefined, 'USD')).toBeNull();
  });
});
