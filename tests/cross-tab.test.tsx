// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaleTabBanner } from "@/components/layout/stale-tab-banner";
import { StudyDataProvider, useStudyData } from "@/features/data/study-data-provider";
import { accountKey, createAccountStore } from "@/lib/account-store";
import type { StorageLike } from "@/lib/data-store";
import { serializeData, type StoredData } from "@/lib/storage";
import { createMemoryStorage, type MemoryStorage } from "./helpers/memory-storage";

const downloads: { text: string; name: string }[] = [];
vi.mock("@/lib/download", () => ({ downloadText: (text: string, name: string) => void downloads.push({ text, name }) }));

afterEach(cleanup);
beforeEach(() => {
  downloads.length = 0;
});

const USER = "user-a";
const DATA_KEY = accountKey(USER, "data");

const OTHER_TAB_DATA: StoredData = {
  classes: [{ id: "n1", name: "Written by the other tab", color: "#3b82f6", groups: [] }],
  sessions: [{ id: "n-s1", classId: "n1", groupId: null, startedAt: 1_700_000_000_000, seconds: 600, mode: "stopwatch" }],
};

/** One browser tab: its own store and providers over the SHARED storage (like two tabs sharing localStorage). */
function openTab(mem: StorageLike) {
  const store = createAccountStore(USER, () => mem);
  return renderHook(() => useStudyData(), { wrapper: ({ children }) => <StudyDataProvider store={store}>{children}</StudyDataProvider> });
}

/** What the browser does for the OTHER tabs when a tab writes: a storage event. */
const storageEvent = (key: string | null = DATA_KEY) => act(() => void window.dispatchEvent(new StorageEvent("storage", { key })));
/** Another tab saves `data`. */
const otherTabSaves = (mem: StorageLike, data: StoredData) => mem.setItem(DATA_KEY, serializeData(data));

describe("normal single-tab use is unchanged", () => {
  it("saves every change, and is never flagged by its own writes or by window events", () => {
    const mem = createMemoryStorage();
    const tab = openTab(mem);
    act(() => void tab.result.current.addClass("Math"));
    act(() => void tab.result.current.addClass("Art"));
    expect(tab.result.current.staleTab).toBe(false);
    expect(JSON.parse(mem.getItem(DATA_KEY)!).classes.map((c: { name: string }) => c.name)).toEqual(["Math", "Art"]);
    // the events a single tab sees in normal use
    storageEvent();
    act(() => void window.dispatchEvent(new Event("focus")));
    act(() => void window.dispatchEvent(new Event("pageshow")));
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(tab.result.current.staleTab).toBe(false);
    act(() => void tab.result.current.addClass("Biology"));
    expect(tab.result.current.classes.map((c) => c.name)).toEqual(["Math", "Art", "Biology"]);
    expect(JSON.parse(mem.getItem(DATA_KEY)!).classes).toHaveLength(3);
  });

  it("a tab with existing data loads it and saves normally", () => {
    const mem = createMemoryStorage({ [DATA_KEY]: serializeData(OTHER_TAB_DATA) });
    const tab = openTab(mem);
    expect(tab.result.current.classes.map((c) => c.id)).toEqual(["n1"]);
    act(() => void tab.result.current.addClass("More"));
    expect(tab.result.current.staleTab).toBe(false);
    expect(JSON.parse(mem.getItem(DATA_KEY)!).classes).toHaveLength(2);
  });

  it("two tabs that wrote identical text are not in conflict", () => {
    const mem = createMemoryStorage({ [DATA_KEY]: serializeData(OTHER_TAB_DATA) });
    const tab = openTab(mem);
    otherTabSaves(mem, OTHER_TAB_DATA); // the same text again
    storageEvent();
    expect(tab.result.current.staleTab).toBe(false);
  });

  it("when storage cannot be read nothing is ever flagged, and the tab works as before", () => {
    const broken: StorageLike = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
    const tab = openTab(broken);
    act(() => void tab.result.current.addClass("Math"));
    storageEvent();
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(tab.result.current.staleTab).toBe(false);
    expect(tab.result.current.classes.map((c) => c.name)).toEqual(["Math"]);
  });
});

