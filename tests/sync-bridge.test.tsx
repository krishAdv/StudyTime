// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StudyDataProvider, useStudyData } from "@/features/data/study-data-provider";
import { createAccountStore } from "@/lib/account-store";
import { createMemoryStorage } from "./helpers/memory-storage";

const setup = () => {
  const mem = createMemoryStorage();
  return renderHook(() => useStudyData(), { wrapper: ({ children }) => <StudyDataProvider store={createAccountStore("u", () => mem)}>{children}</StudyDataProvider> });
};

describe("the sync bridge of the data provider", () => {
  it("returns the same object until data changes, then a new one", () => {
    const { result } = setup();
    const a = result.current.syncBridge.getData();
    expect(result.current.syncBridge.getData()).toBe(a);
    act(() => void result.current.addClass("Math"));
    const b = result.current.syncBridge.getData();
    expect(b).not.toBe(a);
    expect(b.classes.map((c) => c.name)).toEqual(["Math"]);
    expect(result.current.syncBridge.getData()).toBe(b);
  });

  it("applies new data only if nothing changed since it was read", () => {
    const { result } = setup();
    act(() => void result.current.addClass("Math"));
    const expected = result.current.syncBridge.getData();
    const next = { classes: [{ id: "x", name: "Art", color: "#000000", groups: [] }], sessions: [] };
    let applied = false;
    act(() => void (applied = result.current.syncBridge.applyData(expected, next)));
    expect(applied).toBe(true);
    expect(result.current.classes.map((c) => c.name)).toEqual(["Art"]);
  });

  it("refuses when the data changed meanwhile, and nothing is overwritten", () => {
    const { result } = setup();
    const stale = result.current.syncBridge.getData();
    act(() => void result.current.addClass("Math")); // a change after the engine read the data
    let applied = true;
    act(() => void (applied = result.current.syncBridge.applyData(stale, { classes: [], sessions: [] })));
    expect(applied).toBe(false);
    expect(result.current.classes.map((c) => c.name)).toEqual(["Math"]);
  });

  it("refuses invalid data", () => {
    const { result } = setup();
    const expected = result.current.syncBridge.getData();
    let applied = true;
    act(() => void (applied = result.current.syncBridge.applyData(expected, { classes: [{ id: "x", name: "", color: "#000", groups: [] }], sessions: [] })));
    expect(applied).toBe(false);
    expect(result.current.classes).toEqual([]);
  });
});
