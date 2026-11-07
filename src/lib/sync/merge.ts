import { nameKey } from "../class-rules";
import {
  buildDecisionPoints, validateDecisions,
  type AcceptedDecision, type DecisionPoint, type RejectedDecision, type RejectedReason,
} from "./decisions";
import { diffToOps, type DiffError, type DiffOptions } from "./diff";
import type { SyncIssue } from "./eligibility";
import { fromSyncSnapshot } from "./from-snapshot";
import type { SyncClass, SyncGroup, SyncSession, SyncSnapshot } from "./snapshot";
import { simpleNameKey } from "./text";

/**
 * Three-way merge of two device states, by stable id (never by name).
 *
 *  - `base`   the snapshot at the last successful sync (the common ancestor)
 *  - `local`  this device's data, flattened
 *  - `remote` the server's current snapshot
 *
 * A change made on one side only is taken. The same change on both sides is taken once. Different
 * changes to the same field, a delete against an edit or an addition that depends on the deleted thing,
 * two versions of one session, and name collisions are CONFLICTS: nothing is chosen for the user, nothing
 * is renamed, no session is dropped. This step only detects; it takes no resolution input.
 *
 * Guarantee: if all three inputs are valid, there are no unresolved conflicts, and the merged target can be
 * represented by the S3 planner (`diffToOps(remote, target)` succeeds), the result is `merged`. Otherwise it
 * is `conflicted` (the data is valid but the sides disagree) or `refused` (an input is unusable or S3 cannot
 * express the result), with the reasons. A `conflicted` or `refused` result has no `target`, so it cannot be
 * mistaken for a snapshot that is safe to push.
 *
 * Rules (a field is "changed" on a side when it differs from base):
 *  - Class fields `name`, `color` and group fields `name`, `classId` merge one field at a time.
 *  - A session's `classId` + `groupId` move together as one unit; `startedAt`, `seconds` and `mode` are
 *    immutable, and any difference between versions of one session REFUSES the merge (`session_immutable_mismatch`):
 *    no operation can edit them, and neither version can be trusted over the other.
 *  - A session moved out of a class that the other side deleted survives in its new class when that class exists in
 *    the result (reported as `moved_session_kept`); a session added to or moved into the deleted class, moved within
 *    it (another subgroup), or moved to a class that does not survive is a conflict.
 *  - A session may only disappear together with its class. A session missing on one side while its base class
 *    still exists there is a conflict (`session_removal_unsupported`), never "repaired".
 *  - A deleted group's sessions that nobody touched are ungrouped (warning). A group deletion on one side does
 *    not count as a session move on that side: the other side's move out of the group is kept.
 *  - Name collisions are checked on the merged result under both the app's and a simple lowercasing rule.
 *
 * Decisions (`options.decisions`, S5 Phase 2): field, move and add-mismatch conflicts take the chosen side whole (a
 * session's class and subgroup together); a rename is applied to the final data and must not collide with any surviving
 * entity of its scope (class names across the app, subgroup names within the final parent class); `ungroup` keeps the
 * subgroup deleted and its sessions ungrouped; `ungroup_session` drops the subgroup of one session. Rejected decisions
 * are reported, never partly applied.
 *
 * List order is not merged: existing entities keep `remote`'s order, others follow sorted by id.
 * Pure: no network, storage or React; the inputs are never mutated and the result shares no objects with them.
 */

export type MergeOptions = {
  /** Ids that must not disappear (a running timer's class and subgroup). A merge that would delete one conflicts. */
  protect?: { classIds?: string[]; groupIds?: string[] };
  /** Options for the final S3 compatibility check. */
  diff?: DiffOptions;
  /**
   * User decisions about conflicts, by the fingerprint of the decision point (see `decisions.ts`). They are validated, and
   * the valid, applicable ones settle their conflicts; every rejected one is returned in `rejectedDecisions` and changes
   * nothing. A conflict without a valid decision stays a conflict. Never silently chosen for the user.
   */
  decisions?: unknown[];
};

type Entity = "class" | "group" | "session";

export type ConflictCode =
  | "class_field_conflict"
  | "class_deleted_vs_edited"
  | "class_add_mismatch"
  | "class_deleted_but_groups_added"
  | "class_deleted_but_groups_modified"
  | "class_deleted_but_sessions_added"
  | "class_deleted_but_sessions_modified"
  | "group_field_conflict"
  | "group_deleted_vs_edited"
  | "group_add_mismatch"
  | "group_deleted_but_sessions_added"
  | "group_deleted_but_sessions_moved_in"
  | "session_move_conflict"
  | "session_removal_unsupported"
  | "session_group_class_mismatch"
  | "name_collision"
  | "protected_entity_deleted";

export type MergeConflict = {
  code: ConflictCode;
  entity: Entity;
  id: string;
  field?: "name" | "color" | "classId" | "groupId" | "placement" | "startedAt" | "seconds" | "mode";
  base?: unknown;
  local?: unknown;
  remote?: unknown;
  relatedIds?: string[];
  message: string;
};

