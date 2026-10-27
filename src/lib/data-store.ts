import { removeKnownSeedData } from "./legacy-seed";
import {
  DATA_KEY, RESET_BACKUP_KEY, RESET_MARKER_KEY, parseStoredData, serializeData, type StoredData,
} from "./storage";

/**
 * Where classes and sessions are persisted. The provider owns app state and
 * only talks to this interface, so the mechanism can change later.
 * `load` and `save` may return a Promise (a remote store) or complete
 * synchronously (localStorage). The localStorage store never throws and falls
 * back to running in memory. An async store should reject on failure instead of
 * returning empty data: the provider then shows an error and never saves.
 */
export interface StudyDataStore {
  /** Applies the one-time reset and migrations (keeping backups), then returns the data to start with. */
  load(): StoredData | Promise<StoredData>;
  /** Persists a full snapshot. The provider never calls it before a load has succeeded. */
  save(data: StoredData): void | Promise<void>;
}

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const FLATTEN_BACKUP_KEY = `${DATA_KEY}:pre-flatten-backup`;
const SEED_BACKUP_KEY = `${DATA_KEY}:pre-seed-cleanup-backup`;
const CORRUPT_KEY = `${DATA_KEY}:corrupt`;
const EMPTY: StoredData = { classes: [], sessions: [] };

/**
 * First run starts empty. Saved data always wins; an unreadable payload is kept
 * aside (never deleted) and the app starts empty. Payloads saved before version 2
 * go through the one-time removal of provably untouched sample records, with the
 * original kept under a backup key first. Backup keys are never removed.
 * `getStorage` returns null on the server, where nothing is read.
 */
export function createLocalStorageStore(
  getStorage: () => StorageLike | null = () => (typeof window === "undefined" ? null : window.localStorage),
): StudyDataStore {
  return {
    load() {
      try {
        const storage = getStorage();
        if (!storage) return EMPTY;
        const raw = storage.getItem(DATA_KEY);
        if (storage.getItem(RESET_MARKER_KEY) === null) {
          // One-time clean slate. Keep a recovery copy, never touch other keys
          // (settings, theme, existing backups), and mark it done so it can't repeat.
          if (raw !== null) {
            if (storage.getItem(RESET_BACKUP_KEY) === null) storage.setItem(RESET_BACKUP_KEY, raw);
            storage.removeItem(DATA_KEY);
          }
          storage.setItem(RESET_MARKER_KEY, new Date().toISOString());
          return EMPTY;
        }
        if (raw === null) return EMPTY;
        const parsed = parseStoredData(raw);
        if (!parsed) {
          storage.setItem(CORRUPT_KEY, raw);
          return EMPTY;
        }
        // Keep the original aside the first time deep nesting is flattened.
        if (parsed.flattened && storage.getItem(FLATTEN_BACKUP_KEY) === null) {
          storage.setItem(FLATTEN_BACKUP_KEY, raw);
        }
        let data: StoredData = { classes: parsed.classes, sessions: parsed.sessions };
        if (parsed.fromVersion < 2) {
          const cleaned = removeKnownSeedData(data);
          if (cleaned.removed) {
            if (storage.getItem(SEED_BACKUP_KEY) === null) storage.setItem(SEED_BACKUP_KEY, raw);
            data = cleaned.data;
          }
        }
        return data;
      } catch {
        // Storage unavailable: run in memory, empty.
        return EMPTY;
      }
    },

    save(data) {
      try {
        getStorage()?.setItem(DATA_KEY, serializeData(data));
      } catch {
        // Quota or private mode: keep working in memory.
      }
    },
  };
}

/** The store the app uses: this browser's localStorage. */
export const localStorageStore = createLocalStorageStore();
