"use client";

import { useState } from "react";
import { Flame, Trophy } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Dropdown } from "@/components/ui/dropdown";
import { TIMEFRAME_OPTIONS, classTotals, type Timeframe } from "@/lib/timeframe";
import { useStudyData } from "@/features/data/study-data-provider";
import { cn, dayKey, formatDuration, startOfDay } from "@/lib/utils";

type Bar = { label: string; value: number; highlight?: boolean };

function BarChart({ title, bars }: { title: string; bars: Bar[] }) {
  const max = Math.max(...bars.map((b) => b.value), 1);
  return (
    <figure>
      <figcaption className="sr-only">{title}</figcaption>
      <div className="flex h-44 items-end gap-2 sm:gap-3" role="img" aria-label={`${title}: ${bars.map((b) => `${b.label} ${formatDuration(b.value * 60)}`).join(", ")}`}>
        {bars.map((b) => (
          <div key={b.label} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {b.value === 0 ? "–" : formatDuration(b.value * 60)}
            </span>
            <div
              className={cn("w-full max-w-10 rounded-t-md", b.highlight ? "bg-primary" : "bg-primary/35")}
              style={{ height: `${Math.max((b.value / max) * 100, b.value === 0 ? 0 : 4) * 0.72}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2 border-t border-border pt-2 sm:gap-3" aria-hidden>
        {bars.map((b) => (
          <span key={b.label} className="min-w-0 flex-1 truncate text-center text-[11px] text-muted-foreground sm:text-xs">
            {b.label}
          </span>
        ))}
      </div>
    </figure>
  );
}

const DAY = 86_400_000;

/** Longest and current runs of consecutive study days. */
function streaks(days: Set<string>, today: number) {
  let longest = 0;
  let run = 0;
  const sorted = [...days].sort();
  let prev: number | null = null;
  for (const d of sorted) {
    const [y, m, dd] = d.split("-").map(Number);
    const ms = new Date(y, m - 1, dd, 12).getTime();
    run = prev !== null && Math.round((ms - prev) / DAY) === 1 ? run + 1 : 1;
    prev = ms;
    longest = Math.max(longest, run);
  }
  // The streak is still alive if the last study day was yesterday.
  let cursor = days.has(dayKey(today)) ? today : today - DAY;
  let current = 0;
  while (days.has(dayKey(cursor))) {
    current += 1;
    cursor -= DAY;
  }
  return { current, longest };
}

export function InsightsView() {
  const { classes, sessions } = useStudyData();
  const [now] = useState(() => Date.now());
  const [timeframe, setTimeframe] = useState<Timeframe>("all");
  const today = startOfDay(now);

  const minutesBetween = (from: number, to: number) =>
    sessions.filter((x) => x.startedAt >= from && x.startedAt < to).reduce((n, x) => n + x.seconds, 0) / 60;

  const dailyMinutes = Array.from({ length: 7 }, (_, i) => {
    const start = today - (6 - i) * DAY;
    return minutesBetween(start, start + DAY);
  });
  const weeklyMinutes = Array.from({ length: 8 }, (_, i) => {
    const start = today + DAY - (8 - i) * 7 * DAY;
    return minutesBetween(start, start + 7 * DAY);
  });

  const daily: Bar[] = dailyMinutes.map((value, i) => ({
    label: i === 6 ? "Today" : new Date(today - (6 - i) * DAY).toLocaleDateString(undefined, { weekday: "short" }),
    value,
    highlight: i === 6,
  }));
  const weekly: Bar[] = weeklyMinutes.map((value, i) => ({
    label: i === 7 ? "Now" : `${7 - i}w`,
    value,
    highlight: i === 7,
  }));

  const dailyTotal = dailyMinutes.reduce((n, v) => n + v, 0);
  const { current: currentStreak, longest: longestStreak } = streaks(
    new Set(sessions.map((x) => dayKey(x.startedAt))),
    now,
  );
  const byClass = classTotals(classes, sessions, timeframe, now);
  const classMax = Math.max(...byClass.map((r) => r.seconds), 1);
  const periodEmpty = byClass.every((r) => r.seconds === 0);

  return (
    <>
      <PageHeader title="Insights" description="Daily and weekly study time, plus your streaks, from sessions saved on this device." />

      <div className="mb-6 grid grid-cols-2 gap-4">
        <Card>
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Flame className="h-4 w-4 text-break" aria-hidden /> Current streak
          </p>
          <p className="mt-2 text-4xl font-semibold tracking-tight tabular-nums">
            {currentStreak} <span className="text-base font-normal text-muted-foreground">days</span>
          </p>
        </Card>
        <Card>
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Trophy className="h-4 w-4 text-primary" aria-hidden /> Longest streak
          </p>
          <p className="mt-2 text-4xl font-semibold tracking-tight tabular-nums">
            {longestStreak} <span className="text-base font-normal text-muted-foreground">days</span>
          </p>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Last 7 days</CardTitle>
          <p className="mb-4 mt-0.5 text-xs text-muted-foreground">
            {formatDuration(dailyTotal * 60)} total · {formatDuration((dailyTotal / 7) * 60)} per day
          </p>
          <BarChart title="Study time per day" bars={daily} />
        </Card>
        <Card>
          <CardTitle>Last 8 weeks</CardTitle>
          <p className="mb-4 mt-0.5 text-xs text-muted-foreground">Total study time per week (7-day blocks ending today)</p>
          <BarChart title="Study time per week" bars={weekly} />
        </Card>
      </div>

      <Card className="mt-6">
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <CardTitle className="min-w-0">By class</CardTitle>
          <Dropdown
            label="Timeframe"
            value={timeframe}
            options={TIMEFRAME_OPTIONS}
            onChange={setTimeframe}
            className="w-full sm:w-44 sm:shrink-0"
          />
        </div>
        {classes.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No classes yet.</p>}
        {classes.length > 0 && periodEmpty && (
          <p className="mt-3 text-sm text-muted-foreground">
            {timeframe === "all" ? "No sessions yet." : "No study time in this period."}
          </p>
        )}
        <ul className="mt-4 space-y-4">
          {byClass.map((row) => (
            <li key={row.cls.id}>
              <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate font-medium">{row.cls.name}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {row.seconds < 1 ? "0m" : formatDuration(row.seconds)}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${(row.seconds / classMax) * 100}%`, backgroundColor: row.cls.color }}
                />
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
