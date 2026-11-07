import { describe, expect, it } from "vitest";
import { buildDecisionPoints, validateDecisions, type Decision, type DecisionPoint } from "@/lib/sync/decisions";
import { merge3 } from "@/lib/sync/merge";
import type { SyncSnapshot } from "@/lib/sync/snapshot";
import { conflictedOf, addSession, baseSnapshot, delClass, delGroup, edited, find, move, renameClass, renameGroup, type Edit } from "./helpers/merge-fixtures";
import { clone, deepFreeze } from "./helpers/merge-harness";
import { cls, grp, ses } from "./helpers/sync-plan-harness";

const kinds = (points: DecisionPoint[]) => points.map((p) => `${p.kind}:${p.entity}:${p.id}`);
const choiceKeys = (p: DecisionPoint) => p.choices.map((c) => c.key);

/** Class B deleted remotely; locally a session and a subgroup were added under it and a subgroup renamed. */
const classCluster = (extra: (d: SyncSnapshot) => void = () => {}) =>
  conflictedOf(
    edited(addSession("x1", "B"), (d) => d.groups.push(grp("g9", "B", "New")), renameGroup("g3", "Paint"), extra),
    edited(delClass("B")),
  );

describe("decision points: one per thing the user decides", () => {
  it("a deleted class with several dependents is ONE point with every conflict as a member", () => {
    const r = classCluster();
    expect(r.conflicts.map((c) => c.code).sort()).toEqual([
      "class_deleted_but_groups_added", "class_deleted_but_groups_modified", "class_deleted_but_sessions_added",
    ]);
    expect(kinds(r.decisionPoints)).toEqual(["class_deleted:class:B"]);
    const [p] = r.decisionPoints;
    expect([...p.members].sort()).toEqual([0, 1, 2]);
    expect(choiceKeys(p)).toEqual(["keep_class", "delete_class"]);
    expect(p.choices[0].destructive).toBe(false);
    expect(p.choices[1]).toMatchObject({ key: "delete_class", destructive: true, sessionsRemoved: 3 }); // s3, s4 and the new x1
    expect(p.choices.map((c) => c.unavailable !== undefined)).toEqual([false, true]); // restoring a class works (Phase 3); deleting it is not implemented
    expect(p.ids).toEqual(["B", "g3", "g9", "x1"]);
  });

  it("a class deleted on one side and edited on the other is a class_deleted point", () => {
    const r = conflictedOf(edited(renameClass("B", "Drawing")), edited(delClass("B")));
    expect(kinds(r.decisionPoints)).toEqual(["class_deleted:class:B"]);
    expect(r.decisionPoints[0].members).toHaveLength(1);
  });

  it("a deleted subgroup with sessions added or moved in is ONE group_deleted point", () => {
    const r = conflictedOf(edited(addSession("x1", "A", "g1"), move("s2", "A", "g1")), edited(delGroup("g1")));
    expect(r.conflicts.map((c) => c.code).sort()).toEqual(["group_deleted_but_sessions_added", "group_deleted_but_sessions_moved_in"]);
    expect(kinds(r.decisionPoints)).toEqual(["group_deleted:group:g1"]);
    expect(choiceKeys(r.decisionPoints[0])).toEqual(["keep_group", "ungroup"]);
    expect(r.decisionPoints[0].choices.every((c) => !c.destructive)).toBe(true);
  });

  it("a subgroup deleted against a rename is a group_deleted point", () => {
    expect(kinds(conflictedOf(edited(delGroup("g2")), edited(renameGroup("g2", "Renamed"))).decisionPoints)).toEqual(["group_deleted:group:g2"]);
  });

  it("two deleted things are two points, and unrelated conflicts are their own points", () => {
    const r = conflictedOf(
      edited(addSession("x1", "B"), addSession("x2", "A", "g1"), renameClass("A", "Maths")),
      edited(delClass("B"), delGroup("g1"), renameClass("A", "Calculus")),
    );
    // sorted by entity, then id, then kind
    expect(kinds(r.decisionPoints)).toEqual(["field:class:A", "class_deleted:class:B", "group_deleted:group:g1"]);
  });

  it("field, move, add-mismatch and collision conflicts are one point each with their own choices", () => {
    const field = conflictedOf(edited(renameClass("A", "Maths")), edited(renameClass("A", "Calculus")));
    expect(kinds(field.decisionPoints)).toEqual(["field:class:A"]);
    expect(choiceKeys(field.decisionPoints[0])).toEqual(["keep_local", "keep_remote"]);

    const both = conflictedOf(edited(renameClass("A", "Maths"), (d) => (find.cls(d, "A").color = "#111111")), edited(renameClass("A", "Calculus"), (d) => (find.cls(d, "A").color = "#222222")));
    expect(both.decisionPoints).toHaveLength(2); // name and color are separate decisions
    expect(new Set(both.decisionPoints.map((p) => p.fingerprint)).size).toBe(2);

    const mv = conflictedOf(edited(move("s2", "A", "g2")), edited(move("s2", "B", null)));
    expect(kinds(mv.decisionPoints)).toEqual(["move:session:s2"]);
    expect(choiceKeys(mv.decisionPoints[0])).toEqual(["keep_local", "keep_remote"]);

    const add = conflictedOf(edited((d) => d.classes.push(cls("N", "One"))), edited((d) => d.classes.push(cls("N", "Two"))));
    expect(kinds(add.decisionPoints)).toEqual(["add_mismatch:class:N"]);

    const collide = conflictedOf(edited((d) => d.classes.push(cls("C1", "Bio"))), edited((d) => d.classes.push(cls("C2", "bio"))));
    expect(kinds(collide.decisionPoints)).toEqual(["name_collision:class:C1"]);
    expect(collide.decisionPoints[0].ids).toEqual(["C1", "C2"]);
    expect(choiceKeys(collide.decisionPoints[0])).toEqual(["rename"]);
  });

  it("a subgroup that changed class under a moved session is a group_class_mismatch point", () => {
    const r = conflictedOf(edited((d) => (find.grp(d, "g2").classId = "B")), edited(move("s2", "A", "g2")));
    expect(kinds(r.decisionPoints)).toEqual(["group_class_mismatch:session:s2"]);
    expect(choiceKeys(r.decisionPoints[0])).toEqual(["ungroup_session"]);
  });

  it("a missing session is a session_removal point whose `remove` is marked unavailable for now", () => {
    const r = conflictedOf(edited((d) => (d.sessions = d.sessions.filter((s) => s.id !== "s2"))), baseSnapshot());
    expect(kinds(r.decisionPoints)).toEqual(["session_removal:session:s2"]);
    const [restore, remove] = r.decisionPoints[0].choices;
    expect(restore).toMatchObject({ key: "restore", destructive: false });
    expect(restore.unavailable).toMatch(/not implemented/);
    expect(remove).toMatchObject({ key: "remove", destructive: true, sessionsRemoved: 1 });
    expect(remove.unavailable).toMatch(/not implemented/);
  });

  it("a protected deletion is not a decision point (deferred to the engine)", () => {
    const r = conflictedOf(baseSnapshot(), edited(delClass("B")), baseSnapshot(), { protect: { classIds: ["B"] } });
    expect(r.conflicts.map((c) => c.code)).toEqual(["protected_entity_deleted"]);
    expect(r.decisionPoints).toEqual([]);
  });

  it("every other conflict belongs to exactly one point, and members index the conflicts list", () => {
    const r = classCluster();
    const used = r.decisionPoints.flatMap((p) => p.members).sort();
    expect(used).toEqual(r.conflicts.map((_, i) => i));
    const field = conflictedOf(edited(renameClass("A", "Maths")), edited(renameClass("A", "Calculus")));
    expect(field.decisionPoints.flatMap((p) => p.members).sort()).toEqual([0]);
  });

  it("a merged result has no decision points", () => {
    expect("decisionPoints" in merge3(baseSnapshot(), baseSnapshot(), baseSnapshot())).toBe(false);
  });
});

