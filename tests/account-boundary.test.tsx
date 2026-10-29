// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AuthProvider } from "@/features/auth/auth-provider";
import { AccountBoundary } from "@/features/data/account-boundary";
import { useStudyData } from "@/features/data/study-data-provider";
import { SettingsProvider } from "@/features/settings/settings-provider";
import { accountKey } from "@/lib/account-store";
import { createLocalStorageStore } from "@/lib/data-store";
import { DATA_KEY, DATA_VERSION, RESET_BACKUP_KEY, RESET_MARKER_KEY, type StoredData } from "@/lib/storage";
import { createFakeAuth } from "./helpers/fake-auth";
import { createMemoryStorage } from "./helpers/memory-storage";

afterEach(cleanup);

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const data = (name: string): StoredData => ({
  classes: [{ id: `c-${name}`, name, color: "#10b981", groups: [] }],
  sessions: [
    { id: `s-${name}`, classId: `c-${name}`, groupId: null, startedAt: 1_700_000_000_000, seconds: 600, mode: "stopwatch" },
  ],
});
const payload = (d: StoredData) => JSON.stringify({ version: DATA_VERSION, ...d });

/** Shows what the app would show; the button adds a class so we can test saving and remounting. */
function Probe() {
  const d = useStudyData();
  return (
    <div>
      <p data-testid="status">{d.status}</p>
      <ul data-testid="classes">
        {d.classes.map((c) => (
          <li key={c.id}>{c.name}</li>
        ))}
      </ul>
      <button onClick={() => d.addClass("Added")}>add</button>
    </div>
  );
}

const names = () => Array.from(screen.getByTestId("classes").querySelectorAll("li")).map((l) => l.textContent);

function setup(
  opts: { configured?: boolean; legacy?: StoredData; accounts?: Record<string, StoredData>; signedInAs?: string } = {},
) {
  const { configured = true, legacy, accounts = {}, signedInAs } = opts;
  const initial: Record<string, string> = { [RESET_MARKER_KEY]: "done", [RESET_BACKUP_KEY]: "old-backup" };
  if (legacy) initial[DATA_KEY] = payload(legacy);
  for (const [id, d] of Object.entries(accounts)) initial[accountKey(id, "data")] = payload(d);
  const storage = createMemoryStorage(initial);
  const auth = createFakeAuth(
    [
      { id: "user-a", email: "a@example.com", password: "pw-a" },
      { id: "user-b", email: "b@example.com", password: "pw-b" },
    ],
    signedInAs ? { user: { id: signedInAs, email: `${signedInAs}@example.com` } } : null,
  );
  render(
    <SettingsProvider>
      <AuthProvider client={configured ? auth.client : null}>
        <AccountBoundary legacyStore={createLocalStorageStore(() => storage)} getStorage={() => storage}>
          <Probe />
        </AccountBoundary>
      </AuthProvider>
    </SettingsProvider>,
  );
  return { storage, auth };
}

describe("accounts not configured", () => {
  it("shows the legacy device data exactly as before accounts existed", () => {
    setup({ configured: false, legacy: data("Legacy") });
    expect(names()).toEqual(["Legacy"]);
    expect(screen.queryByLabelText("Email")).toBeNull();
  });
});

describe("signed-out wall", () => {
  it("shows a loading state, and no study data or data provider, while checking sign-in", () => {
    const { storage } = setup({ legacy: data("Legacy"), accounts: { "user-a": data("Alpha") } });
    expect(screen.getByRole("status").textContent).toContain("Checking sign-in");
    expect(screen.queryByTestId("classes")).toBeNull();
    expect(storage.reads).toEqual([]); // nothing was even read
  });

  it("shows only the sign-in form once signed out, never legacy or account data", async () => {
    const { storage } = setup({ legacy: data("Legacy"), accounts: { "user-a": data("Alpha") } });
    await flush();
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.queryByTestId("classes")).toBeNull();
    expect(document.body.textContent).not.toContain("Legacy");
    expect(document.body.textContent).not.toContain("Alpha");
    expect(storage.reads).toEqual([]);
  });

  it("falls back to the wall, not to data, if checking the saved session fails", async () => {
    const auth = createFakeAuth();
    auth.auth.getSession.mockRejectedValue(new Error("blocked"));
    render(
      <AuthProvider client={auth.client}>
        <AccountBoundary>
          <Probe />
        </AccountBoundary>
      </AuthProvider>,
    );
    await flush();
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.queryByTestId("classes")).toBeNull();
  });

  it("signing in through the wall opens that account's data", async () => {
    setup({ accounts: { "user-a": data("Alpha") } });
    await flush();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw-a" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await flush();
    expect(names()).toEqual(["Alpha"]);
  });
});

