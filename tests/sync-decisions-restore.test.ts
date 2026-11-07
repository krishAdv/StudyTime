import { describe, expect, it } from "vitest";
import type { Decision, DecisionPoint } from "@/lib/sync/decisions";
import { merge3, type MergeResult } from "@/lib/sync/merge";
import type { SyncSnapshot } from "@/lib/sync/snapshot";
import { addSession, baseSnapshot, conflictedOf, delClass, delGroup, edited, find, move, renameClass, renameGroup } from "./helpers/merge-fixtures";
import { clone, mergeAndPush } from "./helpers/merge-harness";

/**
 * S5 Phase 3 (restore only): `keep_class` and `keep_group` undo a deletion that the other device's work depends on.
 * The class or subgroup stays, in the version of the side that still has it, together with everything that side holds.
 * Nothing is deleted: the destructive choices (`delete_class`, `remove`) are still unavailable.
 * Base: classes A "Math", B "Art"; subgroups g1, g2 (in A), g3 (in B); sessions s1 (A, g1), s2 (A), s3 (B), s4 (B, g3).
 */

const pointOf = (local: SyncSnapshot, remote: SyncSnapshot, kind: DecisionPoint["kind"]): DecisionPoint => {
  const found = conflictedOf(local, remote).decisionPoints.filter((p) => p.kind === kind);
  if (found.length !== 1) throw new Error(`expected one ${kind} point, found ${found.length}`);
  return found[0];
};
const dec = (p: DecisionPoint, choice: string): Decision => ({ fingerprint: p.fingerprint, choice });
const ids = (list: { id: string }[]) => list.map((x) => x.id).sort();
/** Every session either side had is still there (the sessions of a restored class are never lost). */
const allSessions = (...sides: SyncSnapshot[]) => [...new Set(sides.flatMap((s) => s.sessions.map((x) => x.id)))].sort();

/** Merges with one decision, pushes the plan to the fake server and checks it converges, then returns the target. */
async function restore(local: SyncSnapshot, remote: SyncSnapshot, kind: DecisionPoint["kind"], choice: string) {
  const p = pointOf(local, remote, kind);
  const { target, result } = await mergeAndPush(baseSnapshot(), local, remote, { decisions: [dec(p, choice)] });
  if (result.status !== "merged") throw new Error("not merged");
  expect(result.rejectedDecisions).toEqual([]);
  return { target, result };
}

