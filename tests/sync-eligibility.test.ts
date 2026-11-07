import { describe, expect, it } from "vitest";
import { createClass, createGroup } from "@/lib/class-rules";
import {
  SERVER_LIMITS, checkSyncEligibility, type SyncIssue, type SyncIssueCode,
} from "@/lib/sync/eligibility";
import { toSyncSnapshot } from "@/lib/sync/snapshot";
import type { StoredData } from "@/lib/storage";
import type { Session } from "@/lib/types";

const deepFreeze = <T>(v: T): T => {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v)) deepFreeze(child);
  }
  return v;
};

/** A small data set that satisfies every server constraint. Tests change one thing at a time. */
function valid(): StoredData {
  return {
    classes: [
      { id: "c1", name: "Math", color: "#3b82f6", groups: [{ id: "g1", name: "Unit 1" }, { id: "g2", name: "Unit 2" }] },
      { id: "c2", name: "Art", color: "#8B5CF6", groups: [{ id: "g3", name: "Unit 1" }] },
    ],
    sessions: [
      { id: "s1", classId: "c1", groupId: "g1", startedAt: 1_700_000_000_123, seconds: 1500, mode: "stopwatch" },
      { id: "s2", classId: "c2", groupId: null, startedAt: 1_700_000_500_000, seconds: 90, mode: "countdown" },
    ],
  };
}

const session = (over: Partial<Session> | Record<string, unknown>): Session =>
  ({ ...valid().sessions[0], ...over }) as Session;

function issuesOf(data: StoredData): SyncIssue[] {
  const r = checkSyncEligibility(data);
  if (r.ok) throw new Error("expected issues but the data was eligible");
  return r.issues;
}
const codesOf = (data: StoredData): SyncIssueCode[] => issuesOf(data).map((i) => i.code);

describe("eligible data", () => {
  it("returns ok with the flat snapshot (identical to toSyncSnapshot)", () => {
    const data = valid();
    const r = checkSyncEligibility(data);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.snapshot).toEqual(toSyncSnapshot(data));
  });

  it("accepts empty data", () => {
    expect(checkSyncEligibility({ classes: [], sessions: [] }).ok).toBe(true);
  });

  it("accepts data built by the app's own rules", () => {
    const classes = createClass([], "  Math   101 ", "class-x", "#3b82f6");
    if (!classes.ok) throw new Error("setup");
    const withGroup = createGroup(classes.value, "class-x", " Unit  1", "group-x");
    if (!withGroup.ok) throw new Error("setup");
    const r = checkSyncEligibility({
      classes: withGroup.value,
      sessions: [{ id: "s", classId: "class-x", groupId: "group-x", startedAt: 1, seconds: 5, mode: "stopwatch" }],
    });
    expect(r.ok).toBe(true);
  });

  it("does not mutate its input", () => {
    const data = deepFreeze(valid());
    const before = JSON.stringify(data);
    expect(() => checkSyncEligibility(data)).not.toThrow();
    expect(JSON.stringify(data)).toBe(before);
    const bad = deepFreeze({ classes: [{ id: "", name: " x ", color: "no", groups: [] }], sessions: [] } as StoredData);
    const beforeBad = JSON.stringify(bad);
    checkSyncEligibility(bad);
    expect(JSON.stringify(bad)).toBe(beforeBad);
  });

  it("never repairs: the same invalid data is reported identically on every call", () => {
    const data = valid();
    data.classes[0].name = " Math ";
    expect(codesOf(data)).toEqual(["name_not_normalized"]);
    expect(codesOf(data)).toEqual(["name_not_normalized"]);
    expect(data.classes[0].name).toBe(" Math ");
  });
});

