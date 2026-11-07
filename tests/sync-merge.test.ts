import { describe, expect, it } from "vitest";
import { merge3 } from "@/lib/sync/merge";
import type { SyncSnapshot } from "@/lib/sync/snapshot";
import { clone, conflictKeys, conflictsOf, deepFreeze, mergeAndPush, mergedTarget, sameData } from "./helpers/merge-harness";
import { cls, grp, ses, snap } from "./helpers/sync-plan-harness";

/**
 * Base: classes A "Math" and B "Art"; subgroups g1, g2 in A and g3 in B; sessions s1 (A, g1), s2 (A),
 * s3 (B) and s4 (B, g3). Every test edits copies of it on one or both sides.
 */
const base = (): SyncSnapshot =>
  snap(
    [cls("A", "Math"), cls("B", "Art", "#8b5cf6")],
    [grp("g1", "A", "Unit 1"), grp("g2", "A", "Unit 2"), grp("g3", "B", "Sketch")],
    [ses("s1", "A", "g1", 1_000, 60), ses("s2", "A", null, 2_000, 120), ses("s3", "B", null, 3_000, 180), ses("s4", "B", "g3", 4_000, 240)],
  );

type Edit = (d: SyncSnapshot) => void;
const edited = (...edits: Edit[]): SyncSnapshot => {
  const d = base();
  for (const e of edits) e(d);
  return d;
};
const cl = (d: SyncSnapshot, id: string) => d.classes.find((c) => c.id === id)!;
const gr = (d: SyncSnapshot, id: string) => d.groups.find((g) => g.id === id)!;
const se = (d: SyncSnapshot, id: string) => d.sessions.find((s) => s.id === id)!;
const delClass =
  (id: string): Edit =>
  (d) => {
    d.classes = d.classes.filter((c) => c.id !== id);
    d.groups = d.groups.filter((g) => g.classId !== id);
    d.sessions = d.sessions.filter((s) => s.classId !== id);
  };
const delGroup =
  (id: string): Edit =>
  (d) => {
    d.groups = d.groups.filter((g) => g.id !== id);
    for (const s of d.sessions) if (s.groupId === id) s.groupId = null;
  };
const rename = (kind: "class" | "group", id: string, name: string): Edit => (d) => {
  (kind === "class" ? cl(d, id) : gr(d, id)).name = name;
};
const move = (id: string, classId: string, groupId: string | null): Edit => (d) => {
  Object.assign(se(d, id), { classId, groupId });
};
const addSession = (id: string, classId: string, groupId: string | null = null, seconds = 30): Edit => (d) => {
  d.sessions.push(ses(id, classId, groupId, 9_000 + d.sessions.length, seconds));
};

const run = (local: SyncSnapshot, remote: SyncSnapshot, base0 = base()) => merge3(base0, local, remote);
/** Both directions must give the same conflicts (by code, entity and id). */
const bothWays = (a: SyncSnapshot, b: SyncSnapshot) => {
  const ab = conflictKeys(run(a, b));
  expect(ab.length).toBeGreaterThan(0);
  expect(conflictKeys(run(b, a))).toEqual(ab);
  return ab;
};

describe("result shape", () => {
  it("a merged result has a target and no conflicts; a conflicted one has conflicts and no target", () => {
    const ok = run(base(), base());
    expect(ok.status).toBe("merged");
    expect("conflicts" in ok).toBe(false);
    const bad = run(edited(rename("class", "A", "X")), edited(rename("class", "A", "Y")));
    expect(bad.status).toBe("conflicted");
    expect("target" in bad).toBe(false);
  });

  it("a refused result has an error and no target", () => {
    const bad = clone(base());
    bad.classes.push(cls("A", "Dup"));
    const r = merge3(base(), bad, base());
    expect(r.status).toBe("refused");
    expect("target" in r).toBe(false);
  });

  it("never mutates its inputs and shares no objects with them", () => {
    const b = deepFreeze(base());
    const l = deepFreeze(edited(rename("class", "A", "Maths"), addSession("x1", "B")));
    const r = deepFreeze(edited(rename("group", "g2", "Unit Two")));
    const t = mergedTarget(merge3(b, l, r));
    for (const list of [t.classes, t.groups, t.sessions]) for (const item of list) {
      for (const input of [b, l, r]) {
        for (const src of [...input.classes, ...input.groups, ...input.sessions]) expect(item).not.toBe(src);
      }
    }
  });

  it("keeps remote's list order and puts new entities after, sorted by id", () => {
    const remote = edited((d) => d.classes.reverse());
    const local = edited((d) => d.classes.push(cls("Z", "Zed"), cls("N", "New")));
    const t = mergedTarget(run(local, remote));
    expect(t.classes.map((c) => c.id)).toEqual(["B", "A", "N", "Z"]);
  });
});

