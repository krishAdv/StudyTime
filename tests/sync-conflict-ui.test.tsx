// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudyDataProvider, useStudyData } from "@/features/data/study-data-provider";
import { SettingsProvider } from "@/features/settings/settings-provider";
import { SyncProvider } from "@/features/sync/sync-provider";
import { SyncCard } from "@/features/sync/sync-ui";
import { TimerProvider, useTimer } from "@/features/timer/timer-provider";
import { accountKey, createAccountStore } from "@/lib/account-store";
import type { SyncChange } from "@/lib/sync/changes";
import { listSyncBackups, loadBaseline, saveBaseline, saveSyncEnabled } from "@/lib/sync/device-store";
import { planReplaceCloud } from "@/lib/sync/escape";
import { fromSyncSnapshot } from "@/lib/sync/from-snapshot";
import type { SyncSnapshot } from "@/lib/sync/snapshot";
import { serializeData } from "@/lib/storage";
import { createFakeSyncServer, type FakeSyncServer } from "./helpers/fake-sync-server";
import { baseSnapshot } from "./helpers/merge-fixtures";
import { createMemoryStorage } from "./helpers/memory-storage";
import { canon, seed } from "./helpers/sync-plan-harness";

afterEach(cleanup);
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }));
afterEach(() => vi.useRealTimers());

const USER = "user-a";
const EMAIL = "her@example.com";
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const click = async (name: string | RegExp) => {
  fireEvent.click(screen.getByRole("button", { name }));
  await advance(10);
};
const pushes = (s: FakeSyncServer) => s.calls.filter((c) => c.fn === "push_changes").length;

const latest = {} as { data: ReturnType<typeof useStudyData>; timer: ReturnType<typeof useTimer> };
function Probe() {
  const live = { data: useStudyData(), timer: useTimer() };
  useEffect(() => void Object.assign(latest, live));
  return null;
}

/** A linked device (baseline = the seeded base) whose local data is `local`, while the cloud got `cloudOps` from elsewhere. */
async function shell(local: SyncSnapshot, cloudOps: (cloud: SyncSnapshot) => SyncChange[]) {
  const server = createFakeSyncServer();
  const pulled = await seed(server, USER, baseSnapshot());
  const api = server.apiFor(USER);
  const ops = cloudOps(pulled.snapshot);
  if (ops.length) await api.pushChanges(pulled.revision, ops);
  const init = fromSyncSnapshot(local);
  if (!init.ok) throw new Error("bad local");
  const mem = createMemoryStorage({ [accountKey(USER, "data")]: serializeData(init.data) });
  saveBaseline(mem, USER, pulled);
  saveSyncEnabled(mem, USER, true);
  const getStorage = () => mem;
  render(
    <SettingsProvider>
      <StudyDataProvider store={createAccountStore(USER, getStorage)}>
        <TimerProvider getStorage={getStorage}>
          <SyncProvider userId={USER} accountLabel={EMAIL} api={server.apiFor(USER)} getStorage={getStorage} buildEnabled>
            <Probe />
            <SyncCard />
          </SyncProvider>
        </TimerProvider>
      </StudyDataProvider>
    </SettingsProvider>,
  );
  await advance(50);
  return { server, mem };
}

const renamedLocal = () => {
  const s = baseSnapshot();
  s.classes[0].name = "Maths";
  return s;
};
const renameCloud = (): ((c: SyncSnapshot) => SyncChange[]) => () => [{ op: "update_class", id: "A", name: "Calculus" }];

/** The cloud lost session s2 the way another device's "replace cloud" would do it: an unresolvable difference. */
const cloudLosesS2 = (c: SyncSnapshot): SyncChange[] => {
  const plan = planReplaceCloud(c, { ...c, sessions: c.sessions.filter((x) => x.id !== "s2") });
  if (!plan.ok) throw new Error("plan");
  return plan.ops;
};

const openDetails = async (summary: RegExp) => {
  const details = screen.getByText(summary).closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await advance(10);
};