describe("another tab modifies the data while this tab is active", () => {
  it("a storage event marks the OTHER tab stale, and never the tab that wrote", () => {
    const mem = createMemoryStorage();
    const a = openTab(mem);
    const b = openTab(mem);
    act(() => void a.result.current.addClass("From tab A"));
    storageEvent(); // delivered to both tabs here; in a browser only to tab B
    expect(b.result.current.staleTab).toBe(true);
    expect(a.result.current.staleTab).toBe(false);
  });

  it("an event for some other key changes nothing", () => {
    const mem = createMemoryStorage();
    const b = openTab(mem);
    storageEvent("studytime-theme");
    expect(b.result.current.staleTab).toBe(false);
  });

  it("a change is also noticed without any event, when the tab becomes visible, gets focus, or is restored (Safari)", () => {
    for (const trigger of [() => document.dispatchEvent(new Event("visibilitychange")), () => window.dispatchEvent(new Event("focus")), () => window.dispatchEvent(new Event("pageshow"))]) {
      cleanup();
      const mem = createMemoryStorage();
      const b = openTab(mem);
      otherTabSaves(mem, OTHER_TAB_DATA); // no storage event is delivered (a suspended tab)
      expect(b.result.current.staleTab).toBe(false);
      act(() => void trigger());
      expect(b.result.current.staleTab).toBe(true);
    }
  });

  it("a hidden tab does not check on visibilitychange", () => {
    const mem = createMemoryStorage();
    const b = openTab(mem);
    otherTabSaves(mem, OTHER_TAB_DATA);
    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(b.result.current.staleTab).toBe(false);
    spy.mockRestore();
  });

  it("DETECTED AT SAVE TIME: even if no event ever arrives, a stale tab's save is refused and the newer data survives", () => {
    const mem = createMemoryStorage();
    const b = openTab(mem);
    otherTabSaves(mem, OTHER_TAB_DATA); // another tab saved; this tab heard nothing
    const newer = mem.getItem(DATA_KEY);
    act(() => void b.result.current.addClass("Stale edit")); // this tab edits and tries to save its older copy
    expect(mem.getItem(DATA_KEY)).toBe(newer); // the newer data was NOT overwritten
    expect(b.result.current.staleTab).toBe(true);
  });
});

