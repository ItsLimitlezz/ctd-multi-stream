// Top-bar profile switcher ("● DPRTMNT ▾") and the "2 live: Miami or Bust · DPRTMNT" pill.

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ProfileSummary } from '@shared/types';
import { Link, useRoute } from '../router';
import { useAuth } from '../state/auth';
import { useProfileContext } from '../state/profile';
import { liveProfilesText, otherProfileLive, profileLabel, showLiveSummary } from '../state/profiles';
import { CheckIcon, ChevronDownIcon, FlaskIcon, LayersIcon } from './icons';
import { PROFILE_STATUS_UI, ProfileDot } from './ProfileBadge';
import { StatusDot } from './StatusDot';
import { cx } from './utils';

export interface ProfileSwitcherViewProps {
  profiles: readonly ProfileSummary[] | null;
  currentId: string;
  canManage: boolean;
  onSelect: (id: string) => void;
  /** Start opened (static renders / tests). */
  defaultOpen?: boolean;
}

/** Profile switcher wired to the app's profile state. */
export function ProfileSwitcher() {
  const { profiles, profileId, select } = useProfileContext();
  const { isAdmin } = useAuth();
  return <ProfileSwitcherView profiles={profiles} currentId={profileId} canManage={isAdmin} onSelect={(id) => select(id)} />;
}

export function ProfileSwitcherView({ profiles, currentId, canManage, onSelect, defaultOpen = false }: ProfileSwitcherViewProps) {
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const route = useRoute();
  const current = profiles?.find((p) => p.id === currentId) ?? null;
  const name = current?.name ?? profileLabel(currentId, profiles);
  const liveText = liveProfilesText(profiles);
  const othersLive = otherProfileLive(profiles, currentId);

  useEffect(() => setOpen(false), [route.pathname, currentId]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        ref.current?.querySelector<HTMLButtonElement>('.profile-button')?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    // Focus the current profile so arrow keys start from it.
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]');
    const checked = menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    (checked ?? items?.[0])?.focus();
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next = 0;
    if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'ArrowDown') next = at === -1 ? 0 : (at + 1) % items.length;
    else if (e.key === 'ArrowUp') next = at <= 0 ? items.length - 1 : at - 1;
    items[next]?.focus();
  };

  const buttonTitle = [`Streaming profile: ${name}`, liveText].filter(Boolean).join(' — ');
  return (
    <div className="profile-switcher" ref={ref}>
      <button
        type="button"
        className="profile-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Streaming profile: ${name}${liveText ? `. ${liveText}` : ''}. Switch profile`}
        title={buttonTitle}
        onClick={() => setOpen((o) => !o)}
      >
        <ProfileDot profile={current} />
        <span className="profile-button-name truncate">{name}</span>
        {othersLive && <StatusDot tone="live" pulse className="profile-button-live" />}
        <ChevronDownIcon width={14} height={14} className="profile-button-chevron" />
      </button>
      {open && (
        <div className="menu profile-menu" role="menu" aria-label="Streaming profiles" ref={menuRef} onKeyDown={onMenuKey}>
          <div className="menu-header">
            <div className="small muted">Streaming profile</div>
            {liveText && <div className="profile-menu-live">{liveText}</div>}
          </div>
          {profiles === null ? (
            <div className="menu-note muted small">Loading profiles…</div>
          ) : (
            profiles.map((p) => {
              const ui = PROFILE_STATUS_UI[p.status] ?? PROFILE_STATUS_UI.offline;
              const selected = p.id === currentId;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  aria-label={`${p.name}${p.status !== 'offline' ? ` (${ui.label.toLowerCase()})` : ''}${p.testMode ? ', test mode' : ''}`}
                  className={cx('menu-item profile-menu-item', selected && 'is-current')}
                  onClick={() => {
                    setOpen(false);
                    if (!selected) onSelect(p.id);
                  }}
                >
                  <ProfileDot profile={p} />
                  <span className="profile-menu-name truncate">{p.name}</span>
                  {p.testMode && (
                    <span className="profile-menu-test" title="Test mode">
                      <FlaskIcon width={14} height={14} />
                      <span className="sr-only">test mode</span>
                    </span>
                  )}
                  {p.status !== 'offline' && (
                    <span className={cx('profile-menu-status', `tone-${ui.tone}`)}>
                      <StatusDot tone={ui.tone} pulse={ui.pulse} />
                      {ui.label}
                    </span>
                  )}
                  <span className="profile-menu-check">{selected && <CheckIcon width={16} height={16} />}</span>
                </button>
              );
            })
          )}
          {canManage && (
            <Link to="/profiles" className="menu-item profile-menu-manage" role="menuitem" onClick={() => setOpen(false)}>
              <LayersIcon width={16} height={16} />
              Manage profiles
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * "2 live: Miami or Bust · DPRTMNT" (or "DPRTMNT is live" when the live one isn't on screen), so a
 * profile streaming in the background is never missed. Admins can click through to the profiles.
 */
export function LiveProfilesIndicator() {
  const { profiles, profileId } = useProfileContext();
  const { isAdmin } = useAuth();
  if (!showLiveSummary(profiles, profileId)) return null;
  const text = liveProfilesText(profiles);
  const count = (profiles ?? []).filter((p) => p.status === 'live').length;
  const content = (
    <>
      <StatusDot tone="live" pulse />
      <span className="live-summary-short">
        {count}
        <span className="live-summary-word"> live</span>
      </span>
      <span className="live-summary-long truncate">{text}</span>
    </>
  );
  return isAdmin ? (
    <Link to="/profiles" className="live-pill is-live live-summary" title={text} aria-label={text}>
      {content}
    </Link>
  ) : (
    <span className="live-pill is-live live-summary" title={text} role="status" aria-label={text}>
      {content}
    </span>
  );
}
