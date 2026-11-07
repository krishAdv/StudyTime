import { describe, expect, it } from "vitest";
import { toSyncSnapshot, type RevisionedSnapshot } from "@/lib/sync/snapshot";
import type { StoredData } from "@/lib/storage";

const deepFreeze = <T>(v: T): T => {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v)) deepFreeze(child);
  }
  return v;
};

const sample = (): StoredData => ({
  classes: [
    {
      id: "class-a",
      name: "Math",
      color: "#3b82f6",
      groups: [
        { id: "group-a1", name: "Unit 1" },
        { id: "group-a2", name: "Unit 2" },
      ],
    },
    { id: "class-b", name: "Art", color: "#8b5cf6", groups: [] },
    { id: "class-c", name: "History", color: "#f59e0b", groups: [{ id: "group-c1", name: "Rome" }] },
  ],
  sessions: [
    { id: "s-3", classId: "class-c", groupId: "group-c1", startedAt: 1_700_000_300_000, seconds: 90, mode: "stopwatch" },
    { id: "s-2", classId: "class-b", groupId: null, startedAt: 1_700_000_200_000, seconds: 600, mode: "countdown" },
    { id: "s-1", classId: "class-a", groupId: "group-a2", startedAt: 1_700_000_100_123, seconds: 1500, mode: "stopwatch" },
  ],
});

describe("toSyncSnapshot", () => {
  it("returns the server's flat shape: classes, groups and sessions, and nothing else", () => {
    const snap = toSyncSnapshot(sample());
    expect(Object.keys(snap).sort()).toEqual(["classes", "groups", "sessions"]);
    expect(snap.classes[0]).toEqual({ id: "class-a", name: "Math", color: "#3b82f6" });
    expect(Object.keys(snap.groups[0]).sort()).toEqual(["classId", "id", "name"]);
    expect(Object.keys(snap.sessions[0]).sort()).toEqual(["classId", "groupId", "id", "mode", "seconds", "startedAt"]);
  });

  it("flattens nested subgroups in class order, then subgroup order, each pointing at its class", () => {
    expect(toSyncSnapshot(sample()).groups).toEqual([
      { id: "group-a1", classId: "class-a", name: "Unit 1" },
      { id: "group-a2", classId: "class-a", name: "Unit 2" },
      { id: "group-c1", classId: "class-c", name: "Rome" },
    ]);
  });

  it("keeps every class, including those with no subgroups, in order", () => {
    expect(toSyncSnapshot(sample()).classes.map((c) => c.id)).toEqual(["class-a", "class-b", "class-c"]);
  });

  it("preserves every id and relationship exactly, and generates no ids", () => {
    const data = sample();
    const snap = toSyncSnapshot(data);
    expect(snap.classes.map((c) => c.id)).toEqual(data.classes.map((c) => c.id));
    expect(snap.groups.map((g) => g.id)).toEqual(data.classes.flatMap((c) => c.groups.map((g) => g.id)));
    expect(snap.sessions.map((s) => s.id)).toEqual(data.sessions.map((s) => s.id));
    // Each session keeps its own class and subgroup (a null subgroup stays null, not "").
    expect(snap.sessions.map((s) => [s.classId, s.groupId])).toEqual(data.sessions.map((s) => [s.classId, s.groupId]));
    // Every subgroup's classId is the class that held it locally.
    for (const g of snap.groups) {
      const owner = data.classes.find((c) => c.groups.some((x) => x.id === g.id));
      expect(g.classId).toBe(owner?.id);
    }
    const ids = [...snap.classes, ...snap.groups, ...snap.sessions].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^(class|group|s)-/.test(id))).toBe(true);
  });

  it("keeps session order, values and millisecond precision untouched", () => {
    const snap = toSyncSnapshot(sample());
    expect(snap.sessions.map((s) => s.id)).toEqual(["s-3", "s-2", "s-1"]);
    expect(snap.sessions[2]).toEqual({
      id: "s-1", classId: "class-a", groupId: "group-a2", startedAt: 1_700_000_100_123, seconds: 1500, mode: "stopwatch",
    });
  });

  it("handles empty data", () => {
    expect(toSyncSnapshot({ classes: [], sessions: [] })).toEqual({ classes: [], groups: [], sessions: [] });
  });

  it("does not mutate its input (even a frozen one)", () => {
    const data = deepFreeze(sample());
    const before = JSON.stringify(data);
    expect(() => toSyncSnapshot(data)).not.toThrow();
    expect(JSON.stringify(data)).toBe(before);
  });

  it("returns copies: no object is shared with the input, so editing the result never changes it", () => {
    const data = sample();
    const snap = toSyncSnapshot(data);
    data.classes.forEach((c, i) => expect(snap.classes[i]).not.toBe(c));
    data.sessions.forEach((s, i) => expect(snap.sessions[i]).not.toBe(s));
    snap.classes[0].name = "Changed";
    snap.groups[0].name = "Changed";
    snap.sessions[0].seconds = 1;
    expect(data.classes[0].name).toBe("Math");
    expect(data.classes[0].groups[0].name).toBe("Unit 1");
    expect(data.sessions[0].seconds).toBe(90);
  });

  it("is a pure copy: invalid data is carried over as is, never repaired or dropped", () => {
    const data: StoredData = {
      classes: [{ id: "c", name: "  Messy   name ", color: "blue", groups: [{ id: "g", name: " x" }] }],
      sessions: [
        { id: "orphan", classId: "gone", groupId: "missing", startedAt: -5, seconds: 0, mode: "stopwatch" },
        { id: "orphan", classId: "gone", groupId: null, startedAt: 1.5, seconds: 2.5, mode: "stopwatch" },
      ],
    };
    const snap = toSyncSnapshot(data);
    expect(snap.classes).toEqual([{ id: "c", name: "  Messy   name ", color: "blue" }]);
    expect(snap.groups).toEqual([{ id: "g", classId: "c", name: " x" }]);
    expect(snap.sessions).toHaveLength(2); // the duplicate id is not merged away
    expect(snap.sessions[0]).toMatchObject({ classId: "gone", groupId: "missing", startedAt: -5, seconds: 0 });
  });

  it("does not crash on a damaged shape", () => {
    expect(toSyncSnapshot({ classes: undefined, sessions: undefined } as unknown as StoredData)).toEqual({
      classes: [], groups: [], sessions: [],
    });
    const snap = toSyncSnapshot({ classes: [{ id: "c", name: "n", color: "#000000" }], sessions: [] } as unknown as StoredData);
    expect(snap.classes).toHaveLength(1);
    expect(snap.groups).toEqual([]);
  });

  it("keeps the revision out of the data: it travels beside the snapshot, not inside it", () => {
    const snapshot = toSyncSnapshot(sample());
    expect("revision" in snapshot).toBe(false);
    const withRevision: RevisionedSnapshot = { revision: 7, snapshot };
    expect(withRevision.revision).toBe(7);
    expect(withRevision.snapshot).toBe(snapshot);
  });
});
