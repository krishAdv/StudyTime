"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Result } from "@/lib/class-rules";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase/client";

/**
 * Who is signed in. This is for the UI only: the database never trusts it. Every request
 * carries the user's JWT and Row Level Security uses auth.uid() from that token.
 *
 * Study data still lives in localStorage (M4.1 scopes it per account in AccountBoundary; nothing
 * syncs yet). This provider only reports who is signed in. "Not configured" (`disabled`) keeps
 * the app local-only; with Supabase configured, AccountBoundary shows a sign-in wall until signed in.
 */
export type AuthUser = { id: string; email: string | null };

/** `disabled`: Supabase isn't configured, so there are no accounts and the app is local-only. */
export type AuthStatus = "disabled" | "loading" | "signed-out" | "signed-in";

type AuthError = { message?: string; status?: number; code?: string; name?: string } | null;

/** The slice of the Supabase client used here (so tests can pass a fake). */
export type AuthClient = {
  auth: {
    getSession(): Promise<{ data: { session: { user: { id: string; email?: string } } | null }; error?: unknown }>;
    onAuthStateChange(
      callback: (event: string, session: { user: { id: string; email?: string } } | null) => void,
    ): { data: { subscription: { unsubscribe(): void } } };
    signInWithPassword(credentials: { email: string; password: string }): Promise<{ error: AuthError }>;
    signOut(options?: { scope: "local" }): Promise<{ error: AuthError }>;
    updateUser(attributes: { password: string }): Promise<{ error: AuthError }>;
  };
};

