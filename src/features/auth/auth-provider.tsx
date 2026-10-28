"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Result } from "@/lib/class-rules";
import { getSupabase } from "@/lib/supabase/client";

/**
 * Who is signed in. This is for the UI only: the database never trusts it. Every request
 * carries the user's JWT and Row Level Security uses auth.uid() from that token.
 *
 * Accounts do not change where study data lives yet (still localStorage), and nothing waits
 * on this provider: signed-out, loading and "not configured" all leave the app fully usable.
 */
export type AuthUser = { id: string; email: string | null };

/** `disabled`: Supabase isn't configured, so there are no accounts and the app is local-only. */
export type AuthStatus = "disabled" | "loading" | "signed-out" | "signed-in";

type AuthError = { message?: string; status?: number; code?: string; name?: string } | null;

/** The slice of the Supabase client used here (so tests can pass a fake). */
export type AuthClient = {
  auth: {
    getSession(): Promise<{ data: { session: { user: { id: string; email?: string } } | null } }>;
    onAuthStateChange(
      callback: (event: string, session: { user: { id: string; email?: string } } | null) => void,
    ): { data: { subscription: { unsubscribe(): void } } };
    signInWithPassword(credentials: { email: string; password: string }): Promise<{ error: AuthError }>;
    signOut(options?: { scope: "local" }): Promise<{ error: AuthError }>;
  };
};

type AuthContextValue = {
  status: AuthStatus;
  user: AuthUser | null;
  signIn: (email: string, password: string) => Promise<Result>;
  signOut: () => Promise<Result>;
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

const toUser = (u: { id: string; email?: string }): AuthUser => ({ id: u.id, email: u.email ?? null });

export function AuthProvider({
  children,
  client: injected,
}: {
  children: React.ReactNode;
  /** Tests pass a fake (or null for "not configured"); the app uses the shared client. */
  client?: AuthClient | null;
}) {
  const [client] = useState<AuthClient | null>(() => (injected !== undefined ? injected : getSupabase()));
  const [state, setState] = useState<{ status: AuthStatus; user: AuthUser | null }>(() => ({
    status: client ? "loading" : "disabled",
    user: null,
  }));

  useEffect(() => {
    if (!client) return;
    let active = true;
    const apply = (session: { user: { id: string; email?: string } } | null) =>
      setState(session ? { status: "signed-in", user: toUser(session.user) } : { status: "signed-out", user: null });

    // Events are the source of truth (sign-in, sign-out, refresh, another tab).
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      if (active) apply(session);
    });
    // Fallback for the first answer only; it must never overwrite a newer event.
    client.auth
      .getSession()
      .then(({ data: { session } }) => {
        if (!active) return;
        setState((prev) =>
          prev.status !== "loading"
            ? prev
            : session
              ? { status: "signed-in", user: toUser(session.user) }
              : { status: "signed-out", user: null },
        );
      })
      .catch(() => {
        if (active) setState((prev) => (prev.status === "loading" ? { status: "signed-out", user: null } : prev));
      });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [client]);

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

  const value = useMemo<AuthContextValue>(
    () => ({ status: state.status, user: state.user, signIn, signOut }),
    [state, signIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
