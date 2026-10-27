"use client";

import { useState } from "react";
import Link from "next/link";
import { History as HistoryIcon, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { useStudyData } from "@/features/data/study-data-provider";
import { dayLabel, formatDuration, startOfDay } from "@/lib/utils";
import { SessionEditDialog } from "./session-edit-dialog";
import { SessionRow } from "./session-row";

export function HistoryView() {
  const { sessions, classes } = useStudyData();
  const [filter, setFilter] = useState("");
  const [now] = useState(() => Date.now());
  const [editingId, setEditingId] = useState<string | null>(null);

  // A deleted class can no longer be the active filter.
  const activeFilter = classes.some((c) => c.id === filter) ? filter : "";
  const visible = sessions
    .filter((s) => !activeFilter || s.classId === activeFilter)
    .sort((a, b) => b.startedAt - a.startedAt);

  const days = new Map<number, typeof visible>();
  for (const s of visible) {
    const key = startOfDay(s.startedAt);
    days.set(key, [...(days.get(key) ?? []), s]);
  }
  const total = visible.reduce((n, s) => n + s.seconds, 0);

  return (
    <>
      <PageHeader title="History" description="Every study session, newest first. Tap a session to fix its class or subgroup." />

      {sessions.length === 0 ? (
        <EmptyState
          icon={<HistoryIcon className="h-6 w-6" aria-hidden />}
          title="No sessions yet"
          description="Finished study sessions will show up here with their class, subgroup and duration."
          action={
            <Link href="/">
              <Button>Go to timer</Button>
            </Link>
          }
        />
      ) : (
        <>
          <div className="mb-6 flex items-end justify-between gap-4">
            <Select
              label="Filter by class"
              value={activeFilter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-full max-w-xs"
            >
              <option value="">All classes</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <p className="pb-2.5 text-right text-sm text-muted-foreground">
              {visible.length} {visible.length === 1 ? "session" : "sessions"} ·{" "}
              <span className="font-medium text-foreground">{formatDuration(total)}</span>
            </p>
          </div>

          {visible.length === 0 ? (
            <EmptyState
              icon={<SearchX className="h-6 w-6" aria-hidden />}
              title="No sessions for this class"
              description="Nothing has been logged for the selected class yet."
              action={
                <Button variant="secondary" onClick={() => setFilter("")}>
                  Show all classes
                </Button>
              }
            />
          ) : (
            <div className="space-y-6">
              {[...days.entries()].map(([day, list]) => (
                <section key={day} aria-label={dayLabel(day, now)}>
                  <div className="flex items-baseline justify-between">
                    <h2 className="text-sm font-semibold">{dayLabel(day, now)}</h2>
                    <span className="text-xs text-muted-foreground">
                      {formatDuration(list.reduce((n, s) => n + s.seconds, 0))}
                    </span>
                  </div>
                  <ul className="mt-1 divide-y divide-border rounded-2xl border border-border bg-card px-4">
                    {list.map((s) => (
                      <SessionRow
                        key={s.id}
                        session={s}
                        cls={classes.find((c) => c.id === s.classId)}
                        onSelect={() => setEditingId(s.id)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </>
      )}

      <SessionEditDialog session={sessions.find((s) => s.id === editingId) ?? null} onClose={() => setEditingId(null)} />
    </>
  );
}
