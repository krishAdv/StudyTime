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
import { listSyncBackups, loadBaseline, saveSyncEnabled } from "@/lib/sync/device-store";
import { fromSyncSnapshot } from "@/lib/sync/from-snapshot";
import { toSyncSnapshot, type SyncSnapshot } from "@/lib/sync/snapshot";
import { serializeData } from "@/lib/storage";
import { createFakeSyncServer, type FakeSyncServer } from "./helpers/fake-sync-server";
import { createMemoryStorage } from "./helpers/memory-storage";
import { canon, cls, grp, ses, seed, snap } from "./helpers/sync-plan-harness";

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
const count = (s: FakeSyncServer, fn: string) => s.calls.filter((c) => c.fn === fn).length;

const mine = () => snap([cls("M1", "Mine")], [grp("MG", "M1", "Unit")], [ses("ms1", "M1", "MG", 5_000, 100)]);
const theirs = () => snap([cls("T1", "Theirs")], [], [ses("ts1", "T1", null, 6_000, 200)]);

const latest = {} as { data: ReturnType<typeof useStudyData>; timer: ReturnType<typeof useTimer> };
const hooks = latest;
function Probe() {
  const live = { data: useStudyData(), timer: useTimer() };
  useEffect(() => void Object.assign(latest, live));
  return null;
}

/** A device that opted in but is not linked yet, with `local` on it and `cloud` on the account. */
async function shell(local: SyncSnapshot, cloud: SyncSnapshot | null, wrap: (api: ReturnType<FakeSyncServer["apiFor"]>) => ReturnType<FakeSyncServer["apiFor"]> = (a) => a) {
  const server = createFakeSyncServer();
  if (cloud) await seed(server, USER, cloud);
  const seeded = count(server, "import_and_init_sync");
  const init = fromSyncSnapshot(local);
  if (!init.ok) throw new Error("bad local");
  const mem = createMemoryStorage({ [accountKey(USER, "data")]: serializeData(init.data) });
  saveSyncEnabled(mem, USER, true);
  const getStorage = () => mem;
  const store = createAccountStore(USER, getStorage);
  render(
    <SettingsProvider>
      <StudyDataProvider store={store}>
        <TimerProvider>
          <SyncProvider userId={USER} accountLabel={EMAIL} api={wrap(server.apiFor(USER))} getStorage={getStorage} buildEnabled>
            <Probe />
            <SyncCard />
          </SyncProvider>
        </TimerProvider>
      </StudyDataProvider>
    </SettingsProvider>,
  );
  await advance(50);
  return { server, mem, seeded };
}

