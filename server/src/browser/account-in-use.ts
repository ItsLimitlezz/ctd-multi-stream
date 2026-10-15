// Whether a running live holds an account's browser context (so the login viewer must not take
// over its page or close the context).

import { DEFAULT_PROFILE_ID, type DestinationPhase } from '../../../shared/types.js';
import type { AppServices, Orchestrator } from '../services.js';

/** Runner phases in which a driver may be using the account's browser page. */
const ACTIVE_PHASES: ReadonlySet<DestinationPhase> = new Set(['preparing', 'connecting', 'confirming', 'live', 'retrying', 'recovering', 'ending']);

/** Message shown when a login/browser action is refused because the account is live. */
export const ACCOUNT_LIVE_MESSAGE = 'This account is live right now. Stop the live before logging in again.';

/**
 * True while a destination runner using `accountId` is preparing, live or ending. Looks at the
 * account's own profile first (its destinations live there), then at the other profiles, so a
 * destination linked across profiles can never be missed.
 */
export function accountInUse(services: Pick<AppServices, 'orchestrators' | 'repos'>, accountId: string): boolean {
  let own: string = DEFAULT_PROFILE_ID;
  try {
    own = services.repos.accounts.get(accountId)?.profileId ?? DEFAULT_PROFILE_ID;
  } catch {
    // Unknown profile: every orchestrator is checked below anyway.
  }
  const all = services.orchestrators.all();
  const ordered: Orchestrator[] = [...all.filter((o) => o.profileId === own), ...all.filter((o) => o.profileId !== own)];
  for (const orch of ordered) {
    for (const state of orch.state().destinations) {
      if (!ACTIVE_PHASES.has(state.phase)) continue;
      if (services.repos.destinations.get(state.destinationId)?.accountId === accountId) return true;
    }
  }
  return false;
}
