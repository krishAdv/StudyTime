import { createHash } from "node:crypto";
import { normalizeName } from "@/lib/class-rules";
import { createSupabaseSyncApi, type SyncApi, type SyncRpcClient, type SyncRpcResponse } from "@/lib/sync/api";
import type { SyncSnapshot } from "@/lib/sync/snapshot";
import { codePointLength, simpleNameKey } from "@/lib/sync/text";

/**
 * A deterministic in-memory model of the M4.2 server: `pull_snapshot`, `push_changes` and
 * `import_and_init_sync` (which wraps `import_local_data`), written against the SQL in
 * supabase/migrations/20261027120000_studytime_schema.sql, 20261027120100_studytime_import.sql and
 * 20261029120000_studytime_sync.sql. It keeps real per-user state and applies changes to it; it is
 * NOT canned responses. It answers at the same level as the Supabase client, `{data, error, status}`,
 * with PostgREST-style errors, so the real `createSupabaseSyncApi` (validators, classifier) runs on top of it.
 *
 * What is modeled (and where it comes from in the SQL):
 *  - per-user revision (absent row = 0; a push that changes nothing never creates the row), the advisory
 *    lock is implicit because calls run one at a time
 *  - push_changes: argument checks, then the stale check (any base other than the current revision), then
 *    the ops in order inside one transaction (a failed op discards the whole call), then the class and
 *    session caps, then exactly +1 only if some row changed
 *  - table constraints in the order PostgreSQL applies them: CHECK constraints, then unique indexes, then
 *    foreign keys. Unique violations in push_changes are ST003; every other constraint failure is 22023;
 *    inside the import every constraint failure is 22023
 *  - delete_class refuses (ST004) when the session count differs, and removes sessions then the class and its subgroups;
 *    delete_group keeps the sessions and nulls their subgroup
 *  - import: ST001 / ST002 / envelope checks / payload checks, the retry rule (same id and identical payload
 *    is `already_imported` and writes nothing, even if the data has changed since), and the sync_state
 *    revision rule (new row = 1, existing row = +1 on import, created at 1 on a replay if missing)
 *  - account isolation: all state is keyed by user id, ids are unique per user only, and the owner always
 *    comes from the caller, never from the payload
 *
 * Known approximations (cannot be modeled confidently without the real database):
 *  - jsonb byte sizes (4 MB / 32 MB limits) are approximated by the JSON text length
 *  - ordering ties (same creation time or same start time) are broken by plain string comparison, while
 *    PostgreSQL uses the database collation
 *  - `normalize_name` uses the app's own normalization and `lower()` a per-character lowercase, whereas
 *    PostgreSQL follows the database locale for exotic whitespace and capital letters
 *  - the import payload hash is taken over canonical JSON text; jsonb also keeps numeric scale (60.0 vs 60),
 *    which JavaScript numbers cannot express
 *  - HTTP status codes for errors follow PostgREST's documented mapping, which was not checked against a running server
 */

const MAX_ID = 100;
const MAX_NAME = 60;
const MAX_TEXT = 1000;
const MAX_SECONDS = 31_622_400;
const MAX_STARTED_AT = 253_402_300_799_999;
const MAX_CLASSES = 1000;
const MAX_GROUPS = 1000;
const MAX_SESSIONS = 100_000;
const MAX_CHANGES = 5000;
const MAX_PUSH_BYTES = 4_000_000;
const MAX_IMPORT_BYTES = 33_554_432;
const COLOR = /^#[0-9a-fA-F]{6}$/;

type Rec = Record<string, unknown>;
type FClass = { id: string; name: string; color: string; created: number };
type FGroup = { id: string; classId: string; name: string; created: number };
type FSession = { id: string; classId: string; groupId: string | null; startedAt: number; seconds: number; mode: string };
type FImport = { hash: string; classes: number; groups: number; sessions: number };
type Account = {
  revision: number | null; // null = no sync_state row yet
  classes: Map<string, FClass>;
  groups: Map<string, FGroup>;
  sessions: Map<string, FSession>;
  imports: Map<string, FImport>;
};

