"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  createClass, createGroup, removeGroup, renameClassIn, renameGroupIn, type Result,
} from "@/lib/class-rules";
import { findGroup } from "@/lib/class-tree";
import { removeKnownSeedData } from "@/lib/legacy-seed";
import { reassignSession, sessionsForGroup } from "@/lib/session-rules";
import { CLASS_COLORS, DATA_KEY, RESET_BACKUP_KEY, RESET_MARKER_KEY, parseStoredData, serializeData, type StoredData } from "@/lib/storage";
import type { ClassItem, Session } from "@/lib/types";
import { uid } from "@/lib/utils";

/**
 * Classes and sessions live in React state and are mirrored to localStorage.
 * localStorage is per device and browser; syncing across devices is future work.
 */
type StudyData = {
  classes: ClassItem[];
  sessions: Session[];
  /** Mutations validate first and return the reason when they are rejected; nothing changes then. */
  addClass: (name: string) => Result;
  renameClass: (id: string, name: string) => Result;
  deleteClass: (id: string) => void;
  /** `parentId` must be the class itself: subgroups can't contain subgroups. */
  addGroup: (classId: string, name: string, parentId?: string) => Result;
  renameGroup: (classId: string, groupId: string, name: string) => Result;
  deleteGroup: (classId: string, groupId: string) => void;
  /** Moves a saved session to another class/subgroup (null = no subgroup); nothing else about it changes. */
  reassignSession: (sessionId: string, classId: string, groupId: string | null) => Result;
  /** Idempotent: a session whose id is already stored is ignored. */
  logSession: (s: Session) => void;
  /** Total seconds for a class, or for the sessions logged directly to one of its groups. */
  secondsFor: (classId: string, groupId?: string | null) => number;
};

const StudyDataContext = createContext<StudyData | null>(null);

const FLATTEN_BACKUP_KEY = `${DATA_KEY}:pre-flatten-backup`;

const SEED_BACKUP_KEY = `${DATA_KEY}:pre-seed-cleanup-backup`;
const EMPTY: StoredData = { classes: [], sessions: [] };

/**
 * First run starts empty. Saved data always wins; an unreadable payload is kept
 * aside (never deleted) and the app starts empty. Payloads saved before version 2
 * go through the one-time removal of provably untouched sample records, with the
 * original kept under a backup key first. Backup keys are never removed.
 * Only reads storage in the browser; AppShell does not render children until
 * after hydration, so differing server/client state never reaches the markup.
 */
function loadInitial(): StoredData {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = localStorage.getItem(DATA_KEY);
    if (localStorage.getItem(RESET_MARKER_KEY) === null) {
      // One-time clean slate. Keep a recovery copy, never touch other keys
      // (settings, theme, existing backups), and mark it done so it can't repeat.
      if (raw !== null) {
        if (localStorage.getItem(RESET_BACKUP_KEY) === null) localStorage.setItem(RESET_BACKUP_KEY, raw);
        localStorage.removeItem(DATA_KEY);
      }
      localStorage.setItem(RESET_MARKER_KEY, new Date().toISOString());
      return EMPTY;
    }
    if (raw === null) return EMPTY;
    const parsed = parseStoredData(raw);
    if (!parsed) {
      localStorage.setItem(`${DATA_KEY}:corrupt`, raw);
      return EMPTY;
    }
    // Keep the original aside the first time deep nesting is flattened.
    if (parsed.flattened && localStorage.getItem(FLATTEN_BACKUP_KEY) === null) {
      localStorage.setItem(FLATTEN_BACKUP_KEY, raw);
    }
    let data: StoredData = { classes: parsed.classes, sessions: parsed.sessions };
    if (parsed.fromVersion < 2) {
      const cleaned = removeKnownSeedData(data);
      if (cleaned.removed) {
        if (localStorage.getItem(SEED_BACKUP_KEY) === null) localStorage.setItem(SEED_BACKUP_KEY, raw);
        data = cleaned.data;
      }
    }
    return data;
  } catch {
    // Storage unavailable: run in memory, empty.
    return EMPTY;
  }
}

