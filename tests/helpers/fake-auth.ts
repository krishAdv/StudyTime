import { vi } from "vitest";
import type { AuthClient } from "@/features/auth/auth-provider";

type Session = { user: { id: string; email?: string } } | null;
type Account = { id: string; email: string; password: string };

/**
 * A fake Supabase auth client that behaves like the real one where it matters for account
 * tests: sign-in checks the password and emits SIGNED_IN, sign-out emits SIGNED_OUT, and
 * tests can also emit any event directly (account switch without a sign-out, token refresh,
 * another tab). `signInWithPassword` / `signOut` / `updateUser` are spies and can be overridden.
 */
export function createFakeAuth(accounts: Account[] = [], initial: Session = null) {
  let session: Session = initial;
  let listener: ((event: string, s: Session) => void) | null = null;
  const passwords = new Map(accounts.map((a) => [a.email, { ...a }]));
  const emit = (event: string, s: Session) => {
    session = s;
    listener?.(event, s);
  };

  const auth = {
    getSession: vi.fn(async () => ({ data: { session } })),
    onAuthStateChange: vi.fn((cb: (event: string, s: Session) => void) => {
      listener = cb;
      return { data: { subscription: { unsubscribe: vi.fn(() => void (listener = null)) } } };
    }),
    signInWithPassword: vi.fn<AuthClient["auth"]["signInWithPassword"]>(async ({ email, password }) => {
      const a = passwords.get(email);
      if (!a || a.password !== password) return { error: { status: 400, code: "invalid_credentials" } };
      emit("SIGNED_IN", { user: { id: a.id, email: a.email } });
      return { error: null };
    }),
    signOut: vi.fn<AuthClient["auth"]["signOut"]>(async () => {
      emit("SIGNED_OUT", null);
      return { error: null };
    }),
    updateUser: vi.fn<AuthClient["auth"]["updateUser"]>(async ({ password }) => {
      const email = session?.user.email;
      const a = email ? passwords.get(email) : undefined;
      if (!a) return { error: { status: 401, code: "not_authenticated" } };
      a.password = password;
      return { error: null };
    }),
  };

  return {
    client: { auth } as AuthClient,
    auth,
    /** Emit a raw auth event (e.g. another tab signed in as someone else). */
    emit,
    signInAs: (id: string, email = `${id}@example.com`) => emit("SIGNED_IN", { user: { id, email } }),
    signOutEvent: () => emit("SIGNED_OUT", null),
    currentUserId: () => session?.user.id ?? null,
  };
}
