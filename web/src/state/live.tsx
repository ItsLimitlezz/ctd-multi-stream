// Live store React bindings: one WebSocket to /api/ws while logged in.
// Hooks: useSession, useChat, useLiveStatus, useLiveConnections, useAccountUpdates,
// useAccountsVersion, useDestinationsVersion, useLiveEvent, useLiveActions.

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { WsServerMessage } from '@shared/api';
import type { Account, ChatMessage, SessionState } from '@shared/types';
import { api, wsUrl } from '../api';
import { alertForNotice, installAlerts } from './alerts';
import { useAuth } from './auth';
import { isApiError } from './errors';
import { LiveConnection, LiveStore, type LiveState } from './live-store';
import { toast } from './toast';

const LiveContext = createContext<LiveStore | null>(null);

/** Resolves false only when the server says we're logged out. */
async function stillLoggedIn(): Promise<boolean> {
  try {
    await api.me();
    return true;
  } catch (err) {
    return !isApiError(err, 401);
  }
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [store] = useState(() => new LiveStore());
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!userId) return;
    const conn = new LiveConnection({
      url: () => wsUrl('/api/ws'),
      onMessage: (msg) => {
        store.dispatch(msg);
        if (msg.type === 'notice') {
          toast(msg.message, { tone: msg.level });
          // Opt-in sound + browser notification (Profile → Alerts / dashboard "Alert me").
          alertForNotice(msg.level, msg.message);
        }
      },
      onConnectedChange: (connected) => store.setConnected(connected),
      checkAuth: stillLoggedIn,
    });
    const uninstallAlerts = installAlerts();
    conn.start();
    const kick = () => conn.kick();
    const onVisible = () => {
      if (document.visibilityState === 'visible') conn.kick();
    };
    window.addEventListener('online', kick);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', kick);
      document.removeEventListener('visibilitychange', onVisible);
      uninstallAlerts();
      conn.stop();
      store.reset();
    };
  }, [userId, store]);

  return <LiveContext.Provider value={store}>{children}</LiveContext.Provider>;
}

function useStore(): LiveStore {
  const store = useContext(LiveContext);
  if (!store) throw new Error('Live hooks must be used inside <LiveProvider>');
  return store;
}

/** Subscribe to a slice of the live state. The selector must return a stable reference. */
export function useLiveState<T>(selector: (s: LiveState) => T): T {
  const store = useStore();
  const get = () => selector(store.getState());
  return useSyncExternalStore(store.subscribe, get, get);
}

/** Current session (null until the first snapshot arrives). */
export const useSession = (): SessionState | null => useLiveState((s) => s.session);
/** Combined chat, oldest first (last 500). */
export const useChat = (): ChatMessage[] => useLiveState((s) => s.chat);
/** True while the live WebSocket is connected. */
export const useLiveStatus = (): boolean => useLiveState((s) => s.connected);
/** How many times the socket has connected (0 = still connecting for the first time). */
export const useLiveConnections = (): number => useLiveState((s) => s.connections);
/** Latest Account objects pushed by the server (by id). */
export const useAccountUpdates = (): Readonly<Record<string, Account>> => useLiveState((s) => s.accounts);
/** Changes whenever an account changes (or after a reconnect): use as a refetch dependency. */
export const useAccountsVersion = (): number => useLiveState((s) => s.accountsVersion);
/** Changes whenever destinations change (or after a reconnect): use as a refetch dependency. */
export const useDestinationsVersion = (): number => useLiveState((s) => s.destinationsVersion);

/** Run `handler` for every server message of `type` (latest handler is always used). */
export function useLiveEvent<K extends WsServerMessage['type']>(
  type: K,
  handler: (msg: Extract<WsServerMessage, { type: K }>) => void,
): void {
  const store = useStore();
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(
    () =>
      store.onEvent((msg) => {
        if (msg.type === type) ref.current(msg as Extract<WsServerMessage, { type: K }>);
      }),
    [store, type],
  );
}

export interface LiveActions {
  /** Apply a SessionState returned by a REST call (start/stop/auto). */
  applySession: (session: SessionState) => void;
  /** Use a REST session snapshot only if the socket hasn't delivered one yet. */
  seedSession: (session: SessionState) => void;
  /** Merge fields into the current session (e.g. { title } after api.setTitle). */
  patchSession: (patch: Partial<SessionState>) => void;
  /** Merge chat messages fetched over REST. */
  mergeChat: (messages: ChatMessage[]) => void;
}

export function useLiveActions(): LiveActions {
  const store = useStore();
  return useMemo(
    () => ({
      applySession: (s) => store.applySession(s),
      seedSession: (s) => store.seedSession(s),
      patchSession: (p) => store.patchSession(p),
      mergeChat: (m) => store.mergeChat(m),
    }),
    [store],
  );
}
