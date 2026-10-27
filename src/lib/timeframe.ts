import type { ClassItem, Session } from "./types";

/**
 * Timeframes for Insights → By class. All boundaries use the user's local
 * calendar (the JS Date local timezone; DST-safe because boundaries are built
 * with Date constructors rather than by adding 24h). Weeks run Monday–Sunday.
 */
export type Timeframe = "all" | "today" | "week" | "month";

export const TIMEFRAME_OPTIONS: { value: Timeframe; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
];

/** Half-open range [start, end) in epoch ms. */
export type Range = { start: number; end: number };

/** Returns null for "all" (unbounded). */
export function timeframeRange(tf: Timeframe, now: number): Range | null {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  switch (tf) {
    case "all":
      return null;
    case "today":
      return { start: new Date(y, m, day).getTime(), end: new Date(y, m, day + 1).getTime() };
    case "week": {
      const sinceMonday = (d.getDay() + 6) % 7;
      return {
        start: new Date(y, m, day - sinceMonday).getTime(),
        end: new Date(y, m, day - sinceMonday + 7).getTime(),
      };
    }
    case "month":
      return { start: new Date(y, m, 1).getTime(), end: new Date(y, m + 1, 1).getTime() };
  }
}

/**
 * Seconds of a session that fall inside the range. A session stores only its
 * start time and its total studied seconds (paused time is excluded and pause
 * positions are not recorded), so its studied time is treated as one contiguous
 * block beginning at `startedAt`. A session crossing a boundary therefore counts
 * only the portion on the selected side, never its whole duration.
 */
export function secondsInRange(s: Session, range: Range | null): number {
  if (!range) return s.seconds;
  const end = s.startedAt + s.seconds * 1000;
  const overlapMs = Math.min(end, range.end) - Math.max(s.startedAt, range.start);
  return Math.max(0, overlapMs / 1000);
}

export type ClassTotal = { cls: ClassItem; seconds: number };

/** One row per class (zero-time classes included), largest first, then by name. */
export function classTotals(
  classes: ClassItem[],
  sessions: Session[],
  tf: Timeframe,
  now: number,
): ClassTotal[] {
  const range = timeframeRange(tf, now);
  const totals = new Map<string, number>(classes.map((c) => [c.id, 0]));
  for (const s of sessions) {
    const prev = totals.get(s.classId);
    if (prev !== undefined) totals.set(s.classId, prev + secondsInRange(s, range));
  }
  return classes
    .map((cls) => ({ cls, seconds: totals.get(cls.id) ?? 0 }))
    .sort((a, b) => b.seconds - a.seconds || a.cls.name.localeCompare(b.cls.name));
}
