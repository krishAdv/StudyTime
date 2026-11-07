import { describe, expect, it } from "vitest";
import { PUSH_LIMITS } from "@/lib/sync/changes";
import { DEFAULT_BATCH_BYTES, diffToOps } from "@/lib/sync/diff";
import { cls, grp, kinds, planAndApply, planOk, ses, snap } from "./helpers/sync-plan-harness";

const deepFreeze = <T>(v: T): T => {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v)) deepFreeze(child);
  }
  return v;
};
const isTemp = (name: unknown) => typeof name === "string" && /^~sync-\d+$/.test(name);
const indexOfOp = (ops: { op: string; id?: string }[], op: string, id: string) => ops.findIndex((o) => o.op === op && o.id === id);

describe("nothing to do", () => {
  it("two empty snapshots give an empty plan", () => {
    const p = planOk(diffToOps(snap(), snap()));
    expect(p.ops).toEqual([]);
    expect(p.batches).toEqual([]);
  });

  it("identical snapshots give an empty plan", () => {
    const s = snap([cls("c1", "Math"), cls("c2", "Art")], [grp("g1", "c1", "Unit 1")], [ses("s1", "c1", "g1"), ses("s2", "c2")]);
    expect(planOk(diffToOps(s, structuredClone(s))).ops).toEqual([]);
  });

  it("the order of the lists does not matter when nothing differs", () => {
    const a = snap([cls("c1", "Math"), cls("c2", "Art")], [], [ses("s1", "c1"), ses("s2", "c2")]);
    const b = snap([cls("c2", "Art"), cls("c1", "Math")], [], [ses("s2", "c2"), ses("s1", "c1")]);
    expect(planOk(diffToOps(a, b)).ops).toEqual([]);
  });
});

describe("classes", () => {
  it("adds classes in target order, then their subgroups, then their sessions", async () => {
    const target = snap([cls("c1", "Math"), cls("c2", "Art")], [grp("g1", "c1", "Unit 1")], [ses("s1", "c1", "g1"), ses("s2", "c2")]);
    const { plan, after } = await planAndApply(snap(), target);
    expect(kinds(plan.ops)).toEqual(["add_class", "add_class", "add_group", "add_session", "add_session"]);
    expect(after.snapshot.classes.map((c) => c.id)).toEqual(["c1", "c2"]); // created in target order
  });

  it("updates only the fields that differ, in one operation per class", async () => {
    const remote = snap([cls("c1", "Math", "#111111"), cls("c2", "Art", "#222222"), cls("c3", "Bio", "#333333")]);
    const target = snap([cls("c1", "Maths", "#111111"), cls("c2", "Art", "#999999"), cls("c3", "Biology", "#888888")]);
    const { plan } = await planAndApply(remote, target);
    expect(plan.ops).toEqual([
      { op: "update_class", id: "c1", name: "Maths" },
      { op: "update_class", id: "c2", color: "#999999" },
      { op: "update_class", id: "c3", name: "Biology", color: "#888888" },
    ]);
  });

  it("a case-only rename of the same class is one operation", async () => {
    const { plan } = await planAndApply(snap([cls("c1", "Math")]), snap([cls("c1", "MATH")]));
    expect(plan.ops).toEqual([{ op: "update_class", id: "c1", name: "MATH" }]);
  });

  it("deletes a class with its subgroups and sessions in one operation, counting the sessions", async () => {
    const remote = snap(
      [cls("c1", "Math"), cls("c2", "Art")],
      [grp("g1", "c1", "Unit 1")],
      [ses("s1", "c1", "g1"), ses("s2", "c1"), ses("s3", "c2")],
    );
    const target = snap([cls("c2", "Art")], [], [ses("s3", "c2")]);
    const { plan, after } = await planAndApply(remote, target);
    expect(plan.ops).toEqual([{ op: "delete_class", id: "c1", expectedSessions: 2 }]);
    expect(after.snapshot.sessions.map((s) => s.id)).toEqual(["s3"]);
  });

  it("deletes a class that holds nothing", async () => {
    const { plan } = await planAndApply(snap([cls("c1", "Math"), cls("c2", "Art")]), snap([cls("c2", "Art")]));
    expect(plan.ops).toEqual([{ op: "delete_class", id: "c1", expectedSessions: 0 }]);
  });

  it("deletes every class at once", async () => {
    const remote = snap([cls("c1", "Math"), cls("c2", "Art")], [grp("g1", "c1", "U")], [ses("s1", "c1"), ses("s2", "c2")]);
    const { plan } = await planAndApply(remote, snap());
    expect(plan.ops).toEqual([
      { op: "delete_class", id: "c1", expectedSessions: 1 },
      { op: "delete_class", id: "c2", expectedSessions: 1 },
    ]);
  });
});

