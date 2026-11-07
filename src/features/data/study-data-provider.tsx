"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  createClass, createGroup, removeGroup, renameClassIn, renameGroupIn, updateClassIn, type Result,
} from "@/lib/class-rules";
import { findGroup } from "@/lib/class-tree";
import { localStorageStore, type StudyDataStore } from "@/lib/data-store";
import { validateStudyData } from "@/lib/data-export";
import { createSerialWriter, isPromise } from "@/lib/serial-writer";
import { reassignSession, sessionsForGroup } from "@/lib/session-rules";
import { defaultClassColor } from "@/lib/class-colors";
import type { StoredData } from "@/lib/storage";
import type { ClassItem, Session } from "@/lib/types";
import { uid } from "@/lib/utils";

/**
 * Classes and sessions live in React state and are mirrored to a StudyDataStore
 * (localStorage today: per device and browser; syncing across devices is future work).
 */
export type DataStatus = "loading" | "ready" | "error";

type StudyData = {
  /**
   * "loading" and "error" mean classes/sessions are not real data yet, only a
   * placeholder; nothing is saved and mutations are refused until "ready".
   */
  status: DataStatus;
  loadError: string | null;
  /** Starts another load after a failed one. */
  retryLoad: () => void;
  /** True while the latest snapshot could not be saved. Nothing is discarded: it is retried on the next change or here. */
  saveError: boolean;
  retrySave: () => void;
  /**
   * True once ANOTHER TAB changed this account's stored data after this tab last read or wrote it. This tab's copy is then
   * out of date: it saves nothing, it does not sync, and changes are refused (a finished study session is still kept in
   * memory so it isn't lost silently, and can be downloaded). It stays true until the tab is reloaded.
   */
  staleTab: boolean;
  classes: ClassItem[];
  sessions: Session[];
  /** Mutations validate first and return the reason when they are rejected; nothing changes then. */
  /** `color` (`#rrggbb`) is optional; without it the class gets the first preset no class uses yet. */
  addClass: (name: string, color?: string) => Result;
  renameClass: (id: string, name: string) => Result;
  /** Changes a class's name and/or color atomically; an unchanged edit is a no-op. */
  updateClass: (id: string, changes: { name?: string; color?: string }) => Result;
  deleteClass: (id: string) => void;
  /** `parentId` must be the class itself: subgroups can't contain subgroups. */
  addGroup: (classId: string, name: string, parentId?: string) => Result;
  renameGroup: (classId: string, groupId: string, name: string) => Result;
  deleteGroup: (classId: string, groupId: string) => void;
  /**
   * Replaces ALL classes and sessions with validated data (used by import). Refused until
   * "ready"; invalid data changes nothing. The new data is saved like any other change.
   */
  replaceAllData: (data: StoredData) => Result;
  /** Moves a saved session to another class/subgroup (null = no subgroup); nothing else about it changes. */
  reassignSession: (sessionId: string, classId: string, groupId: string | null) => Result;
  /** Idempotent: a session whose id is already stored is ignored. */
  logSession: (s: Session) => void;
  /** Total seconds for a class, or for the sessions logged directly to one of its groups. */
  secondsFor: (classId: string, groupId?: string | null) => number;
  /**
   * For the sync engine only. `getData` returns the current data and the SAME object until something changes;
   * `applyData` replaces everything with `next` only if the data is still exactly `expected` (returns false and
   * changes nothing otherwise, or when not ready or `next` is invalid), so a session saved during a sync is never
   * overwritten. Applied data is saved like any other change.
   */
  syncBridge: {
    getData: () => StoredData;
    applyData: (expected: StoredData, next: StoredData) => boolean;
    /** True if another tab changed this account's stored data (checked against storage right now). Sync must not push then. */
    isStale: () => boolean;
  };
};

const StudyDataContext = createContext<StudyData | null>(null);

const NOT_READY = { ok: false, error: "Your data is still loading." } as const;
const STALE = { ok: false, error: "StudyTime was changed in another tab. Reload this tab before making changes." } as const;