describe("account isolation", () => {
  it("shows the signed-in account's data, not the legacy bucket or another account's", async () => {
    setup({
      signedInAs: "user-a",
      legacy: data("Legacy"),
      accounts: { "user-a": data("Alpha"), "user-b": data("Beta") },
    });
    await flush();
    expect(screen.getByTestId("status").textContent).toBe("ready");
    expect(names()).toEqual(["Alpha"]);
  });

  it("a new account starts empty even when the device has legacy data", async () => {
    setup({ signedInAs: "user-a", legacy: data("Legacy") });
    await flush();
    expect(names()).toEqual([]);
  });

  it("saves edits only under the signed-in account's key", async () => {
    const { storage } = setup({ signedInAs: "user-a", legacy: data("Legacy") });
    await flush();
    const legacyBefore = storage.map.get(DATA_KEY);
    fireEvent.click(screen.getByText("add"));
    expect(names()).toEqual(["Added"]);
    expect(storage.map.get(accountKey("user-a", "data"))).toContain("Added");
    expect(storage.map.get(accountKey("user-b", "data"))).toBeUndefined();
    expect(storage.map.get(DATA_KEY)).toBe(legacyBefore);
  });
});

describe("sign-out and account switching", () => {
  it("signing out hides everything and deletes nothing", async () => {
    const { storage, auth } = setup({
      signedInAs: "user-a",
      legacy: data("Legacy"),
      accounts: { "user-a": data("Alpha") },
    });
    await flush();
    fireEvent.click(screen.getByText("add"));
    const before = storage.snapshot();
    storage.writes.length = 0;
    await act(async () => void auth.signOutEvent());
    expect(screen.queryByTestId("classes")).toBeNull();
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(storage.snapshot()).toEqual(before);
    expect(storage.writes).toEqual([]);
  });

  it("signing back in as the same account restores its data", async () => {
    const { auth } = setup({ signedInAs: "user-a", accounts: { "user-a": data("Alpha") } });
    await flush();
    fireEvent.click(screen.getByText("add"));
    await act(async () => void auth.signOutEvent());
    await act(async () => void auth.signInAs("user-a"));
    expect(names().sort()).toEqual(["Added", "Alpha"]);
  });

  it("switching to another account shows only that account's data, never the previous one", async () => {
    const { auth } = setup({ signedInAs: "user-a", accounts: { "user-a": data("Alpha"), "user-b": data("Beta") } });
    await flush();
    await act(async () => void auth.signOutEvent());
    await act(async () => void auth.signInAs("user-b"));
    expect(names()).toEqual(["Beta"]);
    expect(document.body.textContent).not.toContain("Alpha");
  });

  it("a direct switch with no sign-out event (another tab) also remounts to the new account", async () => {
    const { storage, auth } = setup({
      signedInAs: "user-a",
      accounts: { "user-a": data("Alpha"), "user-b": data("Beta") },
    });
    await flush();
    const alphaBefore = storage.map.get(accountKey("user-a", "data"));
    await act(async () => void auth.signInAs("user-b"));
    expect(names()).toEqual(["Beta"]);
    fireEvent.click(screen.getByText("add"));
    expect(storage.map.get(accountKey("user-a", "data"))).toBe(alphaBefore);
    expect(storage.map.get(accountKey("user-b", "data"))).toContain("Added");
  });

  it("a token refresh for the same user does not remount or lose in-memory state", async () => {
    const { auth } = setup({ signedInAs: "user-a" });
    await flush();
    fireEvent.click(screen.getByText("add"));
    await act(async () => void auth.emit("TOKEN_REFRESHED", { user: { id: "user-a", email: "user-a@example.com" } }));
    expect(names()).toEqual(["Added"]);
  });

  it("keeps the legacy bucket, its backup and the reset marker byte-for-byte through all of it", async () => {
    const { storage, auth } = setup({
      signedInAs: "user-a",
      legacy: data("Legacy"),
      accounts: { "user-b": data("Beta") },
    });
    const keep = [DATA_KEY, RESET_MARKER_KEY, RESET_BACKUP_KEY].map((k) => [k, storage.map.get(k)] as const);
    await flush();
    fireEvent.click(screen.getByText("add"));
    await act(async () => void auth.signOutEvent());
    await act(async () => void auth.signInAs("user-b"));
    fireEvent.click(screen.getByText("add"));
    await act(async () => void auth.signOutEvent());
    for (const [k, v] of keep) expect(storage.map.get(k)).toBe(v);
    expect(storage.writes.some((w) => w.startsWith("remove:"))).toBe(false);
  });
});
