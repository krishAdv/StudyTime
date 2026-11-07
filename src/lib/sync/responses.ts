import { SyncResponseError } from "./errors";
import { SERVER_LIMITS } from "./eligibility";
import type { RevisionedSnapshot, SyncClass, SyncGroup, SyncSession } from "./snapshot";
import { codePointLength } from "./text";

/**
 * Strict runtime validators for what the three M4.2 RPCs return. A TypeScript type says nothing
 * about what the server actually sent, so every field is checked here and any deviation throws a
 * `SyncResponseError` (kind `malformed_response`) instead of letting bad data into the app.
 *
 * Strictness: objects must have exactly the documented keys (an extra or missing key is a contract
 * change that this version of the app doesn't understand), numbers must be whole and in range, and
 * enum fields must be one of the documented values. Only the shape is validated here; whether the
 * data is internally consistent (unique ids, valid relationships, names) is the job of
 * `fromSyncSnapshot` / `checkSyncEligibility`. Error details name the field and never include the
 * response contents.
 *
 * Contracts (from supabase/migrations/20261029120000_studytime_sync.sql):
 *  - pull_snapshot  -> {revision, classes:[{id,name,color}], groups:[{id,classId,name}],
 *                       sessions:[{id,classId,groupId|null,startedAt,seconds,mode}]}
 *  - push_changes   -> {status:"applied", revision, changed} | {status:"stale", revision}
 *  - import_and_init_sync -> {status:"imported"|"already_imported", import_id, classes, groups, sessions, revision}
 */

export type PushResult =
  | { status: "applied"; revision: number; changed: number }
  | { status: "stale"; revision: number };

export type ImportResult = {
  status: "imported" | "already_imported";
  importId: string;
  classes: number;
  groups: number;
  sessions: number;
  revision: number;
};

type Rec = Record<string, unknown>;

const bad = (fn: string, what: string): never => {
  throw new SyncResponseError(`${fn}: ${what}`);
};

function record(fn: string, v: unknown, keys: readonly string[], where: string): Rec {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return bad(fn, `${where} is not an object`);
  const have = Object.keys(v).sort();
  const want = [...keys].sort();
  if (have.length !== want.length || have.some((k, i) => k !== want[i])) {
    return bad(fn, `${where} does not have exactly the expected fields (${want.join(", ")})`);
  }
  return v as Rec;
}

function whole(fn: string, v: unknown, min: number, max: number, where: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    return bad(fn, `${where} is not a whole number from ${min} to ${max}`);
  }
  return v;
}

function text(fn: string, v: unknown, where: string): string {
  if (typeof v !== "string") return bad(fn, `${where} is not text`);
  return v;
}

/** An id: non-blank text of at most 100 characters (the server's limit). */
function id(fn: string, v: unknown, where: string): string {
  const s = text(fn, v, where);
  if (s.trim() === "" || codePointLength(s) > SERVER_LIMITS.maxIdLength) {
    return bad(fn, `${where} is not a valid id`);
  }
  return s;
}

function list(fn: string, v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) return bad(fn, `${where} is not a list`);
  return v;
}

const revision = (fn: string, v: unknown, min = 0) => whole(fn, v, min, Number.MAX_SAFE_INTEGER, "revision");

export function parsePullResponse(data: unknown): RevisionedSnapshot {
  const fn = "pull_snapshot";
  const top = record(fn, data, ["revision", "classes", "groups", "sessions"], "the response");
  const rev = revision(fn, top.revision);

  const classes: SyncClass[] = list(fn, top.classes, "classes").map((c, i) => {
    const where = `classes[${i}]`;
    const r = record(fn, c, ["id", "name", "color"], where);
    return { id: id(fn, r.id, `${where}.id`), name: text(fn, r.name, `${where}.name`), color: text(fn, r.color, `${where}.color`) };
  });

  const groups: SyncGroup[] = list(fn, top.groups, "groups").map((g, i) => {
    const where = `groups[${i}]`;
    const r = record(fn, g, ["id", "classId", "name"], where);
    return { id: id(fn, r.id, `${where}.id`), classId: id(fn, r.classId, `${where}.classId`), name: text(fn, r.name, `${where}.name`) };
  });

  const sessions: SyncSession[] = list(fn, top.sessions, "sessions").map((s, i) => {
    const where = `sessions[${i}]`;
    const r = record(fn, s, ["id", "classId", "groupId", "startedAt", "seconds", "mode"], where);
    const mode = r.mode;
    if (mode !== "stopwatch" && mode !== "countdown") return bad(fn, `${where}.mode is not an allowed value`);
    return {
      id: id(fn, r.id, `${where}.id`),
      classId: id(fn, r.classId, `${where}.classId`),
      groupId: r.groupId === null ? null : id(fn, r.groupId, `${where}.groupId`),
      startedAt: whole(fn, r.startedAt, 0, SERVER_LIMITS.maxStartedAtMs, `${where}.startedAt`),
      seconds: whole(fn, r.seconds, SERVER_LIMITS.minSeconds, SERVER_LIMITS.maxSeconds, `${where}.seconds`),
      mode,
    };
  });

  return { revision: rev, snapshot: { classes, groups, sessions } };
}

export function parsePushResponse(data: unknown): PushResult {
  const fn = "push_changes";
  if (typeof data !== "object" || data === null || Array.isArray(data)) return bad(fn, "the response is not an object");
  const status = (data as Rec).status;
  if (status === "applied") {
    const r = record(fn, data, ["status", "revision", "changed"], "the response");
    return {
      status: "applied",
      revision: revision(fn, r.revision),
      // One push holds at most 5,000 changes, and every change alters at most one row.
      changed: whole(fn, r.changed, 0, 5_000, "changed"),
    };
  }
  if (status === "stale") {
    const r = record(fn, data, ["status", "revision"], "the response");
    return { status: "stale", revision: revision(fn, r.revision) };
  }
  return bad(fn, "status is not an allowed value");
}

export function parseImportResponse(data: unknown): ImportResult {
  const fn = "import_and_init_sync";
  const r = record(fn, data, ["status", "import_id", "classes", "groups", "sessions", "revision"], "the response");
  const status = r.status;
  if (status !== "imported" && status !== "already_imported") return bad(fn, "status is not an allowed value");
  return {
    status,
    importId: id(fn, r.import_id, "import_id"),
    classes: whole(fn, r.classes, 0, SERVER_LIMITS.maxClasses, "classes"),
    groups: whole(fn, r.groups, 0, SERVER_LIMITS.maxClasses * SERVER_LIMITS.maxGroupsPerClass, "groups"),
    sessions: whole(fn, r.sessions, 0, SERVER_LIMITS.maxSessions, "sessions"),
    // An import always leaves a sync_state row at revision 1 or more.
    revision: revision(fn, r.revision, 1),
  };
}