describe("colors", () => {
  it.each(["blue", "#12345", "#1234567", "123456", "#GGGGGG", "#12345G", "#abc", "", " #3b82f6", "#3b82f6 ", "#3b82f6\n"])(
    "rejects %j",
    (color) => {
      const data = valid();
      data.classes[0].color = color;
      const issues = issuesOf(data);
      expect(issues.map((i) => i.code)).toEqual(["invalid_color"]);
      expect(issues[0]).toMatchObject({ entity: "class", id: "c1", field: "color", position: 1 });
    },
  );

  it.each(["#000000", "#ffffff", "#FFFFFF", "#aBcDeF"])("accepts %j", (color) => {
    const data = valid();
    data.classes[0].color = color;
    expect(checkSyncEligibility(data).ok).toBe(true);
  });

  it("rejects a color that is not a string", () => {
    const data = valid();
    (data.classes[0] as unknown as { color: unknown }).color = 123456;
    expect(codesOf(data)).toEqual(["invalid_color"]);
  });
});

describe("names", () => {
  it.each([
    ["leading space", " Math"],
    ["trailing space", "Math "],
    ["double inner space", "Intro  Art"],
    ["a tab", "Intro\tArt"],
    ["a non-breaking space", "Intro Art"],
    ["a newline", "Intro\nArt"],
  ])("a class name with %s is not normalized", (_label, name) => {
    const data = valid();
    data.classes[0].name = name;
    const issues = issuesOf(data);
    expect(issues.map((i) => i.code)).toEqual(["name_not_normalized"]);
    expect(issues[0].hint).toContain("Rename it to");
  });

  it("a subgroup name with extra spaces is not normalized", () => {
    const data = valid();
    data.classes[0].groups[0].name = "Unit  1";
    const issues = issuesOf(data);
    expect(issues.map((i) => i.code)).toEqual(["name_not_normalized"]);
    expect(issues[0]).toMatchObject({ entity: "group", id: "g1", classId: "c1", position: 1, field: "name" });
  });

  it.each(["", "   ", "\t\n"])("rejects the empty class name %j", (name) => {
    const data = valid();
    data.classes[0].name = name;
    expect(codesOf(data)).toEqual(["name_empty"]);
  });

  it("rejects an empty subgroup name", () => {
    const data = valid();
    data.classes[0].groups[0].name = "  ";
    expect(codesOf(data)).toEqual(["name_empty"]);
  });

  it("rejects names that are not strings", () => {
    const data = valid();
    (data.classes[0] as unknown as { name: unknown }).name = 5;
    (data.classes[1].groups[0] as unknown as { name: unknown }).name = null;
    expect(codesOf(data)).toEqual(["invalid_name", "invalid_name"]);
  });

  it("allows 60 characters and rejects 61, for classes and subgroups", () => {
    const data = valid();
    data.classes[0].name = "n".repeat(60);
    data.classes[0].groups[0].name = "g".repeat(60);
    expect(checkSyncEligibility(data).ok).toBe(true);
    data.classes[0].name = "n".repeat(61);
    data.classes[0].groups[0].name = "g".repeat(61);
    const issues = issuesOf(data);
    expect(issues.map((i) => i.code)).toEqual(["name_too_long", "name_too_long"]);
    expect(issues.map((i) => i.entity)).toEqual(["class", "group"]);
  });

  it("counts characters like the server (code points), not UTF-16 units", () => {
    const data = valid();
    data.classes[0].name = "😀".repeat(60); // 120 UTF-16 units but 60 characters
    expect(checkSyncEligibility(data).ok).toBe(true);
    data.classes[0].name = "😀".repeat(61);
    expect(codesOf(data)).toEqual(["name_too_long"]);
  });

  it("rejects names the database cannot store (NUL, lone surrogates)", () => {
    const data = valid();
    data.classes[0].name = "Ma\u0000th";
    data.classes[1].name = "Art\ud800";
    expect(codesOf(data)).toEqual(["invalid_text", "invalid_text"]);
    const good = valid();
    good.classes[0].name = "Math 😀"; // a proper surrogate pair is fine
    expect(checkSyncEligibility(good).ok).toBe(true);
  });
});

