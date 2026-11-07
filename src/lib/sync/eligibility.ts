import { nameKey, normalizeName } from "../class-rules";
import type { StoredData } from "../storage";
import { toSyncSnapshot, type SyncSnapshot } from "./snapshot";
import { codePointLength, hasUnstorableText, simpleNameKey } from "./text";

/**
 * Whether local study data can be sent to the server as it is. The server (M4.2) rejects the
 * whole request when any row breaks a constraint, so this reports every problem up front instead
 * of letting an upload fail halfway. It never repairs, normalizes or drops anything: the caller
 * decides what to do with the issues (show them, let the user fix the data, or export a copy).
 *
 * Limits mirror supabase/migrations (schema, import and sync files):
 *  - ids: `btrim(id) <> '' and char_length(id) <= 100`, unique per table (a subgroup id is unique
 *    across ALL classes, because sessions refer to subgroups by id)
 *  - names: must already equal `normalize_name(name)` (trimmed, whitespace runs collapsed to one
 *    space) and be 1..60 characters; class names are unique per user, subgroup names per class,
 *    case-insensitively
 *  - color: `^#[0-9a-fA-F]{6}$`
 *  - sessions: seconds 1..31,622,400 and whole; mode stopwatch|countdown; startedAt a whole number
 *    of epoch ms from 0 to 253,402,300,799,999 (year 9999); class must exist; subgroup, if set,
 *    must exist AND belong to the session's class
 *  - caps: 1,000 classes, 1,000 subgroups per class, 100,000 sessions
 *
 * Also rejected, because PostgreSQL cannot store them in text/jsonb: strings containing NUL
 * (U+0000) and lone UTF-16 surrogates.
 *
 * Request-size limits (4 MB per push, 32 MB per import) depend on serialization and belong to the
 * code that builds the requests, not to this check.
 *
 * Known uncertainty (also noted in the schema migration): PostgreSQL's `\s` and `lower()` follow
 * the database locale, JavaScript's `\s` and `toLocaleLowerCase()` follow the browser. Names are
 * therefore required to match the app's own normalization exactly (stricter than the server for
 * exotic whitespace), and duplicate names are detected under two lowercasing rules (the app's and a
 * simple one-to-one per-character rule). This is conservative, but it cannot prove what the
 * server's locale does for every rare character.
 */
export const SERVER_LIMITS = {
  maxIdLength: 100,
  maxNameLength: 60,
  minSeconds: 1,
  maxSeconds: 31_622_400,
  maxStartedAtMs: 253_402_300_799_999,
  maxClasses: 1_000,
  maxGroupsPerClass: 1_000,
  maxSessions: 100_000,
} as const;

const COLOR = /^#[0-9a-fA-F]{6}$/;

export type SyncIssueCode =
  | "invalid_data"
  | "invalid_id"
  | "id_too_long"
  | "invalid_text"
  | "duplicate_class_id"
  | "duplicate_group_id"
  | "duplicate_session_id"
  | "invalid_name"
  | "name_empty"
  | "name_not_normalized"
  | "name_too_long"
  | "duplicate_class_name"
  | "duplicate_group_name"
  | "invalid_color"
  | "session_class_missing"
  | "invalid_group_reference"
  | "session_group_missing"
  | "session_group_wrong_class"
  | "invalid_start_time"
  | "invalid_duration"
  | "invalid_mode"
  | "too_many_classes"
  | "too_many_groups"
  | "too_many_sessions"
  | "group_class_missing"
  | "invalid_revision";

export type SyncIssue = {
  code: SyncIssueCode;
  entity: "data" | "class" | "group" | "session";
  /** The offending record's id, or null when it has no usable id (or the issue is about a whole list). */
  id: string | null;
  /** For subgroups and sessions: the id of the class they belong to, when known. */
  classId?: string;
  /** 1-based position in its list (for subgroups: within their class), as a person would count. */
  position?: number;
  field?: "id" | "name" | "color" | "classId" | "groupId" | "groups" | "startedAt" | "seconds" | "mode";
  /** Other records involved, such as the one this record duplicates. */
  related?: string[];
  /** Plain language, safe to show to the user. */
  message: string;
  /** What the user can do about it. */
  hint: string;
};

