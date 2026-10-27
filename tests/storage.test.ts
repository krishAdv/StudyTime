import { describe, expect, it } from "vitest";
import { flattenLegacyGroups } from "@/lib/class-tree";
import { DATA_VERSION, parseStoredData } from "@/lib/storage";

const session = (id: string, groupId: string | null) => ({
  id, classId: "cs", groupId, startedAt: 1_000, seconds: 600, mode: "stopwatch",
});

const legacy = JSON.stringify({
  version: DATA_VERSION,
  classes: [
    {
      id: "cs",
      name: "CS",
      color: "#3b82f6",
      groups: [
        {
          id: "algo",
          name: "Algorithms",
          children: [{ id: "graphs", name: "Graphs", children: [{ id: "sp", name: "Shortest Paths", children: [] }] }],
        },
        { id: "proj", name: "Project", children: [] },
      ],
    },
  ],
  sessions: [session("s1", "sp"), session("s2", "graphs"), session("s3", "algo"), session("s4", null)],
});

describe("legacy nested group migration", () => {
  it("flattens to one level, keeping every id and session reference", () => {
    const parsed = parseStoredData(legacy)!;
    expect(parsed.flattened).toBe(true);
    const [cs] = parsed.classes;
    expect(cs.groups.map((g) => g.id)).toEqual(["algo", "graphs", "sp", "proj"]);
    expect(cs.groups.map((g) => g.name)).toEqual([
      "Algorithms",
      "Algorithms › Graphs",
      "Algorithms › Graphs › Shortest Paths",
      "Project",
    ]);
    // No group has children any more.
    expect(cs.groups.every((g) => !("children" in g))).toBe(true);
    // Every session still points at an existing group (or none).
    const ids = new Set(cs.groups.map((g) => g.id));
    expect(parsed.sessions).toHaveLength(4);
    for (const s of parsed.sessions) expect(s.groupId === null || ids.has(s.groupId)).toBe(true);
  });

  it("is idempotent and does not flag already-flat data", () => {
    const once = parseStoredData(legacy)!;
    const again = parseStoredData(JSON.stringify({ version: DATA_VERSION, ...once }))!;
    expect(again.flattened).toBe(false);
    expect(again.classes).toEqual(once.classes);
  });

  it("treats the old shape with only empty children arrays as unchanged data", () => {
    const flat = flattenLegacyGroups([{ id: "a", name: "A", children: [] }]);
    expect(flat).toEqual({ groups: [{ id: "a", name: "A" }], changed: false });
  });

  it("does not rename or drop existing classes, even with duplicate names", () => {
    const raw = JSON.stringify({
      version: DATA_VERSION,
      classes: [
        { id: "1", name: "Math", color: "#000", groups: [] },
        { id: "2", name: "math", color: "#000", groups: [] },
      ],
      sessions: [],
    });
    expect(parseStoredData(raw)!.classes.map((c) => c.name)).toEqual(["Math", "math"]);
  });
});
