import { describe, expect, it } from "vitest";
import type { SyncApi } from "@/lib/sync/api";
import type { SyncOutcome } from "@/lib/sync/engine";
import { baseSnapshot, delClass } from "./helpers/merge-fixtures";
import { createFakeSyncServer, type FakeSyncServer } from "./helpers/fake-sync-server";
import { createDevice, seedAndLink } from "./helpers/sync-device";
import { canon, cls, ses } from "./helpers/sync-plan-harness";

/**
 * S6: the sync engine against the real Supabase adapter running on the in-memory fake server.
 * Base data: classes A "Math", B "Art"; subgroups g1, g2 (A), g3 (B); sessions s1 to s4.
 */

const USER = "u1";
const pushCount = (server: FakeSyncServer) => server.calls.filter((c) => c.fn === "push_changes").length;
const pullCount = (server: FakeSyncServer) => server.calls.filter((c) => c.fn === "pull_snapshot").length;
const serverData = (server: FakeSyncServer) => canon(server.state(USER).snapshot);
const world = async (hooksA = {}, hooksB = {}) => {
  const server = createFakeSyncServer();
  const { a, b, revision } = await seedAndLink(server, USER, baseSnapshot(), hooksA, hooksB);
  return { server, a, b, revision };
};
const addSession = (id: string) => (d: ReturnType<typeof baseSnapshot>) => void d.sessions.push(ses(id, "A", null, 50_000 + d.sessions.length, 90));
const addClass = (id: string, name: string) => (d: ReturnType<typeof baseSnapshot>) => void d.classes.push(cls(id, name));
const sessionIds = (d: { sessions: { id: string }[] }) => d.sessions.map((s) => s.id).sort();
const statusOf = (o: SyncOutcome) => o.status;

describe("a pass with nothing to do", () => {
  it("is up to date and neither pushes nor writes anything", async () => {
    const { server, a, revision } = await world();
    const before = a.local;
    const out = await a.sync();
    expect(out).toEqual({ status: "up_to_date", revision });
    expect(pushCount(server)).toBe(0);
    expect(a.local).toBe(before);
    expect(a.baselineWrites).toHaveLength(0);
    expect(a.backups).toHaveLength(0);
  });
});

describe("ordinary syncing", () => {
  it("a local-only change is pushed; local data is not replaced and no backup is needed", async () => {
    const { server, a, revision } = await world();
    a.edit(addSession("x1"));
    const before = a.local;
    const out = await a.sync();
    expect(out).toEqual({ status: "synced", revision: revision + 1, pushed: 1, applied: false });
    expect(sessionIds(serverData(server))).toContain("x1");
    expect(a.local).toBe(before);
    expect(a.backups).toHaveLength(0);
    expect(a.baseline?.revision).toBe(revision + 1);
    expect(canon(a.baseline!.snapshot)).toEqual(serverData(server));
  });

  it("a remote-only change is applied locally, after a backup of the old local data", async () => {
    const { server, a, b, revision } = await world();
    b.edit(addSession("x1"));
    await b.sync();
    const out = await a.sync();
    expect(out).toEqual({ status: "synced", revision: revision + 1, pushed: 0, applied: true });
    expect(sessionIds(a.snapshot())).toContain("x1");
    expect(a.snapshot()).toEqual(serverData(server));
    expect(a.backups).toHaveLength(1);
    expect(sessionIds(a.backups[0].data)).not.toContain("x1"); // the backup is the data from before
    expect(a.baseline?.revision).toBe(revision + 1);
  });

  it("different changes on two devices merge, and all devices converge without losing anything", async () => {
    const { server, a, b } = await world();
    a.edit(addSession("xa"));
    b.edit(addClass("C", "Biology"));
    b.edit(addSession("xb"));
    expect(statusOf(await a.sync())).toBe("synced");
    expect(statusOf(await b.sync())).toBe("synced");
    expect(statusOf(await a.sync())).toBe("synced");
    for (const d of [a, b]) {
      expect(d.snapshot()).toEqual(serverData(server));
      expect(sessionIds(d.snapshot())).toEqual(expect.arrayContaining(["xa", "xb", "s1", "s2", "s3", "s4"]));
      expect(d.snapshot().classes.map((c) => c.id)).toContain("C");
    }
    expect((await a.sync()).status).toBe("up_to_date");
    expect((await b.sync()).status).toBe("up_to_date");
  });

  it("a long back-and-forth stays consistent", async () => {
    const { server, a, b } = await world();
    for (let i = 0; i < 8; i++) {
      const [x, y] = i % 2 ? [a, b] : [b, a];
      x.edit(addSession(`n${i}`));
      await x.sync();
      await y.sync();
    }
    await a.sync();
    await b.sync();
    expect(a.snapshot()).toEqual(serverData(server));
    expect(b.snapshot()).toEqual(serverData(server));
    expect(sessionIds(serverData(server))).toEqual([...baseSnapshot().sessions.map((s) => s.id), ...Array.from({ length: 8 }, (_, i) => `n${i}`)].sort());
  });

  it("a class deleted on another device is removed here, and the backup keeps it", async () => {
    const { a, b } = await world();
    b.edit(delClass("B"));
    await b.sync();
    const out = await a.sync();
    expect(out).toMatchObject({ status: "synced", applied: true });
    expect(a.snapshot().classes.map((c) => c.id)).toEqual(["A"]);
    expect(a.backups[0].data.classes.map((c) => c.id)).toContain("B");
    expect(sessionIds(a.backups[0].data)).toEqual(expect.arrayContaining(["s3", "s4"]));
  });
});