export function StudyDataProvider({ children }: { children: React.ReactNode }) {
  const [initial] = useState(loadInitial);
  const [classes, setClasses] = useState<ClassItem[]>(initial.classes);
  const [sessions, setSessionsState] = useState<Session[]>(initial.sessions);
  const sessionsRef = useRef(initial.sessions);
  const setSessions = useCallback((fn: (prev: Session[]) => Session[]) => {
    sessionsRef.current = fn(sessionsRef.current);
    setSessionsState(sessionsRef.current);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(DATA_KEY, serializeData({ classes, sessions }));
    } catch {
      // Quota or private mode: keep working in memory.
    }
  }, [classes, sessions]);

  // Mutations read the latest classes synchronously so they can validate and
  // report the outcome to the caller; every class change goes through here.
  const classesRef = useRef(classes);
  const applyClasses = useCallback((r: Result<ClassItem[]>): Result => {
    if (!r.ok) return r;
    classesRef.current = r.value;
    setClasses(r.value);
    return { ok: true, value: undefined };
  }, []);

  const addClass = useCallback(
    (name: string) => {
      const cur = classesRef.current;
      return applyClasses(createClass(cur, name, uid("class"), CLASS_COLORS[cur.length % CLASS_COLORS.length]));
    },
    [applyClasses],
  );

  const renameClass = useCallback(
    (id: string, name: string) => applyClasses(renameClassIn(classesRef.current, id, name)),
    [applyClasses],
  );

  const deleteClass = useCallback((id: string) => {
    classesRef.current = classesRef.current.filter((c) => c.id !== id);
    setClasses(classesRef.current);
    setSessions((prev) => prev.filter((s) => s.classId !== id));
  }, [setSessions]);

  const addGroup = useCallback(
    (classId: string, name: string, parentId?: string) =>
      applyClasses(createGroup(classesRef.current, classId, name, uid("group"), parentId)),
    [applyClasses],
  );

  const renameGroup = useCallback(
    (classId: string, groupId: string, name: string) =>
      applyClasses(renameGroupIn(classesRef.current, classId, groupId, name)),
    [applyClasses],
  );

  const deleteGroup = useCallback((classId: string, groupId: string) => {
    classesRef.current = removeGroup(classesRef.current, classId, groupId);
    setClasses(classesRef.current);
    // Sessions stay attributed to the class; they just lose their group.
    setSessions((prev) =>
      prev.map((s) => (s.classId === classId && s.groupId === groupId ? { ...s, groupId: null } : s)),
    );
  }, [setSessions]);

  const logSession = useCallback((s: Session) => {
    // The class or subgroup may have been deleted while the timer was running.
    // A deleted class takes its sessions with it, and a deleted subgroup leaves
    // its sessions on the class, so a late save follows the same rules.
    const cls = classesRef.current.find((c) => c.id === s.classId);
    if (!cls) return;
    const session = s.groupId && !findGroup(cls.groups, s.groupId) ? { ...s, groupId: null } : s;
    setSessions((prev) => (prev.some((p) => p.id === session.id) ? prev : [session, ...prev]));
  }, [setSessions]);

  const reassign = useCallback(
    (sessionId: string, classId: string, groupId: string | null): Result => {
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
      classes, sessions, addClass, renameClass, deleteClass,
      addGroup, renameGroup, deleteGroup, reassignSession: reassign, logSession, secondsFor,
    }),
    [classes, sessions, addClass, renameClass, deleteClass, addGroup, renameGroup, deleteGroup, reassign, logSession, secondsFor],
  );

  return <StudyDataContext.Provider value={value}>{children}</StudyDataContext.Provider>;
}

export function useStudyData() {
  const ctx = useContext(StudyDataContext);
  if (!ctx) throw new Error("useStudyData must be used within StudyDataProvider");
  return ctx;
}
