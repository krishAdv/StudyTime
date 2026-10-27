"use client";

import Link from "next/link";
import { BookOpen, Hourglass, Pause, Play, Square, Timer as TimerIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DurationInput } from "@/components/ui/duration-input";
import { Select } from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { MAX_MINUTES, MIN_MINUTES, useSettings } from "@/features/settings/settings-provider";
import { useStudyData } from "@/features/data/study-data-provider";
import type { TimerMode } from "@/lib/types";
import { clockParts, cn, formatDuration } from "@/lib/utils";
import { useTimer } from "./timer-provider";

const MODES: { value: TimerMode; label: string; icon: React.ReactNode }[] = [
  { value: "stopwatch", label: "Stopwatch", icon: <TimerIcon className="h-4 w-4" aria-hidden /> },
  { value: "countdown", label: "Countdown", icon: <Hourglass className="h-4 w-4" aria-hidden /> },
];

function Clock({ ms, paused }: { ms: number; paused: boolean }) {
  const { hours, minutes, seconds } = clockParts(ms);
  const units = [
    { v: hours, l: "hours" },
    { v: minutes, l: "minutes" },
    { v: seconds, l: "seconds" },
  ];
  // Digit size steps up with the viewport so the clock always fits inside the card.
  const big = "text-[2.75rem] min-[400px]:text-[3.5rem] sm:text-7xl";
  return (
    <div
      role="timer"
      aria-label={`${hours} hours ${minutes} minutes ${seconds} seconds`}
      className={cn("flex items-start justify-center gap-1.5 min-[400px]:gap-2 sm:gap-4", paused && "opacity-60")}
    >
      {units.map((u, i) => (
        <div key={u.l} className="flex items-start gap-1.5 min-[400px]:gap-2 sm:gap-4">
          <div className="flex flex-col items-center">
            <span aria-hidden className={cn("font-semibold leading-none tracking-tight tabular-nums", big)}>
              {u.v}
            </span>
            <span className="mt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {u.l}
            </span>
          </div>
          {i < 2 && (
            <span aria-hidden className={cn("font-light leading-none text-muted-foreground/50", big)}>
              :
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function TimerCard() {
  const t = useTimer();
  const { classes } = useStudyData();
  const { countdownMinutes } = useSettings();

  const { state } = t;
  const idle = state.status === "idle";
  const cls = classes.find((c) => c.id === t.classId);
  const groups = cls?.groups ?? [];
  const modeLabel = state.mode === "countdown" ? "Countdown" : "Stopwatch";

  const phaseLabel = idle ? "Ready to study" : state.status === "paused" ? "Paused" : "Studying";

  const modeHint =
    state.mode === "countdown"
      ? t.durationMinutes !== null
        ? `${formatDuration(t.durationMinutes * 60)} countdown`
        : "Enter a valid duration below."
      : "Counts up from zero until you stop";

  return (
    <Card className="p-5 sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-primary-soft px-3 py-1 text-xs font-semibold text-primary">
          <BookOpen className="h-3.5 w-3.5" aria-hidden />
          {phaseLabel}
        </span>
        <span className="text-xs font-medium text-muted-foreground">{modeLabel} mode</span>
      </div>

      <div className="py-8 sm:py-10">
        <Clock ms={t.displayMs} paused={state.status === "paused"} />
        {t.progress !== null && (
          <div
            className="mx-auto mt-6 h-1.5 max-w-sm overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="Progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(t.progress * 100)}
          >
            <div className="h-full rounded-full bg-primary" style={{ width: `${t.progress * 100}%` }} />
          </div>
        )}
        <p className="mt-4 text-center text-sm text-muted-foreground" aria-live="polite">
          {state.message ??
            (idle
              ? modeHint
              : state.status === "paused"
                ? "Paused. Paused time isn’t counted."
                : "Study time is being counted.")}
        </p>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap justify-center gap-3">
        {idle && (
          <Button size="lg" className="min-w-40 flex-1 sm:flex-none" disabled={!t.canStart} onClick={t.start}>
            <Play className="h-5 w-5" aria-hidden /> Start
          </Button>
        )}
        {state.status === "running" && (
          <Button size="lg" variant="secondary" className="min-w-40 flex-1 sm:flex-none" onClick={t.pause}>
            <Pause className="h-5 w-5" aria-hidden /> Pause
          </Button>
        )}
        {state.status === "paused" && (
          <Button size="lg" className="min-w-40 flex-1 sm:flex-none" onClick={t.resume}>
            <Play className="h-5 w-5" aria-hidden /> Resume
          </Button>
        )}
        {!idle && (
          <Button size="lg" variant="secondary" className="min-w-32 flex-1 sm:flex-none" onClick={t.stop}>
            <Square className="h-4 w-4" aria-hidden /> Stop
          </Button>
        )}
      </div>
      {idle && !t.classId && (
        <p className="mt-3 text-center text-xs text-muted-foreground">
          {classes.length === 0 ? (
            <>
              You have no classes yet.{" "}
              <Link href="/classes" className="font-medium text-primary">
                Create one
              </Link>{" "}
              to start.
            </>
          ) : (
            "Choose a class below to start."
          )}
        </p>
      )}

      {/* Setup */}
      <div className="mt-8 space-y-4 border-t border-border pt-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Select label="Class" value={t.classId} disabled={!idle} onChange={(e) => t.setClassId(e.target.value)}>
            <option value="">Select a class…</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select
            label="Subgroup (optional)"
            value={t.groupId}
            disabled={!idle || !cls || groups.length === 0}
            onChange={(e) => t.setGroupId(e.target.value)}
          >
            <option value="">{cls && groups.length === 0 ? "No subgroups yet" : "No subgroup"}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Timer mode</span>
          <SegmentedControl label="Timer mode" value={state.mode} options={MODES} onChange={t.setMode} disabled={!idle} />
        </div>

        {idle && state.mode === "countdown" && (
          <DurationInput
            initialMinutes={countdownMinutes}
            minMinutes={MIN_MINUTES}
            maxMinutes={MAX_MINUTES}
            onChange={t.setDurationMinutes}
          />
        )}
      </div>
    </Card>
  );
}
