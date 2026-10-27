import { findGroup } from "./class-tree";
import type { ClassItem, GroupNode } from "./types";

/**
 * Validation and immutable updates for classes and subgroups. The data provider
 * routes every mutation through these functions, so the rules hold no matter
 * which UI path (or future code path) triggers a change.
 */

export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** Trims and collapses internal whitespace runs, so "Math  101 " equals "Math 101". */
export const normalizeName = (name: string) => name.trim().replace(/\s+/g, " ");

/** Comparison key: case-insensitive on the normalized name. */
export const nameKey = (name: string) => normalizeName(name).toLocaleLowerCase();

export const MAX_NAME_LENGTH = 60;

/** Validates a class name; `excludeId` lets a class keep its own name on rename. */
export function validateClassName(
  classes: ClassItem[],
  name: string,
  excludeId?: string,
): Result<string> {
  const clean = normalizeName(name);
  if (!clean) return fail("Enter a class name.");
  if (clean.length > MAX_NAME_LENGTH) return fail(`Use ${MAX_NAME_LENGTH} characters or fewer.`);
  const key = nameKey(clean);
  const clash = classes.find((c) => c.id !== excludeId && nameKey(c.name) === key);
  if (clash) return fail(`A class named “${clash.name}” already exists.`);
  return { ok: true, value: clean };
}

/**
 * Subgroup names are unique within their class only (same normalization as class
 * names). `excludeId` lets a subgroup keep its own name on rename.
 */
export function validateGroupName(
  siblings: GroupNode[],
  name: string,
  excludeId?: string,
): Result<string> {
  const clean = normalizeName(name);
  if (!clean) return fail("Enter a group name.");
  if (clean.length > MAX_NAME_LENGTH) return fail(`Use ${MAX_NAME_LENGTH} characters or fewer.`);
  const key = nameKey(clean);
  const clash = siblings.find((g) => g.id !== excludeId && nameKey(g.name) === key);
  if (clash) return fail(`This class already has a subgroup named “${clash.name}”.`);
  return { ok: true, value: clean };
}

/**
 * Where a new subgroup is being attached. It must be the class itself; a
 * subgroup id is rejected, which is what keeps the structure to one level.
 */
export function validateGroupParent(classes: ClassItem[], classId: string, parentId: string): Result {
  const cls = classes.find((c) => c.id === classId);
  if (!cls) return fail("That class no longer exists.");
  if (parentId === classId) return { ok: true, value: undefined };
  if (findGroup(cls.groups, parentId)) return fail("Subgroups can’t contain other subgroups.");
  return fail("Subgroups must belong directly to a class.");
}

export function createClass(
  classes: ClassItem[],
  name: string,
  id: string,
  color: string,
): Result<ClassItem[]> {
  const v = validateClassName(classes, name);
  if (!v.ok) return v;
  return { ok: true, value: [...classes, { id, name: v.value, color, groups: [] }] };
}

export function renameClassIn(classes: ClassItem[], id: string, name: string): Result<ClassItem[]> {
  if (!classes.some((c) => c.id === id)) return fail("That class no longer exists.");
  const v = validateClassName(classes, name, id);
  if (!v.ok) return v;
  return { ok: true, value: classes.map((c) => (c.id === id ? { ...c, name: v.value } : c)) };
}

/** `parentId` defaults to the class itself; anything else is rejected. */
export function createGroup(
  classes: ClassItem[],
  classId: string,
  name: string,
  id: string,
  parentId: string = classId,
): Result<ClassItem[]> {
  const p = validateGroupParent(classes, classId, parentId);
  if (!p.ok) return p;
  const v = validateGroupName(classes.find((c) => c.id === classId)!.groups, name);
  if (!v.ok) return v;
  const node: GroupNode = { id, name: v.value };
  return {
    ok: true,
    value: classes.map((c) => (c.id === classId ? { ...c, groups: [...c.groups, node] } : c)),
  };
}

export function renameGroupIn(
  classes: ClassItem[],
  classId: string,
  groupId: string,
  name: string,
): Result<ClassItem[]> {
  const cls = classes.find((c) => c.id === classId);
  if (!cls || !findGroup(cls.groups, groupId)) return fail("That group no longer exists.");
  const v = validateGroupName(cls.groups, name, groupId);
  if (!v.ok) return v;
  return {
    ok: true,
    value: classes.map((c) =>
      c.id === classId
        ? { ...c, groups: c.groups.map((g) => (g.id === groupId ? { ...g, name: v.value } : g)) }
        : c,
    ),
  };
}

export function removeGroup(classes: ClassItem[], classId: string, groupId: string): ClassItem[] {
  return classes.map((c) =>
    c.id === classId ? { ...c, groups: c.groups.filter((g) => g.id !== groupId) } : c,
  );
}
