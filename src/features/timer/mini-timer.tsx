"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTimer } from "./timer-provider";
import { clockParts } from "@/lib/utils";

/** Floating reminder that a timer is active while browsing other screens. */
export function MiniTimer() {
  const pathname = usePathname();
  const { state, displayMs } = useTimer();
  if (state.status === "idle" || pathname === "/") return null;

  const { hours, minutes, seconds } = clockParts(displayMs);

  return (
    <Link
      href="/"
      className="fixed right-4 z-30 flex h-11 items-center gap-2 rounded-full border border-border bg-card px-4 text-sm font-medium shadow-sm bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] md:bottom-6 md:right-6"
      aria-label={`Study timer ${state.status}, open dashboard`}
    >
      <span
        className={`h-2 w-2 rounded-full bg-primary ${state.status === "paused" ? "opacity-40" : ""}`}
        aria-hidden
      />
      <span className="tabular-nums">
        {hours}:{minutes}:{seconds}
      </span>
      <span className="text-muted-foreground">{state.status === "paused" ? "Paused" : "Studying"}</span>
    </Link>
  );
}
