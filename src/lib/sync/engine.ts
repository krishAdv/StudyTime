import type { StoredData } from "../storage";
import type { SyncApi } from "./api";
import { diffToOps } from "./diff";
import { checkSyncEligibility, type SyncIssue } from "./eligibility";
import { classifySyncError, type SyncError } from "./errors";
import { fromSyncSnapshot } from "./from-snapshot";
import { merge3, type MergeConflict, type MergeError, type MergeOptions } from "./merge";
import type { DecisionPoint, RejectedDecision } from "./decisions";
import type { RevisionedSnapshot, SyncSnapshot } from "./snapshot";

/**
 * The sync engine (M4.3 S6): one `syncOnce()` pass is pull, three-way merge, push, then bring the local data in line.
 * It is plain TypeScript with everything it touches injected, so it is tested against the in-memory fake server and
 * wired into the app by `features/sync/sync-provider.tsx` (S7), which decides when a pass runs.
 *
 * The baseline is the last state that BOTH this device and the server were known to hold (a snapshot and the server
 * revision it was read at). It is saved only after local data has reached that state, never before. That is what makes
 * every failure safe: if a pass dies halfway, the baseline is still the old one, and the next pass sees the local
 * changes that already reached the server as identical changes on both sides (taken once) and merges the rest.
 *
 * Safety rules, all covered by tests:
 *  - Nothing is pushed unless the merge returned `merged`. A conflict or a refusal changes neither side.
 *  - A remote older than the baseline, or with different data at the same revision, is refused.
 *  - Local data is replaced only after a backup of it was saved, and only if it did not change during the pass
 *    (otherwise the pass runs again). A failed backup means the remote data is not applied.
 *  - A network or server error leaves local data and the baseline untouched.
 *  - A stale push (another device pushed first) pulls and merges again, up to `maxAttempts` times.
 *  - Ids a running timer uses are protected: a merge that would delete them is a conflict.
 */

/**
 * Why a copy of data was kept: before remote data replaced local data (a normal pass), before first link replaced it,
 * before "use cloud" replaced it, before "replace cloud" (a copy of THIS device's data), and a copy of the CLOUD's data
 * taken before "replace cloud" overwrote it.
 */
export type SyncBackupReason = "before_apply_remote" | "before_first_link" | "before_use_cloud" | "before_replace_cloud" | "cloud_before_replace_cloud";

export type SyncEngineDeps = {
  api: SyncApi;
  /** The baseline for the signed-in account, or null when this device is not linked yet (S8 links it). */
  loadBaseline(): RevisionedSnapshot | null | Promise<RevisionedSnapshot | null>;
  saveBaseline(baseline: RevisionedSnapshot): void | Promise<void>;
  /** The current local data. The same object must be returned until local data changes. */
  getLocal(): StoredData;
  /**
   * Replaces local data with `next`, but only if local data is still exactly `expected`; returns false (changing
   * nothing) when it changed in the meantime, so a study session saved during a sync is never overwritten.
   */
  replaceLocal(expected: StoredData, next: StoredData): boolean | Promise<boolean>;
  /** Keeps a copy of local data before remote data replaces it. It must throw or reject when it could not save it. */
  backup(data: StoredData, info: { reason: SyncBackupReason; remoteRevision: number }): void | Promise<void>;
  /** Ids the merge may not delete (the class and subgroup of a running timer). */
  protect?(): MergeOptions["protect"];
  /**
   * Asked right before anything is pushed. False means this device's data was changed by something else since the pass
   * read it (another tab), so what was merged is out of date: nothing is pushed and the pass stops with `refused`.
   */
  isLocalCurrent?(): boolean;
  /** Pushes of a stale revision, or local changes during a pass, are retried this many times in all. Default 4. */
  maxAttempts?: number;
};

export type SyncStage = "pull" | "push" | "backup" | "apply" | "baseline" | "unexpected";

export type SyncOutcome =
  /** Nothing differed. No push, no write. */
  | { status: "up_to_date"; revision: number }
  /** Local and server now hold the same data. `pushed` operations were sent; `applied` is true when local data was replaced. */
  | { status: "synced"; revision: number; pushed: number; applied: boolean }
  /** This device has no baseline yet (first link, S8). Nothing was done. */
  | { status: "not_linked" }
  /** Local data breaks a server rule (names, caps, ...). Nothing was done. */
  | { status: "ineligible"; issues: SyncIssue[] }
  /** The two sides disagree. Nothing was pushed or changed; decide with `options.decisions` and run again. */
  | { status: "conflicted"; conflicts: MergeConflict[]; decisionPoints: DecisionPoint[]; rejectedDecisions: RejectedDecision[]; snapshots: { base: SyncSnapshot; local: SyncSnapshot; remote: SyncSnapshot } }
  /** Something does not add up, so nothing was done. `merge` carries the merge's own error for `merge_refused`. */
  | { status: "refused"; reason: "remote_older" | "remote_changed_without_revision" | "merge_refused" | "not_representable" | "local_changed_elsewhere"; message: string; merge?: MergeError }
  /** Gave up after `maxAttempts` (another device kept pushing, or local data kept changing). Try again later. */
  | { status: "busy" }
  /** A network, server, auth or storage failure. `stage` says where. Local data is exactly as it was unless `stage` is later than `push`. */
  | { status: "error"; stage: SyncStage; error: SyncError };