/** An error the database would raise, with its SQLSTATE. */
class PgError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
/** A table-constraint failure; the caller maps it to 22023 or ST003 like the SQL's exception handlers do. */
class Violation extends Error {
  readonly kind: "check" | "unique" | "fk";
  constructor(kind: "check" | "unique" | "fk", message: string) {
    super(message);
    this.kind = kind;
  }
}

const invalid = (m: string) => new PgError("22023", `invalid_payload: ${m}`);
const isObj = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: Rec, k: string) => k in o; // the SQL's `p_obj -> key is not null`: present, even if JSON null
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** SQL btrim(x) with no characters given trims spaces only. */
const btrim = (s: string) => s.replace(/^ +| +$/g, "");
const norm = (s: string) => normalizeName(s);
const lowerKey = (s: string) => simpleNameKey(norm(s));
const approxBytes = (v: unknown) => JSON.stringify(v).length;

// ---- the payload helpers (sync_text, sync_opt_text, sync_whole)
function syncText(o: Rec, k: string, where: string): string {
  const v = o[k];
  if (typeof v !== "string" || codePointLength(v) > MAX_TEXT) throw invalid(`${where} needs a text field "${k}" of at most ${MAX_TEXT} characters.`);
  return v;
}
function syncOptText(o: Rec, k: string, where: string): string | null {
  if (!has(o, k)) throw invalid(`${where} needs the field "${k}" (text or null).`);
  if (o[k] === null) return null;
  return syncText(o, k, where);
}
function syncWhole(o: Rec, k: string, min: number, max: number, where: string): number {
  const v = o[k];
  if (typeof v !== "number") throw invalid(`${where} needs a numeric field "${k}".`);
  if (!Number.isInteger(v) || v < min || v > max) throw invalid(`${where} has an invalid "${k}".`);
  return v;
}

// ---- table constraints, in PostgreSQL's order: CHECK, then unique indexes, then foreign keys
const checkId = (id: string, table: string) => {
  if (btrim(id) === "" || codePointLength(id) > MAX_ID) throw new Violation("check", `${table}_id_check`);
};
const checkName = (name: string, table: string) => {
  const n = codePointLength(name);
  if (name !== norm(name) || n < 1 || n > MAX_NAME) throw new Violation("check", `${table}_name_check`);
};

function insertClass(a: Account, row: FClass) {
  checkId(row.id, "classes");
  checkName(row.name, "classes");
  if (!COLOR.test(row.color)) throw new Violation("check", "classes_color_check");
  if (a.classes.has(row.id)) throw new Violation("unique", "classes_pkey");
  for (const c of a.classes.values()) if (lowerKey(c.name) === lowerKey(row.name)) throw new Violation("unique", "classes_user_name_key");
  a.classes.set(row.id, row);
}

function groupNameTaken(a: Account, classId: string, name: string, exceptId?: string) {
  for (const g of a.groups.values()) {
    if (g.classId === classId && g.id !== exceptId && lowerKey(g.name) === lowerKey(name)) return true;
  }
  return false;
}

function insertGroup(a: Account, row: FGroup) {
  checkId(row.id, "groups");
  checkName(row.name, "groups");
  if (a.groups.has(row.id)) throw new Violation("unique", "groups_pkey");
  if (groupNameTaken(a, row.classId, row.name)) throw new Violation("unique", "groups_class_name_key");
  if (!a.classes.has(row.classId)) throw new Violation("fk", "groups_class_fk");
  a.groups.set(row.id, row);
}

function checkSessionRefs(a: Account, classId: string, groupId: string | null) {
  if (!a.classes.has(classId)) throw new Violation("fk", "sessions_class_fk");
  if (groupId !== null) {
    const g = a.groups.get(groupId);
    if (!g || g.classId !== classId) throw new Violation("fk", "sessions_group_fk");
  }
}