type AuthContextValue = {
  status: AuthStatus;
  user: AuthUser | null;
  signIn: (email: string, password: string) => Promise<Result>;
  signOut: () => Promise<Result>;
  /** Signed-in only. Re-checks the current password first, then sets the new one. */
  changePassword: (currentPassword: string, newPassword: string) => Promise<Result>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const NETWORK_MESSAGE = "Couldn’t reach the server. Check your connection and try again.";

/** Turns a Supabase auth error into a short message. Never says whether an email has an account. */
export function describeAuthError(error: AuthError | unknown): string {
  const e = (error ?? {}) as NonNullable<AuthError>;
  if (e.code === "invalid_credentials") return "Incorrect email or password.";
  if (e.code === "email_not_confirmed") return "This account’s email hasn’t been confirmed yet.";
  if (e.status === 429 || e.code === "over_request_rate_limit") return "Too many attempts. Wait a few minutes and try again.";
  if (e.name === "AuthRetryableFetchError" || e.status === 0 || e.status === undefined) return NETWORK_MESSAGE;
  if (e.status === 400) return "Incorrect email or password.";
  return "Couldn’t sign in. Try again in a moment.";
}

export const MIN_PASSWORD_LENGTH = 8;

const toUser = (u: { id: string; email?: string }): AuthUser => ({ id: u.id, email: u.email ?? null });

/**
 * The account last seen signed in on this device (`{id, email}`), written from auth events and removed on SIGNED_OUT.
 * It only says WHICH account's local data to show when supabase-js reports "no session" because it could not refresh
 * an expired token offline (see below); it is never a credential and never decides on its own that anyone is signed in.
 */
export const LAST_USER_KEY = "studytime:auth:last-user";

type GetStorage = () => Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
const defaultStorage: GetStorage = () => (typeof window === "undefined" ? null : window.localStorage);

function readLastUser(getStorage: GetStorage): AuthUser | null {
  try {
    const v = JSON.parse(getStorage()?.getItem(LAST_USER_KEY) ?? "null") as { id?: unknown; email?: unknown } | null;
    if (!v || typeof v.id !== "string" || !v.id) return null;
    return { id: v.id, email: typeof v.email === "string" ? v.email : null };
  } catch {
    return null;
  }
}

function writeLastUser(getStorage: GetStorage, user: AuthUser | null) {
  try {
    const s = getStorage();
    if (!s) return;
    if (user) s.setItem(LAST_USER_KEY, JSON.stringify(user));
    else s.removeItem(LAST_USER_KEY);
  } catch {
    // Only an offline convenience: without it, offline with an expired token shows the sign-in screen as before.
  }
}

export function AuthProvider({
  children,
  client: injected,
  getStorage = defaultStorage,
}: {
  children: React.ReactNode;
  /** Tests pass a fake (or null for "not configured"); the app uses the shared client. */
  client?: AuthClient | null;
  /** Where the last signed-in account is remembered (`LAST_USER_KEY`); defaults to window.localStorage. */
  getStorage?: GetStorage;
}) {
  const [client] = useState<AuthClient | null>(() => (injected !== undefined ? injected : getSupabase()));
  const [state, setState] = useState<{ status: AuthStatus; user: AuthUser | null }>(() => ({
    status: client ? "loading" : "disabled",
    user: null,
  }));

  useEffect(() => {
    if (!client) return;
    let active = true;
    const signedIn = (user: AuthUser) => {
      writeLastUser(getStorage, user);
      return { status: "signed-in" as const, user };
    };
    const signedOut = () => {
      writeLastUser(getStorage, null);
      return { status: "signed-out" as const, user: null };
    };

    // Events are the source of truth (sign-in, sign-out, refresh, another tab). A session in an event means signed
    // in, and SIGNED_OUT (also sent when supabase-js drops a session whose refresh token was rejected) means signed
    // out. A null INITIAL_SESSION alone doesn't say why there is no session, so getSession's answer below decides.
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (session) setState(signedIn(toUser(session.user)));
      else if (event === "SIGNED_OUT") setState(signedOut());
    });

    // The first answer, unless an event already gave one. "No session" is not always "signed out": offline with an
    // expired access token (e.g. reopened after an hour), supabase-js can't refresh, returns no session with an
    // AuthRetryableFetchError, keeps the stored session and refreshes it once the network is back (verified against
    // supabase-js 2.118). The device is still signed in then, as the account last seen here, so its local data and a
    // running timer stay available offline. No error means nothing is stored; any other error means the session was
    // rejected and removed. Both are signed out.
    const offlineOr = (error: unknown) => {
      const last = isAuthRetryableFetchError(error) ? readLastUser(getStorage) : null;
      return last ? { status: "signed-in" as const, user: last } : null;
    };
    client.auth
      .getSession()
      .then(({ data: { session }, error }) => {
        if (!active) return;
        setState((prev) =>
          prev.status !== "loading"
            ? prev
            : session
              ? signedIn(toUser(session.user))
              : (offlineOr(error) ?? signedOut()),
        );
      })
      .catch((e: unknown) => {
        if (active) {
          setState((prev) => (prev.status === "loading" ? (offlineOr(e) ?? { status: "signed-out", user: null }) : prev));
        }
      });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [client, getStorage]);

  const signIn = useCallback(
    async (email: string, password: string): Promise<Result> => {
      if (!client) return { ok: false, error: "Accounts aren’t set up for this copy of StudyTime." };
      const trimmed = email.trim();
      if (!trimmed || !trimmed.includes("@")) return { ok: false, error: "Enter your email address." };
      if (!password) return { ok: false, error: "Enter your password." };
      try {
        const { error } = await client.auth.signInWithPassword({ email: trimmed, password });
        return error ? { ok: false, error: describeAuthError(error) } : { ok: true, value: undefined };
      } catch (e) {
        return { ok: false, error: describeAuthError(e) };
      }
    },
    [client],
  );

  const signOut = useCallback(async (): Promise<Result> => {
    if (!client) return { ok: true, value: undefined };
    try {
      // "local": end this device's session only. The default scope would sign out every device.
      const { error } = await client.auth.signOut({ scope: "local" });
      return error ? { ok: false, error: "Couldn’t sign out. Try again." } : { ok: true, value: undefined };
    } catch {
      return { ok: false, error: "Couldn’t sign out. Try again." };
    }
  }, [client]);

  const email = state.user?.email ?? null;
  const signedIn = state.status === "signed-in";
  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string): Promise<Result> => {
      if (!client || !signedIn || !email) return { ok: false, error: "Sign in to change your password." };
      if (!currentPassword) return { ok: false, error: "Enter your current password." };
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        return { ok: false, error: `Use at least ${MIN_PASSWORD_LENGTH} characters for the new password.` };
      }
      if (newPassword === currentPassword) return { ok: false, error: "Choose a password you aren’t using now." };
      try {
        // updateUser doesn't check the old password, so confirm it first. Same account, so
        // the resulting auth event keeps the same user id and nothing remounts.
        const check = await client.auth.signInWithPassword({ email, password: currentPassword });
        if (check.error) {
          const e = check.error;
          return {
            ok: false,
            error:
              e.code === "invalid_credentials" || e.status === 400
                ? "Your current password is incorrect."
                : describeAuthError(e),
          };
        }
        const { error } = await client.auth.updateUser({ password: newPassword });
        if (!error) return { ok: true, value: undefined };
        if (error.code === "weak_password") {
          return { ok: false, error: "That password is too easy to guess. Choose a longer or less common one." };
        }
        if (error.code === "same_password") return { ok: false, error: "Choose a password you aren’t using now." };
        if (error.name === "AuthRetryableFetchError" || error.status === 0 || error.status === undefined) {
          return { ok: false, error: NETWORK_MESSAGE };
        }
        return { ok: false, error: "Couldn’t change your password. Try again in a moment." };
      } catch (e) {
        return { ok: false, error: describeAuthError(e) };
      }
    },
    [client, signedIn, email],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ status: state.status, user: state.user, signIn, signOut, changePassword }),
    [state, signIn, signOut, changePassword],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
