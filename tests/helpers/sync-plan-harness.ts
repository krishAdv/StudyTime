import { expect } from "vitest";
import { toImportPayload } from "@/lib/sync/changes";
import { diffToOps, type DiffOptions, type DiffPlan, type DiffResult } from "@/lib/sync/diff";
import { fromSyncSnapshot } from "@/lib/sync/from-snapshot";
import type { SyncSnapshot } from "@/lib/sync/snapshot";
import { createFakeSyncServer, type FakeSyncServer } from "./fake-sync-server";

/** Small builders for flat snapshots. */
export const cls = (id: string, name: string, color = "#3b82f6") => ({ id, name, color });
export const grp = (id: string, classId: string, name: string) => ({ id, classId, name });
export const ses = (
  id: string, classId: string, groupId: string | null = null, startedAt = 1_700_000_000_000, seconds = 60,
  mode: "stopwatch" | "countdown" = "stopwatch",
) => ({ id, classId, groupId, startedAt, seconds, mode });
export const snap = (
  classes: SyncSnapshot["classes"] = [], groups: SyncSnapshot["groups"] = [], sessions: SyncSnapshot["sessions"] = [],
): SyncSnapshot => ({ classes, groups, sessions });

/** The same snapshot with every list sorted by id: equality that ignores the order the server happens to return. */
export const canon = (s: SyncSnapshot): SyncSnapshot => {
  const byId = <T extends { id: string }>(l: T[]) => [...l].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { classes: byId(s.classes), groups: byId(s.groups), sessions: byId(s.sessions) };
};

export const kinds = (ops: { op: string }[]) => ops.map((o) => o.op);

/** Puts `remote` on a fresh server account (through the import, like a first upload) and reads it back as a client would. */
export async function seed(server: FakeSyncServer, user: string, remote: SyncSnapshot) {
  const api = server.apiFor(user);
  if (remote.classes.length > 0 || remote.sessions.length > 0) {
    const nested = fromSyncSnapshot(remote);
    if (!nested.ok) throw new Error("the seed snapshot is not valid: " + JSON.stringify(nested.issues));
    await api.importAndInitSync("seed", toImportPayload(nested.data, new Date(0)));
  }
  return api.pullSnapshot();
}

export function planOk(result: DiffResult): DiffPlan {
  if (!result.ok) throw new Error(`expected a plan, got ${result.error.code}: ${result.error.message}`);
  return result;
}

/**
 * Applies every batch to the fake server in order, each at the revision the previous one produced.
 * Every batch must be accepted, and every operation must change a row (so no operation is unnecessary).
 */
export async function applyBatches(server: FakeSyncServer, user: string, batches: DiffPlan["batches"], startRevision: number) {
  const api = server.apiFor(user);
  let revision = startRevision;
  for (const batch of batches) {
    const r = await api.pushChanges(revision, batch);
    if (r.status !== "applied") throw new Error("a batch was answered stale");
    expect(r.changed, "every operation of a plan must change something").toBe(batch.length);
    expect(r.revision).toBe(revision + 1);
    revision = r.revision;
  }
  return revision;
}

/**
 * The full check used throughout: seed the server with `remote`, plan against what the server returns,
 * apply the plan, and require the server to end up exactly at `target` (compared ignoring list order).
 * Planning again from the final state must then give an empty plan.
 */
export async function planAndApply(remote: SyncSnapshot, target: SyncSnapshot, options?: DiffOptions) {
  const server = createFakeSyncServer();
  const user = "u";
  const before = await seed(server, user, remote);
  const plan = planOk(diffToOps(before.snapshot, target, options));
  const finalRevision = await applyBatches(server, user, plan.batches, before.revision);
  const after = await server.apiFor(user).pullSnapshot();
  expect(canon(after.snapshot)).toEqual(canon(target));
  expect(after.revision).toBe(before.revision + plan.batches.length);
  expect(finalRevision).toBe(after.revision);
  const again = planOk(diffToOps(after.snapshot, target, options));
  expect(again.ops, "planning from the final state must find nothing left to do").toEqual([]);
  return { plan, server, before, after };
}
