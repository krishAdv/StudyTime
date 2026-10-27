// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { StudyDataProvider, useStudyData } from "@/features/data/study-data-provider";
import { SettingsProvider } from "@/features/settings/settings-provider";
import { removeKnownSeedData } from "@/lib/legacy-seed";
import { DATA_KEY, RESET_MARKER_KEY } from "@/lib/storage";
import { classTotals } from "@/lib/timeframe";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SettingsProvider>
    <StudyDataProvider>{children}</StudyDataProvider>
  </SettingsProvider>
);
const load = () => renderHook(() => useStudyData(), { wrapper }).result.current;
const stored = () => JSON.parse(localStorage.getItem(DATA_KEY)!);

// What version 1 saved on first run: nested sample classes + seed-N sessions.
const SEED_V1 = {
  version: 1,
  classes: [
    {
      id: "cs", name: "Computer Science", color: "#3b82f6",
      groups: [
        { id: "cs-algo", name: "Algorithms", children: [
          { id: "cs-graphs", name: "Graphs", children: [{ id: "cs-sp", name: "Shortest Paths", children: [] }] },
          { id: "cs-dp", name: "Dynamic Programming", children: [] },
        ] },
        { id: "cs-os", name: "Operating Systems", children: [{ id: "cs-sched", name: "Scheduling", children: [] }] },
        { id: "cs-proj", name: "Final Project", children: [] },
      ],
    },
    {
      id: "math", name: "Mathematics", color: "#8b5cf6",
      groups: [
        { id: "math-la", name: "Linear Algebra", children: [{ id: "math-eig", name: "Eigenvalues", children: [] }] },
        { id: "math-vc", name: "Vector Calculus", children: [] },
      ],
    },
    {
      id: "hist", name: "History", color: "#f59e0b",
      groups: [
        { id: "hist-eu", name: "Modern Europe", children: [
          { id: "hist-essay", name: "Essay Draft", children: [] },
          { id: "hist-notes", name: "Reading Notes", children: [] },
        ] },
        { id: "hist-rome", name: "Ancient Rome", children: [] },
      ],
    },
  ],
  sessions: [
    { id: "seed-0", classId: "cs", groupId: "cs-graphs", startedAt: 1, seconds: 1500, mode: "countdown" },
    { id: "seed-3", classId: "hist", groupId: "hist-essay", startedAt: 2, seconds: 3300, mode: "stopwatch" },
    { id: "seed-14", classId: "math", groupId: null, startedAt: 3, seconds: 3000, mode: "countdown" },
  ],
};

const realSession = {
  id: "session-abc", classId: "cs", groupId: null, startedAt: 5, seconds: 900, mode: "stopwatch",
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(RESET_MARKER_KEY, "done"); // these tests are about data after the one-time reset
});

describe("empty first run", () => {
  it("starts with no classes or sessions and writes no sample data", () => {
    const d = load();
    expect(d.classes).toEqual([]);
    expect(d.sessions).toEqual([]);
    expect(d.secondsFor("cs")).toBe(0);
    expect(classTotals(d.classes, d.sessions, "all", Date.now())).toEqual([]);
  });

  it("an unreadable payload is kept aside and the app starts empty", () => {
    localStorage.setItem(DATA_KEY, "{not json");
    expect(load().classes).toEqual([]);
    expect(localStorage.getItem(`${DATA_KEY}:corrupt`)).toBe("{not json");
  });
});

