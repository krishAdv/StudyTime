// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountCard } from "@/features/auth/account-card";
import { AuthProvider } from "@/features/auth/auth-provider";
import { LegacyDataCard } from "@/features/settings/legacy-data-card";
import { DATA_KEY, DATA_VERSION, type StoredData } from "@/lib/storage";
import { createFakeAuth } from "./helpers/fake-auth";
import { createMemoryStorage } from "./helpers/memory-storage";

afterEach(cleanup);

// jsdom has no <dialog> modal support; model just enough of it for the confirm dialog.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const ACCOUNTS = [{ id: "user-a", email: "a@example.com", password: "old-password" }];
const SIGNED_IN = { user: { id: "user-a", email: "a@example.com" } };

describe("change password", () => {
  async function open() {
    const f = createFakeAuth(ACCOUNTS, SIGNED_IN);
    render(
      <AuthProvider client={f.client}>
        <AccountCard timerActive={false} />
      </AuthProvider>,
    );
    await flush();
    const fill = (current: string, next: string, confirm: string) => {
      fireEvent.change(screen.getByLabelText("Current password"), { target: { value: current } });
      fireEvent.change(screen.getByLabelText("New password"), { target: { value: next } });
      fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: confirm } });
      fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    };
    return { f, fill };
  }

  it("checks the current password, sets the new one, and clears the form", async () => {
    const { f, fill } = await open();
    fill("old-password", "new-password-1", "new-password-1");
    await flush();
    expect(f.auth.signInWithPassword).toHaveBeenCalledWith({ email: "a@example.com", password: "old-password" });
    expect(f.auth.updateUser).toHaveBeenCalledWith({ password: "new-password-1" });
    expect(screen.getByText("Password changed.")).toBeTruthy();
    expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe("");
  });

  it("rejects a wrong current password without changing anything", async () => {
    const { f, fill } = await open();
    fill("not-my-password", "new-password-1", "new-password-1");
    await flush();
    expect((await screen.findByRole("alert")).textContent).toBe("Your current password is incorrect.");
    expect(f.auth.updateUser).not.toHaveBeenCalled();
  });

  it("rejects mismatched, too-short and unchanged passwords before any request", async () => {
    const { f, fill } = await open();
    fill("old-password", "new-password-1", "different-1");
    expect((await screen.findByRole("alert")).textContent).toContain("don’t match");
    fill("old-password", "short", "short");
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("at least 8");
    fill("old-password", "old-password", "old-password");
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("aren’t using now");
    expect(f.auth.signInWithPassword).not.toHaveBeenCalled();
    expect(f.auth.updateUser).not.toHaveBeenCalled();
  });

  it("maps a weak-password rejection and a network failure to plain messages", async () => {
    const { f, fill } = await open();
    f.auth.updateUser.mockResolvedValueOnce({ error: { status: 422, code: "weak_password", message: "internal" } });
    fill("old-password", "password123", "password123");
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("too easy to guess");
    f.auth.updateUser.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fill("old-password", "another-new-pw", "another-new-pw");
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("reach the server");
  });

  it("is not offered when signed out", async () => {
    const f = createFakeAuth(ACCOUNTS);
    render(
      <AuthProvider client={f.client}>
        <AccountCard timerActive={false} />
      </AuthProvider>,
    );
    await flush();
    expect(screen.queryByLabelText("Current password")).toBeNull();
  });
});

describe("legacy data card", () => {
  const LEGACY: StoredData = {
    classes: [{ id: "c1", name: "Biology", color: "#10b981", groups: [] }],
    sessions: [{ id: "s1", classId: "c1", groupId: null, startedAt: 1_700_000_000_000, seconds: 600, mode: "stopwatch" }],
  };
  const legacyPayload = JSON.stringify({ version: DATA_VERSION, ...LEGACY });

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();
  });

  function renderCard(storage: ReturnType<typeof createMemoryStorage>, signedIn = true) {
    const f = createFakeAuth(ACCOUNTS, signedIn ? SIGNED_IN : null);
    render(
      <AuthProvider client={f.client}>
        <LegacyDataCard getStorage={() => storage} />
      </AuthProvider>,
    );
    return f;
  }

  it("tells a signed-in user the data exists, without showing its contents", async () => {
    renderCard(createMemoryStorage({ [DATA_KEY]: legacyPayload }));
    await flush();
    expect(screen.getByText(/1 class and 1 session from before accounts/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("Biology");
  });

  it("is hidden when signed out, or when there is no legacy data", async () => {
    renderCard(createMemoryStorage({ [DATA_KEY]: legacyPayload }), false);
    await flush();
    expect(screen.queryByText("Saved before accounts")).toBeNull();
    cleanup();
    renderCard(createMemoryStorage());
    await flush();
    expect(screen.queryByText("Saved before accounts")).toBeNull();
  });

  it("asks first, naming the account, and downloads only after confirming", async () => {
    const storage = createMemoryStorage({ [DATA_KEY]: legacyPayload });
    renderCard(storage);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Download saved data/ }));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("signed in as a@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("never changes the stored legacy data", async () => {
    const storage = createMemoryStorage({ [DATA_KEY]: legacyPayload });
    renderCard(storage);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /Download saved data/ }));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(storage.writes).toEqual([]);
    expect(storage.map.get(DATA_KEY)).toBe(legacyPayload);
  });
});
