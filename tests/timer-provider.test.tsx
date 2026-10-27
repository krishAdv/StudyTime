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
  localStorage.setItem(RESET_MARKER_KEY, "done"); // these tests are about data after the one-time reset
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date(2026, 9, 27, 12, 0, 0));
});
afterEach(() => vi.useRealTimers());

describe("timer default mode", () => {
  it("starts in Stopwatch for a user with nothing saved", () => {
    const { result } = setup();
    expect(result.current.timer.state.mode).toBe("stopwatch");
    expect(result.current.timer.displayMs).toBe(0);
  });

  it("still starts in Stopwatch when other saved data exists, such as a countdown length", () => {
    seed();
    localStorage.setItem("studytime:countdown-minutes", "25");
    const { result } = setup();
    expect(result.current.timer.state.mode).toBe("stopwatch");
    expect(result.current.timer.durationMinutes).toBe(25);
  });

  it("keeps the mode locked while a session is active", () => {
    seed();
    const { result } = setup();
    act(() => result.current.timer.setClassId("c1"));
    act(() => result.current.timer.start());
    act(() => result.current.timer.setMode("countdown"));
    expect(result.current.timer.state.mode).toBe("stopwatch");
  });
});

describe("saving sessions", () => {
  it("stopwatch counts up, pauses without counting, and saves class, group and mode", () => {
    seed();
    const { result } = setup();
    act(() => {
      result.current.timer.setClassId("c1");
      result.current.timer.setGroupId("g1");
    });
    act(() => result.current.timer.start());
    act(() => vi.advanceTimersByTime(90_000));
    expect(result.current.timer.displayMs).toBe(90_000);
    act(() => result.current.timer.pause());
    act(() => vi.advanceTimersByTime(60_000));
    act(() => result.current.timer.resume());
    act(() => vi.advanceTimersByTime(30_000));
    act(() => result.current.timer.stop());

    const [s] = result.current.data.sessions;
    expect(result.current.data.sessions).toHaveLength(1);
    expect(s).toMatchObject({ classId: "c1", groupId: "g1", seconds: 120, mode: "stopwatch" });
    expect(result.current.timer.state.mode).toBe("stopwatch");
  });

  it("countdown saves the elapsed time on stop and the full target on completion", () => {
    seed();
    const { result } = setup();
    act(() => {
      result.current.timer.setClassId("c1");
      result.current.timer.setMode("countdown");
      result.current.timer.setDurationMinutes(10);
    });
    act(() => result.current.timer.start());
    act(() => vi.advanceTimersByTime(4 * 60_000));
    expect(result.current.timer.displayMs).toBe(6 * 60_000);
    act(() => result.current.timer.stop());
    expect(result.current.data.sessions[0]).toMatchObject({ classId: "c1", groupId: null, seconds: 240, mode: "countdown" });

    act(() => result.current.timer.start());
    act(() => vi.advanceTimersByTime(11 * 60_000));
    expect(result.current.data.sessions).toHaveLength(2);
    expect(result.current.data.sessions[0]).toMatchObject({ seconds: 600, mode: "countdown" });
    expect(result.current.timer.state.status).toBe("idle");
  });
});

describe("provider enforces class rules", () => {
  it("rejects duplicate class names (case/whitespace) and keeps existing data", () => {
    seed();
    const { result } = setup();
    let r!: ReturnType<typeof result.current.data.addClass>;
    act(() => {
      r = result.current.data.addClass("  mATh ");
    });
    expect(r.ok).toBe(false);
    expect(result.current.data.classes).toHaveLength(1);
    act(() => {
      r = result.current.data.addClass("  Art ");
    });
    expect(r.ok).toBe(true);
    expect(result.current.data.classes.map((c) => c.name)).toEqual(["Math", "Art"]);
  });

  it("rejects two same-name classes created back to back in one batch", () => {
    seed();
    const { result } = setup();
    const rs: boolean[] = [];
    act(() => {
      rs.push(result.current.data.addClass("Bio").ok);
      rs.push(result.current.data.addClass("BIO").ok);
    });
    expect(rs).toEqual([true, false]);
    expect(result.current.data.classes.filter((c) => c.name.toLowerCase() === "bio")).toHaveLength(1);
  });

  it("rejects subgroup-under-subgroup and allows keeping the class's own name on rename", () => {
    seed();
    const { result } = setup();
    let r!: ReturnType<typeof result.current.data.addGroup>;
    act(() => {
      r = result.current.data.addGroup("c1", "Unit 1.1", "g1");
    });
    expect(r.ok).toBe(false);
    expect(result.current.data.classes[0].groups).toHaveLength(1);
    act(() => {
      r = result.current.data.renameClass("c1", "MATH");
    });
    expect(r.ok).toBe(true);
  });
});
