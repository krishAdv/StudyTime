import type { SyncSnapshot } from "@/lib/sync/snapshot";
import { cls, grp } from "./sync-plan-harness";
import { addSession, delClass, delGroup, edited, find, move, renameClass, renameGroup } from "./merge-fixtures";

/**
 * Conflicts built from the shared `merge-fixtures` scenario with ordinary ids. Their decision-point fingerprints are
 * pinned in `sync-decisions-ids.test.ts`: the values were recorded from the code BEFORE the prototype-safety fix to
 * `contextFor`, so that test proves ordinary ids still hash exactly as they did. A change to the fingerprint format
 * must use a new version prefix (`sf2:`) instead of changing these.
 */
export type GoldenCase = { name: string; local: SyncSnapshot; remote: SyncSnapshot };

export const goldenCases = (): GoldenCase[] => [
  { name: "field", local: edited(renameClass("A", "Maths")), remote: edited(renameClass("A", "Calculus")) },
  { name: "class edited vs deleted", local: edited(renameClass("B", "Drawing")), remote: edited(delClass("B")) },
  { name: "group edited vs deleted", local: edited(renameGroup("g1", "First")), remote: edited(delGroup("g1")) },
  {
    name: "class cluster",
    local: edited(addSession("x1", "B"), (d) => d.groups.push(grp("g9", "B", "New")), renameGroup("g3", "Paint")),
    remote: edited(delClass("B")),
  },
  { name: "move", local: edited(move("s2", "A", "g2")), remote: edited(move("s2", "B", null)) },
  {
    name: "name collision",
    local: edited((d) => d.classes.push(cls("C1", "Bio"))),
    remote: edited((d) => d.classes.push(cls("C2", "bio"))),
  },
  { name: "group cluster", local: edited(addSession("x1", "A", "g1"), move("s2", "A", "g1")), remote: edited(delGroup("g1")) },
  { name: "session removal", local: edited((d) => (d.sessions = d.sessions.filter((s) => s.id !== "s2"))), remote: edited() },
  { name: "group class mismatch", local: edited((d) => (find.grp(d, "g2").classId = "B")), remote: edited(move("s2", "A", "g2")) },
];
