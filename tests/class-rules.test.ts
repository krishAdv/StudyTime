import { describe, expect, it } from "vitest";
import {
  createClass, createGroup, renameClassIn, renameGroupIn, validateClassName, validateGroupParent,
} from "@/lib/class-rules";
import type { ClassItem } from "@/lib/types";

const math: ClassItem = {
  id: "c-math",
  name: "Math",
  color: "#000",
  groups: [{ id: "g-u1", name: "Unit 1" }],
};
const art: ClassItem = { id: "c-art", name: "Art", color: "#111", groups: [] };
const classes = [math, art];

describe("class name uniqueness", () => {
  it("rejects case-insensitive duplicates", () => {
    for (const name of ["Math", "math", "MATH", "mAtH"]) {
      const r = validateClassName(classes, name);
      expect(r.ok).toBe(false);
    }
  });

  it("trims whitespace before validating and saving", () => {
    expect(validateClassName(classes, "   math  ").ok).toBe(false);
    const r = createClass(classes, "  History  ", "c-hist", "#222");
    expect(r.ok && r.value.at(-1)?.name).toBe("History");
  });

  it("collapses inner whitespace so spacing can't dodge the rule", () => {
    const r = createClass([{ ...art, name: "Intro to Art" }], "intro   TO art", "x", "#222");
    expect(r.ok).toBe(false);
  });

  it("rejects empty and whitespace-only names", () => {
    expect(validateClassName(classes, "").ok).toBe(false);
    expect(validateClassName(classes, "   \t ").ok).toBe(false);
  });

  it("shows which class is in the way", () => {
    const r = validateClassName(classes, "MATH");
    expect(!r.ok && r.error).toContain("Math");
  });

  it("createClass leaves existing classes untouched on rejection", () => {
    const r = createClass(classes, "math", "dup", "#333");
    expect(r.ok).toBe(false);
    expect(classes).toHaveLength(2);
  });
});

describe("renaming a class", () => {
  it("rejects another class's name in any casing", () => {
    expect(renameClassIn(classes, "c-art", "MATH").ok).toBe(false);
    expect(renameClassIn(classes, "c-art", " math ").ok).toBe(false);
  });

  it("lets a class keep its own name, or change only its capitalization", () => {
    expect(renameClassIn(classes, "c-math", "Math").ok).toBe(true);
    const r = renameClassIn(classes, "c-math", "  MATH ");
    expect(r.ok && r.value.find((c) => c.id === "c-math")?.name).toBe("MATH");
  });

  it("allows a genuinely new name", () => {
    const r = renameClassIn(classes, "c-art", "Painting");
    expect(r.ok && r.value.map((c) => c.name)).toEqual(["Math", "Painting"]);
  });

  it("rejects an empty rename", () => {
    expect(renameClassIn(classes, "c-art", "  ").ok).toBe(false);
  });
});

describe("one-level subgroups", () => {
  it("adds a subgroup directly under a class, trimmed", () => {
    const r = createGroup(classes, "c-math", "  Unit 2 ", "g-u2");
    expect(r.ok && r.value[0].groups.map((g) => g.name)).toEqual(["Unit 1", "Unit 2"]);
  });

  it("allows any number of subgroups", () => {
    let cur = classes;
    for (let i = 0; i < 25; i++) {
      const r = createGroup(cur, "c-art", `Part ${i}`, `g-${i}`);
      if (!r.ok) throw new Error(r.error);
      cur = r.value;
    }
    expect(cur[1].groups).toHaveLength(25);
  });

  it("rejects creating a subgroup under another subgroup", () => {
    const r = createGroup(classes, "c-math", "Unit 1.1", "g-x", "g-u1");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/can.t contain other subgroups/);
    expect(math.groups).toHaveLength(1);
  });

  it("rejects an unknown parent and an unknown class", () => {
    expect(validateGroupParent(classes, "c-math", "nope").ok).toBe(false);
    expect(validateGroupParent(classes, "missing", "missing").ok).toBe(false);
  });

  it("rejects empty subgroup names and renames", () => {
    expect(createGroup(classes, "c-math", "  ", "g-x").ok).toBe(false);
    expect(renameGroupIn(classes, "c-math", "g-u1", "").ok).toBe(false);
    const r = renameGroupIn(classes, "c-math", "g-u1", " Algebra ");
    expect(r.ok && r.value[0].groups[0].name).toBe("Algebra");
  });
});
