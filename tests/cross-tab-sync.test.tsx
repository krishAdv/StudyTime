// @vitest-environment jsdom
import { act, cleanup, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudyDataProvider, useStudyData } from "@/features/data/study-data-provider";
import { SettingsProvider } from "@/features/settings/settings-provider";
import { SyncProvider, useSync } from "@/features/sync/sync-provider";
import { SyncBanner, SyncCard } from "@/features/sync/sync-ui";
import { TimerProvider, useTimer } from "@/features/timer/timer-provider";
import { accountKey, createAccountStore } from "@/lib/account-store";
import type { SyncApi } from "@/lib/sync/api";
import { loadBaseline, saveBaseline, saveSyncEnabled } from "@/lib/sync/device-store";
import { createSyncEngine } from "@/lib/sync/engine";
import { createEscapes } from "@/lib/sync/escape";
import { fromSyncSnapshot } from "@/lib/sync/from-snapshot";
import { createLinker } from "@/lib/sync/link";
import { serializeData, type StoredData } from "@/lib/storage";
import { createFakeSyncServer, type FakeSyncServer } from "./helpers/fake-sync-server";
import { baseSnapshot } from "./helpers/merge-fixtures";
import { createMemoryStorage } from "./helpers/memory-storage";
import { cls, seed, snap } from "./helpers/sync-plan-harness";

afterEach(cleanup);
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }));
afterEach(() => vi.useRealTimers());

const USER = "user-a";
const DATA_KEY = accountKey(USER, "data");
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const calls = (s: FakeSyncServer, fn: string) => s.calls.filter((c) => c.fn === fn).length;
const serverClassIds = (s: FakeSyncServer) => s.state(USER).snapshot.classes.map((c) => c.id).sort();
const storageEvent = () => act(() => void window.dispatchEvent(new StorageEvent("storage", { key: DATA_KEY })));
const asData = (snapshot: ReturnType<typeof baseSnapshot>): StoredData => {
  const r = fromSyncSnapshot(snapshot);
  if (!r.ok) throw new Error("bad test data");
  return r.data;
};

/** A linked, opted-in tab with data equal to the cloud's, over a storage that "another tab" can also write to. */
async function setup(wrap?: (api: SyncApi, mem: ReturnType<typeof createMemoryStorage>) => SyncApi) {
  const server = createFakeSyncServer();
  const pulled = await seed(server, USER, baseSnapshot());
  const mem = createMemoryStorage({ [DATA_KEY]: serializeData(asData(pulled.snapshot)) });
  saveBaseline(mem, USER, pulled);
  saveSyncEnabled(mem, USER, true);
  const getStorage = () => mem;
  const store = createAccountStore(USER, getStorage);
  const real = server.apiFor(USER);
  const api = wrap ? wrap(real, mem) : real;
  const hook = renderHook(() => ({ sync: useSync(), data: useStudyData(), timer: useTimer() }), {
    wrapper: ({ children }) => (
      <SettingsProvider>
        <StudyDataProvider store={store}>
          <TimerProvider>
            <SyncProvider userId={USER} api={api} getStorage={getStorage} buildEnabled>
              <SyncBanner />
              <SyncCard />
              {children}
            </SyncProvider>
          </TimerProvider>
        </StudyDataProvider>
      </SettingsProvider>
    ),
  });
  await advance(50); // the first pass at start: nothing differs
  /** What another tab does: gets a new class from the cloud, saves the data AND the new baseline locally. */
  const otherTabReceivesNewClass = async () => {
    const other = server.apiFor(USER);
    const cur = await other.pullSnapshot();
    await other.pushChanges(cur.revision, [{ op: "add_class", id: "N", name: "New from the cloud", color: "#000000" }]);
    const after = await other.pullSnapshot();
    mem.setItem(DATA_KEY, serializeData(asData(after.snapshot)));
    saveBaseline(mem, USER, after);
  };
  return { server, mem, hook, otherTabReceivesNewClass };
}

