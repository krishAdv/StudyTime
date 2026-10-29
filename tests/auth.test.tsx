// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountCard } from "@/features/auth/account-card";
import { AuthProvider, describeAuthError, useAuth, type AuthClient } from "@/features/auth/auth-provider";
import { StudyDataProvider, useStudyData } from "@/features/data/study-data-provider";
import { createLocalStorageStore, type StorageLike } from "@/lib/data-store";
import { DATA_KEY, DATA_VERSION, RESET_MARKER_KEY, type StoredData } from "@/lib/storage";

afterEach(cleanup);

type Session = { user: { id: string; email?: string } } | null;

const SESSION: Session = { user: { id: "user-1", email: "her@example.com" } };

function fakeClient(opts: { session?: Session; getSession?: () => Promise<{ data: { session: Session } }> } = {}) {
  let listener: ((event: string, session: Session) => void) | null = null;
  const unsubscribe = vi.fn();
  const auth = {
    getSession: vi.fn(opts.getSession ?? (async () => ({ data: { session: opts.session ?? null } }))),
    onAuthStateChange: vi.fn((cb: (event: string, session: Session) => void) => {
      listener = cb;
      return { data: { subscription: { unsubscribe } } };
    }),
    signInWithPassword: vi.fn<AuthClient["auth"]["signInWithPassword"]>(async () => ({ error: null })),
    signOut: vi.fn<AuthClient["auth"]["signOut"]>(async () => ({ error: null })),
    updateUser: vi.fn<AuthClient["auth"]["updateUser"]>(async () => ({ error: null })),
  };
  return { client: { auth } as AuthClient, auth, unsubscribe, emit: (e: string, s: Session) => listener?.(e, s) };
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function setup(client: AuthClient | null) {
  return renderHook(() => useAuth(), { wrapper: ({ children }) => <AuthProvider client={client}>{children}</AuthProvider> });
}

describe("AuthProvider status", () => {
  it("is disabled, and never loading, when Supabase isn't configured", async () => {
    const { result } = setup(null);
    expect(result.current.status).toBe("disabled");
    await flush();
    expect(result.current.status).toBe("disabled");
    expect(await result.current.signIn("a@b.co", "pw")).toMatchObject({ ok: false });
    expect(await result.current.signOut()).toMatchObject({ ok: true });
  });

  it("starts loading, then signed-out when there is no saved session", async () => {
    const { client } = fakeClient();
    const { result } = setup(client);
    expect(result.current.status).toBe("loading");
    await flush();
    expect(result.current.status).toBe("signed-out");
    expect(result.current.user).toBeNull();
  });

  it("restores a saved session", async () => {
    const { client } = fakeClient({ session: SESSION });
    const { result } = setup(client);
    await flush();
    expect(result.current.status).toBe("signed-in");
    expect(result.current.user).toEqual({ id: "user-1", email: "her@example.com" });
  });

  it("falls back to signed-out if reading the session fails", async () => {
    const { client } = fakeClient({ getSession: () => Promise.reject(new Error("storage blocked")) });
    const { result } = setup(client);
    await flush();
    expect(result.current.status).toBe("signed-out");
  });

  it("follows auth events (sign-in, sign-out, another tab)", async () => {
    const f = fakeClient();
    const { result } = setup(f.client);
    await flush();
    act(() => f.emit("SIGNED_IN", SESSION));
    expect(result.current.status).toBe("signed-in");
    act(() => f.emit("SIGNED_OUT", null));
    expect(result.current.status).toBe("signed-out");
    expect(result.current.user).toBeNull();
  });

  it("a late getSession answer never overwrites a newer event", async () => {
    let resolve!: (v: { data: { session: Session } }) => void;
    const f = fakeClient({ getSession: () => new Promise((r) => (resolve = r)) });
    const { result } = setup(f.client);
    act(() => f.emit("SIGNED_IN", SESSION));
    await act(async () => resolve({ data: { session: null } }));
    expect(result.current.status).toBe("signed-in");
  });

  it("unsubscribes on unmount and ignores later events", async () => {
    const f = fakeClient();
    const { result, unmount } = setup(f.client);
    await flush();
    unmount();
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    act(() => f.emit("SIGNED_IN", SESSION));
    expect(result.current.status).toBe("signed-out");
  });
});

describe("signIn / signOut", () => {
  it("sends the trimmed email and the password as typed", async () => {
    const f = fakeClient();
    const { result } = setup(f.client);
    await flush();
    const r = await act(() => result.current.signIn("  her@example.com ", " pw "));
    expect(r).toEqual({ ok: true, value: undefined });
    expect(f.auth.signInWithPassword).toHaveBeenCalledWith({ email: "her@example.com", password: " pw " });
  });

  it("rejects empty or malformed input without calling the server", async () => {
    const f = fakeClient();
    const { result } = setup(f.client);
    await flush();
    expect(await act(() => result.current.signIn("   ", "pw"))).toMatchObject({ ok: false });
    expect(await act(() => result.current.signIn("not-an-email", "pw"))).toMatchObject({ ok: false });
    expect(await act(() => result.current.signIn("a@b.co", ""))).toMatchObject({ ok: false });
    expect(f.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("returns a friendly error for wrong credentials, and stays signed out", async () => {
    const f = fakeClient();
    f.auth.signInWithPassword.mockResolvedValue({ error: { status: 400, code: "invalid_credentials", message: "Invalid login credentials" } });
    const { result } = setup(f.client);
    await flush();
    const r = await act(() => result.current.signIn("a@b.co", "bad"));
    expect(r).toEqual({ ok: false, error: "Incorrect email or password." });
    expect(result.current.status).toBe("signed-out");
  });

  it("turns a thrown network failure into a message instead of an exception", async () => {
    const f = fakeClient();
    f.auth.signInWithPassword.mockRejectedValue(new TypeError("Failed to fetch"));
    const { result } = setup(f.client);
    await flush();
    const r = await act(() => result.current.signIn("a@b.co", "pw"));
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("reach the server") });
  });

  it("signs out this device only (scope local), never every device", async () => {
    const f = fakeClient({ session: SESSION });
    const { result } = setup(f.client);
    await flush();
    expect(await act(() => result.current.signOut())).toEqual({ ok: true, value: undefined });
    expect(f.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("reports a failed sign-out and stays signed in", async () => {
    const f = fakeClient({ session: SESSION });
    f.auth.signOut.mockResolvedValue({ error: { status: 500, message: "boom" } });
    const { result } = setup(f.client);
    await flush();
    expect(await act(() => result.current.signOut())).toMatchObject({ ok: false });
    expect(result.current.status).toBe("signed-in");
  });
});

describe("describeAuthError", () => {
  it("maps known cases and never leaks server text", () => {
    expect(describeAuthError({ status: 400, code: "invalid_credentials", message: "Invalid login credentials" })).toBe("Incorrect email or password.");
    expect(describeAuthError({ status: 429, code: "over_request_rate_limit" })).toContain("Too many attempts");
    expect(describeAuthError({ status: 400, code: "email_not_confirmed" })).toContain("confirmed");
    expect(describeAuthError({ name: "AuthRetryableFetchError", status: 0 })).toContain("reach the server");
    expect(describeAuthError({ status: 500, message: "internal detail" })).not.toContain("internal detail");
    expect(describeAuthError(undefined)).toContain("reach the server");
  });
});

describe("AccountCard", () => {
  function renderCard(client: AuthClient | null) {
    return render(
      <AuthProvider client={client}>
        <AccountCard timerActive={false} />
      </AuthProvider>,
    );
  }
  const email = () => screen.getByLabelText("Email");
  const password = () => screen.getByLabelText("Password");

  it("explains that accounts aren't set up when unconfigured", () => {
    renderCard(null);
    expect(screen.getByText(/aren’t set up/)).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
  });

  it("shows a sign-in form when signed out and submits it", async () => {
    const f = fakeClient();
    renderCard(f.client);
    expect(screen.getByRole("status").textContent).toContain("Checking");
    await flush();
    fireEvent.change(email(), { target: { value: "her@example.com" } });
    fireEvent.change(password(), { target: { value: "secret-pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await flush();
    expect(f.auth.signInWithPassword).toHaveBeenCalledWith({ email: "her@example.com", password: "secret-pw" });
  });

  it("shows the error inline, links it to the fields, and keeps the email", async () => {
    const f = fakeClient();
    f.auth.signInWithPassword.mockResolvedValue({ error: { status: 400, code: "invalid_credentials" } });
    renderCard(f.client);
    await flush();
    fireEvent.change(email(), { target: { value: "her@example.com" } });
    fireEvent.change(password(), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Incorrect email or password.");
    expect(password().getAttribute("aria-describedby")).toBe(alert.id);
    expect((email() as HTMLInputElement).value).toBe("her@example.com");
  });

  it("disables the button while signing in, so a double tap sends one request", async () => {
    const f = fakeClient();
    let finish!: (v: { error: null }) => void;
    f.auth.signInWithPassword.mockReturnValue(new Promise((r) => (finish = r)));
    renderCard(f.client);
    await flush();
    fireEvent.change(email(), { target: { value: "her@example.com" } });
    fireEvent.change(password(), { target: { value: "pw" } });
    const form = email().closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(f.auth.signInWithPassword).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Signing in…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish({ error: null }));
  });

  it("when signed in, shows the email and signs out", async () => {
    const f = fakeClient({ session: SESSION });
    renderCard(f.client);
    await flush();
    expect(screen.getByText("her@example.com")).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Sign out/ }));
    await flush();
    expect(f.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});

describe("local data is independent of the account", () => {
  const DATA: StoredData = {
    classes: [{ id: "c1", name: "Biology", color: "#10b981", groups: [] }],
    sessions: [{ id: "s1", classId: "c1", groupId: null, startedAt: 1_700_000_000_000, seconds: 600, mode: "stopwatch" }],
  };

  function storage() {
    const map = new Map<string, string>([
      [RESET_MARKER_KEY, "done"],
      [DATA_KEY, JSON.stringify({ version: DATA_VERSION, ...DATA })],
    ]);
    const s: StorageLike & { map: Map<string, string> } = {
      map,
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    };
    return s;
  }

  it("keeps study data readable and unchanged through sign-in and sign-out", async () => {
    const s = storage();
    const before = s.map.get(DATA_KEY);
    const f = fakeClient();
    const { result } = renderHook(() => ({ auth: useAuth(), data: useStudyData() }), {
      wrapper: ({ children }) => (
        <AuthProvider client={f.client}>
          <StudyDataProvider store={createLocalStorageStore(() => s)}>{children}</StudyDataProvider>
        </AuthProvider>
      ),
    });
    expect(result.current.data.status).toBe("ready"); // not waiting for auth
    expect(result.current.auth.status).toBe("loading");
    expect(result.current.data.classes).toHaveLength(1);
    await flush();
    act(() => f.emit("SIGNED_IN", SESSION));
    act(() => f.emit("SIGNED_OUT", null));
    await waitFor(() => expect(result.current.auth.status).toBe("signed-out"));
    expect(result.current.data.classes).toHaveLength(1);
    expect(result.current.data.sessions).toHaveLength(1);
    expect(s.map.get(DATA_KEY)).toBe(before);
  });

  it("works with no account configured at all", () => {
    const s = storage();
    const { result } = renderHook(() => useStudyData(), {
      wrapper: ({ children }) => (
        <AuthProvider client={null}>
          <StudyDataProvider store={createLocalStorageStore(() => s)}>{children}</StudyDataProvider>
        </AuthProvider>
      ),
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.sessions).toHaveLength(1);
  });
});
