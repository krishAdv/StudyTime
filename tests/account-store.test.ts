import { describe, expect, it } from "vitest";
import { accountKey, createAccountStore, peekLegacyData } from "@/lib/account-store";
import { DATA_KEY, DATA_VERSION, RESET_BACKUP_KEY, RESET_MARKER_KEY, type StoredData } from "@/lib/storage";
import { createMemoryStorage } from "./helpers/memory-storage";

const DATA: StoredData = {
  classes: [{ id: "c1", name: "Biology", color: "#10b981", groups: [{ id: "g1", name: "Unit 1" }] }],
  sessions: [{ id: "s1", classId: "c1", groupId: "g1", startedAt: 1_700_000_000_000, seconds: 600, mode: "stopwatch" }],
};
const payload = (d: StoredData) => JSON.stringify({ version: DATA_VERSION, ...d });

describe("accountKey", () => {
  it("is scoped by user id and refuses an empty id", () => {
    expect(accountKey("u1", "data")).toBe("studytime:u:u1:data");
    expect(accountKey("u1", "data")).not.toBe(accountKey("u2", "data"));
    expect(() => accountKey("", "data")).toThrow();
    expect(() => accountKey("   ", "data")).toThrow();
  });
});

describe("createAccountStore", () => {
  it("starts empty and writes nothing on load", () => {
    const s = createMemoryStorage();
    expect(createAccountStore("u1", () => s).load()).toEqual({ classes: [], sessions: [] });
    expect(s.writes).toEqual([]);
  });

  it("saves under the account's own key and reads it back", () => {
    const s = createMemoryStorage();
    createAccountStore("u1", () => s).save(DATA);
    expect(Object.keys(s.snapshot())).toEqual([accountKey("u1", "data")]);
    expect(createAccountStore("u1", () => s).load()).toEqual(DATA);
  });

  it("never lets one account read another's data", () => {
    const s = createMemoryStorage();
    createAccountStore("u1", () => s).save(DATA);
    expect(createAccountStore("u2", () => s).load()).toEqual({ classes: [], sessions: [] });
  });

  it("never reads, writes or migrates the legacy bucket, its markers or its backups", () => {
    const legacy = {
      [DATA_KEY]: payload(DATA),
      [RESET_MARKER_KEY]: "done",
      [RESET_BACKUP_KEY]: "backup-bytes",
      [`${DATA_KEY}:pre-flatten-backup`]: "flatten-bytes",
      [`${DATA_KEY}:pre-seed-cleanup-backup`]: "seed-bytes",
      [`${DATA_KEY}:corrupt`]: "corrupt-bytes",
    };
    const s = createMemoryStorage(legacy);
    const store = createAccountStore("u1", () => s);
    expect(store.load()).toEqual({ classes: [], sessions: [] });
    store.save({ classes: [], sessions: [] });
    for (const k of s.reads) expect(k.startsWith("studytime:u:u1:")).toBe(true);
    for (const w of s.writes) expect(w.startsWith("set:studytime:u:u1:")).toBe(true);
    for (const [k, v] of Object.entries(legacy)) expect(s.map.get(k)).toBe(v);
  });

  it("keeps an unreadable payload aside under :corrupt instead of deleting it", () => {
    const s = createMemoryStorage({ [accountKey("u1", "data")]: "{not json" });
    expect(createAccountStore("u1", () => s).load()).toEqual({ classes: [], sessions: [] });
    expect(s.map.get(accountKey("u1", "data:corrupt"))).toBe("{not json");
    expect(s.map.get(accountKey("u1", "data"))).toBe("{not json");
  });

  it("falls back to memory when storage is unavailable or throws", () => {
    expect(createAccountStore("u1", () => null).load()).toEqual({ classes: [], sessions: [] });
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {},
    };
    const store = createAccountStore("u1", () => broken);
    expect(store.load()).toEqual({ classes: [], sessions: [] });
    expect(() => store.save(DATA)).not.toThrow();
  });
});

describe("peekLegacyData", () => {
  it("returns the legacy data without writing anything", () => {
    const s = createMemoryStorage({ [DATA_KEY]: payload(DATA) }); // no reset marker on purpose
    expect(peekLegacyData(() => s)).toEqual(DATA);
    expect(s.writes).toEqual([]);
    expect(s.map.has(RESET_MARKER_KEY)).toBe(false);
  });

  it("is null for nothing, empty data, unreadable data, or no storage", () => {
    expect(peekLegacyData(() => createMemoryStorage())).toBeNull();
    expect(peekLegacyData(() => createMemoryStorage({ [DATA_KEY]: payload({ classes: [], sessions: [] }) }))).toBeNull();
    const bad = createMemoryStorage({ [DATA_KEY]: "garbage" });
    expect(peekLegacyData(() => bad)).toBeNull();
    expect(bad.writes).toEqual([]);
    expect(peekLegacyData(() => null)).toBeNull();
  });
});