describe("sync in a tab that is up to date (control)", () => {
  it("still syncs a local change as before", async () => {
    const { server, hook } = await setup();
    act(() => void hook.result.current.data.addClass("Local"));
    await advance(3_100);
    expect(calls(server, "push_changes")).toBe(1);
    expect(serverClassIds(server)).toContain("A");
    expect(hook.result.current.sync.paused).toBe(false);
    expect(hook.result.current.data.staleTab).toBe(false);
  });
});

describe("a stale tab never syncs (the deletion scenario from the audit)", () => {
  it("does not push this tab's older copy, so the other tab's new class is not deleted from the cloud", async () => {
    const { server, mem, hook, otherTabReceivesNewClass } = await setup();
    await otherTabReceivesNewClass(); // the cloud and the shared local storage now hold class N; this tab has never seen it
    storageEvent();
    expect(hook.result.current.data.staleTab).toBe(true);
    expect(hook.result.current.data.classes.map((c) => c.id)).not.toContain("N"); // this tab really is out of date

    const pushesBefore = calls(server, "push_changes");
    const pullsBefore = calls(server, "pull_snapshot");
    const storedBefore = mem.getItem(DATA_KEY);
    const baselineBefore = JSON.stringify(loadBaseline(mem, USER));

    // the user keeps clicking in the stale tab
    act(() => void hook.result.current.data.addClass("Edit in the stale tab"));
    act(() => void hook.result.current.data.deleteClass("A"));
    await advance(60_000);
    await act(async () => void (await hook.result.current.sync.syncNow()));
    await advance(60_000);

    expect(calls(server, "push_changes")).toBe(pushesBefore); // nothing was pushed
    expect(calls(server, "pull_snapshot")).toBe(pullsBefore); // not even a pass ran
    expect(serverClassIds(server)).toContain("N"); // the class from the other tab is still in the cloud
    expect(mem.getItem(DATA_KEY)).toBe(storedBefore); // and in the shared local storage
    expect(JSON.stringify(loadBaseline(mem, USER))).toBe(baselineBefore); // the baseline was not touched
  });

  it("a session finished in the stale tab is not synced either", async () => {
    const { server, hook, otherTabReceivesNewClass } = await setup();
    await otherTabReceivesNewClass();
    storageEvent();
    act(() => hook.result.current.data.logSession({ id: "late-1", classId: "A", groupId: null, startedAt: 1_700_002_000_000, seconds: 90, mode: "stopwatch" }));
    await advance(60_000);
    expect(calls(server, "push_changes")).toBe(1); // only the other tab's own push from the test setup
    expect(server.state(USER).snapshot.sessions.map((s) => s.id)).not.toContain("late-1");
  });

  it("a stale tab that finishes a real timer keeps the session in memory only: nothing is saved, nothing is pushed, and it is gone after a reload", async () => {
    const { server, mem, hook, otherTabReceivesNewClass } = await setup();
    await otherTabReceivesNewClass();
    storageEvent();
    expect(hook.result.current.data.staleTab).toBe(true);
    const stored = mem.getItem(DATA_KEY);
    const baseline = JSON.stringify(loadBaseline(mem, USER));
    const pushes = calls(server, "push_changes");
    const pulls = calls(server, "pull_snapshot");

    act(() => hook.result.current.timer.setClassId("A"));
    act(() => hook.result.current.timer.start());
    await advance(5_000);
    act(() => hook.result.current.timer.stop());
    await advance(60_000); // long enough for any automatic pass

    const known = new Set(baseSnapshot().sessions.map((s) => s.id));
    const logged = hook.result.current.data.sessions.filter((s) => !known.has(s.id));
    expect(hook.result.current.timer.state.status).toBe("idle");
    expect(logged).toHaveLength(1); // in memory: visible in this tab and part of "Download this tab's data"
    expect(logged[0]).toMatchObject({ classId: "A", mode: "stopwatch" });
    expect(logged[0].seconds).toBeGreaterThanOrEqual(5);

    expect(mem.getItem(DATA_KEY)).toBe(stored); // localStorage was not overwritten
    expect(mem.getItem(DATA_KEY)).not.toContain(logged[0].id);
    expect(JSON.stringify(loadBaseline(mem, USER))).toBe(baseline); // the sync baseline was not touched
    expect(calls(server, "push_changes")).toBe(pushes); // nothing was pushed to the server
    expect(calls(server, "pull_snapshot")).toBe(pulls); // and no sync pass even started
    expect(server.state(USER).snapshot.sessions.map((s) => s.id)).not.toContain(logged[0].id);
    expect(serverClassIds(server)).toContain("N"); // the other tab's class is still in the cloud

    // a reload starts from what was really saved: the session was never persisted
    hook.unmount();
    cleanup();
    const reloaded = createAccountStore(USER, () => mem).load() as StoredData; // the account store is synchronous
    expect(reloaded.sessions.map((s) => s.id)).not.toContain(logged[0].id);
  });

  it("says why: sync is shown as paused, the Sync now button is disabled, and no retry banner is offered", async () => {
    const { hook, otherTabReceivesNewClass } = await setup();
    await otherTabReceivesNewClass();
    storageEvent();
    expect(hook.result.current.sync.paused).toBe(true);
    expect(screen.getByText(/Sync is paused because StudyTime was changed in another tab/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Sync now/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("linking and the escape actions are blocked too (no request is made)", async () => {
    const { server, hook, otherTabReceivesNewClass } = await setup();
    await otherTabReceivesNewClass();
    storageEvent();
    const before = server.calls.length;
    await act(async () => {
      await hook.result.current.sync.link.refresh();
      await hook.result.current.sync.escape.open();
    });
    expect(server.calls.length).toBe(before);
    expect(hook.result.current.sync.escape.phase).toBe("none");
  });

  it("RECOVERY: after a reload the tab holds the newer data, is not stale, and syncs normally again", async () => {
    const { server, mem, hook, otherTabReceivesNewClass } = await setup();
    await otherTabReceivesNewClass();
    storageEvent();
    expect(hook.result.current.sync.paused).toBe(true);
    hook.unmount();
    cleanup();

    // the reloaded page: fresh stores and providers over the same storage
    const getStorage = () => mem;
    const store = createAccountStore(USER, getStorage);
    const reloaded = renderHook(() => ({ sync: useSync(), data: useStudyData() }), {
      wrapper: ({ children }) => (
        <SettingsProvider>
          <StudyDataProvider store={store}>
            <TimerProvider>
              <SyncProvider userId={USER} api={server.apiFor(USER)} getStorage={getStorage} buildEnabled>
                {children}
              </SyncProvider>
            </TimerProvider>
          </StudyDataProvider>
        </SettingsProvider>
      ),
    });
    await advance(50);
    expect(reloaded.result.current.data.staleTab).toBe(false);
    expect(reloaded.result.current.sync.paused).toBe(false);
    expect(reloaded.result.current.data.classes.map((c) => c.id)).toContain("N"); // it has the other tab's class
    const pushes = calls(server, "push_changes");
    act(() => void reloaded.result.current.data.addClass("After reload"));
    await advance(3_100);
    expect(calls(server, "push_changes")).toBe(pushes + 1);
    expect(serverClassIds(server)).toContain("N"); // and the class was never deleted
  });
});

describe("a sync pass already running when the other tab writes", () => {
  it("is stopped before it pushes: nothing from the older copy reaches the cloud", async () => {
    let writeOtherTabOnNextPull = false;
    const { server, mem, hook } = await setup((api, shared) => ({
      ...api,
      pullSnapshot: async () => {
        const r = await api.pullSnapshot();
        if (writeOtherTabOnNextPull) {
          writeOtherTabOnNextPull = false;
          shared.setItem(DATA_KEY, serializeData(asData({ ...baseSnapshot(), classes: [...baseSnapshot().classes, cls("N", "Other tab")] }))); // no event arrives
        }
        return r;
      },
    }));
    act(() => void hook.result.current.data.addClass("My local class")); // a normal change: the pass will want to push it
    writeOtherTabOnNextPull = true;
    const pushesBefore = calls(server, "push_changes");
    await advance(3_100); // the pass starts; during its pull the other tab writes
    expect(calls(server, "push_changes")).toBe(pushesBefore); // refused before pushing
    expect(hook.result.current.data.staleTab).toBe(true);
    expect(hook.result.current.sync.paused).toBe(true);
    expect(serverClassIds(server)).not.toContain("My local class");
    expect(mem.getItem(DATA_KEY)).toContain("Other tab"); // the other tab's data is what is stored
  });
});

describe("the guard inside the engine, first link and Replace cloud", () => {
  it("the engine pushes nothing and says why when this device's data is no longer current", async () => {
    const server = createFakeSyncServer();
    const pulled = await seed(server, USER, baseSnapshot());
    const edited = asData({ ...baseSnapshot(), classes: [...baseSnapshot().classes, cls("L1", "Local only")] });
    let current = false;
    const engine = createSyncEngine({
      api: server.apiFor(USER), loadBaseline: () => pulled, saveBaseline: () => {}, getLocal: () => edited, replaceLocal: () => true, backup: () => {},
      isLocalCurrent: () => current,
    });
    const pushes = calls(server, "push_changes");
    const out = await engine.syncOnce();
    expect(out).toMatchObject({ status: "refused", reason: "local_changed_elsewhere" });
    expect(calls(server, "push_changes")).toBe(pushes);
    current = true;
    expect(await engine.syncOnce()).toMatchObject({ status: "synced" }); // without the problem it pushes as usual
    expect(serverClassIds(server)).toContain("L1");
  });

  it("first-link upload sends nothing when this device's data is no longer current", async () => {
    const server = createFakeSyncServer();
    const local = asData(snap([cls("M1", "Mine")]));
    const deps = {
      api: server.apiFor(USER), loadBaseline: () => null, saveBaseline: () => {}, getLocal: () => local, replaceLocal: () => true, backup: () => {},
      isLocalCurrent: () => false,
    };
    const linker = createLinker(deps);
    const seen = await linker.inspect();
    if (seen.status !== "ok") throw new Error("inspect");
    const out = await linker.link("upload", seen.inspection.fingerprint);
    expect(out).toMatchObject({ status: "refused" });
    expect(calls(server, "import_and_init_sync")).toBe(0);
  });

  it("Replace cloud sends nothing and saves no copies when this device's data is no longer current", async () => {
    const server = createFakeSyncServer();
    const pulled = await seed(server, USER, baseSnapshot());
    const b = baseSnapshot();
    const local = asData({ classes: b.classes.filter((c) => c.id === "A"), groups: b.groups.filter((g) => g.classId === "A"), sessions: b.sessions.filter((x) => x.classId === "A") });
    const backups: unknown[] = [];
    const deps = {
      api: server.apiFor(USER), loadBaseline: () => pulled, saveBaseline: () => {}, getLocal: () => local, replaceLocal: () => true, backup: (d: StoredData) => void backups.push(d),
      isLocalCurrent: () => false,
    };
    const escapes = createEscapes(deps);
    const seen = await escapes.inspect();
    if (seen.status !== "ok") throw new Error("inspect");
    const pushes = calls(server, "push_changes");
    expect(await escapes.run("replace_cloud", seen.inspection.fingerprint)).toMatchObject({ status: "refused" });
    expect(calls(server, "push_changes")).toBe(pushes);
    expect(backups).toEqual([]); // and no safety copy was written either
  });
});
