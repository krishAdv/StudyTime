"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/card";
import { SessionRow } from "@/features/history/session-row";
import { useStudyData } from "@/features/data/study-data-provider";
import { formatDuration, startOfDay } from "@/lib/utils";

export function TodaySummary() {
  const { sessions, classes } = useStudyData();
  // Midnight is fixed at mount.
  const [today] = useState(() => startOfDay(Date.now()));

  const todays = sessions.filter((s) => s.startedAt >= today);
  const studySeconds = todays.reduce((n, s) => n + s.seconds, 0);
  const recent = [...sessions].sort((a, b) => b.startedAt - a.startedAt).slice(0, 4);

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>Today</CardTitle>
        <div className="mt-3">
          <p className="text-3xl font-semibold tracking-tight tabular-nums">{formatDuration(studySeconds)}</p>
          <p className="text-xs text-muted-foreground">
            Study time · {todays.length} {todays.length === 1 ? "session" : "sessions"}
          </p>
        </div>
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <CardTitle>Recent sessions</CardTitle>
          <Link href="/history" className="flex items-center gap-1 text-xs font-medium text-primary">
            View all <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
        {recent.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No sessions yet. Start the timer to log your first one.</p>
        ) : (
          <ul className="mt-1 divide-y divide-border">
            {recent.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                cls={classes.find((c) => c.id === s.classId)}
                showDate={s.startedAt >= today ? undefined : new Date(s.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