describe("one-time sample cleanup (version 1 → 2)", () => {
  it("removes untouched sample classes and sessions, backs up the original, and saves as version 2", () => {
    const raw = JSON.stringify(SEED_V1);
    localStorage.setItem(DATA_KEY, raw);
    const d = load();
    expect(d.classes).toEqual([]);
    expect(d.sessions).toEqual([]);
    expect(localStorage.getItem(`${DATA_KEY}:pre-seed-cleanup-backup`)).toBe(raw);
  });

  it("keeps a sample class the user logged real time against, with all of its sessions", () => {
    localStorage.setItem(DATA_KEY, JSON.stringify({ ...SEED_V1, sessions: [...SEED_V1.sessions, realSession] }));
    const d = load();
    expect(d.classes.map((c) => c.id)).toEqual(["cs"]);
    expect(d.sessions.map((s) => s.id).sort()).toEqual(["seed-0", "session-abc"]);
  });

  it("keeps a sample class the user renamed or extended", () => {
    const renamed = { ...SEED_V1, classes: SEED_V1.classes.map((c) => (c.id === "math" ? { ...c, name: "Calculus" } : c)) };
    localStorage.setItem(DATA_KEY, JSON.stringify(renamed));
    expect(load().classes.map((c) => c.id)).toEqual(["math"]);

    localStorage.clear();
  localStorage.setItem(RESET_MARKER_KEY, "done"); // these tests are about data after the one-time reset
    const extended = {
      ...SEED_V1,
      classes: SEED_V1.classes.map((c) =>
        c.id === "hist" ? { ...c, groups: [...c.groups, { id: "group-new", name: "Mine", children: [] }] } : c,
      ),
    };
    localStorage.setItem(DATA_KEY, JSON.stringify(extended));
    expect(load().classes.map((c) => c.id)).toEqual(["hist"]);
  });

  it("never removes user classes, even ones named like samples or reusing sample ids with other content", () => {
    const user = {
      version: 1,
      classes: [
        { id: "class-1", name: "Computer Science", color: "#3b82f6", groups: [] },
        { id: "cs", name: "My CS", color: "#3b82f6", groups: [] },
      ],
      sessions: [realSession, { ...realSession, id: "seed-0", classId: "class-1" }],
    };
    localStorage.setItem(DATA_KEY, JSON.stringify(user));
    const d = load();
    expect(d.classes.map((c) => c.id)).toEqual(["class-1", "cs"]);
    expect(d.sessions).toHaveLength(2);
    expect(localStorage.getItem(`${DATA_KEY}:pre-seed-cleanup-backup`)).toBeNull();
  });

  it("is idempotent: version 2 data is never cleaned again", () => {
    localStorage.setItem(DATA_KEY, JSON.stringify(SEED_V1));
    load();
    expect(stored().version).toBe(2);
    // A user later recreates a class that happens to look like a sample: untouched on next load.
    const v2 = { ...SEED_V1, version: 2 };
    localStorage.setItem(DATA_KEY, JSON.stringify(v2));
    expect(load().classes).toHaveLength(3);
    // Reloading the migrated payload changes nothing.
    localStorage.setItem(DATA_KEY, JSON.stringify({ version: 2, classes: [{ id: "class-9", name: "Art", color: "#000", groups: [] }], sessions: [realSession] }));
    const before = localStorage.getItem(DATA_KEY);
    load();
    expect(JSON.parse(localStorage.getItem(DATA_KEY)!)).toEqual(JSON.parse(before!));
  });

  it("preserves existing backup keys, including the pre-flatten backup", () => {
    localStorage.setItem(`${DATA_KEY}:pre-flatten-backup`, "old-backup");
    localStorage.setItem(`${DATA_KEY}:pre-seed-cleanup-backup`, "older");
    localStorage.setItem(DATA_KEY, JSON.stringify(SEED_V1));
    load();
    expect(localStorage.getItem(`${DATA_KEY}:pre-flatten-backup`)).toBe("old-backup");
    expect(localStorage.getItem(`${DATA_KEY}:pre-seed-cleanup-backup`)).toBe("older");
  });

  it("creates the pre-flatten backup for nested data that is not sample data", () => {
    const nested = {
      version: 1,
      classes: [{ id: "class-1", name: "Bio", color: "#000", groups: [{ id: "g1", name: "A", children: [{ id: "g2", name: "B", children: [] }] }] }],
      sessions: [{ ...realSession, classId: "class-1", groupId: "g2" }],
    };
    localStorage.setItem(DATA_KEY, JSON.stringify(nested));
    const d = load();
    expect(d.classes[0].groups.map((g) => g.id)).toEqual(["g1", "g2"]);
    expect(d.sessions[0].groupId).toBe("g2");
    expect(localStorage.getItem(`${DATA_KEY}:pre-flatten-backup`)).toBe(JSON.stringify(nested));
  });

  it("removeKnownSeedData is a no-op on data without sample records", () => {
    const data = { classes: [], sessions: [realSession as never] };
    expect(removeKnownSeedData(data)).toEqual({ data, removed: false });
  });
});
