// ChatMessage.alert (internal) -> alert.<kind> envelope data (docs/API.md §5).
//
// The ChatHub already cleans alerts when it normalizes a message (chat/normalize.ts cleanAlert);
// the API re-validates with the same rules here so that a malformed one never reaches other apps:
// unknown kinds drop the alert, counts must be non-negative integers, money must be a decimal
// string with an ISO 4217 currency (a float amount is dropped, never guessed at).

import type { ChatMessage } from '../../../shared/types.js';
import { cleanAlert, cleanAlertAmount } from '../chat/normalize.js';
import { apiUserId } from './chat-map.js';
import type { ApiAlert, ApiAlertEventType } from './types.js';

export { CURRENCY_RE, DECIMAL_RE } from '../chat/normalize.js';

/** An alert amount, or undefined when malformed (see cleanAlertAmount). */
export function alertAmount(value: unknown): ApiAlert['amount'] | undefined {
  return cleanAlertAmount(value);
}

/** The alert.<kind> data for a chat message, or null when it carries no (valid) alert. */
export function alertEventData(msg: ChatMessage): { type: ApiAlertEventType; data: ApiAlert } | null {
  const a = cleanAlert(msg.alert as unknown, msg.author.name);
  if (!a) return null;

  const { name, avatar, anonymous } = a.user;
  const user: ApiAlert['user'] = {
    // An anonymous user has no id (cleanAlert drops it); others get the chat.message user.id form.
    ...(anonymous ? {} : { id: apiUserId(msg.platform, a.user.id ?? null, name) }),
    name,
    ...(avatar ? { avatar } : {}),
    ...(anonymous ? { anonymous: true } : {}),
  };
  const ts = Date.parse(msg.ts);
  const data: ApiAlert = {
    kind: a.kind,
    user,
    ...(a.amount ? { amount: a.amount } : {}),
    ...(a.tier ? { tier: a.tier } : {}),
    ...(a.message ? { message: a.message } : {}),
    ...(a.gift ? { gift: a.gift } : {}),
    platform: msg.platform,
    destinationId: msg.destinationId,
    messageId: msg.id,
    ts: Number.isFinite(ts) ? ts : Date.now(),
  };
  return { type: `alert.${a.kind}`, data };
}
