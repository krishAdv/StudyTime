import { History as HistoryIcon } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import type { ClassItem, Session } from "@/lib/types";
import { formatDuration, timeLabel } from "@/lib/utils";

const MODE_LABEL = { stopwatch: "Stopwatch", countdown: "Countdown" } as const;

/**
 * Read-only list of the sessions saved against one subgroup. Cards are plain
 * list items with no click target and nothing here can edit,
 * reassign or delete a session; that stays in History.
 */
export function SubgroupSessions({
  name,
  cls,
  sessions,
}: {
  name: string;
  cls: ClassItem;
  /** Already filtered to this subgroup and sorted newest first. */
  sessions: Session[];
}) {
  return (
    <section aria-label={`Sessions in ${name}`} className="mt-6">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Study sessions</h2>
        <span className="text-xs text-muted-foreground">
          {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
        </span>
      </div>
      {sessions.length === 0 ? (
        <EmptyState
          icon={<HistoryIcon className="h-6 w-6" aria-hidden />}
          title="No sessions yet"
          description={`Sessions you log to ${name} will show up here.`}
        />
      ) : (
        <ul className="divide-y divide-border rounded-2xl border border-border bg-card px-4">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-3">
              <span
                className="h-9 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: cls.color }}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {new Date(s.startedAt).toLocaleDateString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {timeLabel(s.startedAt)} · {MODE_LABEL[s.mode]}
                </p>
              </div>
              <span className="shrink-0 text-sm font-medium tabular-nums">{formatDuration(s.seconds)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
