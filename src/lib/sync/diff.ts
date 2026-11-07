import { nameKey } from "../class-rules";
import { PUSH_LIMITS, type SyncChange } from "./changes";
import type { SyncIssue } from "./eligibility";
import { fromSyncSnapshot } from "./from-snapshot";
import type { SyncSnapshot } from "./snapshot";
import { simpleNameKey } from "./text";

/**
 * The diff planner: turns "what the server has" (`remote`) and "what we want it to have" (`target`)
 * into an ordered list of M4.2 `push_changes` operations, split into batches that each fit one push.
 *
 * How the order is guaranteed valid: the planner keeps a simulated copy of the server state and only
 * emits an operation once every precondition of that operation holds in the simulation (the class or
 * subgroup it refers to exists, the name it needs is free, a class it deletes holds no session that is
 * still needed, ...). Applying each operation updates the simulation exactly like the SQL does
 * (`delete_group` nulls the subgroup of its sessions, `delete_class` removes the class's sessions and
 * subgroups, names are unique per account for classes and per class for subgroups, case-insensitively).
 * So the sequence is valid by construction, `expectedSessions` is the simulated count at the moment the
 * delete runs (earlier operations of the plan, in this batch or an earlier one, included), and the
 * simulation must end equal to `target` or the plan is refused.
 *
 * Order of work, repeated until nothing is left: (1) move sessions whose destination exists, (2) delete
 * subgroups, delete classes that no longer hold a needed session, update classes, rename subgroups, add
 * classes, add subgroups, (3) add sessions. Moves come first so sessions leave a subgroup or class
 * before it is deleted whenever their destination exists. A session whose destination does not exist yet
 * is left to `delete_group` (which keeps it, with no subgroup) and moved later; a class is never deleted
 * while a session that must survive is still in it.
 *
 * Names: a name that is wanted while another entity still holds it is freed by deleting the holder if it
 * can already be deleted, or by renaming the holder to a temporary name (`~sync-N`, chosen so it collides
 * with no existing or target name under either lowercasing rule). This is what makes swaps and longer
 * rename cycles, and "delete a class and re-create its name", always solvable. Name collisions are checked
 * under the app's lowercasing and a simple per-character one, so the plan is safe whichever the server uses.
 *
 * Batches: operations are cut into batches of at most `maxChanges` operations and `maxBytes` of JSON.
 * Every prefix of the plan leaves the server in a valid state, so a cut is valid at any operation
 * boundary, with one rule: a cut is only allowed where the simulated state respects the server's class
 * (1,000) and session (100,000) caps, because the server checks those caps at the end of every push.
 * The subgroup cap (1,000 per class) is checked inside a push, so the planner never lets it be exceeded
 * at any step. If no allowed cut exists inside a batch, the plan is refused instead of split unsafely.
 *
 * What cannot be represented (refused, never approximated):
 *  - a session that exists on both sides with a different start time, duration or mode (no operation edits them)
 *  - a session that exists remotely but not in the target while its class stays (no operation deletes a
 *    session; sessions only disappear with their class)
 *  - reordering existing classes or subgroups (the server orders by creation; new ones are created in target
 *    order, existing ones keep their relative order)
 * A subgroup that keeps its id but changes class is represented as delete + add (its sessions are kept and
 * moved), which is the only way the server allows.
 *
 * Pure: no network, storage, React or Supabase. Both snapshots are validated first with the same rules as
 * the rest of the sync code; an invalid one is refused.
 */

export type DiffErrorCode =
  | "invalid_options"
  | "invalid_remote"
  | "invalid_target"
  | "session_data_changed"
  | "session_removal_unsupported"
  | "cannot_order"
  | "op_too_large"
  | "no_safe_chunk_boundary"
  | "plan_incomplete"
  | "internal_error";

export type DiffError = {
  code: DiffErrorCode;
  message: string;
  /** Ids involved (at most 20). */
  ids?: string[];
  /** Validation problems, for `invalid_remote` and `invalid_target`. */
  issues?: SyncIssue[];
};