export type SyncOptions = {
  /** User decisions for the conflicts a previous pass reported (see `merge3`). */
  decisions?: unknown[];
};

export interface SyncEngine {
  /** Runs one pass. Calls made while a pass is running share its result. */
  syncOnce(options?: SyncOptions): Promise<SyncOutcome>;
}

const DEFAULT_MAX_ATTEMPTS = 4;

/** Order-independent text of a snapshot, for equality (the server and the merge may order lists differently). */
export function snapshotKey(s: SyncSnapshot): string {
  const byId = <T extends { id: string }>(list: T[]) => [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify([
    byId(s.classes).map((c) => [c.id, c.name, c.color]),
    byId(s.groups).map((g) => [g.id, g.classId, g.name]),
    byId(s.sessions).map((x) => [x.id, x.classId, x.groupId, x.startedAt, x.seconds, x.mode]),
  ]);
}

class StageError extends Error {
  constructor(readonly stage: SyncStage, readonly original: unknown) {
    super("sync stage failed");
  }
}

/** Runs one step; anything it throws is tagged with the stage it happened in. */
async function at<T>(stage: SyncStage, step: () => T | Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (e) {
    throw new StageError(stage, e);
  }
}

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  const maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  let running: Promise<SyncOutcome> | null = null;

  /** One attempt: an outcome, or "again" when another device pushed first or local data changed during the pass. */
  async function attempt(options: SyncOptions): Promise<SyncOutcome | "again"> {
    const local = deps.getLocal();
    const eligible = checkSyncEligibility(local);
    if (!eligible.ok) return { status: "ineligible", issues: eligible.issues };
    const localSnapshot = eligible.snapshot;

    const base = await at("baseline", () => deps.loadBaseline());
    if (!base) return { status: "not_linked" };

    const remote = await at("pull", () => deps.api.pullSnapshot());
    if (remote.revision < base.revision) {
      return { status: "refused", reason: "remote_older", message: `The server is at revision ${remote.revision}, behind this device's last sync (${base.revision}). Nothing was changed.` };
    }
    const remoteIsBase = snapshotKey(remote.snapshot) === snapshotKey(base.snapshot);
    if (remote.revision === base.revision && !remoteIsBase) {
      return { status: "refused", reason: "remote_changed_without_revision", message: "The server data differs from the last sync at the same revision. Nothing was changed." };
    }
    if (remoteIsBase && snapshotKey(localSnapshot) === snapshotKey(base.snapshot)) {
      return { status: "up_to_date", revision: remote.revision };
    }

    const merged = merge3(base.snapshot, localSnapshot, remote.snapshot, { protect: deps.protect?.(), decisions: options.decisions });
    if (merged.status === "conflicted") {
      return {
        status: "conflicted", conflicts: merged.conflicts, decisionPoints: merged.decisionPoints, rejectedDecisions: merged.rejectedDecisions,
        snapshots: { base: base.snapshot, local: localSnapshot, remote: remote.snapshot },
      };
    }
    if (merged.status === "refused") {
      return { status: "refused", reason: "merge_refused", message: merged.error.message, merge: merged.error };
    }
    const plan = diffToOps(remote.snapshot, merged.target);
    if (!plan.ok) return { status: "refused", reason: "not_representable", message: plan.error.message };
    const target = fromSyncSnapshot(merged.target);
    if (!target.ok) return { status: "refused", reason: "not_representable", message: "The merged data cannot be stored locally." };

    if (deps.isLocalCurrent && !deps.isLocalCurrent()) {
      return { status: "refused", reason: "local_changed_elsewhere", message: "This device’s data was changed in another tab while syncing, so nothing was pushed. Reload this tab." };
    }

    // push, one batch at a time, each at the revision the previous one produced
    let revision = remote.revision;
    for (const batch of plan.batches) {
      const pushed = await at("push", () => deps.api.pushChanges(revision, batch));
      if (pushed.status === "stale") return "again";
      revision = pushed.revision;
    }

    // bring local data to the merged state: backup first, and only if local data did not change meanwhile
    let applied = false;
    if (snapshotKey(localSnapshot) !== snapshotKey(merged.target)) {
      await at("backup", () => deps.backup(local, { reason: "before_apply_remote", remoteRevision: revision }));
      const replaced = await at("apply", () => deps.replaceLocal(local, target.data));
      if (!replaced) return "again";
      applied = true;
    }

    await at("baseline", () => deps.saveBaseline({ revision, snapshot: merged.target }));
    return { status: "synced", revision, pushed: plan.ops.length, applied };
  }

  async function run(options: SyncOptions): Promise<SyncOutcome> {
    try {
      for (let i = 0; i < maxAttempts; i++) {
        const outcome = await attempt(options);
        if (outcome !== "again") return outcome;
      }
      return { status: "busy" };
    } catch (e) {
      if (e instanceof StageError) return { status: "error", stage: e.stage, error: classifySyncError(e.original) };
      return { status: "error", stage: "unexpected", error: classifySyncError(e) };
    }
  }

  return {
    syncOnce(options = {}) {
      if (!running) {
        running = run(options).finally(() => {
          running = null;
        });
      }
      return running;
    },
  };
}
