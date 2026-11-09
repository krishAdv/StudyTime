"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useStudyData } from "@/features/data/study-data-provider";
import { useSettings } from "@/features/settings/settings-provider";
import {
  type ActiveSession,
  type ActiveSessionRecord,
  activeElapsedMs,
  defaultGetStorage,
  EMPTY_RECORD,
  LEGACY_ACTIVE_SESSION_KEY,
  parseActiveRecord,
  readActiveText,
  writeActiveRecord,
} from "@/lib/active-session";
import { findGroup } from "@/lib/class-tree";
import type { StorageLike } from "@/lib/data-store";
import { DEFAULT_TIMER_MODE } from "@/lib/timer-defaults";
import type { Session, TimerMode } from "@/lib/types";
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
  /**
   * Set while a session is active but could not be saved on this device (storage full or blocked): it keeps running
   * here, but would be lost if the app is closed or reloaded. Null otherwise.
   */
  persistWarning: string | null;
};

export const PERSIST_WARNING =
  "This session couldn’t be saved on this device, so it would be lost if StudyTime is closed or reloaded. Keep the app open until you stop it.";

const TimerContext = createContext<TimerContextValue | null>(null);

const elapsedOf = (s: TimerState, at: number) => activeElapsedMs(s, at);

/** The timer state for a stored active session (or idle, keeping `mode`, when there is none). */
function stateFromActive(a: ActiveSession | null, mode: TimerMode): TimerState {
  if (!a) return { ...INITIAL, mode };
  return {
    status: a.status,
    mode: a.mode,
    accumulatedMs: a.accumulatedMs,
    runStartedAt: a.runStartedAt,
    targetMs: a.targetMs,
    context: { sessionId: a.sessionId, startedAt: a.startedAt, classId: a.classId, groupId: a.groupId },
    message: null,
  };
}

function activeFromState(s: TimerState): ActiveSession | null {
  if (s.status === "idle" || !s.context) return null;
  return {
    ...s.context,
    mode: s.mode,
    status: s.status,
    accumulatedMs: s.accumulatedMs,
    runStartedAt: s.runStartedAt,
    targetMs: s.targetMs,
  };
}

const sameActive = (a: ActiveSession | null, b: ActiveSession | null) =>
  a === b || (a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));

/**
 * The timer. The session being timed is persisted on this device the moment it starts, pauses or resumes
 * (`lib/active-session.ts`), so a reload, or iOS killing the page in the background, never loses it: the provider
 * restores it before its first render and recomputes elapsed time from timestamps. Active sessions are local only;
 * a finished session goes into study data through `logSession` and syncs from there like any other.
 */