export type DiffOptions = {
  /** Most operations in one batch. Default and ceiling: the server's 5,000. */
  maxChanges?: number;
  /** Most JSON bytes in one batch. Default 3,000,000; ceiling: the server's 4,000,000. */
  maxBytes?: number;
};

export type DiffPlan = {
  /** Every operation, in the order they must be applied. */
  ops: SyncChange[];
  /** `ops` cut into pushes. Apply them in order, each at the revision the previous one produced. */
  batches: SyncChange[][];
};

export type DiffResult = ({ ok: true } & DiffPlan) | { ok: false; error: DiffError };

/**
 * The default byte budget per batch: 75% of the server's 4 MB. The server measures the size of the jsonb
 * value, which is not exactly the JSON text length, so a margin keeps a batch from being refused.
 */
export const DEFAULT_BATCH_BYTES = 3_000_000;

const MAX_GROUPS_PER_CLASS = 1_000;
const MAX_CLASSES = 1_000;
const MAX_SESSIONS = 100_000;

const fail = (code: DiffErrorCode, message: string, extra: Partial<DiffError> = {}): DiffResult => ({
  ok: false,
  error: { code, message, ...extra },
});

/** UTF-8 byte length of a string, without allocating. */
function byteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

export function diffToOps(remote: SyncSnapshot, target: SyncSnapshot, options: DiffOptions = {}): DiffResult {
  const maxChanges = options.maxChanges ?? PUSH_LIMITS.maxChanges;
  const maxBytes = options.maxBytes ?? DEFAULT_BATCH_BYTES;
  if (!Number.isInteger(maxChanges) || maxChanges < 1 || maxChanges > PUSH_LIMITS.maxChanges) {
    return fail("invalid_options", `maxChanges must be a whole number from 1 to ${PUSH_LIMITS.maxChanges}.`);
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 2 || maxBytes > PUSH_LIMITS.maxBytes) {
    return fail("invalid_options", `maxBytes must be a whole number from 2 to ${PUSH_LIMITS.maxBytes}.`);
  }

  const r = fromSyncSnapshot(remote, { maxIssues: 20 });
  if (!r.ok) return fail("invalid_remote", "The remote snapshot is not valid, so no plan was made.", { issues: r.issues });
  const t = fromSyncSnapshot(target, { maxIssues: 20 });
  if (!t.ok) return fail("invalid_target", "The target snapshot is not valid, so no plan was made.", { issues: t.issues });

  try {
    return plan(remote, target, maxChanges, maxBytes);
  } catch (e) {
    return fail("internal_error", `The planner hit an internal inconsistency: ${e instanceof Error ? e.message : String(e)}`);
  }
}

type Group = { classId: string; name: string };
type Sess = { classId: string; groupId: string | null };