export type SyncEligibility =
  | { ok: true; snapshot: SyncSnapshot }
  | {
      ok: false;
      /** The first `maxIssues` problems, in list order (classes, then their subgroups, then sessions). */
      issues: SyncIssue[];
      /** Every problem found, including those beyond `maxIssues`. */
      totalIssues: number;
      truncated: boolean;
    };

const DEFAULT_MAX_ISSUES = 200;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Remembers which record first used a name, under both keys. */
function createNameIndex() {
  const app = new Map<string, string>();
  const simple = new Map<string, string>();
  return {
    /** Returns the id of an earlier record whose name collides, or null (and records this one). */
    add(name: string, id: string): string | null {
      const k1 = nameKey(name);
      const k2 = simpleNameKey(name);
      const clash = app.get(k1) ?? simple.get(k2) ?? null;
      if (clash === null) {
        app.set(k1, id);
        simple.set(k2, id);
      }
      return clash;
    },
  };
}

/**
 * Checks `data` against every server constraint listed above and returns either the flat snapshot
 * (identical to `toSyncSnapshot(data)`) or the structured list of problems. Pure: `data` is never
 * changed. At most `maxIssues` issues are returned (default 200) but all are counted.
 */
export function checkSyncEligibility(data: StoredData, options: { maxIssues?: number } = {}): SyncEligibility {
  const maxIssues = options.maxIssues ?? DEFAULT_MAX_ISSUES;
  const issues: SyncIssue[] = [];
  let total = 0;
  const add = (issue: SyncIssue) => {
    total++;
    if (issues.length < maxIssues) issues.push(issue);
  };
  const finish = (): SyncEligibility =>
    total === 0
      ? { ok: true, snapshot: toSyncSnapshot(data) }
      : { ok: false, issues, totalIssues: total, truncated: total > issues.length };

  const raw = data as unknown;
  if (!isObj(raw) || !Array.isArray(raw.classes) || !Array.isArray(raw.sessions)) {
    add({
      code: "invalid_data",
      entity: "data",
      id: null,
      message: "The study data is not in the expected shape, so it can’t be uploaded.",
      hint: "Export a copy of your data from Settings before doing anything else.",
    });
    return finish();
  }

  /** Validates an id; returns it when usable (and so able to take part in duplicate checks). */
  const checkId = (
    value: unknown,
    base: Pick<SyncIssue, "entity" | "classId" | "position">,
    label: string,
  ): string | null => {
    const at = { ...base, field: "id" as const };
    if (typeof value !== "string" || value.trim() === "") {
      add({ ...at, code: "invalid_id", id: null, message: `${label} has no id.`, hint: "This record is damaged. Export your data and remove or re-create it." });
      return null;
    }
    if (hasUnstorableText(value)) {
      add({ ...at, code: "invalid_text", id: null, message: `${label} has an id with characters that can’t be stored.`, hint: "This record is damaged. Export your data and remove or re-create it." });
      return null;
    }
    if (value.length > SERVER_LIMITS.maxIdLength && codePointLength(value) > SERVER_LIMITS.maxIdLength) {
      add({ ...at, code: "id_too_long", id: value, message: `${label} has an id longer than ${SERVER_LIMITS.maxIdLength} characters.`, hint: "Ids can’t be changed in the app. Export your data and re-create this record." });
      return null;
    }
    return value;
  };

  /** Validates a name; returns it when it is a usable, non-empty string (for duplicate checks). */
  const checkName = (
    value: unknown,
    id: string | null,
    base: Pick<SyncIssue, "entity" | "classId" | "position">,
    label: string,
  ): string | null => {
    const at = { ...base, field: "name" as const, id };
    if (typeof value !== "string") {
      add({ ...at, code: "invalid_name", message: `${label} has no name.`, hint: "Rename it, then try again." });
      return null;
    }
    if (hasUnstorableText(value)) {
      add({ ...at, code: "invalid_text", message: `${label} has a name with characters that can’t be stored.`, hint: "Rename it, then try again." });
    }
    const clean = normalizeName(value);
    if (clean === "") {
      add({ ...at, code: "name_empty", message: `${label} has an empty name.`, hint: "Give it a name, then try again." });
      return null;
    }
    if (value !== clean) {
      add({ ...at, code: "name_not_normalized", message: `${label} has extra spaces in its name (“${value}”).`, hint: `Rename it to “${clean}”.` });
    }
    if (codePointLength(value) > SERVER_LIMITS.maxNameLength) {
      add({ ...at, code: "name_too_long", message: `${label} has a name longer than ${SERVER_LIMITS.maxNameLength} characters.`, hint: `Shorten it to ${SERVER_LIMITS.maxNameLength} characters or fewer.` });
    }
    return value;
  };

  const classIds = new Set<string>();
  const groupOwner = new Map<string, string>(); // group id -> id of the class that holds it
  const classNames = createNameIndex();

  if (raw.classes.length > SERVER_LIMITS.maxClasses) {
    add({
      code: "too_many_classes",
      entity: "class",
      id: null,
      message: `There are ${raw.classes.length} classes; the most that can be synced is ${SERVER_LIMITS.maxClasses}.`,
      hint: "Delete classes you no longer need, then try again.",
    });
  }

  raw.classes.forEach((c: unknown, i: number) => {
    const position = i + 1;
    if (!isObj(c)) {
      add({ code: "invalid_data", entity: "class", id: null, position, message: `Class ${position} is not a valid class.`, hint: "This record is damaged. Export your data and remove or re-create it." });
      return;
    }
    const nameForLabel = typeof c.name === "string" && c.name.trim() !== "" ? ` (“${c.name}”)` : "";
    const label = `Class ${position}${nameForLabel}`;
    const base = { entity: "class" as const, position };

    const id = checkId(c.id, base, label);
    if (id !== null) {
      if (classIds.has(id)) {
        add({ ...base, code: "duplicate_class_id", id, field: "id", related: [id], message: `${label} repeats a class id that another class already uses.`, hint: "Export your data and remove one of the two classes." });
      }
      classIds.add(id);
    }

    const name = checkName(c.name, id, base, label);
    if (name !== null && id !== null) {
      const clash = classNames.add(name, id);
      if (clash !== null) {
        add({ ...base, code: "duplicate_class_name", id, field: "name", related: [clash], message: `${label} has the same name as another class (names are compared ignoring capitals and extra spaces).`, hint: "Rename one of them, then try again." });
      }
    }

    if (typeof c.color !== "string" || !COLOR.test(c.color)) {
      add({ ...base, code: "invalid_color", id, field: "color", message: `${label} has an invalid color.`, hint: "Edit the class or export and fix the color; it must look like #3b82f6." });
    }

    if (!Array.isArray(c.groups)) {
      add({ ...base, code: "invalid_data", id, field: "groups", message: `${label} has a damaged list of subgroups.`, hint: "This record is damaged. Export your data and remove or re-create it." });
      return;
    }
    if (c.groups.length > SERVER_LIMITS.maxGroupsPerClass) {
      add({
        entity: "group",
        code: "too_many_groups",
        id: null,
        classId: id ?? undefined,
        message: `${label} has ${c.groups.length} subgroups; the most per class is ${SERVER_LIMITS.maxGroupsPerClass}.`,
        hint: "Delete subgroups you no longer need, then try again.",
      });
    }

    const groupNames = createNameIndex();
    c.groups.forEach((g: unknown, j: number) => {
      const gPosition = j + 1;
      const gBase = { entity: "group" as const, classId: typeof c.id === "string" ? c.id : undefined, position: gPosition };
      if (!isObj(g)) {
        add({ ...gBase, code: "invalid_data", id: null, message: `Subgroup ${gPosition} of ${label} is not a valid subgroup.`, hint: "This record is damaged. Export your data and remove or re-create it." });
        return;
      }
      const gName = typeof g.name === "string" && g.name.trim() !== "" ? ` (“${g.name}”)` : "";
      const gLabel = `Subgroup ${gPosition}${gName} of ${label}`;
      const gid = checkId(g.id, gBase, gLabel);
      if (gid !== null) {
        const owner = groupOwner.get(gid);
        if (owner !== undefined) {
          add({ ...gBase, code: "duplicate_group_id", id: gid, field: "id", related: [owner], message: `${gLabel} repeats a subgroup id that is already used (subgroup ids must be unique across all classes).`, hint: "Export your data and remove one of the two subgroups." });
        } else if (id !== null) {
          groupOwner.set(gid, id);
        }
      }
      const checked = checkName(g.name, gid, gBase, gLabel);
      if (checked !== null && gid !== null) {
        const clash = groupNames.add(checked, gid);
        if (clash !== null) {
          add({ ...gBase, code: "duplicate_group_name", id: gid, field: "name", related: [clash], message: `${gLabel} has the same name as another subgroup in this class.`, hint: "Rename one of them, then try again." });
        }
      }
    });
  });

  if (raw.sessions.length > SERVER_LIMITS.maxSessions) {
    add({
      code: "too_many_sessions",
      entity: "session",
      id: null,
      message: `There are ${raw.sessions.length} sessions; the most that can be synced is ${SERVER_LIMITS.maxSessions}.`,
      hint: "Export a copy of your data from Settings; that many sessions can’t be synced as one account.",
    });
  }

  const sessionIds = new Set<string>();
  raw.sessions.forEach((s: unknown, i: number) => {
    const position = i + 1;
    const label = `Session ${position}`;
    if (!isObj(s)) {
      add({ code: "invalid_data", entity: "session", id: null, position, message: `${label} is not a valid session.`, hint: "This record is damaged. Export your data and remove or re-create it." });
      return;
    }
    const classId = typeof s.classId === "string" ? s.classId : undefined;
    const base = { entity: "session" as const, position, classId };

    const id = checkId(s.id, base, label);
    if (id !== null) {
      if (sessionIds.has(id)) {
        add({ ...base, code: "duplicate_session_id", id, field: "id", related: [id], message: `${label} repeats a session id that another session already uses.`, hint: "Export your data and remove one of the two sessions." });
      }
      sessionIds.add(id);
    }

    if (classId === undefined || classId === "" || !classIds.has(classId)) {
      add({ ...base, code: "session_class_missing", id, field: "classId", message: `${label} belongs to a class that isn’t in your data (it may have been deleted).`, hint: "Move the session to an existing class, or export your data and remove it." });
    }

    if (s.groupId !== null) {
      if (typeof s.groupId !== "string") {
        add({ ...base, code: "invalid_group_reference", id, field: "groupId", message: `${label} has a damaged subgroup reference.`, hint: "Edit the session and choose its subgroup again." });
      } else if (!groupOwner.has(s.groupId)) {
        add({ ...base, code: "session_group_missing", id, field: "groupId", related: [s.groupId], message: `${label} points at a subgroup that doesn’t exist.`, hint: "Edit the session and choose an existing subgroup, or none." });
      } else if (groupOwner.get(s.groupId) !== classId) {
        add({ ...base, code: "session_group_wrong_class", id, field: "groupId", related: [s.groupId], message: `${label} points at a subgroup that belongs to a different class.`, hint: "Edit the session and choose a subgroup of its own class, or none." });
      }
    }

    if (
      typeof s.startedAt !== "number" || !Number.isSafeInteger(s.startedAt) ||
      s.startedAt < 0 || s.startedAt > SERVER_LIMITS.maxStartedAtMs
    ) {
      add({ ...base, code: "invalid_start_time", id, field: "startedAt", message: `${label} has an invalid start time.`, hint: "The start time must be a whole number of milliseconds between 1970 and the year 9999. Export your data and remove or re-create this session." });
    }
    if (
      typeof s.seconds !== "number" || !Number.isInteger(s.seconds) ||
      s.seconds < SERVER_LIMITS.minSeconds || s.seconds > SERVER_LIMITS.maxSeconds
    ) {
      add({ ...base, code: "invalid_duration", id, field: "seconds", message: `${label} has an invalid duration (it must be a whole number of seconds from 1 to ${SERVER_LIMITS.maxSeconds}).`, hint: "Export your data and remove or re-create this session." });
    }
    if (s.mode !== "stopwatch" && s.mode !== "countdown") {
      add({ ...base, code: "invalid_mode", id, field: "mode", message: `${label} has an unknown timer mode.`, hint: "Export your data and remove or re-create this session." });
    }
  });

  return finish();
}
