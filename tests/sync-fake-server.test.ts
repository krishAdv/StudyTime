import { describe, expect, it } from "vitest";
import { toImportPayload, type ImportPayload, type SyncChange } from "@/lib/sync/changes";
import type { SyncError } from "@/lib/sync/errors";
import { createFakeSyncServer, type FakeSyncServer } from "./helpers/fake-sync-server";

/**
 * The in-memory server is checked against the SQL contract, not against itself. Most scenarios
 * below are ported from supabase/tests/sync_verify.sql (the same inputs and the same expected
 * SQLSTATE codes), which passed on local PGlite and on the real test project, so a mistake in the
 * model shows up here as a test that disagrees with the SQL.
 */

const A = "user-a";
const B = "user-b";

const addClass = (id: string, name: string, color = "#3b82f6"): SyncChange => ({ op: "add_class", id, name, color });
const addGroup = (id: string, classId: string, name: string): SyncChange => ({ op: "add_group", id, classId, name });
const addSession = (id: string, classId: string, groupId: string | null, startedAt = 1_700_000_000_000, seconds = 60, mode: "stopwatch" | "countdown" = "stopwatch"): SyncChange =>
  ({ op: "add_session", id, classId, groupId, startedAt, seconds, mode });

/** Raw call: exactly what the SQL receives, so malformed requests can be sent. */
const raw = (server: FakeSyncServer, user: string | null, fn: string, args?: Record<string, unknown>) => server.rpcFor(user).rpc(fn, args);
const pushRaw = (server: FakeSyncServer, user: string, base: unknown, changes: unknown) =>
  raw(server, user, "push_changes", { p_base_revision: base, p_changes: changes });

/** A is at revision 4 with: classes c1 Math and c2 Painting, subgroup g1 (of c1), sessions s1 (c1/g1) and s2 (c2). */
async function seededA() {
  const server = createFakeSyncServer();
  const api = server.apiFor(A);
  await api.pushChanges(0, [
    addClass("c1", "Math"),
    addClass("c2", "Art", "#8b5cf6"),
    addGroup("g1", "c1", "Unit 1"),
    addSession("s1", "c1", "g1", 1_700_000_000_123, 1500),
    addSession("s2", "c2", null, 1_700_000_500_000, 90, "countdown"),
  ]);
  await api.pushChanges(1, [{ op: "update_class", id: "c2", name: "Painting" }]);
  await api.pushChanges(2, [{ op: "update_class", id: "c2", name: "painting" }]);
  await api.pushChanges(3, [{ op: "update_class", id: "c2", name: "  Painting " }]);
  expect(server.state(A).revision).toBe(4);
  return server;
}

/** The whole observable state of one user, to prove a rejected call changed nothing. */
const stateOf = (server: FakeSyncServer, user: string) => JSON.stringify(server.state(user));

async function expectRejected(server: FakeSyncServer, user: string, base: number, changes: unknown, code: string) {
  const before = stateOf(server, user);
  const res = await pushRaw(server, user, base, changes);
  expect(res.error?.code, JSON.stringify(changes)).toBe(code);
  expect(res.data).toBeNull();
  expect(stateOf(server, user), "a rejected push must change nothing").toBe(before);
}

async function expectKind(p: Promise<unknown>, kind: string, code?: string) {
  try {
    await p;
  } catch (e) {
    expect((e as SyncError).kind).toBe(kind);
    if (code) expect((e as SyncError).code).toBe(code);
    return;
  }
  throw new Error("expected a rejection");
}

