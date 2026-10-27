/**
 * A subgroup of a class. Groups are exactly one level deep: every group belongs
 * directly to a class and can never contain another group.
 */
export type GroupNode = {
  id: string;
  name: string;
};

export type ClassItem = {
  id: string;
  name: string;
  /** Hex colour used for dots and chart bars. */
  color: string;
  /** Direct subgroups of this class (one level only). */
  groups: GroupNode[];
};

export type TimerMode = "countdown" | "stopwatch";

/** A completed block of study time. Paused time is never included. */
export type Session = {
  id: string;
  classId: string;
  groupId: string | null;
  /** Epoch ms. */
  startedAt: number;
  /** Actual elapsed study seconds. */
  seconds: number;
  mode: TimerMode;
};
