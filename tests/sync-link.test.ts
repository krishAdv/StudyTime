import { describe, expect, it } from "vitest";
import type { SyncApi } from "@/lib/sync/api";
import { createLinker, type LinkAction, type LinkDeps, type LinkInspection } from "@/lib/sync/link";
import { fromSyncSnapshot } from "@/lib/sync/from-snapshot";
import { toSyncSnapshot, type RevisionedSnapshot, type SyncSnapshot } from "@/lib/sync/snapshot";
import type { StoredData } from "@/lib/storage";
import { createFakeSyncServer, type FakeSyncServer } from "./helpers/fake-sync-server";
import { canon, cls, grp, ses, snap, seed } from "./helpers/sync-plan-harness";
import { baseSnapshot } from "./helpers/merge-fixtures";

const USER = "u";
const EMPTY: StoredData = { classes: [], sessions: [] };
const data = (s: SyncSnapshot): StoredData => {
  const r = fromSyncSnapshot(s);
  if (!r.ok) throw new Error("bad test data");
  return r.data;
};

/** A device that has never linked: local data, no baseline, backups recorded, everything injectable. */
function device(server: FakeSyncServer, local: StoredData, hooks: { wrapApi?: (a: SyncApi) => SyncApi; timerActive?: () => boolean } = {}) {
  const st = { local, baseline: null as RevisionedSnapshot | null, backups: [] as { data: StoredData; reason: string }[], failBackup: false, failBaseline: false };
  let n = 0;
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
    newImportId: () => `import-${++n}`,
  };
  const linker = createLinker(deps);
  const inspect = async () => {
    const r = await linker.inspect();
    if (r.status !== "ok") throw new Error("inspect failed: " + r.status);
    return r.inspection;
  };
  const link = async (action: LinkAction, seen?: LinkInspection) => linker.link(action, (seen ?? (await inspect())).fingerprint);
  return { st, linker, inspect, link, deps };
}

const serverSnap = (s: FakeSyncServer) => canon(s.state(USER).snapshot);
const calls = (s: FakeSyncServer, fn: string) => s.calls.filter((c) => c.fn === fn).length;

const mine = () => snap([cls("M1", "Mine")], [grp("MG", "M1", "Unit")], [ses("ms1", "M1", "MG", 5_000, 100)]);
const theirs = () => snap([cls("T1", "Theirs")], [], [ses("ts1", "T1", null, 6_000, 200)]);

describe("first link: which situation is it", () => {
  it("both empty or identical: match", async () => {
    const server = createFakeSyncServer();
    expect((await device(server, EMPTY).inspect()).scenario).toBe("match");
    await seed(server, USER, baseSnapshot());
    const d = device(server, data(baseSnapshot()));
    expect(await d.inspect()).toMatchObject({ scenario: "match", actions: ["link"] });
  });

  it("local data and an empty cloud: upload, with counts", async () => {
    const server = createFakeSyncServer();
    const i = await device(server, data(mine())).inspect();
    expect(i).toMatchObject({ scenario: "upload", actions: ["upload"], local: { classes: 1, groups: 1, sessions: 1 }, cloud: { classes: 0, groups: 0, sessions: 0 } });
  });

  it("an empty device and cloud data: adopt", async () => {
    const server = createFakeSyncServer();
    await seed(server, USER, baseSnapshot());
    const i = await device(server, EMPTY).inspect();
    expect(i).toMatchObject({ scenario: "adopt", actions: ["adopt"], cloud: { classes: 2, groups: 3, sessions: 4 } });
  });

  it("different data on both sides: use cloud, and combine when it works", async () => {
    const server = createFakeSyncServer();
    await seed(server, USER, theirs());
    const i = await device(server, data(mine())).inspect();
    expect(i.scenario).toBe("both");
    expect(i.actions).toEqual(["use_cloud", "combine"]);
    expect(i.combineBlockedReason).toBeNull();
  });

  it("both sides with a class of the same name: combine is not offered and the reason is given", async () => {
    const server = createFakeSyncServer();
    await seed(server, USER, snap([cls("T1", "Math")]));
    const i = await device(server, data(snap([cls("M1", "Math")]))).inspect();
    expect(i.scenario).toBe("both");
    expect(i.actions).toEqual(["use_cloud"]);
    expect(i.combineBlockedReason).toMatch(/same name/);
  });

  it("local data the cloud would reject: cannot be uploaded (ineligible), and combine is not offered", async () => {
    const server = createFakeSyncServer();
    const bad: StoredData = { classes: [{ id: "x", name: "A", color: "#000000", groups: [] }, { id: "y", name: "a", color: "#000000", groups: [] }], sessions: [] };
    const up = await device(server, bad).inspect();
    expect(up.scenario).toBe("ineligible");
    expect(up.actions).toEqual([]);
    expect(up.issues.length).toBeGreaterThan(0);
    await seed(server, USER, theirs());
    const both = await device(server, bad).inspect();
    expect(both.actions).toEqual(["use_cloud"]);
  });

  it("inspecting never changes anything", async () => {
    const server = createFakeSyncServer();
    await seed(server, USER, theirs());
    const d = device(server, data(mine()));
    const before = serverSnap(server);
    await d.inspect();
    expect(calls(server, "import_and_init_sync")).toBe(1); // only the seed
    expect(calls(server, "push_changes")).toBe(0);
    expect(serverSnap(server)).toEqual(before);
    expect(d.st.baseline).toBeNull();
    expect(d.st.backups).toEqual([]);
  });
});

