import { describe, expect, it } from "vitest";
import type { SyncApi } from "@/lib/sync/api";
import { createEscapes, planReplaceCloud, type EscapeAction } from "@/lib/sync/escape";
import type { LinkDeps } from "@/lib/sync/link";
import { fromSyncSnapshot } from "@/lib/sync/from-snapshot";
import { toSyncSnapshot, type RevisionedSnapshot, type SyncSnapshot } from "@/lib/sync/snapshot";
import type { StoredData } from "@/lib/storage";
import { createFakeSyncServer, type FakeSyncServer } from "./helpers/fake-sync-server";
import { canon, cls, grp, ses, snap, seed } from "./helpers/sync-plan-harness";
import { baseSnapshot } from "./helpers/merge-fixtures";

const USER = "u";
const data = (s: SyncSnapshot): StoredData => {
  const r = fromSyncSnapshot(s);
  if (!r.ok) throw new Error("bad test data");
  return r.data;
};
const calls = (s: FakeSyncServer, fn: string) => s.calls.filter((c) => c.fn === fn).length;
const serverSnap = (s: FakeSyncServer) => canon(s.state(USER).snapshot);

/** A linked device (it has a baseline) whose local data may differ from the cloud's. */
async function device(server: FakeSyncServer, cloud: SyncSnapshot, local: SyncSnapshot, hooks: { wrapApi?: (a: SyncApi) => SyncApi; timerActive?: () => boolean } = {}) {
  const pulled = await seed(server, USER, cloud);
  const st = {
    local: data(local),
    baseline: structuredClone(pulled) as RevisionedSnapshot | null,
    backups: [] as { data: StoredData; reason: string }[],
    failBackup: false,
    failBaseline: false,
  };
  const base = server.apiFor(USER);
  const deps: LinkDeps = {
    api: hooks.wrapApi ? hooks.wrapApi(base) : base,
    loadBaseline: () => st.baseline,
    saveBaseline: (b) => {
      if (st.failBaseline) throw new Error("disk full");
      st.baseline = structuredClone(b);
    },
    getLocal: () => st.local,
    replaceLocal: (expected, next) => {
      if (st.local !== expected) return false;
      st.local = next;
      return true;
    },
    backup: (d, info) => {
      if (st.failBackup) throw new Error("no space");
      st.backups.push({ data: structuredClone(d), reason: info.reason });
    },
    timerActive: hooks.timerActive,
  };
  const esc = createEscapes(deps);
  const inspect = async () => {
    const r = await esc.inspect();
    if (r.status !== "ok") throw new Error("inspect: " + r.status);
    return r.inspection;
  };
  const run = async (a: EscapeAction) => esc.run(a, (await inspect()).fingerprint);
  return { st, esc, inspect, run, pulled };
}

/** Cloud and device diverged: the cloud lost a session the device still has, and the device lacks one the cloud has. */
const cloudSide = () => {
  const s = baseSnapshot();
  s.sessions = s.sessions.filter((x) => x.id !== "s2"); // cloud removed s2 (cannot be merged: removal of one session)
  s.sessions.push(ses("cloud-new", "A", null, 7_000, 90));
  return s;
};

describe("escape: inspect", () => {
  it("describes both sides and offers both actions; changes nothing", async () => {
    const server = createFakeSyncServer();
    const d = await device(server, cloudSide(), baseSnapshot());
    const before = serverSnap(server);
    const i = await d.inspect();
    expect(i.actions).toEqual(["use_cloud", "replace_cloud"]);
    expect(i.localOnlySessions).toBe(1); // s2
    expect(i.cloudOnlySessions).toBe(1); // cloud-new
    expect(calls(server, "push_changes")).toBe(0);
    expect(serverSnap(server)).toEqual(before);
    expect(d.st.backups).toEqual([]);
  });

  it("an unlinked device has no escapes", async () => {
    const server = createFakeSyncServer();
    const d = await device(server, baseSnapshot(), baseSnapshot());
    d.st.baseline = null;
    expect((await d.esc.inspect()).status).toBe("not_linked");
  });

  it("local data the cloud rejects cannot replace the cloud, but use cloud stays available", async () => {
    const server = createFakeSyncServer();
    const d = await device(server, baseSnapshot(), baseSnapshot());
    d.st.local = { classes: [{ id: "x", name: "A", color: "#000000", groups: [] }, { id: "y", name: "a", color: "#000000", groups: [] }], sessions: [] };
    const i = await d.inspect();
    expect(i.actions).toEqual(["use_cloud"]);
    expect(i.replaceBlockedReason).toMatch(/can’t be synced/);
  });
});

