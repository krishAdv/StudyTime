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
export function accountKey(userId: string, suffix: "data" | "data:corrupt" | "active-session"): string {
  if (typeof userId !== "string" || userId.trim() === "") {
    throw new Error("An account id is required to read or write account data.");
  }
  return `studytime:u:${userId}:${suffix}`;
}

/**
 * Cross-tab protection. Every tab of the same browser and account shares ONE localStorage key, but each tab keeps its own
 * copy of the data in memory. A tab that missed another tab's change would later save its older copy over the newer one,
 * and a sync pass from it would then see the newer data as deleted. So the store remembers the exact text this tab last
 * read or wrote (`known`), and:
 *  - `save` compares the stored text with `known` first and writes nothing if it differs (another tab wrote in between),
 *  - a `storage` event, and a re-check when the tab becomes visible, gets focus or is restored from the back/forward
 *    cache (Safari suspends background tabs and may deliver no event), notice a change before any save is attempted.
 * Once a tab is stale it stays stale until it is reloaded: it never writes again and never merges. Two tabs that wrote
 * identical text are not in conflict. If storage can't be read (private mode, blocked), nothing is ever flagged and the
 * store behaves as before.
 */
export function createAccountStore(
  userId: string,
  getStorage: () => StorageLike | null = () => (typeof window === "undefined" ? null : window.localStorage),
): StudyDataStore {
  const dataKey = accountKey(userId, "data");
  const corruptKey = accountKey(userId, "data:corrupt");

  /** The stored text this tab last read or wrote; null = nothing was stored; undefined = unknown (never compare). */
  let known: string | null | undefined;
  let stale = false;
  const listeners = new Set<() => void>();
  let detach: (() => void) | null = null;

  const readNow = (): string | null | undefined => {
    try {
      const storage = getStorage();
      return storage ? storage.getItem(dataKey) : undefined;
    } catch {
      return undefined;
    }
  };

  const markStale = () => {
    if (stale) return;
    stale = true;
    for (const notify of [...listeners]) {
      try {
        notify();
      } catch {
        // one listener failing must not stop the others
      }
    }
  };

  /** Compares what is stored now with what this tab knows; flags the tab if another tab changed it. */
  const check = () => {
    if (stale || known === undefined) return;
    const now = readNow();
    if (now !== undefined && now !== known) markStale();
  };

  function attach() {
    if (detach || typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === dataKey) check();
    };
    const onVisible = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") check();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", check);
    document.addEventListener("visibilitychange", onVisible);
    detach = () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", check);
      window.removeEventListener("pageshow", check);
      document.removeEventListener("visibilitychange", onVisible);
      detach = null;
    };
  }

  return {
    load() {
      try {
        const storage = getStorage();
        if (!storage) return EMPTY;
        const raw = storage.getItem(dataKey);
        known = raw;
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
      // Another tab changed the data since this tab last looked: never overwrite it, now or later.
      if (stale) return;
      check();
      if (stale) return;
      // A failed write (quota, blocked storage) throws, as in the legacy store: the provider shows "not saved" with
      // Retry and keeps the data in memory. `known` changes only after a write that happened.
      const text = serializeData(data);
      getStorage()?.setItem(dataKey, text);
      known = text;
    },

    checkNow() {
      check();
    },

    watch(onExternalChange) {
      listeners.add(onExternalChange);
      attach();
      if (stale) onExternalChange();
      return () => {
        listeners.delete(onExternalChange);
        if (listeners.size === 0) detach?.();
      };
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