describe("no changes", () => {
  it("all three equal gives the same data, nothing to report, and an empty plan", async () => {
    const { result, plan } = await mergeAndPush(base(), base(), base());
    sameData(mergedTarget(result), base());
    expect(plan.ops).toEqual([]);
    if (result.status === "merged") {
      expect(result.resolutions).toEqual([]);
      expect(result.warnings).toEqual([]);
    }
  });

  it("an empty account merges to empty", () => {
    expect(mergedTarget(merge3(snap(), snap(), snap()))).toEqual(snap());
  });
});

describe("classes", () => {
  it("takes a local-only rename", async () => {
    const r = await mergeAndPush(base(), edited(rename("class", "A", "Maths")), base());
    expect(cl(r.target, "A").name).toBe("Maths");
  });

  it("takes a remote-only recolor", async () => {
    const r = await mergeAndPush(base(), base(), edited((d) => (cl(d, "B").color = "#10b981")));
    expect(cl(r.target, "B").color).toBe("#10b981");
  });

  it("the same change on both sides is taken once and reported", async () => {
    const side = () => edited(rename("class", "A", "Maths"));
    const { result, target } = await mergeAndPush(base(), side(), side());
    expect(cl(target, "A").name).toBe("Maths");
    expect(result.status === "merged" && result.resolutions).toContainEqual({ code: "same_change_both_sides", entity: "class", id: "A", field: "name" });
  });

  it("different fields changed on each side merge field by field", async () => {
    const { target } = await mergeAndPush(base(), edited(rename("class", "A", "Maths")), edited((d) => (cl(d, "A").color = "#10b981")));
    expect(cl(target, "A")).toEqual({ id: "A", name: "Maths", color: "#10b981" });
  });

  it("the same field changed differently conflicts and carries all three values", () => {
    const r = run(edited(rename("class", "A", "Maths")), edited(rename("class", "A", "Calculus")));
    const [c] = conflictsOf(r);
    expect(c).toMatchObject({ code: "class_field_conflict", entity: "class", id: "A", field: "name", base: "Math", local: "Maths", remote: "Calculus" });
  });

  it("both sides recoloring differently conflicts on color only", () => {
    const l = edited((d) => (cl(d, "B").color = "#111111"));
    const r = edited((d) => (cl(d, "B").color = "#222222"));
    expect(conflictsOf(run(l, r)).map((c) => c.field)).toEqual(["color"]);
  });

  it("a class deleted on one side and untouched on the other is deleted, with its sessions, and reported", async () => {
    for (const [l, r] of [[edited(delClass("B")), base()], [base(), edited(delClass("B"))]]) {
      const { result, target } = await mergeAndPush(base(), l, r);
      sameData(target, edited(delClass("B")));
      expect(result.status === "merged" && result.warnings).toEqual([
        expect.objectContaining({ code: "class_deleted_sessions_removed", entity: "class", id: "B", ids: ["s3", "s4"], count: 2 }),
      ]);
    }
  });

  it("deleted on both sides is deleted and reported", async () => {
    const { result, target } = await mergeAndPush(base(), edited(delClass("B")), edited(delClass("B")));
    sameData(target, edited(delClass("B")));
    expect(result.status === "merged" && result.resolutions).toContainEqual({ code: "both_deleted", entity: "class", id: "B" });
  });

  it("deleted on one side and edited on the other conflicts, in both directions", () => {
    const keys = bothWays(edited(delClass("B")), edited(rename("class", "B", "Drawing")));
    expect(keys).toEqual(["class_deleted_vs_edited:class:B"]);
  });

  it("deleted on one side while the other only edits a session's group elsewhere does not conflict", async () => {
    const { target } = await mergeAndPush(base(), edited(delClass("B")), edited(move("s2", "A", "g2")));
    expect(se(target, "s2").groupId).toBe("g2");
    expect(target.classes.map((c) => c.id)).toEqual(["A"]);
  });

  it("classes added on either side are kept (and pushed)", async () => {
    const { target } = await mergeAndPush(base(), edited((d) => d.classes.push(cls("L", "Local"))), edited((d) => d.classes.push(cls("R", "Remote"))));
    expect(target.classes.map((c) => c.id).sort()).toEqual(["A", "B", "L", "R"]);
  });

  it("the same class added identically on both sides is added once", async () => {
    const add: Edit = (d) => d.classes.push(cls("N", "New"));
    const { result, target } = await mergeAndPush(base(), edited(add), edited(add));
    expect(target.classes.filter((c) => c.id === "N")).toHaveLength(1);
    expect(result.status === "merged" && result.resolutions).toContainEqual({ code: "both_added_identical", entity: "class", id: "N" });
  });

  it("the same class id added with different contents conflicts, and names are not used to match", () => {
    const r = run(edited((d) => d.classes.push(cls("N", "One"))), edited((d) => d.classes.push(cls("N", "Two"))));
    expect(conflictKeys(r)).toEqual(["class_add_mismatch:class:N"]);
    // Same name, different ids: two entities, so a collision, never a silent merge into one.
    const r2 = run(edited((d) => d.classes.push(cls("N1", "Same"))), edited((d) => d.classes.push(cls("N2", "Same"))));
    expect(conflictKeys(r2)).toEqual(["name_collision:class:N1"]);
  });
});

