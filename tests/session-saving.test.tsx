// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudyDataProvider, useStudyData } from "@/features/data/study-data-provider";
import { SettingsProvider } from "@/features/settings/settings-provider";
import { TimerProvider, useTimer } from "@/features/timer/timer-provider";
import { DATA_KEY, DATA_VERSION, RESET_MARKER_KEY } from "@/lib/storage";

function seed() {
  localStorage.setItem(
    DATA_KEY,
    JSON.stringify({
      version: DATA_VERSION,
      classes: [{ id: "c1", name: "Math", color: "#000", groups: [{ id: "g1", name: "Unit 1" }] }],
      sessions: [],
    }),
  );
}

function setup() {
  return renderHook(() => ({ timer: useTimer(), data: useStudyData() }), {
    wrapper: ({ children }) => (
      <SettingsProvider>
        <StudyDataProvider>
          <TimerProvider>{children}</TimerProvider>
        </StudyDataProvider>
      </SettingsProvider>
    ),
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(RESET_MARKER_KEY, "done");
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date(2026, 9, 27, 12, 0, 0));
});
afterEach(() => vi.useRealTimers());

describe("duplicate saves", () => {
  it("Stop clicked twice in the same batch saves one session", () => {
    seed();
    const { result } = setup();
    act(() => result.current.timer.setClassId("c1"));
    act(() => result.current.timer.start());
    act(() => vi.advanceTimersByTime(60_000));
    act(() => {
      result.current.timer.stop();
      result.current.timer.stop();
    });
    expect(result.current.data.sessions).toHaveLength(1);
    expect(result.current.data.sessions[0].seconds).toBe(60);
  });

  it("a manual Stop after a countdown already completed does not save a second session", () => {
    seed();
    const { result } = setup();
    act(() => {
      result.current.timer.setClassId("c1");
      result.current.timer.setMode("countdown");
      result.current.timer.setDurationMinutes(5);
    });
    act(() => result.current.timer.start());
    act(() => vi.advanceTimersByTime(6 * 60_000));
    act(() => result.current.timer.stop());
    expect(result.current.data.sessions).toHaveLength(1);
    expect(result.current.data.sessions[0].seconds).toBe(300);
  });

  it("logSession ignores a session id that is already stored", () => {
    seed();
    const { result } = setup();
    const s = { id: "s1", classId: "c1", groupId: null, startedAt: 1, seconds: 30, mode: "stopwatch" as const };
    act(() => {
      result.current.data.logSession(s);
      result.current.data.logSession({ ...s, seconds: 999 });
    });
    expect(result.current.data.sessions).toEqual([s]);
  });

  it("a session shorter than one second is not saved", () => {
    seed();
    const { result } = setup();
    act(() => result.current.timer.setClassId("c1"));
    act(() => result.current.timer.start());
    act(() => vi.advanceTimersByTime(400));
    act(() => result.current.timer.stop());
    expect(result.current.data.sessions).toHaveLength(0);
  });
});

describe("deleting what a running timer points at", () => {
  it("does not save an orphan session when the class is deleted mid-session", () => {
    seed();
    const { result } = setup();
    act(() => result.current.timer.setClassId("c1"));
    act(() => result.current.timer.start());
    act(() => vi.advanceTimersByTime(60_000));
    act(() => result.current.data.deleteClass("c1"));
    act(() => result.current.timer.stop());
    expect(result.current.data.sessions).toHaveLength(0);
  });

  it("saves to the class without a dangling subgroup when the subgroup is deleted mid-session", () => {
    seed();
    const { result } = setup();
    act(() => {
      result.current.timer.setClassId("c1");
      result.current.timer.setGroupId("g1");
    });
    act(() => result.current.timer.start());
    act(() => vi.advanceTimersByTime(60_000));
    act(() => result.current.data.deleteGroup("c1", "g1"));
    act(() => result.current.timer.stop());
    expect(result.current.data.sessions).toHaveLength(1);
    expect(result.current.data.sessions[0]).toMatchObject({ classId: "c1", groupId: null });
  });
});
