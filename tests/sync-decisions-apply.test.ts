import { describe, expect, it } from "vitest";
import type { Decision, DecisionPoint } from "@/lib/sync/decisions";
import { fromSyncSnapshot } from "@/lib/sync/from-snapshot";
import { merge3, type MergeResult } from "@/lib/sync/merge";
import type { SyncSession, SyncSnapshot } from "@/lib/sync/snapshot";
import { addSession, baseSnapshot, conflictedOf, delClass, delGroup, edited, find, move, renameClass, renameGroup, type Edit } from "./helpers/merge-fixtures";
import { clone, deepFreeze, mergeAndPush, mergedTarget } from "./helpers/merge-harness";
import { cls, grp, snap } from "./helpers/sync-plan-harness";

/**
 * S5 Phase 2: decisions are validated against the current decision points and then APPLIED by merge3.
 * Base: classes A "Math", B "Art"; subgroups g1, g2 (in A), g3 (in B); sessions s1 (A, g1), s2 (A), s3 (B), s4 (B, g3).
 */

type Conflicted = Extract<MergeResult, { status: "conflicted" }>;
const pointsOf = (local: SyncSnapshot, remote: SyncSnapshot, base = baseSnapshot()) => conflictedOf(local, remote, base).decisionPoints;
const only = (points: DecisionPoint[], kind: DecisionPoint["kind"]) => {
  const found = points.filter((p) => p.kind === kind);
  if (found.length !== 1) throw new Error(`expected one ${kind} point, found ${found.length} of ${points.map((p) => p.kind).join(",")}`);
  return found[0];
};
const ofField = (r: Conflicted, field: string) => r.decisionPoints.find((p) => p.members.some((m) => r.conflicts[m].field === field))!;
const dec = (p: DecisionPoint, choice: string, names?: Record<string, string>): Decision => (names ? { fingerprint: p.fingerprint, choice, names } : { fingerprint: p.fingerprint, choice });
const run = (local: SyncSnapshot, remote: SyncSnapshot, decisions: unknown[], base = baseSnapshot()) => merge3(base, clone(local), clone(remote), { decisions });
/** The merged target, which must also be eligible. */
const target = (r: MergeResult) => {
  const t = mergedTarget(r);
  expect(fromSyncSnapshot(t).ok, "the final target must pass the eligibility rules").toBe(true);
  return t;
};
const conflictedResult = (r: MergeResult): Conflicted => {
  if (r.status !== "conflicted") throw new Error(`expected conflicts, got ${r.status}`);
  return r;
};
const reasons = (r: MergeResult) => (r.status === "refused" ? [] : r.rejectedDecisions.map((x) => x.reason));
const names = (t: SyncSnapshot) => Object.fromEntries(t.classes.map((c) => [c.id, c.name]));
const groupNames = (t: SyncSnapshot) => Object.fromEntries(t.groups.map((g) => [g.id, g.name]));
const applied = (r: MergeResult) => (r.status === "refused" ? [] : r.resolutions.filter((x) => x.code === "decision_applied").map((x) => `${x.entity}:${x.id}:${x.field ?? ""}:${x.choice}`));

describe("field conflicts", () => {
  const local = () => edited(renameClass("A", "Maths"));
  const remote = () => edited(renameClass("A", "Calculus"), addSession("x2", "B"));

  it("keep_local and keep_remote apply the chosen side's value, and everything else still merges automatically", async () => {
    const p = only(pointsOf(local(), remote()), "field");
    const mine = await mergeAndPush(baseSnapshot(), local(), remote(), { decisions: [dec(p, "keep_local")] });
    expect(mine.target.classes.find((c) => c.id === "A")).toEqual({ id: "A", name: "Maths", color: "#3b82f6" });
    expect(mine.target.sessions.some((s) => s.id === "x2")).toBe(true); // the unrelated remote change is still there
    expect(applied(mine.result)).toEqual(["class:A:name:keep_local"]);
    const theirs = await mergeAndPush(baseSnapshot(), local(), remote(), { decisions: [dec(p, "keep_remote")] });
    expect(theirs.target.classes.find((c) => c.id === "A")?.name).toBe("Calculus");
  });

  it("name and color are separate decisions: each takes its own side and nothing else is overwritten", () => {
    const l = edited(renameClass("A", "Maths"), (d) => (find.cls(d, "A").color = "#111111"));
    const r = edited(renameClass("A", "Calculus"), (d) => (find.cls(d, "A").color = "#222222"));
    const c = conflictedOf(l, r);
    expect(c.decisionPoints).toHaveLength(2);
    const both = target(run(l, r, [dec(ofField(c, "name"), "keep_local"), dec(ofField(c, "color"), "keep_remote")]));
    expect(both.classes.find((x) => x.id === "A")).toEqual({ id: "A", name: "Maths", color: "#222222" });
    expect(both.classes.find((x) => x.id === "B")).toEqual(find.cls(baseSnapshot(), "B"));
  });

  it("deciding only one of two leaves the other a conflict, and there is no target", () => {
    const l = edited(renameClass("A", "Maths"), (d) => (find.cls(d, "A").color = "#111111"));
    const r = edited(renameClass("A", "Calculus"), (d) => (find.cls(d, "A").color = "#222222"));
    const c = conflictedOf(l, r);
    const out = conflictedResult(run(l, r, [dec(ofField(c, "name"), "keep_local")]));
    expect(out.conflicts.map((x) => x.field)).toEqual(["color"]);
    expect(out.decisionPoints).toHaveLength(1);
    expect(out.rejectedDecisions).toEqual([]);
    expect("target" in out).toBe(false);
  });

  it("a subgroup's name and class are decided separately, each from one side", () => {
    const withC: Edit = (d) => d.classes.push(cls("C", "Bio"));
    const base = edited(withC);
    const l = edited(withC, renameGroup("g2", "Local"), (d) => (find.grp(d, "g2").classId = "B"));
    const r = edited(withC, renameGroup("g2", "Remote"), (d) => (find.grp(d, "g2").classId = "C"));
    const c = conflictedOf(l, r, base);
    expect(c.decisionPoints).toHaveLength(2);
    const t = target(run(l, r, [dec(ofField(c, "name"), "keep_remote"), dec(ofField(c, "classId"), "keep_local")], base));
    expect(find.grp(t, "g2")).toEqual({ id: "g2", classId: "B", name: "Remote" });
  });
});

