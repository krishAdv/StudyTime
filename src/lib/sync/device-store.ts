import type { StorageLike } from "../data-store";
import type { StoredData } from "../storage";
import { fromSyncSnapshot } from "./from-snapshot";
import type { SyncBackupReason } from "./engine";
import type { RevisionedSnapshot } from "./snapshot";

/**
 * What sync keeps on THIS device, per account (M4.3 S7): whether the user turned sync on here, the baseline (the last
 * state both this device and the server held), and a few backups of local data taken before remote data replaced it.
 * Everything lives under the account's own `studytime:u:<userId>:sync:` prefix, so one account can never see another's
 * and the study data bucket itself is never touched here.
 */

const prefix = (userId: string) => {
  if (typeof userId !== "string" || userId.trim() === "") throw new Error("An account id is required.");
  return `studytime:u:${userId}:sync:`;
};

export const enabledKey = (userId: string) => `${prefix(userId)}enabled`;
export const baselineKey = (userId: string) => `${prefix(userId)}baseline`;
const backupIndexKey = (userId: string) => `${prefix(userId)}backups`;

/** How many pre-apply backups are kept (the newest). Older ones are removed only after a newer one was saved. */
export const MAX_SYNC_BACKUPS = 8;

export function loadSyncEnabled(storage: StorageLike | null, userId: string): boolean {
  try {
    return storage?.getItem(enabledKey(userId)) === "1";
  } catch {
    return false;
  }
}

/** Throws when it could not be saved, so the caller can tell the user instead of pretending. */
export function saveSyncEnabled(storage: StorageLike | null, userId: string, on: boolean): void {
  if (!storage) throw new Error("This device cannot store the sync setting.");
  if (on) storage.setItem(enabledKey(userId), "1");
  else storage.removeItem(enabledKey(userId));
}

/** The saved baseline, or null when there is none or it is unreadable (the device then counts as not linked). */
export function loadBaseline(storage: StorageLike | null, userId: string): RevisionedSnapshot | null {
  try {
    const raw = storage?.getItem(baselineKey(userId));
    if (!raw) return null;
    const v = JSON.parse(raw) as { revision?: unknown; snapshot?: unknown };
    if (typeof v.revision !== "number" || !Number.isSafeInteger(v.revision) || v.revision < 0) return null;
    const checked = fromSyncSnapshot(v.snapshot as RevisionedSnapshot["snapshot"]);
    if (!checked.ok) return null;
    return { revision: v.revision, snapshot: v.snapshot as RevisionedSnapshot["snapshot"] };
  } catch {
    return null;
  }
}

/** Throws when it could not be saved (the engine reports that as an error and the next pass is still safe). */
export function saveBaseline(storage: StorageLike | null, userId: string, baseline: RevisionedSnapshot): void {
  if (!storage) throw new Error("This device cannot store the sync state.");
  storage.setItem(baselineKey(userId), JSON.stringify({ revision: baseline.revision, snapshot: baseline.snapshot }));
}

export type SyncBackupInfo = { reason: SyncBackupReason; remoteRevision: number };

/**
 * Keeps a copy of local data. Throws if it could not be written, which makes the engine skip applying remote data.
 * Only after the new backup is saved are backups beyond the newest `MAX_SYNC_BACKUPS` removed.
 */
export function saveSyncBackup(storage: StorageLike | null, userId: string, data: StoredData, info: SyncBackupInfo, now: Date = new Date()): void {
  if (!storage) throw new Error("This device cannot store a backup.");
  const indexKey = backupIndexKey(userId);
  let index: string[] = [];
  try {
    const parsed = JSON.parse(storage.getItem(indexKey) ?? "[]") as unknown;
    if (Array.isArray(parsed)) index = parsed.filter((k): k is string => typeof k === "string");
  } catch {
    index = [];
  }
  let key = `${prefix(userId)}backup:${now.getTime()}`;
  for (let n = 1; index.includes(key); n++) key = `${prefix(userId)}backup:${now.getTime()}-${n}`;
  storage.setItem(
    key,
    JSON.stringify({ format: "studytime-sync-backup", savedAt: now.toISOString(), reason: info.reason, remoteRevision: info.remoteRevision, data }),
  );
  const next = [...index, key];
  storage.setItem(indexKey, JSON.stringify(next));
  for (const old of next.slice(0, Math.max(0, next.length - MAX_SYNC_BACKUPS))) {
    try {
      storage.removeItem(old);
    } catch {
      // a leftover old backup is harmless
    }
  }
  if (next.length > MAX_SYNC_BACKUPS) storage.setItem(indexKey, JSON.stringify(next.slice(-MAX_SYNC_BACKUPS)));
}

/** The saved backups, newest last (for a future "restore" screen and for tests). */
export function listSyncBackups(storage: StorageLike | null, userId: string): { key: string; savedAt: string; reason: string; data: StoredData }[] {
  try {
    const index = JSON.parse(storage?.getItem(backupIndexKey(userId)) ?? "[]") as string[];
    const out: { key: string; savedAt: string; reason: string; data: StoredData }[] = [];
    for (const key of index) {
      const raw = storage?.getItem(key);
      if (!raw) continue;
      const v = JSON.parse(raw) as { savedAt: string; reason?: string; data: StoredData };
      out.push({ key, savedAt: v.savedAt, reason: v.reason ?? "", data: v.data });
    }
    return out;
  } catch {
    return [];
  }
}