describe("pull_snapshot", () => {
  it("an empty account is revision 0 with empty lists, and no sync row exists yet", async () => {
    const server = createFakeSyncServer();
    expect(await server.apiFor(A).pullSnapshot()).toEqual({ revision: 0, snapshot: { classes: [], groups: [], sessions: [] } });
    expect(server.state(A).hasSyncRow).toBe(false);
  });

  it("returns classes in creation order and sessions oldest first, with exact millisecond start times", async () => {
    const server = await seededA();
    const { snapshot, revision } = await server.apiFor(A).pullSnapshot();
    expect(revision).toBe(4);
    expect(snapshot.classes.map((c) => c.name)).toEqual(["Math", "Painting"]);
    expect(snapshot.groups).toEqual([{ id: "g1", classId: "c1", name: "Unit 1" }]);
    expect(snapshot.sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(snapshot.sessions[0].startedAt).toBe(1_700_000_000_123);
    expect(snapshot.sessions[1].groupId).toBeNull();
  });

  it("is read-only and does not move the revision", async () => {
    const server = await seededA();
    const before = stateOf(server, A);
    await server.apiFor(A).pullSnapshot();
    expect(stateOf(server, A)).toBe(before);
  });

  it("returns every row of a large account in one response (well past 1,000 rows)", async () => {
    const server = createFakeSyncServer();
    const api = server.apiFor(A);
    const ops: SyncChange[] = [addClass("hc", "Big", "#000000")];
    for (let n = 1; n <= 1500; n++) ops.push(addSession(`hs${n}`, "hc", null, 1_700_000_000_000 + n * 1000));
    expect(await api.pushChanges(0, ops)).toEqual({ status: "applied", revision: 1, changed: 1501 });
    const { snapshot } = await api.pullSnapshot();
    expect(snapshot.sessions).toHaveLength(1500);
    expect(snapshot.sessions[0].id).toBe("hs1");
    expect(snapshot.sessions[1499].id).toBe("hs1500");
  });
});

describe("revision rules", () => {
  it("a first push at base 0 is applied and moves the revision to exactly 1", async () => {
    const server = createFakeSyncServer();
    expect(await server.apiFor(A).pushChanges(0, [addClass("c1", "Math")])).toEqual({ status: "applied", revision: 1, changed: 1 });
    expect(server.state(A)).toMatchObject({ revision: 1, hasSyncRow: true });
  });

  it("an older base and a base from the future are both stale and write nothing", async () => {
    const server = await seededA();
    const before = stateOf(server, A);
    const api = server.apiFor(A);
    expect(await api.pushChanges(0, [addClass("late", "Late")])).toEqual({ status: "stale", revision: 4 });
    expect(await api.pushChanges(3, [addClass("late", "Late")])).toEqual({ status: "stale", revision: 4 });
    expect(await api.pushChanges(7, [addClass("late", "Late")])).toEqual({ status: "stale", revision: 4 });
    expect(stateOf(server, A)).toBe(before);
  });

  it("a stale push is answered before any change is looked at, so a bad change inside it is not an error", async () => {
    const server = await seededA();
    const res = await pushRaw(server, A, 0, [{ op: "drop_everything" }]);
    expect(res.error).toBeNull();
    expect(res.data).toEqual({ status: "stale", revision: 4 });
  });

  it("an empty push is applied, changes nothing, keeps the revision and creates no sync row", async () => {
    const server = createFakeSyncServer();
    expect(await server.apiFor(A).pushChanges(0, [])).toEqual({ status: "applied", revision: 0, changed: 0 });
    expect(server.state(A).hasSyncRow).toBe(false);
    const seeded = await seededA();
    expect(await seeded.apiFor(A).pushChanges(4, [])).toEqual({ status: "applied", revision: 4, changed: 0 });
  });

  it("an update that sets the same values, and a move onto the current class and subgroup, change nothing", async () => {
    const server = await seededA();
    const api = server.apiFor(A);
    expect(await api.pushChanges(4, [{ op: "update_class", id: "c2", name: "Painting", color: "#8b5cf6" }])).toEqual({ status: "applied", revision: 4, changed: 0 });
    expect(await api.pushChanges(4, [{ op: "move_session", id: "s1", classId: "c1", groupId: "g1" }])).toEqual({ status: "applied", revision: 4, changed: 0 });
    expect(await api.pushChanges(4, [{ op: "update_class", id: "c1", name: "  math  " }])).toMatchObject({ status: "applied" }); // renames case/spacing: a real change
  });

  it("a real change raises the revision by exactly 1 per push, however many changes it holds", async () => {
    const server = await seededA();
    const api = server.apiFor(A);
    expect(await api.pushChanges(4, [addClass("c3", "Chem"), addClass("c4", "Bio"), addGroup("g9", "c3", "Lab")])).toEqual({ status: "applied", revision: 5, changed: 3 });
  });

  it("repeating a push at its old base is stale: it can never be applied twice", async () => {
    const server = createFakeSyncServer();
    const api = server.apiFor(A);
    const ops = [addClass("c1", "Math")];
    expect(await api.pushChanges(0, ops)).toMatchObject({ status: "applied", revision: 1 });
    expect(await api.pushChanges(0, ops)).toEqual({ status: "stale", revision: 1 });
    expect((await api.pullSnapshot()).snapshot.classes).toHaveLength(1);
  });

  it("a case-only rename of the same class is allowed", async () => {
    const server = await seededA();
    expect(await server.apiFor(A).pushChanges(4, [{ op: "update_class", id: "c2", name: "PAINTING" }])).toMatchObject({ status: "applied", revision: 5 });
  });

  it("names are stored normalized (trimmed, whitespace collapsed)", async () => {
    const server = createFakeSyncServer();
    await server.apiFor(A).pushChanges(0, [addClass("c1", "  Math   101 "), addClass("c2", "Art"), addGroup("g1", "c1", "  Unit   1")]);
    const { snapshot } = await server.apiFor(A).pullSnapshot();
    expect(snapshot.classes[0].name).toBe("Math 101");
    expect(snapshot.groups[0].name).toBe("Unit 1");
  });

  it("rejects a null, negative or non-integer base revision before anything else", async () => {
    const server = await seededA();
    await expectRejected(server, A, null as never, [], "22023");
    await expectRejected(server, A, -1, [], "22023");
    const frac = await pushRaw(server, A, 1.5, []);
    expect(frac.error?.code).toBe("22P02");
  });
});

describe("push_changes: invalid input is rejected and changes nothing (ported from sync_verify.sql)", () => {
  const cases: [string, unknown, string][] = [
    ["changes that are not a list", { op: "add_class" }, "22023"],
    ["a change that is not an object", ["add_class"], "22023"],
    ["a change with no op", [{ id: "x" }], "22023"],
    ["an unknown op", [{ op: "drop_everything" }], "22023"],
    ["an op that is not text", [{ op: 5 }], "22023"],
    ["add_class without an id", [{ op: "add_class", name: "X", color: "#000000" }], "22023"],
    ["an id that is not text", [{ op: "add_class", id: 5, name: "X", color: "#000000" }], "22023"],
    ["an empty id", [{ op: "add_class", id: "", name: "X", color: "#000000" }], "22023"],
    ["an id over 100 characters", [{ op: "add_class", id: "x".repeat(101), name: "X", color: "#000000" }], "22023"],
    ["a name empty after normalization", [{ op: "add_class", id: "x", name: "   ", color: "#000000" }], "22023"],
    ["a name over 60 characters", [{ op: "add_class", id: "x", name: "n".repeat(61), color: "#000000" }], "22023"],
    ["a color that is not #rrggbb", [{ op: "add_class", id: "x", name: "X", color: "blue" }], "22023"],
    ["a duplicate class name (other case)", [{ op: "add_class", id: "x", name: "MATH", color: "#000000" }], "ST003"],
    ["a duplicate class name after normalization", [{ op: "add_class", id: "x", name: "  math  ", color: "#000000" }], "ST003"],
    ["a duplicate class id", [{ op: "add_class", id: "c1", name: "Brand new", color: "#000000" }], "ST003"],
    ["renaming a class to another class's name", [{ op: "update_class", id: "c2", name: "MATH" }], "ST003"],
    ["a duplicate subgroup name in the class", [{ op: "add_group", id: "g9", classId: "c1", name: "UNIT 1" }], "ST003"],
    ["a subgroup id that exists in another class", [{ op: "add_group", id: "g1", classId: "c2", name: "Other" }], "ST003"],
    ["a subgroup of a missing class", [{ op: "add_group", id: "g9", classId: "nope", name: "X" }], "22023"],
    ["a session in a missing class", [{ op: "add_session", id: "sx", classId: "nope", groupId: null, startedAt: 1, seconds: 5, mode: "stopwatch" }], "22023"],
    ["a session using another class's subgroup", [{ op: "add_session", id: "sx", classId: "c2", groupId: "g1", startedAt: 1, seconds: 5, mode: "stopwatch" }], "22023"],
    ["a session with an unsupported mode", [{ op: "add_session", id: "sx", classId: "c1", groupId: null, startedAt: 1, seconds: 5, mode: "pomodoro" }], "22023"],
    ["a session with zero seconds", [{ op: "add_session", id: "sx", classId: "c1", groupId: null, startedAt: 1, seconds: 0, mode: "stopwatch" }], "22023"],
    ["a session with fractional seconds", [{ op: "add_session", id: "sx", classId: "c1", groupId: null, startedAt: 1, seconds: 1.5, mode: "stopwatch" }], "22023"],
    ["seconds sent as text", [{ op: "add_session", id: "sx", classId: "c1", groupId: null, startedAt: 1, seconds: "60", mode: "stopwatch" }], "22023"],
    ["a negative start time", [{ op: "add_session", id: "sx", classId: "c1", groupId: null, startedAt: -5, seconds: 5, mode: "stopwatch" }], "22023"],
    ["a session with no groupId key", [{ op: "add_session", id: "sx", classId: "c1", startedAt: 1, seconds: 5, mode: "stopwatch" }], "22023"],
    ["a duplicate session id", [{ op: "add_session", id: "s1", classId: "c1", groupId: null, startedAt: 1, seconds: 5, mode: "stopwatch" }], "ST003"],
    ["update_class with nothing to update", [{ op: "update_class", id: "c1" }], "22023"],
    ["update_class on a missing class", [{ op: "update_class", id: "nope", name: "X" }], "22023"],
    ["rename_group on a missing subgroup", [{ op: "rename_group", id: "nope", name: "X" }], "22023"],
    [
      "a valid change followed by an invalid one",
      [
        { op: "add_class", id: "tmp", name: "Temp", color: "#123456" },
        { op: "add_session", id: "sx", classId: "nope", groupId: null, startedAt: 1, seconds: 5, mode: "stopwatch" },
      ],
      "22023",
    ],
    [
      "a valid change followed by a name conflict",
      [
        { op: "add_class", id: "tmp", name: "Temp", color: "#123456" },
        { op: "add_class", id: "tmp2", name: "MATH", color: "#123456" },
      ],
      "ST003",
    ],
    ["more than 5,000 changes", Array.from({ length: 5001 }, (_, i) => ({ op: "delete_group", id: `x${i}` })), "22023"],
  ];

  it.each(cases)("%s", async (_label, changes, code) => {
    const server = await seededA();
    await expectRejected(server, A, 4, changes, code);
  });

  it("a change whose own text field is too long (over 1,000 characters) is rejected", async () => {
    const server = await seededA();
    await expectRejected(server, A, 4, [{ op: "add_class", id: "x", name: "N".repeat(1001), color: "#000000" }], "22023");
  });

  it("unknown keys, including user_id and userId, are ignored", async () => {
    const server = createFakeSyncServer();
    const res = await pushRaw(server, B, 0, [{ op: "add_class", id: "c1", name: "Math", color: "#3b82f6", user_id: A, userId: A, anything: 1 }]);
    expect(res.data).toEqual({ status: "applied", revision: 1, changed: 1 });
    expect(server.state(B).snapshot.classes).toHaveLength(1);
    expect(server.state(A).snapshot.classes).toHaveLength(0);
  });
});

describe("constraint order inside one row (CHECK, then unique, then foreign key)", () => {
  it("a bad color on a duplicate id is a check failure (22023), not a conflict", async () => {
    const server = await seededA();
    await expectRejected(server, A, 4, [{ op: "add_class", id: "c1", name: "New", color: "blue" }], "22023");
  });

  it("a duplicate subgroup id in a missing class is a conflict (ST003): the unique check runs before the foreign key", async () => {
    const server = await seededA();
    await expectRejected(server, A, 4, [{ op: "add_group", id: "g1", classId: "nope", name: "X" }], "ST003");
  });

  it("an unsupported mode on a duplicate session id is a check failure (22023)", async () => {
    const server = await seededA();
    await expectRejected(server, A, 4, [{ op: "add_session", id: "s1", classId: "c1", groupId: null, startedAt: 1, seconds: 5, mode: "pomodoro" }], "22023");
  });
});

describe("deleting and moving (ported from sync_verify.sql)", () => {
  it("moves a session to another class and back, changing only its class and subgroup", async () => {
    const server = await seededA();
    const api = server.apiFor(A);
    expect(await api.pushChanges(4, [{ op: "move_session", id: "s1", classId: "c2", groupId: null }])).toMatchObject({ revision: 5 });
    expect((await api.pullSnapshot()).snapshot.sessions.find((s) => s.id === "s1")).toMatchObject({ classId: "c2", groupId: null, seconds: 1500, startedAt: 1_700_000_000_123 });
    expect(await api.pushChanges(5, [{ op: "move_session", id: "s1", classId: "c1", groupId: "g1" }])).toMatchObject({ revision: 6 });
  });

  it("rejects a move to another class that keeps the old subgroup, to a missing class, of a missing session, or without groupId", async () => {
    const server = await seededA();
    await expectRejected(server, A, 4, [{ op: "move_session", id: "s1", classId: "c2", groupId: "g1" }], "22023");
    await expectRejected(server, A, 4, [{ op: "move_session", id: "s1", classId: "nope", groupId: null }], "22023");
    await expectRejected(server, A, 4, [{ op: "move_session", id: "nope", classId: "c1", groupId: null }], "22023");
    await expectRejected(server, A, 4, [{ op: "move_session", id: "s1", classId: "c1" }], "22023");
  });

  it("deleting a subgroup keeps its sessions with the class and no subgroup", async () => {
    const server = await seededA();
    const api = server.apiFor(A);
    expect(await api.pushChanges(4, [{ op: "delete_group", id: "g1" }])).toMatchObject({ revision: 5 });
    const { snapshot } = await api.pullSnapshot();
    expect(snapshot.groups).toEqual([]);
    expect(snapshot.sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(snapshot.sessions[0]).toMatchObject({ classId: "c1", groupId: null });
  });

  it("deleting a missing subgroup is rejected", async () => {
    const server = await seededA();
    await expectRejected(server, A, 4, [{ op: "delete_group", id: "nope" }], "22023");
  });

  it("delete_class refuses (ST004) when the session count differs, and keeps everything", async () => {
    const server = await seededA();
    for (const expectedSessions of [0, 2, 5]) {
      await expectRejected(server, A, 4, [{ op: "delete_class", id: "c1", expectedSessions }], "ST004");
    }
  });

  it("delete_class needs a whole, non-negative expectedSessions and an existing class", async () => {
    const server = await seededA();
    await expectRejected(server, A, 4, [{ op: "delete_class", id: "c1" }], "22023");
    await expectRejected(server, A, 4, [{ op: "delete_class", id: "c1", expectedSessions: -1 }], "22023");
    await expectRejected(server, A, 4, [{ op: "delete_class", id: "c1", expectedSessions: "1" }], "22023");
    await expectRejected(server, A, 4, [{ op: "delete_class", id: "c1", expectedSessions: 1.5 }], "22023");
    await expectRejected(server, A, 4, [{ op: "delete_class", id: "nope", expectedSessions: 0 }], "22023");
  });

  it("delete_class with the right count removes the class, its subgroups and its sessions, and nothing else", async () => {
    const server = await seededA();
    const api = server.apiFor(A);
    expect(await api.pushChanges(4, [{ op: "delete_class", id: "c1", expectedSessions: 1 }])).toMatchObject({ revision: 5 });
    const { snapshot } = await api.pullSnapshot();
    expect(snapshot.classes.map((c) => c.id)).toEqual(["c2"]);
    expect(snapshot.groups).toEqual([]);
    expect(snapshot.sessions.map((s) => s.id)).toEqual(["s2"]);
  });

  it("moving a session out and deleting its class in one push keeps the session (order matters)", async () => {
    const server = await seededA();
    const api = server.apiFor(A);
    const res = await api.pushChanges(4, [
      { op: "move_session", id: "s2", classId: "c1", groupId: null },
      { op: "delete_class", id: "c2", expectedSessions: 0 },
    ]);
    expect(res).toMatchObject({ status: "applied", revision: 5, changed: 2 });
    const { snapshot } = await api.pullSnapshot();
    expect(snapshot.classes.map((c) => c.id)).toEqual(["c1"]);
    expect(snapshot.sessions.find((s) => s.id === "s2")).toMatchObject({ classId: "c1", groupId: null });
  });

  it("the same two changes in the wrong order are refused, and nothing is applied", async () => {
    const server = await seededA();
    await expectRejected(server, A, 4, [
      { op: "delete_class", id: "c2", expectedSessions: 0 },
      { op: "move_session", id: "s2", classId: "c1", groupId: null },
    ], "ST004");
  });

  it("a class can be re-created with a freed name in a later change of the same push", async () => {
    const server = await seededA();
    const api = server.apiFor(A);
    const res = await api.pushChanges(4, [
      { op: "move_session", id: "s2", classId: "c1", groupId: null },
      { op: "delete_class", id: "c2", expectedSessions: 0 },
      addClass("c9", "Painting"),
    ]);
    expect(res).toMatchObject({ status: "applied", changed: 3 });
  });
});

describe("limits", () => {
  it("allows 1,000 classes and rejects 1,001", async () => {
    const server = createFakeSyncServer();
    const ops = (n: number) => Array.from({ length: n }, (_, i) => addClass(`c${i}`, `Class ${i}`));
    expect(await server.apiFor(A).pushChanges(0, ops(1000))).toMatchObject({ status: "applied", changed: 1000 });
    const other = createFakeSyncServer();
    await expectRejected(other, A, 0, ops(1001), "22023");
  }, 30_000);

  it("allows 1,000 subgroups in a class and rejects 1,001", async () => {
    const server = createFakeSyncServer();
    const groups = (n: number) => Array.from({ length: n }, (_, i) => addGroup(`g${i}`, "c1", `Group ${i}`));
    expect(await server.apiFor(A).pushChanges(0, [addClass("c1", "Big"), ...groups(1000)])).toMatchObject({ status: "applied" });
    const other = createFakeSyncServer();
    await expectRejected(other, A, 0, [addClass("c1", "Big"), ...groups(1001)], "22023");
  }, 30_000);

  it("rejects the 100,001st session", async () => {
    const server = createFakeSyncServer();
    const api = server.apiFor(A);
    let revision = 0;
    const first: SyncChange[] = [addClass("c", "C", "#000000")];
    for (let i = 0; i < 100_000; i++) {
      first.push(addSession(`s${i}`, "c", null, i));
      if (first.length === 5000 || i === 99_999) {
        const r = await api.pushChanges(revision, first.splice(0));
        expect(r.status).toBe("applied");
        revision = r.revision;
      }
    }
    expect(server.state(A).snapshot.sessions).toHaveLength(100_000);
    await expectRejected(server, A, revision, [addSession("one-too-many", "c", null, 1)], "22023");
  }, 60_000);
});

describe("account isolation", () => {
  it("the same ids and names can exist in two accounts, with independent revisions", async () => {
    const server = createFakeSyncServer();
    await server.apiFor(A).pushChanges(0, [addClass("c1", "Math"), addSession("s1", "c1", null)]);
    expect(await server.apiFor(B).pushChanges(0, [addClass("c1", "Math"), addSession("s1", "c1", null)])).toEqual({ status: "applied", revision: 1, changed: 2 });
    expect(await server.apiFor(A).pushChanges(1, [addClass("c2", "Art")])).toMatchObject({ revision: 2 });
    expect(server.state(B).revision).toBe(1);
  });

  it("one account cannot see another's rows", async () => {
    const server = await seededA();
    expect(await server.apiFor(B).pullSnapshot()).toEqual({ revision: 0, snapshot: { classes: [], groups: [], sessions: [] } });
  });

  it("one account cannot change, delete, move or attach to another's rows, and the other account is untouched", async () => {
    const server = await seededA();
    await server.apiFor(B).pushChanges(0, [addClass("c1", "Mine")]);
    const aBefore = stateOf(server, A);
    await expectRejected(server, B, 1, [{ op: "move_session", id: "s1", classId: "c1", groupId: null }], "22023");
    await expectRejected(server, B, 1, [{ op: "update_class", id: "c2", name: "Hacked" }], "22023");
    await expectRejected(server, B, 1, [{ op: "delete_class", id: "c2", expectedSessions: 1 }], "22023");
    await expectRejected(server, B, 1, [addSession("bs2", "c2", null, 1)], "22023");
    expect(stateOf(server, A)).toBe(aBefore);
  });

  it("a payload that names another user as owner is stored for the caller", async () => {
    const server = createFakeSyncServer();
    const payload = {
      format: "studytime-export", formatVersion: 1, exportedAt: "2026-10-29T12:00:00.000Z", user_id: A,
      data: {
        classes: [{ id: "ec1", name: "Chemistry", color: "#3b82f6", user_id: A, groups: [] }],
        sessions: [{ id: "es1", classId: "ec1", groupId: null, user_id: A, startedAt: 1_700_000_000_000, seconds: 60, mode: "stopwatch" }],
      },
    };
    const res = await raw(server, B, "import_and_init_sync", { p_import_id: "imp-b", p_payload: payload });
    expect(res.data).toMatchObject({ status: "imported", classes: 1, sessions: 1, revision: 1 });
    expect(server.state(B).snapshot.classes).toHaveLength(1);
    expect(server.state(A).snapshot.classes).toHaveLength(0);
  });

  it("an import record belongs to one account: the same import id is independent in another account", async () => {
    const server = createFakeSyncServer();
    const payload = toImportPayload({ classes: [{ id: "c1", name: "Math", color: "#000000", groups: [] }], sessions: [] }, new Date(0));
    expect(await server.apiFor(A).importAndInitSync("imp", payload)).toMatchObject({ status: "imported" });
    expect(await server.apiFor(B).importAndInitSync("imp", payload)).toMatchObject({ status: "imported" });
  });
});

describe("import_and_init_sync", () => {
  const dataset = () => ({
    classes: [
      { id: "ic1", name: "Biology", color: "#10b981", groups: [{ id: "ig1", name: "Cells" }, { id: "ig2", name: "Genetics" }] },
      { id: "ic2", name: "History", color: "#f59e0b", groups: [] },
    ],
    sessions: [
      { id: "is1", classId: "ic1", groupId: "ig1", startedAt: 1_700_000_000_123, seconds: 1200, mode: "countdown" as const },
      { id: "is2", classId: "ic2", groupId: null, startedAt: 1_700_000_500_000, seconds: 90, mode: "stopwatch" as const },
    ],
  });
  const payload = (): ImportPayload => toImportPayload(dataset(), new Date("2026-10-29T12:00:00.000Z"));

  it("imports into an empty account: counts, revision 1, classes in list order, millisecond times kept", async () => {
    const server = createFakeSyncServer();
    const r = await server.apiFor(A).importAndInitSync("imp-1", payload());
    expect(r).toEqual({ status: "imported", importId: "imp-1", classes: 2, groups: 2, sessions: 2, revision: 1 });
    const { snapshot } = await server.apiFor(A).pullSnapshot();
    expect(snapshot.classes.map((c) => c.name)).toEqual(["Biology", "History"]);
    expect(snapshot.groups.map((g) => g.id)).toEqual(["ig1", "ig2"]);
    expect(snapshot.sessions.find((s) => s.id === "is1")).toMatchObject({ startedAt: 1_700_000_000_123, groupId: "ig1" });
  });

  it("a retry with the same id and an identical payload is already_imported and writes nothing", async () => {
    const server = createFakeSyncServer();
    const api = server.apiFor(A);
    await api.importAndInitSync("imp-1", payload());
    const before = stateOf(server, A);
    expect(await api.importAndInitSync("imp-1", payload())).toEqual({ status: "already_imported", importId: "imp-1", classes: 2, groups: 2, sessions: 2, revision: 1 });
    expect(stateOf(server, A)).toBe(before);
  });

  it("an identical payload with its keys in a different order still counts as identical", async () => {
    const server = createFakeSyncServer();
    await server.apiFor(A).importAndInitSync("imp-1", payload());
    const p = payload();
    const reordered = { data: { sessions: p.data.sessions, classes: p.data.classes }, exportedAt: p.exportedAt, formatVersion: p.formatVersion, format: p.format };
    const res = await raw(server, A, "import_and_init_sync", { p_import_id: "imp-1", p_payload: reordered });
    expect(res.data).toMatchObject({ status: "already_imported" });
  });

  it("a late retry after more edits reports the current revision and does not overwrite the edits", async () => {
    const server = createFakeSyncServer();
    const api = server.apiFor(A);
    await api.importAndInitSync("imp-1", payload());
    expect(await api.pushChanges(1, [{ op: "update_class", id: "ic1", name: "Biology 101" }])).toMatchObject({ revision: 2 });
    expect(await api.importAndInitSync("imp-1", payload())).toMatchObject({ status: "already_imported", revision: 2 });
    expect((await api.pullSnapshot()).snapshot.classes.map((c) => c.name)).toEqual(["Biology 101", "History"]);
  });

  it("the same import id with a different payload is refused (ST001) and changes nothing", async () => {
    const server = createFakeSyncServer();
    const api = server.apiFor(A);
    await api.importAndInitSync("imp-1", payload());
    const before = stateOf(server, A);
    const changed = toImportPayload({ classes: [dataset().classes[0]], sessions: [] }, new Date("2026-10-29T12:00:00.000Z"));
    await expectKind(api.importAndInitSync("imp-1", changed), "import_mismatch", "ST001");
    expect(stateOf(server, A)).toBe(before);
  });

  it("a new import id into an account that already has data is refused (ST002)", async () => {
    const server = createFakeSyncServer();
    const api = server.apiFor(A);
    await api.importAndInitSync("imp-1", payload());
    await expectKind(api.importAndInitSync("imp-2", payload()), "account_not_empty", "ST002");
  });

  it("an account whose data was created by pushes refuses an import and keeps its data and revision", async () => {
    const server = createFakeSyncServer();
    const api = server.apiFor(A);
    await api.pushChanges(0, [addClass("dc1", "Existing")]);
    const before = stateOf(server, A);
    await expectKind(api.importAndInitSync("imp-d", payload()), "account_not_empty", "ST002");
    expect(stateOf(server, A)).toBe(before);
    expect(server.state(A).imports).toEqual([]);
  });

  it("an account emptied by deletes may import again, and the revision goes up from where it was", async () => {
    const server = createFakeSyncServer();
    const api = server.apiFor(A);
    await api.pushChanges(0, [addClass("gc1", "Temp")]);
    await api.pushChanges(1, [{ op: "delete_class", id: "gc1", expectedSessions: 0 }]);
    expect(await api.importAndInitSync("imp-g", payload())).toMatchObject({ status: "imported", revision: 3 });
    expect(await api.importAndInitSync("imp-g", payload())).toMatchObject({ status: "already_imported", revision: 3 });
  });

  it("a failed import leaves nothing behind: no rows, no import record, no sync row", async () => {
    const server = createFakeSyncServer();
    const bad = payload();
    bad.data.sessions.push({ id: "ds2", classId: "nope", groupId: null, startedAt: 1, seconds: 60, mode: "stopwatch" });
    await expectKind(server.apiFor(A).importAndInitSync("imp-e", bad), "invalid_request", "22023");
    expect(server.state(A)).toMatchObject({ revision: 0, hasSyncRow: false, imports: [] });
    expect(server.state(A).snapshot).toEqual({ classes: [], groups: [], sessions: [] });
  });

  describe("malformed payloads are rejected with 22023 and write nothing", () => {
    const envelope = (data: unknown, over: Record<string, unknown> = {}) =>
      ({ format: "studytime-export", formatVersion: 1, exportedAt: "x", data, ...over });
    const goodClass = { id: "a", name: "One", color: "#000000", groups: [] };
    const cases: [string, unknown][] = [
      ["a payload that is not an object", "just a string"],
      ["an empty object", {}],
      ["a null payload", null],
      ["a wrong format name", envelope({ classes: [], sessions: [] }, { format: "other" })],
      ["an unsupported version", envelope({ classes: [], sessions: [] }, { formatVersion: 2 })],
      ["a version that is not a number", envelope({ classes: [], sessions: [] }, { formatVersion: "1" })],
      ["a missing export date", envelope({ classes: [], sessions: [] }, { exportedAt: undefined })],
      ["classes that are not a list", envelope({ classes: {}, sessions: [] })],
      ["sessions that are not a list", envelope({ classes: [], sessions: {} })],
      ["a class name that is not a string", envelope({ classes: [{ ...goodClass, name: 5 }], sessions: [] })],
      ["an empty class name", envelope({ classes: [{ ...goodClass, name: "   " }], sessions: [] })],
      ["duplicate class names after normalization", envelope({ classes: [{ ...goodClass, id: "a", name: "Math  101" }, { ...goodClass, id: "b", name: "math 101" }], sessions: [] })],
      ["duplicate class ids", envelope({ classes: [goodClass, { ...goodClass, name: "Two" }], sessions: [] })],
      ["duplicate subgroup names in one class", envelope({ classes: [{ ...goodClass, groups: [{ id: "g1", name: "Unit" }, { id: "g2", name: "UNIT" }] }], sessions: [] })],
      ["duplicate subgroup ids across classes", envelope({ classes: [{ ...goodClass, groups: [{ id: "g1", name: "X" }] }, { ...goodClass, id: "b", name: "Two", groups: [{ id: "g1", name: "Y" }] }], sessions: [] })],
      ["a session using another class's subgroup", envelope({ classes: [{ ...goodClass, groups: [{ id: "g1", name: "X" }] }, { ...goodClass, id: "b", name: "Two" }], sessions: [{ id: "s", classId: "b", groupId: "g1", startedAt: 1, seconds: 5, mode: "stopwatch" }] })],
      ["a session with a fractional duration", envelope({ classes: [goodClass], sessions: [{ id: "s", classId: "a", groupId: null, startedAt: 1, seconds: 1.5, mode: "stopwatch" }] })],
      ["a session with zero duration", envelope({ classes: [goodClass], sessions: [{ id: "s", classId: "a", groupId: null, startedAt: 1, seconds: 0, mode: "stopwatch" }] })],
      ["a session with an unsupported mode", envelope({ classes: [goodClass], sessions: [{ id: "s", classId: "a", groupId: null, startedAt: 1, seconds: 5, mode: "pomodoro" }] })],
      ["a session with a negative start time", envelope({ classes: [goodClass], sessions: [{ id: "s", classId: "a", groupId: null, startedAt: -5, seconds: 5, mode: "stopwatch" }] })],
      ["a session with no groupId key", envelope({ classes: [goodClass], sessions: [{ id: "s", classId: "a", startedAt: 1, seconds: 5, mode: "stopwatch" }] })],
      ["a class color that is not #rrggbb", envelope({ classes: [{ ...goodClass, color: "blue" }], sessions: [] })],
    ];
    it.each(cases)("%s", async (_label, body) => {
      const server = createFakeSyncServer();
      const res = await raw(server, A, "import_and_init_sync", { p_import_id: "m", p_payload: body });
      expect(res.error?.code).toBe("22023");
      expect(server.state(A)).toMatchObject({ revision: 0, hasSyncRow: false, imports: [] });
    });

    it("an empty import id", async () => {
      const server = createFakeSyncServer();
      const res = await raw(server, A, "import_and_init_sync", { p_import_id: "  ", p_payload: envelope({ classes: [], sessions: [] }) });
      expect(res.error?.code).toBe("22023");
    });

    it("an import name clash is 22023 here, unlike the ST003 a push gives for the same clash", async () => {
      const server = createFakeSyncServer();
      const res = await raw(server, A, "import_and_init_sync", {
        p_import_id: "m",
        p_payload: envelope({ classes: [goodClass, { ...goodClass, id: "b", name: "ONE" }], sessions: [] }),
      });
      expect(res.error?.code).toBe("22023");
    });
  });
});

describe("transport and callers", () => {
  it("only the documented argument names are accepted: anything else is 'function not found' (PGRST202)", async () => {
    const server = await seededA();
    for (const args of [
      { base: 4, changes: [] },
      { p_base_revision: 4 },
      { p_base_revision: 4, p_changes: [], extra: 1 },
      {},
    ]) {
      const res = await raw(server, A, "push_changes", args);
      expect(res.error?.code).toBe("PGRST202");
      expect(res.status).toBe(404);
    }
    expect((await raw(server, A, "pull_snapshot", { p_user_id: A })).error?.code).toBe("PGRST202");
    expect((await raw(server, A, "not_a_function")).error?.code).toBe("PGRST202");
  });

  it("an anonymous caller is refused every function (42501, 401)", async () => {
    const server = await seededA();
    for (const [fn, args] of [
      ["pull_snapshot", undefined],
      ["push_changes", { p_base_revision: 0, p_changes: [] }],
      ["import_and_init_sync", { p_import_id: "x", p_payload: {} }],
    ] as [string, Record<string, unknown> | undefined][]) {
      const res = await raw(server, null, fn, args);
      expect(res.error?.code).toBe("42501");
      expect(res.status).toBe(401);
    }
  });

  it("values cross the wire as JSON: NaN becomes null, and an undefined field disappears", async () => {
    const server = await seededA();
    await expectRejected(server, A, 4, [{ op: "add_session", id: "x", classId: "c1", groupId: null, startedAt: Number.NaN, seconds: 5, mode: "stopwatch" }], "22023");
    await expectRejected(server, A, 4, [{ op: "add_session", id: "x", classId: "c1", groupId: undefined, startedAt: 1, seconds: 5, mode: "stopwatch" }], "22023");
  });

  it("is deterministic: the same calls always give the same state", async () => {
    const a = await seededA();
    const b = await seededA();
    expect(stateOf(a, A)).toBe(stateOf(b, A));
  });

  it("fails if a mode is on and works again when it is turned off", async () => {
    const server = createFakeSyncServer();
    server.setMode("network_down");
    await expectKind(server.apiFor(A).pullSnapshot(), "network");
    server.setMode("normal");
    await expect(server.apiFor(A).pullSnapshot()).resolves.toMatchObject({ revision: 0 });
  });
});
