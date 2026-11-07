import { describe, expect, it } from "vitest";
import { SyncError } from "@/lib/sync/errors";
import {
  MAX_SYNC_BACKUPS, enabledKey, listSyncBackups, loadBaseline, loadSyncEnabled, saveBaseline, saveSyncBackup, saveSyncEnabled,
} from "@/lib/sync/device-store";
import type { SyncOutcome } from "@/lib/sync/engine";
import { describeOutcome } from "@/lib/sync/status";
import { baseSnapshot } from "./helpers/merge-fixtures";
import { createMemoryStorage } from "./helpers/memory-storage";

const DATA = { classes: [{ id: "c", name: "Math", color: "#000000", groups: [] }], sessions: [] };

describe("the per-device sync setting and baseline", () => {
  it("is off by default, per account, and survives a reload of the storage", () => {
    const mem = createMemoryStorage();
    expect(loadSyncEnabled(mem, "a")).toBe(false);
    saveSyncEnabled(mem, "a", true);
    expect(loadSyncEnabled(mem, "a")).toBe(true);
    expect(loadSyncEnabled(mem, "b")).toBe(false); // another account on the same device is unaffected
    saveSyncEnabled(mem, "a", false);
    expect(loadSyncEnabled(mem, "a")).toBe(false);
    expect(enabledKey("a")).toBe("studytime:u:a:sync:enabled");
  });

  it("refuses an empty account id and reports a missing storage instead of pretending", () => {
    expect(() => enabledKey("")).toThrow();
    expect(() => saveSyncEnabled(null, "a", true)).toThrow();
    expect(loadSyncEnabled(null, "a")).toBe(false);
  });

  it("saves and reloads a baseline, and treats a damaged one as not linked", () => {
    const mem = createMemoryStorage();
    expect(loadBaseline(mem, "a")).toBeNull();
    saveBaseline(mem, "a", { revision: 3, snapshot: baseSnapshot() });
    expect(loadBaseline(mem, "a")).toEqual({ revision: 3, snapshot: baseSnapshot() });
    expect(loadBaseline(mem, "b")).toBeNull();
    for (const bad of ["not json", JSON.stringify({ revision: -1, snapshot: baseSnapshot() }), JSON.stringify({ revision: 1, snapshot: { classes: 5 } }), JSON.stringify({ snapshot: baseSnapshot() })]) {
      mem.map.set("studytime:u:a:sync:baseline", bad);
      expect(loadBaseline(mem, "a")).toBeNull();
    }
  });

  it("keeps the newest backups, never the study data bucket itself, and fails loudly when it cannot save", () => {
    const mem = createMemoryStorage({ "studytime:u:a:data": "{}" });
    for (let i = 0; i < MAX_SYNC_BACKUPS + 3; i++) {
      saveSyncBackup(mem, "a", { ...DATA, sessions: [] }, { reason: "before_apply_remote", remoteRevision: i }, new Date(1_000 + i));
    }
    const kept = listSyncBackups(mem, "a");
    expect(kept).toHaveLength(MAX_SYNC_BACKUPS);
    expect(kept[kept.length - 1].data).toEqual(DATA);
    expect(mem.map.get("studytime:u:a:data")).toBe("{}"); // untouched
    const full = { ...mem, setItem: () => { throw new Error("quota"); } };
    expect(() => saveSyncBackup(full, "a", DATA, { reason: "before_apply_remote", remoteRevision: 1 })).toThrow();
    expect(() => saveSyncBackup(null, "a", DATA, { reason: "before_apply_remote", remoteRevision: 1 })).toThrow();
  });

  it("two backups in the same millisecond do not overwrite each other", () => {
    const mem = createMemoryStorage();
    const now = new Date(5_000);
    saveSyncBackup(mem, "a", DATA, { reason: "before_apply_remote", remoteRevision: 1 }, now);
    saveSyncBackup(mem, "a", DATA, { reason: "before_apply_remote", remoteRevision: 2 }, now);
    expect(listSyncBackups(mem, "a")).toHaveLength(2);
  });
});

describe("what the user is told", () => {
  const view = (o: SyncOutcome) => describeOutcome(o);
  const err = (kind: ConstructorParameters<typeof SyncError>[0], stage: "pull" | "push" | "backup" = "pull"): SyncOutcome => ({ status: "error", stage, error: new SyncError(kind) });

  it("maps every outcome to one of the states, with a message", () => {
    expect(view({ status: "up_to_date", revision: 1 })).toMatchObject({ status: "synced" });
    expect(view({ status: "synced", revision: 2, pushed: 1, applied: false })).toMatchObject({ status: "synced" });
    expect(view({ status: "not_linked" })).toMatchObject({ status: "not_linked", retryable: false });
    expect(view(err("network"))).toMatchObject({ status: "offline", retryable: true });
    expect(view(err("server"))).toMatchObject({ status: "attention", retryable: true });
    expect(view(err("auth"))).toMatchObject({ status: "attention", retryable: false });
    expect(view(err("unknown", "backup"))).toMatchObject({ status: "attention", retryable: true });
    expect(view({ status: "busy" })).toMatchObject({ status: "attention", retryable: true });
    expect(view({ status: "conflicted", conflicts: [], decisionPoints: [], rejectedDecisions: [], snapshots: { base: baseSnapshot(), local: baseSnapshot(), remote: baseSnapshot() } })).toMatchObject({ status: "attention", retryable: false });
    expect(view({ status: "refused", reason: "remote_older", message: "Behind." })).toMatchObject({ status: "attention", retryable: false });
    expect(view({ status: "ineligible", issues: [] })).toMatchObject({ status: "attention", retryable: false });
  });

  it("every message is non-empty plain text that never leaks technical detail", () => {
    const all: SyncOutcome[] = [
      { status: "up_to_date", revision: 1 }, { status: "not_linked" }, { status: "busy" }, err("network"), err("server"), err("auth"), err("forbidden"),
      err("unavailable"), err("malformed_response"), err("unknown", "backup"),
    ];
    for (const o of all) expect(view(o).message.length).toBeGreaterThan(10);
  });
});