describe("duplicate names", () => {
  it.each([["exact", "Math", "Math"], ["different case", "Math", "MATH"], ["mixed case", "mAtH", "Math"]])(
    "two classes with the same name (%s) are reported on the second",
    (_label, a, b) => {
      const data = valid();
      data.classes[0].name = a;
      data.classes[1].name = b;
      const issues = issuesOf(data);
      expect(issues.map((i) => i.code)).toEqual(["duplicate_class_name"]);
      expect(issues[0]).toMatchObject({ entity: "class", id: "c2", position: 2, related: ["c1"] });
    },
  );

  it("normalizes before comparing (extra spaces do not hide a duplicate)", () => {
    const data = valid();
    data.classes[1].name = "  math ";
    expect(codesOf(data)).toEqual(["name_not_normalized", "duplicate_class_name"]);
  });

  it("flags names that a database locale may treat as equal even though the app's rule does not", () => {
    const data = valid();
    data.classes[0].name = "İstanbul";
    data.classes[1].name = "istanbul";
    expect(codesOf(data)).toEqual(["duplicate_class_name"]);
  });

  it("does not flag genuinely different names (ß and SS are different)", () => {
    const data = valid();
    data.classes[0].name = "Straße";
    data.classes[1].name = "STRASSE";
    expect(checkSyncEligibility(data).ok).toBe(true);
  });

  it("the same subgroup name in two different classes is fine", () => {
    // valid() already has "Unit 1" in both classes
    expect(checkSyncEligibility(valid()).ok).toBe(true);
  });

  it("the same subgroup name twice in one class is reported, case-insensitively", () => {
    const data = valid();
    data.classes[0].groups[1].name = "UNIT 1";
    const issues = issuesOf(data);
    expect(issues.map((i) => i.code)).toEqual(["duplicate_group_name"]);
    expect(issues[0]).toMatchObject({ entity: "group", id: "g2", classId: "c1", position: 2, related: ["g1"] });
  });

  it("a class and a subgroup may share a name (different tables)", () => {
    const data = valid();
    data.classes[0].groups[0].name = "Art";
    expect(checkSyncEligibility(data).ok).toBe(true);
  });
});

describe("ids", () => {
  it.each(["", "   ", "\t"])("rejects the empty id %j on a class, subgroup and session", (id) => {
    const data = valid();
    data.classes[0].id = id;
    data.classes[1].groups[0].id = id;
    data.sessions[1].id = id;
    const issues = issuesOf(data);
    expect(issues.filter((i) => i.code === "invalid_id").map((i) => i.entity).sort()).toEqual(["class", "group", "session"]);
    expect(issues.every((i) => i.id === null || i.code !== "invalid_id")).toBe(true);
  });

  it("rejects ids that are not strings", () => {
    const data = valid();
    (data.classes[0] as unknown as { id: unknown }).id = 7;
    (data.sessions[0] as unknown as { id: unknown }).id = undefined;
    expect(codesOf(data)).toContain("invalid_id");
    expect(issuesOf(data).filter((i) => i.code === "invalid_id")).toHaveLength(2);
  });

  it("allows exactly 100 characters and rejects 101, for every kind of record", () => {
    const data = valid();
    data.classes[0].id = "a".repeat(100);
    data.classes[0].groups[0].id = "b".repeat(100);
    data.sessions[0] = session({ id: "c".repeat(100), classId: "a".repeat(100), groupId: "b".repeat(100) });
    expect(checkSyncEligibility(data).ok).toBe(true);

    const long = valid();
    long.classes[0].id = "a".repeat(101);
    long.classes[1].groups[0].id = "b".repeat(101);
    long.sessions[1].id = "c".repeat(101);
    const issues = issuesOf(long).filter((i) => i.code === "id_too_long");
    expect(issues.map((i) => i.entity).sort()).toEqual(["class", "group", "session"]);
  });

  it("counts id characters like the server (code points)", () => {
    const data = valid();
    data.classes[0].id = "😀".repeat(100); // 200 UTF-16 units, 100 characters
    data.sessions[0].classId = "😀".repeat(100);
    data.sessions[0].groupId = null;
    expect(checkSyncEligibility(data).ok).toBe(true);
    data.classes[0].id = "😀".repeat(101);
    expect(codesOf(data)).toContain("id_too_long");
  });

  it("rejects ids with NUL or a lone surrogate", () => {
    const data = valid();
    data.classes[0].id = "c\u0000";
    data.sessions[0].id = "s\udc00";
    expect(issuesOf(data).filter((i) => i.code === "invalid_text")).toHaveLength(2);
  });

  it("rejects a repeated class id, subgroup id and session id", () => {
    const data = valid();
    data.classes[1].id = "c1";
    data.classes[1].groups[0].id = "g1"; // same id as a subgroup in ANOTHER class
    data.sessions[1].id = "s1";
    const issues = issuesOf(data);
    expect(issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(["duplicate_class_id", "duplicate_group_id", "duplicate_session_id"]),
    );
    expect(issues.find((i) => i.code === "duplicate_group_id")).toMatchObject({ id: "g1", classId: "c1", related: ["c1"] });
  });

  it("subgroup ids must be unique across classes, but a class id and a subgroup id may match", () => {
    const data = valid();
    data.classes[1].groups[0].id = "c1"; // equal to a CLASS id: different table, allowed
    expect(checkSyncEligibility(data).ok).toBe(true);
  });
});