describe("move conflicts", () => {
  const local = () => edited(move("s2", "A", "g2"));
  const remote = () => edited(move("s2", "B", null), addSession("x2", "A"));

  it("keep_local and keep_remote apply the chosen class AND subgroup together, keeping the session's id and immutable fields", async () => {
    const p = only(pointsOf(local(), remote()), "move");
    const mine = await mergeAndPush(baseSnapshot(), local(), remote(), { decisions: [dec(p, "keep_local")] });
    expect(find.ses(mine.target, "s2")).toEqual({ id: "s2", classId: "A", groupId: "g2", startedAt: 2_000, seconds: 120, mode: "stopwatch" });
    expect(mine.target.sessions.some((s) => s.id === "x2")).toBe(true);
    const theirs = await mergeAndPush(baseSnapshot(), local(), remote(), { decisions: [dec(p, "keep_remote")] });
    expect(find.ses(theirs.target, "s2")).toEqual({ id: "s2", classId: "B", groupId: null, startedAt: 2_000, seconds: 120, mode: "stopwatch" });
  });

  it("a session created on both sides in different places takes one side's whole record", () => {
    const l = edited(addSession("x1", "A", "g1"));
    const r = edited(addSession("x1", "B"));
    const p = only(pointsOf(l, r), "move");
    expect(find.ses(target(run(l, r, [dec(p, "keep_local")])), "x1")).toMatchObject({ classId: "A", groupId: "g1" });
    expect(find.ses(target(run(l, r, [dec(p, "keep_remote")])), "x1")).toMatchObject({ classId: "B", groupId: null });
  });

  it("a chosen placement whose subgroup was deleted is rejected as invalid_result, the conflict stays and nothing changes", () => {
    // local moved s2 into subgroup g2; the remote moved s2 elsewhere AND deleted g2
    const l = edited(move("s2", "A", "g2"));
    const r = edited(delGroup("g2"), move("s2", "B", null));
    const c = conflictedOf(l, r);
    const p = only(c.decisionPoints, "move");
    const rejected = conflictedResult(run(l, r, [dec(p, "keep_local")]));
    expect(rejected.rejectedDecisions).toEqual([{ decision: dec(p, "keep_local"), reason: "invalid_result" }]);
    expect(rejected.conflicts).toEqual(c.conflicts); // exactly the undecided conflicts
    expect(rejected.decisionPoints).toEqual(c.decisionPoints);
    expect("target" in rejected).toBe(false);
    // the other choice is valid and works
    expect(find.ses(target(run(l, r, [dec(p, "keep_remote")])), "s2")).toMatchObject({ classId: "B", groupId: null });
  });
});

describe("add mismatches", () => {
  it("a class created twice takes ONE side's complete record, never a mix", () => {
    const l = edited((d) => d.classes.push(cls("N", "One", "#111111")));
    const r = edited((d) => d.classes.push(cls("N", "Two", "#222222")));
    const p = only(pointsOf(l, r), "add_mismatch");
    expect(find.cls(target(run(l, r, [dec(p, "keep_local")])), "N")).toEqual({ id: "N", name: "One", color: "#111111" });
    expect(find.cls(target(run(l, r, [dec(p, "keep_remote")])), "N")).toEqual({ id: "N", name: "Two", color: "#222222" });
  });

  it("a subgroup created twice takes one side's whole record, including its class", async () => {
    const l = edited((d) => d.groups.push(grp("n", "A", "One")));
    const r = edited((d) => d.groups.push(grp("n", "B", "Two")));
    const p = only(pointsOf(l, r), "add_mismatch");
    expect(find.grp(target(run(l, r, [dec(p, "keep_local")])), "n")).toEqual({ id: "n", classId: "A", name: "One" });
    const theirs = await mergeAndPush(baseSnapshot(), l, r, { decisions: [dec(p, "keep_remote")] });
    expect(find.grp(theirs.target, "n")).toEqual({ id: "n", classId: "B", name: "Two" });
  });

  it("a choice that would attach the subgroup to a deleted class is rejected as invalid_result", () => {
    const l = edited((d) => d.groups.push(grp("n", "B", "One")));
    const r = edited(delClass("B"), (d) => d.groups.push(grp("n", "A", "Two")));
    const c = conflictedOf(l, r);
    const p = only(c.decisionPoints, "add_mismatch");
    const bad = conflictedResult(run(l, r, [dec(p, "keep_local")]));
    expect(bad.rejectedDecisions.map((x) => x.reason)).toEqual(["invalid_result"]);
    expect(bad.conflicts).toEqual(c.conflicts);
    expect(find.grp(target(run(l, r, [dec(p, "keep_remote")])), "n")).toEqual({ id: "n", classId: "A", name: "Two" });
  });
});

