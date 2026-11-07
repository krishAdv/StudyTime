import { PUSH_LIMITS, type SyncChange } from "./changes";
import { DEFAULT_BATCH_BYTES, diffToOps } from "./diff";
import { checkSyncEligibility, type SyncIssue } from "./eligibility";
import { snapshotKey, type SyncOutcome } from "./engine";
import { classifySyncError } from "./errors";
import { sha256Hex } from "./fingerprint";
import { fromSyncSnapshot } from "./from-snapshot";
import type { LinkCounts, LinkDeps } from "./link";
import { toSyncSnapshot, type RevisionedSnapshot, type SyncSnapshot } from "./snapshot";

/**
 * The two ways out when a linked device and the cloud can't be brought together by merging (M4.3 S9):
 *
 *  - USE CLOUD     This device's data is replaced by the cloud's. A safety copy of this device's data is saved first.
 *                  Anything that exists only on this device (changes not synced yet) is replaced.
 *  - REPLACE CLOUD The cloud's data is replaced by this device's, and so disappears from the user's other devices the
 *                  next time they sync. The server can't delete a single session, only a class with all its sessions, so
 *                  every class that differs between the two sides is deleted from the cloud and created again from this
 *                  device, in ONE push (all or nothing). Safety copies of this device's data AND of the cloud's data are
 *                  saved on this device first, so nothing is lost without a copy. If the plan does not fit one push, it
 *                  is refused rather than split.
 *
 * Shared rules, covered by tests:
 *  - The user confirms what they were shown: `link(action, seen)` needs the fingerprint of the inspected situation (this
 *    device's data, the cloud's data and the cloud revision). If any of it changed, nothing is done.
 *  - Nothing is pushed or replaced unless the backups were saved first. A failed backup stops everything.
 *  - The baseline is advanced only after the final state was read back from the cloud and verified.
 *  - "Use cloud" never runs while a timer is running, and replaces local data only if it did not change meanwhile.
 *  - Errors leave this device's data exactly as it was.
 */

export type EscapeAction = "use_cloud" | "replace_cloud";

export type EscapeInspection = {
  local: LinkCounts;
  cloud: LinkCounts;
  /** Sessions this device has and the cloud lacks: "use cloud" replaces them, "replace cloud" uploads them. */
  localOnlySessions: number;
  /** Sessions the cloud has and this device lacks: "use cloud" brings them, "replace cloud" removes them from the cloud. */
  cloudOnlySessions: number;
  actions: EscapeAction[];
  /** Why "replace cloud" is not offered, when it isn't. */
  replaceBlockedReason: string | null;
  issues: SyncIssue[];
  /** Identifies exactly what was inspected; `link` refuses when it no longer holds. */
  fingerprint: string;
};

export type EscapeOutcome =
  | { status: "done"; action: EscapeAction; revision: number }
  | { status: "changed"; inspection: EscapeInspection }
  | { status: "not_allowed"; inspection: EscapeInspection }
  | { status: "timer_running" }
  | { status: "refused"; message: string }
  | { status: "error"; outcome: Extract<SyncOutcome, { status: "error" }> };

type Stage = Extract<SyncOutcome, { status: "error" }>["stage"];

class Failure extends Error {
  constructor(readonly stage: Stage, readonly original: unknown) {
    super("escape step failed");
  }
}
async function at<T>(stage: Stage, step: () => T | Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (e) {
    throw new Failure(stage, e);
  }
}

const countsOf = (s: SyncSnapshot): LinkCounts => ({ classes: s.classes.length, groups: s.groups.length, sessions: s.sessions.length });
const hasData = (s: SyncSnapshot) => s.classes.length > 0 || s.sessions.length > 0;

/** One class with its subgroups and sessions, so two sides can be compared class by class. */
function classPart(s: SyncSnapshot, id: string): SyncSnapshot {
  return {
    classes: s.classes.filter((c) => c.id === id),
    groups: s.groups.filter((g) => g.classId === id),
    sessions: s.sessions.filter((x) => x.classId === id),
  };
}