describe("fingerprints of decision points", () => {
  const fp = (r = classCluster()) => r.decisionPoints[0].fingerprint;

  it("are sf1 fingerprints, deterministic across calls, clones and input order", () => {
    const f = fp();
    expect(f).toMatch(/^sf1:[0-9a-f]{64}$/);
    expect(fp()).toBe(f);
    const reversed = (s: SyncSnapshot): SyncSnapshot => ({ classes: [...s.classes].reverse(), groups: [...s.groups].reverse(), sessions: [...s.sessions].reverse() });
    const local = edited(addSession("x1", "B"), (d) => d.groups.push(grp("g9", "B", "New")), renameGroup("g3", "Paint"));
    const r = merge3(reversed(baseSnapshot()), reversed(local), reversed(edited(delClass("B"))));
    expect(r.status === "conflicted" && r.decisionPoints[0].fingerprint).toBe(f);
  });

  it("change when a further dependent is added to the deleted class", () => {
    expect(fp(classCluster(addSession("x2", "B")))).not.toBe(fp());
    expect(fp(classCluster((d) => d.groups.push(grp("g8", "B", "More"))))).not.toBe(fp());
  });

  it("change when any involved entity's content changes", () => {
    const base = fp();
    const longer = conflictedOf(edited(addSession("x1", "B", null, 31), (d) => d.groups.push(grp("g9", "B", "New")), renameGroup("g3", "Paint")), edited(delClass("B")));
    expect(fp(longer)).not.toBe(base); // x1 lasted 31 s instead of 30
    const renamed = conflictedOf(edited(addSession("x1", "B"), (d) => d.groups.push(grp("g9", "B", "New")), renameGroup("g3", "Paint 2")), edited(delClass("B")));
    expect(fp(renamed)).not.toBe(base);
    const untouchedSessionMoved = conflictedOf(edited(addSession("x1", "B"), (d) => d.groups.push(grp("g9", "B", "New")), renameGroup("g3", "Paint"), move("s3", "B", "g3")), edited(delClass("B")));
    expect(fp(untouchedSessionMoved)).not.toBe(base); // one more conflicting change inside the deleted class
  });

  it("change when the keeping side's copy of a deleted class or subgroup changes, even if no new conflict appears", () => {
    // The class stays (tentatively) because it was edited on one side and deleted on the other: a session added to it is not a conflict of its own,
    // but "keep the class" would now bring that session back, so the decision must be asked again.
    const classCase = (...extra: Edit[]) => conflictedOf(edited(renameClass("B", "Drawing"), ...extra), edited(delClass("B")));
    const plain = classCase();
    const moreSessions = classCase(addSession("x1", "B"));
    expect(plain.conflicts).toHaveLength(1);
    expect(moreSessions.conflicts).toHaveLength(1);
    expect(fp(moreSessions)).not.toBe(fp(plain));
    expect(fp(classCase(addSession("x1", "B"), (d) => d.groups.push(grp("g9", "B", "New"))))).not.toBe(fp(moreSessions));

    const groupCase = (...extra: Edit[]) => conflictedOf(edited(renameGroup("g1", "First"), ...extra), edited(delGroup("g1")));
    const groupPlain = groupCase();
    const groupMore = groupCase(move("s2", "A", "g1"));
    expect(groupPlain.conflicts).toHaveLength(1);
    expect(groupMore.conflicts).toHaveLength(1);
    expect(fp(groupMore)).not.toBe(fp(groupPlain));
  });

  it("change when the base (or the other side) differs for the same conflict", () => {
    const withS5 = (d: SyncSnapshot) => d.sessions.push(ses("s5", "B", null, 5_000, 90));
    const base2 = edited(withS5);
    const r = conflictedOf(
      edited(withS5, addSession("x1", "B"), (d) => d.groups.push(grp("g9", "B", "New")), renameGroup("g3", "Paint")),
      edited(delClass("B")),
      base2,
    );
    expect(fp(r)).not.toBe(fp());
  });

  it("do NOT change for edits to unrelated entities", () => {
    const f = fp();
    const unrelatedLocal = conflictedOf(
      edited(addSession("x1", "B"), (d) => d.groups.push(grp("g9", "B", "New")), renameGroup("g3", "Paint"), addSession("y1", "A", "g2"), renameClass("A", "Maths")),
      edited(delClass("B"), renameGroup("g2", "Second")),
    );
    expect(fp(unrelatedLocal)).toBe(f);
  });

  it("differ between decision points, and for the same conflict decided from a different side", () => {
    const a = conflictedOf(edited(renameClass("A", "Maths")), edited(renameClass("A", "Calculus")));
    const b = conflictedOf(edited(renameClass("A", "Calculus")), edited(renameClass("A", "Maths")));
    expect(a.decisionPoints[0].fingerprint).not.toBe(b.decisionPoints[0].fingerprint); // local and remote values are swapped
    const c = conflictedOf(edited(renameClass("A", "Maths")), edited(renameClass("A", "Algebra")));
    expect(c.decisionPoints[0].fingerprint).not.toBe(a.decisionPoints[0].fingerprint);
  });

  it("buildDecisionPoints is deterministic and does not mutate its inputs", () => {
    const r = classCluster();
    const snaps = { base: deepFreeze(baseSnapshot()), local: deepFreeze(edited()), remote: deepFreeze(edited(delClass("B"))) };
    const conflicts = deepFreeze(clone(r.conflicts));
    expect(buildDecisionPoints(conflicts, snaps)).toEqual(buildDecisionPoints(conflicts, snaps));
  });
});

