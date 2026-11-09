// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudyDataProvider, useStudyData } from "@/features/data/study-data-provider";
import { SettingsProvider } from "@/features/settings/settings-provider";
import { SyncProvider, useSync } from "@/features/sync/sync-provider";
import { SyncBanner, SyncCard } from "@/features/sync/sync-ui";
import { TimerProvider, useTimer } from "@/features/timer/timer-provider";
import { accountKey, createAccountStore } from "@/lib/account-store";
import { listSyncBackups, loadBaseline, saveBaseline, saveSyncEnabled } from "@/lib/sync/device-store";
import { fromSyncSnapshot } from "@/lib/sync/from-snapshot";
import { serializeData } from "@/lib/storage";
import { createFakeSyncServer, type FakeSyncServer } from "./helpers/fake-sync-server";
import { baseSnapshot } from "./helpers/merge-fixtures";
import { createMemoryStorage } from "./helpers/memory-storage";
import { canon, seed, ses } from "./helpers/sync-plan-harness";
import type { SyncChange } from "@/lib/sync/changes";
import type { SyncApi } from "@/lib/sync/api";

afterEach(cleanup);
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }));
afterEach(() => vi.useRealTimers());

const USER = "user-a";
const pulls = (s: FakeSyncServer) => s.calls.filter((c) => c.fn === "pull_snapshot").length;
const pushes = (s: FakeSyncServer) => s.calls.filter((c) => c.fn === "push_changes").length;
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const serverIds = (s: FakeSyncServer, list: "classes" | "sessions") => canon(s.state(USER).snapshot)[list].map((x) => x.id);

async function setup(opts: { enabled?: boolean; linked?: boolean; buildEnabled?: boolean; api?: (real: SyncApi) => SyncApi; changeDelayMs?: number } = {}) {
  const { enabled = true, linked = true, buildEnabled = true } = opts;
  const server = createFakeSyncServer();
  const pulled = await seed(server, USER, baseSnapshot());
  const initial = fromSyncSnapshot(pulled.snapshot);
  if (!initial.ok) throw new Error("bad seed");
  const mem = createMemoryStorage({ [accountKey(USER, "data")]: serializeData(initial.data) });
  if (linked) saveBaseline(mem, USER, pulled);
  if (enabled) saveSyncEnabled(mem, USER, true);
  const real = server.apiFor(USER);
  const api = opts.api ? opts.api(real) : real;
  const getStorage = () => mem;
  const store = createAccountStore(USER, getStorage);
  const hook = renderHook(() => ({ sync: useSync(), data: useStudyData(), timer: useTimer() }), {
    wrapper: ({ children }) => (
      <SettingsProvider>
        <StudyDataProvider store={store}>
          <TimerProvider getStorage={getStorage}>
            <SyncProvider userId={USER} api={api} getStorage={getStorage} buildEnabled={buildEnabled} changeDelayMs={opts.changeDelayMs ?? 3000}>
              {children}
            </SyncProvider>
          </TimerProvider>
        </StudyDataProvider>
      </SettingsProvider>
    ),
  });
  const other = server.apiFor(USER);
  /** Another device adds a session on the server. */
  const remoteAddSession = async (id: string) => {
    const { revision } = await other.pullSnapshot();
    const s = ses(id, "A", null, 70_000, 120);
    await other.pushChanges(revision, [{ op: "add_session", id, classId: "A", groupId: null, startedAt: s.startedAt, seconds: s.seconds, mode: s.mode } as SyncChange]);
  };
  return { server, mem, pulled, hook, other, remoteAddSession, api };
}

describe("sync off", () => {
  it("the build flag off: not available, nothing runs, even if the device setting is on", async () => {
    const { server, hook } = await setup({ buildEnabled: false });
    const calls = server.calls.length;
    await advance(60_000);
    expect(hook.result.current.sync).toMatchObject({ available: false, enabled: false, status: "off" });
    expect(server.calls).toHaveLength(calls);
    act(() => hook.result.current.sync.setEnabled(true));
    await advance(60_000);
    expect(server.calls).toHaveLength(calls);
    expect(hook.result.current.data.classes.map((c) => c.id)).toEqual(["A", "B"]); // local data untouched
  });

  it("flag on but the device has not opted in: nothing runs until the user turns it on", async () => {
    const { server, mem, hook } = await setup({ enabled: false });
    const calls = server.calls.length;
    await advance(60_000);
    expect(hook.result.current.sync).toMatchObject({ available: true, enabled: false, status: "off" });
    expect(server.calls).toHaveLength(calls);
    act(() => hook.result.current.sync.setEnabled(true));
    await advance(10);
    expect(mem.map.get(`studytime:u:${USER}:sync:enabled`)).toBe("1");
    expect(hook.result.current.sync.status).toBe("synced");
    expect(pulls(server)).toBeGreaterThan(0);
  });

  it("turning it off stops everything again", async () => {
    const { server, hook } = await setup();
    await advance(10);
    act(() => hook.result.current.sync.setEnabled(false));
    const calls = server.calls.length;
    act(() => void window.dispatchEvent(new Event("online")));
    await advance(60_000);
    expect(hook.result.current.sync.status).toBe("off");
    expect(server.calls).toHaveLength(calls);
  });

  it("a device that is not linked says so and uploads nothing", async () => {
    const { server, hook } = await setup({ linked: false });
    await advance(10);
    expect(hook.result.current.sync.status).toBe("not_linked");
    expect(hook.result.current.sync.message).toMatch(/isn’t linked/);
    expect(pushes(server)).toBe(0);
  });
});

