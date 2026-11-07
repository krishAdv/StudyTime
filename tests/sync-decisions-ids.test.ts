import { describe, expect, it } from "vitest";
import { validateDecisions, type DecisionPoint } from "@/lib/sync/decisions";
import { fromSyncSnapshot } from "@/lib/sync/from-snapshot";
import { merge3, type MergeResult } from "@/lib/sync/merge";
import type { SyncSnapshot } from "@/lib/sync/snapshot";
import { goldenCases } from "./helpers/golden-scenarios";
import { baseSnapshot } from "./helpers/merge-fixtures";
import { clone, mergeAndPush, mergedTarget } from "./helpers/merge-harness";
import { cls, grp, ses, snap } from "./helpers/sync-plan-harness";

/**
 * Ids are arbitrary strings that pass eligibility, so names that exist on Object.prototype are valid ids. Before the
 * fix, an entity whose id was "__proto__" made `merge3` THROW (the decision-point context was built on plain objects).
 */

describe("ordinary ids keep exactly the fingerprints they had before the prototype-safety fix", () => {
  // Recorded from the code before the fix (see tests/helpers/golden-scenarios.ts). Do not edit these values: a change
  // to the fingerprint format needs a new version prefix instead.
  const GOLDEN: Record<string, string> = {
    "field": "sf1:e1a491ef90143b6894c40a5bcb763539c3a9b6eb860c5a823f2112d84f08d2a2",
    "class edited vs deleted": "sf1:8fe31c21541a11bfb5ce362ea3b9e2c902336bc3486349926d32851f400d62b8",
    "group edited vs deleted": "sf1:3454656c397df711064ac789e82414989d69c5d8a3e81085b6b4d8b9d90d7fb3",
    "class cluster": "sf1:1228cfb9752fc29849534e615cb1e92794864e941889f0330b43653342053202",
    "move": "sf1:47a72ed39b5dcc05b7895c640e2455dbb5efe0696957beeb527b5f939207637b",
    "name collision": "sf1:bcd76df78e9e9a6b4ea8eca5a841395d66a591a57b6e092ce491ea378c4e11de",
    "group cluster": "sf1:a9b730f775199aeafc7da70bfb87aa7e271beb2f439c3fd8829c3c6fdbbb15e2",
    "session removal": "sf1:3a4660516f918eee2b07c97897750464aad44063b14135a977ce6ba529e8f02e",
    "group class mismatch": "sf1:723d49de491b5d009493f09d6cf486e256dea86697f9772cd9e829108deb6ea5",
  };

  it("covers every golden scenario", () => {
    expect(goldenCases().map((c) => c.name).sort()).toEqual(Object.keys(GOLDEN).sort());
  });

  for (const c of goldenCases()) {
    it(`${c.name}`, () => {
      const r = merge3(baseSnapshot(), c.local, c.remote);
      expect(r.status).toBe("conflicted");
      expect(r.status === "conflicted" && r.decisionPoints.map((p) => p.fingerprint)).toEqual([GOLDEN[c.name]]);
    });
  }
});

// A base whose ids are names found on Object.prototype, in every role:
//   classes  "__proto__" (Alpha), "constructor" (Beta)
//   groups   "toString" in "__proto__", "hasOwnProperty" in "constructor"
//   sessions "valueOf" (in "__proto__"/"toString"), "isPrototypeOf" (in "__proto__"), "propertyIsEnumerable" (in "constructor"/"hasOwnProperty"),
//            and a session called "__proto__" (in "constructor")
const trickyBase = (): SyncSnapshot =>
  snap(
    [cls("__proto__", "Alpha"), cls("constructor", "Beta", "#8b5cf6")],
    [grp("toString", "__proto__", "Unit 1"), grp("hasOwnProperty", "constructor", "Unit 2")],
    [
      ses("valueOf", "__proto__", "toString", 1_000, 60),
      ses("isPrototypeOf", "__proto__", null, 2_000, 120),
      ses("propertyIsEnumerable", "constructor", "hasOwnProperty", 3_000, 180),
      ses("__proto__", "constructor", null, 4_000, 240),
    ],
  );

