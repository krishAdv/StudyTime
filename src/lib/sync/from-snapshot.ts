import type { StoredData } from "../storage";
import type { ClassItem, GroupNode } from "../types";
import { checkSyncEligibility, type SyncIssue } from "./eligibility";
import type { RevisionedSnapshot, SyncSnapshot } from "./snapshot";

/**
 * The reverse of `toSyncSnapshot`: turns the server's flat snapshot into the local nested model.
 *
 * Server data is validated first and is never trusted: a group that points at a class that isn't
 * in the snapshot cannot be nested, and everything else goes through the same `checkSyncEligibility`
 * rules the upload side uses (names, ids, colors, session relationships, limits). Any problem makes
 * the whole conversion fail with structured issues. Nothing is repaired, skipped or dropped, no ids
 * are generated, and the input is never mutated or aliased.
 *
 * Order is preserved: classes keep their order, each class's subgroups keep their relative order
 * from the flat list (subgroups of different classes may be interleaved in the flat list, as the
 * server returns them in creation order), and sessions keep their order.
 *
 * Revision metadata is NOT part of the data: `fromSyncSnapshot` takes and returns data only, and
 * `fromRevisionedSnapshot` carries the revision through beside the converted data, unchanged.
 */
export type FromSnapshotResult =
  | { ok: true; data: StoredData }
  | { ok: false; issues: SyncIssue[]; totalIssues: number; truncated: boolean };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function fromSyncSnapshot(snapshot: SyncSnapshot, options: { maxIssues?: number } = {}): FromSnapshotResult {
  const maxIssues = options.maxIssues ?? 200;
  const raw = snapshot as unknown;
  if (!isObj(raw) || !Array.isArray(raw.classes) || !Array.isArray(raw.groups) || !Array.isArray(raw.sessions)) {
    return {
      ok: false,
      issues: [{
        code: "invalid_data",
        entity: "data",
        id: null,
        message: "The data from the server is not in the expected shape.",
        hint: "Try again later. Nothing on this device was changed.",
      }],
      totalIssues: 1,
      truncated: false,
    };
  }

  const structural: SyncIssue[] = [];
  const classes: ClassItem[] = [];
  const byId = new Map<string, ClassItem>();
  for (const c of snapshot.classes) {
    const item: ClassItem = { id: c.id, name: c.name, color: c.color, groups: [] };
    classes.push(item);
    if (!byId.has(c.id)) byId.set(c.id, item); // a repeated class id is reported by the eligibility check below
  }

  snapshot.groups.forEach((g, i) => {
    const owner = byId.get(g.classId);
    if (!owner) {
      structural.push({
        code: "group_class_missing",
        entity: "group",
        id: typeof g.id === "string" ? g.id : null,
        classId: typeof g.classId === "string" ? g.classId : undefined,
        position: i + 1,
        field: "classId",
        message: `Subgroup ${i + 1} of the server data belongs to a class that isn’t in that data.`,
        hint: "Try again later. Nothing on this device was changed.",
      });
      return;
    }
    const node: GroupNode = { id: g.id, name: g.name };
    owner.groups.push(node);
  });

  const data: StoredData = {
    classes,
    sessions: snapshot.sessions.map((s) => ({
      id: s.id,
      classId: s.classId,
      groupId: s.groupId,
      startedAt: s.startedAt,
      seconds: s.seconds,
      mode: s.mode,
    })),
  };

  const checked = checkSyncEligibility(data, { maxIssues });
  if (structural.length === 0 && checked.ok) return { ok: true, data };

  const rest = checked.ok ? [] : checked.issues;
  const restTotal = checked.ok ? 0 : checked.totalIssues;
  const all = [...structural, ...rest];
  const totalIssues = structural.length + restTotal;
  return { ok: false, issues: all.slice(0, maxIssues), totalIssues, truncated: totalIssues > Math.min(all.length, maxIssues) };
}

export type FromRevisionedResult =
  | { ok: true; revision: number; data: StoredData }
  | { ok: false; issues: SyncIssue[]; totalIssues: number; truncated: boolean };

/**
 * Converts a snapshot together with its revision. The revision is validated (a whole number, 0 or
 * more) and passed through untouched; it is never written into, or derived from, the data.
 */
export function fromRevisionedSnapshot(
  revisioned: RevisionedSnapshot,
  options: { maxIssues?: number } = {},
): FromRevisionedResult {
  const rev = (revisioned as { revision?: unknown } | null)?.revision;
  if (typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 0) {
    return {
      ok: false,
      issues: [{
        code: "invalid_revision",
        entity: "data",
        id: null,
        message: "The server sent an invalid revision number.",
        hint: "Try again later. Nothing on this device was changed.",
      }],
      totalIssues: 1,
      truncated: false,
    };
  }
  const converted = fromSyncSnapshot(revisioned.snapshot, options);
  return converted.ok ? { ok: true, revision: rev, data: converted.data } : converted;
}