export function TimerProvider({
  children,
  persistKey = LEGACY_ACTIVE_SESSION_KEY,
  getStorage = defaultGetStorage,
}: {
  children: React.ReactNode;
  /** Where this data owner's active session is kept (`accountKey(userId, "active-session")` for an account). */
  persistKey?: string;
  /** Tests inject a fake storage; defaults to window.localStorage. */
  getStorage?: () => StorageLike | null;
}) {
  const { classes, sessions, logSession, status: dataStatus, saveError, staleTab } = useStudyData();
  const { countdownMinutes, setCountdownMinutes } = useSettings();

  // Read once, before the first render: a restored session shows immediately, never an empty timer first.
  const [restored] = useState(() => {
    const text = readActiveText(getStorage, persistKey);
    return { text, record: text === undefined ? EMPTY_RECORD : parseActiveRecord(text) };
  });

  const [state, setState] = useState<TimerState>(() => stateFromActive(restored.record.active, DEFAULT_TIMER_MODE));
  const [now, setNow] = useState(() => (typeof window === "undefined" ? 0 : Date.now()));
  const [selection, setSelection] = useState<Selection>(() => {
    const a = restored.record.active;
    return a ? { classId: a.classId, groupId: a.groupId ?? "" } : { classId: "", groupId: "" };
  });
  const [durationMinutes, setDurationState] = useState<number | null>(countdownMinutes);

  // Actions and the tick read the latest state synchronously from here, so a
  // double click or a tick racing a Stop can never save the same session twice.
  const stateRef = useRef(state);
  const commit = useCallback((next: TimerState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  // The persisted record as this tab last read or wrote it. `knownText` is the exact stored text (undefined when
  // storage can't be read): when the stored text differs, another tab of the same account changed it, and this tab
  // adopts that instead of acting on (or writing back) its outdated copy.
  const recordRef = useRef<ActiveSessionRecord>(restored.record);
  const knownText = useRef<string | null | undefined>(restored.text);
  // Whether the latest record failed to reach storage (quota, blocked or no storage). Never ignored: the UI warns while
  // a session is active, and the write is retried with every change and whenever the page is hidden or shown.
  const [persistFailed, setPersistFailed] = useState(false);
  const persistFailedRef = useRef(false);
  const persist = useCallback(
    (r: ActiveSessionRecord) => {
      recordRef.current = r;
      const text = writeActiveRecord(getStorage, persistKey, r);
      knownText.current = text;
      persistFailedRef.current = text === undefined;
      setPersistFailed(text === undefined);
    },
    [getStorage, persistKey],
  );
  const retryPersist = useCallback(() => {
    if (persistFailedRef.current) persist(recordRef.current);
  }, [persist]);

  /** Adds unsaved finished sessions to study data; keeps only those that still couldn't be saved. */
  const flushUnsaved = useCallback(() => {
    const r = recordRef.current;
    if (r.unsaved.length === 0) return;
    const left = r.unsaved.filter((s) => logSession(s) === "unsaved");
    if (left.length !== r.unsaved.length) persist({ ...recordRef.current, unsaved: left });
  }, [logSession, persist]);

  /**
   * Re-reads the stored record. If another tab changed it, adopts it (its active session, or idle) and returns
   * false so the caller doesn't act on outdated state. Returns true when this tab was up to date.
   */
  const syncFromStorage = useCallback((): boolean => {
    const text = readActiveText(getStorage, persistKey);
    if (text === undefined || knownText.current === undefined || text === knownText.current) return true;
    const r = parseActiveRecord(text);
    recordRef.current = r;
    knownText.current = text;
    const s = stateRef.current;
    if (!sameActive(activeFromState(s), r.active)) {
      commit(stateFromActive(r.active, s.mode));
      if (r.active) setSelection({ classId: r.active.classId, groupId: r.active.groupId ?? "" });
      setNow(Date.now());
    }
    return false;
  }, [commit, getStorage, persistKey]);

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
      const unsaved = recordRef.current.unsaved.filter((u) => u.id !== s.context?.sessionId);
      if (s.context && seconds >= 1) {
        const session: Session = {
          id: s.context.sessionId,
          classId: s.context.classId,
          groupId: s.context.groupId,
          startedAt: s.context.startedAt,
          seconds,
          mode: s.mode,
        };
        // Recorded as finished-but-unsaved first, so a page killed mid-save still has it on the next start; it
        // leaves the record only once study data holding it was written (or its class was deleted meanwhile).
        persist({ ...recordRef.current, active: null, unsaved: [...unsaved, session] });
        if (logSession(session) !== "unsaved") persist({ ...recordRef.current, unsaved });
      } else {
        persist({ ...recordRef.current, active: null, unsaved });
      }
      commit({
        ...INITIAL,
        mode: s.mode,
        message: seconds >= 1 ? `${verb} ${formatDuration(seconds)} logged.` : null,
      });
      setNow(Date.now());
    },
    [commit, logSession, persist],
  );

  const tick = useCallback(() => {
    const t = Date.now();
    setNow(t);
    const s = stateRef.current;
    if (s.status === "running" && s.targetMs !== null && elapsedOf(s, t) >= s.targetMs) {
      // Another tab may have stopped this session (and started another) meanwhile: follow it instead.
      if (!syncFromStorage()) return;
      // Completed (possibly while the tab was hidden or the app closed): record the full target, not the lateness.
      finish(s, Math.round(s.targetMs / 1000), "Session complete.");
    }
  }, [finish, syncFromStorage]);

  const running = state.status === "running";
  useEffect(() => {
    if (!running) return;
    // Timestamps are the source of truth; the interval only refreshes the UI and
    // catches completion. Browsers throttle it in background tabs, so also tick
    // as soon as the page becomes visible again, and once now: a restored
    // countdown may have ended while the app was closed.
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 250);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [running, tick]);

  const start = useCallback(() => {
    if (!syncFromStorage()) return;
    const s = stateRef.current;
    if (!classId || s.status !== "idle") return;
    const minutes = durationRef.current;
    if (s.mode === "countdown" && minutes === null) return;
    const t = Date.now();
    const next: TimerState = {
      ...s,
      status: "running",
      accumulatedMs: 0,
      runStartedAt: t,
      targetMs: s.mode === "countdown" && minutes !== null ? minutes * 60_000 : null,
      context: { sessionId: uid("session"), startedAt: t, classId, groupId: groupId || null },
      message: null,
    };
    // Persisted before anything else, so the session survives the page dying at any moment after Start.
    persist({ ...recordRef.current, active: activeFromState(next) });
    commit(next);
    setNow(t);
  }, [classId, groupId, commit, persist, syncFromStorage]);

  const pause = useCallback(() => {
    if (!syncFromStorage()) return;
    const s = stateRef.current;
    if (s.status !== "running") return;
    const t = Date.now();
    const next: TimerState = { ...s, status: "paused", accumulatedMs: elapsedOf(s, t), runStartedAt: null };
    persist({ ...recordRef.current, active: activeFromState(next) });
    commit(next);
    setNow(t);
  }, [commit, persist, syncFromStorage]);

  const resume = useCallback(() => {
    if (!syncFromStorage()) return;
    const s = stateRef.current;
    if (s.status !== "paused") return;
    const t = Date.now();
    const next: TimerState = { ...s, status: "running", runStartedAt: t };
    persist({ ...recordRef.current, active: activeFromState(next) });
    commit(next);
    setNow(t);
  }, [commit, persist, syncFromStorage]);

  const stop = useCallback(() => {
    if (!syncFromStorage()) return;
    const s = stateRef.current;
    if (s.status === "idle") return;
    let ms = elapsedOf(s, Date.now());
    if (s.targetMs !== null) ms = Math.min(ms, s.targetMs);
    finish(s, Math.round(ms / 1000), "Session stopped.");
  }, [finish, syncFromStorage]);

  // Another tab of the same account started, paused or stopped a session: follow it. Safari may not deliver the
  // storage event to a suspended tab, so also re-check when this one comes back (and every action re-checks first).
  useEffect(() => {
    const check = () => {
      syncFromStorage();
      flushUnsaved();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === persistKey) check();
    };
    const onVisible = () => {
      // Going to the background is the last chance before iOS may kill the page: retry a failed write then too.
      retryPersist();
      if (document.visibilityState === "visible") check();
    };
    const onShow = () => {
      retryPersist();
      check();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("pageshow", onShow);
    window.addEventListener("pagehide", retryPersist);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pageshow", onShow);
      window.removeEventListener("pagehide", retryPersist);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [persistKey, syncFromStorage, flushUnsaved, retryPersist]);

  // Finished sessions that couldn't be saved yet (page killed mid-save, data still loading, a failed write) are
  // added as soon as the data can take them, and again after a successful retry.
  const restoreChecked = useRef(false);
  useEffect(() => {
    if (dataStatus !== "ready" || saveError || staleTab) return;
    syncFromStorage();
    if (!restoreChecked.current) {
      restoreChecked.current = true;
      // A restored session that is already in study data was finished, but clearing its record failed (a failed
      // write): don't bring it back as running. Its saved copy stays as it is.
      const ctx = stateRef.current.context;
      if (ctx && sessions.some((s) => s.id === ctx.sessionId)) {
        persist({ ...recordRef.current, active: null });
        commit({ ...INITIAL, mode: stateRef.current.mode });
      }
    }
    flushUnsaved();
  }, [dataStatus, saveError, staleTab, sessions, syncFromStorage, flushUnsaved, persist, commit]);

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
  const persistWarning = persistFailed && state.status !== "idle" ? PERSIST_WARNING : null;

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
      persistWarning,
    }),
    [state, elapsedMs, displayMs, classId, groupId, durationMinutes, setDurationMinutes, canStart, setClassId, setGroupId, setMode, start, pause, resume, stop, persistWarning],
  );

  return <TimerContext.Provider value={value}>{children}</TimerContext.Provider>;
}

export function useTimer() {
  const ctx = useContext(TimerContext);
  if (!ctx) throw new Error("useTimer must be used within TimerProvider");
  return ctx;
}
