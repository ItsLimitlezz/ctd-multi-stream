// Auth context: boot sequence (setup status -> me), current user, logout, 401 handling.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MeResponse } from '@shared/api';
import type { User } from '@shared/types';
import { api, setCsrfToken, setUnauthorizedHandler } from '../api';
import { navigate, safeReturnPath } from '../router';
import { errorMessage, isApiError } from './errors';

export type AuthStatus = 'loading' | 'setup' | 'anonymous' | 'authenticated' | 'error';

/** Minimum password length (matches the server's rule). */
export const MIN_PASSWORD = 10;

export interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  isAdmin: boolean;
  /** Boot error (server unreachable), shown with a retry button. */
  error: string | null;
  /** Re-fetch the current user (e.g. after enabling 2FA). */
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  /** Login/setup succeeded: store the user (the CSRF token is set by api.ts). */
  signedIn: (me: MeResponse) => void;
  /** Run the boot sequence again. */
  retry: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Where to go after login (the page the user was on when the session ended).
let returnTo: string | null = null;

export function rememberReturnTo(path: string): void {
  returnTo = safeReturnPath(path);
}

export function takeReturnTo(): string {
  const r = returnTo ?? '/';
  returnTo = null;
  return r;
}

interface State {
  status: AuthStatus;
  user: User | null;
  error: string | null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading', user: null, error: null });
  const bootSeq = useRef(0);

  const boot = useCallback(async () => {
    const seq = ++bootSeq.current;
    const apply = (s: State) => {
      if (seq === bootSeq.current) setState(s);
    };
    apply({ status: 'loading', user: null, error: null });
    try {
      const { needsSetup } = await api.setupStatus();
      if (needsSetup) return apply({ status: 'setup', user: null, error: null });
      try {
        const me = await api.me();
        apply({ status: 'authenticated', user: me.user, error: null });
      } catch (err) {
        if (isApiError(err, 401)) apply({ status: 'anonymous', user: null, error: null });
        else throw err;
      }
    } catch (err) {
      apply({ status: 'error', user: null, error: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    // Any 401 'unauthenticated' from the API: the session is gone.
    setUnauthorizedHandler(() => {
      setCsrfToken(null);
      setState((s) => (s.status === 'setup' ? s : { status: 'anonymous', user: null, error: null }));
    });
    void boot();
    return () => setUnauthorizedHandler(null);
  }, [boot]);

  const refresh = useCallback(async () => {
    try {
      const me = await api.me();
      setState({ status: 'authenticated', user: me.user, error: null });
    } catch (err) {
      // 401 is handled by the unauthorized handler; other errors keep the current state.
      if (!isApiError(err, 401)) throw err;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* the session may already be gone; log out locally anyway */
    }
    setCsrfToken(null);
    returnTo = null;
    navigate('/login', { replace: true });
    setState({ status: 'anonymous', user: null, error: null });
  }, []);

  const signedIn = useCallback((me: MeResponse) => {
    setState({ status: 'authenticated', user: me.user, error: null });
  }, []);

  const retry = useCallback(() => void boot(), [boot]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status: state.status,
      user: state.user,
      isAdmin: state.user?.role === 'admin',
      error: state.error,
      refresh,
      logout,
      signedIn,
      retry,
    }),
    [state, refresh, logout, signedIn, retry],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth() must be used inside <AuthProvider>');
  return ctx;
}
