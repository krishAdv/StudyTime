import { nameKey, normalizeName } from "../class-rules";
import { SERVER_LIMITS } from "./eligibility";
import { canonicalize, compareCodeUnits, fingerprintOf, parseFingerprint, FINGERPRINT_VERSION, tri } from "./fingerprint";
import type { MergeConflict } from "./merge";
import type { SyncSnapshot } from "./snapshot";
import { codePointLength, hasUnstorableText, simpleNameKey } from "./text";

/**
 * Decision points and decisions (M4.3 S5).
 *
 * A DECISION POINT is one thing the user decides, built from the conflicts `merge3` found. A deleted class
 * (or subgroup) with dependents added or changed elsewhere is ONE point however many conflicts it causes, so
 * the choice is made once and cannot become a mix of "keep" and "delete". Every other conflict is its own point.
 *
 * A DECISION names a point by fingerprint and picks one of its choices. The fingerprint covers the complete
 * identity of the situation (see `fingerprintOf`), so a decision made earlier applies only if the same
 * situation is detected again. This file builds the points and validates decisions; `merge3` (merge.ts) applies the
 * valid ones. Implemented so far (Phase 2): field, move and add-mismatch choices, `rename`, `ungroup` and `ungroup_session`.
 * Choices whose application does not exist yet (restoring or deleting a deleted class or subgroup, anything about a
 * missing session) are marked `unavailable`, so a decision for them is rejected instead of being accepted and ignored.
 *
 * Not decision points: protected-entity deletions (deferred to the future engine) and immutable session
 * mismatches (refused by `merge3`).
 */

export type DecisionKind =
  | "field"
  | "move"
  | "add_mismatch"
  | "name_collision"
  | "class_deleted"
  | "group_deleted"
  | "group_class_mismatch"
  | "session_removal";

export type ChoiceInfo = {
  key: string;
  /** True when choosing it discards data that exists today (deleted sessions). */
  destructive: boolean;
  /** How many sessions the choice would remove, when it removes any. */
  sessionsRemoved?: number;
  /** Set when the choice cannot be used in this merge; the reason is plain text. Deciding it is rejected. */
  unavailable?: string;
};

export type DecisionPoint = {
  fingerprint: string;
  kind: DecisionKind;
  entity: "class" | "group" | "session";
  /** The entity the point is about (for a deleted class or group: that class or group). */
  id: string;
  /** Every entity id involved, sorted. A `rename` decision may only name these. */
  ids: string[];
  /** Indexes into the `conflicts` list this point was built from. */
  members: number[];
  choices: ChoiceInfo[];
};

export type Decision = { fingerprint: string; choice: string; names?: Record<string, string> };

export type RejectedReason =
  | "stale"
  | "unsupported_version"
  | "choice_not_allowed"
  | "choice_unavailable"
  | "invalid_payload"
  | "duplicate_conflicting"
  // reasons found only when a decision is applied (merge.ts):
  | "name_collision" // a rename collides with a surviving entity of its scope in the final data
  | "invalid_result" // the choice would leave a placement or relationship that does not exist in the final data
  | "not_applicable"; // the data the decision names does not survive the merge, or its conflict no longer occurs

/** `decision` is whatever was passed in (it may be malformed, so it is not typed as a Decision). */
export type RejectedDecision = { decision: unknown; reason: RejectedReason };

/** `decision` has any rename names normalized; `raw` is exactly what the caller passed in. */
export type AcceptedDecision = { point: DecisionPoint; decision: Decision; raw: unknown };

type Snapshots = { base: SyncSnapshot; local: SyncSnapshot; remote: SyncSnapshot };
type Side = keyof Snapshots;
const SIDES: Side[] = ["base", "local", "remote"];

const MAX_CHOICE_LENGTH = 64;
const MAX_RENAMES = 100;

