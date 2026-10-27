import { validateClassName, validateGroupName, type Result } from "./class-rules";
import type { StoredData } from "./storage";
import type { ClassItem, GroupNode, Session } from "./types";

/**
 * Export file format (JSON), version 1:
 *
 *   {
 *     "format": "studytime-export",
 *     "formatVersion": 1,
 *     "exportedAt": "2026-10-27T18:30:00.000Z",     // ISO timestamp
 *     "data": {
 *       "classes":  [{ "id", "name", "color": "#rrggbb", "groups": [{ "id", "name" }] }],
 *       "sessions": [{ "id", "classId", "groupId": string | null,
 *                      "startedAt": epoch ms, "seconds": whole number > 0,
 *                      "mode": "stopwatch" | "countdown" }]
 *     }
 *   }
 *
 * Only study data is exported. Theme and countdown length are device settings
 * and are neither exported nor imported. Import validates the whole file and
 * returns either clean data or the first problem found; it never partly applies.
 * Unknown extra fields are ignored. Ids are kept exactly as saved. Group ids
 * must be unique across all classes, session ids unique, and every session must
 * point at an existing class (and, if set, a subgroup of that same class).
 */
export const EXPORT_FORMAT = "studytime-export";
export const EXPORT_VERSION = 1;

/** Largest file the UI will read, in bytes. A real export is a few KB to a few MB. */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

export function serializeExport(data: StoredData, now: Date = new Date()): string {
  const classes: ClassItem[] = data.classes.map((c) => ({
    id: c.id,
    name: c.name,
    color: c.color,
    groups: c.groups.map((g) => ({ id: g.id, name: g.name })),
  }));
  const sessions: Session[] = data.sessions.map((s) => ({
    id: s.id,
    classId: s.classId,
    groupId: s.groupId,
    startedAt: s.startedAt,
    seconds: s.seconds,
    mode: s.mode,
  }));
  return JSON.stringify(
    { format: EXPORT_FORMAT, formatVersion: EXPORT_VERSION, exportedAt: now.toISOString(), data: { classes, sessions } },
    null,
    2,
  );
}

/** studytime-export-2026-10-27.json, using the local calendar date. */
export function exportFileName(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `studytime-export-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_SECONDS = 366 * 24 * 60 * 60;

/**
 * Strictly validates `{classes, sessions}`, applying the same naming rules as
 * the app (names are trimmed and whitespace-collapsed; class names unique app-wide,
 * subgroup names unique within a class). Used by import and by the provider's
 * replace operation, so the rules hold on every path.
 */
export function validateStudyData(value: unknown): Result<StoredData> {
  if (!isObj(value)) return fail("The file has no study data.");
  if (!Array.isArray(value.classes)) return fail("The file is missing its list of classes.");
  if (!Array.isArray(value.sessions)) return fail("The file is missing its list of sessions.");

  const classes: ClassItem[] = [];
  const classIds = new Set<string>();
  const groupIds = new Set<string>();
  const groupsByClass = new Map<string, Set<string>>();

  for (const [i, raw] of value.classes.entries()) {
    const where = `Class ${i + 1}`;
    if (!isObj(raw)) return fail(`${where} is not a valid class.`);
    if (!isId(raw.id)) return fail(`${where} has no id.`);
    if (classIds.has(raw.id)) return fail(`${where} repeats the id “${raw.id}”.`);
    if (typeof raw.name !== "string") return fail(`${where} has no name.`);
    if (typeof raw.color !== "string" || !COLOR.test(raw.color)) return fail(`${where} has an invalid color.`);
    if (!Array.isArray(raw.groups)) return fail(`${where} is missing its list of subgroups.`);
    const name = validateClassName(classes, raw.name);
    if (!name.ok) return fail(`${where}: ${name.error}`);
    classIds.add(raw.id);

    const groups: GroupNode[] = [];
    for (const [j, g] of raw.groups.entries()) {
      const gw = `${where}, subgroup ${j + 1}`;
      if (!isObj(g)) return fail(`${gw} is not a valid subgroup.`);
      if (!isId(g.id)) return fail(`${gw} has no id.`);
      if (groupIds.has(g.id)) return fail(`${gw} repeats the id “${g.id}”.`);
      if (typeof g.name !== "string") return fail(`${gw} has no name.`);
      const gn = validateGroupName(groups, g.name);
      if (!gn.ok) return fail(`${gw}: ${gn.error}`);
      groupIds.add(g.id);
      groups.push({ id: g.id, name: gn.value });
    }
    groupsByClass.set(raw.id, new Set(groups.map((g) => g.id)));
    classes.push({ id: raw.id, name: name.value, color: raw.color, groups });
  }

  const sessions: Session[] = [];
  const sessionIds = new Set<string>();
  for (const [i, s] of value.sessions.entries()) {
    const where = `Session ${i + 1}`;
    if (!isObj(s)) return fail(`${where} is not a valid session.`);
    if (!isId(s.id)) return fail(`${where} has no id.`);
    if (sessionIds.has(s.id)) return fail(`${where} repeats the id “${s.id}”.`);
    if (!isId(s.classId)) return fail(`${where} has no class.`);
    const classGroups = groupsByClass.get(s.classId);
    if (!classGroups) return fail(`${where} belongs to a class that isn’t in the file.`);
    if (s.groupId !== null && typeof s.groupId !== "string") return fail(`${where} has an invalid subgroup.`);
    if (s.groupId !== null && !classGroups.has(s.groupId)) {
      return fail(`${where} belongs to a subgroup that isn’t part of its class.`);
    }
    if (typeof s.startedAt !== "number" || !Number.isSafeInteger(s.startedAt) || s.startedAt < 0) {
      return fail(`${where} has an invalid start time.`);
    }
    if (typeof s.seconds !== "number" || !Number.isInteger(s.seconds) || s.seconds < 1 || s.seconds > MAX_SECONDS) {
      return fail(`${where} has an invalid duration.`);
    }
    if (s.mode !== "stopwatch" && s.mode !== "countdown") return fail(`${where} has an invalid timer mode.`);
    sessionIds.add(s.id);
    sessions.push({
      id: s.id,
      classId: s.classId,
      groupId: s.groupId,
      startedAt: s.startedAt,
      seconds: s.seconds,
      mode: s.mode,
    });
  }

  return { ok: true, value: { classes, sessions } };
}

/** Parses and validates an export file's text. Pure: touches no stored data. */
export function parseExport(text: string): Result<StoredData> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail("This isn’t a valid JSON file.");
  }
  if (!isObj(json) || json.format !== EXPORT_FORMAT) return fail("This isn’t a StudyTime export file.");
  if (typeof json.formatVersion !== "number") return fail("The file has no version number.");
  if (json.formatVersion > EXPORT_VERSION) {
    return fail("This file was made by a newer version of StudyTime and can’t be imported here.");
  }
  if (json.formatVersion !== EXPORT_VERSION) return fail(`Export version ${json.formatVersion} isn’t supported.`);
  if (typeof json.exportedAt !== "string" || Number.isNaN(Date.parse(json.exportedAt))) {
    return fail("The file has no valid export date.");
  }
  return validateStudyData(json.data);
}