export function StudyDataProvider({
  children,
  store = localStorageStore,
}: {
  children: React.ReactNode;
  /** Where data is loaded from and saved to; defaults to this browser's localStorage. */
  store?: StudyDataStore;
}) {
  // AppShell does not render children until after hydration, so a differing
  // server/client initial state never reaches the markup.
  // A synchronous store (localStorage) is ready on the first render. An async
  // store starts in "loading" with placeholder empty arrays that are never saved.
  // Stores should reject rather than throw, and `store` is not expected to change.
  const [first] = useState(() => store.load());
  const initial = isPromise(first) ? null : first;
  const [status, setStatus] = useState<DataStatus>(initial ? "ready" : "loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [classes, setClasses] = useState<ClassItem[]>(initial?.classes ?? []);
  const [sessions, setSessionsState] = useState<Session[]>(initial?.sessions ?? []);
  const readyRef = useRef(initial !== null);

  // Cross-tab protection: the store tells us when another tab changed the stored data (see createAccountStore). From then
  // on this tab's copy is stale: no saves (the store refuses), no sync, no changes, until it is reloaded.
  const [staleTab, setStaleTab] = useState(false);
  const staleRef = useRef(false);
  useEffect(() => {
    if (!store.watch) return;
    return store.watch(() => {
      staleRef.current = true;
      setStaleTab(true);
    });
  }, [store]);
  const sessionsRef = useRef(sessions);
  const setSessions = useCallback((fn: (prev: Session[]) => Session[]) => {
    sessionsRef.current = fn(sessionsRef.current);
    setSessionsState(sessionsRef.current);
  }, []);

  // Mutations read the latest classes synchronously so they can validate and
  // report the outcome to the caller; every class change goes through here.
  const classesRef = useRef(classes);

  // Each load attempt gets a token; a result from an older attempt (or after
  // unmount) is ignored, so a slow first load can't overwrite a retry.
  const loadToken = useRef(0);
  const track = useCallback((p: PromiseLike<StoredData>) => {
    const token = ++loadToken.current;
    p.then(
      (data) => {
        if (token !== loadToken.current) return;
        classesRef.current = data.classes;
        sessionsRef.current = data.sessions;
        readyRef.current = true;
        setClasses(data.classes);
        setSessionsState(data.sessions);
        setLoadError(null);
        setStatus("ready");
      },
      (e: unknown) => {
        if (token !== loadToken.current) return;
        setLoadError(e instanceof Error && e.message ? e.message : "Couldn't load your data.");
        setStatus("error");
      },
    );
  }, []);

  const cancelLoads = useCallback(() => {
    loadToken.current++;
  }, []);
  useEffect(() => {
    if (isPromise(first)) track(first as PromiseLike<StoredData>);
    return cancelLoads;
  }, [first, track, cancelLoads]);

  const retryLoad = useCallback(() => {
    if (readyRef.current) return;
    setLoadError(null);
    setStatus("loading");
    try {
      track(Promise.resolve(store.load()));
    } catch (e) {
      track(Promise.reject(e));
    }
  }, [store, track]);

  // Whole-snapshot writes go through a serial writer: one in flight, newest wins,
  // a failed snapshot stays marked unsaved. Never submitted before a successful load.
  const [saveError, setSaveError] = useState(false);
  const [writer] = useState(() => createSerialWriter<StoredData>((d) => store.save(d), setSaveError));
  useEffect(() => {
    if (status === "ready") writer.submit({ classes, sessions });
  }, [status, classes, sessions, writer]);
  const retrySave = useCallback(() => writer.retry(), [writer]);

  const applyClasses = useCallback((r: Result<ClassItem[]>): Result => {
    if (!r.ok) return r;
    classesRef.current = r.value;
    setClasses(r.value);
    return { ok: true, value: undefined };
  }, []);

  const addClass = useCallback(
    (name: string, color?: string) => {
      if (!readyRef.current) return NOT_READY;
      if (staleRef.current) return STALE;
      const cur = classesRef.current;
      return applyClasses(createClass(cur, name, uid("class"), color ?? defaultClassColor(cur)));
    },
    [applyClasses],
  );

  const updateClass = useCallback(
    (id: string, changes: { name?: string; color?: string }) => {
      if (!readyRef.current) return NOT_READY;
      if (staleRef.current) return STALE;
      const r = updateClassIn(classesRef.current, id, changes);
      // Unchanged: keep the same array so nothing is saved or synced for a no-op edit.
      if (r.ok && r.value === classesRef.current) return { ok: true, value: undefined } as const;
      return applyClasses(r);
    },
    [applyClasses],
  );

  const renameClass = useCallback(
    (id: string, name: string) =>
      !readyRef.current ? NOT_READY : staleRef.current ? STALE : applyClasses(renameClassIn(classesRef.current, id, name)),
    [applyClasses],
  );

  const deleteClass = useCallback((id: string) => {
    if (!readyRef.current || staleRef.current) return;
    classesRef.current = classesRef.current.filter((c) => c.id !== id);
    setClasses(classesRef.current);
    setSessions((prev) => prev.filter((s) => s.classId !== id));
  }, [setSessions]);

  const addGroup = useCallback(
    (classId: string, name: string, parentId?: string) =>
      !readyRef.current
        ? NOT_READY
        : staleRef.current
          ? STALE
          : applyClasses(createGroup(classesRef.current, classId, name, uid("group"), parentId)),
    [applyClasses],
  );

  const renameGroup = useCallback(
    (classId: string, groupId: string, name: string) =>
      !readyRef.current ? NOT_READY : staleRef.current ? STALE : applyClasses(renameGroupIn(classesRef.current, classId, groupId, name)),
    [applyClasses],
  );

  const deleteGroup = useCallback((classId: string, groupId: string) => {
    if (!readyRef.current || staleRef.current) return;
    classesRef.current = removeGroup(classesRef.current, classId, groupId);
    setClasses(classesRef.current);
    // Sessions stay attributed to the class; they just lose their group.
    setSessions((prev) =>
      prev.map((s) => (s.classId === classId && s.groupId === groupId ? { ...s, groupId: null } : s)),
    );
  }, [setSessions]);

  const logSession = useCallback((s: Session) => {
    // Not reachable from the UI before "ready": the timer can't start without a class.
    if (!readyRef.current) return;
    // Deliberately NOT blocked in a stale tab: a session that was timed in this tab is kept in memory (visible, and part
    // of "Download this tab's data") so it is never dropped silently. It is not saved and not synced from here.
    // The class or subgroup may have been deleted while the timer was running.
    // A deleted class takes its sessions with it, and a deleted subgroup leaves
    // its sessions on the class, so a late save follows the same rules.
    const cls = classesRef.current.find((c) => c.id === s.classId);
    if (!cls) return;
    const session = s.groupId && !findGroup(cls.groups, s.groupId) ? { ...s, groupId: null } : s;
    setSessions((prev) => (prev.some((p) => p.id === session.id) ? prev : [session, ...prev]));
  }, [setSessions]);

  const replaceAllData = useCallback(
    (data: StoredData): Result => {
      if (!readyRef.current) return NOT_READY;
      if (staleRef.current) return STALE;
      const v = validateStudyData(data);
      if (!v.ok) return v;
      classesRef.current = v.value.classes;
      sessionsRef.current = v.value.sessions;
      setClasses(v.value.classes);
      setSessionsState(v.value.sessions);
      return { ok: true, value: undefined };
    },
    [],
  );

  const isStale = useCallback((): boolean => {
    store.checkNow?.();
    return staleRef.current;
  }, [store]);
  const cacheRef = useRef<{ c: ClassItem[]; s: Session[]; data: StoredData } | null>(null);
  const getData = useCallback((): StoredData => {
    const c = classesRef.current;
    const s = sessionsRef.current;
    const hit = cacheRef.current;
    if (hit && hit.c === c && hit.s === s) return hit.data;
    const data = { classes: c, sessions: s };
    cacheRef.current = { c, s, data };
    return data;
  }, []);
  const applyData = useCallback(
    (expected: StoredData, next: StoredData): boolean => {
      if (!readyRef.current || isStale() || getData() !== expected) return false;
      const v = validateStudyData(next);
      if (!v.ok) return false;
      classesRef.current = v.value.classes;
      sessionsRef.current = v.value.sessions;
      setClasses(v.value.classes);
      setSessionsState(v.value.sessions);
      return true;
    },
    [getData, isStale],
  );
  const syncBridge = useMemo(() => ({ getData, applyData, isStale }), [getData, applyData, isStale]);

  const reassign = useCallback(
    (sessionId: string, classId: string, groupId: string | null): Result => {
      if (!readyRef.current) return NOT_READY;
      if (staleRef.current) return STALE;
      const r = reassignSession(classesRef.current, sessionsRef.current, sessionId, classId, groupId);
      if (!r.ok) return r;
      setSessions(() => r.value);
      return { ok: true, value: undefined };
    },
    [setSessions],
  );

  const secondsFor = useCallback(
    (classId: string, groupId?: string | null) =>
      (groupId
        ? sessionsForGroup(sessions, classId, groupId)
        : sessions.filter((s) => s.classId === classId)
      ).reduce((n, s) => n + s.seconds, 0),
    [sessions],
  );

  const value = useMemo(
    () => ({
      status, loadError, retryLoad, saveError, retrySave, staleTab,
      classes, sessions, addClass, renameClass, updateClass, deleteClass,
      addGroup, renameGroup, deleteGroup, replaceAllData, reassignSession: reassign, logSession, secondsFor, syncBridge,
    }),
    [syncBridge, status, loadError, retryLoad, saveError, retrySave, staleTab, classes, sessions, addClass, renameClass, updateClass, deleteClass, addGroup, renameGroup, deleteGroup, replaceAllData, reassign, logSession, secondsFor],
  );

  return <StudyDataContext.Provider value={value}>{children}</StudyDataContext.Provider>;
}

export function useStudyData() {
  const ctx = useContext(StudyDataContext);
  if (!ctx) throw new Error("useStudyData must be used within StudyDataProvider");
  return ctx;
}
