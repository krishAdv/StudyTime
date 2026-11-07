import { describe, expect, it } from "vitest";
import { checkSyncEligibility } from "@/lib/sync/eligibility";
import { fromRevisionedSnapshot, fromSyncSnapshot } from "@/lib/sync/from-snapshot";
import { toSyncSnapshot, type SyncSnapshot } from "@/lib/sync/snapshot";
import type { StoredData } from "@/lib/storage";

const deepFreeze = <T>(v: T): T => {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v)) deepFreeze(child);
  }
  return v;
};

const flat = (): SyncSnapshot => ({
  classes: [
    { id: "c1", name: "Math", color: "#3b82f6" },
    { id: "c2", name: "Art", color: "#8b5cf6" },
    { id: "c3", name: "History", color: "#f59e0b" },
  ],
  // Interleaved across classes, the way the server returns them (creation order).
  groups: [
    { id: "g1", classId: "c1", name: "Unit 1" },
    { id: "g4", classId: "c3", name: "Rome" },
    { id: "g2", classId: "c1", name: "Unit 2" },
    { id: "g3", classId: "c2", name: "Sketching" },
  ],
  sessions: [
    { id: "s1", classId: "c1", groupId: "g1", startedAt: 1_700_000_000_123, seconds: 1500, mode: "stopwatch" },
    { id: "s2", classId: "c2", groupId: null, startedAt: 1_700_000_500_000, seconds: 90, mode: "countdown" },
  ],
});

const nested = (): StoredData => ({
  classes: [
    { id: "c1", name: "Math", color: "#3b82f6", groups: [{ id: "g1", name: "Unit 1" }, { id: "g2", name: "Unit 2" }] },
    { id: "c2", name: "Art", color: "#8b5cf6", groups: [{ id: "g3", name: "Sketching" }] },
    { id: "c3", name: "History", color: "#f59e0b", groups: [{ id: "g4", name: "Rome" }] },
  ],
  sessions: flat().sessions,
});

function okData(r: ReturnType<typeof fromSyncSnapshot>): StoredData {
  if (!r.ok) throw new Error("expected a successful conversion: " + JSON.stringify(r.issues));
  return r.data;
}

