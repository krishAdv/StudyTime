import { describe, expect, it } from "vitest";
import { EXPORT_FORMAT, EXPORT_VERSION, exportFileName, parseExport, serializeExport, validateStudyData } from "@/lib/data-export";
import type { StoredData } from "@/lib/storage";

const DATA: StoredData = {
  classes: [
    { id: "class-1", name: "Math", color: "#3b82f6", groups: [{ id: "group-1", name: "Unit 1" }, { id: "group-2", name: "Unit 2" }] },
    { id: "class-2", name: "Art", color: "#8b5cf6", groups: [] },
  ],
  sessions: [
    { id: "s1", classId: "class-1", groupId: "group-1", startedAt: 1_700_000_000_000, seconds: 1500, mode: "stopwatch" },
    { id: "s2", classId: "class-2", groupId: null, startedAt: 1_700_000_100_000, seconds: 60, mode: "countdown" },
  ],
};

type Mutable = { classes: Record<string, unknown>[]; sessions: Record<string, unknown>[] };
const clone = (): Mutable => JSON.parse(JSON.stringify(DATA));
const file = (data: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ format: EXPORT_FORMAT, formatVersion: EXPORT_VERSION, exportedAt: "2026-10-27T12:00:00.000Z", data, ...extra });
const reject = (data: unknown, message: RegExp) => {
  const r = parseExport(file(data));
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(message);
};

describe("serializeExport", () => {
  it("writes the format, version, timestamp and data", () => {
    const out = JSON.parse(serializeExport(DATA, new Date("2026-10-27T18:30:00.000Z")));
    expect(out).toMatchObject({
      format: "studytime-export",
      formatVersion: 1,
      exportedAt: "2026-10-27T18:30:00.000Z",
      data: DATA,
    });
  });

  it("exports only study data, not settings or other fields", () => {
    const withExtra = { ...DATA, theme: "dark" } as StoredData;
    expect(Object.keys(JSON.parse(serializeExport(withExtra)))).toEqual(["format", "formatVersion", "exportedAt", "data"]);
    expect(Object.keys(JSON.parse(serializeExport(withExtra)).data)).toEqual(["classes", "sessions"]);
  });

  it("names the file with the local date", () => {
    expect(exportFileName(new Date(2026, 0, 5))).toBe("studytime-export-2026-01-05.json");
  });
});

describe("round trip", () => {
  it("restores identical classes, subgroups, sessions, ids and relationships", () => {
    const r = parseExport(serializeExport(DATA));
    expect(r).toEqual({ ok: true, value: DATA });
  });

  it("round-trips empty data", () => {
    const empty: StoredData = { classes: [], sessions: [] };
    expect(parseExport(serializeExport(empty))).toEqual({ ok: true, value: empty });
  });

  it("ignores unknown extra fields instead of keeping them", () => {
    const d = clone();
    d.classes[0].extra = "x";
    d.sessions[0].note = "y";
    expect(parseExport(file(d, { somethingElse: 1 }))).toEqual({ ok: true, value: DATA });
  });
});

describe("rejects unusable files", () => {
  it("malformed JSON", () => {
    expect(parseExport("{not json")).toMatchObject({ ok: false, error: expect.stringMatching(/valid JSON/) });
    expect(parseExport("")).toMatchObject({ ok: false });
  });

  it("files that aren't StudyTime exports", () => {
    expect(parseExport("[]")).toMatchObject({ ok: false });
    expect(parseExport(JSON.stringify({ classes: [], sessions: [] }))).toMatchObject({ ok: false });
    expect(parseExport(JSON.stringify({ format: "other", formatVersion: 1 }))).toMatchObject({ ok: false });
  });

  it("unsupported versions", () => {
    expect(parseExport(file(clone(), { formatVersion: 2 }))).toMatchObject({ ok: false, error: expect.stringMatching(/newer version/) });
    expect(parseExport(file(clone(), { formatVersion: 0 }))).toMatchObject({ ok: false, error: expect.stringMatching(/isn’t supported/) });
    expect(parseExport(file(clone(), { formatVersion: "1" }))).toMatchObject({ ok: false });
  });

  it("a missing or invalid export date", () => {
    expect(parseExport(file(clone(), { exportedAt: undefined }))).toMatchObject({ ok: false });
    expect(parseExport(file(clone(), { exportedAt: "not a date" }))).toMatchObject({ ok: false });
  });

  it("missing data, classes or sessions", () => {
    expect(parseExport(file(undefined))).toMatchObject({ ok: false });
    expect(parseExport(file(null))).toMatchObject({ ok: false });
    reject({ sessions: [] }, /classes/);
    reject({ classes: [] }, /sessions/);
    reject({ classes: {}, sessions: [] }, /classes/);
  });
});