const withEdits = (...edits: ((d: SyncSnapshot) => void)[]) => {
  const d = trickyBase();
  for (const e of edits) e(d);
  return d;
};
const find = {
  cls: (d: SyncSnapshot, id: string) => d.classes.find((c) => c.id === id)!,
  grp: (d: SyncSnapshot, id: string) => d.groups.find((g) => g.id === id)!,
  ses: (d: SyncSnapshot, id: string) => d.sessions.find((s) => s.id === id)!,
};
const dropClass = (id: string) => (d: SyncSnapshot) => {
  d.classes = d.classes.filter((c) => c.id !== id);
  d.groups = d.groups.filter((g) => g.classId !== id);
  d.sessions = d.sessions.filter((s) => s.classId !== id);
};
const dropGroup = (id: string) => (d: SyncSnapshot) => {
  d.groups = d.groups.filter((g) => g.id !== id);
  for (const s of d.sessions) if (s.groupId === id) s.groupId = null;
};

/** merge3 must stay a pure function that returns a result; it must never throw for a valid id. */
function conflicted(local: SyncSnapshot, remote: SyncSnapshot, base = trickyBase()) {
  for (const [name, s] of [["base", base], ["local", local], ["remote", remote]] as const) expect(fromSyncSnapshot(s).ok, `${name} must be eligible`).toBe(true);
  let r: MergeResult | undefined;
  expect(() => (r = merge3(base, clone(local), clone(remote)))).not.toThrow();
  if (!r || r.status !== "conflicted") throw new Error(`expected conflicts, got ${r?.status}`);
  return r;
}
const FP = /^sf1:[0-9a-f]{64}$/;
const kinds = (points: DecisionPoint[]) => points.map((p) => `${p.kind}:${p.entity}:${p.id}`);

