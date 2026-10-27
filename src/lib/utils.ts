import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

let counter = 0;
export function uid(prefix = "id") {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 6)}`;
}

const pad = (n: number) => n.toString().padStart(2, "0");

/** Splits milliseconds into zero-padded clock parts. */
export function clockParts(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return {
    hours: pad(Math.floor(total / 3600)),
    minutes: pad(Math.floor((total % 3600) / 60)),
    seconds: pad(total % 60),
  };
}

/** "1h 25m", "25m", "40s" */
export function formatDuration(totalSeconds: number) {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function startOfDay(ms: number) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dayLabel(ms: number, now: number) {
  const diff = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

export function timeLabel(ms: number) {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

/** Local calendar-day key like "2026-10-26". */
export function dayKey(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