export type ReplacePlan = { ok: true; ops: SyncChange[]; deletedClasses: number; recreatedClasses: number } | { ok: false; message: string };

/**
 * The operations that turn `remote` into `local`: every cloud class that differs from this device's version is deleted
 * (with its sessions) and every local class that differs is created again; classes that already match are left alone.
 * Built with the diff planner in two steps, so order and `expectedSessions` are right by construction. One push only.
 */
export function planReplaceCloud(remote: SyncSnapshot, local: SyncSnapshot): ReplacePlan {
  const same = new Set<string>();
  for (const c of remote.classes) {
    if (local.classes.some((l) => l.id === c.id) && snapshotKey(classPart(remote, c.id)) === snapshotKey(classPart(local, c.id))) same.add(c.id);
  }
  const intermediate: SyncSnapshot = {
    classes: remote.classes.filter((c) => same.has(c.id)),
    groups: remote.groups.filter((g) => same.has(g.classId)),
    sessions: remote.sessions.filter((s) => same.has(s.classId)),
  };
  const first = diffToOps(remote, intermediate);
  if (!first.ok) return { ok: false, message: `The cloud data can’t be replaced safely: ${first.error.message}` };
  const second = diffToOps(intermediate, local);
  if (!second.ok) return { ok: false, message: `This device’s data can’t be uploaded safely: ${second.error.message}` };
  const ops = [...first.ops, ...second.ops];
  if (ops.length > PUSH_LIMITS.maxChanges || JSON.stringify(ops).length > DEFAULT_BATCH_BYTES) {
    return { ok: false, message: "There is too much data to replace the cloud in one safe step. Nothing was changed." };
  }
  return { ok: true, ops, deletedClasses: remote.classes.length - same.size, recreatedClasses: local.classes.length - same.size };
}

export interface Escapes {
  /** Reads both sides and says what each escape would do. Changes nothing. */
  inspect(): Promise<
    | { status: "ok"; inspection: EscapeInspection; remote: RevisionedSnapshot }
    | { status: "not_linked" }
    | { status: "error"; outcome: Extract<SyncOutcome, { status: "error" }> }
  >;
  /** Does `action` if the situation is still the one the user saw (`seen` is `inspection.fingerprint`). */
  run(action: EscapeAction, seen: string): Promise<EscapeOutcome>;
}