describe("triggers", () => {
  it("app start pulls the other device's changes, after a backup, and applying them does not cause another pass", async () => {
    const { server, mem, hook, remoteAddSession } = await setup();
    await remoteAddSession("far-1");
    // the start pass already ran for the seeded state; run again through the manual path to pick up the change
    await act(async () => void (await hook.result.current.sync.syncNow()));
    expect(hook.result.current.data.sessions.map((s) => s.id)).toContain("far-1");
    expect(listSyncBackups(mem, USER)).toHaveLength(1);
    expect(hook.result.current.sync.status).toBe("synced");
    const pullsAfter = pulls(server);
    await advance(120_000);
    expect(pulls(server)).toBe(pullsAfter); // our own apply is not a new local change
  });

  it("a local change syncs after a short delay, and several quick changes make one pass", async () => {
    const { server, hook } = await setup();
    await advance(10);
    const before = pulls(server);
    act(() => void hook.result.current.data.addClass("Biology"));
    await advance(1_000);
    act(() => void hook.result.current.data.addClass("Chemistry"));
    await advance(2_500);
    expect(pulls(server)).toBe(before); // still within the delay of the last change
    await advance(1_000);
    expect(pulls(server)).toBe(before + 1);
    expect(serverIds(server, "classes")).toHaveLength(4);
    expect(hook.result.current.sync.status).toBe("synced");
  });

  it("the network coming back starts a pass", async () => {
    const { server, hook } = await setup();
    await advance(10);
    const before = pulls(server);
    act(() => void window.dispatchEvent(new Event("online")));
    await advance(10);
    expect(pulls(server)).toBe(before + 1);
    expect(hook.result.current.sync.status).toBe("synced");
  });

  it("coming back to the app starts a pass, but not more than once per throttle window", async () => {
    const { server } = await setup();
    await advance(10);
    const before = pulls(server);
    act(() => void window.dispatchEvent(new Event("focus")));
    await advance(10);
    expect(pulls(server)).toBe(before); // too soon after the last pass
    await advance(31_000);
    act(() => void window.dispatchEvent(new Event("focus")));
    await advance(10);
    expect(pulls(server)).toBe(before + 1);
  });

  it("there is no polling: nothing runs on its own while the app sits idle", async () => {
    const { server } = await setup();
    await advance(10);
    const calls = server.calls.length;
    await advance(30 * 60_000);
    expect(server.calls).toHaveLength(calls);
  });
});

describe("a running timer", () => {
  it("automatic passes wait for the timer to stop, then run; the session is synced", async () => {
    const { server, hook } = await setup();
    await advance(10);
    act(() => hook.result.current.timer.setClassId("B"));
    act(() => hook.result.current.timer.start());
    const before = pulls(server);
    act(() => void hook.result.current.data.addClass("Biology"));
    await advance(20_000);
    act(() => void window.dispatchEvent(new Event("online")));
    await advance(20_000);
    expect(pulls(server)).toBe(before); // nothing while the timer runs
    act(() => hook.result.current.timer.stop());
    await advance(3_500);
    expect(pulls(server)).toBe(before + 1);
    expect(serverIds(server, "classes")).toHaveLength(3);
    // the session recorded by the timer reached the server too (a very short one may be dropped by the timer itself)
    expect(serverIds(server, "sessions").sort()).toEqual(hook.result.current.data.sessions.map((s) => s.id).sort());
  });

  it("Sync now works during a session and the timer's class cannot be deleted by the merge", async () => {
    const { server, hook } = await setup();
    await advance(10);
    act(() => hook.result.current.timer.setClassId("B"));
    act(() => hook.result.current.timer.start());
    // another device deletes class B
    const other = server.apiFor(USER);
    const now = await other.pullSnapshot();
    await other.pushChanges(now.revision, [{ op: "delete_class", id: "B", expectedSessions: 2 }]);
    await act(async () => void (await hook.result.current.sync.syncNow()));
    expect(hook.result.current.sync.status).toBe("attention");
    expect(hook.result.current.data.classes.map((c) => c.id)).toContain("B"); // still here, the timer keeps its class
    expect(hook.result.current.timer.state.status).toBe("running");
  });
});

