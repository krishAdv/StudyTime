import { describe, expect, it } from "vitest";
import type { SyncApi } from "../src/lib/sync/api";
import type { SyncChange } from "../src/lib/sync/changes";
import { planReplaceCloud } from "../src/lib/sync/escape";
import type { SyncSnapshot } from "../src/lib/sync/snapshot";
import { KNOWN_TEST_CLASS_IDS, appCallsDuplicate, describeNonEmpty, rawDeleteClasses, unknownClasses } from "../scripts/stage-b/cleanup";
import { createFakeSyncServer } from "./helpers/fake-sync-server";
import { cls, grp, ses, snap, seed } from "./helpers/sync-plan-harness";

const USER = "u";

describe("Stage B raw cleanup (offline, against the fake server)", () => {
  it("empties an account holding classes, subgroups and sessions in one push, and verifies it", async () => {
    const server = createFakeSyncServer();
    const api = server.apiFor(USER);
    await seed(server, USER, snap([cls("A", "Math"), cls("B", "Art")], [grp("g1", "A", "Unit")], [ses("s1", "A", "g1"), ses("s2", "A", null, 2_000), ses("s3", "B", null, 3_000)]));
    const pushes = () => server.calls.filter((c) => c.fn === "push_changes").length;
    const before = pushes();
    const r = await rawDeleteClasses(api, "all");
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(2);
    expect(pushes() - before).toBe(1); // all or nothing
    const after = await api.pullSnapshot();
    expect(after.snapshot).toEqual({ classes: [], groups: [], sessions: [] });
  });

  it("an already empty account sends nothing and reports success", async () => {
    const server = createFakeSyncServer();
    const api = server.apiFor(USER);
    const r = await rawDeleteClasses(api, "all");
    expect(r).toMatchObject({ ok: true, deleted: 0 });
    expect(server.calls.filter((c) => c.fn === "push_changes")).toHaveLength(0);
  });

  it("removes only the classes it is told to, and leaves the others alone", async () => {
    const server = createFakeSyncServer();
    const api = server.apiFor(USER);
    await seed(server, USER, snap([cls("A", "Math"), cls("u1", "One"), cls("u2", "Two")], [], [ses("s1", "A")]));
    const r = await rawDeleteClasses(api, ["u1", "u2"]);
    expect(r.ok).toBe(true);
    const after = (await api.pullSnapshot()).snapshot;
    expect(after.classes.map((c) => c.id)).toEqual(["A"]);
    expect(after.sessions.map((s) => s.id)).toEqual(["s1"]);
  });

  it("uses the exact session count of each class (a wrong count would be refused, so success proves it)", async () => {
    const server = createFakeSyncServer();
    const api = server.apiFor(USER);
    await seed(server, USER, snap([cls("Load", "Load")], [], Array.from({ length: 50 }, (_, i) => ses(`s${i}`, "Load", null, 1_000 + i))));
    expect((await rawDeleteClasses(api, "all")).ok).toBe(true);
  });

  it("cleans up data the app's planner refuses (the B9 case)", async () => {
    // The real database accepted "İstanbul" and "istanbul" as different names; the app's validator calls them duplicates.
    // (The fake server folds them like the real one did NOT, so it can't hold this state: a tiny stub holds exactly it.)
    expect(appCallsDuplicate("İstanbul", "istanbul")).toBe(true);
    let state: SyncSnapshot = snap([cls("u1", "İstanbul", "#000000"), cls("u2", "istanbul", "#000000")]);
    let revision = 11;
    const pushed: SyncChange[][] = [];
    const stub: SyncApi = {
      pullSnapshot: async () => ({ revision, snapshot: structuredClone(state) }),
      pushChanges: async (base, changes) => {
        if (base !== revision) return { status: "stale", revision };
        pushed.push(changes);
        const gone = new Set(changes.map((c) => (c.op === "delete_class" ? c.id : "")));
        state = { classes: state.classes.filter((c) => !gone.has(c.id)), groups: state.groups.filter((g) => !gone.has(g.classId)), sessions: state.sessions.filter((x) => !gone.has(x.classId)) };
        revision += 1;
        return { status: "applied", revision, changed: changes.length };
      },
      importAndInitSync: async () => {
        throw new Error("not used");
      },
    };
    // the planner can not plan anything for this snapshot, which is what stranded the account in the live run
    const plan = planReplaceCloud((await stub.pullSnapshot()).snapshot, snap());
    expect(plan.ok).toBe(false);
    // the raw cleanup can, for just this pair, in one push
    const r = await rawDeleteClasses(stub, ["u1", "u2"]);
    expect(r.ok).toBe(true);
    expect(pushed).toEqual([[{ op: "delete_class", id: "u1", expectedSessions: 0 }, { op: "delete_class", id: "u2", expectedSessions: 0 }]]);
    expect((await stub.pullSnapshot()).snapshot.classes).toEqual([]);
    // and the "empty everything" form works on the same kind of state
    state = snap([cls("u1", "İstanbul", "#000000"), cls("u2", "istanbul", "#000000")]);
    expect((await rawDeleteClasses(stub, "all")).ok).toBe(true);
  });

  it("reports (does not hide) a stale answer and deletes nothing", async () => {
    const server = createFakeSyncServer();
    const real = server.apiFor(USER);
    await seed(server, USER, snap([cls("A", "Math")]));
    const racing = {
      ...real,
      pushChanges: async (rev: number, changes: Parameters<typeof real.pushChanges>[1]) => {
        const cur = await real.pullSnapshot();
        await real.pushChanges(cur.revision, [{ op: "add_class", id: "X", name: "Other", color: "#000000" }]); // someone else pushes first
        return real.pushChanges(rev, changes);
      },
    };
    const r = await rawDeleteClasses(racing, "all");
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/stale/);
    expect((await real.pullSnapshot()).snapshot.classes.map((c) => c.id).sort()).toEqual(["A", "X"]);
  });

  it("lets a network or server error through instead of calling it success", async () => {
    const server = createFakeSyncServer();
    const api = server.apiFor(USER);
    await seed(server, USER, snap([cls("A", "Math")]));
    server.setMode("network_down");
    await expect(rawDeleteClasses(api, "all")).rejects.toMatchObject({ kind: "network" });
  });
});

