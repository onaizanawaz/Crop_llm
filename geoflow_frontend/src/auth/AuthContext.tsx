/**
 * Session state.
 *
 * The token is mirrored to localStorage so a reload survives, but the user is
 * always re-fetched from /auth/me rather than decoded from the token. The
 * backend re-reads the user row on every request, so a deactivated account is
 * rejected immediately -- trusting cached claims would show a working UI to
 * someone who no longer has access.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from "react";

import { AUTH_EXPIRED, api, tokenStore } from "../api/client";
import type { UserOut } from "../api/types";

interface AuthValue {
  user: UserOut | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, orgName: string) => Promise<void>;
  signOut: () => void;
}

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserOut | null>(null);
  const [loading, setLoading] = useState(true);

  const signOut = useCallback(() => {
    tokenStore.clear();
    setUser(null);
  }, []);

  // Restore on boot. A stored token that no longer resolves just means
  // signed out -- not an error worth showing anyone.
  useEffect(() => {
    if (!tokenStore.get()) { setLoading(false); return; }
    api.me()
      .then(setUser)
      .catch(() => tokenStore.clear())
      .finally(() => setLoading(false));
  }, []);

  // The API client fires this on any 401, so one expired token anywhere
  // signs the whole app out.
  useEffect(() => {
    window.addEventListener(AUTH_EXPIRED, signOut);
    return () => window.removeEventListener(AUTH_EXPIRED, signOut);
  }, [signOut]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { access_token } = await api.login(email, password);
    tokenStore.set(access_token);
    setUser(await api.me());
  }, []);

  const signUp = useCallback(async (email: string, password: string, orgName: string) => {
    const { access_token } = await api.register(email, password, orgName);
    tokenStore.set(access_token);
    setUser(await api.me());
  }, []);

  const value = useMemo(
    () => ({ user, loading, signIn, signUp, signOut }),
    [user, loading, signIn, signUp, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>");
  return v;
}