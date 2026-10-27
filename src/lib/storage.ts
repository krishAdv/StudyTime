import { flattenLegacyGroups } from "./class-tree";
import type { ClassItem, Session, TimerMode } from "./types";

export const DATA_KEY = "studytime:data";
/**
 * 1: original format. 2: the one-time sample-data cleanup has been applied
 * (see legacy-seed.ts). Version 1 payloads are still read, then saved as 2.
 */
export const DATA_VERSION = 2;
/**
 * One-time reset (2026-10-27): the first load that does not find this marker
 * moves the active dataset to RESET_BACKUP_KEY, clears it, and writes the marker,
 * so the reset can never run again. Only DATA_KEY is ever cleared.
 */
export const RESET_MARKER_KEY = "studytime:reset:2026-10-27";
export const RESET_BACKUP_KEY = `${DATA_KEY}:pre-reset-backup`;
export const CLASS_COLORS = ["#3b82f6", "#8b5cf6", "#f59e0b", "#10b981", "#ec4899", "#14b8a6"];

export type StoredData = { classes: ClassItem[]; sessions: Session[] };

/** `flattened` is true when saved data had groups nested deeper than one level. */
export type ParsedData = StoredData & { flattened: boolean; fromVersion: number };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Keeps valid, unique-id nodes (at any depth) so legacy nesting can be flattened without loss. */
function cleanLegacyGroups(v: unknown, seen: Set<string>): { id: string; name: string; children: unknown[] }[] {
  if (!Array.isArray(v)) return [];
  const out: { id: string; name: string; children: unknown[] }[] = [];
  for (const g of v) {
    if (!isObj(g) || !isStr(g.id) || typeof g.name !== "string" || seen.has(g.id)) continue;
    seen.add(g.id);
    out.push({ id: g.id, name: g.name, children: cleanLegacyGroups(g.children, seen) });
  }
  return out;
}

function cleanMode(v: unknown): TimerMode {
  return v === "stopwatch" ? "stopwatch" : "countdown";
}

/** Returns null when the payload is unusable; otherwise a cleaned copy. */
export function parseStoredData(raw: string): ParsedData | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(json) || (json.version !== 1 && json.version !== DATA_VERSION) || !Array.isArray(json.classes) || !Array.isArray(json.sessions)) {
    return null;
  }
  const classIds = new Set<string>();
  const classes: ClassItem[] = [];
  let flattened = false;
  for (const c of json.classes) {
    if (!isObj(c) || !isStr(c.id) || typeof c.name !== "string" || classIds.has(c.id)) continue;
    classIds.add(c.id);
    const flat = flattenLegacyGroups(cleanLegacyGroups(c.groups, new Set()));
    if (flat.changed) flattened = true;
    classes.push({
      id: c.id,
      name: c.name,
      color: isStr(c.color) ? c.color : "#3b82f6",
      groups: flat.groups,
    });
  }
  const sessionIds = new Set<string>();
  const sessions: Session[] = [];
  for (const s of json.sessions) {
    if (
      !isObj(s) || !isStr(s.id) || sessionIds.has(s.id) || !isStr(s.classId) ||
      typeof s.startedAt !== "number" || !Number.isFinite(s.startedAt) ||
      typeof s.seconds !== "number" || !Number.isFinite(s.seconds) || s.seconds <= 0
    ) continue;
    sessionIds.add(s.id);
    sessions.push({
      id: s.id,
      classId: s.classId,
      groupId: isStr(s.groupId) ? s.groupId : null,
      startedAt: s.startedAt,
      seconds: Math.round(s.seconds),
      mode: cleanMode(s.mode),
    });
  }
  return { classes, sessions, flattened, fromVersion: json.version as number };
}

export function serializeData(data: StoredData) {
  return JSON.stringify({ version: DATA_VERSION, ...data });
}
