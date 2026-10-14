// Whether a running live holds an account's browser context (so the login viewer must not take
// over its page or close the context).

import type { DestinationPhase } from '../../../shared/types.js';
import type { AppServices } from '../services.js';

/** Runner phases in which a driver may be using the account's browser page. */
const ACTIVE_PHASES: ReadonlySet<DestinationPhase> = new Set(['preparing', 'connecting', 'confirming', 'live', 'retrying', 'recovering', 'ending']);

/** Message shown when a login/browser action is refused because the account is live. */
export const ACCOUNT_LIVE_MESSAGE = 'This account is live right now. Stop the live before logging in again.';

/** True while a destination runner using `accountId` is preparing, live or ending. */
export function accountInUse(services: Pick<AppServices, 'orchestrator' | 'repos'>, accountId: string): boolean {
  for (const state of services.orchestrator.state().destinations) {
    if (!ACTIVE_PHASES.has(state.phase)) continue;
    if (services.repos.destinations.get(state.destinationId)?.accountId === accountId) return true;
  }
  return false;
}