/** A merge with three decision points: a field conflict on A, a name collision, and a missing session. */
function scenario(remoteName = "Calculus") {
  const local = edited(renameClass("A", "Maths"), (d) => d.classes.push(cls("C1", "Bio")), (d) => (d.sessions = d.sessions.filter((s) => s.id !== "s2")));
  const remote = edited(renameClass("A", remoteName), (d) => d.classes.push(cls("C2", "bio")));
  const r = conflictedOf(local, remote);
  const by = (kind: string) => r.decisionPoints.find((p) => p.kind === kind)!;
  return { r, field: by("field"), collision: by("name_collision"), removal: by("session_removal") };
}

const pick = (p: DecisionPoint, choice: string, names?: Record<string, string>): Decision => (names ? { fingerprint: p.fingerprint, choice, names } : { fingerprint: p.fingerprint, choice });

describe("validateDecisions", () => {
  it("accepts valid decisions, in the order of the points, and rejects nothing", () => {
    const { r, field, collision } = scenario();
    expect(r.decisionPoints).toHaveLength(3);
    const out = validateDecisions(r.decisionPoints, [pick(collision, "rename", { C2: "Biology" }), pick(field, "keep_local")]);
    expect(out.rejected).toEqual([]);
    expect(out.accepted.map((a) => a.point)).toEqual(r.decisionPoints.filter((p) => p === field || p === collision));
    expect(out.accepted.find((a) => a.point === field)?.decision).toEqual({ fingerprint: field.fingerprint, choice: "keep_local" });
  });

  it("rejects a decision from a different situation as stale, never applying it", () => {
    const old = scenario();
    const changed = scenario("Algebra"); // the remote value in the field conflict changed
    const out = validateDecisions(changed.r.decisionPoints, [pick(old.field, "keep_local")]);
    expect(out.accepted).toEqual([]);
    expect(out.rejected).toEqual([{ decision: pick(old.field, "keep_local"), reason: "stale" }]);
  });

  it("rejects another fingerprint version without trying to read it", () => {
    const { r, field } = scenario();
    const future = { fingerprint: "sf2:" + field.fingerprint.slice(4), choice: "keep_local" };
    expect(validateDecisions(r.decisionPoints, [future]).rejected).toEqual([{ decision: future, reason: "unsupported_version" }]);
  });

  it("rejects malformed decisions without throwing", () => {
    const { r, field } = scenario();
    const f = field.fingerprint;
    const bad: unknown[] = [
      null, undefined, 5, "text", [], {}, () => 1, Symbol("s"),
      { fingerprint: f }, { choice: "keep_local" }, { fingerprint: 1, choice: "keep_local" }, { fingerprint: f, choice: 1 }, { fingerprint: f, choice: "" },
      { fingerprint: f, choice: "x".repeat(65) }, { fingerprint: f, choice: "keep_local", extra: true }, { fingerprint: "nope", choice: "keep_local" },
      { fingerprint: f.toUpperCase(), choice: "keep_local" }, { fingerprint: f, choice: "keep_local", names: [] }, { fingerprint: f, choice: "keep_local", names: {} },
      { fingerprint: f, choice: "keep_local", names: { A: 1 } }, { fingerprint: f, choice: "keep_local", names: null },
    ];
    const out = validateDecisions(r.decisionPoints, bad);
    expect(out.accepted).toEqual([]);
    expect(out.rejected.map((x) => x.reason)).toEqual(bad.map(() => "invalid_payload"));
    expect(out.rejected.map((x) => x.decision)).toEqual(bad);
  });

  it("collapses identical repeats and rejects both when one situation is decided two ways", () => {
    const { r, field } = scenario();
    const same = validateDecisions(r.decisionPoints, [pick(field, "keep_local"), pick(field, "keep_local")]);
    expect(same.accepted).toHaveLength(1);
    expect(same.rejected).toEqual([]);

    const a = pick(field, "keep_local");
    const b = pick(field, "keep_remote");
    const clash = validateDecisions(r.decisionPoints, [a, b, a]);
    expect(clash.accepted).toEqual([]);
    expect(clash.rejected).toEqual([
      { decision: a, reason: "duplicate_conflicting" }, { decision: b, reason: "duplicate_conflicting" }, { decision: a, reason: "duplicate_conflicting" },
    ]);
  });

  it("a stale repeated decision is stale, not a duplicate", () => {
    const old = scenario();
    const out = validateDecisions(scenario("Algebra").r.decisionPoints, [pick(old.field, "keep_local"), pick(old.field, "keep_remote")]);
    expect(out.rejected.map((x) => x.reason)).toEqual(["stale", "stale"]);
  });

  it("rejects a choice the point does not offer, and a choice marked unavailable", () => {
    const { r, field, removal, collision } = scenario();
    const out = validateDecisions(r.decisionPoints, [pick(field, "rename", { A: "X" }), pick(removal, "remove"), pick(collision, "keep_local")]);
    expect(out.accepted).toEqual([]);
    expect(out.rejected.map((x) => x.reason).sort()).toEqual(["choice_not_allowed", "choice_not_allowed", "choice_unavailable"]);
    expect(validateDecisions(r.decisionPoints, [pick(field, "nonsense")]).rejected.map((x) => x.reason)).toEqual(["choice_not_allowed"]);
    expect(validateDecisions(r.decisionPoints, [pick(removal, "restore")]).rejected.map((x) => x.reason)).toEqual(["choice_unavailable"]); // not applied yet, so not accepted
  });

  it("names are only allowed for rename", () => {
    const { r, field } = scenario();
    expect(validateDecisions(r.decisionPoints, [pick(field, "keep_local", { A: "X" })]).rejected.map((x) => x.reason)).toEqual(["invalid_payload"]);
  });

  describe("rename payloads", () => {
    const run = (names?: Record<string, string>) => {
      const { r, collision } = scenario();
      const out = validateDecisions(r.decisionPoints, [pick(collision, "rename", names)]);
      return out.accepted.length === 1 ? "accepted" : out.rejected[0].reason;
    };

    it("accepts one or both involved entities with valid new names", () => {
      expect(run({ C2: "Biology" })).toBe("accepted");
      expect(run({ C1: "Bio 1", C2: "Bio 2" })).toBe("accepted");
      expect(run({ C1: "x".repeat(60) })).toBe("accepted");
      expect(run({ C1: "  Padded  " })).toBe("accepted"); // trimmed before saving, see the next test
      expect(run({ C1: "Two   spaces" })).toBe("accepted"); // inner runs collapse, like every class and subgroup name
      expect(run({ C1: ` ${"x".repeat(60)} ` })).toBe("accepted"); // the length limit applies to the normalized name
      expect(run({ C1: "😀".repeat(60) })).toBe("accepted"); // 60 characters, counted as code points like PostgreSQL
    });

    it("needs names, and only for entities the point involves", () => {
      expect(run(undefined)).toBe("invalid_payload");
      expect(run({})).toBe("invalid_payload");
      expect(run({ A: "Elsewhere" })).toBe("invalid_payload");
      expect(run({ C1: "Fine", A: "Elsewhere" })).toBe("invalid_payload");
    });

    it("saves the normalized name, and leaves the caller's decision unchanged", () => {
      const { r, collision } = scenario();
      const raw = { fingerprint: collision.fingerprint, choice: "rename", names: { C1: "  Bio   One  " } };
      const out = validateDecisions(r.decisionPoints, [raw]);
      expect(out.accepted[0].decision.names).toEqual({ C1: "Bio One" });
      expect(out.accepted[0].raw).toBe(raw);
      expect(raw.names).toEqual({ C1: "  Bio   One  " });
    });

    it("rejects names that are empty, too long, unstorable, or equal to each other once normalized", () => {
      expect(run({ C1: "" })).toBe("invalid_payload");
      expect(run({ C1: "   " })).toBe("invalid_payload");
      expect(run({ C1: "x".repeat(61) })).toBe("invalid_payload");
      expect(run({ C1: "😀".repeat(61) })).toBe("invalid_payload");
      expect(run({ C1: "Same", C2: "  SAME  " })).toBe("invalid_payload");
      expect(run({ C1: "bad\u0000name" })).toBe("invalid_payload");
      expect(run({ C1: "lone\ud800" })).toBe("invalid_payload");
      expect(run({ C1: "Same", C2: "same" })).toBe("invalid_payload");
    });
  });

  it("neither mutates its inputs nor throws on frozen data", () => {
    const { r, field, collision } = scenario();
    const decisions = deepFreeze([pick(field, "keep_local"), pick(collision, "rename", { C1: "Bio 1" }), { junk: 1 }]);
    const points = deepFreeze(clone(r.decisionPoints));
    const out = validateDecisions(points, decisions);
    expect(out.accepted).toHaveLength(2);
    expect(out.rejected).toHaveLength(1);
  });
});