describe("first link: upload", () => {
  it("uploads this device's data, reads the cloud back and saves the baseline last", async () => {
    const server = createFakeSyncServer();
    const d = device(server, data(mine()));
    const out = await d.link("upload");
    expect(out).toMatchObject({ status: "linked", action: "upload" });
    expect(serverSnap(server)).toEqual(canon(mine()));
    expect(d.st.baseline).toMatchObject({ revision: server.state(USER).revision });
    expect(canon(d.st.baseline!.snapshot)).toEqual(canon(mine()));
    expect(d.st.local).toEqual(data(mine())); // local data is never rewritten by an upload
    expect(d.st.backups).toEqual([]);
  });

  it("an upload that cannot reach the server leaves everything as it was, and a retry works", async () => {
    const server = createFakeSyncServer();
    const d = device(server, data(mine()));
    const seen = await d.inspect();
    server.setMode("network_down");
    const failed = await d.link("upload", seen);
    expect(failed).toMatchObject({ status: "error" });
    server.setMode("normal");
    expect(d.st.baseline).toBeNull();
    expect(serverSnap(server)).toEqual(canon(snap()));
    expect(await d.link("upload", seen)).toMatchObject({ status: "linked" });
    expect(canon(d.st.baseline!.snapshot)).toEqual(canon(mine()));
  });

  it("the import went through but its answer was lost: not linked yet, and the retry links without importing again", async () => {
    const server = createFakeSyncServer();
    const d = device(server, data(mine()), {
      wrapApi: (api) => ({
        ...api,
        importAndInitSync: async (id, payload) => {
          await api.importAndInitSync(id, payload);
          throw new Error("TypeError: fetch failed");
        },
      }),
    });
    const first = await d.link("upload");
    expect(first).toMatchObject({ status: "error" });
    expect(d.st.baseline).toBeNull();
    expect(serverSnap(server)).toEqual(canon(mine())); // it did reach the server
    const again = await d.inspect();
    expect(again.scenario).toBe("match");
    expect(await d.link("link", again)).toMatchObject({ status: "linked", action: "link" });
    expect(calls(server, "import_and_init_sync")).toBe(1);
    expect(canon(d.st.baseline!.snapshot)).toEqual(canon(mine()));
  });

  it("failing to save the baseline leaves the device not linked, and the retry then links cleanly", async () => {
    const server = createFakeSyncServer();
    const d = device(server, data(mine()));
    d.st.failBaseline = true;
    expect(await d.link("upload")).toMatchObject({ status: "error", outcome: { stage: "baseline" } });
    expect(d.st.baseline).toBeNull();
    d.st.failBaseline = false;
    const again = await d.inspect();
    expect(again.scenario).toBe("match");
    expect(await d.link("link", again)).toMatchObject({ status: "linked" });
  });

  it("another device filled the account first: nothing is overwritten, the new situation comes back", async () => {
    const server = createFakeSyncServer();
    const d = device(server, data(mine()));
    const seen = await d.inspect();
    await seed(server, USER, theirs()); // another device uploads first
    const out = await d.link("upload", seen);
    expect(out).toMatchObject({ status: "changed", inspection: { scenario: "both" } });
    expect(serverSnap(server)).toEqual(canon(theirs()));
    expect(d.st.baseline).toBeNull();
    expect(d.st.local).toEqual(data(mine()));
  });

  it("an account that is not empty at upload time (race) is reported, not overwritten", async () => {
    const server = createFakeSyncServer();
    const d = device(server, data(mine()), {
      wrapApi: (api) => ({
        ...api,
        importAndInitSync: async (id, payload) => {
          await seed(server, USER, theirs()); // lands between the inspection and the import
          return api.importAndInitSync(id, payload);
        },
      }),
    });
    const out = await d.link("upload");
    expect(out).toMatchObject({ status: "error", outcome: { error: { kind: "account_not_empty" } } });
    expect(serverSnap(server)).toEqual(canon(theirs()));
    expect(d.st.baseline).toBeNull();
  });

  it("local data changed while the cloud was being read back: the baseline is what was uploaded, so the change still syncs later", async () => {
    const server = createFakeSyncServer();
    const d = device(server, data(mine()), {
      wrapApi: (api) => ({
        ...api,
        importAndInitSync: async (id, payload) => {
          const r = await api.importAndInitSync(id, payload);
          const next = structuredClone(d.st.local);
          next.sessions.push({ id: "late", classId: "M1", groupId: null, startedAt: 9_000, seconds: 30, mode: "stopwatch" });
          d.st.local = next; // a session recorded during linking
          return r;
        },
      }),
    });
    expect(await d.link("upload")).toMatchObject({ status: "linked" });
    expect(canon(d.st.baseline!.snapshot)).toEqual(canon(mine())); // not including the late session
    expect(d.st.local.sessions.map((s) => s.id)).toContain("late");
  });

  it("an ineligible device cannot upload", async () => {
    const server = createFakeSyncServer();
    const bad: StoredData = { classes: [{ id: "x", name: "A", color: "#000000", groups: [] }, { id: "y", name: "a", color: "#000000", groups: [] }], sessions: [] };
    const d = device(server, bad);
    const seen = await d.inspect();
    expect(await d.linker.link("upload", seen.fingerprint)).toMatchObject({ status: "not_allowed" });
    expect(calls(server, "import_and_init_sync")).toBe(0);
  });
});