describe("the conflict screen", () => {
  it("shows what differs in plain language and pushes nothing until the choice is applied", async () => {
    const { server } = await shell(renamedLocal(), renameCloud());
    expect(screen.getByText("This device and the cloud disagree")).toBeTruthy();
    expect(screen.getByText(/renamed on both sides/)).toBeTruthy();
    expect(screen.getByText(/“Maths”. The cloud calls it “Calculus”/)).toBeTruthy();
    expect(screen.getByText("Use “Maths”")).toBeTruthy();
    expect(screen.getByText("Use “Calculus”")).toBeTruthy();
    await advance(120_000);
    expect(pushes(server)).toBe(1); // only the cloud's own change from elsewhere
    expect((screen.getByRole("button", { name: "Apply my choices" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("applying the chosen option runs through the engine and clears the screen", async () => {
    const { server, mem } = await shell(renamedLocal(), renameCloud());
    fireEvent.click(screen.getByLabelText(/Use “Maths”/));
    expect((screen.getByRole("button", { name: "Apply my choices" }) as HTMLButtonElement).disabled).toBe(false);
    await click("Apply my choices");
    expect(canon(server.state(USER).snapshot).classes.find((c) => c.id === "A")!.name).toBe("Maths");
    expect(screen.queryByText("This device and the cloud disagree")).toBeNull();
    expect(screen.getByText("Synced")).toBeTruthy();
    expect(loadBaseline(mem, USER)!.revision).toBe(server.state(USER).revision);
  });

  it("choosing the cloud's version changes this device, with a safety copy", async () => {
    const { mem } = await shell(renamedLocal(), renameCloud());
    fireEvent.click(screen.getByLabelText(/Use “Calculus”/));
    await click("Apply my choices");
    expect(latest.data.classes[0].name).toBe("Calculus");
    expect(listSyncBackups(mem, USER).length).toBeGreaterThan(0);
  });

  it("an unresolvable difference blocks Apply and points to the escape actions", async () => {
    await shell(baseSnapshot(), cloudLosesS2);
    expect(screen.getByText("A study session is missing on one side")).toBeTruthy();
    expect(screen.getByText(/can’t be settled one by one/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply my choices" })).not.toBeNull();
    expect((screen.getByRole("button", { name: "Apply my choices" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("use the cloud's data", () => {
  it("needs the checkbox, saves a safety copy, replaces this device and advances the baseline", async () => {
    const { server, mem } = await shell(baseSnapshot(), cloudLosesS2);
    const before = pushes(server);
    await openDetails(/Not working out/);
    expect(screen.getByText(/1 session exists only on this device/)).toBeTruthy();
    await click("Use the cloud’s data");
    expect(screen.getByText("Replace this device’s data with the cloud’s?")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Yes, replace this device’s data" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I understand that changes on this device/));
    await click("Yes, replace this device’s data");
    expect(latest.data.sessions.map((s) => s.id)).not.toContain("s2");
    const copies = listSyncBackups(mem, USER);
    expect(copies.at(-1)!.reason).toBe("before_use_cloud");
    expect(copies.at(-1)!.data.sessions.map((s) => s.id)).toContain("s2");
    expect(pushes(server)).toBe(before); // the cloud is untouched
    expect(loadBaseline(mem, USER)!.revision).toBe(server.state(USER).revision);
    expect(screen.queryByText("This device and the cloud disagree")).toBeNull();
  });

  it("is blocked while a timer runs", async () => {
    await shell(baseSnapshot(), cloudLosesS2);
    await openDetails(/Not working out/);
    await click("Use the cloud’s data");
    act(() => latest.timer.setClassId("A"));
    act(() => latest.timer.start());
    expect(screen.getByText(/Stop the timer first/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/I understand that changes on this device/));
    expect((screen.getByRole("button", { name: "Yes, replace this device’s data" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a stale confirmation (the cloud changed meanwhile) does nothing", async () => {
    const { server, mem } = await shell(baseSnapshot(), cloudLosesS2);
    await openDetails(/Not working out/);
    await click("Use the cloud’s data");
    fireEvent.click(screen.getByLabelText(/I understand that changes on this device/));
    const api = server.apiFor(USER);
    const cur = await api.pullSnapshot();
    await api.pushChanges(cur.revision, [{ op: "add_class", id: "N", name: "New", color: "#000000" }]);
    await click("Yes, replace this device’s data");
    expect(screen.getByText(/Something changed while you were deciding/)).toBeTruthy();
    expect(latest.data.sessions.map((s) => s.id)).toContain("s2");
    expect(listSyncBackups(mem, USER)).toEqual([]);
  });
});

describe("replace the cloud's data", () => {
  it("states what disappears, needs the checkbox, saves both copies and verifies before finishing", async () => {
    const { server, mem } = await shell(baseSnapshot(), (c) => [
      ...cloudLosesS2(c),
    ]);
    // the cloud also has a session this device does not
    const api = server.apiFor(USER);
    const cur = await api.pullSnapshot();
    await api.pushChanges(cur.revision, [{ op: "add_session", id: "cloud-only", classId: "B", groupId: null, startedAt: 8_000, seconds: 45, mode: "stopwatch" }]);
    await advance(40_000);
    await openDetails(/Not working out/);
    await click("Replace the cloud’s data");
    expect(screen.getByText(/1 session that exist only in the cloud will be removed from it/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Yes, replace the cloud’s data" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I understand the cloud’s data will be replaced/));
    await click("Yes, replace the cloud’s data");
    expect(canon(server.state(USER).snapshot)).toEqual(canon(baseSnapshot()));
    expect(latest.data.sessions).toHaveLength(4); // this device is untouched
    const reasons = listSyncBackups(mem, USER).map((c) => c.reason);
    expect(reasons).toEqual(expect.arrayContaining(["before_replace_cloud", "cloud_before_replace_cloud"]));
    const cloudCopy = listSyncBackups(mem, USER).find((c) => c.reason === "cloud_before_replace_cloud")!;
    expect(cloudCopy.data.sessions.map((s) => s.id)).toContain("cloud-only"); // nothing is lost without a copy
    expect(loadBaseline(mem, USER)!.revision).toBe(server.state(USER).revision);
    expect(screen.queryByText("This device and the cloud disagree")).toBeNull();
  });

  it("Cancel does nothing", async () => {
    const { server, mem } = await shell(baseSnapshot(), cloudLosesS2);
    const before = pushes(server);
    await openDetails(/Not working out/);
    await click("Replace the cloud’s data");
    await click("Cancel");
    expect(pushes(server)).toBe(before);
    expect(listSyncBackups(mem, USER)).toEqual([]);
  });
});

describe("safety copies", () => {
  it("are listed once something was replaced, and can be downloaded", async () => {
    await shell(renamedLocal(), renameCloud());
    fireEvent.click(screen.getByLabelText(/Use “Calculus”/));
    await click("Apply my choices");
    expect(screen.getByText(/Safety copies on this device \(1\)/)).toBeTruthy();
    expect(screen.getByText("This device, before newer cloud data was applied")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  });

  it("with sync off none of this is shown", async () => {
    const { mem } = await shell(renamedLocal(), renameCloud());
    fireEvent.click(screen.getByRole("button", { name: "Turn off sync on this device" }));
    await advance(10);
    expect(screen.queryByText("This device and the cloud disagree")).toBeNull();
    expect(screen.queryByText(/Not working out/)).toBeNull();
    expect(mem.map.get(`studytime:u:${USER}:sync:enabled`)).toBeUndefined();
  });
});