function insertSession(a: Account, row: FSession) {
  checkId(row.id, "sessions");
  if (row.seconds < 1 || row.seconds > MAX_SECONDS) throw new Violation("check", "sessions_seconds_check");
  if (row.mode !== "stopwatch" && row.mode !== "countdown") throw new Violation("check", "sessions_mode_check");
  if (a.sessions.has(row.id)) throw new Violation("unique", "sessions_pkey");
  checkSessionRefs(a, row.classId, row.groupId);
  a.sessions.set(row.id, row);
}

// ---- pull_snapshot
const sortedByCreated = <T extends { created: number; id: string }>(m: Map<string, T>) =>
  [...m.values()].sort((x, y) => x.created - y.created || cmp(x.id, y.id));

function snapshotOf(a: Account): SyncSnapshot {
  return {
    classes: sortedByCreated(a.classes).map((c) => ({ id: c.id, name: c.name, color: c.color })),
    groups: sortedByCreated(a.groups).map((g) => ({ id: g.id, classId: g.classId, name: g.name })),
    sessions: [...a.sessions.values()]
      .sort((x, y) => x.startedAt - y.startedAt || cmp(x.id, y.id))
      .map((s) => ({ id: s.id, classId: s.classId, groupId: s.groupId, startedAt: s.startedAt, seconds: s.seconds, mode: s.mode as "stopwatch" | "countdown" })),
  };
}

// ---- push_changes
type Outcome = { result: Rec; next: Account };