function kindOf(c: MergeConflict): { kind: DecisionKind; root?: { entity: "class" | "group"; id: string } } | null {
  switch (c.code) {
    case "class_field_conflict":
    case "group_field_conflict":
      return { kind: "field" };
    case "session_move_conflict":
      return { kind: "move" };
    case "class_add_mismatch":
    case "group_add_mismatch":
      return { kind: "add_mismatch" };
    case "name_collision":
      return { kind: "name_collision" };
    case "class_deleted_vs_edited":
      return { kind: "class_deleted", root: { entity: "class", id: c.id } };
    case "class_deleted_but_groups_added":
    case "class_deleted_but_groups_modified":
    case "class_deleted_but_sessions_added":
    case "class_deleted_but_sessions_modified":
      return { kind: "class_deleted", root: { entity: "class", id: c.relatedIds?.[0] ?? c.id } };
    case "group_deleted_vs_edited":
      return { kind: "group_deleted", root: { entity: "group", id: c.id } };
    case "group_deleted_but_sessions_added":
    case "group_deleted_but_sessions_moved_in":
      return { kind: "group_deleted", root: { entity: "group", id: c.relatedIds?.[0] ?? c.id } };
    case "session_group_class_mismatch":
      return { kind: "group_class_mismatch" };
    case "session_removal_unsupported":
      return { kind: "session_removal" };
    case "protected_entity_deleted":
      return null; // deferred to the engine: not a user decision
  }
}

const idKey = (a: { id: string }, b: { id: string }) => compareCodeUnits(a.id, b.id);

/**
 * A dictionary with no prototype. Entity ids are arbitrary strings that pass eligibility, so `"__proto__"`,
 * `"constructor"` or `"toString"` are valid ids; on an ordinary object `d["__proto__"] = x` sets the prototype
 * instead of adding a key. Here every id is an ordinary own key, and the canonical encoder accepts null-prototype
 * objects, so the encoded text for ordinary ids is exactly what a plain object would give.
 */
const dictionary = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

/** Everything about the involved entities, on each side, with absence kept distinct from null. */
function contextFor(ids: string[], root: { entity: "class" | "group"; id: string } | undefined, snaps: Snapshots) {
  const entities: Record<string, Record<string, Record<Side, unknown>>> = dictionary();
  entities.class = dictionary();
  entities.group = dictionary();
  entities.session = dictionary();
  for (const [entity, list] of [["class", "classes"], ["group", "groups"], ["session", "sessions"]] as const) {
    for (const id of ids) {
      const found = SIDES.map((side) => (snaps[side][list] as { id: string }[]).find((x) => x.id === id));
      if (found.every((x) => x === undefined)) continue;
      entities[entity][id] = { base: tri(found[0]), local: tri(found[1]), remote: tri(found[2]) };
    }
  }
  let subtree: Record<Side, unknown> | undefined;
  if (root) {
    const pick = (side: Side) => {
      const s = snaps[side];
      if (root.entity === "class") {
        return {
          groups: s.groups.filter((g) => g.classId === root.id).sort(idKey),
          sessions: s.sessions.filter((x) => x.classId === root.id).sort(idKey),
        };
      }
      return { sessions: s.sessions.filter((x) => x.groupId === root.id).sort(idKey) };
    };
    subtree = { base: pick("base"), local: pick("local"), remote: pick("remote") };
  }
  return { entities, subtree };
}

function choicesFor(kind: DecisionKind, root: { entity: "class" | "group"; id: string } | undefined, snaps: Snapshots): ChoiceInfo[] {
  switch (kind) {
    case "field":
    case "move":
    case "add_mismatch":
      return [{ key: "keep_local", destructive: false }, { key: "keep_remote", destructive: false }];
    case "name_collision":
      return [{ key: "rename", destructive: false }];
    case "class_deleted": {
      const doomed = new Set<string>();
      for (const side of ["local", "remote"] as const) for (const s of snaps[side].sessions) if (s.classId === root?.id) doomed.add(s.id);
      return [
        { key: "keep_class", destructive: false },
        { key: "delete_class", destructive: true, sessionsRemoved: doomed.size, unavailable: "deleting a class together with its sessions is not implemented yet" },
      ];
    }
    case "group_deleted":
      return [{ key: "keep_group", destructive: false }, { key: "ungroup", destructive: false }];
    case "group_class_mismatch":
      return [{ key: "ungroup_session", destructive: false }];
    case "session_removal":
      return [
        { key: "restore", destructive: false, unavailable: "session removal and restoring are not implemented yet" },
        { key: "remove", destructive: true, sessionsRemoved: 1, unavailable: "removing a single session is not implemented yet" },
      ];
  }
}