describe("the allowed-id list (the --cleanup identity check on the fresh snapshot)", () => {
  /** A stub account that records every push, so a test can assert that nothing was sent. */
  function stubAccount(initial: SyncSnapshot, laterSnapshots?: () => SyncSnapshot) {
    let state = initial;
    let revision = 5;
    let pulls = 0;
    const pushes: SyncChange[][] = [];
    const api: SyncApi = {
      pullSnapshot: async () => {
        pulls += 1;
        // the first read is the script's initial identity check; later reads show what is there by then
        if (pulls > 1 && laterSnapshots) state = laterSnapshots();
        return { revision, snapshot: structuredClone(state) };
      },
      pushChanges: async (base, changes) => {
        if (base !== revision) return { status: "stale", revision };
        pushes.push(changes);
        const gone = new Set(changes.map((c) => (c.op === "delete_class" ? c.id : "")));
        const added = changes.flatMap((c) => (c.op === "add_class" ? [{ id: c.id, name: c.name, color: c.color }] : []));
        state = {
          classes: [...state.classes.filter((c) => !gone.has(c.id)), ...added],
          groups: state.groups.filter((g) => !gone.has(g.classId)),
          sessions: state.sessions.filter((x) => !gone.has(x.classId)),
        };
        revision += 1;
        return { status: "applied", revision, changed: changes.length };
      },
      importAndInitSync: async () => {
        throw new Error("not used");
      },
    };
    return { api, pushes, get state() { return state; }, get revision() { return revision; } };
  }

  it("REGRESSION: a class that appears between the initial identity check and the fresh read is refused, and no push is sent", async () => {
    const testData = snap([cls("A", "Math"), cls("u1", "One")], [], [ses("s1", "A")]);
    const withReal = snap([cls("A", "Math"), cls("u1", "One"), cls("class-mvx1-3-ab12", "Biology")], [], [ses("s1", "A"), ses("real1", "class-mvx1-3-ab12")]);
    const acct = stubAccount(testData, () => withReal);

    // 1. the script's initial read and identity check: everything looks like test data
    const first = (await acct.api.pullSnapshot()).snapshot;
    expect(unknownClasses(first.classes)).toEqual([]);

    // 2. the delete takes its own fresh read, now with the extra class in it
    const r = await rawDeleteClasses(acct.api, "all", { allowedIds: KNOWN_TEST_CLASS_IDS });
    expect(r.ok).toBe(false);
    expect(r.deleted).toBe(0);
    expect(r.unexpected).toEqual(["class-mvx1-3-ab12"]);
    expect(r.detail).toMatch(/nothing was sent/);
    expect(acct.pushes).toEqual([]); // no delete push of any kind
    expect(acct.state.classes.map((c) => c.id)).toEqual(["A", "u1", "class-mvx1-3-ab12"]); // everything still there
    expect(acct.state.sessions.map((x) => x.id)).toEqual(["s1", "real1"]);
    expect(acct.revision).toBe(5); // the revision did not move
  });

  it("checks every class in the snapshot, not only the ones it would delete", async () => {
    const acct = stubAccount(snap([cls("u1", "One"), cls("class-real", "Biology")]));
    const r = await rawDeleteClasses(acct.api, ["u1"], { allowedIds: KNOWN_TEST_CLASS_IDS });
    expect(r.ok).toBe(false);
    expect(r.unexpected).toEqual(["class-real"]);
    expect(acct.pushes).toEqual([]);
  });

  it("with only allowed classes it still deletes everything, at the read revision, with exact counts, and verifies", async () => {
    const acct = stubAccount(snap([cls("A", "Math"), cls("Load", "Load")], [grp("g1", "A", "Unit")], [ses("s1", "A", "g1"), ses("s2", "A"), ses("s3", "Load")]));
    const r = await rawDeleteClasses(acct.api, "all", { allowedIds: KNOWN_TEST_CLASS_IDS });
    expect(r.ok).toBe(true);
    expect(r.unexpected).toBeUndefined();
    expect(acct.pushes).toEqual([[{ op: "delete_class", id: "A", expectedSessions: 2 }, { op: "delete_class", id: "Load", expectedSessions: 1 }]]);
    expect(acct.state).toEqual({ classes: [], groups: [], sessions: [] });
  });

  it("an empty account passes the allowlist and sends nothing", async () => {
    const acct = stubAccount(snap());
    expect(await rawDeleteClasses(acct.api, "all", { allowedIds: KNOWN_TEST_CLASS_IDS })).toMatchObject({ ok: true, deleted: 0 });
    expect(acct.pushes).toEqual([]);
  });

  it("without an allowlist behavior is unchanged: B9's own cleanup removes only u1 and u2 even when other classes exist", async () => {
    const acct = stubAccount(snap([cls("A", "Math"), cls("u1", "One"), cls("u2", "Two")]));
    const r = await rawDeleteClasses(acct.api, ["u1", "u2"]);
    expect(r.ok).toBe(true);
    expect(acct.state.classes.map((c) => c.id)).toEqual(["A"]);
    expect(acct.pushes).toEqual([[{ op: "delete_class", id: "u1", expectedSessions: 0 }, { op: "delete_class", id: "u2", expectedSessions: 0 }]]);
  });

  it("the revision protection is kept: a stale answer after the allowlist check deletes nothing", async () => {
    const acct = stubAccount(snap([cls("u1", "One")]));
    const racing: SyncApi = {
      ...acct.api,
      pushChanges: async (rev, changes) => {
        await acct.api.pushChanges(5, [{ op: "add_class", id: "R1", name: "Race", color: "#000000" }]); // someone else pushes first
        return acct.api.pushChanges(rev, changes);
      },
    };
    const r = await rawDeleteClasses(racing, "all", { allowedIds: KNOWN_TEST_CLASS_IDS });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/stale/);
    expect(acct.state.classes.map((c) => c.id).sort()).toEqual(["R1", "u1"]); // the competing class is there, u1 was NOT deleted
    expect(acct.pushes).toEqual([[{ op: "add_class", id: "R1", name: "Race", color: "#000000" }]]); // only the competing push landed
  });
});

