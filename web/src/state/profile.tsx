// Current streaming profile + every profile's live summary, for the whole app.
//
// - The current profile lives in the URL (`?profile=<id>`, kept on every in-app link by the router),
//   so links and tabs are stable; without it the last profile used in this browser is the default.
// - The list comes from GET /api/profiles at login, then from the live socket ('hello' and 'profiles'
//   messages, pushed by LiveProvider through `apply`).
// Pure logic is in profiles.ts.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ProfileSummary } from '@shared/types';
import { DEFAULT_PROFILE_ID } from '@shared/types';
import { api } from '../api';
import { navigate, setQuery, useRoute } from '../router';
import { useAuth } from './auth';
import { reconnectDelay } from './live-store';
import {
  findProfile,
  pathWithProfile,
  PROFILE_QUERY,
  profileQueryValue,
  readStoredProfile,
  resolveProfileId,
  sortProfiles,
  storeProfile,
} from './profiles';

export interface ProfileContextValue {
  /** Every profile with its live situation (default first); null until loaded. */
  profiles: ProfileSummary[] | null;
  /** The profile on screen: every profile-scoped call and the live socket use it. */
  profileId: string;
  /** Its summary (null while the list is loading or failed to load). */
  current: ProfileSummary | null;
  /** The list loaded (or failed to load, then the URL/remembered id is used as is). */
  ready: boolean;
  /** Switch profile (remembered in this browser). `to` = also go to this app path. */
  select: (id: string, to?: string) => void;
  /** Re-fetch the list (after creating, renaming or deleting a profile). */
  refresh: () => Promise<void>;
  /** Replace the list with a pushed one (live socket). */
  apply: (profiles: readonly ProfileSummary[]) => void;
}

const noopAsync = async () => undefined;

/** Outside a provider (static renders, tests): the default profile, nothing loaded. */
export const STATIC_PROFILE_CONTEXT: ProfileContextValue = {
  profiles: null,
  profileId: DEFAULT_PROFILE_ID,
  current: null,
  ready: true,
  select: () => undefined,
  refresh: noopAsync,
  apply: () => undefined,
};

export const ProfileContext = createContext<ProfileContextValue>(STATIC_PROFILE_CONTEXT);

export function ProfileProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const route = useRoute();
  const requested = useMemo(() => new URLSearchParams(route.search).get(PROFILE_QUERY), [route.search]);
  const [profiles, setProfiles] = useState<ProfileSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [stored, setStored] = useState<string | null>(() => readStoredProfile());
  const loadSeq = useRef(0);

  const apply = useCallback((list: readonly ProfileSummary[]) => {
    loadSeq.current++; // a pushed list is newer than any REST answer still in flight
    setProfiles(sortProfiles(list));
    setFailed(false);
  }, []);

  const refresh = useCallback(async () => {
    const seq = ++loadSeq.current;
    const res = await api.profiles();
    if (seq === loadSeq.current && Array.isArray(res?.profiles)) {
      setProfiles(sortProfiles(res.profiles));
      setFailed(false);
    }
  }, []);

  // Load at login; retry with backoff until a list arrives (REST or the live socket).
  useEffect(() => {
    if (!userId) {
      loadSeq.current++;
      setProfiles(null);
      setFailed(false);
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const load = () => {
      const seq = ++loadSeq.current;
      api.profiles().then(
        (res) => {
          if (!active || seq !== loadSeq.current) return;
          setProfiles(sortProfiles(Array.isArray(res?.profiles) ? res.profiles : []));
          setFailed(false);
        },
        () => {
          if (!active) return;
          // Use the URL/remembered profile meanwhile, so the app doesn't wait forever.
          if (seq === loadSeq.current) setFailed(true);
          timer = setTimeout(() => {
            if (active && seq === loadSeq.current) load();
          }, reconnectDelay(attempt++));
        },
      );
    };
    load();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [userId]);

  const profileId = resolveProfileId({ requested, stored, profiles });
  const current = findProfile(profiles, profileId);

  // Keep the URL and the remembered profile in line with what is shown (unknown/removed ids are
  // replaced, a missing parameter is added once there is more than one profile).
  useEffect(() => {
    if (!userId || !profiles) return;
    const want = profileQueryValue(profileId, profiles);
    if ((requested ?? null) !== want) setQuery({ [PROFILE_QUERY]: want }, { replace: true });
    if (stored !== profileId) {
      storeProfile(profileId);
      setStored(profileId);
    }
  }, [userId, profiles, profileId, requested, stored]);

  const select = useCallback((id: string, to?: string) => {
    storeProfile(id);
    setStored(id);
    const here = typeof location === 'undefined' ? '/' : location.pathname + location.search;
    navigate(pathWithProfile(to ?? here, id));
  }, []);

  const value = useMemo<ProfileContextValue>(
    () => ({ profiles, profileId, current, ready: profiles !== null || failed || !userId, select, refresh, apply }),
    [profiles, profileId, current, failed, userId, select, refresh, apply],
  );

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfileContext(): ProfileContextValue {
  return useContext(ProfileContext);
}

/** Every profile with its live situation (null until loaded). */
export const useProfiles = (): ProfileSummary[] | null => useProfileContext().profiles;
/** The current profile's id. */
export const useProfileId = (): string => useProfileContext().profileId;
/** The current profile's summary (null while loading). */
export const useCurrentProfile = (): ProfileSummary | null => useProfileContext().current;