describe("fromSyncSnapshot: nesting", () => {
  it("nests each subgroup under its class, keeping class order and each class's subgroup order", () => {
    expect(okData(fromSyncSnapshot(flat()))).toEqual(nested());
  });

  it("keeps classes that have no subgroups", () => {
    // No subgroups at all, so no session may point at one either.
    const sessions = flat().sessions.map((s) => ({ ...s, groupId: null }));
    const data = okData(fromSyncSnapshot({ ...flat(), groups: [], sessions }));
    expect(data.classes.map((c) => [c.id, c.groups.length])).toEqual([["c1", 0], ["c2", 0], ["c3", 0]]);
  });

  it("preserves every id and relationship and generates none", () => {
    const snap = flat();
    const data = okData(fromSyncSnapshot(snap));
    expect(data.classes.map((c) => c.id)).toEqual(snap.classes.map((c) => c.id));
    expect(data.classes.flatMap((c) => c.groups.map((g) => g.id)).sort()).toEqual(snap.groups.map((g) => g.id).sort());
    expect(data.sessions).toEqual(snap.sessions);
    for (const g of snap.groups) {
      const owner = data.classes.find((c) => c.groups.some((x) => x.id === g.id));
      expect(owner?.id).toBe(g.classId);
    }
  });

  it("keeps session order and values, including a null subgroup and millisecond precision", () => {
    const data = okData(fromSyncSnapshot(flat()));
    expect(data.sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(data.sessions[0].startedAt).toBe(1_700_000_000_123);
    expect(data.sessions[1].groupId).toBeNull();
  });

  it("handles an empty snapshot", () => {
    expect(okData(fromSyncSnapshot({ classes: [], groups: [], sessions: [] }))).toEqual({ classes: [], sessions: [] });
  });

  it("does not mutate its input and shares no objects with it", () => {
    const snap = deepFreeze(flat());
    const before = JSON.stringify(snap);
    const data = okData(fromSyncSnapshot(snap));
    expect(JSON.stringify(snap)).toBe(before);
    snap.classes.forEach((c, i) => expect(data.classes[i]).not.toBe(c));
    snap.sessions.forEach((s, i) => expect(data.sessions[i]).not.toBe(s));
    data.classes[0].name = "Changed";
    data.classes[0].groups[0].name = "Changed";
    data.sessions[0].seconds = 1;
    expect(snap.classes[0].name).toBe("Math");
    expect(snap.groups[0].name).toBe("Unit 1");
    expect(snap.sessions[0].seconds).toBe(1500);
  });
});

describe("fromSyncSnapshot: validation (nothing is repaired or dropped)", () => {
  it("rejects a subgroup whose class is not in the snapshot, and returns no partial data", () => {
    const snap = flat();
    snap.groups.push({ id: "g9", classId: "gone", name: "Orphan" });
    const r = fromSyncSnapshot(snap);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0]).toMatchObject({ code: "group_class_missing", entity: "group", id: "g9", classId: "gone", position: 5, field: "classId" });
      expect(r.issues[0].message.length).toBeGreaterThan(10);
      expect("data" in r).toBe(false);
    }
  });

  it("applies the same rules as the upload check: names, colors, ids and session relationships", () => {
    const snap = flat();
    snap.classes[0].color = "blue";
    snap.classes[1].name = " art ";
    snap.sessions[0] = { ...snap.sessions[0], classId: "gone", groupId: null };
    const r = fromSyncSnapshot(snap);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.map((i) => i.code)).toEqual(["invalid_color", "name_not_normalized", "session_class_missing"]);
    }
  });

  it("does not trim or fix a name: the damaged name is reported as it came", () => {
    const snap = flat();
    snap.classes[0].name = "  Math  ";
    const r = fromSyncSnapshot(snap);
    expect(r.ok).toBe(false);
    expect(snap.classes[0].name).toBe("  Math  ");
  });

  it("reports duplicate ids (a repeated class id still gets its subgroups attached once)", () => {
    const snap = flat();
    snap.classes.push({ id: "c1", name: "Math again", color: "#000000" });
    const r = fromSyncSnapshot(snap);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.code)).toContain("duplicate_class_id");
  });

  it("reports a subgroup used by a session of another class", () => {
    const snap = flat();
    snap.sessions[1] = { ...snap.sessions[1], groupId: "g1" }; // g1 belongs to c1, the session is in c2
    const r = fromSyncSnapshot(snap);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.code)).toEqual(["session_group_wrong_class"]);
  });

  it("combines structural and rule problems, in that order, and counts them all", () => {
    const snap = flat();
    snap.groups.push({ id: "g9", classId: "gone", name: "Orphan" });
    snap.classes[0].color = "blue";
    const r = fromSyncSnapshot(snap);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.map((i) => i.code)).toEqual(["group_class_missing", "invalid_color"]);
      expect(r.totalIssues).toBe(2);
      expect(r.truncated).toBe(false);
    }
  });

  it("truncates a long issue list but counts every problem", () => {
    const snap: SyncSnapshot = {
      classes: [{ id: "c", name: "C", color: "#000000" }],
      groups: [],
      sessions: Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, classId: "c", groupId: null, startedAt: -1, seconds: 1, mode: "stopwatch" as const })),
    };
    const r = fromSyncSnapshot(snap, { maxIssues: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toHaveLength(3);
      expect(r.totalIssues).toBe(50);
      expect(r.truncated).toBe(true);
    }
  });

  it("reports a damaged shape instead of crashing", () => {
    for (const bad of [null, {}, { classes: [], groups: [] }, { classes: {}, groups: [], sessions: [] }, { classes: [], groups: "x", sessions: [] }]) {
      const r = fromSyncSnapshot(bad as unknown as SyncSnapshot);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues[0]).toMatchObject({ code: "invalid_data", entity: "data" });
    }
  });
});

