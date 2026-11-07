import { describe, expect, it } from "vitest";
import {
  CLASS_COLOR_OPTIONS, CLASS_COLORS, colorName, contrastingInk, defaultClassColor, isClassColor, normalizeStoredColor,
} from "@/lib/class-colors";
import { createClass, renameClassIn, updateClassIn, validateClassColor } from "@/lib/class-rules";
import { parseExport, serializeExport } from "@/lib/data-export";
import { DATA_VERSION, parseStoredData, serializeData } from "@/lib/storage";
import { checkSyncEligibility } from "@/lib/sync/eligibility";
import type { ClassItem } from "@/lib/types";

const math: ClassItem = { id: "math", name: "Math", color: "#3b82f6", groups: [{ id: "u1", name: "Unit 1" }] };
const art: ClassItem = { id: "art", name: "Art", color: "#8b5cf6", groups: [] };

describe("preset palette", () => {
  it("has unique, valid #rrggbb colors with names", () => {
    expect(new Set(CLASS_COLORS).size).toBe(CLASS_COLORS.length);
    for (const o of CLASS_COLOR_OPTIONS) {
      expect(isClassColor(o.value)).toBe(true);
      expect(o.value).toBe(o.value.toLowerCase());
      expect(o.name).toBeTruthy();
    }
  });

  it("starts with the six colors the app assigned automatically before, in the same order", () => {
    expect(CLASS_COLORS.slice(0, 6)).toEqual(["#3b82f6", "#8b5cf6", "#f59e0b", "#10b981", "#ec4899", "#14b8a6"]);
  });

  it("names presets case-insensitively and returns null for other colors", () => {
    expect(colorName("#3B82F6")).toBe("Blue");
    expect(colorName("#123456")).toBeNull();
  });

  it("picks a readable check-mark color for every preset", () => {
    expect(contrastingInk("#000000")).toBe("#ffffff");
    expect(contrastingInk("#ffffff")).toBe("#000000");
    expect(contrastingInk("#f59e0b")).toBe("#000000"); // amber is light: a white check would be hard to see
    expect(contrastingInk("#64748b")).toBe("#ffffff");
    // Every preset's check mark meets the WCAG 3:1 minimum for icons.
    const lum = (hex: string) => {
      const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    };
    for (const c of CLASS_COLORS) {
      const [a, b] = [lum(c), lum(contrastingInk(c))].sort((x, y) => y - x);
      expect((a + 0.05) / (b + 0.05)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("default color for a new class", () => {
  it("is the first preset no class uses yet", () => {
    expect(defaultClassColor([])).toBe(CLASS_COLORS[0]);
    expect(defaultClassColor([math])).toBe(CLASS_COLORS[1]);
    expect(defaultClassColor([art])).toBe(CLASS_COLORS[0]);
    expect(defaultClassColor([{ color: "#3B82F6" }])).toBe(CLASS_COLORS[1]); // case doesn't matter
  });

  it("cycles through presets once all are used", () => {
    const all = CLASS_COLORS.map((color) => ({ color }));
    expect(defaultClassColor(all)).toBe(CLASS_COLORS[0]);
    expect(defaultClassColor([...all, { color: "#000000" }])).toBe(CLASS_COLORS[1]);
  });
});

describe("class color rules", () => {
  it("accepts only #rrggbb", () => {
    for (const ok of ["#3b82f6", "#ABCDEF"]) expect(validateClassColor(ok).ok).toBe(true);
    for (const bad of ["", "red", "#abc", "3b82f6", "#3b82f6 ", "#ggg000", "#3b82f6ff"]) expect(validateClassColor(bad).ok).toBe(false);
  });

  it("createClass stores the chosen color and rejects an invalid one", () => {
    const r = createClass([math], "Bio", "bio", "#ef4444");
    expect(r.ok && r.value.at(-1)).toEqual({ id: "bio", name: "Bio", color: "#ef4444", groups: [] });
    expect(createClass([math], "Bio", "bio", "red")).toEqual({ ok: false, error: "Choose a valid color." });
  });

  it("updateClassIn changes the color alone and keeps name, id and subgroups", () => {
    const r = updateClassIn([math, art], "math", { color: "#10b981" });
    expect(r.ok && r.value).toEqual([{ ...math, color: "#10b981" }, art]);
  });

  it("updateClassIn changes name and color together", () => {
    const r = updateClassIn([math, art], "math", { name: "  Algebra ", color: "#10b981" });
    expect(r.ok && r.value[0]).toEqual({ ...math, name: "Algebra", color: "#10b981" });
  });

  it("updateClassIn changes nothing when either field is rejected", () => {
    const classes = [math, art];
    expect(updateClassIn(classes, "math", { name: "art", color: "#10b981" }).ok).toBe(false);
    expect(updateClassIn(classes, "math", { name: "Algebra", color: "green" }).ok).toBe(false);
    expect(updateClassIn(classes, "gone", { color: "#10b981" })).toEqual({ ok: false, error: "That class no longer exists." });
    expect(classes).toEqual([math, art]);
  });

  it("an unchanged edit returns the same array (nothing to save or sync)", () => {
    const classes = [math, art];
    const r = updateClassIn(classes, "math", { name: "Math", color: "#3b82f6" });
    expect(r.ok && r.value).toBe(classes);
  });

  it("renaming keeps the color", () => {
    const r = renameClassIn([math], "math", "Algebra");
    expect(r.ok && r.value[0].color).toBe("#3b82f6");
  });
});

describe("stored data (localStorage)", () => {
  const payload = (classes: unknown[]) => JSON.stringify({ version: DATA_VERSION, classes, sessions: [] });

  it("keeps a saved color exactly", () => {
    const d = parseStoredData(payload([{ ...math, color: "#ABCDEF" }]))!;
    expect(d.classes[0].color).toBe("#ABCDEF");
  });

  it("gives classes without a color the preset for their position", () => {
    const d = parseStoredData(payload([{ id: "a", name: "A", groups: [] }, { id: "b", name: "B", groups: [] }]))!;
    expect(d.classes.map((c) => c.color)).toEqual([CLASS_COLORS[0], CLASS_COLORS[1]]);
  });

  it("expands #rgb and replaces unusable colors so the data stays valid for export and sync", () => {
    expect(normalizeStoredColor("#AbC", 0)).toBe("#aabbcc");
    const d = parseStoredData(payload([
      { id: "a", name: "A", color: "#000", groups: [] },
      { id: "b", name: "B", color: "red", groups: [] },
      { id: "c", name: "C", color: 42, groups: [] },
    ]))!;
    expect(d.classes.map((c) => c.color)).toEqual(["#000000", CLASS_COLORS[1], CLASS_COLORS[2]]);
    expect(checkSyncEligibility(d).ok).toBe(true);
  });

  it("round-trips a chosen color through save and load", () => {
    const data = { classes: [{ ...math, color: "#f97316" }], sessions: [] };
    expect(parseStoredData(serializeData(data))!.classes).toEqual(data.classes);
  });
});

describe("backup export / import", () => {
  it("round-trips every class color", () => {
    const data = { classes: [{ ...math, color: "#64748b" }, { ...art, color: "#0EA5E9" }], sessions: [] };
    const r = parseExport(serializeExport(data));
    expect(r.ok && r.value.classes.map((c) => c.color)).toEqual(["#64748b", "#0EA5E9"]);
  });

  it("rejects a backup with an invalid class color", () => {
    const text = serializeExport({ classes: [math], sessions: [] }).replace("#3b82f6", "blue");
    expect(parseExport(text).ok).toBe(false);
  });
});