describe("the final read-back must show ALL THREE collections empty", () => {
  /** An account whose delete is "accepted" but leaves `leftover` behind, as a broken or partial delete would. */
  function leakyAccount(leftover: Partial<SyncSnapshot>) {
    let state: SyncSnapshot = snap([cls("A", "Math")], [grp("g1", "A", "Unit")], [ses("s1", "A", "g1")]);
    let revision = 3;
    const api: SyncApi = {
      pullSnapshot: async () => ({ revision, snapshot: structuredClone(state) }),
      pushChanges: async (base) => {
        if (base !== revision) return { status: "stale", revision };
        state = { classes: leftover.classes ?? [], groups: leftover.groups ?? [], sessions: leftover.sessions ?? [] };
        revision += 1;
        return { status: "applied", revision, changed: 1 };
      },
      importAndInitSync: async () => {
        throw new Error("not used");
      },
    };
    return api;
  }

  it("REGRESSION: does NOT report success when a subgroup remains, even with no classes and no sessions", async () => {
    const r = await rawDeleteClasses(leakyAccount({ groups: [grp("g1", "A", "Unit")] }), "all");
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/0 class\(es\), 1 subgroup\(s\) and 0 session\(s\) remain/);
  });

  it("does not report success when a session remains", async () => {
    const r = await rawDeleteClasses(leakyAccount({ sessions: [ses("s1", "A")] }), "all");
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/0 class\(es\), 0 subgroup\(s\) and 1 session\(s\) remain/);
  });

  it("does not report success when a class remains", async () => {
    const r = await rawDeleteClasses(leakyAccount({ classes: [cls("A", "Math")] }), "all");
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/1 class\(es\), 0 subgroup\(s\) and 0 session\(s\) remain/);
  });

  it("reports success only when classes, subgroups and sessions are all gone", async () => {
    const r = await rawDeleteClasses(leakyAccount({}), "all");
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/1 class\(es\) removed/);
  });

  it("the allowed-id form is verified the same way", async () => {
    const r = await rawDeleteClasses(leakyAccount({ groups: [grp("g1", "A", "Unit")] }), "all", { allowedIds: KNOWN_TEST_CLASS_IDS });
    expect(r.ok).toBe(false);
  });
});

