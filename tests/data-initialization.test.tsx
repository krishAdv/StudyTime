// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudyDataProvider, useStudyData } from "@/features/data/study-data-provider";
import { createLocalStorageStore, type StudyDataStore } from "@/lib/data-store";
import type { StoredData } from "@/lib/storage";

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const MATH: StoredData = { classes: [{ id: "c1", name: "Math", color: "#000", groups: [] }], sessions: [] };

function setup(store: StudyDataStore) {
  return renderHook(() => useStudyData(), {
    wrapper: ({ children }) => <StudyDataProvider store={store}>{children}</StudyDataProvider>,
  });
}

describe("delayed loading", () => {
  it("shows loading with no data, saves nothing and refuses changes until the load succeeds", async () => {
    const load = deferred<StoredData>();
    const save = vi.fn();
    const { result } = setup({ load: () => load.promise, save });
    expect(result.current.status).toBe("loading");
    expect(result.current.classes).toEqual([]);
    await flush();
    expect(save).not.toHaveBeenCalled();

    let r!: ReturnType<typeof result.current.addClass>;
    act(() => {
      r = result.current.addClass("Early");
    });
    expect(r.ok).toBe(false);
    expect(save).not.toHaveBeenCalled();

    load.resolve(MATH);
    await flush();
    expect(result.current.status).toBe("ready");
    expect(result.current.classes.map((c) => c.name)).toEqual(["Math"]);
    // The refused early change did not leak into the loaded data.
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith(MATH);
  });

  it("a synchronous localStorage store is ready on the first render", () => {
    const storage = new Map<string, string>([["studytime:reset:2026-10-27", "done"]]);
    const store = createLocalStorageStore(() => ({
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => void storage.set(k, v),
      removeItem: (k) => void storage.delete(k),
    }));
    const { result } = setup(store);
    expect(result.current.status).toBe("ready");
    expect(storage.has("studytime:data")).toBe(true);
  });
});

describe("failed loading and retry", () => {
  it("shows an error, never saves, and retry loads the data", async () => {
    const save = vi.fn();
    const load = vi
      .fn<() => Promise<StoredData>>()
      .mockRejectedValueOnce(new Error("Network down"))
      .mockResolvedValueOnce(MATH);
    const { result } = setup({ load, save });
    await flush();
    expect(result.current.status).toBe("error");
    expect(result.current.loadError).toBe("Network down");
    expect(result.current.classes).toEqual([]);
    expect(save).not.toHaveBeenCalled();

    act(() => result.current.retryLoad());
    expect(result.current.status).toBe("loading");
    await flush();
    expect(result.current.status).toBe("ready");
    expect(result.current.classes).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a retry that fails again stays in error without saving", async () => {
    const save = vi.fn();
    const load = vi.fn<() => Promise<StoredData>>().mockRejectedValue(new Error("still down"));
    const { result } = setup({ load, save });
    await flush();
    act(() => result.current.retryLoad());
    await flush();
    expect(result.current.status).toBe("error");
    expect(save).not.toHaveBeenCalled();
  });

  it("ignores the result of an older load attempt that finishes after a retry", async () => {
    const first = deferred<StoredData>();
    const second = deferred<StoredData>();
    const load = vi
      .fn<() => Promise<StoredData>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = setup({ load, save: vi.fn() });
    act(() => result.current.retryLoad());
    second.resolve({ classes: [{ id: "c2", name: "New", color: "#000", groups: [] }], sessions: [] });
    await flush();
    first.resolve(MATH);
    await flush();
    expect(result.current.classes.map((c) => c.name)).toEqual(["New"]);
  });
});

describe("saving", () => {
  it("writes snapshots one at a time, in order, newest last", async () => {
    const gates: ReturnType<typeof deferred<void>>[] = [];
    const saved: string[][] = [];
    let running = 0;
    let maxRunning = 0;
    const store: StudyDataStore = {
      load: () => MATH,
      save: (d) => {
        const gate = deferred<void>();
        gates.push(gate);
        saved.push(d.classes.map((c) => c.name));
        running++;
        maxRunning = Math.max(maxRunning, running);
        return gate.promise.then(() => void running--);
      },
    };
    const { result } = setup(store);
    expect(saved).toEqual([["Math"]]);
    act(() => void result.current.addClass("Art"));
    act(() => void result.current.addClass("Bio"));
    expect(saved).toHaveLength(1); // first write still in flight
    gates[0].resolve();
    await flush();
    expect(saved).toEqual([["Math"], ["Math", "Art", "Bio"]]); // intermediate state skipped, newest written
    gates[1].resolve();
    await flush();
    expect(maxRunning).toBe(1);
  });

  it("a failed save keeps the data, reports saveError, and retrySave writes the latest", async () => {
    const save = vi
      .fn<(d: StoredData) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const { result } = setup({ load: () => MATH, save });
    await flush();
    act(() => void result.current.addClass("Art"));
    await flush();
    expect(result.current.saveError).toBe(true);
    expect(result.current.classes.map((c) => c.name)).toEqual(["Math", "Art"]);

    act(() => result.current.retrySave());
    await flush();
    expect(result.current.saveError).toBe(false);
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ classes: [expect.anything(), expect.objectContaining({ name: "Art" })] }),
    );
  });
});
