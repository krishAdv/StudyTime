// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StudyDataProvider, useStudyData } from "@/features/data/study-data-provider";
import { createLocalStorageStore, type StorageLike, type StudyDataStore } from "@/lib/data-store";
import { DATA_KEY, DATA_VERSION, RESET_BACKUP_KEY, RESET_MARKER_KEY } from "@/lib/storage";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const storage: StorageLike & { map: Map<string, string> } = {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
  return storage;
}

const payload = (extra: object = {}) =>
  JSON.stringify({
    version: DATA_VERSION,
    classes: [{ id: "c1", name: "Math", color: "#000", groups: [] }],
    sessions: [{ id: "s1", classId: "c1", groupId: null, startedAt: 1, seconds: 60, mode: "stopwatch" }],
    ...extra,
  });

describe("localStorage store", () => {
  it("returns empty data and touches nothing when there is no storage (server)", () => {
    expect(createLocalStorageStore(() => null).load()).toEqual({ classes: [], sessions: [] });
  });

  it("round-trips saved data once the reset marker exists", () => {
    const storage = fakeStorage({ [RESET_MARKER_KEY]: "done" });
    const store = createLocalStorageStore(() => storage);
    const data = { classes: [{ id: "c1", name: "Math", color: "#000", groups: [] }], sessions: [] };
    store.save(data);
    expect(JSON.parse(storage.map.get(DATA_KEY)!).version).toBe(DATA_VERSION);
    expect(store.load()).toEqual(data);
  });

  it("one-time reset: backs up the old data, clears it, writes the marker, leaves other keys alone", () => {
    const storage = fakeStorage({ [DATA_KEY]: payload(), "studytime-theme": "dark" });
    const store = createLocalStorageStore(() => storage);
    expect(store.load()).toEqual({ classes: [], sessions: [] });
    expect(storage.map.get(RESET_BACKUP_KEY)).toBe(payload());
    expect(storage.map.has(DATA_KEY)).toBe(false);
    expect(storage.map.has(RESET_MARKER_KEY)).toBe(true);
    expect(storage.map.get("studytime-theme")).toBe("dark");
  });

  it("an unreadable payload is copied to the corrupt key, not deleted", () => {
    const storage = fakeStorage({ [RESET_MARKER_KEY]: "done", [DATA_KEY]: "{not json" });
    expect(createLocalStorageStore(() => storage).load()).toEqual({ classes: [], sessions: [] });
    expect(storage.map.get(`${DATA_KEY}:corrupt`)).toBe("{not json");
    expect(storage.map.get(DATA_KEY)).toBe("{not json");
  });

  it("load never throws when storage throws, and returns empty data", () => {
    const store = createLocalStorageStore(() => ({
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
    }));
    expect(store.load()).toEqual({ classes: [], sessions: [] });
  });

  it("save never throws when the write fails (quota or private mode)", () => {
    const store = createLocalStorageStore(() => ({
      getItem: () => null,
      setItem: () => { throw new Error("QuotaExceededError"); },
      removeItem: () => {},
    }));
    expect(() => store.save({ classes: [], sessions: [] })).not.toThrow();
  });

  it("save is a no-op without storage", () => {
    expect(() => createLocalStorageStore(() => null).save({ classes: [], sessions: [] })).not.toThrow();
  });
});

describe("StudyDataProvider with an injected store", () => {
  it("starts from store.load() once and saves every change through store.save()", () => {
    const store: StudyDataStore = {
      load: vi.fn(() => ({ classes: [{ id: "c1", name: "Math", color: "#000", groups: [] }], sessions: [] })),
      save: vi.fn(),
    };
    const { result } = renderHook(() => useStudyData(), {
      wrapper: ({ children }) => <StudyDataProvider store={store}>{children}</StudyDataProvider>,
    });
    expect(result.current.classes.map((c) => c.name)).toEqual(["Math"]);
    expect(store.load).toHaveBeenCalledTimes(1);
    act(() => void result.current.addClass("Art"));
    expect(store.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ classes: [expect.anything(), expect.objectContaining({ name: "Art" })] }),
    );
    expect(store.load).toHaveBeenCalledTimes(1);
  });
});
