import type { StorageLike, StudyDataStore } from "./data-store";
import { DATA_KEY, parseStoredData, serializeData, type StoredData } from "./storage";

/**
 * Per-account study data on this device (M4.1). Each signed-in user gets their own
 * localStorage key, so one account can never read or write another's data, and the
 * legacy `studytime:data` bucket (everything saved before accounts existed) is never
 * touched by an account's store.
 *
 * Deliberately simpler than the legacy store: no one-time reset, no migrations and no
 * backup writes. Those apply only to the legacy bucket. The only extra write is keeping
 * an unreadable payload aside under `:corrupt` (never deleted), as the legacy store does.
 *
 * This is isolation in the UI, not encryption: anyone who can open the browser's dev
 * tools on a shared device can still read every bucket.
 */
const EMPTY: StoredData = { classes: [], sessions: [] };

/** `studytime:u:<userId>:<suffix>`. Refuses an empty id so no two accounts can ever share a bucket. */
export function accountKey(userId: string, suffix: "data" | "data:corrupt"): string {
  if (typeof userId !== "string" || userId.trim() === "") {
    throw new Error("An account id is required to read or write account data.");
  }
  return `studytime:u:${userId}:${suffix}`;
}

export function createAccountStore(
  userId: string,
  getStorage: () => StorageLike | null = () => (typeof window === "undefined" ? null : window.localStorage),
): StudyDataStore {
  const dataKey = accountKey(userId, "data");
  const corruptKey = accountKey(userId, "data:corrupt");
  return {
    load() {
      try {
        const storage = getStorage();
        if (!storage) return EMPTY;
        const raw = storage.getItem(dataKey);
        if (raw === null) return EMPTY;
        const parsed = parseStoredData(raw);
        if (!parsed) {
          storage.setItem(corruptKey, raw);
          return EMPTY;
        }
        return { classes: parsed.classes, sessions: parsed.sessions };
      } catch {
        // Storage unavailable: run in memory, empty.
        return EMPTY;
      }
    },

    save(data) {
      try {
        getStorage()?.setItem(dataKey, serializeData(data));
      } catch {
        // Quota or private mode: keep working in memory (same as the legacy store).
      }
    },
  };
}

/**
 * A read-only look at the legacy bucket, for the "saved before accounts" notice. Never
 * writes, migrates, resets or claims anything. Returns null when there is nothing
 * readable to show (no data, unreadable data, or storage unavailable).
 */
export function peekLegacyData(
  getStorage: () => StorageLike | null = () => (typeof window === "undefined" ? null : window.localStorage),
): StoredData | null {
  try {
    const raw = getStorage()?.getItem(DATA_KEY);
    if (raw === null || raw === undefined) return null;
    const parsed = parseStoredData(raw);
    if (!parsed || (parsed.classes.length === 0 && parsed.sessions.length === 0)) return null;
    return { classes: parsed.classes, sessions: parsed.sessions };
  } catch {
    return null;
  }
}
