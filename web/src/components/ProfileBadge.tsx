// Small profile visuals: colour dot, status badge and the "Profile: <name>" tag shown on every
// profile-scoped page.

import type { Profile, ProfileSummary, SessionStatus } from '@shared/types';
import { useProfileContext } from '../state/profile';
import { profileColor, profileLabel } from '../state/profiles';
import { Badge } from './Badge';
import { cx, type Tone } from './utils';

export const PROFILE_STATUS_UI: Record<SessionStatus, { label: string; tone: Tone; pulse: boolean }> = {
  offline: { label: 'Offline', tone: 'neutral', pulse: false },
  starting: { label: 'Starting', tone: 'warn', pulse: true },
  live: { label: 'LIVE', tone: 'live', pulse: true },
  stopping: { label: 'Stopping', tone: 'warn', pulse: true },
};

/** The profile's accent colour as a dot (a hollow ring when it has none). Decorative. */
export function ProfileDot({ profile, className }: { profile: Pick<Profile, 'color'> | null; className?: string }) {
  const color = profileColor(profile);
  return (
    <span
      className={cx('profile-dot', !color && 'is-empty', className)}
      style={color ? { background: color } : undefined}
      aria-hidden="true"
    />
  );
}

/** Session status of a profile ("LIVE", "Starting", …); nothing while offline unless `showOffline`. */
export function ProfileStatusBadge({ profile, showOffline = false }: { profile: Pick<ProfileSummary, 'status' | 'testMode'>; showOffline?: boolean }) {
  const ui = PROFILE_STATUS_UI[profile.status] ?? PROFILE_STATUS_UI.offline;
  return (
    <>
      {(profile.status !== 'offline' || showOffline) && (
        <Badge tone={ui.tone} dot pulse={ui.pulse}>
          {ui.label}
        </Badge>
      )}
      {profile.testMode && <Badge tone="warn">Test mode</Badge>}
    </>
  );
}

/**
 * "Profile: ● DPRTMNT" — which profile a page is showing. Uses the current profile unless one is
 * given (static renders / tests).
 */
export function ProfileTag({ profile, className }: { profile?: Pick<Profile, 'id' | 'name' | 'color'> | null; className?: string }) {
  const ctx = useProfileContext();
  const p = profile === undefined ? ctx.current : profile;
  const name = p?.name ?? profileLabel(ctx.profileId, ctx.profiles);
  return (
    <span className={cx('profile-tag', className)} title="Streaming profile shown on this page (switch it in the top bar)">
      <ProfileDot profile={p ?? null} />
      <span className="profile-tag-label">Profile:</span>
      <strong className="truncate">{name}</strong>
    </span>
  );
}
