// Exact money amounts for Super Chats / Super Stickers. YouTube reports `amountMicros` (a uint64,
// serialized as a JSON string) plus an ISO 4217 `currency`; ChatAlert money is a decimal string,
// never a float, so the conversion is done on the digits.
// https://developers.google.com/youtube/v3/live/docs/liveChatMessages#snippet.superChatDetails

import type { ChatAlert } from '../../../../shared/types.js';
import type { Uint64 } from './api.js';

export type MoneyAmount = Extract<NonNullable<ChatAlert['amount']>, { unit: 'currency' }>;

const CURRENCY_RE = /^[A-Z]{3}$/;
const MICROS_DIGITS = 6;

/** The currency's minor-unit digits (USD 2, JPY 0, KWD 3), from ICU; 2 when unknown. */
export function currencyDigits(currency: string): number {
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
    return typeof digits === 'number' && Number.isInteger(digits) && digits >= 0 && digits <= MICROS_DIGITS ? digits : 2;
  } catch {
    return 2;
  }
}

/** Non-negative integer digits of a uint64 value, or null. */
function microsDigits(micros: Uint64 | null | undefined): string | null {
  if (typeof micros === 'number') return Number.isSafeInteger(micros) && micros >= 0 ? String(micros) : null;
  if (typeof micros !== 'string') return null;
  const raw = micros.trim();
  return /^\d{1,24}$/.test(raw) ? raw : null;
}

/**
 * `amountMicros` → exact decimal string with at least the currency's minor digits:
 * ("5000000", "USD") → "5.00", ("500000000", "JPY") → "500", ("1990000", "EUR") → "1.99".
 * Null when the amount is missing or malformed.
 */
export function microsToDecimal(micros: Uint64 | null | undefined, currency: string): string | null {
  const raw = microsDigits(micros);
  if (raw === null) return null;
  const padded = raw.padStart(MICROS_DIGITS + 1, '0');
  const whole = padded.slice(0, -MICROS_DIGITS).replace(/^0+(?=\d)/, '');
  let fraction = padded.slice(-MICROS_DIGITS).replace(/0+$/, '');
  const minor = currencyDigits(currency);
  if (fraction.length < minor) fraction = fraction.padEnd(minor, '0');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** ChatAlert money amount, or null when the currency or amount is missing/invalid. */
export function moneyAmount(micros: Uint64 | null | undefined, currency: string | null | undefined): MoneyAmount | null {
  const code = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  if (!CURRENCY_RE.test(code)) return null;
  const value = microsToDecimal(micros, code);
  return value === null ? null : { unit: 'currency', value, currency: code };
}
