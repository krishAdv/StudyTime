// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AccountCard } from "@/features/auth/account-card";
import { SettingsView } from "@/features/settings/settings-view";
import { ThemeProvider } from "@/features/theme/theme-provider";
import { AuthProvider } from "@/features/auth/auth-provider";
import { StudyDataProvider } from "@/features/data/study-data-provider";
import { DataTransferCard } from "@/features/settings/data-transfer";
import { SettingsProvider } from "@/features/settings/settings-provider";
import { SyncProvider } from "@/features/sync/sync-provider";
import { TimerProvider } from "@/features/timer/timer-provider";
import { accountKey, createAccountStore } from "@/lib/account-store";
import { saveSyncEnabled } from "@/lib/sync/device-store";
import { serializeExport } from "@/lib/data-export";
import { serializeData, type StoredData } from "@/lib/storage";
import { createFakeAuth } from "./helpers/fake-auth";
import { createFakeSyncServer } from "./helpers/fake-sync-server";
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

const USER = "user-a";
const CURRENT: StoredData = {
  classes: [{ id: "c-old", name: "Old class", color: "#3b82f6", groups: [] }],
  sessions: [{ id: "s-old", classId: "c-old", groupId: null, startedAt: 1_700_000_000_000, seconds: 90, mode: "stopwatch" }],
};
const INCOMING: StoredData = {
  classes: [{ id: "c-new", name: "Biology", color: "#10b981", groups: [] }],
  sessions: [{ id: "s-new", classId: "c-new", groupId: null, startedAt: 1_700_000_500_000, seconds: 1200, mode: "countdown" }],
};

type Mode = "no-sync-provider" | "flag-off" | "available-not-opted-in" | "opted-in";

/** The Settings pieces under test, with sync absent, available, or turned on for this device. */
function renderSettings(mode: Mode, children: React.ReactNode) {
  const mem = createMemoryStorage({ [accountKey(USER, "data")]: serializeData(CURRENT) });
  if (mode === "opted-in") saveSyncEnabled(mem, USER, true);
  const getStorage = () => mem;
  const store = createAccountStore(USER, getStorage);
  const api = createFakeSyncServer().apiFor(USER);
  const fake = createFakeAuth([], { user: { id: USER, email: "her@example.com" } });
  const inner = <TimerProvider>{children}</TimerProvider>;
  render(
    <AuthProvider client={fake.client}>
      <SettingsProvider>
        <StudyDataProvider store={store}>
          {mode === "no-sync-provider" ? (
            inner
          ) : (
            <TimerProvider>
              <SyncProvider userId={USER} api={api} getStorage={getStorage} buildEnabled={mode !== "flag-off"}>
                {children}
              </SyncProvider>
            </TimerProvider>
          )}
        </StudyDataProvider>
      </SettingsProvider>
    </AuthProvider>,
  );
  return mem;
}

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

