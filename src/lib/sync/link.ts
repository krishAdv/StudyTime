import type { StoredData } from "../storage";
import { toImportPayload } from "./changes";
import { diffToOps } from "./diff";
import { checkSyncEligibility, type SyncIssue } from "./eligibility";
import { createSyncEngine, snapshotKey, type SyncEngineDeps, type SyncOutcome } from "./engine";
import { classifySyncError } from "./errors";
import { sha256Hex } from "./fingerprint";
import { fromSyncSnapshot } from "./from-snapshot";
import { merge3 } from "./merge";
import { toSyncSnapshot, type RevisionedSnapshot, type SyncSnapshot } from "./snapshot";

/**
 * First link (M4.3 S8): connects a device that has no baseline to its account's cloud data. Nothing here runs by itself:
 * `inspect()` only reads (one pull), and `link(action, seen)` does exactly the one action the user confirmed.
 *
 * Scenarios, decided from the device's data and the cloud's data:
 *  - match       Both sides hold the same data (or both are empty). Linking changes nothing on either side.
 *  - upload      This device has data, the cloud is empty. Linking uploads it with `import_and_init_sync`.
 *  - adopt       This device is empty, the cloud has data. Linking copies the cloud's data here.
 *  - both        Both have different data. Nothing is guessed: the user picks `use_cloud` (a backup of this device's data
 *                is saved, then it is replaced by the cloud's) or `combine` (everything from both sides is kept; offered
 *                only when that works without any naming conflict). Replacing the cloud with this device is not offered.
 *  - ineligible  This device's data breaks a cloud rule, so it can't be uploaded or combined (the cloud's data can still
 *                be used).
 *
 * Safety rules, all covered by tests:
 *  - The baseline is saved only after both sides really hold the linked state, so an interrupted attempt leaves the
 *    device "not linked" and can simply be retried. Retrying is safe: an import that went through but whose answer was
 *    lost shows up as "match" the next time.
 *  - The user confirms what they were shown. If either side changed since (`seen` no longer matches), nothing is done and
 *    the new situation is returned to be confirmed again.
 *  - Local data is replaced only after a backup of it was saved (a failed backup means nothing is replaced), only if it did
 *    not change meanwhile, and never while a timer is running.
 *  - An upload is verified by reading the cloud back; the baseline is what the cloud holds, not what we hoped it holds.
 *  - A network or server error leaves local data untouched.
 */

export type LinkCounts = { classes: number; groups: number; sessions: number };

export type LinkScenario = "match" | "upload" | "adopt" | "both" | "ineligible";

export type LinkAction = "link" | "upload" | "adopt" | "use_cloud" | "combine";

export type LinkInspection = {
  scenario: LinkScenario;
  local: LinkCounts;
  cloud: LinkCounts;
  /** What the user may choose now. */
  actions: LinkAction[];
  /** `both` only: why combining isn't offered (names that clash, or this device's data can't be uploaded), else null. */
  combineBlockedReason: string | null;
  /** `ineligible` and `both` with unusable local data: what is wrong. */
  issues: SyncIssue[];
  /** Identifies exactly what was inspected (both sides and the cloud revision); `link` refuses if it no longer holds. */
  fingerprint: string;
};

export type LinkOutcome =
  | { status: "linked"; action: LinkAction; revision: number }
  /** Something changed since the user looked (or an upload could not be confirmed). Nothing was done; confirm again. */
  | { status: "changed"; inspection: LinkInspection }
  | { status: "not_allowed"; inspection: LinkInspection }
  /** Replacing local data needs the timer to be stopped. */
  | { status: "timer_running" }
  | { status: "conflicted" }
  | { status: "refused"; message: string }
  | { status: "error"; outcome: Extract<SyncOutcome, { status: "error" }> };

export type LinkDeps = SyncEngineDeps & {
  /** True while a timer is running or paused. Actions that replace local data wait for it to stop. */
  timerActive?(): boolean;
  /** Makes the import id (tests inject a fixed one). */
  newImportId?(): string;
};

const EMPTY: SyncSnapshot = { classes: [], groups: [], sessions: [] };