export function createEscapes(deps: LinkDeps): Escapes {
  let busy = false;

  function describe(local: ReturnType<LinkDeps["getLocal"]>, remote: RevisionedSnapshot): EscapeInspection {
    const localSnap = toSyncSnapshot(local);
    const eligible = checkSyncEligibility(local);
    const issues = eligible.ok ? [] : eligible.issues;
    const remoteIds = new Set(remote.snapshot.sessions.map((s) => s.id));
    const localIds = new Set(localSnap.sessions.map((s) => s.id));
    let replaceBlockedReason: string | null = null;
    if (!eligible.ok) replaceBlockedReason = "Some of this device’s data can’t be synced yet (a name or limit the cloud doesn’t accept), so it can’t replace the cloud.";
    else {
      const plan = planReplaceCloud(remote.snapshot, localSnap);
      if (!plan.ok) replaceBlockedReason = plan.message;
    }
    return {
      local: countsOf(localSnap),
      cloud: countsOf(remote.snapshot),
      localOnlySessions: localSnap.sessions.filter((s) => !remoteIds.has(s.id)).length,
      cloudOnlySessions: remote.snapshot.sessions.filter((s) => !localIds.has(s.id)).length,
      actions: replaceBlockedReason === null ? ["use_cloud", "replace_cloud"] : ["use_cloud"],
      replaceBlockedReason,
      issues,
      fingerprint: sha256Hex(`${remote.revision}|${snapshotKey(localSnap)}|${snapshotKey(remote.snapshot)}`),
    };
  }

  const failure = (e: unknown) => {
    const outcome: Extract<SyncOutcome, { status: "error" }> =
      e instanceof Failure ? { status: "error", stage: e.stage, error: classifySyncError(e.original) } : { status: "error", stage: "unexpected", error: classifySyncError(e) };
    return { status: "error" as const, outcome };
  };

  async function inspect() {
    try {
      if (!(await at("baseline", () => deps.loadBaseline()))) return { status: "not_linked" as const };
      const local = deps.getLocal();
      const remote = await at("pull", () => deps.api.pullSnapshot());
      return { status: "ok" as const, inspection: describe(local, remote), remote };
    } catch (e) {
      return failure(e);
    }
  }

  async function run(action: EscapeAction, seen: string): Promise<EscapeOutcome> {
    if (busy) return { status: "refused", message: "Another step is already in progress." };
    busy = true;
    try {
      const fresh = await inspect();
      if (fresh.status === "error") return fresh;
      if (fresh.status === "not_linked") return { status: "refused", message: "This device isn’t linked yet." };
      const { inspection, remote } = fresh;
      if (inspection.fingerprint !== seen) return { status: "changed", inspection };
      if (!inspection.actions.includes(action)) return { status: "not_allowed", inspection };

      const local = deps.getLocal();
      const localSnap = toSyncSnapshot(local);

      if (action === "use_cloud") {
        if (deps.timerActive?.()) return { status: "timer_running" };
        const target = fromSyncSnapshot(remote.snapshot);
        if (!target.ok) return { status: "refused", message: "The cloud data can’t be stored on this device. Nothing was changed." };
        if (snapshotKey(localSnap) !== snapshotKey(remote.snapshot) && hasData(localSnap)) {
          await at("backup", () => deps.backup(local, { reason: "before_use_cloud", remoteRevision: remote.revision }));
        }
        const replaced = await at("apply", () => deps.replaceLocal(local, target.data));
        if (!replaced) return { status: "changed", inspection: describe(deps.getLocal(), remote) };
        await at("baseline", () => deps.saveBaseline({ revision: remote.revision, snapshot: remote.snapshot }));
        return { status: "done", action, revision: remote.revision };
      }

      // replace cloud
      const plan = planReplaceCloud(remote.snapshot, localSnap);
      if (!plan.ok) return { status: "refused", message: plan.message };
      if (deps.isLocalCurrent && !deps.isLocalCurrent()) return { status: "refused", message: "This device’s data was changed in another tab, so the cloud was not replaced. Reload this tab." };
      // Copies of both sides first. If either can't be saved, nothing is pushed.
      if (hasData(localSnap)) await at("backup", () => deps.backup(local, { reason: "before_replace_cloud", remoteRevision: remote.revision }));
      if (hasData(remote.snapshot)) {
        const cloudCopy = fromSyncSnapshot(remote.snapshot);
        if (!cloudCopy.ok) return { status: "refused", message: "Couldn’t make a safety copy of the cloud data, so it wasn’t replaced. Nothing was changed." };
        await at("backup", () => deps.backup(cloudCopy.data, { reason: "cloud_before_replace_cloud", remoteRevision: remote.revision }));
      }
      if (plan.ops.length > 0) {
        const pushed = await at("push", () => deps.api.pushChanges(remote.revision, plan.ops));
        if (pushed.status === "stale") return { status: "changed", inspection: describe(deps.getLocal(), (await at("pull", () => deps.api.pullSnapshot()))) };
      }
      // Read the cloud back: the baseline advances only if it now holds exactly what this device held.
      const after = await at("pull", () => deps.api.pullSnapshot());
      if (snapshotKey(after.snapshot) !== snapshotKey(localSnap)) {
        return { status: "refused", message: "The cloud doesn’t match this device after the replace, so nothing was marked as synced. Your data here is unchanged and safe copies were saved. Try again." };
      }
      await at("baseline", () => deps.saveBaseline({ revision: after.revision, snapshot: after.snapshot }));
      return { status: "done", action, revision: after.revision };
    } catch (e) {
      return failure(e);
    } finally {
      busy = false;
    }
  }

  return { inspect, run };
}