describe("sessions and their relationships", () => {
  it("rejects a session whose class does not exist (an orphan)", () => {
    const data = valid();
    data.sessions[0] = session({ classId: "gone", groupId: null });
    const issues = issuesOf(data);
    expect(issues.map((i) => i.code)).toEqual(["session_class_missing"]);
    expect(issues[0]).toMatchObject({ entity: "session", id: "s1", classId: "gone", position: 1, field: "classId" });
  });

  it.each(["", undefined, 5])("rejects a session with no usable class (%j)", (classId) => {
    const data = valid();
    data.sessions[0] = session({ classId: classId as unknown as string, groupId: null });
    expect(codesOf(data)).toEqual(["session_class_missing"]);
  });

  it("rejects a session whose subgroup does not exist", () => {
    const data = valid();
    data.sessions[0] = session({ groupId: "nope" });
    const issues = issuesOf(data);
    expect(issues.map((i) => i.code)).toEqual(["session_group_missing"]);
    expect(issues[0].related).toEqual(["nope"]);
  });

  it("rejects an empty-string subgroup (null is the only way to say no subgroup)", () => {
    const data = valid();
    data.sessions[0] = session({ groupId: "" });
    expect(codesOf(data)).toEqual(["session_group_missing"]);
  });

  it("rejects a session whose subgroup belongs to a different class", () => {
    const data = valid();
    data.sessions[0] = session({ classId: "c2", groupId: "g1" });
    const issues = issuesOf(data);
    expect(issues.map((i) => i.code)).toEqual(["session_group_wrong_class"]);
    expect(issues[0]).toMatchObject({ classId: "c2", related: ["g1"] });
  });

  it("requires the subgroup key: undefined or a non-string is rejected, null is fine", () => {
    const data = valid();
    data.sessions[0] = session({ groupId: undefined as unknown as null });
    data.sessions[1] = session({ id: "s2", classId: "c2", groupId: 12 as unknown as null });
    expect(codesOf(data)).toEqual(["invalid_group_reference", "invalid_group_reference"]);
    const ok = valid();
    ok.sessions[0] = session({ groupId: null });
    expect(checkSyncEligibility(ok).ok).toBe(true);
  });

  it("reports both problems for a session that has a missing class and a missing subgroup", () => {
    const data = valid();
    data.sessions[0] = session({ classId: "gone", groupId: "nope" });
    expect(codesOf(data)).toEqual(["session_class_missing", "session_group_missing"]);
  });

  it("does not let a deleted class's subgroup count: a session pointing at it is reported", () => {
    const data = valid();
    data.classes.splice(0, 1); // c1 (and its subgroups g1, g2) is gone
    expect(codesOf(data)).toContain("session_class_missing");
    expect(codesOf(data)).toContain("session_group_missing");
  });
});