describe("failures never take local data away", () => {
  it("offline: shows offline, keeps working, and retries by itself", async () => {
    const { server, hook } = await setup();
    await advance(10);
    server.setMode("network_down");
    act(() => void hook.result.current.data.addClass("Biology"));
    await advance(3_100);
    expect(hook.result.current.sync.status).toBe("offline");
    expect(hook.result.current.data.classes.map((c) => c.name)).toContain("Biology");
    server.setMode("normal");
    await advance(30_100);
    expect(hook.result.current.sync.status).toBe("synced");
    expect(serverIds(server, "classes")).toHaveLength(3);
  });

  it("a server error is shown with a message, local data keeps working, and Sync now retries", async () => {
    const { server, hook } = await setup();
    await advance(10);
    server.setMode("server_error");
    await act(async () => void (await hook.result.current.sync.syncNow()));
    expect(hook.result.current.sync.status).toBe("attention");
    expect(hook.result.current.sync.message).toMatch(/isn’t responding/);
    act(() => void hook.result.current.data.addClass("Biology"));
    expect(hook.result.current.data.classes).toHaveLength(3);
    server.setMode("normal");
    await act(async () => void (await hook.result.current.sync.syncNow()));
    expect(hook.result.current.sync.status).toBe("synced");
    expect(serverIds(server, "classes")).toHaveLength(3);
  });

  it("a conflict is shown and nothing is pushed or changed", async () => {
    const { server, hook, other } = await setup();
    await advance(10);
    const remote = await other.pullSnapshot();
    await other.pushChanges(remote.revision, [{ op: "update_class", id: "A", name: "Calculus" }]);
    act(() => void hook.result.current.data.renameClass("A", "Maths"));
    const pushesBefore = pushes(server);
    await act(async () => void (await hook.result.current.sync.syncNow()));
    expect(hook.result.current.sync.status).toBe("attention");
    expect(hook.result.current.sync.message).toMatch(/different ways/);
    expect(pushes(server)).toBe(pushesBefore);
    expect(hook.result.current.data.classes.find((c) => c.id === "A")?.name).toBe("Maths");
  });

  it("the baseline is saved per account after a good pass", async () => {
    const { mem, hook } = await setup();
    await advance(10);
    expect(hook.result.current.sync.status).toBe("synced");
    expect(loadBaseline(mem, USER)).not.toBeNull();
  });
});

describe("the settings card and the banner", () => {
  async function shell(opts: Parameters<typeof setup>[0] = {}) {
    const server = createFakeSyncServer();
    const pulled = await seed(server, USER, baseSnapshot());
    const initial = fromSyncSnapshot(pulled.snapshot);
    if (!initial.ok) throw new Error("bad seed");
    const mem = createMemoryStorage({ [accountKey(USER, "data")]: serializeData(initial.data) });
    saveBaseline(mem, USER, pulled);
    if (opts.enabled) saveSyncEnabled(mem, USER, true);
    const getStorage = () => mem;
    const store = createAccountStore(USER, getStorage);
    const api = server.apiFor(USER);
    render(
      <SettingsProvider>
        <StudyDataProvider store={store}>
          <TimerProvider getStorage={getStorage}>
            <SyncProvider userId={USER} api={api} getStorage={getStorage} buildEnabled={opts.buildEnabled ?? true}>
              <SyncBanner />
              <SyncCard />
            </SyncProvider>
          </TimerProvider>
        </StudyDataProvider>
      </SettingsProvider>,
    );
    return { server, mem };
  }

  it("with the flag off the card renders nothing", async () => {
    await shell({ buildEnabled: false });
    expect(screen.queryByText("Sync between devices")).toBeNull();
  });

  it("the card turns sync on for this device and offers Sync now", async () => {
    const { server } = await shell();
    expect(screen.getByText("Sync between devices")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Sync now/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Turn on sync on this device" }));
    await advance(10);
    expect(screen.getByRole("button", { name: /Sync now/ })).toBeTruthy();
    expect(screen.getByText("Synced")).toBeTruthy();
    const before = pulls(server);
    fireEvent.click(screen.getByRole("button", { name: /Sync now/ }));
    await advance(10);
    expect(pulls(server)).toBe(before + 1);
    fireEvent.click(screen.getByRole("button", { name: "Turn off sync on this device" }));
    expect(screen.queryByRole("button", { name: /Sync now/ })).toBeNull();
  });

  it("the banner appears while offline, with a Retry that works", async () => {
    const { server } = await shell({ enabled: true });
    await advance(10);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    server.setMode("network_down");
    fireEvent.click(screen.getByRole("button", { name: /Sync now/ }));
    await advance(10);
    expect(screen.getAllByText(/You’re offline/).length).toBeGreaterThan(0);
    server.setMode("normal");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await advance(10);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