describe("round trips", () => {
  const fixtures: [string, StoredData][] = [
    ["empty", { classes: [], sessions: [] }],
    ["the sample data", nested()],
    ["a class with no subgroups and no sessions", { classes: [{ id: "only", name: "Only", color: "#000000", groups: [] }], sessions: [] }],
    [
      "unicode names, 60-character names and 100-character ids",
      {
        classes: [
          { id: "😀".repeat(100), name: "😀".repeat(60), color: "#ABCDEF", groups: [{ id: "g".repeat(100), name: "Ünïcode ß" }] },
        ],
        sessions: [{ id: "s".repeat(100), classId: "😀".repeat(100), groupId: "g".repeat(100), startedAt: 253_402_300_799_999, seconds: 31_622_400, mode: "countdown" }],
      },
    ],
    [
      "many classes, subgroups and sessions",
      {
        classes: Array.from({ length: 40 }, (_, i) => ({
          id: `c${i}`, name: `Class ${i}`, color: "#123456",
          groups: Array.from({ length: i % 5 }, (_, j) => ({ id: `g${i}-${j}`, name: `Group ${j}` })),
        })),
        sessions: Array.from({ length: 300 }, (_, i) => ({
          id: `s${i}`, classId: `c${i % 40}`, groupId: i % 40 % 5 > 0 && i % 3 === 0 ? `g${i % 40}-0` : null,
          startedAt: 1_700_000_000_000 + i, seconds: 1 + i, mode: i % 2 ? ("stopwatch" as const) : ("countdown" as const),
        })),
      },
    ],
  ];

  it.each(fixtures)("local -> server -> local gives back the same data (%s)", (_name, data) => {
    expect(checkSyncEligibility(data).ok).toBe(true);
    const back = fromSyncSnapshot(toSyncSnapshot(data));
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.data).toEqual(data);
  });

  it("server -> local -> server keeps everything, regrouping subgroups by class", () => {
    const original = flat();
    const again = toSyncSnapshot(okData(fromSyncSnapshot(original)));
    expect(again.classes).toEqual(original.classes);
    expect(again.sessions).toEqual(original.sessions);
    // Same subgroups; the interleaved flat order becomes class order, with each class's own order kept.
    expect([...again.groups].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...original.groups].sort((a, b) => a.id.localeCompare(b.id)));
    expect(again.groups.filter((g) => g.classId === "c1").map((g) => g.id)).toEqual(["g1", "g2"]);
  });

  it("a flat snapshot already in class order survives server -> local -> server exactly", () => {
    const grouped = { ...flat(), groups: toSyncSnapshot(nested()).groups };
    expect(toSyncSnapshot(okData(fromSyncSnapshot(grouped)))).toEqual(grouped);
  });
});

describe("revision handling", () => {
  it("fromSyncSnapshot takes and returns data only: a revision is never part of it", () => {
    const data = okData(fromSyncSnapshot(flat()));
    expect(Object.keys(data).sort()).toEqual(["classes", "sessions"]);
    expect(JSON.stringify(data)).not.toContain("revision");
  });

  it("fromRevisionedSnapshot carries the revision through beside the data, unchanged", () => {
    const r = fromRevisionedSnapshot({ revision: 42, snapshot: flat() });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.revision).toBe(42);
      expect(r.data).toEqual(nested());
      expect(JSON.stringify(r.data)).not.toContain("revision");
    }
  });

  it.each([0, 1, Number.MAX_SAFE_INTEGER])("accepts the revision %d", (revision) => {
    const r = fromRevisionedSnapshot({ revision, snapshot: { classes: [], groups: [], sessions: [] } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.revision).toBe(revision);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", null, undefined])("rejects the revision %j", (revision) => {
    const r = fromRevisionedSnapshot({ revision: revision as number, snapshot: flat() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]).toMatchObject({ code: "invalid_revision", entity: "data" });
  });

  it("an invalid snapshot fails the revisioned conversion too, without a revision or data", () => {
    const snap = flat();
    snap.classes[0].color = "blue";
    const r = fromRevisionedSnapshot({ revision: 5, snapshot: snap });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues[0].code).toBe("invalid_color");
      expect("data" in r).toBe(false);
      expect("revision" in r).toBe(false);
    }
  });
});
