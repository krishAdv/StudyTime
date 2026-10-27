// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dropdown } from "@/components/ui/dropdown";
import { computeMenuPlacement } from "@/lib/menu-position";
import { TIMEFRAME_OPTIONS, type Timeframe } from "@/lib/timeframe";

const WIDTHS = [320, 375, 390, 430, 768, 1024];
const box = (left: number, width: number, top = 300, height = 44) => ({
  left, right: left + width, top, bottom: top + height,
});

describe("computeMenuPlacement keeps the menu inside the viewport", () => {
  it.each(WIDTHS)("at %ipx wide, for triggers at the left, middle and right edges", (vw) => {
    const viewport = { width: vw, height: 700 };
    for (const trigger of [box(16, vw - 32), box(16, 176), box(vw - 16 - 176, 176), box(vw / 2 - 88, 176)]) {
      for (const contentWidth of [100, 176, 600, 5000]) {
        const p = computeMenuPlacement({ trigger, contentWidth, contentHeight: 200, viewport });
        expect(p.left).toBeGreaterThanOrEqual(16);
        expect(p.left + p.width).toBeLessThanOrEqual(vw - 16);
        expect(p.top).toBeGreaterThanOrEqual(16);
        expect(p.top + Math.min(200, p.maxHeight)).toBeLessThanOrEqual(700 - 16);
      }
    }
  });

  it("aligns to the trigger's right edge when left alignment would cross the right edge", () => {
    const p = computeMenuPlacement({
      trigger: box(200, 120), contentWidth: 250, contentHeight: 100, viewport: { width: 320, height: 700 },
    });
    expect(p.left + p.width).toBe(320 - 16);
  });

  it("never exceeds the viewport width for a very long label", () => {
    const p = computeMenuPlacement({
      trigger: box(16, 176), contentWidth: 9999, contentHeight: 100, viewport: { width: 320, height: 700 },
    });
    expect(p.width).toBe(320 - 32);
  });

  it("opens above when there is no room below, and scrolls when neither side fits", () => {
    const above = computeMenuPlacement({
      trigger: box(16, 176, 620), contentWidth: 176, contentHeight: 200, viewport: { width: 390, height: 700 },
    });
    expect(above.side).toBe("above");
    expect(above.top + 200).toBeLessThanOrEqual(620);
    const tiny = computeMenuPlacement({
      trigger: box(16, 176, 100), contentWidth: 176, contentHeight: 900, viewport: { width: 390, height: 300 },
    });
    expect(tiny.maxHeight).toBeLessThan(900);
  });
});

function Harness({ onChange = () => {} }: { onChange?: (v: Timeframe) => void }) {
  return <Dropdown label="Timeframe" value="all" options={TIMEFRAME_OPTIONS} onChange={onChange} />;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Dropdown", () => {
  it("shows the current value and every timeframe option, in a portal outside the card", () => {
    const { container } = render(<Harness />);
    const trigger = screen.getByRole("combobox", { name: "Timeframe" });
    expect(trigger.textContent).toContain("All time");
    fireEvent.click(trigger);
    const list = screen.getByRole("listbox");
    expect(list.parentElement).toBe(document.body);
    expect(container.contains(list)).toBe(false);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(
      TIMEFRAME_OPTIONS.map((o) => o.label),
    );
  });

  it("positions the opened menu inside a 320px viewport", () => {
    Object.defineProperty(document.documentElement, "clientWidth", { value: 320, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 700, configurable: true });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      { ...box(150, 170), x: 150, y: 300, width: 170, height: 44, toJSON() {} } as DOMRect,
    );
    render(<Harness />);
    fireEvent.click(screen.getByRole("combobox"));
    const menu = screen.getByRole("listbox");
    const left = parseFloat(menu.style.left);
    const width = parseFloat(menu.style.width);
    expect(left).toBeGreaterThanOrEqual(16);
    expect(left + width).toBeLessThanOrEqual(320 - 16);
    expect(menu.style.visibility).toBe("visible");
  });

  it("selects with click and closes", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "This week" }));
    expect(onChange).toHaveBeenCalledWith("week");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("supports the keyboard: arrows, Enter, Escape", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const trigger = screen.getByRole("combobox");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("today");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