describe("another device pushes first (stale)", () => {
  it("pulls and merges again, then succeeds", async () => {
    let pushes = 0;
    const ref: { other?: ReturnType<typeof createDevice>; self?: ReturnType<typeof createDevice> } = {};
    const { server, a, b } = await world(
      {
        wrapApi: (api: SyncApi): SyncApi => ({
          ...api,
          pullSnapshot: () => api.pullSnapshot(),
          importAndInitSync: api.importAndInitSync,
          pushChanges: async (rev, changes) => {
            if (pushes++ === 0) await ref.other!.sync(); // b gets in first
            return api.pushChanges(rev, changes);
          },
        }),
      },
    );
    ref.other = b;
    a.edit(addSession("xa"));
    b.edit(addClass("C", "Biology"));
    const out = await a.sync();
    expect(out).toMatchObject({ status: "synced", applied: true });
    expect(pushes).toBe(2); // the stale attempt and the retry
    expect(a.snapshot()).toEqual(serverData(server));
    expect(sessionIds(a.snapshot())).toContain("xa");
    expect(a.snapshot().classes.map((c) => c.id)).toContain("C");
  });

  it("gives up after the attempt cap, changing nothing", async () => {
    let pushes = 0;
    const { server, a, revision } = await world({
      maxAttempts: 3,
      wrapApi: (api: SyncApi): SyncApi => ({
        ...api,
        pushChanges: async (rev) => {
          pushes++;
          return { status: "stale", revision: rev + 1 };
        },
      }),
    });
    a.edit(addSession("xa"));
    const before = a.local;
    const serverBefore = serverData(server);
    expect(await a.sync()).toEqual({ status: "busy" });
    expect(pushes).toBe(3);
    expect(a.local).toBe(before);
    expect(a.baselineWrites).toHaveLength(0);
    expect(a.baseline?.revision).toBe(revision);
    expect(serverData(server)).toEqual(serverBefore);
  });

  it("local data changing during the pass is never overwritten: the pass runs again and keeps it", async () => {
    let first = true;
    const ref: { self?: ReturnType<typeof createDevice> } = {};
    const { server, a, b } = await world({
      wrapApi: (api: SyncApi): SyncApi => ({
        ...api,
        pullSnapshot: async () => {
          const r = await api.pullSnapshot();
          if (first) {
            first = false;
            ref.self!.edit(addSession("late")); // a study session saved while the pass is running
          }
          return r;
        },
      }),
    });
    ref.self = a;
    b.edit(addClass("C", "Biology"));
    await b.sync();
    const out = await a.sync();
    expect(out).toMatchObject({ status: "synced" });
    expect(sessionIds(a.snapshot())).toContain("late");
    expect(a.snapshot().classes.map((c) => c.id)).toContain("C");
    expect(sessionIds(serverData(server))).toContain("late");
    expect(a.snapshot()).toEqual(serverData(server));
  });
});

