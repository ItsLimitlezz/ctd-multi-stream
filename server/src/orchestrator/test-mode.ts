// Session test mode (SessionState.testMode, settings key 'session.testMode'): every destination
// streams with its platform's private/test setting (Twitch bandwidth test, YouTube private,
// Instagram Practice, Facebook Page "only me"); destinations without one are skipped, so nothing
// goes out publicly. The orchestrator never prepares a skipped destination.
//
// Channel titles stay untouched too: a platform whose title belongs to the channel rather than to
// one live (it implements setTitleOffline: Twitch, Kick) shows that title publicly even while the
// stream itself is a private test. In test mode the orchestrator never edits it offline, prepares
// those destinations with an empty title (drivers leave the channel title as it is for an empty
// title, the same as when no title was ever set) and skips their live title changes.

import type { Account, Destination } from '../../../shared/types.js';
import type { PlatformDriver } from '../platforms/types.js';

export const TEST_MODE_SETTING = 'session.testMode';

/** TitleResult reason for a channel title that test mode leaves alone. */
export const TEST_MODE_CHANNEL_TITLE =
  'Test mode leaves the channel title unchanged; the title is applied when you go live outside test mode';

/** Whether the platform's title belongs to the channel (public whatever the stream's privacy). */
export function hasChannelTitle(driver: PlatformDriver): boolean {
  return typeof driver.setTitleOffline === 'function';
}

/** Whether this destination can stream privately while test mode is on (throws what the driver throws). */
export function supportsTestMode(driver: PlatformDriver, dest: Destination, account: Account | null): boolean {
  const own = driver.supportsTestMode?.(dest, account);
  if (typeof own === 'boolean') return own;
  return driver.info.testMode?.supported === true;
}

/** Destination message (phase 'disabled') for a destination skipped by test mode. */
export function testModeSkipMessage(platformName: string): string {
  return `Skipped — ${platformName} has no test mode`;
}

/** Why the test-mode switch can't change right now (HTTP 409, code 'session_live'). */
export function testModeLockedError(): Error & { statusCode: number; code: string } {
  return Object.assign(new Error('Test mode can only be changed while no session is running. End the stream first.'), {
    statusCode: 409,
    code: 'session_live',
  });
}
