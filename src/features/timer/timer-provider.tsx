"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useStudyData } from "@/features/data/study-data-provider";
import { useSettings } from "@/features/settings/settings-provider";
import { findGroup } from "@/lib/class-tree";
import { DEFAULT_TIMER_MODE } from "@/lib/timer-defaults";
import type { TimerMode } from "@/lib/types";
import { formatDuration, uid } from "@/lib/utils";

export type TimerStatus = "idle" | "running" | "paused";

type TimerState = {
  status: TimerStatus;
  mode: TimerMode;
  /** Study ms accumulated before the current run segment (excludes pauses). */
  accumulatedMs: number;
  /** Timestamp the current run segment began, null while idle or paused. */
  runStartedAt: number | null;
  /** Countdown length in ms, or null for the open-ended stopwatch. */
  targetMs: number | null;
  /** Locked in when the session began; the id makes saving idempotent. */
  context: { sessionId: string; startedAt: number; classId: string; groupId: string | null } | null;
  message: string | null;
};

const INITIAL: TimerState = {
  status: "idle",
  mode: DEFAULT_TIMER_MODE,
  accumulatedMs: 0,
  runStartedAt: null,
  targetMs: null,
  context: null,
  message: null,
};

type Selection = { classId: string; groupId: string };

type TimerContextValue = {
  state: TimerState;
  /** Study milliseconds elapsed in the current session. */
  elapsedMs: number;
  /** What the big clock shows: remaining for countdowns, elapsed for the stopwatch. */
  displayMs: number;
  /** 0–1 progress for countdowns, null for the stopwatch. */
  progress: number | null;
  /** Selected class id ("" when none), validated against existing classes. */
  classId: string;
  groupId: string;
  /** Valid countdown minutes currently entered, or null while the input is invalid. */
  durationMinutes: number | null;
  setDurationMinutes: (m: number | null) => void;
  /** True when Start would work (class chosen and, for countdowns, a valid duration). */
  canStart: boolean;
  setClassId: (id: string) => void;
  setGroupId: (id: string) => void;
  setMode: (mode: TimerMode) => void;
  start: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
};

const TimerContext = createContext<TimerContextValue | null>(null);

const elapsedOf = (s: TimerState, at: number) =>
  Math.max(0, s.accumulatedMs + (s.runStartedAt !== null ? at - s.runStartedAt : 0));