describe("the store on its own", () => {
  it("a watcher added after the tab already went stale is told at once, and a watcher that was removed is not", () => {
    const mem = createMemoryStorage();
    const store = createAccountStore(USER, () => mem);
    store.load();
    otherTabSaves(mem, OTHER_TAB_DATA);
    store.save({ classes: [], sessions: [] }); // refused: another tab wrote first
    expect(mem.getItem(DATA_KEY)).toBe(serializeData(OTHER_TAB_DATA));
    const late = vi.fn();
    const stop = store.watch!(late);
    expect(late).toHaveBeenCalledTimes(1);
    stop();
    const removed = vi.fn();
    store.watch!(removed)();
    expect(removed).toHaveBeenCalledTimes(1); // told at once (already stale), then removed; never again
    window.dispatchEvent(new StorageEvent("storage", { key: DATA_KEY }));
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it("once stale, the STORE itself never writes again, even if the stored text later matches what it knew", () => {
    const mem = createMemoryStorage({ [DATA_KEY]: serializeData(OTHER_TAB_DATA) });
    const store = createAccountStore(USER, () => mem);
    store.load(); // knows OTHER_TAB_DATA
    const told = vi.fn();
    store.watch!(told);
    const changed: StoredData = { classes: [{ id: "x", name: "Changed elsewhere", color: "#000000", groups: [] }], sessions: [] };
    otherTabSaves(mem, changed);
    store.checkNow!();
    expect(told).toHaveBeenCalledTimes(1);
    otherTabSaves(mem, OTHER_TAB_DATA); // the stored text is back to exactly what this store knew
    store.save({ classes: [], sessions: [] });
    expect(mem.getItem(DATA_KEY)).toBe(serializeData(OTHER_TAB_DATA)); // still refused: it is stale for good
    expect(told).toHaveBeenCalledTimes(1); // and it only ever told its watchers once
  });

  it("the cleanup removes exactly the four listeners it added (storage, focus, pageshow, visibilitychange) and resets so a later watcher attaches again", () => {
    const EVENTS = ["storage", "focus", "pageshow", "visibilitychange"];
    const only = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => EVENTS.includes(c[0] as string));
    const winAdd = vi.spyOn(window, "addEventListener");
    const winRemove = vi.spyOn(window, "removeEventListener");
    const docAdd = vi.spyOn(document, "addEventListener");
    const docRemove = vi.spyOn(document, "removeEventListener");
    try {
      const store = createAccountStore(USER, () => createMemoryStorage());
      store.load();
      const stopA = store.watch!(vi.fn());
      const stopB = store.watch!(vi.fn());
      const added = [...only(winAdd), ...only(docAdd)];
      expect(added.map((c) => c[0])).toEqual(["storage", "focus", "pageshow", "visibilitychange"]); // one set, even with two watchers

      stopA();
      expect(only(winRemove).length + only(docRemove).length).toBe(0); // another watcher is still there

      stopB();
      const removed = [...only(winRemove), ...only(docRemove)];
      expect(removed.map((c) => c[0])).toEqual(["storage", "focus", "pageshow", "visibilitychange"]);
      added.forEach((a, i) => expect(removed[i][1]).toBe(a[1])); // the very same handler functions (anything else would leave a listener behind)

      stopB(); // a second call is harmless
      expect(only(winRemove).length + only(docRemove).length).toBe(4);

      const stopC = store.watch!(vi.fn()); // attachment state was reset: a fresh set is added
      expect(only(winAdd).length + only(docAdd).length).toBe(8);
      stopC();
      expect(only(winRemove).length + only(docRemove).length).toBe(8);
    } finally {
      winAdd.mockRestore();
      winRemove.mockRestore();
      docAdd.mockRestore();
      docRemove.mockRestore();
    }
  });

  it("after the cleanup, window events no longer reach a watcher", () => {
    const mem = createMemoryStorage();
    const store = createAccountStore(USER, () => mem);
    store.load();
    const told = vi.fn();
    store.watch!(told)();
    otherTabSaves(mem, OTHER_TAB_DATA);
    window.dispatchEvent(new StorageEvent("storage", { key: DATA_KEY }));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(told).not.toHaveBeenCalled();
  });

  it("first run in two tabs: the tab that started empty is stale once the other one has saved", () => {
    const mem = createMemoryStorage();
    const first = createAccountStore(USER, () => mem);
    const second = createAccountStore(USER, () => mem);
    first.load();
    second.load(); // both started with nothing stored
    const told = vi.fn();
    second.watch!(told);
    first.save(OTHER_TAB_DATA);
    window.dispatchEvent(new StorageEvent("storage", { key: DATA_KEY }));
    expect(told).toHaveBeenCalledTimes(1);
  });
});

describe("a stale tab cannot save, change or sync", () => {
  function staleTab() {
    const mem: MemoryStorage = createMemoryStorage();
    const b = openTab(mem);
    act(() => void b.result.current.addClass("Before"));
    otherTabSaves(mem, OTHER_TAB_DATA);
    storageEvent();
    expect(b.result.current.staleTab).toBe(true);
    return { mem, b, newer: mem.getItem(DATA_KEY) };
  }

  it("every change is refused with a message, and storage keeps the other tab's data", () => {
    const { mem, b, newer } = staleTab();
    const before = b.result.current.classes;
    let results: { ok: boolean }[] = [];
    act(() => {
      const d = b.result.current;
      results = [d.addClass("X"), d.renameClass(d.classes[0].id, "Y"), d.addGroup(d.classes[0].id, "G"), d.renameGroup(d.classes[0].id, "g", "H"), d.replaceAllData({ classes: [], sessions: [] }), d.reassignSession("s", "c", null)];
      d.deleteClass(d.classes[0].id);
      d.deleteGroup(d.classes[0].id, "g");
    });
    expect(results.every((r) => r.ok === false)).toBe(true);
    const first = results[0] as { ok: false; error: string };
    expect(first.error).toMatch(/changed in another tab/);
    expect(b.result.current.classes).toBe(before); // nothing changed in memory either
    expect(mem.getItem(DATA_KEY)).toBe(newer); // nothing was written
  });

  it("a session finished in this tab is kept in memory (not dropped silently) but is never saved", () => {
    const { mem, b, newer } = staleTab();
    const classId = b.result.current.classes[0].id;
    act(() => b.result.current.logSession({ id: "stale-s1", classId, groupId: null, startedAt: 1_700_001_000_000, seconds: 300, mode: "stopwatch" }));
    expect(b.result.current.sessions.map((s) => s.id)).toContain("stale-s1");
    expect(mem.getItem(DATA_KEY)).toBe(newer);
    expect(mem.getItem(DATA_KEY)).not.toContain("stale-s1");
  });

  it("the sync bridge refuses to replace this tab's data and reports it is stale", () => {
    const { b } = staleTab();
    const bridge = b.result.current.syncBridge;
    expect(bridge.isStale()).toBe(true);
    expect(bridge.applyData(bridge.getData(), { classes: [], sessions: [] })).toBe(false);
    expect(b.result.current.classes.map((c) => c.name)).toEqual(["Before"]);
  });

  it("stays stale for good: even if the stored text goes back to what this tab knew, it never writes again", () => {
    const { mem, b } = staleTab();
    const knownByThisTab = serializeData({ classes: b.result.current.classes, sessions: b.result.current.sessions });
    mem.setItem(DATA_KEY, knownByThisTab);
    act(() => void window.dispatchEvent(new Event("focus")));
    act(() => void b.result.current.addClass("Still refused"));
    expect(b.result.current.staleTab).toBe(true);
    expect(mem.getItem(DATA_KEY)).toBe(knownByThisTab);
  });

  it("the tab that wrote keeps working normally", () => {
    const mem = createMemoryStorage();
    const a = openTab(mem);
    const b = openTab(mem);
    act(() => void a.result.current.addClass("A1"));
    storageEvent();
    act(() => void a.result.current.addClass("A2"));
    expect(a.result.current.staleTab).toBe(false);
    expect(JSON.parse(mem.getItem(DATA_KEY)!).classes.map((c: { name: string }) => c.name)).toEqual(["A1", "A2"]);
    expect(b.result.current.staleTab).toBe(true);
  });
});

describe("reload and recovery", () => {
  it("a reloaded tab (a fresh store and provider) loads the newer data, is not stale, and can save again", () => {
    const mem = createMemoryStorage();
    const a = openTab(mem);
    const b = openTab(mem);
    act(() => void a.result.current.addClass("From tab A"));
    storageEvent();
    expect(b.result.current.staleTab).toBe(true);

    // reload tab B: the old page is gone, a new one starts from storage
    b.unmount();
    const reloaded = openTab(mem);
    expect(reloaded.result.current.staleTab).toBe(false);
    expect(reloaded.result.current.classes.map((c) => c.name)).toEqual(["From tab A"]);
    act(() => void reloaded.result.current.addClass("After reload"));
    expect(JSON.parse(mem.getItem(DATA_KEY)!).classes.map((c: { name: string }) => c.name)).toEqual(["From tab A", "After reload"]);
    // and the other tab learns about THAT change in turn
    storageEvent();
    expect(a.result.current.staleTab).toBe(true);
    expect(reloaded.result.current.staleTab).toBe(false);
  });

  it("unmounting stops watching: a later change causes no error and no update", () => {
    const mem = createMemoryStorage();
    const b = openTab(mem);
    b.unmount();
    expect(() => {
      otherTabSaves(mem, OTHER_TAB_DATA);
      window.dispatchEvent(new StorageEvent("storage", { key: DATA_KEY }));
      window.dispatchEvent(new Event("focus"));
    }).not.toThrow();
  });
});

describe("the message and the Reload button", () => {
  function banner(mem: StorageLike, onReload?: () => void) {
    const store = createAccountStore(USER, () => mem);
    render(
      <StudyDataProvider store={store}>
        <StaleTabBanner onReload={onReload} />
      </StudyDataProvider>,
    );
    return store;
  }

  it("shows nothing in normal use", () => {
    banner(createMemoryStorage());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains what happened, offers Reload, and does NOT reload by itself", () => {
    const mem = createMemoryStorage();
    const reload = vi.fn();
    banner(mem, reload);
    otherTabSaves(mem, OTHER_TAB_DATA);
    act(() => void window.dispatchEvent(new Event("focus")));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/StudyTime was changed in another tab/);
    expect(alert.textContent).toMatch(/stopped saving and syncing/);
    expect(alert.textContent).toMatch(/Reload this tab to continue/);
    expect(reload).not.toHaveBeenCalled(); // never automatic
    fireEvent.click(screen.getByRole("button", { name: "Reload this tab" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("lets the person download what this tab holds first", () => {
    const mem = createMemoryStorage();
    banner(mem);
    otherTabSaves(mem, OTHER_TAB_DATA);
    act(() => void window.dispatchEvent(new Event("focus")));
    fireEvent.click(screen.getByRole("button", { name: "Download this tab’s data" }));
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toMatch(/^studytime-this-tab-/);
    expect(JSON.parse(downloads[0].text).format).toBe("studytime-export");
    expect(screen.getByRole("status").textContent).toMatch(/Download started/);
  });
});