describe("rename decisions: the final namespace is checked", () => {
  // classes C1 "Bio" (local) and C2 "bio" (remote) collide
  const local = () => edited((d) => d.classes.push(cls("C1", "Bio")));
  const remote = () => edited((d) => d.classes.push(cls("C2", "bio")));
  const collision = () => only(pointsOf(local(), remote()), "name_collision");
  const rename = (map: Record<string, string>) => run(local(), remote(), [dec(collision(), "rename", map)]);
  const undecided = () => conflictedOf(local(), remote());

  /** The rename was refused: reported, the collision conflict is back unchanged, nothing was applied, no target. */
  const refusedRename = (r: MergeResult, reason: string) => {
    const out = conflictedResult(r);
    expect(out.rejectedDecisions.map((x) => x.reason)).toEqual([reason]);
    expect(out.conflicts).toEqual(undecided().conflicts);
    expect(out.decisionPoints).toEqual(undecided().decisionPoints);
    expect(applied(out)).toEqual([]);
    expect("target" in out).toBe(false);
  };

  it("renaming one of two colliding classes resolves the collision and the merged data is pushable", async () => {
    const { target: t, result } = await mergeAndPush(baseSnapshot(), local(), remote(), { decisions: [dec(collision(), "rename", { C2: "Biology" })] });
    expect(names(t)).toEqual({ A: "Math", B: "Art", C1: "Bio", C2: "Biology" });
    expect(applied(result)).toEqual(["class:C2:name:rename"]);
  });

  it("a class rename that collides with another existing class is rejected, not adjusted", () => {
    refusedRename(rename({ C2: "Math" }), "name_collision"); // A, which is not part of the original conflict
    refusedRename(rename({ C2: "Art" }), "name_collision"); // B
  });

  it("collision checking ignores capitalization (and uses the same rules as the rest of the project)", () => {
    refusedRename(rename({ C2: "MATH" }), "name_collision");
    refusedRename(rename({ C2: "aRt" }), "name_collision");
    refusedRename(rename({ C2: "BIO" }), "name_collision"); // still equal to C1
  });

  it("leading and trailing whitespace is trimmed before saving, and the trimmed name is what is checked", () => {
    expect(names(target(rename({ C2: "   Biology  " }))).C2).toBe("Biology");
    expect(names(target(rename({ C2: "Bio   logy" }))).C2).toBe("Bio logy"); // inner runs collapse like every other name
    refusedRename(rename({ C2: "  Math  " }), "name_collision"); // trimming does not hide a collision
  });

  it("whitespace-only, empty, over-long and unknown-entity payloads are rejected as invalid_payload", () => {
    const payloads: Record<string, string>[] = [{ C2: "   " }, { C2: "" }, { C2: "x".repeat(61) }, { A: "Elsewhere" }, { C2: "bad\u0000name" }];
    for (const bad of payloads) {
      refusedRename(rename(bad), "invalid_payload");
    }
    refusedRename(run(local(), remote(), [{ fingerprint: collision().fingerprint, choice: "rename" }]), "invalid_payload");
  });

  it("an entity may keep its own name when the others it collided with change; renaming it to its own name alone does not help", () => {
    const keepOwn = target(rename({ C1: "Bio", C2: "Biology" }));
    expect(names(keepOwn)).toMatchObject({ C1: "Bio", C2: "Biology" });
    refusedRename(rename({ C1: "Bio" }), "name_collision"); // C2 still has the same name
  });

  it("the namespace checked is the FINAL one: a name freed by another decision is available, a name taken by it is not", () => {
    // A is renamed differently on both sides ("Maths" / "Calculus"): once that is decided, "Math" is free.
    const l = edited(renameClass("A", "Maths"), (d) => d.classes.push(cls("C1", "Bio")));
    const r = edited(renameClass("A", "Calculus"), (d) => d.classes.push(cls("C2", "bio")));
    const ps = pointsOf(l, r);
    const field = only(ps, "field");
    const collisionPoint = only(ps, "name_collision");
    const freed = target(run(l, r, [dec(field, "keep_local"), dec(collisionPoint, "rename", { C2: "Math" })]));
    expect(names(freed)).toMatchObject({ A: "Maths", C2: "Math" });
    const taken = conflictedResult(run(l, r, [dec(field, "keep_remote"), dec(collisionPoint, "rename", { C2: "Calculus" })]));
    expect(taken.rejectedDecisions.map((x) => x.reason)).toEqual(["name_collision"]);
    expect(applied(taken)).toEqual(["class:A:name:keep_remote"]); // the valid decision is still applied; only the colliding rename is refused
  });

  it("the whole decision is rejected if any one of its names collides", () => {
    refusedRename(rename({ C1: "Physics", C2: "Math" }), "name_collision");
  });

  it("two rename decisions that collide with each other are both rejected", () => {
    const l = edited((d) => d.classes.push(cls("C1", "Bio"), cls("D1", "Chem")));
    const r = edited((d) => d.classes.push(cls("C2", "bio"), cls("D2", "chem")));
    const points = pointsOf(l, r).filter((p) => p.kind === "name_collision");
    expect(points).toHaveLength(2);
    const [pc, pd] = points;
    const idsOf = (p: DecisionPoint) => p.ids;
    const clash = run(l, r, [dec(pc, "rename", { [idsOf(pc)[1]]: "Science" }), dec(pd, "rename", { [idsOf(pd)[1]]: "science" })]);
    const out = conflictedResult(clash);
    expect(out.rejectedDecisions.map((x) => x.reason)).toEqual(["name_collision", "name_collision"]);
    expect(out.decisionPoints).toHaveLength(2); // both collisions are still open
    // different names: both apply
    const fine = target(run(l, r, [dec(pc, "rename", { [idsOf(pc)[1]]: "Science" }), dec(pd, "rename", { [idsOf(pd)[1]]: "Physics" })]));
    expect(Object.values(names(fine)).sort()).toEqual(["Art", "Bio", "Chem", "Math", "Physics", "Science"]);
  });

  it("a rename that collides with an entity another decision introduces is rejected; with a different outcome of that decision it is accepted", () => {
    const l = edited((d) => d.classes.push(cls("C1", "Bio"), cls("N", "Zed", "#111111")));
    const r = edited((d) => d.classes.push(cls("C2", "bio"), cls("N", "Biology", "#222222")));
    const points = pointsOf(l, r);
    const pc = only(points, "name_collision");
    const pn = only(points, "add_mismatch");
    const withRemoteN = conflictedResult(run(l, r, [dec(pc, "rename", { C2: "Biology" }), dec(pn, "keep_remote")]));
    expect(withRemoteN.rejectedDecisions.map((x) => x.reason)).toEqual(["name_collision"]);
    expect(withRemoteN.decisionPoints.map((p) => p.kind)).toEqual(["name_collision"]); // the add decision was applied, the collision is open
    expect(applied(withRemoteN)).toEqual(["class:N::keep_remote"]);
    const withLocalN = target(run(l, r, [dec(pc, "rename", { C2: "Biology" }), dec(pn, "keep_local")]));
    expect(names(withLocalN)).toMatchObject({ N: "Zed", C1: "Bio", C2: "Biology" });
  });

  describe("subgroups: unique within the (final) parent class", () => {
    it("a subgroup rename that collides within the same class is rejected; the same name under another class is allowed", () => {
      const l = edited((d) => d.groups.push(grp("n1", "A", "Unit 3")));
      const r = edited((d) => d.groups.push(grp("n2", "A", "unit 3")));
      const p = only(pointsOf(l, r), "name_collision");
      expect(p.entity).toBe("group");
      expect(p.ids).toEqual(["n1", "n2"]);
      const bad = conflictedResult(run(l, r, [dec(p, "rename", { n2: "UNIT 1" })])); // g1 is "Unit 1" in the same class A
      expect(bad.rejectedDecisions.map((x) => x.reason)).toEqual(["name_collision"]);
      const fine = target(run(l, r, [dec(p, "rename", { n2: "Sketch" })])); // "Sketch" is g3's name, but g3 lives in class B
      expect(groupNames(fine)).toMatchObject({ n1: "Unit 3", n2: "Sketch", g3: "Sketch" });
    });

    it("uses the subgroup's final parent class after its parent changed", () => {
      // g2 moves from A to B on one side only (merged automatically); the other side adds "unit 2" to B
      const l = edited((d) => (find.grp(d, "g2").classId = "B"));
      const r = edited((d) => d.groups.push(grp("n9", "B", "unit 2")));
      const p = only(pointsOf(l, r), "name_collision");
      expect(p.ids).toEqual(["g2", "n9"]);
      // "Unit 1" is taken in class A (by g1) but g2 now belongs to B, so it is free there
      expect(groupNames(target(run(l, r, [dec(p, "rename", { g2: "Unit 1" })]))).g2).toBe("Unit 1");
      // "Sketch" is taken in B (by g3), which is where g2 is now
      const bad = conflictedResult(run(l, r, [dec(p, "rename", { g2: "Sketch" })]));
      expect(bad.rejectedDecisions.map((x) => x.reason)).toEqual(["name_collision"]);
      // and renaming the other one to g2's name is a collision too
      expect(conflictedResult(run(l, r, [dec(p, "rename", { n9: "UNIT 2" })])).rejectedDecisions.map((x) => x.reason)).toEqual(["name_collision"]);
    });
  });
});