function plan(remote: SyncSnapshot, target: SyncSnapshot, maxChanges: number, maxBytes: number): DiffResult {
  const rc = new Map(remote.classes.map((c) => [c.id, c]));
  const rg = new Map(remote.groups.map((g) => [g.id, g]));
  const rs = new Map(remote.sessions.map((s) => [s.id, s]));
  const tc = new Map(target.classes.map((c) => [c.id, c]));
  const tg = new Map(target.groups.map((g) => [g.id, g]));
  const ts = new Map(target.sessions.map((s) => [s.id, s]));

  // ---- transitions the server's operations cannot express
  const changedSessions: string[] = [];
  const removedSessions: string[] = [];
  for (const s of remote.sessions) {
    const t = ts.get(s.id);
    if (!t) {
      if (tc.has(s.classId)) removedSessions.push(s.id); // its class stays, and nothing deletes a single session
    } else if (t.startedAt !== s.startedAt || t.seconds !== s.seconds || t.mode !== s.mode) {
      changedSessions.push(s.id);
    }
  }
  if (changedSessions.length > 0) {
    return fail("session_data_changed", "A session's start time, duration or mode differs between the two snapshots, and no operation can edit them.", { ids: changedSessions.slice(0, 20) });
  }
  if (removedSessions.length > 0) {
    return fail("session_removal_unsupported", "A session is missing from the target but its class stays, and no operation can delete a single session.", { ids: removedSessions.slice(0, 20) });
  }

  // ---- what has to happen
  const delClasses = remote.classes.filter((c) => !tc.has(c.id)).map((c) => c.id);
  const newClasses = target.classes.filter((c) => !rc.has(c.id));
  const keptClasses = target.classes.filter((c) => rc.has(c.id));
  // A subgroup that is gone or changed class is deleted explicitly, unless its whole class is deleted and its id is not
  // reused (the class takes it along). A reused id must be deleted explicitly first: it cannot be added again under its
  // new class while the old subgroup still exists, and waiting for the class delete would deadlock with the moves
  // that the class delete itself is waiting for.
  const delGroups = remote.groups
    .filter((g) => {
      const t = tg.get(g.id);
      const reclassed = !!t && t.classId !== g.classId;
      return (!t || reclassed) && (tc.has(g.classId) || reclassed);
    })
    .map((g) => g.id);
  const deletedGroupIds = new Set(delGroups);
  const newGroups = target.groups.filter((g) => !rg.has(g.id) || rg.get(g.id)!.classId !== g.classId);
  const keptGroups = target.groups.filter((g) => rg.has(g.id) && rg.get(g.id)!.classId === g.classId);
  const prevNewClass = new Map<string, string>();
  newClasses.forEach((c, i) => i > 0 && prevNewClass.set(c.id, newClasses[i - 1].id));
  const prevNewGroup = new Map<string, string>();
  const lastNewGroupOfClass = new Map<string, string>();
  for (const g of newGroups) {
    const prev = lastNewGroupOfClass.get(g.classId);
    if (prev !== undefined) prevNewGroup.set(g.id, prev);
    lastNewGroupOfClass.set(g.classId, g.id);
  }

  // ---- the simulated server
  const simClasses = new Map<string, { name: string; color: string }>();
  const simGroups = new Map<string, Group>();
  const simSessions = new Map<string, Sess>();
  const classH1 = new Map<string, string>();
  const classH2 = new Map<string, string>();
  const groupH = new Map<string, { h1: Map<string, string>; h2: Map<string, string> }>();
  const groupsOfClass = new Map<string, Set<string>>();
  const sessionsOfClass = new Map<string, Set<string>>();
  const sessionsOfGroup = new Map<string, Set<string>>();
  /** Per class: how many of its current sessions also exist in the target (those must leave before the class can go). */
  const needed = new Map<string, number>();

  const setOf = (m: Map<string, Set<string>>, k: string) => {
    let s = m.get(k);
    if (!s) m.set(k, (s = new Set()));
    return s;
  };
  const gh = (classId: string) => {
    let h = groupH.get(classId);
    if (!h) groupH.set(classId, (h = { h1: new Map(), h2: new Map() }));
    return h;
  };
  const holderOfClassName = (name: string, except: string): string | null => {
    const a = classH1.get(nameKey(name));
    if (a !== undefined && a !== except) return a;
    const b = classH2.get(simpleNameKey(name));
    if (b !== undefined && b !== except) return b;
    return null;
  };
  const holderOfGroupName = (classId: string, name: string, except: string): string | null => {
    const h = gh(classId);
    const a = h.h1.get(nameKey(name));
    if (a !== undefined && a !== except) return a;
    const b = h.h2.get(simpleNameKey(name));
    if (b !== undefined && b !== except) return b;
    return null;
  };
  const setClassKeys = (id: string, name: string) => {
    classH1.set(nameKey(name), id);
    classH2.set(simpleNameKey(name), id);
  };
  const clearClassKeys = (id: string, name: string) => {
    if (classH1.get(nameKey(name)) === id) classH1.delete(nameKey(name));
    if (classH2.get(simpleNameKey(name)) === id) classH2.delete(simpleNameKey(name));
  };
  const setGroupKeys = (classId: string, id: string, name: string) => {
    const h = gh(classId);
    h.h1.set(nameKey(name), id);
    h.h2.set(simpleNameKey(name), id);
  };
  const clearGroupKeys = (classId: string, id: string, name: string) => {
    const h = gh(classId);
    if (h.h1.get(nameKey(name)) === id) h.h1.delete(nameKey(name));
    if (h.h2.get(simpleNameKey(name)) === id) h.h2.delete(simpleNameKey(name));
  };
  const bumpNeeded = (classId: string, by: number) => needed.set(classId, (needed.get(classId) ?? 0) + by);

  for (const c of remote.classes) {
    simClasses.set(c.id, { name: c.name, color: c.color });
    setClassKeys(c.id, c.name);
  }
  for (const g of remote.groups) {
    simGroups.set(g.id, { classId: g.classId, name: g.name });
    setOf(groupsOfClass, g.classId).add(g.id);
    setGroupKeys(g.classId, g.id, g.name);
  }
  for (const s of remote.sessions) {
    simSessions.set(s.id, { classId: s.classId, groupId: s.groupId });
    setOf(sessionsOfClass, s.classId).add(s.id);
    if (s.groupId !== null) setOf(sessionsOfGroup, s.groupId).add(s.id);
    if (ts.has(s.id)) bumpNeeded(s.classId, 1);
  }

  // ---- temporary names: unique under both lowercasing rules against every name in either snapshot
  const usedKeys = new Set<string>();
  for (const n of [...remote.classes, ...remote.groups, ...target.classes, ...target.groups]) {
    usedKeys.add(nameKey(n.name));
    usedKeys.add(simpleNameKey(n.name));
  }
  let tempCounter = 0;
  const makeTempName = () => {
    for (;;) {
      const name = `~sync-${++tempCounter}`;
      const k1 = nameKey(name);
      const k2 = simpleNameKey(name);
      if (!usedKeys.has(k1) && !usedKeys.has(k2)) {
        usedKeys.add(k1);
        usedKeys.add(k2);
        return name;
      }
    }
  };

  // ---- emitting operations (each one checks its own preconditions against the simulation)
  const ops: SyncChange[] = [];
  const safeAfter: boolean[] = []; // may a batch end after this operation? (class and session caps hold)
  const must = (ok: boolean, what: string) => {
    if (!ok) throw new Error(what);
  };
  const push = (op: SyncChange) => {
    ops.push(op);
    safeAfter.push(simClasses.size <= MAX_CLASSES && simSessions.size <= MAX_SESSIONS);
  };

  const emitAddClass = (id: string) => {
    const c = tc.get(id)!;
    must(!simClasses.has(id) && holderOfClassName(c.name, id) === null, `add_class ${id} is not valid here`);
    simClasses.set(id, { name: c.name, color: c.color });
    setClassKeys(id, c.name);
    push({ op: "add_class", id, name: c.name, color: c.color });
  };
  const emitUpdateClass = (id: string, name?: string, color?: string) => {
    const cur = simClasses.get(id);
    must(!!cur && (name !== undefined || color !== undefined), `update_class ${id} is not valid here`);
    if (name !== undefined) {
      must(holderOfClassName(name, id) === null, `update_class ${id} needs a name that is taken`);
      clearClassKeys(id, cur!.name);
      cur!.name = name;
      setClassKeys(id, name);
    }
    if (color !== undefined) cur!.color = color;
    const op: SyncChange = { op: "update_class", id };
    if (name !== undefined) op.name = name;
    if (color !== undefined) op.color = color;
    push(op);
  };
  const emitDeleteClass = (id: string) => {
    const cur = simClasses.get(id);
    must(!!cur && (needed.get(id) ?? 0) === 0, `delete_class ${id} would remove a session that must survive`);
    const members = sessionsOfClass.get(id) ?? new Set<string>();
    const expectedSessions = members.size;
    for (const sid of members) {
      const s = simSessions.get(sid)!;
      if (s.groupId !== null) sessionsOfGroup.get(s.groupId)?.delete(sid);
      simSessions.delete(sid);
    }
    sessionsOfClass.delete(id);
    for (const gid of groupsOfClass.get(id) ?? []) {
      const g = simGroups.get(gid)!;
      clearGroupKeys(id, gid, g.name);
      simGroups.delete(gid);
      sessionsOfGroup.delete(gid);
    }
    groupsOfClass.delete(id);
    groupH.delete(id);
    clearClassKeys(id, cur!.name);
    simClasses.delete(id);
    needed.delete(id);
    push({ op: "delete_class", id, expectedSessions });
  };
  const emitAddGroup = (id: string) => {
    const g = tg.get(id)!;
    must(
      !simGroups.has(id) && simClasses.has(g.classId) && holderOfGroupName(g.classId, g.name, id) === null &&
        (groupsOfClass.get(g.classId)?.size ?? 0) < MAX_GROUPS_PER_CLASS,
      `add_group ${id} is not valid here`,
    );
    simGroups.set(id, { classId: g.classId, name: g.name });
    setOf(groupsOfClass, g.classId).add(id);
    setGroupKeys(g.classId, id, g.name);
    push({ op: "add_group", id, classId: g.classId, name: g.name });
  };
  const emitRenameGroup = (id: string, name: string) => {
    const cur = simGroups.get(id);
    must(!!cur && holderOfGroupName(cur!.classId, name, id) === null, `rename_group ${id} is not valid here`);
    clearGroupKeys(cur!.classId, id, cur!.name);
    cur!.name = name;
    setGroupKeys(cur!.classId, id, name);
    push({ op: "rename_group", id, name });
  };
  const emitDeleteGroup = (id: string) => {
    const cur = simGroups.get(id);
    must(!!cur, `delete_group ${id} is not valid here`);
    // The server keeps the group's sessions and clears their subgroup.
    for (const sid of sessionsOfGroup.get(id) ?? []) simSessions.get(sid)!.groupId = null;
    sessionsOfGroup.delete(id);
    clearGroupKeys(cur!.classId, id, cur!.name);
    groupsOfClass.get(cur!.classId)?.delete(id);
    simGroups.delete(id);
    push({ op: "delete_group", id });
  };
  const emitAddSession = (id: string) => {
    const s = ts.get(id)!;
    must(!simSessions.has(id), `add_session ${id} is not valid here`);
    simSessions.set(id, { classId: s.classId, groupId: s.groupId });
    setOf(sessionsOfClass, s.classId).add(id);
    if (s.groupId !== null) setOf(sessionsOfGroup, s.groupId).add(id);
    bumpNeeded(s.classId, 1);
    push({ op: "add_session", id, classId: s.classId, groupId: s.groupId, startedAt: s.startedAt, seconds: s.seconds, mode: s.mode });
  };
  const emitMoveSession = (id: string) => {
    const t = ts.get(id)!;
    const cur = simSessions.get(id);
    must(!!cur, `move_session ${id} is not valid here`);
    sessionsOfClass.get(cur!.classId)?.delete(id);
    bumpNeeded(cur!.classId, -1);
    if (cur!.groupId !== null) sessionsOfGroup.get(cur!.groupId)?.delete(id);
    cur!.classId = t.classId;
    cur!.groupId = t.groupId;
    setOf(sessionsOfClass, t.classId).add(id);
    bumpNeeded(t.classId, 1);
    if (t.groupId !== null) setOf(sessionsOfGroup, t.groupId).add(id);
    push({ op: "move_session", id, classId: t.classId, groupId: t.groupId });
  };

  // ---- readiness
  const destinationExists = (classId: string, groupId: string | null) =>
    simClasses.has(classId) && (groupId === null || simGroups.get(groupId)?.classId === classId);
  const groupIsGone = (id: string) => simGroups.get(id)?.classId !== rg.get(id)!.classId;

  let movers = target.sessions.filter((s) => {
    const r = rs.get(s.id);
    return !!r && (r.classId !== s.classId || r.groupId !== s.groupId);
  });
  let adders = target.sessions.filter((s) => !rs.has(s.id));

  const sessionMovePass = () => {
    let progress = false;
    const left: typeof movers = [];
    for (const s of movers) {
      const cur = simSessions.get(s.id);
      if (!cur || (cur.classId === s.classId && cur.groupId === s.groupId)) continue; // done, maybe by delete_group
      // Leaving a subgroup that is about to be deleted, for no subgroup: the delete does exactly that, so no move is needed.
      if (s.groupId === null && cur.classId === s.classId && cur.groupId !== null && deletedGroupIds.has(cur.groupId)) {
        left.push(s);
        continue;
      }
      if (destinationExists(s.classId, s.groupId)) {
        emitMoveSession(s.id);
        progress = true;
      } else left.push(s);
    }
    movers = left;
    return progress;
  };

  const sessionAddPass = () => {
    let progress = false;
    const left: typeof adders = [];
    for (const s of adders) {
      if (simSessions.has(s.id)) continue;
      if (destinationExists(s.classId, s.groupId)) {
        emitAddSession(s.id);
        progress = true;
      } else left.push(s);
    }
    adders = left;
    return progress;
  };

  /** Why an add/update/rename cannot run now: a name held by another entity, or nothing the planner can break. */
  type Blocker = { kind: "class" | "group"; id: string } | null;
  const classUpdateBlocker = (id: string): { ready: boolean; blocker: Blocker } => {
    const c = tc.get(id)!;
    const cur = simClasses.get(id)!;
    if (cur.name === c.name) return { ready: true, blocker: null };
    const h = holderOfClassName(c.name, id);
    return h === null ? { ready: true, blocker: null } : { ready: false, blocker: { kind: "class", id: h } };
  };
  const groupRenameBlocker = (id: string): { ready: boolean; blocker: Blocker } => {
    const g = tg.get(id)!;
    const cur = simGroups.get(id)!;
    const h = holderOfGroupName(cur.classId, g.name, id);
    return h === null ? { ready: true, blocker: null } : { ready: false, blocker: { kind: "group", id: h } };
  };
  const addClassBlocker = (id: string): { ready: boolean; blocker: Blocker } => {
    const prev = prevNewClass.get(id);
    if (prev !== undefined && !simClasses.has(prev)) return { ready: false, blocker: null };
    const h = holderOfClassName(tc.get(id)!.name, id);
    return h === null ? { ready: true, blocker: null } : { ready: false, blocker: { kind: "class", id: h } };
  };
  const addGroupBlocker = (id: string): { ready: boolean; blocker: Blocker } => {
    const g = tg.get(id)!;
    if (simGroups.has(id) || !simClasses.has(g.classId)) return { ready: false, blocker: null };
    const prev = prevNewGroup.get(id);
    if (prev !== undefined && simGroups.get(prev)?.classId !== g.classId) return { ready: false, blocker: null };
    if ((groupsOfClass.get(g.classId)?.size ?? 0) >= MAX_GROUPS_PER_CLASS) return { ready: false, blocker: null };
    const h = holderOfGroupName(g.classId, g.name, id);
    return h === null ? { ready: true, blocker: null } : { ready: false, blocker: { kind: "group", id: h } };
  };

  const structuralPass = () => {
    let progress = false;
    for (const id of delGroups) {
      if (!groupIsGone(id)) {
        emitDeleteGroup(id);
        progress = true;
      }
    }
    for (const id of delClasses) {
      if (simClasses.has(id) && (needed.get(id) ?? 0) === 0) {
        emitDeleteClass(id);
        progress = true;
      }
    }
    for (const c of keptClasses) {
      const cur = simClasses.get(c.id)!;
      const nameDiff = cur.name !== c.name;
      const colorDiff = cur.color !== c.color;
      if (!nameDiff && !colorDiff) continue;
      if (!classUpdateBlocker(c.id).ready) continue;
      emitUpdateClass(c.id, nameDiff ? c.name : undefined, colorDiff ? c.color : undefined);
      progress = true;
    }
    for (const g of keptGroups) {
      if (simGroups.get(g.id)!.name === g.name) continue;
      if (!groupRenameBlocker(g.id).ready) continue;
      emitRenameGroup(g.id, g.name);
      progress = true;
    }
    for (const c of newClasses) {
      if (simClasses.has(c.id) || !addClassBlocker(c.id).ready) continue;
      emitAddClass(c.id);
      progress = true;
    }
    for (const g of newGroups) {
      if (simGroups.has(g.id) || !addGroupBlocker(g.id).ready) continue;
      emitAddGroup(g.id);
      progress = true;
    }
    return progress;
  };

  /** Nothing can move: free one wanted name by renaming its holder to a temporary name. */
  const breakNameCycle = (): boolean => {
    const candidates: Blocker[] = [];
    for (const c of keptClasses) {
      const cur = simClasses.get(c.id)!;
      if (cur.name !== c.name) candidates.push(classUpdateBlocker(c.id).blocker);
    }
    for (const g of keptGroups) {
      if (simGroups.get(g.id)!.name !== g.name) candidates.push(groupRenameBlocker(g.id).blocker);
    }
    for (const c of newClasses) if (!simClasses.has(c.id)) candidates.push(addClassBlocker(c.id).blocker);
    for (const g of newGroups) if (!simGroups.has(g.id)) candidates.push(addGroupBlocker(g.id).blocker);
    const b = candidates.find((x) => x !== null);
    if (!b) return false;
    if (b.kind === "class") emitUpdateClass(b.id, makeTempName());
    else emitRenameGroup(b.id, makeTempName());
    return true;
  };

  const isComplete = () =>
    delClasses.every((id) => !simClasses.has(id)) &&
    newClasses.every((c) => simClasses.has(c.id)) &&
    keptClasses.every((c) => {
      const cur = simClasses.get(c.id);
      return !!cur && cur.name === c.name && cur.color === c.color;
    }) &&
    delGroups.every(groupIsGone) &&
    newGroups.every((g) => simGroups.get(g.id)?.classId === g.classId) &&
    keptGroups.every((g) => simGroups.get(g.id)?.name === g.name) &&
    target.sessions.every((s) => {
      const cur = simSessions.get(s.id);
      return !!cur && cur.classId === s.classId && cur.groupId === s.groupId;
    });

  // ---- the schedule
  const budget = 10 * (target.classes.length + target.groups.length + remote.classes.length + remote.groups.length + 20);
  for (let round = 0; !isComplete(); round++) {
    if (round > budget) return fail("cannot_order", "The planner could not order the changes.");
    let progress = sessionMovePass();
    while (structuralPass()) progress = true;
    if (sessionAddPass()) progress = true;
    if (!progress && !isComplete() && !breakNameCycle()) {
      return fail("cannot_order", "The planner could not order the changes: nothing could run and no name could be freed.");
    }
  }

  // ---- the simulation must have reached the target exactly
  const reached =
    simClasses.size === target.classes.length &&
    simGroups.size === target.groups.length &&
    simSessions.size === target.sessions.length &&
    target.sessions.every((s) => simSessions.has(s.id));
  if (!reached) return fail("plan_incomplete", "The planned operations do not reproduce the target snapshot.");

  // ---- batches
  const sizes = ops.map((op) => byteLength(JSON.stringify(op)));
  const batches: SyncChange[][] = [];
  let start = 0;
  while (start < ops.length) {
    let bytes = 2; // the brackets
    let end = start;
    while (end < ops.length && end - start < maxChanges) {
      const add = sizes[end] + (end > start ? 1 : 0); // plus the comma
      if (bytes + add > maxBytes) break;
      bytes += add;
      end++;
    }
    if (end === start) {
      return fail("op_too_large", "One operation alone does not fit in a batch.", { ids: [String((ops[start] as { id?: string }).id ?? "")] });
    }
    let cut = end;
    while (cut > start && !safeAfter[cut - 1]) cut--;
    if (cut === start) {
      return fail("no_safe_chunk_boundary", "No place inside this batch keeps the account within the server's class and session limits, so the plan cannot be split safely.");
    }
    batches.push(ops.slice(start, cut));
    start = cut;
  }

  return { ok: true, ops, batches };
}