describe("first link: adopt and use cloud", () => {
  it("an empty device adopts the cloud data; there is nothing to back up", async () => {
    const server = createFakeSyncServer();
    const pulled = await seed(server, USER, baseSnapshot());
    const d = device(server, EMPTY);
    expect(await d.link("adopt")).toMatchObject({ status: "linked", action: "adopt" });
    expect(canon(toSyncSnapshot(d.st.local))).toEqual(canon(baseSnapshot()));
    expect(d.st.baseline).toEqual({ revision: pulled.revision, snapshot: pulled.snapshot });
    expect(d.st.backups).toEqual([]);
    expect(calls(server, "push_changes")).toBe(0);
  });

  it("use cloud: this device's data is backed up first, then replaced; the cloud is not touched", async () => {
    const server = createFakeSyncServer();
    await seed(server, USER, theirs());
    const before = serverSnap(server);
    const d = device(server, data(mine()));
    const mineBefore = d.st.local;
    expect(await d.link("use_cloud")).toMatchObject({ status: "linked", action: "use_cloud" });
    expect(d.st.backups).toHaveLength(1);
    expect(d.st.backups[0]).toMatchObject({ reason: "before_first_link", data: mineBefore });
    expect(canon(toSyncSnapshot(d.st.local))).toEqual(canon(theirs()));
    expect(serverSnap(server)).toEqual(before);
    expect(calls(server, "push_changes")).toBe(0);
  });

  it("a failed backup means nothing is replaced and not linked", async () => {
    const server = createFakeSyncServer();
    await seed(server, USER, theirs());
    const d = device(server, data(mine()));
    const mineBefore = d.st.local;
    d.st.failBackup = true;
    expect(await d.link("use_cloud")).toMatchObject({ status: "error", outcome: { stage: "backup" } });
    expect(d.st.local).toBe(mineBefore);
    expect(d.st.baseline).toBeNull();
  });

  it("local data that changed during the link is not overwritten", async () => {
    const server = createFakeSyncServer();
    await seed(server, USER, theirs());
    const d = device(server, data(mine()));
    const original = d.deps.backup;
    d.deps.backup = (x, info) => {
      original(x, info);
      d.st.local = { ...d.st.local, sessions: [...d.st.local.sessions] }; // changed after it was read
    };
    const out = await createLinker(d.deps).link("use_cloud", (await d.inspect()).fingerprint);
    expect(out.status).toBe("changed");
    expect(d.st.local.classes.map((c) => c.id)).toEqual(["M1"]);
    expect(d.st.baseline).toBeNull();
  });

  it("failing to save the baseline after replacing: retry shows a match", async () => {
    const server = createFakeSyncServer();
    await seed(server, USER, theirs());
    const d = device(server, EMPTY);
    d.st.failBaseline = true;
    expect(await d.link("adopt")).toMatchObject({ status: "error", outcome: { stage: "baseline" } });
    d.st.failBaseline = false;
    const again = await d.inspect();
    expect(again.scenario).toBe("match");
    expect(await d.link("link", again)).toMatchObject({ status: "linked" });
  });

  it("is refused while a timer is running, and nothing changes", async () => {
    const server = createFakeSyncServer();
    await seed(server, USER, theirs());
    const d = device(server, data(mine()), { timerActive: () => true });
    const mineBefore = d.st.local;
    expect(await d.link("use_cloud")).toEqual({ status: "timer_running" });
    expect(d.st.local).toBe(mineBefore);
    expect(d.st.backups).toEqual([]);
    expect(d.st.baseline).toBeNull();
  });
});