export function TimerProvider({ children }: { children: React.ReactNode }) {
  const { classes, logSession } = useStudyData();
  const { countdownMinutes, setCountdownMinutes } = useSettings();

  const [state, setState] = useState<TimerState>(INITIAL);
  const [now, setNow] = useState(() => (typeof window === "undefined" ? 0 : Date.now()));
  const [selection, setSelection] = useState<Selection>({ classId: "", groupId: "" });
  const [durationMinutes, setDurationState] = useState<number | null>(countdownMinutes);

  // Actions and the tick read the latest state synchronously from here, so a
  // double click or a tick racing a Stop can never save the same session twice.
  const stateRef = useRef(state);
  const commit = useCallback((next: TimerState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const selectedClass = classes.find((c) => c.id === selection.classId);
  const classId = selectedClass?.id ?? "";
  const groupId =
    selectedClass && findGroup(selectedClass.groups, selection.groupId) ? selection.groupId : "";

  const setDurationMinutes = useCallback(
    (m: number | null) => {
      setDurationState(m);
      if (m !== null) setCountdownMinutes(m);
    },
    [setCountdownMinutes],
  );

  const durationRef = useRef(durationMinutes);
  useEffect(() => {
    durationRef.current = durationMinutes;
  }, [durationMinutes]);

  /** Saves the elapsed study time (if any) and returns to idle. */
  const finish = useCallback(
    (s: TimerState, seconds: number, verb: string) => {
      if (s.context && seconds >= 1) {
        logSession({
          id: s.context.sessionId,
          classId: s.context.classId,
          groupId: s.context.groupId,
          startedAt: s.context.startedAt,
          seconds,
          mode: s.mode,
        });
      }
      commit({
        ...INITIAL,
        mode: s.mode,
        message: seconds >= 1 ? `${verb} ${formatDuration(seconds)} logged.` : null,
      });
      setNow(Date.now());
    },
    [commit, logSession],
  );

  const tick = useCallback(() => {
    const t = Date.now();
    setNow(t);
    const s = stateRef.current;
    if (s.status === "running" && s.targetMs !== null && elapsedOf(s, t) >= s.targetMs) {
      // Completed (possibly while the tab was hidden): record the full target, not the lateness.
      finish(s, Math.round(s.targetMs / 1000), "Session complete.");
    }
  }, [finish]);

  const running = state.status === "running";
  useEffect(() => {
    if (!running) return;
    // Timestamps are the source of truth; the interval only refreshes the UI and
    // catches completion. Browsers throttle it in background tabs, so also tick
    // as soon as the page becomes visible again.
    const id = window.setInterval(tick, 250);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [running, tick]);

  const start = useCallback(() => {
    const s = stateRef.current;
    if (!classId || s.status !== "idle") return;
    const minutes = durationRef.current;
    if (s.mode === "countdown" && minutes === null) return;
    const t = Date.now();
    commit({
      ...s,
      status: "running",
      accumulatedMs: 0,
      runStartedAt: t,
      targetMs: s.mode === "countdown" && minutes !== null ? minutes * 60_000 : null,
      context: { sessionId: uid("session"), startedAt: t, classId, groupId: groupId || null },
      message: null,
    });
    setNow(t);
  }, [classId, groupId, commit]);

  const pause = useCallback(() => {
    const s = stateRef.current;
    if (s.status !== "running") return;
    const t = Date.now();
    commit({ ...s, status: "paused", accumulatedMs: elapsedOf(s, t), runStartedAt: null });
    setNow(t);
  }, [commit]);

  const resume = useCallback(() => {
    const s = stateRef.current;
    if (s.status !== "paused") return;
    const t = Date.now();
    commit({ ...s, status: "running", runStartedAt: t });
    setNow(t);
  }, [commit]);

  const stop = useCallback(() => {
    const s = stateRef.current;
    if (s.status === "idle") return;
    let ms = elapsedOf(s, Date.now());
    if (s.targetMs !== null) ms = Math.min(ms, s.targetMs);
    finish(s, Math.round(ms / 1000), "Session stopped.");
  }, [finish]);

  const setMode = useCallback(
    (mode: TimerMode) => {
      const s = stateRef.current;
      if (s.status !== "idle") return;
      commit({ ...s, mode, message: null });
    },
    [commit],
  );

  const setClassId = useCallback((id: string) => setSelection({ classId: id, groupId: "" }), []);
  const setGroupId = useCallback((id: string) => setSelection((p) => ({ ...p, groupId: id })), []);

  const elapsedMs = elapsedOf(state, now);
  const idle = state.status === "idle";
  const displayMs =
    state.targetMs !== null
      ? Math.max(0, state.targetMs - elapsedMs)
      : idle && state.mode === "countdown"
        ? // Preview the length Start would use.
          (durationMinutes ?? 0) * 60_000
        : elapsedMs;
  const canStart = !!classId && (state.mode === "stopwatch" || durationMinutes !== null);

  const value = useMemo<TimerContextValue>(
    () => ({
      state,
      elapsedMs,
      displayMs,
      progress: state.targetMs !== null ? Math.min(1, elapsedMs / state.targetMs) : null,
      classId,
      groupId,
      durationMinutes,
      setDurationMinutes,
      canStart,
      setClassId,
      setGroupId,
      setMode,
      start,
      pause,
      resume,
      stop,
    }),
    [state, elapsedMs, displayMs, classId, groupId, durationMinutes, setDurationMinutes, canStart, setClassId, setGroupId, setMode, start, pause, resume, stop],
  );

  return <TimerContext.Provider value={value}>{children}</TimerContext.Provider>;
}

export function useTimer() {
  const ctx = useContext(TimerContext);
  if (!ctx) throw new Error("useTimer must be used within TimerProvider");
  return ctx;
}