describe("conflicting merges with ids that exist on Object.prototype", () => {
  it("the base is eligible (so these really are valid ids)", () => {
    expect(fromSyncSnapshot(trickyBase()).ok).toBe(true);
  });

  it("a field conflict on a class called __proto__ returns a conflicted result with one point", () => {
    const r = conflicted(withEdits((d) => (find.cls(d, "__proto__").name = "Alpha L")), withEdits((d) => (find.cls(d, "__proto__").name = "Alpha R")));
    expect(kinds(r.decisionPoints)).toEqual(["field:class:__proto__"]);
    expect(r.decisionPoints[0].fingerprint).toMatch(FP);
    expect(r.decisionPoints[0].ids).toEqual(["__proto__"]);
  });

  it("the entity really is part of the fingerprint (it is not silently dropped)", () => {
    const fp = (remoteName: string) =>
      conflicted(withEdits((d) => (find.cls(d, "__proto__").name = "Alpha L")), withEdits((d) => (find.cls(d, "__proto__").name = remoteName))).decisionPoints[0].fingerprint;
    expect(fp("Alpha R")).toBe(fp("Alpha R"));
    expect(fp("Alpha R")).not.toBe(fp("Alpha S"));
    const baseChanged = conflicted(
      withEdits((d) => (find.cls(d, "__proto__").name = "Alpha L")),
      withEdits((d) => (find.cls(d, "__proto__").name = "Alpha R")),
      withEdits((d) => (find.cls(d, "__proto__").color = "#111111")),
    );
    expect(baseChanged.decisionPoints[0].fingerprint).not.toBe(fp("Alpha R"));
  });

  it("a deleted class called constructor, with dependents called __defineGetter__, hasOwnProperty and toLocaleString, is one point", () => {
    const local = withEdits(
      (d) => d.sessions.push(ses("toLocaleString", "constructor", null, 9_000, 30)),
      (d) => d.groups.push(grp("__defineGetter__", "constructor", "New")),
      (d) => (find.grp(d, "hasOwnProperty").name = "Renamed"),
    );
    const r = conflicted(local, withEdits(dropClass("constructor")));
    expect(r.conflicts.map((c) => c.code).sort()).toEqual(["class_deleted_but_groups_added", "class_deleted_but_groups_modified", "class_deleted_but_sessions_added"]);
    expect(kinds(r.decisionPoints)).toEqual(["class_deleted:class:constructor"]);
    const [p] = r.decisionPoints;
    expect(p.ids).toEqual(["__defineGetter__", "constructor", "hasOwnProperty", "toLocaleString"]);
    expect(p.choices[1]).toMatchObject({ key: "delete_class", destructive: true, sessionsRemoved: 3 }); // propertyIsEnumerable, __proto__ and toLocaleString
    expect(p.fingerprint).toMatch(FP);
  });

  it("the session called __proto__ moved into a deleted group called toString: one id that is both a class and a session", () => {
    const moved = (className: string) =>
      withEdits((d) => Object.assign(find.ses(d, "__proto__"), { classId: "__proto__", groupId: "toString" }), (d) => (find.cls(d, "__proto__").name = className));
    const run = (className: string) => conflicted(moved(className), withEdits(dropGroup("toString")));
    const r = run("Alpha");
    expect(r.conflicts.map((c) => `${c.code}:${c.id}`)).toEqual(["group_deleted_but_sessions_moved_in:__proto__"]);
    expect(kinds(r.decisionPoints)).toEqual(["group_deleted:group:toString"]);
    expect(r.decisionPoints[0].ids).toEqual(["__proto__", "toString"]);
    // "__proto__" is a class id AND a session id here; both records are in the context (a change to either one changes the fingerprint)
    expect(run("Alpha").decisionPoints[0].fingerprint).toBe(r.decisionPoints[0].fingerprint);
    expect(run("Alpha 2").decisionPoints[0].fingerprint).not.toBe(r.decisionPoints[0].fingerprint);
    // a session added to the same deleted group changes the subtree, so the decision must be asked again
    const more = conflicted(
      withEdits((d) => Object.assign(find.ses(d, "__proto__"), { classId: "__proto__", groupId: "toString" }), (d) => d.sessions.push(ses("zzz", "__proto__", "toString", 9_000, 30))),
      withEdits(dropGroup("toString")),
    );
    expect(more.decisionPoints[0].fingerprint).not.toBe(r.decisionPoints[0].fingerprint);
  });

  it("a move conflict and a missing session, both on sessions with prototype names", () => {
    const move = conflicted(
      withEdits((d) => Object.assign(find.ses(d, "__proto__"), { classId: "__proto__", groupId: null })),
      withEdits((d) => Object.assign(find.ses(d, "__proto__"), { classId: "constructor", groupId: "hasOwnProperty" })),
    );
    expect(kinds(move.decisionPoints)).toEqual(["move:session:__proto__"]);

    const missing = conflicted(withEdits((d) => (d.sessions = d.sessions.filter((s) => s.id !== "valueOf"))), trickyBase());
    expect(kinds(missing.decisionPoints)).toEqual(["session_removal:session:valueOf"]);
  });

  it("a name collision between classes called __proto__ and constructor, and a rename decision naming them", () => {
    const empty = snap();
    const local = snap([cls("__proto__", "Bio")]);
    const remote = snap([cls("constructor", "bio")]);
    const r = conflicted(local, remote, empty);
    expect(kinds(r.decisionPoints)).toEqual(["name_collision:class:__proto__"]);
    const [p] = r.decisionPoints;
    expect(p.ids).toEqual(["__proto__", "constructor"]);

    // The names object comes from JSON so that "__proto__" is an own key, as it is when a decision is read back from text.
    const renameProto = JSON.parse(`{"fingerprint":"${p.fingerprint}","choice":"rename","names":{"__proto__":"Biology"}}`);
    const out = validateDecisions(r.decisionPoints, [renameProto]);
    expect(out.rejected).toEqual([]);
    expect(Object.keys(out.accepted[0].decision.names ?? {})).toEqual(["__proto__"]);
    expect(out.accepted[0].decision.names?.["__proto__"]).toBe("Biology");

    const renameConstructor = JSON.parse(`{"fingerprint":"${p.fingerprint}","choice":"rename","names":{"constructor":"Biology","__proto__":"Biology 2"}}`);
    expect(validateDecisions(r.decisionPoints, [renameConstructor]).accepted).toHaveLength(1);

    // an id that is NOT part of the point is rejected even though it exists on Object.prototype
    for (const outsider of ["toString", "hasOwnProperty", "valueOf"]) {
      const bad = JSON.parse(`{"fingerprint":"${p.fingerprint}","choice":"rename","names":{"${outsider}":"Biology"}}`);
      expect(validateDecisions(r.decisionPoints, [bad]).rejected.map((x) => x.reason), outsider).toEqual(["invalid_payload"]);
    }
  });

  it("the same decision made twice about such ids collapses, and two choices for one point are rejected", () => {
    const r = conflicted(withEdits((d) => (find.cls(d, "constructor").name = "Beta L")), withEdits((d) => (find.cls(d, "constructor").name = "Beta R")));
    const [p] = r.decisionPoints;
    const a = JSON.parse(`{"fingerprint":"${p.fingerprint}","choice":"keep_local"}`);
    const b = JSON.parse(`{"fingerprint":"${p.fingerprint}","choice":"keep_remote"}`);
    expect(validateDecisions(r.decisionPoints, [a, a]).accepted).toHaveLength(1);
    expect(validateDecisions(r.decisionPoints, [a, b]).rejected.map((x) => x.reason)).toEqual(["duplicate_conflicting", "duplicate_conflicting"]);
  });

  it("every prototype-named id behaves the same, in every role, in one-sided and conflicting merges", () => {
    const NAMES = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "__defineGetter__", "__lookupGetter__", "prototype", "length"];
    for (const id of NAMES) {
      const base = snap([cls(id, "Alpha")], [grp(id, id, "Unit 1")], [ses(id, id, id, 1_000, 60)]);
      const edit = (name: string) => {
        const d = clone(base);
        d.classes[0].name = name;
        d.groups[0].name = name + " group";
        return d;
      };
      // conflicting renames of the class and the group
      const r = conflicted(edit("Left"), edit("Right"), base);
      expect(kinds(r.decisionPoints).sort(), id).toEqual([`field:class:${id}`, `field:group:${id}`].sort());
      for (const p of r.decisionPoints) expect(p.fingerprint, id).toMatch(FP);
      // the class deleted on one side and edited on the other (the session shares the id too)
      const gone = snap();
      const del = conflicted(edit("Left"), gone, base);
      expect(kinds(del.decisionPoints), id).toEqual([`class_deleted:class:${id}`]);
      // one-sided: merges normally
      expect(merge3(base, edit("Left"), base).status, id).toBe("merged");
    }
  });

  it("a conflict-free merge with such ids is merged and can be pushed through the planner and the fake server", async () => {
    const local = withEdits((d) => (find.cls(d, "constructor").name = "Beta 2"), (d) => d.sessions.push(ses("toLocaleString", "__proto__", null, 9_000, 30)));
    const remote = withEdits((d) => (find.grp(d, "toString").name = "Unit One"));
    const { result, target } = await mergeAndPush(trickyBase(), local, remote);
    expect(result.status).toBe("merged");
    expect(find.cls(target, "constructor").name).toBe("Beta 2");
    expect(find.grp(target, "toString").name).toBe("Unit One");
    expect(target.sessions.map((s) => s.id).sort()).toEqual(["__proto__", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "valueOf"]);
    expect(mergedTarget(merge3(trickyBase(), local, remote))).toEqual(target);
  });
});