describe("conflicts and refusals never push and never change anything", () => {
  const renamed = (name: string) => (d: ReturnType<typeof baseSnapshot>) => void (d.classes.find((c) => c.id === "A")!.name = name);

  it("a conflict is reported with its decision points; nothing is pushed, applied or saved", async () => {
    const { server, a, b } = await world();
    a.edit(renamed("Maths"));
    b.edit(renamed("Calculus"));
    await b.sync();
    const pushesBefore = pushCount(server);
    const before = a.local;
    const out = await a.sync();
    expect(out.status).toBe("conflicted");
    if (out.status !== "conflicted") return;
    expect(out.decisionPoints.map((p) => p.kind)).toEqual(["field"]);
    expect(pushCount(server)).toBe(pushesBefore);
    expect(a.local).toBe(before);
    expect(a.baselineWrites).toHaveLength(0);
    expect(a.backups).toHaveLength(0);
  });

  it("the user's decision settles it on the next pass (keep mine)", async () => {
    const { server, a, b } = await world();
    a.edit(renamed("Maths"));
    b.edit(renamed("Calculus"));
    await b.sync();
    const first = await a.sync();
    if (first.status !== "conflicted") throw new Error("expected a conflict");
    const decisions = first.decisionPoints.map((p) => ({ fingerprint: p.fingerprint, choice: "keep_local" }));
    expect(statusOf(await a.sync({ decisions }))).toBe("synced");
    expect(serverData(server).classes.find((c) => c.id === "A")?.name).toBe("Maths");
    expect(statusOf(await b.sync())).toBe("synced");
    expect(b.snapshot().classes.find((c) => c.id === "A")?.name).toBe("Maths");
  });

  it("a class deleted here while another device added a session to it: restoring keeps everything", async () => {
    const { server, a, b } = await world();
    a.edit(delClass("B"));
    b.edit((d) => void d.sessions.push(ses("x1", "B", null, 60_000, 45)));
    await b.sync();
    const first = await a.sync();
    if (first.status !== "conflicted") throw new Error("expected a conflict");
    expect(first.decisionPoints.map((p) => p.kind)).toEqual(["class_deleted"]);
    const decisions = first.decisionPoints.map((p) => ({ fingerprint: p.fingerprint, choice: "keep_class" }));
    expect(statusOf(await a.sync({ decisions }))).toBe("synced");
    expect(serverData(server).classes.map((c) => c.id)).toEqual(["A", "B"]);
    expect(sessionIds(serverData(server))).toEqual(expect.arrayContaining(["s3", "s4", "x1"]));
    expect(a.snapshot()).toEqual(serverData(server));
  });

  it("a running timer's class is protected: a remote deletion of it is a conflict", async () => {
    const { server, a, b } = await world({ protect: () => ({ classIds: ["B"] }) });
    b.edit(delClass("B"));
    await b.sync();
    const pushesBefore = pushCount(server);
    const before = a.local;
    const out = await a.sync();
    expect(out.status).toBe("conflicted");
    if (out.status === "conflicted") expect(out.conflicts.map((c) => c.code)).toEqual(["protected_entity_deleted"]);
    expect(pushCount(server)).toBe(pushesBefore);
    expect(a.local).toBe(before);
  });

  it("a server older than the last sync is refused", async () => {
    const server = createFakeSyncServer();
    const { a, revision } = await seedAndLink(server, USER, baseSnapshot());
    const d = createDevice(server, USER, { local: a.local, baseline: { revision: revision + 5, snapshot: a.baseline!.snapshot } });
    d.edit(addSession("x1"));
    const before = d.local;
    const out = await d.sync();
    expect(out).toMatchObject({ status: "refused", reason: "remote_older" });
    expect(pushCount(server)).toBe(0);
    expect(d.local).toBe(before);
    expect(d.baselineWrites).toHaveLength(0);
  });

  it("different server data at the same revision is refused", async () => {
    const server = createFakeSyncServer();
    const { a, revision } = await seedAndLink(server, USER, baseSnapshot());
    const altered = structuredClone(a.baseline!.snapshot);
    altered.classes[0].name = "Something else";
    const d = createDevice(server, USER, { local: a.local, baseline: { revision, snapshot: altered } });
    expect(await d.sync()).toMatchObject({ status: "refused", reason: "remote_changed_without_revision" });
    expect(pushCount(server)).toBe(0);
  });

  it("a device that is not linked does nothing and does not even call the server", async () => {
    const server = createFakeSyncServer();
    const { a } = await seedAndLink(server, USER, baseSnapshot());
    const calls = server.calls.length;
    const d = createDevice(server, USER, { local: a.local, baseline: null });
    expect(await d.sync()).toEqual({ status: "not_linked" });
    expect(server.calls).toHaveLength(calls);
  });

  it("local data that breaks a server rule is reported and nothing is sent", async () => {
    const { server, a } = await world();
    const calls = server.calls.length;
    a.setLocal({ ...a.local, classes: [...a.local.classes, { id: "Z", name: "math", color: "#000000", groups: [] }] });
    const out = await a.sync();
    expect(out.status).toBe("ineligible");
    expect(server.calls).toHaveLength(calls);
  });
});

