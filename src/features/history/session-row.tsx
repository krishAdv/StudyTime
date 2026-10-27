import type { ClassItem, Session } from "@/lib/types";
import { groupLabel } from "@/lib/class-tree";
import { formatDuration, timeLabel } from "@/lib/utils";

const MODE_LABEL = { stopwatch: "Stopwatch", countdown: "Countdown" } as const;

export function SessionRow({
  session,
  cls,
  showDate,
  onSelect,
}: {
  session: Session;
  cls: ClassItem | undefined;
  showDate?: string;
  /** When set, the row is a button that opens the session for editing. */
  onSelect?: () => void;
}) {
  const group = cls ? groupLabel(cls.groups, session.groupId) : null;
  const content = (
    <>
      <span
        className="h-9 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: cls?.color ?? "var(--border)" }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{cls?.name ?? "Unknown class"}</p>
        <p className="truncate text-xs text-muted-foreground">
          {group ?? "No subgroup"} · {showDate ? `${showDate}, ` : ""}
          {timeLabel(session.startedAt)} · {MODE_LABEL[session.mode]}
        </p>
      </div>
      <span className="shrink-0 text-sm font-medium tabular-nums">{formatDuration(session.seconds)}</span>
    </>
  );

  if (!onSelect) return <li className="flex items-center gap-3 py-3">{content}</li>;
  return (
    <li>
      <button
        onClick={onSelect}
        aria-label={`Edit session: ${cls?.name ?? "Unknown class"}, ${group ?? "no subgroup"}, ${timeLabel(session.startedAt)}, ${formatDuration(session.seconds)}`}
        className="-mx-4 flex w-[calc(100%+2rem)] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60"
      >
        {content}
      </button>
    </li>
  );
}