describe("Stage B refuses to start unless classes, subgroups AND sessions are all empty", () => {
  it("REGRESSION: an account with no classes and no sessions but one subgroup is NOT empty, and the counts are reported", () => {
    const state = snap([], [grp("g1", "A", "Unit")], []);
    expect(describeNonEmpty(state)).toBe("0 class(es), 1 subgroup(s) and 0 session(s)");
  });

  it("refuses when only classes, or only sessions, are present", () => {
    expect(describeNonEmpty(snap([cls("A", "Math")]))).toBe("1 class(es), 0 subgroup(s) and 0 session(s)");
    expect(describeNonEmpty(snap([], [], [ses("s1", "A")]))).toBe("0 class(es), 0 subgroup(s) and 1 session(s)");
  });

  it("reports every count when everything is present", () => {
    expect(describeNonEmpty(snap([cls("A", "Math"), cls("B", "Art")], [grp("g1", "A", "Unit")], [ses("s1", "A"), ses("s2", "A"), ses("s3", "B")]))).toBe(
      "2 class(es), 1 subgroup(s) and 3 session(s)",
    );
  });

  it("accepts an account that is empty in all three collections", () => {
    expect(describeNonEmpty(snap())).toBeNull();
  });
});

describe("the --cleanup safety rule and the B9 verdict", () => {
  it("refuses an account holding a class this script does not create", () => {
    expect(unknownClasses([{ id: "A", name: "Math" }, { id: "Load", name: "Load" }])).toEqual([]);
    expect(unknownClasses([{ id: "A", name: "Math" }, { id: "class-mvx1-3-ab12", name: "Biology" }])).toEqual([{ id: "class-mvx1-3-ab12", name: "Biology" }]);
    for (const id of KNOWN_TEST_CLASS_IDS) expect(unknownClasses([{ id, name: "x" }])).toEqual([]);
  });

  it("says what the app's validator makes of each B9 pair", () => {
    expect(appCallsDuplicate("İstanbul", "istanbul")).toBe(true);
    expect(appCallsDuplicate("Éclair", "éclair")).toBe(true);
    expect(appCallsDuplicate("Straße", "STRASSE")).toBe(false);
    expect(appCallsDuplicate("Math", "Art")).toBe(false);
  });
});