/**
 * Groups `conflicts` into decision points. `conflicts` must be the exact list the merge returned (the
 * `members` indexes refer to it). The result is deterministic: the same inputs give the same points in the
 * same order with the same fingerprints.
 */
export function buildDecisionPoints(conflicts: MergeConflict[], snaps: Snapshots): DecisionPoint[] {
  type Group = { kind: DecisionKind; root?: { entity: "class" | "group"; id: string }; members: number[] };
  const groups = new Map<string, Group>();
  conflicts.forEach((c, index) => {
    const k = kindOf(c);
    if (!k) return;
    const key = k.root ? `${k.kind}\u0000${k.root.id}` : `own\u0000${index}`;
    const g = groups.get(key) ?? { kind: k.kind, root: k.root, members: [] };
    g.members.push(index);
    groups.set(key, g);
  });

  const points: DecisionPoint[] = [];
  for (const g of groups.values()) {
    const list = g.members.map((i) => conflicts[i]);
    const ids = [...new Set([...(g.root ? [g.root.id] : []), ...list.flatMap((c) => [c.id, ...(c.relatedIds ?? [])])])].sort(compareCodeUnits);
    const members = list
      .map((c) => ({
        code: c.code, entity: c.entity, id: c.id, field: tri(c.field), relatedIds: c.relatedIds ?? [],
        values: { base: tri(c.base), local: tri(c.local), remote: tri(c.remote) },
      }))
      .sort((a, b) => compareCodeUnits(canonicalize(a), canonicalize(b)));
    const { entities, subtree } = contextFor(ids, g.root, snaps);
    const first = list[0];
    const entity = g.root ? g.root.entity : first.entity;
    const id = g.root ? g.root.id : first.id;
    points.push({
      fingerprint: fingerprintOf({ kind: g.kind, entity, id, members, entities, subtree: tri(subtree) }),
      kind: g.kind, entity, id, ids,
      members: [...g.members],
      choices: choicesFor(g.kind, g.root, snaps),
    });
  }
  return points.sort((a, b) => compareCodeUnits(a.entity, b.entity) || compareCodeUnits(a.id, b.id) || compareCodeUnits(a.kind, b.kind) || compareCodeUnits(a.fingerprint, b.fingerprint));
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** The strict shape of one decision; null when it is not one. */
function readDecision(raw: unknown): Decision | null {
  if (!isRecord(raw)) return null;
  for (const key of Object.keys(raw)) if (key !== "fingerprint" && key !== "choice" && key !== "names") return null;
  if (typeof raw.fingerprint !== "string" || typeof raw.choice !== "string") return null;
  if (raw.choice.length === 0 || raw.choice.length > MAX_CHOICE_LENGTH) return null;
  const decision: Decision = { fingerprint: raw.fingerprint, choice: raw.choice };
  if ("names" in raw) {
    const names = raw.names;
    if (!isRecord(names) || Object.keys(names).length === 0 || Object.keys(names).length > MAX_RENAMES) return null;
    if (!Object.values(names).every((v) => typeof v === "string")) return null;
    decision.names = { ...(names as Record<string, string>) };
  }
  return decision;
}

/**
 * Reads a rename payload and returns its names normalized, or null when it is not valid. Every new name is normalized the
 * way every class and subgroup name is (trimmed, inner whitespace collapsed) and the saved name is the normalized one.
 * The normalized name must be 1..60 characters, storable, and distinct (under both lowercasing rules) from the other
 * names in the same payload, and it may only name entities the point involves.
 *
 * This does NOT check a name against the names that already exist: `validateDecisions` sees decision points, not the
 * snapshots or the merged result. That check is made by `merge3` against the final merged data when it applies the
 * decision (class names unique across the app, subgroup names unique within their final parent class); a rename that
 * collides there is rejected with the reason `name_collision`.
 */
function readRename(decision: Decision, point: DecisionPoint): Record<string, string> | null {
  const names = decision.names;
  if (!names) return null;
  const seen = new Set<string>();
  const entries: [string, string][] = [];
  for (const [id, name] of Object.entries(names)) {
    if (!point.ids.includes(id)) return null;
    const clean = normalizeName(name);
    const length = codePointLength(clean);
    if (length < 1 || length > SERVER_LIMITS.maxNameLength) return null;
    if (hasUnstorableText(clean)) return null;
    for (const key of [`a${nameKey(clean)}`, `b${simpleNameKey(clean)}`]) {
      if (seen.has(key)) return null;
      seen.add(key);
    }
    entries.push([id, clean]);
  }
  // fromEntries defines own keys, so an id such as "__proto__" is kept instead of replacing the prototype
  return Object.fromEntries(entries);
}

/**
 * Checks decisions against the decision points of the CURRENT merge. Nothing is applied and nothing throws:
 * every decision ends up accepted or rejected with a reason, in this order of checks: malformed, unknown
 * fingerprint format, other version, no matching point (stale), same fingerprint decided two different ways,
 * choice not offered, choice unavailable, payload not valid for the choice.
 * Identical repeats of one decision collapse into one accepted decision.
 *
 * "Accepted" means the decision is well-formed and matches a current point and one of its available choices. It does
 * not yet mean the decision can be applied: `merge3` still rejects an accepted rename that collides with an existing
 * name, or a choice that would leave a placement that does not exist.
 */
export function validateDecisions(points: DecisionPoint[], decisions: unknown[]): { accepted: AcceptedDecision[]; rejected: RejectedDecision[] } {
  const byFingerprint = new Map(points.map((p) => [p.fingerprint, p]));
  const rejected: RejectedDecision[] = [];
  const candidates = new Map<string, { raw: unknown; decision: Decision }[]>();

  for (const raw of decisions) {
    const decision = readDecision(raw);
    const parsed = decision && parseFingerprint(decision.fingerprint);
    if (!decision || !parsed) {
      rejected.push({ decision: raw, reason: "invalid_payload" });
    } else if (parsed.version !== FINGERPRINT_VERSION) {
      rejected.push({ decision: raw, reason: "unsupported_version" });
    } else if (!byFingerprint.has(decision.fingerprint)) {
      rejected.push({ decision: raw, reason: "stale" });
    } else {
      const list = candidates.get(decision.fingerprint) ?? [];
      list.push({ raw, decision });
      candidates.set(decision.fingerprint, list);
    }
  }

  const accepted: AcceptedDecision[] = [];
  for (const point of points) {
    const list = candidates.get(point.fingerprint);
    if (!list) continue;
    const forms = new Set(list.map((x) => canonicalize({ choice: x.decision.choice, names: tri(x.decision.names) })));
    if (forms.size > 1) {
      for (const x of list) rejected.push({ decision: x.raw, reason: "duplicate_conflicting" });
      continue;
    }
    const { raw, decision } = list[0];
    const choice = point.choices.find((c) => c.key === decision.choice);
    if (!choice) rejected.push({ decision: raw, reason: "choice_not_allowed" });
    else if (choice.unavailable !== undefined) rejected.push({ decision: raw, reason: "choice_unavailable" });
    else if (choice.key === "rename") {
      const names = readRename(decision, point);
      if (names) accepted.push({ point, decision: { ...decision, names }, raw });
      else rejected.push({ decision: raw, reason: "invalid_payload" });
    } else if (decision.names !== undefined) rejected.push({ decision: raw, reason: "invalid_payload" });
    else accepted.push({ point, decision, raw });
  }
  return { accepted, rejected };
}
