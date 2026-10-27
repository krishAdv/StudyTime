import { describe, expect, it } from "vitest";
import { createGroup, renameGroupIn, validateGroupName } from "@/lib/class-rules";
import type { ClassItem } from "@/lib/types";

const math: ClassItem = {
  id: "math",
  name: "Math",
  color: "#000",
  groups: [
    { id: "m1", name: "Unit 1" },
    { id: "m2", name: "Unit 2" },
  ],
};
const science: ClassItem = { id: "sci", name: "Science", color: "#111", groups: [] };
const classes = [math, science];

describe("subgroup names are unique within a class", () => {
  it("allows a new distinct name", () => {
    const r = createGroup(classes, "math", "Unit 3", "m3");
    expect(r.ok && r.value[0].groups.map((g) => g.name)).toEqual(["Unit 1", "Unit 2", "Unit 3"]);
  });

  it("rejects case differences", () => {
    for (const name of ["unit 1", "UNIT 1", "uNiT 1"]) {
      expect(createGroup(classes, "math", name, "x").ok).toBe(false);
    }
  });

  it("rejects whitespace variants (trim and collapse)", () => {
    for (const name of [" Unit   1 ", "Unit 1   ", "  unit\t1"]) {
      const r = createGroup(classes, "math", name, "x");
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain("Unit 1");
    }
  });

  it("still rejects empty names", () => {
    expect(validateGroupName(math.groups, "   ").ok).toBe(false);
  });

  it("allows the same name in a different class", () => {
    const r = createGroup(classes, "sci", "Unit 1", "s1");
    expect(r.ok && r.value[1].groups.map((g) => g.name)).toEqual(["Unit 1"]);
    expect(createGroup(classes, "sci", "unit 1", "s2").ok).toBe(true);
  });

  it("a rejected create leaves the class unchanged", () => {
    createGroup(classes, "math", "unit 1", "x");
    expect(math.groups).toHaveLength(2);
  });
});

describe("renaming a subgroup", () => {
  it("lets it keep its own name or change only its capitalization/spacing", () => {
    expect(renameGroupIn(classes, "math", "m1", "Unit 1").ok).toBe(true);
    const r = renameGroupIn(classes, "math", "m1", "  UNIT  1 ");
    expect(r.ok && r.value[0].groups[0].name).toBe("UNIT 1");
  });

  it("rejects another sibling's name in any casing", () => {
    expect(renameGroupIn(classes, "math", "m1", "unit 2").ok).toBe(false);
    expect(renameGroupIn(classes, "math", "m2", " UNIT   1").ok).toBe(false);
  });

  it("allows a name that exists only in another class", () => {
    const withSci = [math, { ...science, groups: [{ id: "s1", name: "Lab" }] }];
    expect(renameGroupIn(withSci, "math", "m1", "lab").ok).toBe(true);
  });

  it("allows a genuinely new name", () => {
    const r = renameGroupIn(classes, "math", "m2", "Midterm");
    expect(r.ok && r.value[0].groups.map((g) => g.name)).toEqual(["Unit 1", "Midterm"]);
  });
});
