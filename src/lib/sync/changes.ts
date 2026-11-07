import { serializeExport } from "../data-export";
import type { StoredData } from "../storage";
import type { SyncSession } from "./snapshot";

/**
 * Request shapes for the three M4.2 RPCs, taken from supabase/migrations/20261029120000_studytime_sync.sql
 * (the comment above `push_changes`) and the import migration. These are types and constants only;
 * building the actual change lists is a later step.
 */

/** One change in a `push_changes` list. Field names are camelCase, like the export file. */
export type SyncChange =
  | { op: "add_class"; id: string; name: string; color: string }
  /** At least one of `name` and `color` is required. */
  | { op: "update_class"; id: string; name?: string; color?: string }
  /** Deletes the class, its subgroups and its sessions, but only if it holds exactly `expectedSessions` sessions. */
  | { op: "delete_class"; id: string; expectedSessions: number }
  | { op: "add_group"; id: string; classId: string; name: string }
  | { op: "rename_group"; id: string; name: string }
  /** Sessions in the subgroup are kept; their subgroup becomes null. */
  | { op: "delete_group"; id: string }
  /** `groupId` must be present: a subgroup id of the session's class, or null. */
  | { op: "add_session"; id: string; classId: string; groupId: string | null; startedAt: number; seconds: number; mode: "stopwatch" | "countdown" }
  /** Only the class and subgroup change. `groupId` must be present. */
  | { op: "move_session"; id: string; classId: string; groupId: string | null };

/** Limits the server enforces on one `push_changes` call (the byte limit is measured on the jsonb value). */
export const PUSH_LIMITS = { maxChanges: 5_000, maxBytes: 4_000_000 } as const;

/** The server rejects an import payload above this size (measured on the jsonb value). */
export const IMPORT_LIMITS = { maxBytes: 33_554_432 } as const;

/** The export file (src/lib/data-export.ts) is exactly what `import_and_init_sync` takes. */
export type ImportPayload = {
  format: "studytime-export";
  formatVersion: 1;
  exportedAt: string;
  data: {
    classes: { id: string; name: string; color: string; groups: { id: string; name: string }[] }[];
    sessions: SyncSession[];
  };
};

/** Builds the import payload from local data using the app's own export serializer, so the two can't drift apart. */
export function toImportPayload(data: StoredData, now: Date = new Date()): ImportPayload {
  return JSON.parse(serializeExport(data, now)) as ImportPayload;
}
