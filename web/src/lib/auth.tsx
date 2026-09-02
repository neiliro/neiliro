import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, api } from './api';
import { lang } from './i18n';

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member' | 'kid';
  color: string;
  must_change_password: number;
  google_linked: number;
  password_login_disabled: number;
  totp_enabled: number;
  /** Hosted with service mail: the address has not answered a confirmation
   *  yet, so password recovery by email is unavailable for this account.
   *  Absent (and irrelevant) on a self-hosted hub. */
  email_verification_pending?: boolean;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  mustChangePassword: boolean;
  login: (email: string, password: string) => Promise<string | null>;
  /** Second step of a TOTP-protected sign-in. */
  loginMfa: (mfaToken: string, code: string) => Promise<void>;
  /** Demo login: the server creates a sandbox and a session, no password involved. */
  loginDemo: () => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setUser(await api.get<User>('/auth/me'));
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Returns the MFA ticket when the account owes a TOTP code —
   * the Login page then shows the code step and calls loginMfa.
   */
  const login = useCallback(async (email: string, password: string): Promise<string | null> => {
    const res = await api.post<User | { mfa_required: true; mfa_token: string }>('/auth/login', {
      email,
      password,
    });
    if ('mfa_required' in res) return res.mfa_token;
    setUser(res);
    return null;
  }, []);

  const loginMfa = useCallback(async (mfaToken: string, code: string) => {
    const me = await api.post<User>('/auth/mfa', { mfa_token: mfaToken, code });
    setUser(me);
  }, []);

  const loginDemo = useCallback(async () => {
    // document.referrer is the only trace of how the visitor found the
    // demo — the server keeps it in anonymous usage stats (demo mode only).
    // The language decides which template the sandbox is copied from: the
    // sample family's own content is seeded per language, not translated.
    const me = await api.post<User>('/auth/demo', {
      referrer: document.referrer || null,
      lang,
    });
    setUser(me);
  }, []);

  const logout = useCallback(async () => {
    try {
      // The server has often already destroyed the session by the time this
      // runs (e.g. "sign in again" after a password change), so a 401 here
      // is expected — the cleanup below is the point, not the request.
      await api.post('/auth/logout', {}).catch(() => {});
    } finally {
      setUser(null);
      // The service worker's offline caches hold family data and the
      // last session answer — signing out must not leave them behind
      if ('caches' in window) {
        for (const name of ['api-reads', 'attachments', 'session']) {
          void caches.delete(name);
        }
      }
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        mustChangePassword: Boolean(user?.must_change_password),
        login,
        loginMfa,
        loginDemo,
        logout,
        refresh,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth called outside AuthProvider');
  return ctx;
}

export { ApiError };