describe("escape: use cloud", () => {
  it("backs up this device's data, replaces it with the cloud's, leaves the cloud alone, advances the baseline", async () => {
    const server = createFakeSyncServer();
    const d = await device(server, cloudSide(), baseSnapshot());
    const mine = d.st.local;
    const out = await d.run("use_cloud");
    expect(out).toMatchObject({ status: "done", action: "use_cloud" });
    expect(d.st.backups).toHaveLength(1);
    expect(d.st.backups[0]).toMatchObject({ reason: "before_use_cloud", data: mine });
    expect(canon(toSyncSnapshot(d.st.local))).toEqual(canon(cloudSide()));
    expect(calls(server, "push_changes")).toBe(0);
    expect(canon(d.st.baseline!.snapshot)).toEqual(canon(cloudSide()));
    expect(d.st.baseline!.revision).toBe(server.state(USER).revision);
  });

  it("a failed backup replaces nothing", async () => {
    const server = createFakeSyncServer();
    const d = await device(server, cloudSide(), baseSnapshot());
    const mine = d.st.local;
    const oldBase = d.st.baseline;
    d.st.failBackup = true;
    expect(await d.run("use_cloud")).toMatchObject({ status: "error", outcome: { stage: "backup" } });
    expect(d.st.local).toBe(mine);
    expect(d.st.baseline).toEqual(oldBase);
  });

  it("is refused while a timer runs", async () => {
    const server = createFakeSyncServer();
    const d = await device(server, cloudSide(), baseSnapshot(), { timerActive: () => true });
    const mine = d.st.local;
    expect(await d.run("use_cloud")).toEqual({ status: "timer_running" });
    expect(d.st.local).toBe(mine);
    expect(d.st.backups).toEqual([]);
  });

  it("a stale confirmation (the cloud changed since it was shown) does nothing", async () => {
    const server = createFakeSyncServer();
    const d = await device(server, cloudSide(), baseSnapshot());
    const seen = await d.inspect();
    const api = server.apiFor(USER);
    const { revision } = await api.pullSnapshot();
    await api.pushChanges(revision, [{ op: "add_class", id: "N", name: "New", color: "#000000" }]);
    const mine = d.st.local;
    expect(await d.esc.run("use_cloud", seen.fingerprint)).toMatchObject({ status: "changed" });
    expect(d.st.local).toBe(mine);
    expect(d.st.backups).toEqual([]);
  });

  it("this device's data changed during the step: it is not overwritten", async () => {
    const server = createFakeSyncServer();
    const d = await device(server, cloudSide(), baseSnapshot());
    const seen = await d.inspect();
    const original = d.st;
    const esc = createEscapes({
      api: server.apiFor(USER),
      loadBaseline: () => original.baseline,
      saveBaseline: () => {},
      getLocal: () => original.local,
      replaceLocal: (expected, next) => original.local === expected && ((original.local = next), true),
      backup: () => {
        original.local = { ...original.local, sessions: [...original.local.sessions] }; // recorded a session meanwhile
      },
    });
    expect(await esc.run("use_cloud", seen.fingerprint)).toMatchObject({ status: "changed" });
    expect(original.local.classes.map((c) => c.id)).toEqual(["A", "B"]);
  });

  it("a network error changes nothing", async () => {
    const server = createFakeSyncServer();
    const d = await device(server, cloudSide(), baseSnapshot());
    const seen = await d.inspect();
    server.setMode("network_down");
    const mine = d.st.local;
    expect(await d.esc.run("use_cloud", seen.fingerprint)).toMatchObject({ status: "error", outcome: { error: { kind: "network" } } });
    expect(d.st.local).toBe(mine);
  });
});