describe("subgroups", () => {
  const remote = () => snap([cls("c1", "Math"), cls("c2", "Art")], [grp("g1", "c1", "Unit 1"), grp("g2", "c1", "Unit 2")], [ses("s1", "c1", "g1")]);

  it("adds a subgroup", async () => {
    const target = remote();
    target.groups.push(grp("g3", "c2", "Sketching"));
    const { plan } = await planAndApply(remote(), target);
    expect(plan.ops).toEqual([{ op: "add_group", id: "g3", classId: "c2", name: "Sketching" }]);
  });

  it("renames a subgroup", async () => {
    const target = remote();
    target.groups[0] = grp("g1", "c1", "Chapter 1");
    const { plan } = await planAndApply(remote(), target);
    expect(plan.ops).toEqual([{ op: "rename_group", id: "g1", name: "Chapter 1" }]);
  });

  it("deleting a subgroup leaves its sessions with the class and needs no move (the server clears the subgroup)", async () => {
    const target = snap([cls("c1", "Math"), cls("c2", "Art")], [grp("g2", "c1", "Unit 2")], [ses("s1", "c1", null)]);
    const { plan, after } = await planAndApply(remote(), target);
    expect(plan.ops).toEqual([{ op: "delete_group", id: "g1" }]);
    expect(after.snapshot.sessions[0]).toMatchObject({ id: "s1", classId: "c1", groupId: null });
  });

  it("moves a session out of a subgroup to another subgroup BEFORE deleting the subgroup", async () => {
    const target = snap([cls("c1", "Math"), cls("c2", "Art")], [grp("g2", "c1", "Unit 2")], [ses("s1", "c1", "g2")]);
    const { plan } = await planAndApply(remote(), target);
    expect(plan.ops).toEqual([
      { op: "move_session", id: "s1", classId: "c1", groupId: "g2" },
      { op: "delete_group", id: "g1" },
    ]);
  });

  it("a subgroup that changes class is deleted and re-created with the same id, and its sessions are kept", async () => {
    const target = snap([cls("c1", "Math"), cls("c2", "Art")], [grp("g1", "c2", "Unit 1"), grp("g2", "c1", "Unit 2")], [ses("s1", "c2", "g1")]);
    const { plan, after } = await planAndApply(remote(), target);
    expect(kinds(plan.ops)).toEqual(["delete_group", "add_group", "move_session"]);
    expect(indexOfOp(plan.ops, "delete_group", "g1")).toBeLessThan(indexOfOp(plan.ops, "add_group", "g1"));
    expect(after.snapshot.sessions[0]).toMatchObject({ classId: "c2", groupId: "g1" });
  });

  it("re-creates a subgroup whose old class is deleted in the same plan", async () => {
    const target = snap([cls("c2", "Art")], [grp("g1", "c2", "Unit 1")], [ses("s1", "c2", "g1")]);
    const { plan } = await planAndApply(remote(), target);
    // The old subgroup has to go first (its id is reused), its session is kept and moved afterwards, then the class goes.
    expect(kinds(plan.ops)).toEqual(["delete_group", "add_group", "move_session", "delete_class"]);
    expect(plan.ops[3]).toEqual({ op: "delete_class", id: "c1", expectedSessions: 0 });
  });

  it("adds subgroups of one class in target order", async () => {
    const target = snap([cls("c1", "Math")], [grp("gb", "c1", "B"), grp("ga", "c1", "A"), grp("gc", "c1", "C")]);
    const { after } = await planAndApply(snap([cls("c1", "Math")]), target);
    expect(after.snapshot.groups.map((g) => g.id)).toEqual(["gb", "ga", "gc"]);
  });
});

