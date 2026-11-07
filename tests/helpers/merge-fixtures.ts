import { merge3, type MergeResult } from "@/lib/sync/merge";
import type { SyncSnapshot } from "@/lib/sync/snapshot";
import { clone } from "./merge-harness";
import { cls, grp, ses, snap } from "./sync-plan-harness";

/**
 * A small shared scenario for the S5 decision tests. Base: classes A "Math" and B "Art"; subgroups g1, g2 in A
 * and g3 in B; sessions s1 (A, g1), s2 (A), s3 (B) and s4 (B, g3). Tests edit copies of it on one or both sides.
 */
export const baseSnapshot = (): SyncSnapshot =>
  snap(
    [cls("A", "Math"), cls("B", "Art", "#8b5cf6")],
    [grp("g1", "A", "Unit 1"), grp("g2", "A", "Unit 2"), grp("g3", "B", "Sketch")],
    [ses("s1", "A", "g1", 1_000, 60), ses("s2", "A", null, 2_000, 120), ses("s3", "B", null, 3_000, 180), ses("s4", "B", "g3", 4_000, 240)],
  );

export type Edit = (d: SyncSnapshot) => void;
export const edited = (...edits: Edit[]): SyncSnapshot => {
  const d = baseSnapshot();
  for (const e of edits) e(d);
  return d;
};

export const find = {
  cls: (d: SyncSnapshot, id: string) => d.classes.find((c) => c.id === id)!,
  grp: (d: SyncSnapshot, id: string) => d.groups.find((g) => g.id === id)!,
  ses: (d: SyncSnapshot, id: string) => d.sessions.find((s) => s.id === id)!,
};

export const delClass =
  (id: string): Edit =>
  (d) => {
    d.classes = d.classes.filter((c) => c.id !== id);
    d.groups = d.groups.filter((g) => g.classId !== id);
    d.sessions = d.sessions.filter((s) => s.classId !== id);
  };

export const delGroup =
  (id: string): Edit =>
  (d) => {
    d.groups = d.groups.filter((g) => g.id !== id);
    for (const s of d.sessions) if (s.groupId === id) s.groupId = null;
  };

export const renameClass = (id: string, name: string): Edit => (d) => {
  find.cls(d, id).name = name;
};
export const renameGroup = (id: string, name: string): Edit => (d) => {
  find.grp(d, id).name = name;
};
export const move = (id: string, classId: string, groupId: string | null): Edit => (d) => {
  Object.assign(find.ses(d, id), { classId, groupId });
};
export const addSession = (id: string, classId: string, groupId: string | null = null, seconds = 30): Edit => (d) => {
  d.sessions.push(ses(id, classId, groupId, 9_000 + d.sessions.length, seconds));
};

/** Merges and requires conflicts, returning the whole conflicted result. */
export function conflictedOf(local: SyncSnapshot, remote: SyncSnapshot, base: SyncSnapshot = baseSnapshot(), options = {}) {
  const r: MergeResult = merge3(base, clone(local), clone(remote), options);
  if (r.status !== "conflicted") throw new Error(`expected conflicts, got ${r.status}`);
  return r;
}
