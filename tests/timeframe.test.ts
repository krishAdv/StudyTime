import { describe, expect, it } from "vitest";
import { classTotals, secondsInRange, timeframeRange } from "@/lib/timeframe";
import type { ClassItem, Session } from "@/lib/types";

// All dates use local-time constructors, matching how the app computes boundaries.
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

const cls = (id: string, name: string): ClassItem => ({ id, name, color: "#000", groups: [] });
const A = cls("a", "Alpha");
const B = cls("b", "Beta");
const C = cls("c", "Gamma");

const sess = (id: string, classId: string, startedAt: number, minutes: number): Session => ({
  id, classId, groupId: null, startedAt, seconds: minutes * 60, mode: "stopwatch",
});

// Sunday 2026-11-01, noon. Its week is Mon 2026-10-26 .. Sun 2026-11-01.
const NOW = at(2026, 11, 1, 12);

describe("timeframeRange", () => {
  it("all time is unbounded", () => {
    expect(timeframeRange("all", NOW)).toBeNull();
  });

  it("today is the local calendar day", () => {
    expect(timeframeRange("today", NOW)).toEqual({ start: at(2026, 11, 1), end: at(2026, 11, 2) });
  });

  it("weeks run Monday to Sunday (Sunday belongs to the week that began Monday)", () => {
    expect(timeframeRange("week", NOW)).toEqual({ start: at(2026, 10, 26), end: at(2026, 11, 2) });
    // Monday itself starts a new week.
    expect(timeframeRange("week", at(2026, 10, 26, 0, 1))).toEqual({ start: at(2026, 10, 26), end: at(2026, 11, 2) });
    // Wednesday mid-week.
    expect(timeframeRange("week", at(2026, 10, 28, 15))).toEqual({ start: at(2026, 10, 26), end: at(2026, 11, 2) });
  });

  it("month runs from the 1st to the 1st of the next month, across year ends", () => {
    expect(timeframeRange("month", NOW)).toEqual({ start: at(2026, 11, 1), end: at(2026, 12, 1) });
    expect(timeframeRange("month", at(2026, 12, 31, 23))).toEqual({ start: at(2026, 12, 1), end: at(2027, 1, 1) });
  });
});

describe("secondsInRange", () => {
  const today = timeframeRange("today", NOW);

  it("counts a fully inside session in full", () => {
    expect(secondsInRange(sess("1", "a", at(2026, 11, 1, 9), 60), today)).toBe(3600);
  });

  it("counts nothing for sessions outside the range", () => {
    expect(secondsInRange(sess("1", "a", at(2026, 10, 31, 9), 60), today)).toBe(0);
    expect(secondsInRange(sess("2", "a", at(2026, 11, 2, 9), 60), today)).toBe(0);
  });

  it("counts only the part after the start boundary for a session spanning midnight", () => {
    // 23:30 → 00:30 is 30 minutes on each day.
    const s = sess("1", "a", at(2026, 10, 31, 23, 30), 60);
    expect(secondsInRange(s, today)).toBe(30 * 60);
    expect(secondsInRange(s, timeframeRange("today", at(2026, 10, 31, 12)))).toBe(30 * 60);
  });

  it("splits a session across the week and month boundaries", () => {
    const sunNight = sess("w", "a", at(2026, 11, 1, 23), 120); // Sun 23:00 → Mon 01:00
    expect(secondsInRange(sunNight, timeframeRange("week", NOW))).toBe(3600);
    expect(secondsInRange(sunNight, timeframeRange("week", at(2026, 11, 2, 12)))).toBe(3600);
    const monthEnd = sess("m", "a", at(2026, 10, 31, 23, 30), 60);
    expect(secondsInRange(monthEnd, timeframeRange("month", NOW))).toBe(30 * 60);
  });

  it("returns the full duration when unbounded", () => {
    expect(secondsInRange(sess("1", "a", at(2020, 1, 1), 90), null)).toBe(5400);
  });
});

describe("classTotals", () => {
  const sessions = [
    sess("1", "a", at(2026, 11, 1, 9), 60), // today
    sess("2", "a", at(2026, 10, 27, 9), 30), // Tue, this week, not today
    sess("3", "b", at(2026, 10, 25, 9), 45), // Sun before this week (October)
    sess("4", "b", at(2026, 11, 1, 10), 15), // today
    sess("5", "a", at(2026, 9, 10, 9), 120), // September
    sess("orphan", "gone", at(2026, 11, 1, 9), 500),
  ];
  const classes = [A, B, C];
  const secs = (tf: Parameters<typeof classTotals>[2]) =>
    Object.fromEntries(classTotals(classes, sessions, tf, NOW).map((r) => [r.cls.id, r.seconds / 60]));

  it("all time sums every session of each class", () => {
    expect(secs("all")).toEqual({ a: 210, b: 60, c: 0 });
  });

  it("today", () => {
    expect(secs("today")).toEqual({ a: 60, b: 15, c: 0 });
  });

  it("this week excludes the previous Sunday", () => {
    expect(secs("week")).toEqual({ a: 90, b: 15, c: 0 });
  });

  it("this month excludes October and September", () => {
    expect(secs("month")).toEqual({ a: 60, b: 15, c: 0 });
  });

  it("keeps every class, with 0 for empty periods", () => {
    const empty = classTotals(classes, [], "today", NOW);
    expect(empty).toHaveLength(3);
    expect(empty.every((r) => r.seconds === 0)).toBe(true);
  });

  it("sorts by time, largest first, and ignores sessions of unknown classes", () => {
    const rows = classTotals(classes, sessions, "all", NOW);
    expect(rows.map((r) => r.cls.id)).toEqual(["a", "b", "c"]);
    expect(rows.reduce((n, r) => n + r.seconds, 0) / 60).toBe(270);
  });
});