describe("rename decisions are judged in rounds: a rejected decision never takes another down with it", () => {
  /** Colliding class pairs: `${key}1` (local) and `${key}2` (remote) end up with the same name (different capitalization). */
  const pairs = (...list: [key: string, name: string][]) => ({
    l: edited((d) => d.classes.push(...list.map(([k, n]) => cls(`${k}1`, n)))),
    r: edited((d) => d.classes.push(...list.map(([k, n]) => cls(`${k}2`, n.toLowerCase())))),
  });
  const pointFor = (ps: DecisionPoint[], id: string) => ps.find((p) => p.kind === "name_collision" && p.ids.includes(id))!;
  const permutations = <T,>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest])));
  const byJson = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b));
  /** Rejections are a set: compare them sorted. */
  const normal = (r: MergeResult) => (r.status === "refused" ? r : { ...r, rejectedDecisions: [...r.rejectedDecisions].sort(byJson) });
  /** Runs every ordering of the decisions; all must give the same result. Returns the first. */
  const inEveryOrder = (l: SyncSnapshot, r: SyncSnapshot, decisions: Decision[]) => {
    const first = run(l, r, decisions);
    for (const order of permutations(decisions)) expect(normal(run(l, r, order))).toEqual(normal(first));
    return first;
  };
  const rejected = (r: MergeResult) => (r.status === "refused" ? [] : r.rejectedDecisions.map((x) => ({ names: (x.decision as Decision).names, reason: x.reason })));

  it("C1/C2/D2: A is rejected because C1's name is taken; B, whose only clash was with C2's proposal, is accepted", () => {
    // C1 "Bio" / C2 "bio" collide, D1 "Chem" / D2 "chem" collide, and class A is "Math"
    const { l, r } = pairs(["C", "Bio"], ["D", "Chem"]);
    const ps = pointsOf(l, r);
    const a = dec(pointFor(ps, "C1"), "rename", { C1: "Math", C2: "Biology" });
    const b = dec(pointFor(ps, "D1"), "rename", { D2: "Biology" });
    const out = conflictedResult(inEveryOrder(l, r, [a, b])); // C1/C2 are still open, so no target yet
    expect(rejected(out)).toEqual([{ names: { C1: "Math", C2: "Biology" }, reason: "name_collision" }]);
    expect(applied(out)).toEqual(["class:D2:name:rename"]);
    expect(out.conflicts.map((c) => [c.code, c.id, ...(c.relatedIds ?? [])])).toEqual([["name_collision", "C1", "C2"]]); // untouched
    // the user then redoes A with a free name: everything merges, nothing was adjusted
    const redo = dec(pointFor(ps, "C1"), "rename", { C2: "Zoology" });
    const t = target(inEveryOrder(l, r, [redo, b]));
    expect(names(t)).toEqual({ A: "Math", B: "Art", C1: "Bio", C2: "Zoology", D1: "Chem", D2: "Biology" });
  });

  it("two otherwise-valid decisions that collide with each other are both rejected, in any order, and nothing is renamed", () => {
    const { l, r } = pairs(["C", "Bio"], ["D", "Chem"]);
    const ps = pointsOf(l, r);
    const a = dec(pointFor(ps, "C1"), "rename", { C2: "Science" });
    const b = dec(pointFor(ps, "D1"), "rename", { D2: "SCIENCE" });
    const out = conflictedResult(inEveryOrder(l, r, [a, b]));
    expect(rejected(out).map((x) => x.reason)).toEqual(["name_collision", "name_collision"]);
    expect(applied(out)).toEqual([]);
    expect(out.decisionPoints.map((p) => p.kind)).toEqual(["name_collision", "name_collision"]);
    expect(out.conflicts).toEqual(conflictedOf(l, r).conflicts);
  });

  it("a chain: a decision that only collides with a rejected one is accepted, and a mutual clash discovered later rejects both", () => {
    const { l, r } = pairs(["E", "Eco"], ["F", "Fin"], ["G", "Geo"], ["H", "Hum"]);
    const ps = pointsOf(l, r);
    // X: "Alpha" is free, but "Math" is class A's, so the WHOLE decision is rejected (E1 keeps its name)
    const x = dec(pointFor(ps, "E1"), "rename", { E1: "Alpha", E2: "Math" });
    // W: collides only with the "Alpha" that X proposed, so it is fine once X is rejected
    const w = dec(pointFor(ps, "F1"), "rename", { F2: "alpha" });
    // Y and Z: free names, but they collide with each other
    const y = dec(pointFor(ps, "G1"), "rename", { G2: "Beta" });
    const z = dec(pointFor(ps, "H1"), "rename", { H2: "beta" });
    const out = conflictedResult(inEveryOrder(l, r, [x, w, y, z]));
    expect(rejected(out).map((e) => e.names).sort(byJson)).toEqual([{ E1: "Alpha", E2: "Math" }, { G2: "Beta" }, { H2: "beta" }].sort(byJson));
    expect(applied(out)).toEqual(["class:F2:name:rename"]);
    // with the rejected ones replaced by valid choices everything merges
    const fixed = [dec(pointFor(ps, "E1"), "rename", { E1: "Alpha2", E2: "Math2" }), w, y, dec(pointFor(ps, "H1"), "rename", { H2: "Gamma" })];
    const t = target(inEveryOrder(l, r, fixed));
    expect(names(t)).toMatchObject({ E1: "Alpha2", E2: "Math2", F1: "Fin", F2: "alpha", G2: "Beta", H2: "Gamma" });
  });

  it("a name taken only by a rejected decision's proposal becomes available (subgroups of one class)", () => {
    const l = edited((d) => d.groups.push(grp("n1", "A", "Review"), grp("m1", "A", "Lab")));
    const r = edited((d) => d.groups.push(grp("n2", "A", "review"), grp("m2", "A", "lab")));
    const ps = pointsOf(l, r);
    const pn = ps.find((p) => p.kind === "name_collision" && p.ids.includes("n1"))!;
    const pm = ps.find((p) => p.kind === "name_collision" && p.ids.includes("m1"))!;
    // X would give n1 the name "Notes" but n2 "Unit 1", which g1 already has: rejected whole. Y wants "Notes" for m2.
    const x = dec(pn, "rename", { n1: "Notes", n2: "Unit 1" });
    const y = dec(pm, "rename", { m2: "notes" });
    const out = conflictedResult(inEveryOrder(l, r, [x, y]));
    expect(rejected(out)).toEqual([{ names: { n1: "Notes", n2: "Unit 1" }, reason: "name_collision" }]);
    expect(applied(out)).toEqual(["group:m2:name:rename"]);
    const t = target(inEveryOrder(l, r, [dec(pn, "rename", { n2: "Other" }), y]));
    expect(groupNames(t)).toMatchObject({ n1: "Review", n2: "Other", m1: "Lab", m2: "notes" });
  });

  it("a multi-name decision is atomic: one invalid name rejects all of it, and its other valid name stays free", () => {
    const { l, r } = pairs(["C", "Bio"], ["D", "Chem"]);
    const ps = pointsOf(l, r);
    const bad = dec(pointFor(ps, "C1"), "rename", { C1: "Fresh", C2: "Art" }); // "Fresh" is fine, "Art" is class B's
    const other = dec(pointFor(ps, "D1"), "rename", { D2: "fresh" });
    const out = conflictedResult(inEveryOrder(l, r, [bad, other]));
    expect(rejected(out)).toEqual([{ names: { C1: "Fresh", C2: "Art" }, reason: "name_collision" }]);
    expect(applied(out)).toEqual(["class:D2:name:rename"]); // C1 was NOT renamed to "Fresh"
    expect(out.conflicts.map((c) => [c.code, c.id])).toEqual([["name_collision", "C1"]]);
    // an invalid payload inside a multi-name decision rejects it as a whole too
    const junk = conflictedResult(run(l, r, [dec(pointFor(ps, "C1"), "rename", { C1: "Fresh", C2: "   " })]));
    expect(rejected(junk).map((e) => e.reason)).toEqual(["invalid_payload"]);
    expect(applied(junk)).toEqual([]);
  });

  it("a decision whose own names collide with each other is rejected", () => {
    const { l, r } = pairs(["C", "Bio"]);
    const ps = pointsOf(l, r);
    const out = conflictedResult(run(l, r, [dec(pointFor(ps, "C1"), "rename", { C1: "Same", C2: "SAME" })]));
    expect(rejected(out)).toHaveLength(1);
    expect(applied(out)).toEqual([]);
  });

  describe("one entity named by two pending rename decisions", () => {
    // The app's name key (toLocaleLowerCase) and the simple key (one lowercase character per character) disagree for "\u0130":
    // it lowercases to two characters under the first and to "i" under the second. Three subgroups end up in class A as
    // gx "\u0130", gy "i", gz "I" (every side is valid on its own: no side has two of them in one class):
    //   local:  gx renamed and moved to A, gz renamed "I" (stays in B)
    //   remote: gy renamed "i" and moved to A, gz moved to A
    // gy and gz clash under the app's rule (and the simple one), gx clashes with gz under the simple rule only. The merge
    // groups by one rule at a time and leaves an entity that already has a conflict out of the next grouping, so it reports
    // TWO collision points, {gy, gz} and {gx, gz}, and gz belongs to both.
    const base = () => edited((d) => d.groups.push(grp("gx", "B", "x0"), grp("gy", "B", "y0"), grp("gz", "B", "z0")));
    const local = () => {
      const d = base();
      find.grp(d, "gx").name = "\u0130";
      find.grp(d, "gx").classId = "A";
      find.grp(d, "gz").name = "I";
      return d;
    };
    const remote = () => {
      const d = base();
      find.grp(d, "gy").name = "i";
      find.grp(d, "gy").classId = "A";
      find.grp(d, "gz").classId = "A";
      return d;
    };
    const points = () => {
      const ps = pointsOf(local(), remote(), base()).filter((p) => p.kind === "name_collision");
      expect(ps.map((p) => p.ids)).toEqual([["gx", "gz"], ["gy", "gz"]]); // sorted by entity, id, kind, fingerprint
      return ps;
    };
    const go = (decisions: Decision[]) => {
      const first = run(local(), remote(), decisions, base());
      for (const order of permutations(decisions)) expect(normal(run(local(), remote(), order, base()))).toEqual(normal(first));
      return first;
    };

    it("two different names for one entity are ambiguous: both decisions are rejected, none is picked, nothing is renamed", () => {
      const [xz, yz] = points();
      const a = dec(xz, "rename", { gz: "One" });
      const b = dec(yz, "rename", { gy: "Two", gz: "Three" });
      const out = conflictedResult(go([a, b]));
      // both decisions are well formed, so validation accepts them and they reach the evaluator; it is the evaluator that rejects
      expect(rejected(out).map((x) => x.reason)).toEqual(["name_collision", "name_collision"]);
      expect(rejected(out).map((x) => x.names).sort(byJson)).toEqual([{ gz: "One" }, { gy: "Two", gz: "Three" }].sort(byJson));
      expect(applied(out)).toEqual([]);
      expect(out.conflicts).toEqual(conflictedOf(local(), remote(), base()).conflicts); // the collisions are all still open
      expect("target" in out).toBe(false);
    });

    it("the same name for the same entity in both decisions is not ambiguous and both apply", () => {
      const [xz, yz] = points();
      const t = target(go([dec(xz, "rename", { gz: "One" }), dec(yz, "rename", { gy: "Two", gz: "One" })]));
      expect(groupNames(t)).toMatchObject({ gx: "\u0130", gy: "Two", gz: "One" });
    });
  });

  it("the result does not depend on key order inside a payload", () => {
    const { l, r } = pairs(["C", "Bio"], ["D", "Chem"]);
    const ps = pointsOf(l, r);
    const a = (n: Record<string, string>) => dec(pointFor(ps, "C1"), "rename", n);
    const b = dec(pointFor(ps, "D1"), "rename", { D2: "Biology" });
    const one = run(l, r, [a({ C1: "Math", C2: "Biology" }), b]);
    const two = run(l, r, [b, a({ C2: "Biology", C1: "Math" })]);
    expect(normal(two)).toEqual(normal(one));
  });
});