describe("class deleted while the other side depends on it", () => {
  it("a session added to the deleted class conflicts (both directions) and is not dropped", () => {
    expect(bothWays(edited(delClass("B")), edited(addSession("x1", "B")))).toEqual(["class_deleted_but_sessions_added:session:x1"]);
  });

  it("a session moved out to a surviving class keeps its move and the class is still deleted (both directions)", async () => {
    for (const [l, r] of [[edited(move("s3", "A", null)), edited(delClass("B"))], [edited(delClass("B")), edited(move("s3", "A", null))]]) {
      const localMoved = l.sessions.some((x) => x.id === "s3"); // otherwise local deleted the class and remote moved the session
      const { result, target, plan } = await mergeAndPush(base(), l, r);
      expect(se(target, "s3")).toEqual(ses("s3", "A", null, 3_000, 180)); // same id and immutable fields, new class
      expect(target.classes.map((c) => c.id)).toEqual(["A"]);
      expect(target.sessions.map((x) => x.id).sort()).toEqual(["s1", "s2", "s3"]); // s4 went with the class
      expect(result.status === "merged" && result.resolutions).toContainEqual({ code: "moved_session_kept", entity: "session", id: "s3" });
      expect(result.status === "merged" && result.warnings).toEqual([expect.objectContaining({ code: "class_deleted_sessions_removed", id: "B", ids: ["s4"] })]);
      // The server lost the session with its class only when the class was deleted remotely: then the plan adds it again.
      expect(plan.ops.some((o) => o.op === "add_session" && o.id === "s3")).toBe(localMoved);
    }
  });

  it("the kept move also carries a destination subgroup, and a destination class created on the same device", async () => {
    const toGroup = await mergeAndPush(base(), edited(move("s4", "A", "g2")), edited(delClass("B")));
    expect(se(toGroup.target, "s4")).toMatchObject({ classId: "A", groupId: "g2" });
    const newClass: Edit = (d) => d.classes.push(cls("N", "Newer"));
    const toNew = await mergeAndPush(base(), edited(newClass, move("s3", "N", null)), edited(delClass("B")));
    expect(se(toNew.target, "s3").classId).toBe("N");
    expect(toNew.target.classes.map((c) => c.id).sort()).toEqual(["A", "N"]);
  });

  it("a move whose destination does not survive still conflicts", () => {
    // remote deletes both A and B; local moved s3 from B into A, which is deleted too
    const remote = edited(delClass("A"), delClass("B"));
    expect(conflictKeys(run(edited(move("s3", "A", null)), remote))).toEqual(["class_deleted_but_sessions_modified:session:s3"]);
  });

  it("a session moved within the deleted class (to another subgroup) also conflicts", () => {
    const withG = (d: SyncSnapshot) => d.groups.push(grp("g4", "B", "Other"));
    const b = edited(withG);
    const local = edited(withG, delClass("B"));
    const remote = edited(withG, move("s4", "B", "g4"));
    expect(conflictKeys(merge3(b, local, remote))).toEqual(["class_deleted_but_sessions_modified:session:s4"]);
  });

  it("a session moved into the deleted class conflicts", () => {
    expect(bothWays(edited(delClass("B")), edited(move("s2", "B", null)))).toEqual(["class_deleted_but_sessions_modified:session:s2"]);
  });

  it("a subgroup created under the deleted class conflicts (rule B)", () => {
    expect(bothWays(edited(delClass("B")), edited((d) => d.groups.push(grp("g9", "B", "New"))))).toEqual(["class_deleted_but_groups_added:group:g9"]);
  });

  it("a subgroup under the deleted class that was renamed conflicts", () => {
    expect(bothWays(edited(delClass("B")), edited(rename("group", "g3", "Paint")))).toEqual(["class_deleted_but_groups_modified:group:g3"]);
  });

  it("a subgroup moved into the deleted class conflicts", () => {
    expect(bothWays(edited(delClass("B")), edited((d) => (gr(d, "g2").classId = "B")))).toEqual(["class_deleted_but_groups_modified:group:g2"]);
  });

  it("a subgroup and a session added together under the deleted class report both", () => {
    const add: Edit = (d) => {
      d.groups.push(grp("g9", "B", "New"));
      d.sessions.push(ses("x1", "B", "g9", 9_000, 30));
    };
    expect(bothWays(edited(delClass("B")), edited(add))).toEqual(["class_deleted_but_groups_added:group:g9", "class_deleted_but_sessions_added:session:x1"]);
  });

  it("untouched sessions in a deleted class are not a conflict even if the other side moved other sessions", async () => {
    const { target } = await mergeAndPush(base(), edited(delClass("B")), edited(move("s2", "A", "g2")));
    expect(target.sessions.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });
});

describe("subgroups", () => {
  it("a rename on one side merges", async () => {
    const { target } = await mergeAndPush(base(), edited(rename("group", "g2", "Unit Two")), base());
    expect(gr(target, "g2").name).toBe("Unit Two");
  });

  it("different renames of the same subgroup conflict", () => {
    expect(bothWays(edited(rename("group", "g2", "One")), edited(rename("group", "g2", "Two")))).toEqual(["group_field_conflict:group:g2"]);
  });

  it("the same rename on both sides is taken once", async () => {
    const { result } = await mergeAndPush(base(), edited(rename("group", "g2", "Same")), edited(rename("group", "g2", "Same")));
    expect(result.status === "merged" && result.resolutions).toContainEqual({ code: "same_change_both_sides", entity: "group", id: "g2", field: "name" });
  });

  it("moving a subgroup (no sessions) to another class merges, and conflicts when both choose differently", async () => {
    const withC = (d: SyncSnapshot) => d.classes.push(cls("C", "Bio"));
    const b = edited(withC);
    const toB = edited(withC, (d) => (gr(d, "g2").classId = "B"));
    const toC = edited(withC, (d) => (gr(d, "g2").classId = "C"));
    const one = await mergeAndPush(b, toB, b);
    expect(gr(one.target, "g2").classId).toBe("B");
    expect(conflictsOf(merge3(b, toB, toC)).map((c) => `${c.code}:${c.field}`)).toEqual(["group_field_conflict:classId"]);
    expect(mergedTarget(merge3(b, toB, toB)).groups.find((g) => g.id === "g2")?.classId).toBe("B");
  });

  it("deleted on one side and untouched on the other: sessions stay, ungrouped, with a warning (both directions)", async () => {
    for (const [l, r] of [[edited(delGroup("g1")), base()], [base(), edited(delGroup("g1"))]]) {
      const { result, target } = await mergeAndPush(base(), l, r);
      expect(se(target, "s1").groupId).toBeNull();
      expect(target.sessions).toHaveLength(4);
      expect(result.status === "merged" && result.warnings).toEqual([
        expect.objectContaining({ code: "group_deleted_sessions_ungrouped", entity: "group", id: "g1", ids: ["s1"], count: 1 }),
      ]);
    }
  });

  it("deleted on both sides is deleted once", async () => {
    const { result, target } = await mergeAndPush(base(), edited(delGroup("g1")), edited(delGroup("g1")));
    expect(target.groups.map((g) => g.id)).toEqual(["g2", "g3"]);
    expect(se(target, "s1").groupId).toBeNull();
    expect(result.status === "merged" && result.resolutions).toContainEqual({ code: "both_deleted", entity: "group", id: "g1" });
  });

  it("deleted on one side while the other renames it conflicts (rule: delete vs edit)", () => {
    expect(bothWays(edited(delGroup("g2")), edited(rename("group", "g2", "Renamed")))).toEqual(["group_deleted_vs_edited:group:g2"]);
  });

  it("a base session moved out of the deleted group on the other side keeps its move (rule C)", async () => {
    const toG2 = await mergeAndPush(base(), edited(delGroup("g1")), edited(move("s1", "A", "g2")));
    expect(se(toG2.target, "s1")).toMatchObject({ classId: "A", groupId: "g2" });
    const toNone = await mergeAndPush(base(), edited(move("s1", "A", null)), edited(delGroup("g1")));
    expect(se(toNone.target, "s1").groupId).toBeNull();
    const toB = await mergeAndPush(base(), edited(delGroup("g1")), edited(move("s1", "B", null)));
    expect(se(toB.target, "s1")).toMatchObject({ classId: "B", groupId: null });
    expect(toB.result.status === "merged" && toB.result.warnings).toEqual([]);
  });

  it("a base session moved INTO the deleted group on the other side conflicts (rule C)", () => {
    expect(bothWays(edited(delGroup("g1")), edited(move("s2", "A", "g1")))).toEqual(["group_deleted_but_sessions_moved_in:session:s2"]);
  });

  it("a new session created in the deleted group on the other side conflicts (rule C)", () => {
    expect(bothWays(edited(delGroup("g1")), edited(addSession("x1", "A", "g1")))).toEqual(["group_deleted_but_sessions_added:session:x1"]);
  });

  it("subgroups added on either side are kept", async () => {
    const { target } = await mergeAndPush(base(), edited((d) => d.groups.push(grp("n1", "A", "New L"))), edited((d) => d.groups.push(grp("n2", "A", "New R"))));
    expect(target.groups).toHaveLength(5);
  });

  it("the same subgroup id added with different contents conflicts", () => {
    expect(conflictKeys(run(edited((d) => d.groups.push(grp("n", "A", "One"))), edited((d) => d.groups.push(grp("n", "A", "Two")))))).toEqual(["group_add_mismatch:group:n"]);
  });

  it("a session moved into a subgroup whose class changed on the other side conflicts", () => {
    const l = edited((d) => (gr(d, "g2").classId = "B"));
    const r = edited(move("s2", "A", "g2"));
    expect(conflictKeys(run(l, r))).toEqual(["session_group_class_mismatch:session:s2"]);
  });
});

describe("sessions", () => {
  it("sessions added on either side are kept (union by id)", async () => {
    const { target } = await mergeAndPush(base(), edited(addSession("x1", "A")), edited(addSession("x2", "B", "g3")));
    expect(target.sessions.map((s) => s.id).sort()).toEqual(["s1", "s2", "s3", "s4", "x1", "x2"]);
  });

  it("the same session added identically on both sides is kept once", async () => {
    const { result, target } = await mergeAndPush(base(), edited(addSession("x1", "A")), edited(addSession("x1", "A")));
    expect(target.sessions.filter((s) => s.id === "x1")).toHaveLength(1);
    expect(result.status === "merged" && result.resolutions).toContainEqual({ code: "both_added_identical", entity: "session", id: "x1" });
  });

  /** The merge is refused (not conflicted): the error names the sessions and there is no target. */
  const refusedMismatch = (r: ReturnType<typeof run>, ids: string[]) => {
    expect(r.status).toBe("refused");
    if (r.status !== "refused") return;
    expect(r.error.code).toBe("session_immutable_mismatch");
    expect(r.error.ids).toEqual(ids);
    expect(r.error.count).toBe(ids.length);
    expect("target" in r).toBe(false);
  };

  it("the same id with different immutable fields refuses the merge, whichever field differs and whichever side", () => {
    for (const [l, r] of [
      [edited(addSession("x1", "A")), edited(addSession("x1", "A", null, 31))],
      [edited((d) => d.sessions.push(ses("x1", "A", null, 5, 30))), edited((d) => d.sessions.push(ses("x1", "A", null, 6, 30)))],
      [edited((d) => d.sessions.push(ses("x1", "A", null, 5, 30))), edited((d) => d.sessions.push(ses("x1", "A", null, 5, 30, "countdown")))],
    ] as const) {
      refusedMismatch(run(l, r), ["x1"]);
      refusedMismatch(run(r, l), ["x1"]);
    }
  });

  it("an immutable field edited against base on either side refuses the merge and is never picked", () => {
    const changed = edited((d) => (se(d, "s2").seconds = 999));
    refusedMismatch(run(changed, base()), ["s2"]);
    refusedMismatch(run(base(), changed), ["s2"]);
    refusedMismatch(run(edited((d) => (se(d, "s2").startedAt = 1)), edited((d) => (se(d, "s2").mode = "countdown"))), ["s2"]);
  });

  it("the refusal comes before any other finding, lists every affected session, and caps the listed ids", () => {
    const local = edited(rename("class", "A", "One"), (d) => (se(d, "s1").seconds = 7), (d) => (se(d, "s3").seconds = 8));
    const remote = edited(rename("class", "A", "Two"));
    refusedMismatch(run(local, remote), ["s1", "s3"]); // not a class_field_conflict
    const many = (seconds: number) => snap([cls("A", "Math")], [], Array.from({ length: 30 }, (_, i) => ses(`m${String(i).padStart(2, "0")}`, "A", null, 1_000 + i, seconds)));
    const r = merge3(many(60), many(61), many(60));
    expect(r.status === "refused" && r.error.count).toBe(30);
    expect(r.status === "refused" && r.error.ids).toHaveLength(20);
    expect(r.status === "refused" && r.error.ids?.[0]).toBe("m00");
  });

  it("a session with the same fields everywhere is not a mismatch (only a move differs)", () => {
    expect(conflictKeys(run(edited(move("s2", "A", "g2")), edited(move("s2", "B", null))))).toEqual(["session_move_conflict:session:s2"]);
  });

  it("a move on one side is taken", async () => {
    const { target } = await mergeAndPush(base(), edited(move("s2", "A", "g2")), edited(move("s3", "A", null)));
    expect(se(target, "s2")).toMatchObject({ classId: "A", groupId: "g2" });
    expect(se(target, "s3")).toMatchObject({ classId: "A", groupId: null });
  });

  it("the same move on both sides is taken once", async () => {
    const m = edited(move("s2", "B", null));
    const { result, target } = await mergeAndPush(base(), m, clone(m));
    expect(se(target, "s2").classId).toBe("B");
    expect(result.status === "merged" && result.resolutions).toContainEqual({ code: "same_change_both_sides", entity: "session", id: "s2", field: "placement" });
  });

  it("different moves of one session conflict, and the class and subgroup move as one unit", () => {
    expect(bothWays(edited(move("s2", "A", "g2")), edited(move("s2", "B", null)))).toEqual(["session_move_conflict:session:s2"]);
    expect(bothWays(edited(move("s2", "A", "g1")), edited(move("s2", "A", "g2")))).toEqual(["session_move_conflict:session:s2"]);
  });

  it("a session created on both sides in different places conflicts", () => {
    expect(bothWays(edited(addSession("x1", "A")), edited(addSession("x1", "B")))).toEqual(["session_move_conflict:session:x1"]);
  });

  it("a session missing on one side while its class remains conflicts (nothing deletes a single session)", () => {
    const without = edited((d) => (d.sessions = d.sessions.filter((s) => s.id !== "s2")));
    expect(bothWays(without, base())).toEqual(["session_removal_unsupported:session:s2"]);
    expect(conflictKeys(run(without, without))).toEqual(["session_removal_unsupported:session:s2"]);
  });

  it("a session missing on one side with its class deleted there is removed with the class, not a conflict", async () => {
    const { target } = await mergeAndPush(base(), edited(delClass("A")), base());
    expect(target.sessions.map((s) => s.id)).toEqual(["s3", "s4"]);
  });

  it("a class deleted on one side while the other side removed a session of it is still a conflict only if the class stays", () => {
    const without = edited((d) => (d.sessions = d.sessions.filter((s) => s.id !== "s3")));
    // local deleted class B (so s3 is gone there legitimately); remote lost s3 while B stays: unsupported
    expect(conflictKeys(run(edited(delClass("B")), without))).toEqual(["session_removal_unsupported:session:s3"]);
  });
});

describe("names", () => {
  it("two classes whose names collide only after merging conflict, and nothing is renamed", () => {
    const r = run(edited((d) => d.classes.push(cls("C1", "Bio"))), edited((d) => d.classes.push(cls("C2", "bio"))));
    const [c] = conflictsOf(r);
    expect(c).toMatchObject({ code: "name_collision", entity: "class", id: "C1", relatedIds: ["C2"] });
    expect(conflictKeys(run(edited((d) => d.classes.push(cls("C2", "bio"))), edited((d) => d.classes.push(cls("C1", "Bio")))))).toEqual(["name_collision:class:C1"]);
  });

  it("a rename onto a name the other side just created conflicts", () => {
    expect(bothWays(edited(rename("class", "A", "Bio")), edited((d) => d.classes.push(cls("X", " bio".trim()))))).toEqual(["name_collision:class:A"]);
  });

  it("two subgroups of one class that collide conflict; the same name in different classes does not", async () => {
    expect(bothWays(edited((d) => d.groups.push(grp("n1", "A", "Unit 3"))), edited((d) => d.groups.push(grp("n2", "A", "unit 3"))))).toEqual(["name_collision:group:n1"]);
    const ok = await mergeAndPush(base(), edited((d) => d.groups.push(grp("n1", "A", "Sketch"))), edited((d) => d.groups.push(grp("n2", "B", "Unit 1"))));
    expect(ok.target.groups).toHaveLength(5);
  });

  it("detects a collision under the simple lowercasing rule as well as the app's", () => {
    // "İ" lowercases to "i̇" (two code points) with toLowerCase, but to one code point under the simple rule's first character: both rules are tried.
    const r = run(edited((d) => d.classes.push(cls("C1", "İstanbul"))), edited((d) => d.classes.push(cls("C2", "i̇stanbul"))));
    expect(r.status === "conflicted" ? r.conflicts.map((c) => c.code) : []).toEqual(["name_collision"]);
  });

  it("renames of different classes on the two sides that never collide merge fine", async () => {
    const { target } = await mergeAndPush(base(), edited(rename("class", "A", "Zed")), edited(rename("class", "B", "Drawing")));
    expect(target.classes.map((c) => c.name)).toEqual(["Zed", "Drawing"]);
  });

  it("a name the remote freed and reused (valid there) survives a local change elsewhere", async () => {
    const remote = edited(rename("class", "A", "Maths"), (d) => d.classes.push(cls("N", "Math")));
    const { target } = await mergeAndPush(base(), edited(rename("class", "B", "Drawing")), remote);
    expect(target.classes.find((c) => c.id === "N")?.name).toBe("Math");
    expect(cl(target, "A").name).toBe("Maths");
    expect(cl(target, "B").name).toBe("Drawing");
  });

  it("an entity already in conflict is not also reported as a collision", () => {
    const r = run(edited(rename("class", "A", "One")), edited((d) => {
      rename("class", "A", "Two")(d);
      d.classes.push(cls("N", "one"));
    }));
    expect(conflictKeys(r)).toEqual(["class_field_conflict:class:A"]);
  });
});

describe("protected ids (running timer)", () => {
  it("a class the merge would delete conflicts when protected, and merges when not", async () => {
    const r = merge3(base(), base(), edited(delClass("B")), { protect: { classIds: ["B"] } });
    expect(conflictKeys(r)).toEqual(["protected_entity_deleted:class:B"]);
    await mergeAndPush(base(), base(), edited(delClass("B")));
  });

  it("a subgroup the merge would delete conflicts when protected", () => {
    expect(conflictKeys(merge3(base(), base(), edited(delGroup("g2")), { protect: { groupIds: ["g2"] } }))).toEqual(["protected_entity_deleted:group:g2"]);
  });

  it("protection of something the merge keeps changes nothing", async () => {
    const { result } = await mergeAndPush(base(), base(), edited(delClass("B")), { protect: { classIds: ["A"], groupIds: ["g1", "nope"] } });
    expect(result.status).toBe("merged");
  });

  it("a protected id the local side no longer has is ignored", async () => {
    await mergeAndPush(base(), edited(delClass("B")), edited(delClass("B")), { protect: { classIds: ["B"] } });
  });

  it("deleting the class also reports a protected subgroup inside it", () => {
    const keys = conflictKeys(merge3(base(), base(), edited(delClass("B")), { protect: { classIds: ["B"], groupIds: ["g3"] } }));
    expect(keys).toEqual(["protected_entity_deleted:class:B", "protected_entity_deleted:group:g3"]);
  });
});

describe("refusals", () => {
  const dup = () => {
    const d = base();
    d.classes.push(cls("Z", "math"));
    return d;
  };

  it("refuses an invalid base, local or remote with the validation issues", () => {
    for (const [args, code] of [
      [[dup(), base(), base()], "invalid_base"],
      [[base(), dup(), base()], "invalid_local"],
      [[base(), base(), dup()], "invalid_remote"],
    ] as const) {
      const r = merge3(...(args as [SyncSnapshot, SyncSnapshot, SyncSnapshot]));
      expect(r.status === "refused" && r.error.code).toBe(code);
      expect(r.status === "refused" && r.error.issues?.length).toBeGreaterThan(0);
    }
  });

  it("refuses data that would exceed a server cap after merging", () => {
    const many = () => snap(Array.from({ length: 999 }, (_, i) => cls(`c${i}`, `Class ${i}`)));
    const add = (id: string) => {
      const d = many();
      d.classes.push(cls(id, id));
      return d;
    };
    const r = merge3(many(), add("L"), add("R"));
    expect(r.status === "refused" && r.error.code).toBe("caps_exceeded");
  });

  it("keeps the planner's own error when the merged target cannot be pushed", () => {
    const r = merge3(base(), edited((d) => d.classes.push(cls("N", "New"))), base(), { diff: { maxBytes: 10 } });
    expect(r.status).toBe("refused");
    if (r.status === "refused") {
      expect(r.error.code).toBe("not_representable");
      expect(r.error.diff?.code).toBeTruthy();
      expect(r.error.message).toContain(r.error.diff!.message);
    }
  });
});

describe("determinism and symmetry", () => {
  it("returns identical results for identical inputs and identical conflicts when the sides are swapped", () => {
    const l = edited(delClass("B"), rename("group", "g2", "L"));
    const r = edited(addSession("x1", "B"), rename("class", "A", "R"));
    expect(run(l, r)).toEqual(run(clone(l), clone(r)));
    expect(conflictKeys(run(l, r))).toEqual(conflictKeys(run(r, l)));
  });

  it("a merged target is the same data when the sides are swapped (when remote's order is the same)", () => {
    const l = edited(rename("class", "A", "Maths"), addSession("x1", "B"));
    const r = edited((d) => (cl(d, "B").color = "#10b981"), addSession("x2", "A", "g2"));
    sameData(mergedTarget(run(l, r)), mergedTarget(run(r, l)));
  });
});
