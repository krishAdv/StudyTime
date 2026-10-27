// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { StudyDataProvider, useStudyData } from "@/features/data/study-data-provider";
import { SettingsProvider } from "@/features/settings/settings-provider";
import { reassignSession } from "@/lib/session-rules";
import { DATA_KEY, DATA_VERSION, RESET_MARKER_KEY } from "@/lib/storage";
import type { ClassItem, Session } from "@/lib/types";

const classes: ClassItem[] = [
  { id: "math", name: "Math", color: "#000", groups: [{ id: "m-u1", name: "Unit 1" }, { id: "m-u2", name: "Unit 2" }] },
  { id: "sci", name: "Science", color: "#111", groups: [{ id: "s-lab", name: "Lab" }] },
];
const session: Session = {
  id: "sess-1", classId: "math", groupId: "m-u1", startedAt: 1_700_000_000_000, seconds: 1234, mode: "stopwatch",
};
const other: Session = { ...session, id: "sess-2", groupId: null, seconds: 60, mode: "countdown" };

function seed() {
  localStorage.setItem(DATA_KEY, JSON.stringify({ version: DATA_VERSION, classes, sessions: [session, other] }));
}
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SettingsProvider>
    <StudyDataProvider>{children}</StudyDataProvider>
  </SettingsProvider>
);

describe("reassignSession (pure)", () => {
  const sessions = [session, other];

  it("changes the subgroup within a class", () => {
    const r = reassignSession(classes, sessions, "sess-1", "math", "m-u2");
    expect(r.ok && r.value[0]).toMatchObject({ classId: "math", groupId: "m-u2" });
  });

  it("removes the subgroup (assign to the class itself)", () => {
    const r = reassignSession(classes, sessions, "sess-1", "math", null);
    expect(r.ok && r.value[0].groupId).toBeNull();
  });

  it("changes class together with a subgroup of the new class", () => {
    const r = reassignSession(classes, sessions, "sess-1", "sci", "s-lab");
    expect(r.ok && r.value[0]).toMatchObject({ classId: "sci", groupId: "s-lab" });
  });

  it("rejects a subgroup that belongs to a different class (stale subgroup after switching class)", () => {
    expect(reassignSession(classes, sessions, "sess-1", "sci", "m-u1").ok).toBe(false);
  });

  it("rejects unknown classes, groups and sessions", () => {
    expect(reassignSession(classes, sessions, "sess-1", "gone", null).ok).toBe(false);
    expect(reassignSession(classes, sessions, "sess-1", "math", "nope").ok).toBe(false);
    expect(reassignSession(classes, sessions, "missing", "math", null).ok).toBe(false);
  });

  it("preserves id, start, duration, mode and other fields; leaves other sessions alone", () => {
    const extra = { ...session, note: "kept" } as Session;
    const r = reassignSession(classes, [extra, other], "sess-1", "sci", null);
    if (!r.ok) throw new Error(r.error);
    expect(r.value[0]).toEqual({ ...extra, classId: "sci", groupId: null });
    expect(r.value[1]).toBe(other);
    expect(r.value).toHaveLength(2);
  });

  it("does not mutate its inputs", () => {
    reassignSession(classes, [session], "sess-1", "sci", null);
    expect(session.classId).toBe("math");
  });
});

describe("reassignSession through the provider", () => {
  beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(RESET_MARKER_KEY, "done"); // these tests are about data after the one-time reset
});

  it("updates the stored session in place, keeps its identity and duration, and persists", () => {
    seed();
    const { result, unmount } = renderHook(() => useStudyData(), { wrapper });
    let r!: ReturnType<typeof result.current.reassignSession>;
    act(() => {
      r = result.current.reassignSession("sess-1", "sci", "s-lab");
    });
    expect(r.ok).toBe(true);
    const s = result.current.sessions.find((x) => x.id === "sess-1")!;
    expect(s).toEqual({ ...session, classId: "sci", groupId: "s-lab" });
    expect(result.current.sessions).toHaveLength(2);
    // Derived totals follow immediately.
    expect(result.current.secondsFor("sci")).toBe(1234);
    expect(result.current.secondsFor("sci", "s-lab")).toBe(1234);
    expect(result.current.secondsFor("math")).toBe(60);

    // "Refresh": a new provider reads what was written to localStorage.
    unmount();
    const again = renderHook(() => useStudyData(), { wrapper });
    expect(again.result.current.sessions.find((x) => x.id === "sess-1")).toEqual({
      ...session,
      classId: "sci",
      groupId: "s-lab",
    });
  });

  it("can clear the subgroup, and a rejected change leaves data untouched", () => {
    seed();
    const { result } = renderHook(() => useStudyData(), { wrapper });
    let r!: ReturnType<typeof result.current.reassignSession>;
    act(() => {
      r = result.current.reassignSession("sess-1", "sci", "m-u1");
    });
    expect(r.ok).toBe(false);
    expect(result.current.sessions.find((x) => x.id === "sess-1")).toEqual(session);
    act(() => {
      r = result.current.reassignSession("sess-1", "math", null);
    });
    expect(r.ok).toBe(true);
    expect(result.current.sessions.find((x) => x.id === "sess-1")?.groupId).toBeNull();
    expect(result.current.secondsFor("math", "m-u1")).toBe(0);
  });
});