function push(acct: Account, base: number | null, changes: unknown, tx: number): Outcome {
  if (base === null || base < 0) throw invalid("the base revision must be a number of 0 or more.");
  if (!Array.isArray(changes)) throw invalid("changes must be a list.");
  if (changes.length > MAX_CHANGES || approxBytes(changes) > MAX_PUSH_BYTES) throw invalid("too many changes in one push.");

  const cur = acct.revision ?? 0;
  if (base !== cur) return { result: { status: "stale", revision: cur }, next: acct };

  const w = structuredClone(acct);
  let changed = 0;
  let addedClasses = false;
  let addedSessions = false;

  changes.forEach((op: unknown, i: number) => {
    let where = `change ${i + 1}`;
    if (!isObj(op)) throw invalid(`${where} is not an object.`);
    const type = syncText(op, "op", where);
    where = `${where} (${type.slice(0, 40)})`;
    const created = tx + (i + 1) / 1000; // microsecond offset by position, like v_seq
    try {
      switch (type) {
        case "add_class": {
          const id = syncText(op, "id", where);
          const name = norm(syncText(op, "name", where));
          const color = syncText(op, "color", where);
          insertClass(w, { id, name, color, created });
          addedClasses = true;
          changed++;
          break;
        }
        case "update_class": {
          const id = syncText(op, "id", where);
          if (!has(op, "name") && !has(op, "color")) throw invalid(`${where} needs a name or a color.`);
          const cls = w.classes.get(id);
          if (!cls) throw invalid(`${where} refers to a class that does not exist.`);
          const name = has(op, "name") ? norm(syncText(op, "name", where)) : cls.name;
          const color = has(op, "color") ? syncText(op, "color", where) : cls.color;
          if (name !== cls.name || color !== cls.color) {
            checkName(name, "classes");
            if (!COLOR.test(color)) throw new Violation("check", "classes_color_check");
            for (const c of w.classes.values()) if (c.id !== id && lowerKey(c.name) === lowerKey(name)) throw new Violation("unique", "classes_user_name_key");
            cls.name = name;
            cls.color = color;
            changed++;
          }
          break;
        }
        case "delete_class": {
          const id = syncText(op, "id", where);
          const expected = syncWhole(op, "expectedSessions", 0, 100_000, where);
          if (!w.classes.has(id)) throw invalid(`${where} refers to a class that does not exist.`);
          const inClass = [...w.sessions.values()].filter((s) => s.classId === id);
          if (inClass.length !== expected) {
            throw new PgError("ST004", `delete_refused: the class holds ${inClass.length} sessions but ${expected} were expected; pull and merge first.`);
          }
          for (const s of inClass) w.sessions.delete(s.id);
          for (const g of [...w.groups.values()]) if (g.classId === id) w.groups.delete(g.id);
          w.classes.delete(id);
          changed++;
          break;
        }
        case "add_group": {
          const id = syncText(op, "id", where);
          const classId = syncText(op, "classId", where);
          const name = norm(syncText(op, "name", where));
          insertGroup(w, { id, classId, name, created });
          if ([...w.groups.values()].filter((g) => g.classId === classId).length > MAX_GROUPS) {
            throw invalid(`${where} exceeds the limit of ${MAX_GROUPS} subgroups per class.`);
          }
          changed++;
          break;
        }
        case "rename_group": {
          const id = syncText(op, "id", where);
          const name = norm(syncText(op, "name", where));
          const g = w.groups.get(id);
          if (!g) throw invalid(`${where} refers to a subgroup that does not exist.`);
          if (name !== g.name) {
            checkName(name, "groups");
            if (groupNameTaken(w, g.classId, name, id)) throw new Violation("unique", "groups_class_name_key");
            g.name = name;
            changed++;
          }
          break;
        }
        case "delete_group": {
          const id = syncText(op, "id", where);
          if (!w.groups.delete(id)) throw invalid(`${where} refers to a subgroup that does not exist.`);
          for (const s of w.sessions.values()) if (s.groupId === id) s.groupId = null; // ON DELETE SET NULL (group_id)
          changed++;
          break;
        }
        case "add_session": {
          const id = syncText(op, "id", where);
          const classId = syncText(op, "classId", where);
          const groupId = syncOptText(op, "groupId", where);
          const startedAt = syncWhole(op, "startedAt", 0, MAX_STARTED_AT, where);
          const seconds = syncWhole(op, "seconds", 1, MAX_SECONDS, where);
          const mode = syncText(op, "mode", where);
          insertSession(w, { id, classId, groupId, startedAt, seconds, mode });
          addedSessions = true;
          changed++;
          break;
        }
        case "move_session": {
          const id = syncText(op, "id", where);
          const classId = syncText(op, "classId", where);
          const groupId = syncOptText(op, "groupId", where);
          const s = w.sessions.get(id);
          if (!s) throw invalid(`${where} refers to a session that does not exist.`);
          if (s.classId !== classId || s.groupId !== groupId) {
            checkSessionRefs(w, classId, groupId);
            s.classId = classId;
            s.groupId = groupId;
            changed++;
          }
          break;
        }
        default:
          throw invalid(`${where} is an unknown change type.`);
      }
    } catch (e) {
      if (e instanceof Violation) {
        if (e.kind === "unique") throw new PgError("ST003", `conflict: ${e.message} (at ${where})`);
        throw invalid(`${e.message} (at ${where})`);
      }
      throw e;
    }
  });

  if (addedClasses && w.classes.size > MAX_CLASSES) throw invalid(`more than ${MAX_CLASSES} classes.`);
  if (addedSessions && w.sessions.size > MAX_SESSIONS) throw invalid(`more than ${MAX_SESSIONS} sessions.`);

  if (changed === 0) return { result: { status: "applied", revision: cur, changed: 0 }, next: acct };
  w.revision = cur + 1;
  return { result: { status: "applied", revision: w.revision, changed }, next: w };
}

// ---- import_local_data (wrapped by import_and_init_sync)
function canonical(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (isObj(x)) return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]));
    return x;
  };
  return JSON.stringify(sort(v));
}

