import type { GroupNode } from "./types";

/**
 * Helpers for the class → subgroup structure (one level only).
 * Pure functions with no React or storage dependency, so the same rules can be
 * mirrored in a database constraint later (a group row references a class row,
 * never another group row).
 */

export const NESTING_SEPARATOR = " › ";

export function findGroup(groups: GroupNode[], id: string): GroupNode | null {
  return groups.find((g) => g.id === id) ?? null;
}

export function groupLabel(groups: GroupNode[], id: string | null): string | null {
  if (!id) return null;
  return findGroup(groups, id)?.name ?? null;
}

type LegacyNode = { id: string; name: string; children?: unknown };

/**
 * Flattens any legacy deeper nesting into a single level without losing data.
 * Every node keeps its id (so session references stay valid) and a node that
 * used to be nested is lifted to the class level, placed right after its former
 * parent, and named "Parent › Child" so its context is not lost.
 * `changed` is true only when real nesting was found (not for a bare empty
 * `children` array). Idempotent: flat input comes back unchanged.
 */
export function flattenLegacyGroups(raw: LegacyNode[]): { groups: GroupNode[]; changed: boolean } {
  const groups: GroupNode[] = [];
  let changed = false;
  const visit = (nodes: LegacyNode[], parents: string[]) => {
    for (const node of nodes) {
      const children = Array.isArray(node.children) ? (node.children as LegacyNode[]) : [];
      if (parents.length > 0) changed = true;
      groups.push({ id: node.id, name: [...parents, node.name].join(NESTING_SEPARATOR) });
      visit(children, [...parents, node.name]);
    }
  };
  visit(raw, []);
  return { groups, changed };
}