/**
 * Every session of the target is exactly its original (from the first snapshot that has it) plus the listed changes, and no
 * session was added, dropped or duplicated: ungrouping changes only the intended subgroup association.
 */
const expectOnly = (t: SyncSnapshot, originals: SyncSnapshot[], changes: Record<string, Partial<SyncSession>>) => {
  const original = new Map<string, SyncSession>();
  for (const snapshot of originals) for (const s of snapshot.sessions) if (!original.has(s.id)) original.set(s.id, s);
  expect(t.sessions.map((s) => s.id).sort()).toEqual([...original.keys()].sort());
  for (const s of t.sessions) expect(s, `session ${s.id}`).toEqual({ ...original.get(s.id)!, ...(changes[s.id] ?? {}) });
};

describe("ungroup (a deleted subgroup stays deleted, its sessions are kept)", () => {
  it("sessions added or moved into the deleted subgroup keep their class, lose the subgroup, and every session is preserved", async () => {
    const l = edited(addSession("x1", "A", "g1"), move("s2", "A", "g1"));
    const r = edited(delGroup("g1"));
    const c = conflictedOf(l, r);
    const p = only(c.decisionPoints, "group_deleted");
    const { target: t, result } = await mergeAndPush(baseSnapshot(), l, r, { decisions: [dec(p, "ungroup")] });
    expect(t.groups.map((g) => g.id)).toEqual(["g2", "g3"]); // g1 is gone, nothing else was deleted
    for (const id of ["s1", "s2", "x1"]) expect(find.ses(t, id), id).toMatchObject({ classId: "A", groupId: null });
    expect(find.ses(t, "s2")).toMatchObject({ startedAt: 2_000, seconds: 120, mode: "stopwatch" });
    expect(t.sessions.map((s) => s.id).sort()).toEqual(["s1", "s2", "s3", "s4", "x1"]);
    // existing session of the deleted subgroup (s1), moved in (s2), added (x1): only the subgroup is gone; s3 and s4 are untouched
    expectOnly(t, [baseSnapshot(), l, r], { s1: { groupId: null }, s2: { groupId: null }, x1: { groupId: null } });
    expect(result.status === "merged" && result.warnings).toEqual([expect.objectContaining({ code: "group_deleted_sessions_ungrouped", id: "g1", ids: ["s1", "s2", "x1"], count: 3 })]);
    expect(applied(result)).toEqual([]); // sessions are reported through the warning; no field decision was applied
  });

  it("the same on the other side, with a session moved in from another class: class of the move kept, every immutable field intact", () => {
    const l = edited(delGroup("g1"));
    const r = edited(addSession("x1", "A", "g1"), move("s2", "A", "g1"), move("s3", "A", "g1"), addSession("x2", "B", "g3", 45));
    const p = only(pointsOf(l, r), "group_deleted");
    const t = target(run(l, r, [dec(p, "ungroup")]));
    // s3 was moved from B into A's subgroup: it stays in A (its move is kept), without the subgroup. x2 is unrelated.
    expectOnly(t, [baseSnapshot(), l, r], { s1: { groupId: null }, s2: { groupId: null }, s3: { classId: "A", groupId: null }, x1: { groupId: null } });
    expect(find.ses(t, "x2")).toEqual(find.ses(r, "x2"));
    expect(t.groups.map((g) => g.id)).toEqual(["g2", "g3"]);
    expect(t.classes).toEqual(baseSnapshot().classes);
  });

  it("a subgroup deleted on one side and edited on the other: the deletion wins and its sessions are ungrouped", () => {
    for (const [l, r] of [[edited(renameGroup("g1", "First")), edited(delGroup("g1"))], [edited(delGroup("g1")), edited(renameGroup("g1", "First"))]]) {
      const p = only(pointsOf(l, r), "group_deleted");
      const t = target(run(l, r, [dec(p, "ungroup")]));
      expect(t.groups.map((g) => g.id)).toEqual(["g2", "g3"]);
      expect(find.ses(t, "s1")).toMatchObject({ classId: "A", groupId: null });
      expect(t.classes).toHaveLength(2);
      expectOnly(t, [baseSnapshot(), l, r], { s1: { groupId: null } });
    }
  });

  it("is checked against a running timer: protected subgroups still conflict", () => {
    const l = edited(addSession("x1", "A", "g1"));
    const r = edited(delGroup("g1"));
    const p = only(pointsOf(l, r), "group_deleted");
    const out = conflictedResult(merge3(baseSnapshot(), l, r, { decisions: [dec(p, "ungroup")], protect: { groupIds: ["g1"] } }));
    expect(out.conflicts.map((x) => x.code)).toEqual(["protected_entity_deleted"]);
  });
});