describe("sessions", () => {
  it("adds new sessions after the class and subgroup they need", async () => {
    const target = snap([cls("c1", "Math")], [grp("g1", "c1", "U")], [ses("s1", "c1", "g1", 1_700_000_000_123, 1500, "countdown"), ses("s2", "c1")]);
    const { plan, after } = await planAndApply(snap(), target);
    expect(kinds(plan.ops)).toEqual(["add_class", "add_group", "add_session", "add_session"]);
    expect(after.snapshot.sessions.find((s) => s.id === "s1")).toMatchObject({ startedAt: 1_700_000_000_123, seconds: 1500, mode: "countdown" });
  });

  it("moves a session to another class, to a subgroup, and to no subgroup", async () => {
    const remote = snap([cls("c1", "Math"), cls("c2", "Art")], [grp("g1", "c1", "U"), grp("g2", "c2", "V")], [ses("s1", "c1", "g1"), ses("s2", "c1"), ses("s3", "c2", "g2")]);
    const target = snap(remote.classes, remote.groups, [ses("s1", "c2", "g2"), ses("s2", "c1", "g1"), ses("s3", "c2", null)]);
    const { plan } = await planAndApply(remote, target);
    expect(kinds(plan.ops)).toEqual(["move_session", "move_session", "move_session"]);
  });

  it("moves a session into a subgroup that is added in the same plan, after that subgroup", async () => {
    const remote = snap([cls("c1", "Math")], [], [ses("s1", "c1")]);
    const target = snap([cls("c1", "Math")], [grp("g1", "c1", "U")], [ses("s1", "c1", "g1")]);
    const { plan } = await planAndApply(remote, target);
    expect(kinds(plan.ops)).toEqual(["add_group", "move_session"]);
  });

  it("moves sessions into a class added in the same plan, after it", async () => {
    const remote = snap([cls("c1", "Math")], [], [ses("s1", "c1")]);
    const target = snap([cls("c1", "Math"), cls("c2", "Art")], [], [ses("s1", "c2")]);
    const { plan } = await planAndApply(remote, target);
    expect(kinds(plan.ops)).toEqual(["add_class", "move_session"]);
  });
});

describe("moving before deleting, and expectedSessions", () => {
  it("moves a session out of a class BEFORE deleting the class", async () => {
    const remote = snap([cls("c1", "Math"), cls("c2", "Art")], [], [ses("s1", "c1")]);
    const target = snap([cls("c2", "Art")], [], [ses("s1", "c2")]);
    const { plan, after } = await planAndApply(remote, target);
    expect(plan.ops).toEqual([
      { op: "move_session", id: "s1", classId: "c2", groupId: null },
      { op: "delete_class", id: "c1", expectedSessions: 0 },
    ]);
    expect(after.snapshot.sessions.map((s) => s.id)).toEqual(["s1"]);
  });

  it("expectedSessions counts what is left after the moves earlier in the plan", async () => {
    const remote = snap(
      [cls("c1", "Math"), cls("c2", "Art")],
      [],
      [ses("s1", "c1"), ses("s2", "c1"), ses("s3", "c1"), ses("s4", "c2")],
    );
    // s1 and s2 survive in c2; s3 disappears with its class.
    const target = snap([cls("c2", "Art")], [], [ses("s1", "c2"), ses("s2", "c2"), ses("s4", "c2")]);
    const { plan } = await planAndApply(remote, target);
    expect(kinds(plan.ops)).toEqual(["move_session", "move_session", "delete_class"]);
    expect(plan.ops[2]).toEqual({ op: "delete_class", id: "c1", expectedSessions: 1 });
  });

  it("expectedSessions stays correct when the moves and the delete land in different batches", async () => {
    const remote = snap([cls("c1", "Math"), cls("c2", "Art")], [], [ses("s1", "c1"), ses("s2", "c1"), ses("s3", "c1")]);
    const target = snap([cls("c2", "Art")], [], [ses("s1", "c2"), ses("s2", "c2")]);
    const { plan } = await planAndApply(remote, target, { maxChanges: 2 });
    expect(plan.batches.map((b) => b.length)).toEqual([2, 1]);
    expect(plan.batches[1][0]).toEqual({ op: "delete_class", id: "c1", expectedSessions: 1 });
  });

  it("a class is never deleted while a session that must survive is still in it", async () => {
    const remote = snap([cls("c1", "Math"), cls("c2", "Art")], [], [ses("s1", "c1"), ses("s2", "c1")]);
    const target = snap([cls("c2", "Art")], [], [ses("s1", "c2"), ses("s2", "c2")]);
    const { plan } = await planAndApply(remote, target);
    const del = indexOfOp(plan.ops, "delete_class", "c1");
    for (const id of ["s1", "s2"]) expect(indexOfOp(plan.ops, "move_session", id)).toBeLessThan(del);
    expect((plan.ops[del] as { expectedSessions: number }).expectedSessions).toBe(0);
  });

  it("sessions moved into a class that is added in the same plan: add, move, then delete", async () => {
    const remote = snap([cls("c1", "Math")], [], [ses("s1", "c1")]);
    const target = snap([cls("c9", "Other")], [], [ses("s1", "c9")]);
    const { plan } = await planAndApply(remote, target);
    expect(kinds(plan.ops)).toEqual(["add_class", "move_session", "delete_class"]);
  });
});

