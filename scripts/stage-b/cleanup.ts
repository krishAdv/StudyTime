import type { SyncApi } from "../../src/lib/sync/api";
import type { SyncChange } from "../../src/lib/sync/changes";
import { checkSyncEligibility } from "../../src/lib/sync/eligibility";

/**
 * Cleanup for the Stage B test account that does NOT depend on the app's planner.
 *
 * Why: Stage B deliberately puts data on the server that the app's own validator refuses (B9 stores two names the database
 * treats as different but the app treats as duplicates). The app's planner validates the remote snapshot first, so it can
 * never plan the removal of such data. Raw `delete_class` operations can: one push, all or nothing, with each class's exact
 * session count as `expectedSessions`, then a read-back to prove the classes are gone.
 *
 * Only used by the test script, only on the dedicated throwaway account, and only after the production guard passed.
 */

/** The class ids Stage B itself creates. `--cleanup` refuses an account that holds anything else. */
export const KNOWN_TEST_CLASS_IDS = ["A", "B", "Load", "u1", "u2", "R1", "R2"] as const;

export type RawDeleteResult = {
  ok: boolean;
  deleted: number;
  detail: string;
  /** Set only when the cleanup REFUSED because the account holds classes outside `allowedIds`. Nothing was sent. */
  unexpected?: string[];
};

export type RawDeleteOptions = {
  /**
   * When given, EVERY class in the fresh snapshot this function pulls (not just the ones it would delete) must be on this
   * list, or it refuses before building or sending any operation. The check is made on the same snapshot the push is based
   * on, and the push is protected by that snapshot's revision, so nothing can appear between the check and the delete.
   */
  allowedIds?: readonly string[];
};

/**
 * Deletes the given classes (or every class) with their subgroups and sessions, in ONE push, and verifies by reading the
 * account back (for "all": no classes, no subgroups and no sessions may remain). Network, server and sign-in errors are thrown
 * (a SyncError) so callers can't mistake them for success.
 * With `options.allowedIds` it first refuses (no request is sent) if the fresh snapshot holds any other class.
 */
export async function rawDeleteClasses(api: SyncApi, which: readonly string[] | "all", options: RawDeleteOptions = {}): Promise<RawDeleteResult> {
  const remote = await api.pullSnapshot();
  const { allowedIds } = options;
  if (allowedIds) {
    const unexpected = remote.snapshot.classes.map((c) => c.id).filter((id) => !allowedIds.includes(id));
    if (unexpected.length > 0) {
      return { ok: false, deleted: 0, unexpected, detail: `refused: the account holds class(es) that are not on the allowed list (${unexpected.join(", ")}); nothing was sent` };
    }
  }
  const targets = remote.snapshot.classes.filter((c) => which === "all" || which.includes(c.id));
  if (targets.length > 0) {
    const ops: SyncChange[] = targets.map((c) => ({
      op: "delete_class",
      id: c.id,
      expectedSessions: remote.snapshot.sessions.filter((s) => s.classId === c.id).length,
    }));
    const pushed = await api.pushChanges(remote.revision, ops);
    if (pushed.status !== "applied") return { ok: false, deleted: 0, detail: "the push was answered stale; nothing was deleted" };
  }
  const after = await api.pullSnapshot();
  const stillThere = after.snapshot.classes.filter((c) => targets.some((t) => t.id === c.id));
  // "Empty" means all THREE collections: a subgroup left behind (or a session) is not an empty account.
  const left = { classes: after.snapshot.classes.length, groups: after.snapshot.groups.length, sessions: after.snapshot.sessions.length };
  const empty = left.classes === 0 && left.groups === 0 && left.sessions === 0;
  const ok = stillThere.length === 0 && (which !== "all" || empty);
  return {
    ok,
    deleted: targets.length,
    detail: ok
      ? `${targets.length} class(es) removed, revision ${after.revision}`
      : which === "all"
        ? `the account is not empty after the delete: ${left.classes} class(es), ${left.groups} subgroup(s) and ${left.sessions} session(s) remain, revision ${after.revision}`
        : `${stillThere.length} class(es) still present after the delete, revision ${after.revision}`,
  };
}

/**
 * The starting-state check for the normal Stage B run: null when the account holds no classes, no subgroups and no sessions,
 * otherwise the counts, for the refusal message. Every one of the three collections must be empty.
 */
export function describeNonEmpty(snapshot: { classes: unknown[]; groups: unknown[]; sessions: unknown[] }): string | null {
  const { classes, groups, sessions } = snapshot;
  if (classes.length === 0 && groups.length === 0 && sessions.length === 0) return null;
  return `${classes.length} class(es), ${groups.length} subgroup(s) and ${sessions.length} session(s)`;
}

/** Classes in the account that Stage B did not create. `--cleanup` refuses to touch such an account. */
export function unknownClasses(classes: { id: string; name: string }[]): { id: string; name: string }[] {
  return classes.filter((c) => !(KNOWN_TEST_CLASS_IDS as readonly string[]).includes(c.id));
}

/** Whether the APP's validator (not the database) would call these two class names duplicates. For B9's report. */
export function appCallsDuplicate(a: string, b: string): boolean {
  return !checkSyncEligibility({
    classes: [
      { id: "n1", name: a, color: "#000000", groups: [] },
      { id: "n2", name: b, color: "#000000", groups: [] },
    ],
    sessions: [],
  }).ok;
}
