// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StudyDataProvider } from "@/features/data/study-data-provider";
import { ClassesView } from "@/features/classes/classes-view";
import { SettingsProvider } from "@/features/settings/settings-provider";
import { DATA_KEY, DATA_VERSION, RESET_MARKER_KEY } from "@/lib/storage";
import type { Session } from "@/lib/types";

const H = 3_600_000;
const base = new Date(2026, 9, 20, 9).getTime();
const mk = (id: string, groupId: string | null, startedAt: number, minutes: number, classId = "math", mode: Session["mode"] = "stopwatch"): Session => ({
  id, classId, groupId, startedAt, seconds: minutes * 60, mode,
});

const sessions: Session[] = [
  mk("old", "u1", base, 30),
  mk("new", "u1", base + 48 * H, 45, "math", "countdown"),
  mk("mid", "u1", base + 24 * H, 20),
  mk("u2-only", "u2", base + 10 * H, 11),
  mk("class-level", null, base + 72 * H, 99),
  mk("sci-u1", "s-u1", base + 5 * H, 7, "sci"),
];

function seed(list: Session[] = sessions) {
  localStorage.setItem(
    DATA_KEY,
    JSON.stringify({
      version: DATA_VERSION,
      classes: [
        { id: "math", name: "Math", color: "#000", groups: [{ id: "u1", name: "Unit 1" }, { id: "u2", name: "Unit 2" }, { id: "u3", name: "Unit 3" }] },
        { id: "sci", name: "Science", color: "#111", groups: [{ id: "s-u1", name: "Unit 1" }] },
      ],
      sessions: list,
    }),
  );
}

function setup() {
  return render(
    <SettingsProvider>
      <StudyDataProvider>
        <ClassesView />
      </StudyDataProvider>
    </SettingsProvider>,
  );
}
const openClass = (name: string) => fireEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
const openSubgroup = (name: string) => fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
const cards = () => within(screen.getByRole("region", { name: /^Sessions in/ })).queryAllByRole("listitem");

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(RESET_MARKER_KEY, "done"); // these tests are about data after the one-time reset
});
afterEach(cleanup);

describe("back arrow", () => {
  it("is absent on the main Classes list", () => {
    seed();
    setup();
    expect(screen.queryByRole("button", { name: /^Back to/ })).toBeNull();
  });

  it("returns from a class to the main list", () => {
    seed();
    setup();
    openClass("Math");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Math");
    fireEvent.click(screen.getByRole("button", { name: "Back to classes" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Classes");
  });

  it("returns from a subgroup to its parent class (not to the list)", () => {
    seed();
    setup();
    openClass("Math");
    openSubgroup("Unit 1");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Unit 1");
    fireEvent.click(screen.getByRole("button", { name: "Back to Math" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Math");
    expect(screen.getByText("Subgroups")).toBeTruthy();
    // And once more up to the list.
    fireEvent.click(screen.getByRole("button", { name: "Back to classes" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Classes");
  });

  it("agrees with the breadcrumb navigation", () => {
    seed();
    setup();
    openClass("Math");
    openSubgroup("Unit 2");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: "Math" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Math");
    expect(screen.getByRole("button", { name: "Back to classes" })).toBeTruthy();
  });
});

describe("subgroup session cards", () => {
  it("shows only that subgroup's sessions, newest first", () => {
    seed();
    setup();
    openClass("Math");
    openSubgroup("Unit 1");
    const rows = cards();
    expect(rows).toHaveLength(3);
    // Newest first: 45m, 20m, 30m.
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("45m"),
      expect.stringContaining("20m"),
      expect.stringContaining("30m"),
    ]);
    expect(rows[0].textContent).toContain("Countdown");
    expect(rows[1].textContent).toContain("Stopwatch");
  });

  it("excludes class-level sessions, other subgroups, and same-named subgroups of other classes", () => {
    seed();
    setup();
    openClass("Math");
    openSubgroup("Unit 1");
    const text = cards().map((r) => r.textContent).join("|");
    expect(text).not.toContain("1h 39m"); // class-level 99m
    expect(text).not.toContain("11m"); // Unit 2
    expect(text).not.toContain("7m"); // Science › Unit 1
    // The class-level session appears nowhere in the Classes tab.
    fireEvent.click(screen.getByRole("button", { name: "Back to Math" }));
    expect(document.body.textContent).not.toContain("1h 39m ·");
    expect(screen.queryByRole("region", { name: /^Sessions in/ })).toBeNull();
  });

  it("keeps header totals consistent with the cards", () => {
    seed();
    setup();
    openClass("Math");
    openSubgroup("Unit 1");
    expect(screen.getByText(/1h 35m studied/)).toBeTruthy(); // 30 + 45 + 20
    expect(screen.getByText("3 sessions")).toBeTruthy();
  });

  it("shows an empty state for a subgroup without sessions", () => {
    seed();
    setup();
    openClass("Math");
    openSubgroup("Unit 3");
    expect(cards()).toHaveLength(0);
    expect(screen.getByText("No sessions yet")).toBeTruthy();
    expect(screen.getByText("0 sessions")).toBeTruthy();
  });

  it("does not show sessions to a subgroup whose only sessions are class-level", () => {
    seed([mk("class-level", null, base, 10)]);
    setup();
    openClass("Math");
    openSubgroup("Unit 1");
    expect(cards()).toHaveLength(0);
  });

  it("is read-only: no controls on cards, clicking opens no dialog and changes nothing", () => {
    seed();
    setup();
    openClass("Math");
    openSubgroup("Unit 1");
    const region = screen.getByRole("region", { name: /^Sessions in/ });
    expect(within(region).queryAllByRole("button")).toHaveLength(0);
    for (const row of cards()) fireEvent.click(row);
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(screen.queryByText("Edit session")).toBeNull();
    expect(cards()).toHaveLength(3);
    expect(JSON.parse(localStorage.getItem(DATA_KEY)!).sessions).toEqual(sessions);
  });
});