describe("reusing names", () => {
  it("deletes a class first when its name is wanted by a new class and nothing has to move out of it", async () => {
    const { plan } = await planAndApply(snap([cls("c1", "Math")]), snap([cls("c2", "Math")]));
    expect(kinds(plan.ops)).toEqual(["delete_class", "add_class"]);
  });

  it("frees a name with a temporary rename when the deleted class's sessions can only move to the new class", async () => {
    const remote = snap([cls("c1", "Math")], [], [ses("s1", "c1")]);
    const target = snap([cls("c2", "Math")], [], [ses("s1", "c2")]);
    const { plan, after } = await planAndApply(remote, target);
    expect(kinds(plan.ops)).toEqual(["update_class", "add_class", "move_session", "delete_class"]);
    expect(plan.ops[0]).toMatchObject({ id: "c1" });
    expect(isTemp((plan.ops[0] as { name?: string }).name)).toBe(true);
    expect(after.snapshot.classes).toEqual([cls("c2", "Math")]);
  });

  it("reuses a subgroup name: the old subgroup goes first (its sessions are kept and moved afterwards)", async () => {
    const remote = snap([cls("c1", "Math")], [grp("g1", "c1", "Unit")], [ses("s1", "c1", "g1")]);
    const target = snap([cls("c1", "Math")], [grp("g2", "c1", "Unit")], [ses("s1", "c1", "g2")]);
    const { plan } = await planAndApply(remote, target);
    expect(kinds(plan.ops)).toEqual(["delete_group", "add_group", "move_session"]);
  });

  it("a renamed class frees its old name for a new class, in that order", async () => {
    const remote = snap([cls("c1", "Math")]);
    const target = snap([cls("c1", "Algebra"), cls("c2", "Math")]);
    const { plan } = await planAndApply(remote, target);
    expect(plan.ops).toEqual([
      { op: "update_class", id: "c1", name: "Algebra" },
      { op: "add_class", id: "c2", name: "Math", color: "#3b82f6" },
    ]);
  });

  it("a name that differs only by capitals still counts as taken", async () => {
    const remote = snap([cls("c1", "math")]);
    const target = snap([cls("c1", "Algebra"), cls("c2", "MATH")]);
    const { plan } = await planAndApply(remote, target);
    expect(indexOfOp(plan.ops, "update_class", "c1")).toBeLessThan(indexOfOp(plan.ops, "add_class", "c2"));
  });

  it("new classes are still created in target order when an earlier one has to wait for a name", async () => {
    const remote = snap([cls("c1", "X")], [], [ses("s1", "c1")]);
    const target = snap([cls("n1", "X"), cls("n2", "Y")], [], [ses("s1", "n1")]);
    const { plan, after } = await planAndApply(remote, target);
    expect(indexOfOp(plan.ops, "add_class", "n1")).toBeLessThan(indexOfOp(plan.ops, "add_class", "n2"));
    expect(after.snapshot.classes.map((c) => c.id)).toEqual(["n1", "n2"]);
  });
});

