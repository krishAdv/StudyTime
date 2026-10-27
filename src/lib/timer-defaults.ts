import type { TimerMode } from "./types";

/**
 * Timer mode is not persisted: every page load starts in this mode. (Only the
 * countdown length is saved, under "studytime:countdown-minutes".)
 */
export const DEFAULT_TIMER_MODE: TimerMode = "stopwatch";