describe("rejects invalid classes and subgroups", () => {
  it("missing or wrongly typed fields", () => {
    for (const [field, value] of [["id", undefined], ["id", 5], ["id", " "], ["name", undefined], ["name", 7], ["color", undefined], ["color", "blue"], ["color", "#12"], ["groups", undefined], ["groups", "x"]] as const) {
      const d = clone();
      d.classes[0][field] = value;
      expect(parseExport(file(d)).ok, `${field}=${String(value)}`).toBe(false);
    }
    const d = clone();
    d.classes[0] = null as never;
    expect(parseExport(file(d)).ok).toBe(false);
  });

  it("invalid subgroup fields", () => {
    for (const [field, value] of [["id", undefined], ["id", 1], ["name", undefined], ["name", false]] as const) {
      const d = clone();
      (d.classes[0].groups as Record<string, unknown>[])[0][field] = value;
      expect(parseExport(file(d)).ok, `${field}=${String(value)}`).toBe(false);
    }
  });

  it("duplicate class ids", () => {
    const d = clone();
    d.classes[1].id = "class-1";
    reject(d, /repeats the id “class-1”/);
  });

  it("duplicate subgroup ids, within a class and across classes", () => {
    const within = clone();
    (within.classes[0].groups as Record<string, unknown>[])[1].id = "group-1";
    reject(within, /repeats the id “group-1”/);
    const across = clone();
    across.classes[1].groups = [{ id: "group-1", name: "Other" }];
    reject(across, /repeats the id “group-1”/);
  });

  it("duplicate class names after trimming, spacing and case", () => {
    const d = clone();
    d.classes[1].name = "  mATh ";
    reject(d, /already exists/);
    const spaced = clone();
    spaced.classes[0].name = "Intro  to Art";
    spaced.classes[1].name = "intro to   art";
    reject(spaced, /already exists/);
  });

  it("duplicate subgroup names within one class, but allows the same name in another class", () => {
    const dup = clone();
    (dup.classes[0].groups as Record<string, unknown>[])[1].name = "UNIT  1";
    reject(dup, /already has a subgroup/);
    const ok = clone();
    ok.classes[1].groups = [{ id: "group-9", name: "Unit 1" }];
    expect(parseExport(file(ok)).ok).toBe(true);
  });

  it("empty and over-long names", () => {
    const empty = clone();
    empty.classes[0].name = "   ";
    expect(parseExport(file(empty)).ok).toBe(false);
    const long = clone();
    long.classes[0].name = "x".repeat(61);
    expect(parseExport(file(long)).ok).toBe(false);
  });

  it("normalizes whitespace in names it accepts", () => {
    const d = clone();
    d.classes[0].name = "  Math   101 ";
    const r = parseExport(file(d));
    expect(r.ok && r.value.classes[0].name).toBe("Math 101");
  });

  it("subgroups nested inside subgroups are not part of the format and are dropped without becoming data", () => {
    const d = clone();
    (d.classes[0].groups as Record<string, unknown>[])[0].children = [{ id: "deep", name: "Deep" }];
    const r = parseExport(file(d));
    expect(r.ok && r.value.classes[0].groups.map((g) => g.id)).toEqual(["group-1", "group-2"]);
  });
});

describe("rejects invalid sessions", () => {
  it("missing or wrongly typed fields", () => {
    for (const [field, value] of [["id", undefined], ["id", 3], ["classId", undefined], ["classId", 4], ["groupId", undefined], ["groupId", 5], ["startedAt", undefined], ["startedAt", "1"], ["seconds", undefined], ["seconds", "60"], ["mode", undefined], ["mode", "pomodoro"]] as const) {
      const d = clone();
      d.sessions[0][field] = value;
      expect(parseExport(file(d)).ok, `${field}=${String(value)}`).toBe(false);
    }
  });

  it("duplicate session ids", () => {
    const d = clone();
    d.sessions[1].id = "s1";
    reject(d, /repeats the id “s1”/);
  });

  it("invalid durations", () => {
    for (const seconds of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 400 * 24 * 3600]) {
      const d = clone();
      d.sessions[0].seconds = seconds;
      expect(parseExport(file(d)).ok, `seconds=${seconds}`).toBe(false);
    }
  });

  it("invalid timestamps", () => {
    for (const startedAt of [-1, 1.5, Number.NaN, 2 ** 60]) {
      const d = clone();
      d.sessions[0].startedAt = startedAt;
      expect(parseExport(file(d)).ok, `startedAt=${startedAt}`).toBe(false);
    }
  });

  it("a session whose class is missing", () => {
    const d = clone();
    d.sessions[0].classId = "ghost";
    reject(d, /class that isn’t in the file/);
  });

  it("a subgroup that doesn't exist, or belongs to another class", () => {
    const missing = clone();
    missing.sessions[0].groupId = "ghost";
    reject(missing, /subgroup that isn’t part of its class/);
    const other = clone();
    other.sessions[1].groupId = "group-1"; // group-1 belongs to class-1, session is class-2
    reject(other, /subgroup that isn’t part of its class/);
  });
});

describe("validateStudyData", () => {
  it("accepts the app's own data", () => {
    expect(validateStudyData(DATA)).toEqual({ ok: true, value: DATA });
  });

  it("rejects non-objects", () => {
    expect(validateStudyData(null).ok).toBe(false);
    expect(validateStudyData("x").ok).toBe(false);
    expect(validateStudyData([]).ok).toBe(false);
  });
});
