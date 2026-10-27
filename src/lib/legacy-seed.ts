import { flattenLegacyGroups } from "./class-tree";
import type { ClassItem, GroupNode, Session, TimerMode } from "./types";

/**
 * The sample data that earlier versions of StudyTime inserted on first run.
 * It is NOT loaded for anyone any more. It exists only so the one-time
 * version 1 → 2 migration can recognise untouched sample records exactly,
 * without guessing from names.
 */

type LegacyNode = { id: string; name: string; children?: LegacyNode[] };
type SeedClass = { id: string; name: string; colorIndex: number; groups: LegacyNode[] };

const SEED_CLASSES: SeedClass[] = [
  {
    id: "cs",
    name: "Computer Science",
    colorIndex: 0,
    groups: [
      {
        id: "cs-algo",
        name: "Algorithms",
        children: [
          { id: "cs-graphs", name: "Graphs", children: [{ id: "cs-sp", name: "Shortest Paths" }] },
          { id: "cs-dp", name: "Dynamic Programming" },
        ],
      },
      { id: "cs-os", name: "Operating Systems", children: [{ id: "cs-sched", name: "Scheduling" }] },
      { id: "cs-proj", name: "Final Project" },
    ],
  },
  {
    id: "math",
    name: "Mathematics",
    colorIndex: 1,
    groups: [
      { id: "math-la", name: "Linear Algebra", children: [{ id: "math-eig", name: "Eigenvalues" }] },
      { id: "math-vc", name: "Vector Calculus" },
    ],
  },
  {
    id: "hist",
    name: "History",
    colorIndex: 2,
    groups: [
      {
        id: "hist-eu",
        name: "Modern Europe",
        children: [
          { id: "hist-essay", name: "Essay Draft" },
          { id: "hist-notes", name: "Reading Notes" },
        ],
      },
      { id: "hist-rome", name: "Ancient Rome" },
    ],
  },
];

// Same palette the sample classes were given.
const COLORS = ["#3b82f6", "#8b5cf6", "#f59e0b", "#10b981", "#ec4899", "#14b8a6"];

/** [classId, groupId, minutes, mode] in the order the sample sessions were generated (id `seed-<index>`). */
const SEED_SESSIONS: [string, string | null, number, TimerMode][] = [
  ["cs", "cs-graphs", 25, "countdown"],
  ["cs", "cs-sp", 25, "countdown"],
  ["math", "math-eig", 40, "countdown"],
  ["hist", "hist-essay", 55, "stopwatch"],
  ["math", "math-la", 30, "countdown"],
  ["cs", "cs-dp", 50, "stopwatch"],
  ["hist", "hist-notes", 25, "countdown"],
  ["cs", "cs-os", 75, "stopwatch"],
  ["math", "math-vc", 45, "countdown"],
  ["hist", null, 35, "stopwatch"],
  ["cs", "cs-proj", 60, "stopwatch"],
  ["math", "math-la", 40, "countdown"],
  ["cs", "cs-algo", 90, "stopwatch"],
  ["hist", "hist-rome", 25, "countdown"],
  ["math", null, 50, "countdown"],
];

/** Group lists a pristine sample class can have: the original nested form (flattened on load) or the one-level form. */
function pristineGroupVariants(c: SeedClass): GroupNode[][] {
  const flattened = flattenLegacyGroups(c.groups).groups;
  const oneLevel = flattened.map((g) => ({ id: g.id, name: g.name.split(" › ").at(-1)! }));
  return [flattened, oneLevel];
}

const sameGroups = (a: GroupNode[], b: GroupNode[]) =>
  a.length === b.length &&
  [...a].sort((x, y) => x.id.localeCompare(y.id)).every((g, i) => {
    const o = [...b].sort((x, y) => x.id.localeCompare(y.id))[i];
    return g.id === o.id && g.name === o.name;
  });

function isPristineSeedClass(c: ClassItem, seed: SeedClass) {
  return (
    c.name === seed.name &&
    c.color === COLORS[seed.colorIndex] &&
    pristineGroupVariants(seed).some((v) => sameGroups(c.groups, v))
  );
}

/** True only for a record that matches a generated sample session exactly (id, class, group, length, mode). */
export function isSeedSession(s: Session): boolean {
  const m = /^seed-(\d+)$/.exec(s.id);
  const seed = m ? SEED_SESSIONS[Number(m[1])] : undefined;
  return (
    !!seed && s.classId === seed[0] && s.groupId === seed[1] && s.seconds === seed[2] * 60 && s.mode === seed[3]
  );
}

/**
 * Removes sample records that are provably untouched. A sample class is removed
 * (with its sample sessions) only when ALL hold: its id is a sample id, its name,
 * colour and groups still equal the sample exactly, and every session pointing
 * at it is a verified sample session. Anything the user renamed, extended or
 * logged real time against is kept in full, as are all other classes/sessions.
 */
export function removeKnownSeedData<T extends { classes: ClassItem[]; sessions: Session[] }>(
  data: T,
): { data: T; removed: boolean } {
  const doomed = new Set<string>();
  for (const seed of SEED_CLASSES) {
    const cls = data.classes.find((c) => c.id === seed.id);
    if (!cls || !isPristineSeedClass(cls, seed)) continue;
    const touched = data.sessions.some((s) => s.classId === seed.id && !isSeedSession(s));
    if (!touched) doomed.add(seed.id);
  }
  if (doomed.size === 0) return { data, removed: false };
  return {
    removed: true,
    data: {
      ...data,
      classes: data.classes.filter((c) => !doomed.has(c.id)),
      sessions: data.sessions.filter((s) => !doomed.has(s.classId)),
    },
  };
}