export type ResolutionCode = "same_change_both_sides" | "both_deleted" | "both_added_identical" | "moved_session_kept" | "decision_applied";

/** Settled automatically, with no user decision; reported for transparency. */
export type Resolution = { code: ResolutionCode; entity: Entity; id: string; field?: string; /** for `decision_applied`: the choice that was applied */ choice?: string };

export type WarningCode = "group_deleted_sessions_ungrouped" | "class_deleted_sessions_removed";

/** Merged fine, but the user may want to know. `ids` lists at most 20 affected sessions; `count` is the total. */
export type MergeWarning = { code: WarningCode; entity: "class" | "group"; id: string; ids: string[]; count: number; message: string };

export type MergeErrorCode =
  | "invalid_base"
  | "invalid_local"
  | "invalid_remote"
  | "session_immutable_mismatch"
  | "caps_exceeded"
  | "target_ineligible"
  | "not_representable";

export type MergeError = {
  code: MergeErrorCode;
  message: string;
  /** Validation problems, for the invalid_* codes, `caps_exceeded` and `target_ineligible`. */
  issues?: SyncIssue[];
  /** The planner's own error, kept unchanged, for `not_representable`. */
  diff?: DiffError;
  /** The sessions involved, for `session_immutable_mismatch` (at most 20; `count` is the total). */
  ids?: string[];
  count?: number;
};

export type MergeResult =
  | { status: "merged"; target: SyncSnapshot; resolutions: Resolution[]; warnings: MergeWarning[]; rejectedDecisions: RejectedDecision[] }
  | { status: "conflicted"; conflicts: MergeConflict[]; decisionPoints: DecisionPoint[]; resolutions: Resolution[]; warnings: MergeWarning[]; rejectedDecisions: RejectedDecision[] }
  | { status: "refused"; error: MergeError };

const MAX_LISTED_IDS = 20;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const index = <T extends { id: string }>(list: T[]) => new Map(list.map((x) => [x.id, x] as const));
const sortedUnion = (...maps: Map<string, unknown>[]) => [...new Set(maps.flatMap((m) => [...m.keys()]))].sort(cmp);

type Pick<T> = { ok: true; value: T; both: boolean } | { ok: false };
/** One field of three versions: take the changed side, accept an identical change, otherwise fail. */
function pick<T>(b: T, l: T, r: T): Pick<T> {
  if (l === r) return { ok: true, value: l, both: l !== b };
  if (l === b) return { ok: true, value: r, both: false };
  if (r === b) return { ok: true, value: l, both: false };
  return { ok: false };
}

type Placement = { classId: string; groupId: string | null };
const placementOf = (s: SyncSession): Placement => ({ classId: s.classId, groupId: s.groupId });
const samePlacement = (a: Placement, b: Placement) => a.classId === b.classId && a.groupId === b.groupId;
const sameImmutable = (a: SyncSession, b: SyncSession) => a.startedAt === b.startedAt && a.seconds === b.seconds && a.mode === b.mode;
const sameClass = (a: SyncClass, b: SyncClass) => a.name === b.name && a.color === b.color;
const sameGroup = (a: SyncGroup, b: SyncGroup) => a.name === b.name && a.classId === b.classId;

