// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { StudyDataProvider, useStudyData } from "@/features/data/study-data-provider";
import { SettingsProvider } from "@/features/settings/settings-provider";
import { DATA_KEY, DATA_VERSION, RESET_BACKUP_KEY, RESET_MARKER_KEY } from "@/lib/storage";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SettingsProvider>
    <StudyDataProvider>{children}</StudyDataProvider>
  </SettingsProvider>
);
const mount = () => renderHook(() => useStudyData(), { wrapper });

const userData = JSON.stringify({
  version: DATA_VERSION,
  classes: [{ id: "class-1", name: "Math", color: "#000", groups: [{ id: "g1", name: "Unit 1" }] }],
  sessions: [{ id: "session-1", classId: "class-1", groupId: "g1", startedAt: 1, seconds: 600, mode: "stopwatch" }],
});

beforeEach(() => localStorage.clear());

describe("one-time reset", () => {
  it("clears the active dataset, keeps a recovery copy, and starts empty", () => {
    localStorage.setItem(DATA_KEY, userData);
    const { result } = mount();
    expect(result.current.classes).toEqual([]);
    expect(result.current.sessions).toEqual([]);
    expect(localStorage.getItem(RESET_BACKUP_KEY)).toBe(userData);
    expect(localStorage.getItem(RESET_MARKER_KEY)).not.toBeNull();
    // What is stored as active data is empty, not the old data.
    expect(JSON.parse(localStorage.getItem(DATA_KEY)!)).toMatchObject({ classes: [], sessions: [] });
  });

  it("leaves settings, theme and every existing backup untouched", () => {
    localStorage.setItem(DATA_KEY, userData);
    const others: Record<string, string> = {
      "studytime-theme": "dark",
      "studytime:countdown-minutes": "25",
      [`${DATA_KEY}:pre-flatten-backup`]: "flatten",
      [`${DATA_KEY}:pre-seed-cleanup-backup`]: "seed",
      [`${DATA_KEY}:corrupt`]: "corrupt",
    };
    for (const [k, v] of Object.entries(others)) localStorage.setItem(k, v);
    mount();
    for (const [k, v] of Object.entries(others)) expect(localStorage.getItem(k)).toBe(v);
  });

  it("runs only once: data created afterwards survives later loads", () => {
    localStorage.setItem(DATA_KEY, userData);
    const first = mount();
    act(() => {
      first.result.current.addClass("History");
    });
    first.unmount();

    const second = mount();
    expect(second.result.current.classes.map((c) => c.name)).toEqual(["History"]);
    second.unmount();
    const third = mount();
    expect(third.result.current.classes.map((c) => c.name)).toEqual(["History"]);
    // The recovery copy still holds the pre-reset data.
    expect(localStorage.getItem(RESET_BACKUP_KEY)).toBe(userData);
  });

  it("does not overwrite an existing pre-reset backup", () => {
    localStorage.setItem(RESET_BACKUP_KEY, "older");
    localStorage.setItem(DATA_KEY, userData);
    mount();
    expect(localStorage.getItem(RESET_BACKUP_KEY)).toBe("older");
  });

  it("on a fresh install only writes the marker, so the first real data is kept", () => {
    const first = mount();
    expect(localStorage.getItem(RESET_BACKUP_KEY)).toBeNull();
    act(() => {
      first.result.current.addClass("Art");
    });
    first.unmount();
    expect(mount().result.current.classes.map((c) => c.name)).toEqual(["Art"]);
  });
});