describe("ungroup_session", () => {
  const local = () => edited((d) => (find.grp(d, "g2").classId = "B"));
  const remote = () => edited(move("s2", "A", "g2"));

  it("keeps the session's class, drops its subgroup, and the group stays where it moved", async () => {
    const c = conflictedOf(local(), remote());
    const p = only(c.decisionPoints, "group_class_mismatch");
    const { target: t } = await mergeAndPush(baseSnapshot(), local(), remote(), { decisions: [dec(p, "ungroup_session")] });
    expect(find.ses(t, "s2")).toEqual({ id: "s2", classId: "A", groupId: null, startedAt: 2_000, seconds: 120, mode: "stopwatch" });
    expect(find.grp(t, "g2").classId).toBe("B");
    expectOnly(t, [baseSnapshot(), local(), remote()], { s2: { groupId: null } });
  });

  it("with several affected sessions each needs its own decision; all of them keep identity and immutable fields, others are untouched", () => {
    // g2 moves to class B locally; remotely s2 is moved into g2 (class A) and x1 and x2 are added to it, x3 stays outside
    const l = local();
    const r = edited(move("s2", "A", "g2"), addSession("x1", "A", "g2", 31), addSession("x2", "A", "g2", 32), addSession("x3", "A", null, 33));
    const mismatches = conflictedOf(l, r).decisionPoints.filter((p) => p.kind === "group_class_mismatch");
    expect(mismatches.map((p) => p.id).sort()).toEqual(["s2", "x1", "x2"]);
    // deciding only two leaves the third a conflict
    const partial = conflictedResult(run(l, r, mismatches.slice(0, 2).map((p) => dec(p, "ungroup_session"))));
    expect(partial.decisionPoints).toHaveLength(1);
    const t = target(run(l, r, mismatches.map((p) => dec(p, "ungroup_session"))));
    expectOnly(t, [baseSnapshot(), l, r], { s2: { groupId: null }, x1: { groupId: null }, x2: { groupId: null } });
    expect(find.ses(t, "x1")).toEqual({ ...find.ses(r, "x1"), groupId: null });
    expect(find.grp(t, "g2")).toEqual({ id: "g2", classId: "B", name: "Unit 2" });
    expect(t.groups).toHaveLength(3);
  });

  it("is offered only for that conflict: any other point rejects it as choice_not_allowed", () => {
    const l = edited(renameClass("A", "Maths"));
    const r = edited(renameClass("A", "Calculus"));
    const p = only(pointsOf(l, r), "field");
    const out = conflictedResult(run(l, r, [dec(p, "ungroup_session")]));
    expect(out.rejectedDecisions.map((x) => x.reason)).toEqual(["choice_not_allowed"]);
  });
});

describe("decisions whose result breaks a rule of the final data", () => {
  it("a valid field decision that makes a class name collide is applied, and the merge reports name_collision with no target", () => {
    // A is renamed "Maths" locally and "Zed" remotely; locally B was renamed "Zed" (valid on each side alone)
    const l = edited(renameClass("A", "Maths"), renameClass("B", "Zed"));
    const r = edited(renameClass("A", "Zed"));
    const p = only(pointsOf(l, r), "field");
    const remoteWins = conflictedResult(run(l, r, [dec(p, "keep_remote")]));
    expect(remoteWins.rejectedDecisions).toEqual([]); // the decision itself was valid and applied
    expect(applied(remoteWins)).toEqual(["class:A:name:keep_remote"]);
    expect(remoteWins.conflicts.map((c) => [c.code, c.entity, c.id, c.relatedIds])).toEqual([["name_collision", "class", "A", ["B"]]]);
    expect("target" in remoteWins).toBe(false);
    // the other direction: local's name is the colliding one
    const l2 = edited(renameClass("A", "ZED"));
    const r2 = edited(renameClass("A", "Calculus"), renameClass("B", "Zed"));
    const p2 = only(pointsOf(l2, r2), "field");
    const localWins = conflictedResult(run(l2, r2, [dec(p2, "keep_local")]));
    expect(localWins.rejectedDecisions).toEqual([]);
    expect(localWins.conflicts.map((c) => [c.code, c.id, c.relatedIds])).toEqual([["name_collision", "A", ["B"]]]);
    expect("target" in localWins).toBe(false);
    // the non-colliding choice still merges, so the failed attempt renamed and dropped nothing
    expect(names(target(run(l, r, [dec(p, "keep_local")])))).toEqual({ A: "Maths", B: "Zed" });
    // inputs are untouched by the attempt
    const inputs = [baseSnapshot(), clone(l), clone(r)].map(deepFreeze);
    const decisions = deepFreeze([dec(p, "keep_remote")]);
    expect(merge3(inputs[0], inputs[1], inputs[2], { decisions }).status).toBe("conflicted");
    expect(inputs[1]).toEqual(l);
    expect(inputs[2]).toEqual(r);
    expect(decisions).toEqual([dec(p, "keep_remote")]);
  });

  it("decisions that are individually valid but push the merged data over a server cap are refused as caps_exceeded", () => {
    const base = baseSnapshot();
    for (let i = 0; i < 996; i++) base.classes.push(cls(`k${i}`, `Filler ${i}`)); // A, B and 996 more: 998, under the cap of 1,000
    const l = clone(base);
    find.cls(l, "A").name = "Maths";
    l.classes.push(cls("L1", "Local new")); // 999
    const r = clone(base);
    find.cls(r, "A").name = "Calculus";
    r.classes.push(cls("R1", "Remote new 1"), cls("R2", "Remote new 2")); // 1,000
    const p = only(pointsOf(l, r, base), "field");
    const frozenIn = [deepFreeze(clone(base)), deepFreeze(clone(l)), deepFreeze(clone(r))];
    const decisions = deepFreeze([dec(p, "keep_local")]);
    const out = merge3(frozenIn[0], frozenIn[1], frozenIn[2], { decisions }); // 998 + 1 + 2 = 1,001
    expect(out.status).toBe("refused");
    if (out.status !== "refused") return;
    expect(out.error.code).toBe("caps_exceeded"); // exactly, not target_ineligible
    expect(out.error.issues?.some((i) => i.code === "too_many_classes")).toBe(true);
    expect("target" in out).toBe(false);
    expect(frozenIn[0]).toEqual(base);
    expect(frozenIn[1]).toEqual(l);
    expect(frozenIn[2]).toEqual(r);
    expect(decisions).toEqual([dec(p, "keep_local")]);
    // with one class fewer on the remote the same decision merges, so the refusal is about the cap and nothing else
    const roomy = clone(r);
    roomy.classes.pop(); // 1,000 total
    const ok = merge3(clone(base), clone(l), roomy, { decisions: [dec(only(pointsOf(l, roomy, base), "field"), "keep_local")] });
    expect(ok.status).toBe("merged");
  });
});