describe("rename swaps and cycles", () => {
  it("swaps two class names with one temporary rename (3 operations)", async () => {
    const remote = snap([cls("a", "X"), cls("b", "Y")]);
    const target = snap([cls("a", "Y"), cls("b", "X")]);
    const { plan } = await planAndApply(remote, target);
    expect(plan.ops).toHaveLength(3);
    expect(kinds(plan.ops)).toEqual(["update_class", "update_class", "update_class"]);
    expect(isTemp((plan.ops[0] as { name?: string }).name)).toBe(true);
    // No class ends under a temporary name.
    expect(plan.ops.filter((o) => isTemp((o as { name?: string }).name))).toHaveLength(1);
  });

  it.each([3, 4, 5, 8])("rotates the names of %d classes through one temporary name", async (n) => {
    const names = Array.from({ length: n }, (_, i) => `Name ${i}`);
    const remote = snap(names.map((name, i) => cls(`c${i}`, name)));
    const target = snap(names.map((_, i) => cls(`c${i}`, names[(i + 1) % n])));
    const { plan } = await planAndApply(remote, target);
    expect(plan.ops).toHaveLength(n + 1);
  });

  it("swaps two subgroup names inside a class", async () => {
    const remote = snap([cls("c1", "Math")], [grp("g1", "c1", "A"), grp("g2", "c1", "B")]);
    const target = snap([cls("c1", "Math")], [grp("g1", "c1", "B"), grp("g2", "c1", "A")]);
    const { plan } = await planAndApply(remote, target);
    expect(kinds(plan.ops)).toEqual(["rename_group", "rename_group", "rename_group"]);
  });

  it("rotates the names of subgroups in two classes independently", async () => {
    const remote = snap(
      [cls("c1", "Math"), cls("c2", "Art")],
      [grp("a1", "c1", "A"), grp("a2", "c1", "B"), grp("a3", "c1", "C"), grp("b1", "c2", "A"), grp("b2", "c2", "B")],
    );
    const target = snap(remote.classes, [grp("a1", "c1", "B"), grp("a2", "c1", "C"), grp("a3", "c1", "A"), grp("b1", "c2", "B"), grp("b2", "c2", "A")]);
    const { plan } = await planAndApply(remote, target);
    expect(plan.ops).toHaveLength(4 + 3);
  });

  it("a swap carries the color changes inside the same operations", async () => {
    const remote = snap([cls("a", "X", "#111111"), cls("b", "Y", "#222222")]);
    const target = snap([cls("a", "Y", "#aaaaaa"), cls("b", "X", "#bbbbbb")]);
    const { plan, after } = await planAndApply(remote, target);
    expect(plan.ops).toHaveLength(3);
    expect(after.snapshot.classes.find((c) => c.id === "a")).toEqual(cls("a", "Y", "#aaaaaa"));
  });

  it("a swap and a new class that takes one of the names", async () => {
    const remote = snap([cls("a", "X"), cls("b", "Y")]);
    const target = snap([cls("a", "Y"), cls("b", "Z"), cls("c", "X")]);
    await planAndApply(remote, target);
  });

  it("a swap of names that differ only by capitals", async () => {
    const remote = snap([cls("a", "Math"), cls("b", "math2")]);
    const target = snap([cls("a", "MATH2"), cls("b", "MATH")]);
    await planAndApply(remote, target);
  });
});

