import type { StoredData } from "../storage";
import type { TimerMode } from "../types";

/**
 * The server's flat data model (M4.2): `classes`, `groups` and `sessions` are separate lists,
 * and a subgroup points at its class with `classId`. This is what `pull_snapshot()` returns
 * (minus the revision) and what `import_and_init_sync` stores. The local app model nests
 * subgroups inside their class instead (`ClassItem.groups`).
 *
 * Pure types and functions only: nothing here touches storage, the network or React.
 */
export type SyncClass = { id: string; name: string; color: string };

export type SyncGroup = { id: string; classId: string; name: string };

export type SyncSession = {
  id: string;
  classId: string;
  /** null means "the class itself, no subgroup". The server requires the key to be present. */
  groupId: string | null;
  /** Epoch milliseconds. */
  startedAt: number;
  /** Whole study seconds. */
  seconds: number;
  mode: TimerMode;
};

/** Study data only. The revision is deliberately not part of it: see `RevisionedSnapshot`. */
export type SyncSnapshot = {
  classes: SyncClass[];
  groups: SyncGroup[];
  sessions: SyncSession[];
};

/**
 * A snapshot together with the server revision it was read at. The revision is kept beside the
 * data, never inside it, so comparing or merging two snapshots can't accidentally involve it.
 */
export type RevisionedSnapshot = { revision: number; snapshot: SyncSnapshot };

/**
 * Converts the local model to the server's flat shape. Nested subgroups become entries of the
 * flat `groups` list, in class order and then subgroup order, each pointing at its class.
 *
 * This is a pure copy: ids and every relationship are kept exactly as stored, names, colors and
 * session values are not normalized, repaired or dropped (so invalid data stays visible to
 * `checkSyncEligibility`), no ids are generated, and the input is never mutated or aliased.
 * List order is preserved; the server sorts for itself.
 */
export function toSyncSnapshot(data: StoredData): SyncSnapshot {
  const classes: SyncClass[] = [];
  const groups: SyncGroup[] = [];
  for (const c of Array.isArray(data.classes) ? data.classes : []) {
    classes.push({ id: c.id, name: c.name, color: c.color });
    for (const g of Array.isArray(c.groups) ? c.groups : []) {
      groups.push({ id: g.id, classId: c.id, name: g.name });
    }
  }
  const sessions: SyncSession[] = (Array.isArray(data.sessions) ? data.sessions : []).map((s) => ({
    id: s.id,
    classId: s.classId,
    groupId: s.groupId,
    startedAt: s.startedAt,
    seconds: s.seconds,
    mode: s.mode,
  }));
  return { classes, groups, sessions };
}
