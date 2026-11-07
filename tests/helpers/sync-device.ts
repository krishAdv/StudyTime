import { createSyncEngine, type SyncEngineDeps } from "@/lib/sync/engine";
import type { SyncApi } from "@/lib/sync/api";
import { fromSyncSnapshot } from "@/lib/sync/from-snapshot";
import type { RevisionedSnapshot, SyncSnapshot } from "@/lib/sync/snapshot";
import { toSyncSnapshot } from "@/lib/sync/snapshot";
import type { StoredData } from "@/lib/storage";
import type { FakeSyncServer } from "./fake-sync-server";
import { canon } from "./sync-plan-harness";

/**
 * One simulated device for the engine tests: local data held in memory, a stored baseline, a backup list, and the
 * real sync engine running on the real Supabase adapter on top of the in-memory fake server.
 */
export function createDevice(
  server: FakeSyncServer,
  user: string,
  start: { local: StoredData; baseline: RevisionedSnapshot | null },
  hooks: {
    /** Wraps the api, to inject something that happens during a pass (another device pushing, a failure). */
    wrapApi?: (api: SyncApi) => SyncApi;
    protect?: SyncEngineDeps["protect"];
    maxAttempts?: number;
  } = {},
) {
  let local = start.local;
  let baseline = start.baseline;
  const backups: { data: StoredData; remoteRevision: number }[] = [];
  const baselineWrites: RevisionedSnapshot[] = [];
  const state = { failBackup: false, failSaveBaseline: false };
  const baseApi = server.apiFor(user);
  const api = hooks.wrapApi ? hooks.wrapApi(baseApi) : baseApi;

  const engine = createSyncEngine({
    api,
    loadBaseline: () => baseline,
    saveBaseline: (b) => {
      if (state.failSaveBaseline) throw new Error("disk full");
      baseline = structuredClone(b);
      baselineWrites.push(baseline);
    },
    getLocal: () => local,
    replaceLocal: (expected, next) => {
      if (local !== expected) return false;
      local = next;
      return true;
    },
    backup: (data, info) => {
      if (state.failBackup) throw new Error("cannot write backup");
      backups.push({ data: structuredClone(data), remoteRevision: info.remoteRevision });
    },
    protect: hooks.protect,
    maxAttempts: hooks.maxAttempts,
  });

  return {
    sync: engine.syncOnce,
    state,
    backups,
    baselineWrites,
    get local() {
      return local;
    },
    get baseline() {
      return baseline;
    },
    /** The user changes local data (a new object, like the app's provider does). */
    edit(change: (draft: SyncSnapshot) => void) {
      const draft = toSyncSnapshot(local);
      change(draft);
      const next = fromSyncSnapshot(draft);
      if (!next.ok) throw new Error("test edit made invalid data: " + JSON.stringify(next.issues));
      local = next.data;
    },
    /** Replaces local data directly, without validation (for data the app could not normally produce). */
    setLocal(data: StoredData) {
      local = data;
    },
    snapshot: () => canon(toSyncSnapshot(local)),
  };
}

/** Seeds an account with `snapshot` and returns two devices that both start fully synced at it. */
export async function seedAndLink(server: FakeSyncServer, user: string, initial: SyncSnapshot, hooksA = {}, hooksB = {}) {
  const { seed } = await import("./sync-plan-harness");
  const pulled = await seed(server, user, initial);
  const data = fromSyncSnapshot(pulled.snapshot);
  if (!data.ok) throw new Error("seed is not valid");
  const make = (hooks: object) =>
    createDevice(server, user, { local: structuredClone(data.data), baseline: structuredClone(pulled) }, hooks);
  return { a: make(hooksA), b: make(hooksB), revision: pulled.revision };
}