describe("escape: replace cloud", () => {
  it("makes the cloud equal to this device, after saving copies of BOTH sides, and verifies before moving the baseline", async () => {
    const server = createFakeSyncServer();
    const d = await device(server, cloudSide(), baseSnapshot());
    const mine = d.st.local;
    const out = await d.run("replace_cloud");
    expect(out).toMatchObject({ status: "done", action: "replace_cloud" });
    expect(serverSnap(server)).toEqual(canon(baseSnapshot()));
    expect(d.st.local).toBe(mine); // this device is untouched
    expect(d.st.backups.map((b) => b.reason)).toEqual(["before_replace_cloud", "cloud_before_replace_cloud"]);
    expect(canon(toSyncSnapshot(d.st.backups[1].data))).toEqual(canon(cloudSide())); // the cloud's data is kept here
    expect(canon(d.st.baseline!.snapshot)).toEqual(canon(baseSnapshot()));
    expect(d.st.baseline!.revision).toBe(server.state(USER).revision);
    expect(calls(server, "push_changes")).toBe(1); // one push: all or nothing
  });

  it("works when the cloud is empty or this device is empty", async () => {
    const server1 = createFakeSyncServer();
    const a = await device(server1, snap(), baseSnapshot());
    expect(await a.run("replace_cloud")).toMatchObject({ status: "done" });
    expect(serverSnap(server1)).toEqual(canon(baseSnapshot()));
    expect(a.st.backups.map((b) => b.reason)).toEqual(["before_replace_cloud"]);
    const server2 = createFakeSyncServer();
    const b = await device(server2, baseSnapshot(), snap());
    expect(await b.run("replace_cloud")).toMatchObject({ status: "done" });
    expect(serverSnap(server2)).toEqual(canon(snap()));
    expect(b.st.backups.map((x) => x.reason)).toEqual(["cloud_before_replace_cloud"]); // the emptied cloud is still copied
  });

  it("classes that already match are not touched", async () => {
    const remote = cloudSide();
    const local = baseSnapshot();
    const plan = planReplaceCloud(remote, local);
    if (!plan.ok) throw new Error("plan");
    // class B is identical on both sides, class A differs
    expect(plan.deletedClasses).toBe(1);
    expect(plan.recreatedClasses).toBe(1);
    expect(plan.ops.some((o) => "id" in o && o.id === "B")).toBe(false);
  });

  it("handles a class whose name is taken by a different class on the other side", async () => {
    const server = createFakeSyncServer();
    const remote = snap([cls("R1", "Math")], [grp("RG", "R1", "Unit")], [ses("rs", "R1", "RG")]);
    const local = snap([cls("L1", "Math")], [], [ses("ls", "L1", null, 9_000, 30)]);
    const d = await device(server, remote, local);
    expect(await d.run("replace_cloud")).toMatchObject({ status: "done" });
    expect(serverSnap(server)).toEqual(canon(local));
  });

  it("a failed backup of either side stops before anything is pushed", async () => {
    const server = createFakeSyncServer();
    const d = await device(server, cloudSide(), baseSnapshot());
    const before = serverSnap(server);
    d.st.failBackup = true;
    expect(await d.run("replace_cloud")).toMatchObject({ status: "error", outcome: { stage: "backup" } });
    expect(calls(server, "push_changes")).toBe(0);
    expect(serverSnap(server)).toEqual(before);
    expect(d.st.baseline!.snapshot).toEqual((await d.pulled).snapshot);
  });

  it("a stale push (another device pushed first) changes nothing and asks again", async () => {
    const server = createFakeSyncServer();
    const d = await device(server, cloudSide(), baseSnapshot(), {
      wrapApi: (api) => ({
        ...api,
        pushChanges: async (rev, changes) => {
          const other = server.apiFor(USER);
          const cur = await other.pullSnapshot();
          await other.pushChanges(cur.revision, [{ op: "add_class", id: "Z", name: "Zed", color: "#000000" }]);
          return api.pushChanges(rev, changes);
        },
      }),
    });
    const out = await d.run("replace_cloud");
    expect(out).toMatchObject({ status: "changed" });
    expect(serverSnap(server).classes.map((c) => c.id)).toContain("Z");
    expect(serverSnap(server).sessions.map((s) => s.id)).toContain("cloud-new"); // nothing was replaced
    expect(d.st.baseline!.revision).toBeLessThan(server.state(USER).revision);
  });

  it("if the cloud does not read back as this device's data, the baseline does not move", async () => {
    const server = createFakeSyncServer();
    let pushed = false;
    const d = await device(server, cloudSide(), baseSnapshot(), {
      wrapApi: (api) => ({
        ...api,
        pushChanges: async (rev, changes) => {
          pushed = true;
          return api.pushChanges(rev, changes);
        },
        pullSnapshot: async () => {
          const r = await api.pullSnapshot();
          return pushed ? { ...r, snapshot: { ...r.snapshot, classes: [] } } : r; // the read-back shows something else
        },
      }),
    });
    const seen = await d.inspect();
    const before = d.st.baseline;
    expect(await d.esc.run("replace_cloud", seen.fingerprint)).toMatchObject({ status: "refused" });
    expect(d.st.baseline).toEqual(before);
  });

  it("too much for one push is refused, nothing changed", () => {
    const sessions = Array.from({ length: 5_100 }, (_, n) => ses(`s${n}`, "A", null, 1_000 + n, 60));
    const plan = planReplaceCloud(snap([cls("A", "Math")]), snap([cls("A", "Math")], [], sessions));
    expect(plan.ok).toBe(false);
  });

  it("works again after a failed attempt (retry)", async () => {
    const server = createFakeSyncServer();
    const d = await device(server, cloudSide(), baseSnapshot());
    const seen = await d.inspect();
    d.st.failBaseline = true;
    expect(await d.esc.run("replace_cloud", seen.fingerprint)).toMatchObject({ status: "error", outcome: { stage: "baseline" } });
    // the cloud was replaced but the baseline did not move; the next attempt sees both sides equal
    d.st.failBaseline = false;
    const again = await d.inspect();
    expect(again.localOnlySessions).toBe(0);
    expect(await d.esc.run("replace_cloud", again.fingerprint)).toMatchObject({ status: "done" });
    expect(serverSnap(server)).toEqual(canon(baseSnapshot()));
  });
});