function importLocal(w: Account, importId: unknown, payload: Rec, tx: number): Rec {
  if (typeof importId !== "string" || btrim(importId) === "" || codePointLength(importId) > MAX_ID) {
    throw invalid("the import id must be 1 to 100 characters.");
  }
  const hash = createHash("sha256").update(canonical(payload)).digest("hex");
  const existing = w.imports.get(importId);
  if (existing) {
    if (existing.hash === hash) {
      return { status: "already_imported", import_id: importId, classes: existing.classes, groups: existing.groups, sessions: existing.sessions };
    }
    throw new PgError("ST001", "This import id was already used with different data.");
  }
  if (w.classes.size > 0 || w.sessions.size > 0) throw new PgError("ST002", "This account already contains study data; nothing was imported.");

  if (payload.format !== "studytime-export") throw invalid("not a StudyTime export file.");
  if (typeof payload.formatVersion !== "number" || payload.formatVersion !== 1) throw invalid("unsupported export version.");
  if (typeof payload.exportedAt !== "string") throw invalid("missing export date.");
  const data = payload.data;
  if (!isObj(data)) throw invalid("missing data.");
  if (!Array.isArray(data.classes)) throw invalid("classes must be a list.");
  if (!Array.isArray(data.sessions)) throw invalid("sessions must be a list.");
  const classes = data.classes as unknown[];
  const sessions = data.sessions as unknown[];
  if (classes.length > MAX_CLASSES || sessions.length > MAX_SESSIONS) throw invalid("too much data for one import.");

  let where = "payload";
  let totalGroups = 0;
  try {
    classes.forEach((c, ci) => {
      where = `class ${ci + 1}`;
      if (!isObj(c) || typeof c.id !== "string" || typeof c.name !== "string" || typeof c.color !== "string" || !Array.isArray(c.groups)) {
        throw invalid(`${where} is malformed.`);
      }
      insertClass(w, { id: c.id, name: norm(c.name), color: c.color, created: tx - (classes.length - ci) });
      const groups = c.groups as unknown[];
      if (groups.length > MAX_GROUPS) throw invalid(`${where} has too many subgroups.`);
      groups.forEach((g, gi) => {
        where = `class ${ci + 1}, subgroup ${gi + 1}`;
        if (!isObj(g) || typeof g.id !== "string" || typeof g.name !== "string") throw invalid(`${where} is malformed.`);
        insertGroup(w, { id: g.id, classId: c.id as string, name: norm(g.name), created: tx - (groups.length - gi) });
        totalGroups++;
      });
    });
    sessions.forEach((s, si) => {
      where = `session ${si + 1}`;
      if (
        !isObj(s) || typeof s.id !== "string" || typeof s.classId !== "string" || typeof s.startedAt !== "number" ||
        typeof s.seconds !== "number" || typeof s.mode !== "string" || !has(s, "groupId") ||
        (s.groupId !== null && typeof s.groupId !== "string")
      ) throw invalid(`${where} is malformed.`);
      if (!Number.isInteger(s.seconds)) throw invalid(`${where} has a non-whole duration.`);
      if (s.seconds < 1 || s.seconds > MAX_SECONDS) throw invalid(`${where} has an invalid duration.`);
      if (!Number.isInteger(s.startedAt) || s.startedAt < 0 || s.startedAt > MAX_STARTED_AT) throw invalid(`${where} has an invalid start time.`);
      insertSession(w, { id: s.id, classId: s.classId, groupId: s.groupId as string | null, startedAt: s.startedAt, seconds: s.seconds, mode: s.mode });
    });
  } catch (e) {
    if (e instanceof Violation) throw invalid(`${e.message} (at ${where})`); // in the import every constraint failure is 22023
    throw e;
  }

  w.imports.set(importId, { hash, classes: classes.length, groups: totalGroups, sessions: sessions.length });
  return { status: "imported", import_id: importId, classes: classes.length, groups: totalGroups, sessions: sessions.length };
}

function importAndInit(acct: Account, importId: unknown, payload: unknown, tx: number): Outcome {
  if (!isObj(payload) || approxBytes(payload) > MAX_IMPORT_BYTES) throw invalid("the payload must be a JSON object of at most 32 MB.");
  const w = structuredClone(acct);
  const res = importLocal(w, importId, payload, tx);
  if (res.status === "imported") w.revision = (w.revision ?? 0) + 1;
  else if (w.revision === null) w.revision = 1;
  return { result: { ...res, revision: w.revision }, next: w };
}

// ---- the server and its RPC surface
export type FakeServerMode = "normal" | "network_down" | "server_error" | "unavailable";

const statusFor = (code: string) => (code === "28000" || code === "42501" ? 403 : 400);