export function merge3(base: SyncSnapshot, local: SyncSnapshot, remote: SyncSnapshot, options: MergeOptions = {}): MergeResult {
  for (const [name, snap] of [["base", base], ["local", local], ["remote", remote]] as const) {
    const checked = fromSyncSnapshot(snap);
    if (!checked.ok) {
      const code = `invalid_${name}` as const;
      return { status: "refused", error: { code, message: `The ${name} snapshot is not valid, so nothing can be merged.`, issues: checked.issues } };
    }
  }

  // Two versions of one session that disagree on start, length or mode cannot be reconciled: nothing edits them and
  // neither side can be trusted over the other. Refuse, before anything else is looked at.
  const firstSeen = new Map<string, SyncSession>();
  const mismatched = new Set<string>();
  for (const list of [base.sessions, local.sessions, remote.sessions]) {
    for (const s of list) {
      const seen = firstSeen.get(s.id);
      if (!seen) firstSeen.set(s.id, s);
      else if (!sameImmutable(seen, s)) mismatched.add(s.id);
    }
  }
  if (mismatched.size > 0) {
    const ids = [...mismatched].sort(cmp);
    return {
      status: "refused",
      error: {
        code: "session_immutable_mismatch",
        message: `${ids.length} session(s) have different start times, lengths or modes in different versions. Sessions cannot be edited, so nothing can be merged until this is looked at.`,
        ids: ids.slice(0, MAX_LISTED_IDS),
        count: ids.length,
      },
    };
  }

  const bC = index(base.classes), lC = index(local.classes), rC = index(remote.classes);
  const bG = index(base.groups), lG = index(local.groups), rG = index(remote.groups);
  const bS = index(base.sessions), lS = index(local.sessions), rS = index(remote.sessions);
  const classesOf = { local: lC, remote: rC };
  const groupsOf = { local: lG, remote: rG };

  /** An accepted decision plus the keys of the conflicts of its decision point, as the undecided pass found them. */
  type Applied = AcceptedDecision & { keys: string[] };
  const conflictKey = (code: string, entity: string, id: string, field?: string) => `${code}\u0000${entity}\u0000${id}\u0000${field ?? ""}`;

  /**
   * One complete merge pass. With no decisions it is the plain three-way merge. With decisions, each conflict that a
   * decision covers is settled the way the decision says instead of being recorded; everything else is merged exactly
   * as before. A decision that turns out not to be applicable to the final data (a placement that does not exist, a
   * name that collides) is reported in `invalid` and the caller runs the pass again without it, so a rejected decision
   * never changes anything.
   */
  const runPass = (applied: Applied[]) => {
    const conflicts: MergeConflict[] = [];
    const resolutions: Resolution[] = [];
    const warnings: MergeWarning[] = [];
    const conflicted = new Set<string>();
    const conflict = (c: MergeConflict) => {
      conflicts.push(c);
      conflicted.add(`${c.entity}:${c.id}`);
    };
    const isConflicted = (entity: Entity, id: string) => conflicted.has(`${entity}:${id}`);

    const mergedClasses = new Map<string, SyncClass>();
    const mergedGroups = new Map<string, SyncGroup>();
    const mergedSessions = new Map<string, SyncSession>();

    // ---- what the decisions say, by conflict ----
    const choiceByKey = new Map<string, { choice: string; i: number }>();
    const renameDecisions: { i: number; entity: "class" | "group"; names: [string, string][] }[] = [];
    const ungroupGroups = new Map<string, number>(); // deleted subgroup id -> decision index
    const keepClasses = new Map<string, number>(); // deleted class id the user chose to restore -> decision index
    const keepGroups = new Map<string, number>(); // deleted subgroup id the user chose to restore -> decision index
    applied.forEach((a, i) => {
      const { point, decision } = a;
      if (point.kind === "field" || point.kind === "move" || point.kind === "add_mismatch" || point.kind === "group_class_mismatch") {
        for (const k of a.keys) choiceByKey.set(k, { choice: decision.choice, i });
      } else if (point.kind === "name_collision") {
        renameDecisions.push({ i, entity: point.entity === "group" ? "group" : "class", names: Object.entries(decision.names ?? {}) });
      } else if (point.kind === "group_deleted" && decision.choice === "ungroup") {
        ungroupGroups.set(point.id, i);
      } else if (point.kind === "group_deleted" && decision.choice === "keep_group") {
        keepGroups.set(point.id, i);
      } else if (point.kind === "class_deleted" && decision.choice === "keep_class") {
        keepClasses.set(point.id, i);
      }
      // delete_class and session_removal choices are unavailable (not implemented), so they are never accepted.
    });
    const used = new Set<number>();
    const invalid = new Map<number, RejectedReason>();
    const decidedGroups = new Map<string, number>(); // groups whose class or whole record a decision chose
    const decidedSessions = new Map<string, number>(); // sessions whose placement a decision chose
    const decided = (code: string, entity: string, id: string, field?: string) => {
      const found = choiceByKey.get(conflictKey(code, entity, id, field));
      if (found) used.add(found.i);
      return found;
    };
    const note = (entity: Entity, id: string, field: string | undefined, choice: string) =>
      resolutions.push({ code: "decision_applied", entity, id, ...(field ? { field } : {}), choice });

    // ---- classes ----
    for (const id of sortedUnion(bC, lC, rC)) {
      const b = bC.get(id), l = lC.get(id), r = rC.get(id);
      if (!b) {
        let chosen = (l ?? r)!;
        if (l && r && !sameClass(l, r)) {
          const d = decided("class_add_mismatch", "class", id);
          if (d) {
            chosen = d.choice === "keep_local" ? l : r; // the whole record of one side, never a mix
            note("class", id, undefined, d.choice);
          } else {
            conflict({ code: "class_add_mismatch", entity: "class", id, local: { ...l }, remote: { ...r }, message: "Both devices created a class with this id but with different contents." });
          }
        } else if (l && r) resolutions.push({ code: "both_added_identical", entity: "class", id });
        mergedClasses.set(id, { ...chosen });
        continue;
      }
      if (!l && !r) {
        resolutions.push({ code: "both_deleted", entity: "class", id });
        continue;
      }
      if (!l || !r) {
        const keeper = (l ?? r)!;
        const restoredBy = keepClasses.get(id);
        if (restoredBy !== undefined) {
          // Restore: the class stays, in the version of the side that still has it (its edits included). What it held on
          // that side stays too; what the other side deleted with it is handled by the groups and sessions passes below.
          used.add(restoredBy);
          note("class", id, undefined, "keep_class");
          mergedClasses.set(id, { ...keeper });
          continue;
        }
        if (sameClass(keeper, b)) continue; // deleted on one side, untouched on the other
        conflict({
          code: "class_deleted_vs_edited", entity: "class", id, base: { ...b }, local: l && { ...l }, remote: r && { ...r },
          message: `A class was deleted on ${l ? "the server" : "this device"} but edited on ${l ? "this device" : "the server"}.`,
        });
        mergedClasses.set(id, { ...keeper });
        continue;
      }
      const name = pick(b.name, l.name, r.name);
      const color = pick(b.color, l.color, r.color);
      let nameValue = name.ok ? name.value : b.name;
      let colorValue = color.ok ? color.value : b.color;
      if (!name.ok) {
        const d = decided("class_field_conflict", "class", id, "name");
        if (d) {
          nameValue = d.choice === "keep_local" ? l.name : r.name;
          note("class", id, "name", d.choice);
        } else conflict({ code: "class_field_conflict", entity: "class", id, field: "name", base: b.name, local: l.name, remote: r.name, message: "The class was renamed differently on both devices." });
      }
      if (!color.ok) {
        const d = decided("class_field_conflict", "class", id, "color");
        if (d) {
          colorValue = d.choice === "keep_local" ? l.color : r.color;
          note("class", id, "color", d.choice);
        } else conflict({ code: "class_field_conflict", entity: "class", id, field: "color", base: b.color, local: l.color, remote: r.color, message: "The class color was changed differently on both devices." });
      }
      if (name.ok && name.both) resolutions.push({ code: "same_change_both_sides", entity: "class", id, field: "name" });
      if (color.ok && color.both) resolutions.push({ code: "same_change_both_sides", entity: "class", id, field: "color" });
      mergedClasses.set(id, { id, name: nameValue, color: colorValue });
    }

    // ---- groups ----
    for (const id of sortedUnion(bG, lG, rG)) {
      const b = bG.get(id), l = lG.get(id), r = rG.get(id);
      if (!b) {
        let chosen = (l ?? r)!;
        if (l && r && !sameGroup(l, r)) {
          const d = decided("group_add_mismatch", "group", id);
          if (d) {
            chosen = d.choice === "keep_local" ? l : r;
            decidedGroups.set(id, d.i);
            note("group", id, undefined, d.choice);
          } else {
            conflict({ code: "group_add_mismatch", entity: "group", id, local: { ...l }, remote: { ...r }, message: "Both devices created a subgroup with this id but with different contents." });
          }
        } else if (l && r) resolutions.push({ code: "both_added_identical", entity: "group", id });
        mergedGroups.set(id, { ...chosen });
        continue;
      }
      if (!l && !r) {
        resolutions.push({ code: "both_deleted", entity: "group", id });
        continue;
      }
      if (!l || !r) {
        const keeper = (l ?? r)!;
        const deleter = l ? "remote" : "local";
        const viaClass = !classesOf[deleter].has(b.classId); // the group vanished because its class was deleted
        const restoredBy = viaClass ? keepClasses.get(b.classId) : keepGroups.get(id);
        if (restoredBy !== undefined) {
          // Restored with its class, or on its own: the subgroup stays, in the version of the side that still has it.
          if (!viaClass) {
            used.add(restoredBy);
            note("group", id, undefined, "keep_group");
          }
          decidedGroups.set(id, restoredBy);
          mergedGroups.set(id, { ...keeper });
          continue;
        }
        if (sameGroup(keeper, b)) continue;
        const ungroupedBy = viaClass ? undefined : ungroupGroups.get(id);
        if (ungroupedBy !== undefined) {
          // The deletion wins: the subgroup stays deleted and its sessions are ungrouped (see the sessions pass below).
          used.add(ungroupedBy);
          note("group", id, undefined, "ungroup");
          continue;
        }
        conflict({
          code: viaClass ? "class_deleted_but_groups_modified" : "group_deleted_vs_edited", entity: "group", id, base: { ...b },
          local: l && { ...l }, remote: r && { ...r }, relatedIds: viaClass ? [b.classId] : undefined,
          message: viaClass
            ? `A subgroup was edited on ${deleter === "remote" ? "this device" : "the server"}, but its class was deleted on ${deleter === "remote" ? "the server" : "this device"}.`
            : `A subgroup was deleted on ${deleter === "remote" ? "the server" : "this device"} but edited on the other side.`,
        });
        mergedGroups.set(id, { ...keeper });
        continue;
      }
      const name = pick(b.name, l.name, r.name);
      const classId = pick(b.classId, l.classId, r.classId);
      let nameValue = name.ok ? name.value : b.name;
      let classValue = classId.ok ? classId.value : b.classId;
      if (!name.ok) {
        const d = decided("group_field_conflict", "group", id, "name");
        if (d) {
          nameValue = d.choice === "keep_local" ? l.name : r.name;
          note("group", id, "name", d.choice);
        } else conflict({ code: "group_field_conflict", entity: "group", id, field: "name", base: b.name, local: l.name, remote: r.name, message: "The subgroup was renamed differently on both devices." });
      }
      if (!classId.ok) {
        const d = decided("group_field_conflict", "group", id, "classId");
        if (d) {
          classValue = d.choice === "keep_local" ? l.classId : r.classId;
          decidedGroups.set(id, d.i);
          note("group", id, "classId", d.choice);
        } else conflict({ code: "group_field_conflict", entity: "group", id, field: "classId", base: b.classId, local: l.classId, remote: r.classId, message: "The subgroup was moved to different classes on both devices." });
      }
      if (name.ok && name.both) resolutions.push({ code: "same_change_both_sides", entity: "group", id, field: "name" });
      if (classId.ok && classId.both) resolutions.push({ code: "same_change_both_sides", entity: "group", id, field: "classId" });
      mergedGroups.set(id, { id, classId: classValue, name: nameValue });
    }

    // ---- sessions ----
    const removedWithClass = new Map<string, string[]>(); // class id -> untouched sessions removed with it
    /** What a side did to a session, ignoring the automatic ungrouping its own group deletion caused. */
    const effective = (side: "local" | "remote", b: SyncSession, x: SyncSession): Placement => {
      if (b.groupId !== null && !groupsOf[side].has(b.groupId) && x.classId === b.classId && x.groupId === null) return placementOf(b);
      return placementOf(x);
    };

    for (const id of sortedUnion(bS, lS, rS)) {
      const b = bS.get(id), l = lS.get(id), r = rS.get(id);
      if (!b) {
        let chosen = (l ?? r)!;
        if (l && r) {
          if (!samePlacement(placementOf(l), placementOf(r))) {
            const d = decided("session_move_conflict", "session", id, "placement");
            if (d) {
              chosen = d.choice === "keep_local" ? l : r; // class and subgroup of one side together
              decidedSessions.set(id, d.i);
              note("session", id, "placement", d.choice);
            } else {
              conflict({ code: "session_move_conflict", entity: "session", id, field: "placement", local: placementOf(l), remote: placementOf(r), message: "Both devices created this session in different places." });
            }
          } else resolutions.push({ code: "both_added_identical", entity: "session", id });
        }
        mergedSessions.set(id, { ...chosen });
        continue;
      }
      const explainedLocally = !lC.has(b.classId);
      const explainedRemotely = !rC.has(b.classId);
      if (!l && !r) {
        if (!explainedLocally || !explainedRemotely) {
          conflict({ code: "session_removal_unsupported", entity: "session", id, base: { ...b }, relatedIds: [b.classId], message: "A session is missing on both sides although its class still exists on one of them; a session can only disappear with its class." });
        }
        continue;
      }
      if (!l || !r) {
        const keeper = (l ?? r)!;
        const keeperSide = l ? "local" : "remote";
        const explained = l ? explainedRemotely : explainedLocally;
        if (!explained) {
          conflict({ code: "session_removal_unsupported", entity: "session", id, base: { ...b }, local: l && { ...l }, remote: r && { ...r }, relatedIds: [b.classId], message: `A session is missing on ${l ? "the server" : "this device"} although its class still exists there; a session can only disappear with its class.` });
          mergedSessions.set(id, { ...keeper });
        } else if (keepClasses.has(b.classId) && mergedClasses.has(keeper.classId)) {
          // The class was restored: the session the other side deleted with it comes back, as the side that has it holds it.
          mergedSessions.set(id, { ...keeper });
        } else if (samePlacement(effective(keeperSide, b, keeper), placementOf(b))) {
          const list = removedWithClass.get(b.classId) ?? [];
          list.push(id);
          removedWithClass.set(b.classId, list);
        } else if (effective(keeperSide, b, keeper).classId !== b.classId && mergedClasses.has(effective(keeperSide, b, keeper).classId)) {
          // Moved out of a class the other side deleted, to a class that survives: the move wins, the class is still deleted.
          // The session keeps its id and immutable fields; if the server lost it with the class, the plan adds it again.
          mergedSessions.set(id, { ...b, ...effective(keeperSide, b, keeper) });
          resolutions.push({ code: "moved_session_kept", entity: "session", id });
        } else {
          conflict({ code: "class_deleted_but_sessions_modified", entity: "session", id, base: placementOf(b), local: l && placementOf(l), remote: r && placementOf(r), relatedIds: [b.classId], message: `A session was moved on ${keeperSide === "local" ? "this device" : "the server"}, but its class was deleted on the other side.` });
          mergedSessions.set(id, { ...keeper });
        }
        continue;
      }
      const bp = placementOf(b), lp = effective("local", b, l), rp = effective("remote", b, r);
      let merged: Placement;
      if (samePlacement(lp, rp)) {
        merged = lp;
        if (!samePlacement(lp, bp)) resolutions.push({ code: "same_change_both_sides", entity: "session", id, field: "placement" });
      } else if (samePlacement(lp, bp)) merged = rp;
      else if (samePlacement(rp, bp)) merged = lp;
      else {
        const d = decided("session_move_conflict", "session", id, "placement");
        if (d) {
          merged = d.choice === "keep_local" ? lp : rp; // class and subgroup of one side together
          decidedSessions.set(id, d.i);
          note("session", id, "placement", d.choice);
        } else {
          conflict({ code: "session_move_conflict", entity: "session", id, field: "placement", base: bp, local: lp, remote: rp, message: "The session was moved to different places on both devices." });
          merged = bp;
        }
      }
      mergedSessions.set(id, { ...b, ...merged });
    }

    // ---- references that no longer hold (entities with an open conflict are skipped: they are tentative) ----
    // A choice a decision made that leaves a reference broken is not turned into a new conflict: that decision is
    // reported in `invalid` and the pass is run again without it.
    for (const g of mergedGroups.values()) {
      if (isConflicted("group", g.id) || mergedClasses.has(g.classId)) continue;
      const by = decidedGroups.get(g.id);
      if (by !== undefined) {
        invalid.set(by, "invalid_result");
        continue;
      }
      const modified = bG.has(g.id);
      conflict({
        code: modified ? "class_deleted_but_groups_modified" : "class_deleted_but_groups_added", entity: "group", id: g.id, relatedIds: [g.classId],
        message: modified ? "A subgroup was moved into a class that was deleted on the other side." : "A subgroup was created in a class that was deleted on the other side.",
      });
    }
    const ungrouped = new Map<string, string[]>();
    const ungroup = (s: SyncSession, groupId: string) => {
      mergedSessions.set(s.id, { ...s, groupId: null });
      const list = ungrouped.get(groupId) ?? [];
      list.push(s.id);
      ungrouped.set(groupId, list);
    };
    for (const s of mergedSessions.values()) {
      if (isConflicted("session", s.id)) continue;
      const wasThere = bS.has(s.id);
      const by = decidedSessions.get(s.id);
      if (!mergedClasses.has(s.classId)) {
        if (by !== undefined) {
          invalid.set(by, "invalid_result");
          continue;
        }
        conflict({
          code: wasThere ? "class_deleted_but_sessions_modified" : "class_deleted_but_sessions_added", entity: "session", id: s.id, relatedIds: [s.classId],
          message: wasThere ? "A session was moved into a class that was deleted on the other side." : "A session was created in a class that was deleted on the other side.",
        });
        continue;
      }
      if (s.groupId === null) continue;
      const g = mergedGroups.get(s.groupId);
      if (!g) {
        const b = bS.get(s.id);
        const ungroupBy = ungroupGroups.get(s.groupId);
        if (b && b.classId === s.classId && b.groupId === s.groupId) {
          ungroup(s, s.groupId);
        } else if (ungroupBy !== undefined) {
          // decided: the subgroup stays deleted and this session keeps its class without a subgroup
          used.add(ungroupBy);
          ungroup(s, s.groupId);
        } else if (by !== undefined) {
          invalid.set(by, "invalid_result");
        } else {
          conflict({
            code: wasThere ? "group_deleted_but_sessions_moved_in" : "group_deleted_but_sessions_added", entity: "session", id: s.id, relatedIds: [s.groupId],
            message: wasThere ? "A session was moved into a subgroup that was deleted on the other side." : "A session was created in a subgroup that was deleted on the other side.",
          });
        }
      } else if (g.classId !== s.classId && !isConflicted("group", g.id)) {
        const d = decided("session_group_class_mismatch", "session", s.id);
        if (d) {
          mergedSessions.set(s.id, { ...s, groupId: null }); // the class stays, the subgroup goes
          note("session", s.id, "groupId", d.choice);
        } else if (by !== undefined) {
          invalid.set(by, "invalid_result");
        } else {
          conflict({ code: "session_group_class_mismatch", entity: "session", id: s.id, relatedIds: [g.id, s.classId], message: "The session's subgroup belongs to a different class after merging." });
        }
      }
    }

    // ---- rename decisions: evaluated against the final namespace, then applied ----
    // Class names are unique across the app, subgroup names within their (final) parent class, case-insensitively under
    // both lowercasing rules. A decision is judged in rounds, so one decision that gets rejected cannot take another down
    // with it. Entities named by a still-pending decision carry their proposed name; every other entity (and every entity
    // of an already rejected decision, which keeps its name from before) is FIXED. Each round:
    //   1. a decision with a proposed name that collides with a fixed name is rejected (only those, nothing else);
    //   2. only when no such decision is left, decisions whose names still collide with each other (or inside one
    //      decision) are all rejected;
    // then the namespace is recalculated, until nothing collides. A decision is atomic: one bad name rejects all of it.
    // The result depends only on the SET of decisions (never on their order) and nothing is adjusted, renamed or deleted.
    type Rename = { entity: "class" | "group"; id: string; i: number; name: string };
    const renames: Rename[] = [];
    for (const rd of renameDecisions) {
      const store = rd.entity === "class" ? mergedClasses : mergedGroups;
      if (!rd.names.every(([id]) => store.has(id))) {
        invalid.set(rd.i, "not_applicable"); // an entity it names does not survive the merge
        continue;
      }
      for (const [id, name] of rd.names) renames.push({ entity: rd.entity, id, i: rd.i, name });
    }
    const scopeOf = (entity: "class" | "group", id: string) => (entity === "class" ? "class" : `group:${mergedGroups.get(id)!.classId}`);
    const everyone: { entity: "class" | "group"; id: string; scope: string; name: string }[] = [
      ...[...mergedClasses.values()].map((c) => ({ entity: "class" as const, id: c.id, scope: scopeOf("class", c.id), name: c.name })),
      ...[...mergedGroups.values()].map((g) => ({ entity: "group" as const, id: g.id, scope: scopeOf("group", g.id), name: g.name })),
    ];
    const sameName = (x: string, y: string) => nameKey(x) === nameKey(y) || simpleNameKey(x) === simpleNameKey(y);
    const pendingIds = new Set(renames.map((r) => r.i));
    for (;;) {
      const live = renames.filter((r) => pendingIds.has(r.i));
      // One entity can be named by more than one pending decision (it can sit in two collision points when the two
      // lowercasing rules group names differently), so every entity has a LIST of proposals, never a single one.
      const proposals = new Map<string, Rename[]>();
      for (const r of live) proposals.set(`${r.entity}:${r.id}`, [...(proposals.get(`${r.entity}:${r.id}`) ?? []), r]);
      const fixedHits = new Set<number>();
      const pendingHits = new Set<number>();
      // Two different pending names for one entity are ambiguous: neither is chosen, every decision involved is rejected.
      for (const list of proposals.values()) {
        if (list.some((x) => x.name !== list[0].name)) for (const x of list) pendingHits.add(x.i);
      }
      for (const r of live) {
        const scope = scopeOf(r.entity, r.id);
        for (const other of everyone) {
          if (other.scope !== scope || (other.entity === r.entity && other.id === r.id)) continue;
          const theirs = proposals.get(`${other.entity}:${other.id}`);
          if (theirs === undefined) {
            if (sameName(r.name, other.name)) fixedHits.add(r.i);
          } else {
            for (const q of theirs) {
              if (!sameName(r.name, q.name)) continue;
              pendingHits.add(r.i);
              pendingHits.add(q.i);
            }
          }
        }
      }
      const reject = fixedHits.size > 0 ? fixedHits : pendingHits;
      if (reject.size === 0) break;
      for (const i of reject) {
        pendingIds.delete(i);
        invalid.set(i, "name_collision");
      }
    }
    for (const r of renames) {
      if (!pendingIds.has(r.i)) continue;
      used.add(r.i);
      if (r.entity === "class") mergedClasses.set(r.id, { ...mergedClasses.get(r.id)!, name: r.name });
      else mergedGroups.set(r.id, { ...mergedGroups.get(r.id)!, name: r.name });
      note(r.entity, r.id, "name", "rename");
    }

    // ---- name collisions on the merged result (conservative: either lowercasing rule) ----
    const collisions = (items: { id: string; name: string }[], entity: "class" | "group", scope: string) => {
      const seen = new Set<string>();
      for (const keyOf of [nameKey, simpleNameKey]) {
        const byKey = new Map<string, string[]>();
        for (const it of items) {
          if (isConflicted(entity, it.id)) continue;
          const key = keyOf(it.name);
          byKey.set(key, [...(byKey.get(key) ?? []), it.id]);
        }
        for (const ids of byKey.values()) {
          if (ids.length < 2) continue;
          ids.sort(cmp);
          const signature = ids.join("\u0000");
          if (seen.has(signature)) continue;
          seen.add(signature);
          const names = ids.map((i) => items.find((x) => x.id === i)!.name);
          conflict({ code: "name_collision", entity, id: ids[0], relatedIds: ids.slice(1), message: `After merging, ${entity === "class" ? "classes" : "subgroups"} ${scope}have the same name: ${names.map((n) => `"${n}"`).join(", ")}.` });
        }
      }
    };
    collisions([...mergedClasses.values()], "class", "");
    const groupsByClass = new Map<string, SyncGroup[]>();
    for (const g of mergedGroups.values()) groupsByClass.set(g.classId, [...(groupsByClass.get(g.classId) ?? []), g]);
    for (const [classId, list] of groupsByClass) collisions(list, "group", `in class ${classId} `);

    // ---- protected ids (a running timer): the merge may not delete them ----
    for (const id of [...new Set(options.protect?.classIds ?? [])].sort(cmp)) {
      if (lC.has(id) && !mergedClasses.has(id)) {
        conflict({ code: "protected_entity_deleted", entity: "class", id, message: "The merge would delete a class that a running timer is using." });
      }
    }
    for (const id of [...new Set(options.protect?.groupIds ?? [])].sort(cmp)) {
      if (lG.has(id) && !mergedGroups.has(id)) {
        conflict({ code: "protected_entity_deleted", entity: "group", id, message: "The merge would delete a subgroup that a running timer is using." });
      }
    }

    // ---- warnings ----
    const warn = (code: WarningCode, entity: "class" | "group", id: string, sessionIds: string[], message: string) =>
      warnings.push({ code, entity, id, ids: [...sessionIds].sort(cmp).slice(0, MAX_LISTED_IDS), count: sessionIds.length, message });
    for (const [groupId, ids] of ungrouped) warn("group_deleted_sessions_ungrouped", "group", groupId, ids, `${ids.length} session(s) were kept without a subgroup because their subgroup was deleted.`);
    for (const [classId, ids] of removedWithClass) {
      if (!mergedClasses.has(classId)) warn("class_deleted_sessions_removed", "class", classId, ids, `${ids.length} session(s) were removed together with their deleted class.`);
    }

    const byEntityId = (a: { entity: string; id: string; code: string; field?: string }, b: typeof a) =>
      cmp(a.entity, b.entity) || cmp(a.id, b.id) || cmp(a.code, b.code) || cmp(a.field ?? "", b.field ?? "");
    conflicts.sort(byEntityId);
    resolutions.sort(byEntityId);
    warnings.sort((a, b) => cmp(a.entity, b.entity) || cmp(a.id, b.id) || cmp(a.code, b.code));

    return { conflicts, resolutions, warnings, mergedClasses, mergedGroups, mergedSessions, invalid, used };
  };

  // ---- decisions: validated against the decision points of the undecided pass, then applied ----
  let run = runPass([]);
  let rejectedDecisions: RejectedDecision[] = [];
  const decisionList = options.decisions ?? [];
  if (decisionList.length > 0) {
    const undecided = run.conflicts;
    const points = buildDecisionPoints(undecided, { base, local, remote });
    const validated = validateDecisions(points, decisionList);
    rejectedDecisions = [...validated.rejected];
    let accepted: Applied[] = validated.accepted.map((a) => ({
      ...a,
      keys: a.point.members.map((m) => conflictKey(undecided[m].code, undecided[m].entity, undecided[m].id, undecided[m].field)),
    }));
    // Run again, dropping any decision the final data cannot take, until every remaining decision is applicable.
    // Each round removes at least one decision, so this ends.
    for (;;) {
      run = runPass(accepted);
      if (run.invalid.size === 0) break;
      const kept: Applied[] = [];
      accepted.forEach((a, i) => {
        const reason = run.invalid.get(i);
        if (reason) rejectedDecisions.push({ decision: a.raw, reason });
        else kept.push(a);
      });
      accepted = kept;
    }
    // A valid decision whose conflict no longer occurs once the others are applied changed nothing; say so.
    accepted.forEach((a, i) => {
      if (!run.used.has(i)) rejectedDecisions.push({ decision: a.raw, reason: "not_applicable" });
    });
  }

  const { conflicts, resolutions, warnings, mergedClasses, mergedGroups, mergedSessions } = run;
  if (conflicts.length > 0) {
    return { status: "conflicted", conflicts, decisionPoints: buildDecisionPoints(conflicts, { base, local, remote }), resolutions, warnings, rejectedDecisions };
  }

  // ---- build the target: remote's order for what it has, the rest sorted by id ----
  const ordered = <T extends { id: string }>(remoteList: T[], merged: Map<string, T>): T[] => {
    const out: T[] = [];
    const used = new Set<string>();
    for (const x of remoteList) {
      const m = merged.get(x.id);
      if (m) {
        out.push({ ...m });
        used.add(x.id);
      }
    }
    for (const id of [...merged.keys()].sort(cmp)) if (!used.has(id)) out.push({ ...merged.get(id)! });
    return out;
  };
  const target: SyncSnapshot = {
    classes: ordered(remote.classes, mergedClasses),
    groups: ordered(remote.groups, mergedGroups),
    sessions: ordered(remote.sessions, mergedSessions),
  };

  const eligible = fromSyncSnapshot(target);
  if (!eligible.ok) {
    const caps = eligible.issues.some((i) => i.code === "too_many_classes" || i.code === "too_many_groups" || i.code === "too_many_sessions");
    return {
      status: "refused",
      error: {
        code: caps ? "caps_exceeded" : "target_ineligible",
        message: caps ? "The merged data would exceed a server limit." : "The merged data would break a server rule.",
        issues: eligible.issues,
      },
    };
  }

  const plan = diffToOps(remote, target, options.diff);
  if (!plan.ok) {
    return { status: "refused", error: { code: "not_representable", message: `The merged data cannot be pushed: ${plan.error.message}`, diff: plan.error } };
  }

  return { status: "merged", target, resolutions, warnings, rejectedDecisions };
}