describe("several decisions at once", () => {
  const l = () =>
    edited(renameClass("A", "Maths"), move("s2", "A", "g2"), (d) => d.classes.push(cls("N", "One", "#111111"), cls("C1", "Bio")), addSession("x1", "A", "g1"));
  const r = () =>
    edited(renameClass("A", "Calculus"), move("s2", "B", null), (d) => d.classes.push(cls("N", "Two", "#222222"), cls("C2", "bio")), delGroup("g1"));
  const points = () => pointsOf(l(), r());
  const all = (): Decision[] => {
    const ps = points();
    return [
      dec(only(ps, "field"), "keep_remote"),
      dec(only(ps, "move"), "keep_local"),
      dec(only(ps, "add_mismatch"), "keep_local"),
      dec(only(ps, "name_collision"), "rename", { C2: "Biology" }),
      dec(only(ps, "group_deleted"), "ungroup"),
    ];
  };

  it("five kinds of decision resolve five conflicts into one pushable target", async () => {
    expect(points().map((p) => p.kind).sort()).toEqual(["add_mismatch", "field", "group_deleted", "move", "name_collision"]);
    const { target: t, result } = await mergeAndPush(baseSnapshot(), l(), r(), { decisions: all() });
    expect(names(t)).toEqual({ A: "Calculus", B: "Art", N: "One", C1: "Bio", C2: "Biology" });
    expect(find.ses(t, "s2")).toMatchObject({ classId: "A", groupId: "g2" });
    expect(find.ses(t, "x1")).toMatchObject({ classId: "A", groupId: null });
    expect(find.cls(t, "N").color).toBe("#111111");
    expect(result.status === "merged" && result.rejectedDecisions).toEqual([]);
    expect(applied(result).sort()).toEqual(["class:A:name:keep_remote", "class:C2:name:rename", "class:N::keep_local", "session:s2:placement:keep_local"]);
  });

  it("leaving one conflict undecided keeps the result conflicted with only that conflict, and no target", () => {
    const four = all().slice(0, 4);
    const out = conflictedResult(run(l(), r(), four));
    expect(out.decisionPoints.map((p) => p.kind)).toEqual(["group_deleted"]);
    expect(out.rejectedDecisions).toEqual([]);
    expect("target" in out).toBe(false);
  });

  it("the order of the decisions, and of the keys inside a rename payload, does not change the result", () => {
    const forward = run(l(), r(), all());
    const backward = run(l(), r(), [...all()].reverse());
    expect(backward).toEqual(forward);
    expect(run(l(), r(), all())).toEqual(forward); // repeatable
    const lc = edited((d) => d.classes.push(cls("C1", "Bio"), cls("D1", "Chem")));
    const rc = edited((d) => d.classes.push(cls("C2", "bio"), cls("D2", "chem")));
    const [pc] = pointsOf(lc, rc).filter((p) => p.kind === "name_collision");
    const ids = pc.ids;
    const one = Object.fromEntries(ids.map((id) => [id, `New ${id}`]));
    const two = Object.fromEntries([...ids].reverse().map((id) => [id, `New ${id}`]));
    expect(Object.keys(one)).not.toEqual(Object.keys(two));
    expect(run(lc, rc, [dec(pc, "rename", one)])).toEqual(run(lc, rc, [dec(pc, "rename", two)]));
  });

  it("a valid decision and an invalid one: the invalid one changes nothing, the valid one is applied", () => {
    const ps = points();
    const bad = dec(only(ps, "name_collision"), "rename", { C2: "Art" }); // class B is "Art"
    const out = conflictedResult(run(l(), r(), [dec(only(ps, "field"), "keep_local"), bad]));
    expect(out.rejectedDecisions).toEqual([{ decision: bad, reason: "name_collision" }]);
    expect(applied(out)).toEqual(["class:A:name:keep_local"]);
    expect(out.decisionPoints.map((p) => p.kind).sort()).toEqual(["add_mismatch", "group_deleted", "move", "name_collision"]);
  });
});