const countsOf = (s: SyncSnapshot): LinkCounts => ({ classes: s.classes.length, groups: s.groups.length, sessions: s.sessions.length });
const hasData = (s: SyncSnapshot) => s.classes.length > 0 || s.sessions.length > 0;

function defaultImportId(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && "randomUUID" in c) return `link-${c.randomUUID()}`;
  return `link-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

class Failure extends Error {
  constructor(readonly stage: Extract<SyncOutcome, { status: "error" }>["stage"], readonly original: unknown) {
    super("link step failed");
  }
}

async function at<T>(stage: Failure["stage"], step: () => T | Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (e) {
    throw new Failure(stage, e);
  }
}

export interface Linker {
  /** Reads both sides and says what linking would do. Changes nothing. Rejects-free: failures come back as `error`. */
  inspect(): Promise<{ status: "ok"; inspection: LinkInspection; remote: RevisionedSnapshot } | { status: "error"; outcome: Extract<SyncOutcome, { status: "error" }> } | { status: "linked_already" }>;
  /** Does `action`, if the situation is still the one the user saw (`seen` is `inspection.fingerprint`). */
  link(action: LinkAction, seen: string): Promise<LinkOutcome>;
}

export function createLinker(deps: LinkDeps): Linker {
  let busy = false;

  /** A dry run of "combine", so the user is only offered it when it would work. */
  function combineCheck(local: StoredData, remote: SyncSnapshot): { ok: true } | { ok: false; reason: string; issues: SyncIssue[] } {
    const eligible = checkSyncEligibility(local);
    if (!eligible.ok) return { ok: false, reason: "Some of this device’s data can’t be synced yet (a name or limit the cloud doesn’t accept).", issues: eligible.issues };
    const merged = merge3(EMPTY, eligible.snapshot, remote);
    if (merged.status !== "merged") {
      return { ok: false, reason: "Both sides have a class or subgroup with the same name, so they can’t be combined automatically.", issues: [] };
    }
    if (!diffToOps(remote, merged.target).ok) return { ok: false, reason: "The two sets of data can’t be combined automatically.", issues: [] };
    return { ok: true };
  }

  function describe(local: StoredData, remote: RevisionedSnapshot): LinkInspection {
    const localSnap = toSyncSnapshot(local);
    const localHas = hasData(localSnap);
    const remoteHas = hasData(remote.snapshot);
    const eligible = checkSyncEligibility(local);
    const issues = eligible.ok ? [] : eligible.issues;
    let scenario: LinkScenario;
    let actions: LinkAction[];
    let combineBlockedReason: string | null = null;

    if (snapshotKey(localSnap) === snapshotKey(remote.snapshot) || (!localHas && !remoteHas)) {
      scenario = "match";
      actions = ["link"];
    } else if (localHas && !remoteHas) {
      if (eligible.ok) {
        scenario = "upload";
        actions = ["upload"];
      } else {
        scenario = "ineligible";
        actions = [];
      }
    } else if (!localHas && remoteHas) {
      scenario = "adopt";
      actions = ["adopt"];
    } else {
      scenario = "both";
      actions = ["use_cloud"];
      const combine = combineCheck(local, remote.snapshot);
      if (combine.ok) actions.push("combine");
      else combineBlockedReason = combine.reason;
    }
    // The fingerprint covers what the user's confirmation is about: both data sets and the cloud's revision.
    const fingerprint = sha256Hex(`${scenario}|${remote.revision}|${snapshotKey(localSnap)}|${snapshotKey(remote.snapshot)}`);
    return { scenario, local: countsOf(localSnap), cloud: countsOf(remote.snapshot), actions, combineBlockedReason, issues, fingerprint };
  }

  const failure = (e: unknown): { status: "error"; outcome: Extract<SyncOutcome, { status: "error" }> } => {
    if (e instanceof Failure) return { status: "error", outcome: { status: "error", stage: e.stage, error: classifySyncError(e.original) } };
    return { status: "error", outcome: { status: "error", stage: "unexpected", error: classifySyncError(e) } };
  };

  async function inspect() {
    try {
      if (await at("baseline", () => deps.loadBaseline())) return { status: "linked_already" as const };
      const local = deps.getLocal();
      const remote = await at("pull", () => deps.api.pullSnapshot());
      return { status: "ok" as const, inspection: describe(local, remote), remote };
    } catch (e) {
      return failure(e);
    }
  }

  async function link(action: LinkAction, seen: string): Promise<LinkOutcome> {
    if (busy) return { status: "refused", message: "Linking is already in progress." };
    busy = true;
    try {
      const fresh = await inspect();
      if (fresh.status === "error") return fresh;
      if (fresh.status === "linked_already") return { status: "refused", message: "This device is already linked." };
      const { inspection, remote } = fresh;
      if (inspection.fingerprint !== seen) return { status: "changed", inspection };
      if (!inspection.actions.includes(action)) return { status: "not_allowed", inspection };

      const local = deps.getLocal();
      const replaces = action === "adopt" || action === "use_cloud" || action === "combine";
      if (replaces && deps.timerActive?.()) return { status: "timer_running" };

      const done = (revision: number): LinkOutcome => ({ status: "linked", action, revision });

      switch (action) {
        case "link": {
          // Both sides already agree: only the record that they do.
          await at("baseline", () => deps.saveBaseline({ revision: remote.revision, snapshot: remote.snapshot }));
          return done(remote.revision);
        }

        case "upload": {
          const eligible = checkSyncEligibility(local);
          if (!eligible.ok) return { status: "not_allowed", inspection };
          if (deps.isLocalCurrent && !deps.isLocalCurrent()) return { status: "refused", message: "This device’s data was changed in another tab, so nothing was uploaded. Reload this tab." };
          const importId = (deps.newImportId ?? defaultImportId)();
          await at("push", () => deps.api.importAndInitSync(importId, toImportPayload(local)));
          // Read the cloud back: the baseline is what it now holds. If that is not what we sent (another device got in
          // first), nothing is saved and the user sees the new situation.
          const after = await at("pull", () => deps.api.pullSnapshot());
          if (snapshotKey(after.snapshot) !== snapshotKey(eligible.snapshot)) {
            return { status: "changed", inspection: describe(deps.getLocal(), after) };
          }
          await at("baseline", () => deps.saveBaseline({ revision: after.revision, snapshot: after.snapshot }));
          return done(after.revision);
        }

        case "adopt":
        case "use_cloud": {
          const target = fromSyncSnapshot(remote.snapshot);
          if (!target.ok) return { status: "refused", message: "The cloud data can’t be stored on this device. Nothing was changed." };
          // A device with no data has nothing to lose; otherwise it is saved first, and a failed backup stops everything.
          if (hasData(toSyncSnapshot(local))) {
            await at("backup", () => deps.backup(local, { reason: "before_first_link", remoteRevision: remote.revision }));
          }
          const replaced = await at("apply", () => deps.replaceLocal(local, target.data));
          if (!replaced) return { status: "changed", inspection: describe(deps.getLocal(), remote) };
          await at("baseline", () => deps.saveBaseline({ revision: remote.revision, snapshot: remote.snapshot }));
          return done(remote.revision);
        }

        case "combine": {
          // The normal engine, started from an empty baseline (nothing is known to be shared): everything on both sides
          // is added to the other, nothing can be deleted. Its own rules apply (backup before applying, local changes
          // during the pass, saving the real baseline last); the empty starting point is never stored.
          const engine = createSyncEngine({ ...deps, loadBaseline: () => ({ revision: 0, snapshot: EMPTY }) });
          const result = await engine.syncOnce();
          if (result.status === "synced" || result.status === "up_to_date") return done(result.revision);
          if (result.status === "conflicted") return { status: "conflicted" };
          if (result.status === "error") return { status: "error", outcome: result };
          if (result.status === "refused") return { status: "refused", message: result.message };
          if (result.status === "ineligible") return { status: "not_allowed", inspection };
          return { status: "refused", message: "Your other devices are syncing at the same time. Nothing was changed. Try again in a moment." };
        }
      }
    } catch (e) {
      return failure(e);
    } finally {
      busy = false;
    }
  }

  return { inspect, link };
}
