// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StudyDataProvider } from "@/features/data/study-data-provider";
import { ClassesView } from "@/features/classes/classes-view";
import { SettingsProvider } from "@/features/settings/settings-provider";
import { DATA_KEY, DATA_VERSION, RESET_MARKER_KEY } from "@/lib/storage";
import type { ClassItem } from "@/lib/types";

// jsdom has no <dialog> methods; open/close them by toggling the attribute.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
  localStorage.clear();
  localStorage.setItem(RESET_MARKER_KEY, "done");
});
afterEach(cleanup);

function seed(classes: ClassItem[]) {
  localStorage.setItem(DATA_KEY, JSON.stringify({ version: DATA_VERSION, classes, sessions: [] }));
}
const stored = (): ClassItem[] => JSON.parse(localStorage.getItem(DATA_KEY)!).classes;
const setup = () =>
  render(
    <SettingsProvider>
      <StudyDataProvider>
        <ClassesView />
      </StudyDataProvider>
    </SettingsProvider>,
  );
const dialog = () => screen.getByRole("dialog");
const checked = (el: HTMLElement) => (el as HTMLInputElement).checked;
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;
const bg = (el: Element | null) => (el as HTMLElement).style.backgroundColor;
const colors = () => within(dialog()).getByRole("radiogroup", { name: "Color" });

describe("choosing a color when creating a class", () => {
  it("defaults to the first unused preset, so choosing is optional", () => {
    seed([{ id: "math", name: "Math", color: "#3b82f6", groups: [] }]);
    setup();
    fireEvent.click(screen.getByRole("button", { name: /New class/ }));
    expect(checked(within(colors()).getByRole("radio", { name: "Violet" }))).toBe(true);
    fireEvent.change(within(dialog()).getByLabelText("Class name"), { target: { value: "Art" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Create" }));
    expect(stored().find((c) => c.name === "Art")?.color).toBe("#8b5cf6");
  });

  it("saves the chosen color", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Create a class" }));
    fireEvent.change(within(dialog()).getByLabelText("Class name"), { target: { value: "Bio" } });
    fireEvent.click(within(colors()).getByRole("radio", { name: "Orange" }));
    expect(checked(within(colors()).getByRole("radio", { name: "Orange" }))).toBe(true);
    expect(checked(within(colors()).getByRole("radio", { name: "Blue" }))).toBe(false);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Create" }));
    expect(stored()).toEqual([expect.objectContaining({ name: "Bio", color: "#f97316" })]);
  });
});

describe("changing a class color", () => {
  const math: ClassItem = { id: "math", name: "Math", color: "#3b82f6", groups: [{ id: "u1", name: "Unit 1" }] };

  it("edits the color through the class edit dialog and keeps name and subgroups", () => {
    seed([math]);
    setup();
    fireEvent.click(screen.getByRole("button", { name: /^Math/ }));
    expect(bg(screen.getByTestId("page-accent"))).toBe(rgb("#3b82f6"));
    fireEvent.click(screen.getByRole("button", { name: "Edit Math" }));
    expect((within(dialog()).getByLabelText("Class name") as HTMLInputElement).value).toBe("Math");
    expect(checked(within(colors()).getByRole("radio", { name: "Blue" }))).toBe(true);
    fireEvent.click(within(colors()).getByRole("radio", { name: "Emerald" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(stored()).toEqual([{ ...math, color: "#10b981" }]);
    expect(bg(screen.getByTestId("page-accent"))).toBe(rgb("#10b981"));
  });

  it("can rename and recolor in one save", () => {
    seed([math]);
    setup();
    fireEvent.click(screen.getByRole("button", { name: /^Math/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Math" }));
    fireEvent.change(within(dialog()).getByLabelText("Class name"), { target: { value: "Algebra" } });
    fireEvent.click(within(colors()).getByRole("radio", { name: "Red" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(stored()).toEqual([{ ...math, name: "Algebra", color: "#ef4444" }]);
  });

  it("cancel changes nothing", () => {
    seed([math]);
    setup();
    fireEvent.click(screen.getByRole("button", { name: /^Math/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Math" }));
    fireEvent.click(within(colors()).getByRole("radio", { name: "Red" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(stored()).toEqual([math]);
  });

  it("keeps a non-preset color (e.g. from a backup) selected as Custom until another is picked", () => {
    seed([{ ...math, color: "#123456" }]);
    setup();
    fireEvent.click(screen.getByRole("button", { name: /^Math/ }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Math" }));
    expect(checked(within(colors()).getByRole("radio", { name: "Custom" }))).toBe(true);
    fireEvent.change(within(dialog()).getByLabelText("Class name"), { target: { value: "Maths" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(stored()[0]).toMatchObject({ name: "Maths", color: "#123456" });
  });

  it("subgroup rows show the class color", () => {
    seed([math]);
    setup();
    fireEvent.click(screen.getByRole("button", { name: /^Math/ }));
    const row = screen.getByRole("button", { name: /^Unit 1/ });
    expect(bg(row.querySelector("span[aria-hidden]"))).toBe(rgb("#3b82f6"));
  });
});