const failure = (status: number, code: string, message: string): SyncRpcResponse => ({
  data: null,
  error: { code, message, details: undefined, hint: undefined, name: "PostgrestError" },
  status,
});

const ARGS: Record<string, string[]> = {
  pull_snapshot: [],
  push_changes: ["p_base_revision", "p_changes"],
  import_and_init_sync: ["p_import_id", "p_payload"],
};

export function createFakeSyncServer() {
  const accounts = new Map<string, Account>();
  const expired = new Set<string>();
  const calls: { userId: string | null; fn: string; args: unknown }[] = [];
  let clock = 0;
  let mode: FakeServerMode = "normal";

  const account = (userId: string): Account => {
    let a = accounts.get(userId);
    if (!a) {
      a = { revision: null, classes: new Map(), groups: new Map(), sessions: new Map(), imports: new Map() };
      accounts.set(userId, a);
    }
    return a;
  };

  /** `userId` null is an anonymous caller (no session). */
  function rpcFor(userId: string | null): SyncRpcClient & { rpc(fn: string, args?: Record<string, unknown>): Promise<SyncRpcResponse> } {
    return {
      async rpc(fn: string, args?: Record<string, unknown>): Promise<SyncRpcResponse> {
        calls.push({ userId, fn, args });
        const wire = JSON.parse(JSON.stringify(args ?? {})) as Rec; // what actually crosses the wire
        if (mode === "network_down") return { data: null, error: { message: "TypeError: fetch failed", code: "" }, status: 0 };
        if (mode === "server_error") return { data: null, error: { message: "Service Unavailable", code: "" }, status: 503 };
        if (mode === "unavailable" || !(fn in ARGS)) {
          return failure(404, "PGRST202", `Could not find the function public.${fn} in the schema cache`);
        }
        if (userId === null) return failure(401, "42501", `permission denied for function ${fn}`);
        if (expired.has(userId)) return failure(401, "PGRST301", "JWT expired");
        const want = ARGS[fn];
        const have = Object.keys(wire);
        if (have.length !== want.length || have.some((k) => !want.includes(k))) {
          return failure(404, "PGRST202", `Could not find the function public.${fn}(${have.join(", ")}) in the schema cache`);
        }
        try {
          const acct = account(userId);
          if (fn === "pull_snapshot") return { data: { revision: acct.revision ?? 0, ...snapshotOf(acct) }, error: null, status: 200 };
          let out: Outcome;
          if (fn === "push_changes") {
            const b = wire.p_base_revision;
            if (b !== null && !(typeof b === "number" && Number.isSafeInteger(b))) {
              throw new PgError("22P02", "invalid input syntax for type bigint");
            }
            out = push(acct, b as number | null, wire.p_changes, (clock += 10));
          } else {
            const id = wire.p_import_id;
            if (id !== null && typeof id !== "string") throw new PgError("22P02", "invalid input syntax for type text");
            out = importAndInit(acct, id, wire.p_payload, (clock += 10));
          }
          accounts.set(userId, out.next);
          return { data: JSON.parse(JSON.stringify(out.result)), error: null, status: 200 };
        } catch (e) {
          if (e instanceof PgError) return failure(statusFor(e.code), e.code, e.message);
          throw e;
        }
      },
    };
  }

  return {
    rpcFor,
    /** The real Supabase adapter running on top of this fake. */
    apiFor: (userId: string | null): SyncApi => createSupabaseSyncApi(rpcFor(userId)),
    calls,
    setMode: (m: FakeServerMode) => void (mode = m),
    /** Makes this user's session look expired (401 JWT expired) until cleared. */
    setSessionExpired: (userId: string, on: boolean) => void (on ? expired.add(userId) : expired.delete(userId)),
    /** Direct look at a user's stored state, for assertions (not available to a client). */
    state: (userId: string) => {
      const a = account(userId);
      return { revision: a.revision ?? 0, hasSyncRow: a.revision !== null, snapshot: snapshotOf(a), imports: [...a.imports.keys()] };
    },
  };
}

export type FakeSyncServer = ReturnType<typeof createFakeSyncServer>;