describe("temporary names never collide", () => {
  it("skips a temporary name that is already used by a class", async () => {
    const remote = snap([cls("a", "~sync-1"), cls("b", "~sync-2")]);
    const target = snap([cls("a", "~sync-2"), cls("b", "~sync-1")]);
    const { plan } = await planAndApply(remote, target);
    const temp = (plan.ops[0] as { name: string }).name;
    expect(temp).toBe("~sync-3");
  });

  it("also avoids names that only a target class or a subgroup will use, and ones that differ only by capitals", async () => {
    const remote = snap([cls("a", "X"), cls("b", "Y"), cls("c", "Z")], [grp("g1", "a", "~sync-2"), grp("g2", "a", "~SYNC-3")]);
    const target = snap(
      [cls("a", "Y"), cls("b", "X"), cls("c", "~Sync-1")],
      [grp("g1", "a", "~sync-2"), grp("g2", "a", "~SYNC-3")],
    );
    const { plan } = await planAndApply(remote, target);
    const temps = plan.ops.map((o) => (o as { name?: string }).name).filter(isTemp);
    expect(temps).toEqual(["~sync-4"]);
  });

  it("uses a different temporary name for each cycle in the same plan", async () => {
    const remote = snap([cls("a", "A"), cls("b", "B"), cls("c", "C"), cls("d", "D")]);
    const target = snap([cls("a", "B"), cls("b", "A"), cls("c", "D"), cls("d", "C")]);
    const { plan } = await planAndApply(remote, target);
    const temps = plan.ops.map((o) => (o as { name?: string }).name).filter(isTemp);
    expect(temps).toHaveLength(2);
    expect(new Set(temps).size).toBe(2);
  });
});

describe("transitions that are refused (nothing is dropped or invented)", () => {
  const base = () => snap([cls("c1", "Math")], [grp("g1", "c1", "U")], [ses("s1", "c1", "g1")]);

  it("refuses a remote snapshot that is not valid", () => {
    const bad = snap([cls("c1", "Math")], [], [ses("s1", "gone")]);
    const r = diffToOps(bad, snap());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("invalid_remote");
      expect(r.error.issues?.[0].code).toBe("session_class_missing");
    }
  });

  it("refuses a target snapshot that is not valid", () => {
    for (const bad of [
      snap([cls("c1", "Math"), cls("c2", "math")]),
      snap([cls("c1", "Math")], [grp("g1", "gone", "U")]),
      snap([cls("c1", "Math", "blue")]),
      snap([cls("c1", "Math")], [], [ses("s1", "c1", "nope")]),
    ]) {
      const r = diffToOps(base(), bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_target");
    }
  });

  it("refuses a session whose start time, duration or mode differs", () => {
    for (const changed of [ses("s1", "c1", "g1", 1), ses("s1", "c1", "g1", 1_700_000_000_000, 61), ses("s1", "c1", "g1", 1_700_000_000_000, 60, "countdown")]) {
      const r = diffToOps(base(), snap(base().classes, base().groups, [changed]));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("session_data_changed");
        expect(r.error.ids).toEqual(["s1"]);
      }
    }
  });

  it("refuses to drop a session whose class stays (no operation deletes a single session)", () => {
    const r = diffToOps(base(), snap(base().classes, base().groups, []));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("session_removal_unsupported");
      expect(r.error.ids).toEqual(["s1"]);
    }
  });

  it("allows a session to disappear together with its class", () => {
    expect(diffToOps(base(), snap()).ok).toBe(true);
  });

  it("refuses unusable options", () => {
    for (const options of [{ maxChanges: 0 }, { maxChanges: 1.5 }, { maxChanges: 5001 }, { maxBytes: 1 }, { maxBytes: 4_000_001 }, { maxBytes: 2.5 }]) {
      const r = diffToOps(snap(), snap(), options);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_options");
    }
  });

  it("does not mutate either snapshot", () => {
    const remote = deepFreeze(snap([cls("a", "X"), cls("b", "Y")], [grp("g", "a", "U")], [ses("s", "a", "g")]));
    const target = deepFreeze(snap([cls("a", "Y"), cls("b", "X")], [], [ses("s", "b")]));
    const before = JSON.stringify([remote, target]);
    expect(diffToOps(remote, target).ok).toBe(true);
    expect(JSON.stringify([remote, target])).toBe(before);
  });
});