async function chooseImportFile() {
  const content = serializeExport(INCOMING);
  const input = screen.getByLabelText("Choose an export file to import") as HTMLInputElement;
  const file = new File([content], "backup.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: () => Promise.resolve(content) });
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
  return screen.findByText("Replace your study data?");
}

describe("the import confirmation", () => {
  it("always says that importing replaces the existing data and can't be undone", async () => {
    renderSettings("no-sync-provider", <DataTransferCard />);
    await chooseImportFile();
    const text = screen.getByText(/will be replaced/).textContent ?? "";
    expect(text).toMatch(/Your current 1 class and 1 session will be replaced/);
    expect(text).toMatch(/can’t be undone/);
    expect(text).not.toMatch(/Sync is on/);
  });

  it("says nothing about sync when sync is unavailable or not turned on for this device", async () => {
    for (const mode of ["flag-off", "available-not-opted-in"] as const) {
      cleanup();
      renderSettings(mode, <DataTransferCard />);
      await chooseImportFile();
      expect(screen.getByText(/will be replaced/).textContent).not.toMatch(/sync/i);
    }
  });

  it("WARNS when sync is on for this device: the change can reach other linked devices, including removals", async () => {
    renderSettings("opted-in", <DataTransferCard />);
    await chooseImportFile();
    const text = screen.getByText(/will be replaced/).textContent ?? "";
    expect(text).toMatch(/Sync is on for this device, so this change can also reach your other linked devices/);
    expect(text).toMatch(/anything that isn’t in the file can be removed there too/);
    expect(text).toMatch(/can’t be undone, so export first/);
  });

  it("the replacement itself is unchanged: cancelling changes nothing, confirming replaces", async () => {
    const mem = renderSettings("opted-in", <DataTransferCard />);
    const before = mem.getItem(accountKey(USER, "data"));
    await chooseImportFile();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();
    expect(mem.getItem(accountKey(USER, "data"))).toBe(before);
    await chooseImportFile();
    fireEvent.click(screen.getByRole("button", { name: "Replace my data" }));
    await flush();
    expect(JSON.parse(mem.getItem(accountKey(USER, "data"))!).classes.map((c: { id: string }) => c.id)).toEqual(["c-new"]);
  });
});

describe("the account card no longer says syncing comes later", () => {
  async function signedInCard(mode: Mode) {
    renderSettings(mode, <AccountCard timerActive={false} />);
    await flush();
    return screen.getByText(/Signed in as/).closest("p")?.textContent ?? "";
  }

  it("when sync is not available it only describes where the data is saved", async () => {
    for (const mode of ["no-sync-provider", "flag-off"] as const) {
      cleanup();
      const text = await signedInCard(mode);
      expect(text).toMatch(/saved on this device under this account only/);
      expect(text).not.toMatch(/comes later/);
      expect(text).not.toMatch(/Syncing between your devices/);
      expect(text).toMatch(/Signing out doesn’t remove it/);
    }
  });

  it("when sync is available it explains that it is optional, off until turned on, and what it does", async () => {
    for (const mode of ["available-not-opted-in", "opted-in"] as const) {
      cleanup();
      const text = await signedInCard(mode);
      expect(text).not.toMatch(/comes later/);
      expect(text).toMatch(/Syncing between your devices is optional and stays off until you turn it on below \(Sync between devices\)/);
      expect(text).toMatch(/changes on this device are shared with your other linked devices/);
      expect(text).toMatch(/Signing out doesn’t remove it/);
    }
  });
});

describe("the Settings 'Your data' card", () => {
  beforeAll(() => {
    window.matchMedia ??= (() => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    })) as unknown as typeof window.matchMedia;
  });

  /** The whole Settings page with sync absent, available, or turned on, so the card sees the real sync state. */
  function renderPage(mode: Mode) {
    const mem = createMemoryStorage({ [accountKey(USER, "data")]: serializeData(CURRENT) });
    if (mode === "opted-in") saveSyncEnabled(mem, USER, true);
    const getStorage = () => mem;
    const store = createAccountStore(USER, getStorage);
    const api = createFakeSyncServer().apiFor(USER);
    const fake = createFakeAuth([], { user: { id: USER, email: "her@example.com" } });
    const page = <SettingsView />;
    render(
      <ThemeProvider>
        <AuthProvider client={fake.client}>
          <SettingsProvider>
            <StudyDataProvider store={store}>
              <TimerProvider>
                {mode === "no-sync-provider" ? (
                  page
                ) : (
                  <SyncProvider userId={USER} api={api} getStorage={getStorage} buildEnabled={mode !== "flag-off"}>
                    {page}
                  </SyncProvider>
                )}
              </TimerProvider>
            </StudyDataProvider>
          </SettingsProvider>
        </AuthProvider>
      </ThemeProvider>,
    );
  }
  const card = () => screen.getByText("Your data").closest("section")!.textContent ?? "";

  it("local-only build (no sync, or the build flag off): data stays on this device, and nothing mentions syncing later", async () => {
    for (const mode of ["no-sync-provider", "flag-off"] as const) {
      cleanup();
      renderPage(mode);
      await flush();
      const text = card();
      expect(text).toMatch(/saved in this browser on this device, and clearing site data removes them/);
      expect(text).toMatch(/kept separately for your account on this device/);
      expect(text).toMatch(/Your data stays on this device\./);
      expect(text).not.toMatch(/sync/i);
      expect(text).not.toMatch(/yet|later update/);
    }
  });

  it("sync-enabled build (whether or not this device opted in): syncing is optional and needs a per-device opt-in", async () => {
    for (const mode of ["available-not-opted-in", "opted-in"] as const) {
      cleanup();
      renderPage(mode);
      await flush();
      const text = card();
      expect(text).toMatch(/saved in this browser on this device, and clearing site data removes them/);
      expect(text).toMatch(/Syncing between your devices is optional: it stays off until you turn it on for this device in “Sync between devices” below\./);
      expect(text).not.toMatch(/Your data stays on this device/);
      expect(text).not.toMatch(/yet|later update|don’t sync/);
      // the card it points to really is on the page in this configuration
      expect(screen.getByText("Sync between devices")).toBeTruthy();
    }
  });

  it("the Sync card the text points to is absent when sync is unavailable", async () => {
    for (const mode of ["no-sync-provider", "flag-off"] as const) {
      cleanup();
      renderPage(mode);
      await flush();
      expect(screen.queryByText("Sync between devices")).toBeNull();
    }
  });
});