describe("decisions that must not be applied", () => {
  const l = () => edited(renameClass("A", "Maths"));
  const r = () => edited(renameClass("A", "Calculus"));
  const point = () => only(pointsOf(l(), r()), "field");
  const undecided = () => conflictedOf(l(), r());

  const unchanged = (out: MergeResult, reason: string | string[]) => {
    const c = conflictedResult(out);
    expect(c.rejectedDecisions.map((x) => x.reason)).toEqual(Array.isArray(reason) ? reason : [reason]);
    expect(c.conflicts).toEqual(undecided().conflicts);
    expect(c.decisionPoints).toEqual(undecided().decisionPoints);
    expect(applied(c)).toEqual([]);
    expect("target" in c).toBe(false);
  };

  it("a stale fingerprint (the situation changed) is rejected and modifies nothing", () => {
    const old = point();
    const changedRemote = edited(renameClass("A", "Algebra"));
    const out = run(l(), changedRemote, [dec(old, "keep_local")]);
    const c = conflictedResult(out);
    expect(c.rejectedDecisions.map((x) => x.reason)).toEqual(["stale"]);
    expect(c.conflicts).toEqual(conflictedOf(l(), changedRemote).conflicts);
  });

  it("decisions for a merge that has no conflicts are stale, and the merged target is exactly what it was", () => {
    const left = edited(renameClass("A", "Maths"));
    const right = edited(addSession("x2", "B"));
    const plain = merge3(baseSnapshot(), left, right);
    const withStale = merge3(baseSnapshot(), left, right, { decisions: [dec(point(), "keep_local")] });
    expect(withStale.status).toBe("merged");
    expect(target(withStale)).toEqual(target(plain));
    expect(reasons(withStale)).toEqual(["stale"]);
  });

  it("another fingerprint version is rejected as unsupported_version", () => {
    unchanged(run(l(), r(), [{ fingerprint: "sf2:" + point().fingerprint.slice(4), choice: "keep_local" }]), "unsupported_version");
  });

  it("a choice the point does not offer, and an unavailable choice, are rejected", () => {
    unchanged(run(l(), r(), [dec(point(), "rename", { A: "X" })]), "choice_not_allowed");
    unchanged(run(l(), r(), [dec(point(), "nonsense")]), "choice_not_allowed");
    const lc = edited(addSession("x1", "B"));
    const rc = edited(delClass("B"));
    const c = conflictedOf(lc, rc);
    const classPoint = only(c.decisionPoints, "class_deleted");
    for (const choice of ["delete_class"]) { // restoring (keep_class) works since Phase 3; deleting is not implemented
      const out = conflictedResult(run(lc, rc, [dec(classPoint, choice)]));
      expect(out.rejectedDecisions.map((x) => x.reason)).toEqual(["choice_unavailable"]);
      expect(out.conflicts).toEqual(c.conflicts);
    }
    const missing = edited((d) => (d.sessions = d.sessions.filter((s) => s.id !== "s2")));
    const removalPoint = only(pointsOf(missing, baseSnapshot()), "session_removal");
    for (const choice of ["remove", "restore"]) {
      const out = conflictedResult(run(missing, baseSnapshot(), [dec(removalPoint, choice)]));
      expect(out.rejectedDecisions.map((x) => x.reason)).toEqual(["choice_unavailable"]);
      expect(out.conflicts.map((x) => x.code)).toEqual(["session_removal_unsupported"]);
    }
  });

  it("malformed decisions and payloads are rejected as invalid_payload", () => {
    unchanged(run(l(), r(), [dec(point(), "keep_local", { A: "X" })]), "invalid_payload"); // names on a choice that takes none
    unchanged(run(l(), r(), [null, 5, "text", { fingerprint: point().fingerprint }, { choice: "keep_local" }]), ["invalid_payload", "invalid_payload", "invalid_payload", "invalid_payload", "invalid_payload"]);
  });

  it("one situation decided two different ways rejects both; identical repeats are applied once", () => {
    const keepLocal = dec(point(), "keep_local");
    const keepRemote = dec(point(), "keep_remote");
    unchanged(run(l(), r(), [keepLocal, keepRemote]), ["duplicate_conflicting", "duplicate_conflicting"]);
    const twice = run(l(), r(), [keepLocal, { ...keepLocal }]);
    expect(find.cls(target(twice), "A").name).toBe("Maths");
    expect(reasons(twice)).toEqual([]);
    expect(applied(twice)).toEqual(["class:A:name:keep_local"]);
  });

  it("nothing is ever chosen silently: without a decision a conflict stays a conflict", () => {
    const c = conflictedResult(run(l(), r(), []));
    expect(c.conflicts).toEqual(undecided().conflicts);
    expect(conflictedResult(merge3(baseSnapshot(), l(), r())).conflicts).toEqual(undecided().conflicts);
  });
});

describe("purity and unchanged behaviour", () => {
  it("never mutates the snapshots or the decisions, and gives the same result for frozen and unfrozen input", () => {
    const left = edited(renameClass("A", "Maths"), (d) => d.classes.push(cls("C1", "Bio")), move("s2", "A", "g2"));
    const right = edited(renameClass("A", "Calculus"), (d) => d.classes.push(cls("C2", "bio")), move("s2", "B", null));
    const ps = pointsOf(left, right);
    const decisions = [dec(only(ps, "field"), "keep_local"), dec(only(ps, "move"), "keep_remote"), dec(only(ps, "name_collision"), "rename", { C2: "  Biology " })];
    const plain = merge3(baseSnapshot(), clone(left), clone(right), { decisions: clone(decisions) });
    const frozen = merge3(deepFreeze(baseSnapshot()), deepFreeze(clone(left)), deepFreeze(clone(right)), { decisions: deepFreeze(clone(decisions)) });
    expect(frozen).toEqual(plain);
    expect(target(plain).classes.find((c) => c.id === "C2")?.name).toBe("Biology");
    expect(decisions[2].names).toEqual({ C2: "  Biology " }); // the caller's object keeps the name it passed
  });

  it("conflict-free merges are exactly what they were, with or without (junk) decisions", () => {
    const cases: [SyncSnapshot, SyncSnapshot][] = [
      [edited(renameClass("A", "Maths")), edited(addSession("x1", "B"))],
      [edited(delClass("B")), edited(renameGroup("g2", "Second"))],
      [edited(move("s2", "A", "g2")), edited(move("s3", "A", null))],
      [baseSnapshot(), baseSnapshot()],
    ];
    for (const [left, right] of cases) {
      const plain = merge3(baseSnapshot(), left, right);
      expect(plain.status).toBe("merged");
      expect(merge3(baseSnapshot(), left, right, { decisions: [] })).toEqual(plain);
      const junk = merge3(baseSnapshot(), left, right, { decisions: [{ fingerprint: "sf1:" + "0".repeat(64), choice: "keep_local" }, 7] });
      expect(target(junk)).toEqual(target(plain));
      expect(reasons(junk)).toEqual(["stale", "invalid_payload"]);
    }
  });

  it("refused merges stay refused (decisions are not looked at)", () => {
    const bad = clone(baseSnapshot());
    bad.classes.push(cls("A", "Duplicate"));
    expect(merge3(baseSnapshot(), bad, baseSnapshot(), { decisions: [{ fingerprint: "x", choice: "y" }] }).status).toBe("refused");
  });
});

describe("ids that exist on Object.prototype keep working with decisions", () => {
  it("a field decision and a rename decision (read back from JSON, so '__proto__' is an own key) are applied", () => {
    const base = snap([cls("constructor", "Beta")]);
    const l = snap([cls("constructor", "Beta L"), cls("__proto__", "Bio")]);
    const r = snap([cls("constructor", "Beta R"), cls("toString", "bio")]);
    const c = conflictedOf(l, r, base);
    const field = only(c.decisionPoints, "field");
    const collision = only(c.decisionPoints, "name_collision");
    expect(collision.ids).toEqual(["__proto__", "toString"]);
    const renameText = `{"fingerprint":"${collision.fingerprint}","choice":"rename","names":{"__proto__":"  Biology  "}}`;
    const out = merge3(base, l, r, { decisions: [dec(field, "keep_remote"), JSON.parse(renameText)] });
    expect(reasons(out)).toEqual([]);
    expect(names(target(out))).toEqual({ constructor: "Beta R", ["__proto__"]: "Biology", toString: "bio" }); // computed key: an own property, not the prototype
    expect(Object.keys(names(target(out))).sort()).toEqual(["__proto__", "constructor", "toString"]);
  });

  it("a rename naming an id outside the point is rejected even if that id exists on Object.prototype", () => {
    const l = snap([cls("__proto__", "Bio")]);
    const r = snap([cls("constructor", "bio")]);
    const p = only(pointsOf(l, r, snap()), "name_collision");
    const bad = JSON.parse(`{"fingerprint":"${p.fingerprint}","choice":"rename","names":{"toString":"Biology"}}`);
    const out = conflictedResult(merge3(snap(), l, r, { decisions: [bad] }));
    expect(out.rejectedDecisions.map((x) => x.reason)).toEqual(["invalid_payload"]);
  });
});