describe("batches: operation count and request size", () => {
  const manySessions = (n: number) => Array.from({ length: n }, (_, i) => ses(`s${i}`, "c1", null, 1_700_000_000_000 + i));

  it("uses the server's limits by default", () => {
    expect(PUSH_LIMITS.maxChanges).toBe(5000);
    expect(DEFAULT_BATCH_BYTES).toBeLessThan(PUSH_LIMITS.maxBytes);
  });

  it("splits more than 5,000 operations into batches of at most 5,000 and applies them all", async () => {
    const target = snap([cls("c1", "Big")], [], manySessions(12_344));
    const { plan, after } = await planAndApply(snap(), target);
    expect(plan.ops).toHaveLength(12_345);
    expect(plan.batches.map((b) => b.length)).toEqual([5000, 5000, 2345]);
    expect(plan.batches.flat()).toEqual(plan.ops);
    expect(after.snapshot.sessions).toHaveLength(12_344);
  }, 60_000);

  it("exactly 5,000 operations is one batch and 5,001 is two", () => {
    const one = planOk(diffToOps(snap(), snap([cls("c1", "Big")], [], manySessions(4999))));
    expect(one.ops).toHaveLength(5000);
    expect(one.batches).toHaveLength(1);
    const two = planOk(diffToOps(snap(), snap([cls("c1", "Big")], [], manySessions(5000))));
    expect(two.batches.map((b) => b.length)).toEqual([5000, 1]);
  });

  it("honors a smaller maxChanges", async () => {
    const target = snap([cls("c1", "Big")], [], manySessions(20));
    const { plan } = await planAndApply(snap(), target, { maxChanges: 7 });
    expect(plan.batches.map((b) => b.length)).toEqual([7, 7, 7]);
  });

  it("cuts exactly at the byte budget: the exact size fits, one byte less does not", () => {
    const target = snap([cls("c1", "Big")], [], manySessions(9));
    const ops = planOk(diffToOps(snap(), target)).ops;
    const sizeOf = (n: number) => JSON.stringify(ops.slice(0, n)).length;
    const exact = planOk(diffToOps(snap(), target, { maxBytes: sizeOf(4) }));
    expect(exact.batches[0]).toHaveLength(4);
    const oneLess = planOk(diffToOps(snap(), target, { maxBytes: sizeOf(4) - 1 }));
    expect(oneLess.batches[0]).toHaveLength(3);
    for (const plan of [exact, oneLess]) {
      for (const b of plan.batches) expect(JSON.stringify(b).length).toBeLessThanOrEqual(plan === exact ? sizeOf(4) : sizeOf(4) - 1);
      expect(plan.batches.flat()).toEqual(ops);
    }
  });

  it("measures bytes, not characters: multi-byte names fill a batch faster", () => {
    const names = Array.from({ length: 6 }, (_, i) => cls(`c${i}`, `${"é".repeat(40)}${i}`));
    const target = snap(names);
    const budget = 600;
    const plan = planOk(diffToOps(snap(), target, { maxBytes: budget }));
    const encoder = new TextEncoder();
    for (const b of plan.batches) expect(encoder.encode(JSON.stringify(b)).length).toBeLessThanOrEqual(budget);
    expect(plan.batches.length).toBeGreaterThan(1);
    expect(plan.batches.flat()).toEqual(plan.ops);
  });

  it("refuses when one operation alone does not fit", () => {
    const r = diffToOps(snap(), snap([cls("c1", "Math")]), { maxBytes: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("op_too_large");
  });

  it("every batch is accepted by the fake server whatever the size limit", async () => {
    const target = snap([cls("c1", "Big"), cls("c2", "Other")], [grp("g1", "c1", "U")], manySessions(40).map((s, i) => ({ ...s, classId: i % 2 ? "c2" : "c1" })));
    for (const maxBytes of [200, 333, 1000, 5000]) await planAndApply(snap(), target, { maxBytes });
  });
});

describe("batch boundaries respect the server's class and session caps", () => {
  const thousandClasses = () => Array.from({ length: 1000 }, (_, i) => cls(`c${i}`, `Class ${i}`));

  it("replacing a class at the 1,000-class limit is one valid push (the cap is checked at the end of a push)", async () => {
    const remote = snap(thousandClasses(), [], [ses("s0", "c0")]);
    const target = snap([...thousandClasses().slice(1), cls("n", "New")], [], [ses("s0", "n")]);
    const { plan } = await planAndApply(remote, target);
    expect(kinds(plan.ops)).toEqual(["add_class", "move_session", "delete_class"]);
    expect(plan.batches).toHaveLength(1);
  }, 60_000);

  it("refuses to cut that plan where the account would be over the limit", () => {
    const remote = snap(thousandClasses(), [], [ses("s0", "c0")]);
    const target = snap([...thousandClasses().slice(1), cls("n", "New")], [], [ses("s0", "n")]);
    for (const maxChanges of [1, 2]) {
      const r = diffToOps(remote, target, { maxChanges });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("no_safe_chunk_boundary");
    }
    expect(diffToOps(remote, target, { maxChanges: 3 }).ok).toBe(true);
  });

  it("backs a cut off to the latest safe point instead of ending a batch at 1,001 classes", async () => {
    const remote = snap(thousandClasses(), [], [ses("s0", "c0")]);
    const classes = thousandClasses().slice(1);
    classes[0] = { ...classes[0], color: "#abcdef" }; // an unrelated update that runs first and is safe to end on
    const target = snap([...classes, cls("n", "New")], [], [ses("s0", "n")]);
    const { plan } = await planAndApply(remote, target, { maxChanges: 3 });
    expect(plan.batches.map((b) => b.length)).toEqual([1, 3]);
  }, 60_000);

  it("never exceeds 1,000 subgroups in a class: the old one is deleted before the new one is added", async () => {
    const groups = Array.from({ length: 1000 }, (_, i) => grp(`g${i}`, "c1", `Group ${i}`));
    const remote = snap([cls("c1", "Big")], groups);
    const target = snap([cls("c1", "Big")], [...groups.slice(1), grp("gNew", "c1", "Replacement")]);
    const { plan } = await planAndApply(remote, target);
    expect(plan.ops).toEqual([
      { op: "delete_group", id: "g0" },
      { op: "add_group", id: "gNew", classId: "c1", name: "Replacement" },
    ]);
  }, 60_000);
});

describe("deterministic output", () => {
  const remote = () => snap(
    [cls("a", "X"), cls("b", "Y"), cls("d", "Doomed")],
    [grp("g1", "a", "U"), grp("g2", "a", "V")],
    [ses("s1", "a", "g1"), ses("s2", "d"), ses("s3", "b")],
  );
  const target = () => snap(
    [cls("a", "Y"), cls("b", "X"), cls("n", "Doomed")],
    [grp("g1", "a", "V"), grp("g2", "a", "U"), grp("g3", "n", "W")],
    [ses("s1", "a", "g2"), ses("s2", "n", "g3"), ses("s3", "b")],
  );

  it("the same inputs always give the same plan", () => {
    const first = planOk(diffToOps(remote(), target()));
    for (let i = 0; i < 5; i++) expect(planOk(diffToOps(remote(), target()))).toEqual(first);
    expect(JSON.stringify(planOk(diffToOps(remote(), target())))).toBe(JSON.stringify(first));
  });

  it("is also applied correctly", async () => {
    await planAndApply(remote(), target());
  });
});

describe("large plans", () => {
  it("plans moving 100,000 sessions between classes quickly and in valid batches", () => {
    const n = 100_000;
    const remote = snap([cls("a", "A"), cls("b", "B")], [], Array.from({ length: n }, (_, i) => ses(`s${i}`, "a", null, i)));
    const target = snap(remote.classes, [], remote.sessions.map((s) => ({ ...s, classId: "b" })));
    const started = Date.now();
    const plan = planOk(diffToOps(remote, target));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(plan.ops).toHaveLength(n);
    expect(plan.batches).toHaveLength(20);
    expect(plan.batches.every((b) => b.length <= 5000)).toBe(true);
  }, 30_000);
});