describe("timestamps", () => {
  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["beyond the year 9999", SERVER_LIMITS.maxStartedAtMs + 1],
    ["not a safe integer", Number.MAX_SAFE_INTEGER + 1],
    ["a string", "1700000000000"],
    ["null", null],
  ])("rejects a start time that is %s", (_label, startedAt) => {
    const data = valid();
    data.sessions[0] = session({ startedAt: startedAt as unknown as number });
    const issues = issuesOf(data);
    expect(issues.map((i) => i.code)).toEqual(["invalid_start_time"]);
    expect(issues[0]).toMatchObject({ field: "startedAt", id: "s1" });
  });

  it.each([0, 1, 1_700_000_000_123, SERVER_LIMITS.maxStartedAtMs])("accepts a start time of %d", (startedAt) => {
    const data = valid();
    data.sessions[0] = session({ startedAt });
    expect(checkSyncEligibility(data).ok).toBe(true);
  });
});

describe("durations and modes", () => {
  it.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["over 366 days", SERVER_LIMITS.maxSeconds + 1],
    ["a string", "60"],
    ["undefined", undefined],
  ])("rejects a duration that is %s", (_label, seconds) => {
    const data = valid();
    data.sessions[0] = session({ seconds: seconds as unknown as number });
    const issues = issuesOf(data);
    expect(issues.map((i) => i.code)).toEqual(["invalid_duration"]);
    expect(issues[0].field).toBe("seconds");
  });

  it.each([1, 60, SERVER_LIMITS.maxSeconds])("accepts a duration of %d seconds", (seconds) => {
    const data = valid();
    data.sessions[0] = session({ seconds });
    expect(checkSyncEligibility(data).ok).toBe(true);
  });

  it.each(["pomodoro", "", "Stopwatch", undefined, 1])("rejects the mode %j", (mode) => {
    const data = valid();
    data.sessions[0] = session({ mode: mode as never });
    expect(codesOf(data)).toEqual(["invalid_mode"]);
  });

  it.each(["stopwatch", "countdown"] as const)("accepts the mode %s", (mode) => {
    const data = valid();
    data.sessions[0] = session({ mode });
    expect(checkSyncEligibility(data).ok).toBe(true);
  });
});

describe("limits", () => {
  const manyClasses = (n: number): StoredData["classes"] =>
    Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: `Class ${i}`, color: "#000000", groups: [] }));
  const manySessions = (n: number): Session[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `s${i}`, classId: "c0", groupId: null, startedAt: i, seconds: 1, mode: "stopwatch" as const,
    }));

  it("allows 1,000 classes and rejects 1,001", () => {
    expect(checkSyncEligibility({ classes: manyClasses(SERVER_LIMITS.maxClasses), sessions: [] }).ok).toBe(true);
    const issues = issuesOf({ classes: manyClasses(SERVER_LIMITS.maxClasses + 1), sessions: [] });
    expect(issues.map((i) => i.code)).toEqual(["too_many_classes"]);
  });

  it("allows 1,000 subgroups in a class and rejects 1,001", () => {
    const groups = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `g${i}`, name: `Group ${i}` }));
    const base = (n: number): StoredData => ({
      classes: [{ id: "c1", name: "Big", color: "#000000", groups: groups(n) }],
      sessions: [],
    });
    expect(checkSyncEligibility(base(SERVER_LIMITS.maxGroupsPerClass)).ok).toBe(true);
    const issues = issuesOf(base(SERVER_LIMITS.maxGroupsPerClass + 1));
    expect(issues.map((i) => i.code)).toEqual(["too_many_groups"]);
    expect(issues[0]).toMatchObject({ entity: "group", classId: "c1" });
  });

  it("allows 100,000 sessions and rejects 100,001", () => {
    const classes = manyClasses(1);
    expect(checkSyncEligibility({ classes, sessions: manySessions(SERVER_LIMITS.maxSessions) }).ok).toBe(true);
    const issues = issuesOf({ classes, sessions: manySessions(SERVER_LIMITS.maxSessions + 1) });
    expect(issues.map((i) => i.code)).toEqual(["too_many_sessions"]);
  });

  it("exposes the server limits it checks against", () => {
    expect(SERVER_LIMITS).toMatchObject({
      maxIdLength: 100, maxNameLength: 60, minSeconds: 1, maxSeconds: 31_622_400,
      maxStartedAtMs: 253_402_300_799_999, maxClasses: 1000, maxGroupsPerClass: 1000, maxSessions: 100_000,
    });
  });
});