describe("keep_class restores a deleted class", () => {
  it("deleted here, but the server added a session to it: the class, its subgroup and every session stay", async () => {
    const l = edited(delClass("B"));
    const r = edited(addSession("x1", "B", "g3"));
    const { target: t, result } = await restore(l, r, "class_deleted", "keep_class");
    expect(ids(t.classes)).toEqual(["A", "B"]);
    expect(ids(t.groups)).toEqual(["g1", "g2", "g3"]);
    expect(ids(t.sessions)).toEqual(allSessions(l, r, baseSnapshot()));
    expect(find.ses(t, "x1")).toEqual(find.ses(r, "x1"));
    expect(find.ses(t, "s3")).toEqual(find.ses(baseSnapshot(), "s3")); // immutable fields intact
    expect(result.resolutions.some((x) => x.code === "decision_applied" && x.id === "B" && x.choice === "keep_class")).toBe(true);
    expect(result.warnings).toEqual([]); // nothing was removed with the class
  });

  it("deleted on the server, but this device added a session to it: the plan puts the class back on the server with the same ids", async () => {
    const l = edited(addSession("x1", "B", "g3"));
    const r = edited(delClass("B"));
    const { target: t } = await restore(l, r, "class_deleted", "keep_class");
    expect(ids(t.classes)).toEqual(["A", "B"]);
    expect(ids(t.groups)).toEqual(["g1", "g2", "g3"]);
    expect(ids(t.sessions)).toEqual(allSessions(l, r, baseSnapshot()));
    for (const id of ["s3", "s4", "x1"]) expect(find.ses(t, id), id).toEqual(find.ses(l, id));
  });

  it("the edited version of the class wins when the other side deleted it (the edit is not lost)", async () => {
    const l = edited(renameClass("B", "Drawing"));
    const r = edited(delClass("B"));
    const { target: t } = await restore(l, r, "class_deleted", "keep_class");
    expect(find.cls(t, "B").name).toBe("Drawing");
    expect(ids(t.sessions)).toEqual(allSessions(baseSnapshot()));
  });

  it("an edited subgroup of the deleted class is restored in its edited form", async () => {
    const l = edited(renameGroup("g3", "Sketches"));
    const r = edited(delClass("B"));
    const { target: t } = await restore(l, r, "class_deleted", "keep_class");
    expect(find.grp(t, "g3")).toEqual({ id: "g3", classId: "B", name: "Sketches" });
    expect(ids(t.sessions)).toEqual(allSessions(baseSnapshot()));
  });

  it("a session moved inside the deleted class keeps its move", async () => {
    const l = edited(move("s4", "B", null));
    const r = edited(delClass("B"));
    const { target: t } = await restore(l, r, "class_deleted", "keep_class");
    expect(find.ses(t, "s4")).toEqual({ ...find.ses(baseSnapshot(), "s4"), classId: "B", groupId: null });
    expect(ids(t.sessions)).toEqual(allSessions(baseSnapshot()));
  });

  it("without the decision the conflict stays and nothing is chosen", () => {
    const out = conflictedOf(edited(addSession("x1", "B")), edited(delClass("B")));
    expect(out.conflicts.map((c) => c.code)).toEqual(["class_deleted_but_sessions_added"]);
    expect("target" in out).toBe(false);
  });

  it("deleting stays unavailable: delete_class is rejected and nothing changes", () => {
    const l = edited(addSession("x1", "B"));
    const r = edited(delClass("B"));
    const c = conflictedOf(l, r);
    const p = c.decisionPoints[0];
    expect(p.choices.map((x) => [x.key, x.unavailable === undefined])).toEqual([["keep_class", true], ["delete_class", false]]);
    const out = merge3(baseSnapshot(), clone(l), clone(r), { decisions: [dec(p, "delete_class")] });
    expect(out.status).toBe("conflicted");
    if (out.status === "conflicted") {
      expect(out.rejectedDecisions.map((x) => x.reason)).toEqual(["choice_unavailable"]);
      expect(out.conflicts).toEqual(c.conflicts);
    }
  });

  it("is order independent and repeatable", () => {
    const l = edited(addSession("x1", "B", "g3"));
    const r = edited(delClass("B"));
    const p = pointOf(l, r, "class_deleted");
    const once: MergeResult = merge3(baseSnapshot(), clone(l), clone(r), { decisions: [dec(p, "keep_class")] });
    const twice: MergeResult = merge3(baseSnapshot(), clone(l), clone(r), { decisions: [dec(p, "keep_class"), dec(p, "keep_class")] });
    expect(twice).toEqual(once);
  });
});

describe("keep_group restores a deleted subgroup", () => {
  it("deleted on the server, but this device added a session to it: the subgroup and its sessions stay grouped", async () => {
    const l = edited(addSession("x1", "A", "g1"));
    const r = edited(delGroup("g1"));
    const { target: t, result } = await restore(l, r, "group_deleted", "keep_group");
    expect(ids(t.groups)).toEqual(["g1", "g2", "g3"]);
    expect(find.ses(t, "x1")).toEqual(find.ses(l, "x1"));
    expect(find.ses(t, "s1")).toEqual(find.ses(baseSnapshot(), "s1")); // still in g1: nothing was ungrouped
    expect(ids(t.sessions)).toEqual(allSessions(l, r, baseSnapshot()));
    expect(result.warnings).toEqual([]);
    expect(result.resolutions.some((x) => x.choice === "keep_group" && x.id === "g1")).toBe(true);
  });

  it("deleted here, but the server moved a session into it: the subgroup stays and the session keeps its place", async () => {
    const l = edited(delGroup("g1"));
    const r = edited(move("s2", "A", "g1"));
    const { target: t } = await restore(l, r, "group_deleted", "keep_group");
    expect(ids(t.groups)).toEqual(["g1", "g2", "g3"]);
    expect(find.ses(t, "s2")).toEqual({ ...find.ses(baseSnapshot(), "s2"), groupId: "g1" });
    expect(find.ses(t, "s1").groupId).toBe("g1");
    expect(ids(t.sessions)).toEqual(allSessions(baseSnapshot()));
  });

  it("a subgroup deleted on one side and renamed on the other keeps the new name", async () => {
    const l = edited(delGroup("g1"));
    const r = edited(renameGroup("g1", "First"));
    const { target: t } = await restore(l, r, "group_deleted", "keep_group");
    expect(find.grp(t, "g1")).toEqual({ id: "g1", classId: "A", name: "First" });
    expect(find.ses(t, "s1").groupId).toBe("g1");
  });

  it("ungroup is still available for the same point and does the opposite", async () => {
    const l = edited(addSession("x1", "A", "g1"));
    const r = edited(delGroup("g1"));
    const { target: t } = await restore(l, r, "group_deleted", "ungroup");
    expect(ids(t.groups)).toEqual(["g2", "g3"]);
    expect(find.ses(t, "x1").groupId).toBeNull();
  });
});