describe("failures leave local data alone", () => {
  it("offline: the error says so, nothing changes, and the next pass works", async () => {
    const { server, a } = await world();
    a.edit(addSession("x1"));
    const before = a.local;
    server.setMode("network_down");
    const out = await a.sync();
    expect(out).toMatchObject({ status: "error", stage: "pull" });
    if (out.status === "error") expect(out.error.kind).toBe("network");
    expect(a.local).toBe(before);
    expect(a.baselineWrites).toHaveLength(0);
    server.setMode("normal");
    expect(statusOf(await a.sync())).toBe("synced");
    expect(sessionIds(serverData(server))).toContain("x1");
  });

  it("a server error during the push leaves local data and the baseline alone, and a retry sends it once", async () => {
    const { server, a } = await world({
      wrapApi: (api: SyncApi): SyncApi => ({
        ...api,
        pushChanges: async (rev, changes) => {
          if (server.calls.filter((c) => c.fn === "push_changes").length === 0) server.setMode("server_error");
          return api.pushChanges(rev, changes);
        },
      }),
    });
    a.edit(addSession("x1"));
    const before = a.local;
    const out = await a.sync();
    expect(out).toMatchObject({ status: "error", stage: "push" });
    if (out.status === "error") expect(out.error.kind).toBe("server");
    expect(a.local).toBe(before);
    expect(a.baselineWrites).toHaveLength(0);
    server.setMode("normal");
    expect(statusOf(await a.sync())).toBe("synced");
    expect(serverData(server).sessions.filter((s) => s.id === "x1")).toHaveLength(1);
  });

  it("an expired sign-in is an auth error and changes nothing", async () => {
    const { server, a } = await world();
    server.setSessionExpired(USER, true);
    a.edit(addSession("x1"));
    const out = await a.sync();
    expect(out).toMatchObject({ status: "error", stage: "pull" });
    if (out.status === "error") expect(out.error.kind).toBe("auth");
  });

  it("if the backup cannot be saved, remote data is not applied; the next pass recovers without losing or duplicating anything", async () => {
    const { server, a, b } = await world();
    a.edit(addSession("xa"));
    b.edit(addClass("C", "Biology"));
    await b.sync();
    a.state.failBackup = true;
    const before = a.local;
    const out = await a.sync();
    expect(out).toMatchObject({ status: "error", stage: "backup" });
    expect(a.local).toBe(before); // remote data was NOT applied
    expect(a.baselineWrites).toHaveLength(0);
    expect(sessionIds(serverData(server))).toContain("xa"); // the local change did reach the server
    a.state.failBackup = false;
    expect(statusOf(await a.sync())).toBe("synced");
    expect(a.snapshot()).toEqual(serverData(server));
    expect(serverData(server).sessions.filter((s) => s.id === "xa")).toHaveLength(1);
    expect(a.snapshot().classes.map((c) => c.id)).toContain("C");
  });

  it("if the baseline cannot be saved after a good pass, the next pass is still safe", async () => {
    const { server, a, b } = await world();
    a.edit(addSession("xa"));
    b.edit(addClass("C", "Biology"));
    await b.sync();
    a.state.failSaveBaseline = true;
    const out = await a.sync();
    expect(out).toMatchObject({ status: "error", stage: "baseline" });
    a.state.failSaveBaseline = false;
    expect(statusOf(await a.sync())).toBe("synced");
    expect(a.snapshot()).toEqual(serverData(server));
    expect(sessionIds(a.snapshot())).toContain("xa");
    expect(a.snapshot().classes.map((c) => c.id)).toContain("C");
  });
});

describe("running passes", () => {
  it("passes started while one is running share its result (one pull)", async () => {
    const { server, a } = await world();
    a.edit(addSession("x1"));
    const pulls = pullCount(server);
    const [one, two] = await Promise.all([a.sync(), a.sync()]);
    expect(two).toBe(one);
    expect(pullCount(server) - pulls).toBe(1);
    expect(pushCount(server)).toBe(1);
  });
});