describe("damaged data and reporting", () => {
  it("reports a data object that is not in the expected shape", () => {
    for (const bad of [null, {}, { classes: [] }, { classes: {}, sessions: [] }, { classes: [], sessions: "x" }]) {
      const r = checkSyncEligibility(bad as unknown as StoredData);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues[0]).toMatchObject({ code: "invalid_data", entity: "data", id: null });
    }
  });

  it("reports damaged records instead of crashing", () => {
    const data = valid();
    (data.classes as unknown[])[1] = "not a class";
    (data.sessions as unknown[])[0] = null;
    (data.classes[0] as unknown as { groups: unknown }).groups = "oops";
    const issues = issuesOf(data);
    expect(issues.map((i) => i.code)).toEqual(expect.arrayContaining(["invalid_data"]));
    expect(issues.filter((i) => i.code === "invalid_data").map((i) => i.entity).sort()).toEqual(["class", "class", "session"]);
  });

  it("reports a damaged subgroup entry", () => {
    const data = valid();
    (data.classes[0].groups as unknown[])[0] = 42;
    expect(issuesOf(data)[0]).toMatchObject({ code: "invalid_data", entity: "group", classId: "c1", position: 1 });
  });

  it("collects every problem, in list order, with actionable structure", () => {
    const data = valid();
    data.classes[0].color = "blue";
    data.classes[1].name = "math";
    data.classes[0].groups[1].name = "unit 1";
    data.sessions[0] = session({ classId: "gone", groupId: null, seconds: 0 });
    data.sessions[1] = session({ id: "s2", classId: "c2", groupId: null, mode: "pomodoro" as never });
    const r = checkSyncEligibility(data);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toEqual([
      "invalid_color",
      "duplicate_group_name",
      "duplicate_class_name",
      "session_class_missing",
      "invalid_duration",
      "invalid_mode",
    ]);
    expect(r.totalIssues).toBe(6);
    expect(r.truncated).toBe(false);
    for (const i of r.issues) {
      expect(i.message.length).toBeGreaterThan(10);
      expect(i.hint.length).toBeGreaterThan(5);
      expect(["class", "group", "session"]).toContain(i.entity);
    }
  });

  it("uses plain-language messages that name the record", () => {
    const data = valid();
    data.classes[0].color = "blue";
    const [issue] = issuesOf(data);
    expect(issue.message).toBe("Class 1 (“Math”) has an invalid color.");
  });

  it("truncates a long list but still counts every problem", () => {
    const data: StoredData = {
      classes: [{ id: "c", name: "C", color: "#000000", groups: [] }],
      sessions: Array.from({ length: 300 }, (_, i) => ({
        id: `s${i}`, classId: "c", groupId: null, startedAt: -1, seconds: 1, mode: "stopwatch" as const,
      })),
    };
    const small = checkSyncEligibility(data, { maxIssues: 5 });
    expect(small.ok).toBe(false);
    if (!small.ok) {
      expect(small.issues).toHaveLength(5);
      expect(small.totalIssues).toBe(300);
      expect(small.truncated).toBe(true);
    }
    const dflt = checkSyncEligibility(data);
    if (!dflt.ok) {
      expect(dflt.issues).toHaveLength(200);
      expect(dflt.totalIssues).toBe(300);
    }
  });
});
