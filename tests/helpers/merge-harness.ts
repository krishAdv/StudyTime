import { expect } from "vitest";
import type { DiffOptions } from "@/lib/sync/diff";
import { merge3, type MergeConflict, type MergeOptions, type MergeResult } from "@/lib/sync/merge";
import type { SyncSnapshot } from "@/lib/sync/snapshot";
import { canon, planAndApply } from "./sync-plan-harness";

/** A deep copy that tests can edit freely. */
export const clone = <T,>(v: T): T => structuredClone(v);

/** Freezes a snapshot all the way down, so any mutation by the code under test throws. */
export function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v)) deepFreeze(child);
  }
  return v;
}

/** `[code, entity, id]` of every conflict, in the order returned (the order is part of the contract). */
export const conflictKeys = (r: MergeResult) =>
  r.status === "conflicted" ? r.conflicts.map((c) => `${c.code}:${c.entity}:${c.id}`) : [];

export function conflictsOf(r: MergeResult): MergeConflict[] {
  if (r.status !== "conflicted") throw new Error(`expected a conflicted result, got ${r.status}`);
  return r.conflicts;
}

export function mergedTarget(r: MergeResult): SyncSnapshot {
  if (r.status === "refused") throw new Error(`expected a merged result, got refused: ${r.error.code} ${r.error.message}`);
  if (r.status === "conflicted") throw new Error(`expected a merged result, got conflicts: ${conflictKeys(r).join(", ")}`);
  return r.target;
}

/**
 * Merges, requires `merged`, then proves the target can be pushed: plans `diffToOps(remote, target)`, applies
 * every batch to the in-memory server and requires the server to end exactly at the target.
 */
export async function mergeAndPush(
  base: SyncSnapshot, local: SyncSnapshot, remote: SyncSnapshot, options?: MergeOptions, diff?: DiffOptions,
) {
  const result = merge3(base, local, remote, options);
  const target = mergedTarget(result);
  const pushed = await planAndApply(remote, target, diff);
  return { result, target, ...pushed };
}

/** Same data, compared without regard to list order. */
export const sameData = (a: SyncSnapshot, b: SyncSnapshot) => expect(canon(a)).toEqual(canon(b));
