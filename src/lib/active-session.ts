import type { StorageLike } from "./data-store";
import type { Session, TimerMode } from "./types";

/**
 * The timer's on-device record, so a running or paused session survives the page being reloaded or killed
 * (iOS discards a backgrounded web app's page after a while; reopening it starts the app from scratch).
 *
 * Active sessions are LOCAL ONLY: they belong to the device (and account) that started them, are never
 * exported and never synced. Only a finished session becomes a normal `Session` in study data, which the
 * existing save and sync paths then handle.
 *
 * One key per data owner (`studytime:u:<userId>:active-session`, or `studytime:active-session` for the
 * local-only legacy bucket) holds:
 *  - `active`: the session being timed, or null. Timestamps are the truth: elapsed time is always
 *    recomputed from `accumulatedMs` + (now - `runStartedAt`), never counted by an interval.
 *  - `unsaved`: finished sessions written here BEFORE they are added to study data, removed only once that
 *    data was saved. If the page dies in between, or the save could not happen (stale tab, storage error),
 *    they are added again on the next start; `logSession` is idempotent by id, so retries never duplicate.
 */
export const ACTIVE_SESSION_VERSION = 1;
export const LEGACY_ACTIVE_SESSION_KEY = "studytime:active-session";

export type ActiveSession = {
  sessionId: string;
  classId: string;
  groupId: string | null;
  /** Epoch ms the session began (becomes `Session.startedAt`). */
  startedAt: number;
  mode: TimerMode;
  status: "running" | "paused";
  /** Study ms before the current run segment (pauses excluded). */
  accumulatedMs: number;
  /** Epoch ms the current run segment began; non-null exactly while running. */
  runStartedAt: number | null;
  /** Countdown length in ms; null for the stopwatch. */
  targetMs: number | null;
};

export type ActiveSessionRecord = {
  version: typeof ACTIVE_SESSION_VERSION;
  active: ActiveSession | null;
  unsaved: Session[];
};

export const EMPTY_RECORD: ActiveSessionRecord = { version: ACTIVE_SESSION_VERSION, active: null, unsaved: [] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isMode = (v: unknown): v is TimerMode => v === "stopwatch" || v === "countdown";

function parseActive(v: unknown): ActiveSession | null {
  if (!isObj(v)) return null;
  const { sessionId, classId, groupId, startedAt, mode, status, accumulatedMs, runStartedAt, targetMs } = v;
  if (!isId(sessionId) || !isId(classId) || !(groupId === null || isId(groupId))) return null;
  if (!isTime(startedAt) || !isMode(mode) || !isTime(accumulatedMs)) return null;
  if (status === "running" ? !isTime(runStartedAt) : status !== "paused" || runStartedAt !== null) return null;
  if (mode === "countdown" ? !(isTime(targetMs) && targetMs > 0) : targetMs !== null) return null;
  return {
    sessionId, classId, groupId, startedAt, mode, accumulatedMs,
    status: status as "running" | "paused",
    runStartedAt: runStartedAt as number | null,
    targetMs: targetMs as number | null,
  };
}

function parseSession(v: unknown): Session | null {
  if (!isObj(v)) return null;
  const { id, classId, groupId, startedAt, seconds, mode } = v;
  if (!isId(id) || !isId(classId) || !(groupId === null || isId(groupId))) return null;
  if (!isTime(startedAt) || !(Number.isInteger(seconds) && (seconds as number) >= 1) || !isMode(mode)) return null;
  return { id, classId, groupId, startedAt, seconds: seconds as number, mode };
}

/** Strict parse; anything unreadable is treated as no record (an unreadable record can't be resumed safely). */
export function parseActiveRecord(raw: string | null): ActiveSessionRecord {
  if (raw === null) return EMPTY_RECORD;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return EMPTY_RECORD;
  }
  if (!isObj(v) || v.version !== ACTIVE_SESSION_VERSION) return EMPTY_RECORD;
  const active = v.active === null ? null : parseActive(v.active);
  const unsaved = Array.isArray(v.unsaved)
    ? v.unsaved.map(parseSession).filter((s): s is Session => s !== null)
    : [];
  return { version: ACTIVE_SESSION_VERSION, active, unsaved };
}

export const isEmptyRecord = (r: ActiveSessionRecord) => r.active === null && r.unsaved.length === 0;

/** The stored text for a record; an empty record is stored as "no key" (null). */
export const serializeActiveRecord = (r: ActiveSessionRecord): string | null =>
  isEmptyRecord(r) ? null : JSON.stringify(r);

/** Study ms of an active session at `now` (never negative, e.g. if the clock moved back). */
export const activeElapsedMs = (a: Pick<ActiveSession, "accumulatedMs" | "runStartedAt">, now: number) =>
  Math.max(0, a.accumulatedMs + (a.runStartedAt !== null ? now - a.runStartedAt : 0));

/** Reads the stored text; undefined when storage can't be read (then nothing is persisted or compared). */
export function readActiveText(getStorage: () => StorageLike | null, key: string): string | null | undefined {
  try {
    const s = getStorage();
    return s ? s.getItem(key) : undefined;
  } catch {
    return undefined;
  }
}

/** Writes (or removes, for an empty record) the record. Returns the stored text, or undefined if it failed. */
export function writeActiveRecord(
  getStorage: () => StorageLike | null,
  key: string,
  r: ActiveSessionRecord,
): string | null | undefined {
  const text = serializeActiveRecord(r);
  try {
    const s = getStorage();
    if (!s) return undefined;
    if (text === null) s.removeItem(key);
    else s.setItem(key, text);
    return text;
  } catch {
    return undefined;
  }
}

export const defaultGetStorage = (): StorageLike | null => (typeof window === "undefined" ? null : window.localStorage);