describe("first link: combine", () => {
  it("keeps everything from both sides, on both sides, with a backup, and links", async () => {
    const server = createFakeSyncServer();
    await seed(server, USER, theirs());
    const d = device(server, data(mine()));
    const mineBefore = d.st.local;
    expect(await d.link("combine")).toMatchObject({ status: "linked", action: "combine" });
    const ids = (s: SyncSnapshot) => [...s.classes.map((c) => c.id), ...s.sessions.map((x) => x.id)].sort();
    const expected = ["M1", "T1", "ms1", "ts1"];
    expect(ids(serverSnap(server))).toEqual(expected);
    expect(ids(toSyncSnapshot(d.st.local))).toEqual(expected);
    expect(d.st.backups[0].data).toEqual(mineBefore);
    expect(canon(d.st.baseline!.snapshot)).toEqual(serverSnap(server));
    expect(d.st.baseline!.revision).toBe(server.state(USER).revision);
  });

  it("an interrupted combine saves no baseline and the retry finishes it", async () => {
    const server = createFakeSyncServer();
    await seed(server, USER, theirs());
    const d = device(server, data(mine()));
    d.st.failBackup = true; // the push already happened when the backup fails
    expect(await d.link("combine")).toMatchObject({ status: "error", outcome: { stage: "backup" } });
    expect(d.st.baseline).toBeNull();
    d.st.failBackup = false;
    const again = await d.inspect();
    expect(again.scenario).toBe("both");
    expect(await d.link("combine", again)).toMatchObject({ status: "linked" });
    expect(canon(toSyncSnapshot(d.st.local))).toEqual(serverSnap(server));
    expect(serverSnap(server).classes.map((c) => c.id).sort()).toEqual(["M1", "T1"]);
  });

  it("is not allowed when the names clash, and nothing is touched", async () => {
    const server = createFakeSyncServer();
    await seed(server, USER, snap([cls("T1", "Math")]));
    const d = device(server, data(snap([cls("M1", "Math")])));
    const seen = await d.inspect();
    expect(await d.linker.link("combine", seen.fingerprint)).toMatchObject({ status: "not_allowed" });
    expect(calls(server, "push_changes")).toBe(0);
    expect(d.st.baseline).toBeNull();
  });

  it("is refused while a timer is running", async () => {
    const server = createFakeSyncServer();
    await seed(server, USER, theirs());
    const d = device(server, data(mine()), { timerActive: () => true });
    expect(await d.link("combine")).toEqual({ status: "timer_running" });
    expect(calls(server, "push_changes")).toBe(0);
  });
});

describe("first link: confirming what was shown", () => {
  it("refuses when this device's data changed after the user looked", async () => {
    const server = createFakeSyncServer();
    const d = device(server, data(mine()));
    const seen = await d.inspect();
    d.st.local = data(snap([cls("M1", "Mine"), cls("M2", "More")]));
    const out = await d.linker.link("upload", seen.fingerprint);
    expect(out).toMatchObject({ status: "changed", inspection: { local: { classes: 2 } } });
    expect(calls(server, "import_and_init_sync")).toBe(0);
  });

  it("refuses an action that does not belong to the situation", async () => {
    const server = createFakeSyncServer();
    await seed(server, USER, theirs());
    const d = device(server, data(mine()));
    const seen = await d.inspect();
    expect(await d.linker.link("upload", seen.fingerprint)).toMatchObject({ status: "not_allowed" });
    expect(await d.linker.link("link", seen.fingerprint)).toMatchObject({ status: "not_allowed" });
    expect(d.st.baseline).toBeNull();
  });

  it("a device that is already linked is not linked again", async () => {
    const server = createFakeSyncServer();
    const d = device(server, data(mine()));
    await d.link("upload");
    expect((await d.linker.inspect()).status).toBe("linked_already");
    expect(await d.linker.link("upload", "x")).toMatchObject({ status: "refused" });
  });

  it("network and server errors while looking are reported and change nothing", async () => {
    const server = createFakeSyncServer();
    const d = device(server, data(mine()));
    server.setMode("network_down");
    expect(await d.linker.inspect()).toMatchObject({ status: "error", outcome: { stage: "pull", error: { kind: "network" } } });
    server.setMode("server_error");
    expect(await d.linker.inspect()).toMatchObject({ status: "error", outcome: { error: { kind: "server" } } });
    expect(d.st.baseline).toBeNull();
  });

  it("after linking, the normal engine takes over from the saved baseline", async () => {
    const { createSyncEngine } = await import("@/lib/sync/engine");
    const server = createFakeSyncServer();
    const d = device(server, data(mine()));
    await d.link("upload");
    const engine = createSyncEngine(d.deps);
    expect(await engine.syncOnce()).toMatchObject({ status: "up_to_date" });
  });
});
