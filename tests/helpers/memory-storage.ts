import type { StorageLike } from "@/lib/data-store";

export type MemoryStorage = StorageLike & {
  map: Map<string, string>;
  /** Every key read through getItem, in order. */
  reads: string[];
  /** Every key written or removed, in order, as "set:key" / "remove:key". */
  writes: string[];
  /** A copy of everything stored, for before/after comparisons. */
  snapshot(): Record<string, string>;
};

/** An in-memory localStorage that records access, so tests can prove what was (not) touched. */
export function createMemoryStorage(initial: Record<string, string> = {}): MemoryStorage {
  const map = new Map(Object.entries(initial));
  const reads: string[] = [];
  const writes: string[] = [];
  return {
    map,
    reads,
    writes,
    getItem: (k) => {
      reads.push(k);
      return map.get(k) ?? null;
    },
    setItem: (k, v) => {
      writes.push(`set:${k}`);
      map.set(k, v);
    },
    removeItem: (k) => {
      writes.push(`remove:${k}`);
      map.delete(k);
    },
    snapshot: () => Object.fromEntries(map),
  };
}