describe("first link in the Settings card", () => {
  it("this device has data and the cloud is empty: names the account, uploads only after confirmation", async () => {
    const { server, mem, seeded } = await shell(mine(), null);
    expect(screen.getByText(`Link this device to ${EMAIL}`)).toBeTruthy();
    expect(screen.getByText(/1 class, 1 subgroup and 1 session/)).toBeTruthy();
    await advance(60_000); // waiting changes nothing
    expect(count(server, "import_and_init_sync")).toBe(seeded);
    expect(count(server, "push_changes")).toBe(0);

    await click("Upload this device’s data");
    expect(screen.getByText(`Link ${EMAIL}?`)).toBeTruthy();
    await click("Cancel");
    expect(count(server, "import_and_init_sync")).toBe(seeded); // cancel did nothing
    expect(loadBaseline(mem, USER)).toBeNull();

    await click("Upload this device’s data");
    await click("Yes, upload and link");
    expect(canon(server.state(USER).snapshot)).toEqual(canon(mine()));
    expect(loadBaseline(mem, USER)).not.toBeNull();
    expect(screen.queryByText(`Link this device to ${EMAIL}`)).toBeNull();
    expect(screen.getByText("Synced")).toBeTruthy();
  });

  it("a new device with no data adopts the cloud data after confirmation", async () => {
    const { server, mem } = await shell(snap(), theirs());
    expect(screen.getByText(/has 1 class, 0 subgroups and 1 session/)).toBeTruthy();
    expect(hooks.data.classes).toEqual([]);
    await click("Use the cloud data here");
    await click("Yes, copy it to this device");
    expect(hooks.data.classes.map((c) => c.id)).toEqual(["T1"]);
    expect(loadBaseline(mem, USER)).not.toBeNull();
    expect(count(server, "push_changes")).toBe(0);
  });

  it("both sides have data: shows the choices and their consequences, and changes nothing by itself", async () => {
    const { server, mem, seeded } = await shell(mine(), theirs());
    expect(screen.getByText(/They are different, so nothing is chosen for you/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Combine both" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use the cloud data" })).toBeTruthy();
    expect(screen.getAllByText(/A safety copy of this device’s data is saved first/)).toHaveLength(2);
    await advance(120_000);
    expect(count(server, "push_changes")).toBe(0);
    expect(count(server, "import_and_init_sync")).toBe(seeded);
    expect(hooks.data.classes.map((c) => c.id)).toEqual(["M1"]);
    expect(loadBaseline(mem, USER)).toBeNull();
    expect(listSyncBackups(mem, USER)).toEqual([]);
  });

  it("use the cloud data: a backup of this device's data is saved before it is replaced", async () => {
    const { server, mem } = await shell(mine(), theirs());
    await click("Use the cloud data");
    await click("Yes, replace this device’s data");
    const backups = listSyncBackups(mem, USER);
    expect(backups).toHaveLength(1);
    expect(backups[0].data.classes.map((c) => c.id)).toEqual(["M1"]);
    expect(hooks.data.classes.map((c) => c.id)).toEqual(["T1"]);
    expect(canon(server.state(USER).snapshot)).toEqual(canon(theirs())); // the cloud is untouched
    expect(loadBaseline(mem, USER)).not.toBeNull();
  });

  it("combine keeps both sides", async () => {
    const { server } = await shell(mine(), theirs());
    await click("Combine both");
    await click("Yes, combine both");
    expect(hooks.data.classes.map((c) => c.id).sort()).toEqual(["M1", "T1"]);
    expect(canon(server.state(USER).snapshot).classes.map((c) => c.id)).toEqual(["M1", "T1"]);
  });

  it("combine is not offered when names clash, and the reason is shown", async () => {
    await shell(snap([cls("M1", "Math")]), snap([cls("T1", "Math")]));
    expect(screen.queryByRole("button", { name: "Combine both" })).toBeNull();
    expect(screen.getByText(/same name/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use the cloud data" })).toBeTruthy();
  });

  it("a failure while linking leaves the device unlinked and its data alone; trying again works", async () => {
    let fail = true;
    const { server, mem } = await shell(mine(), null, (api) => ({
      ...api,
      importAndInitSync: async (id, payload) => {
        if (fail) throw new Error("TypeError: fetch failed");
        return api.importAndInitSync(id, payload);
      },
    }));
    await click("Upload this device’s data");
    await click("Yes, upload and link");
    expect(screen.getByRole("alert").textContent).toMatch(/offline/i);
    expect(loadBaseline(mem, USER)).toBeNull();
    expect(canon(server.state(USER).snapshot)).toEqual(canon(snap()));
    expect(hooks.data.classes.map((c) => c.id)).toEqual(["M1"]);
    fail = false;
    await click("Upload this device’s data");
    await click("Yes, upload and link");
    expect(loadBaseline(mem, USER)).not.toBeNull();
    expect(canon(server.state(USER).snapshot)).toEqual(canon(mine()));
  });

  it("the cloud changed while the user was deciding: nothing is done and the new situation is shown", async () => {
    const { server, mem } = await shell(mine(), null);
    await click("Upload this device’s data");
    await seed(server, USER, theirs()); // another device uploads first
    await click("Yes, upload and link");
    expect(canon(server.state(USER).snapshot)).toEqual(canon(theirs()));
    expect(loadBaseline(mem, USER)).toBeNull();
    expect(screen.getByText(/Something changed while you were deciding/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Combine both" })).toBeTruthy();
  });

  it("choices that replace this device's data wait while a timer is running", async () => {
    const { mem } = await shell(mine(), theirs());
    act(() => hooks.timer.setClassId("M1"));
    act(() => hooks.timer.start());
    await click("Use the cloud data");
    expect(screen.getByText(/Stop the timer first/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Yes, replace this device’s data" }) as HTMLButtonElement).disabled).toBe(true);
    expect(loadBaseline(mem, USER)).toBeNull();
    expect(hooks.data.classes.map((c) => c.id)).toEqual(["M1"]);
  });

  it("an identical device and cloud link without changing anything", async () => {
    const { server, mem, seeded } = await shell(mine(), mine());
    expect(screen.getByText(/already match/)).toBeTruthy();
    await click("Link this device");
    await click("Yes, link this device");
    expect(loadBaseline(mem, USER)).not.toBeNull();
    expect(count(server, "push_changes")).toBe(0);
    expect(count(server, "import_and_init_sync")).toBe(seeded);
    expect(toSyncSnapshot(hooks.data.syncBridge.getData())).toEqual(mine());
  });

  it("with sync not turned on for this device nothing is read or shown", async () => {
    const server = createFakeSyncServer();
    await seed(server, USER, theirs());
    const calls = server.calls.length;
    const init = fromSyncSnapshot(mine());
    if (!init.ok) throw new Error("bad");
    const mem = createMemoryStorage({ [accountKey(USER, "data")]: serializeData(init.data) });
    const getStorage = () => mem;
    render(
      <SettingsProvider>
        <StudyDataProvider store={createAccountStore(USER, getStorage)}>
          <TimerProvider>
            <SyncProvider userId={USER} accountLabel={EMAIL} api={server.apiFor(USER)} getStorage={getStorage} buildEnabled>
              <SyncCard />
            </SyncProvider>
          </TimerProvider>
        </StudyDataProvider>
      </SettingsProvider>,
    );
    await advance(60_000);
    expect(server.calls).toHaveLength(calls);
    expect(screen.queryByText(`Link this device to ${EMAIL}`)).toBeNull();
  });
});
