import type { Decision, DecisionPoint } from "./decisions";
import type { MergeConflict } from "./merge";
import type { SyncSnapshot } from "./snapshot";

/**
 * Turns the decision points of a conflicted sync pass into plain language for the conflict screen: what differs, the
 * choices that can be made, and what each one does to the user's study sessions. Pure, so it is tested without any UI.
 *
 * "This device" is the local data; "the cloud" is what the account holds. A choice that is not available (the app
 * cannot delete a class together with its sessions, or one session) is listed with its reason and never selectable, so
 * no choice here can silently discard study time.
 */

export type ConflictChoice = {
  key: string;
  label: string;
  /** What happens to the data, in a sentence. */
  consequence: string;
  available: boolean;
};

export type ConflictView = {
  fingerprint: string;
  title: string;
  detail: string;
  choices: ConflictChoice[];
  /** `name_collision` only: one text box per involved class or subgroup, started with its current name. */
  renames?: { id: string; label: string; current: string }[];
  /** No choice can be made for it. The user needs "Use cloud" or "Replace cloud" to get past it. */
  blocked: boolean;
};

type Snaps = { base: SyncSnapshot; local: SyncSnapshot; remote: SyncSnapshot };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const SIDES = ["local", "remote", "base"] as const;

function className(snaps: Snaps, id: unknown): string {
  for (const side of SIDES) {
    const c = snaps[side].classes.find((x) => x.id === id);
    if (c) return c.name;
  }
  return "a class";
}

function groupName(snaps: Snaps, id: unknown): string {
  for (const side of SIDES) {
    const g = snaps[side].groups.find((x) => x.id === id);
    if (g) return g.name;
  }
  return "a subgroup";
}

function placement(snaps: Snaps, p: unknown): string {
  if (typeof p !== "object" || p === null) return "somewhere";
  const { classId, groupId } = p as { classId?: unknown; groupId?: unknown };
  const c = className(snaps, classId);
  return typeof groupId === "string" ? `${c} › ${groupName(snaps, groupId)}` : c;
}

function sessionText(snaps: Snaps, id: string): string {
  for (const side of SIDES) {
    const s = snaps[side].sessions.find((x) => x.id === id);
    if (s) {
      const date = new Date(s.startedAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
      return `the ${Math.max(1, Math.round(s.seconds / 60))}-minute session on ${date}`;
    }
  }
  return "a session";
}

const present = (list: { id: string }[], id: string) => list.some((x) => x.id === id);

/** Which side removed the class or subgroup `id`: the one that no longer has it. */
function deletedOn(snaps: Snaps, entity: "class" | "group", id: string): { gone: string; kept: string } {
  const list = (s: SyncSnapshot) => (entity === "class" ? s.classes : s.groups);
  return present(list(snaps.local), id) ? { gone: "the cloud", kept: "this device" } : { gone: "this device", kept: "the cloud" };
}

export function describeConflicts(points: DecisionPoint[], conflicts: MergeConflict[], snaps: Snaps): ConflictView[] {
  return points.map((point) => describeOne(point, conflicts, snaps));
}

function describeOne(point: DecisionPoint, conflicts: MergeConflict[], snaps: Snaps): ConflictView {
  const members = point.members.map((i) => conflicts[i]).filter(Boolean);
  const first = members[0];
  const reason = (key: string) => point.choices.find((c) => c.key === key);
  const choice = (key: string, label: string, consequence: string): ConflictChoice => ({ key, label, consequence, available: reason(key)?.unavailable === undefined && reason(key) !== undefined });
  const view = (title: string, detail: string, choices: ConflictChoice[], extra: Partial<ConflictView> = {}): ConflictView => ({
    fingerprint: point.fingerprint,
    title,
    detail,
    choices,
    blocked: !choices.some((c) => c.available),
    ...extra,
  });
  const noun = point.entity === "class" ? "class" : point.entity === "group" ? "subgroup" : "session";

  switch (point.kind) {
    case "field": {
      const field = first?.field;
      if (field === "name") {
        const l = String(first.local);
        const r = String(first.remote);
        return view(`The ${noun} “${String(first.base)}” was renamed on both sides`, `This device calls it “${l}”. The cloud calls it “${r}”.`, [
          choice("keep_local", `Use “${l}”`, `The cloud and your other devices will use “${l}”. Your sessions are not affected.`),
          choice("keep_remote", `Use “${r}”`, `This device will use “${r}”. Your sessions are not affected.`),
        ]);
      }
      if (field === "color") {
        return view(`The color of the class “${className(snaps, first.id)}” was changed on both sides`, "This device and the cloud picked different colors.", [
          choice("keep_local", "Use this device’s color", "The cloud and your other devices will use it."),
          choice("keep_remote", "Use the cloud’s color", "This device will use it."),
        ]);
      }
      const l = placement(snaps, { classId: first?.local });
      const r = placement(snaps, { classId: first?.remote });
      return view(`The subgroup “${groupName(snaps, first?.id)}” was moved to different classes`, `This device put it in “${l}”. The cloud put it in “${r}”.`, [
        choice("keep_local", `Keep it in “${l}”`, "Its sessions go with it."),
        choice("keep_remote", `Keep it in “${r}”`, "Its sessions go with it."),
      ]);
    }

    case "move": {
      const l = placement(snaps, first?.local);
      const r = placement(snaps, first?.remote);
      return view(`${sessionText(snaps, point.id)[0].toUpperCase()}${sessionText(snaps, point.id).slice(1)} was put in different places`, `This device filed it under “${l}”. The cloud filed it under “${r}”.`, [
        choice("keep_local", `File it under “${l}”`, "The session is kept; only where it is filed changes."),
        choice("keep_remote", `File it under “${r}”`, "The session is kept; only where it is filed changes."),
      ]);
    }

    case "add_mismatch":
      return view(`This device and the cloud created a different ${noun} with the same internal id`, "This is rare. They have different contents.", [
        choice("keep_local", "Use this device’s version", "The cloud and your other devices will use it."),
        choice("keep_remote", "Use the cloud’s version", "This device will use it."),
      ]);

    case "name_collision": {
      const scope = point.entity === "class" ? "classes" : "subgroups";
      return view(`Two ${scope} would end up with the same name`, first?.message ?? "After combining, two names are the same. Give each a different name.", [
        choice("rename", "Rename them", "Nothing is deleted; only the names change."),
      ], {
        renames: point.ids
          .filter((id) => (point.entity === "class" ? present(snaps.local.classes, id) || present(snaps.remote.classes, id) : present(snaps.local.groups, id) || present(snaps.remote.groups, id)))
          .map((id) => {
            const current = point.entity === "class" ? className(snaps, id) : groupName(snaps, id);
            return { id, label: `Name for “${current}”`, current };
          }),
      });
    }

    case "class_deleted": {
      const { gone, kept } = deletedOn(snaps, "class", point.id);
      const sessions = snaps.local.sessions.filter((s) => s.classId === point.id).length + snaps.remote.sessions.filter((s) => s.classId === point.id && !present(snaps.local.sessions, s.id)).length;
      const name = className(snaps, point.id);
      return view(`The class “${name}” was deleted on ${gone}, but changed on ${kept}`, `${kept[0].toUpperCase()}${kept.slice(1)} still has it with ${plural(sessions, "session")}, some added or changed since.`, [
        choice("keep_class", `Keep “${name}” and all its sessions`, `The class comes back on ${gone}, with everything ${kept} holds.`),
        choice("delete_class", `Delete “${name}” and its ${plural(sessions, "session")}`, "Not offered: it would erase study sessions."),
      ]);
    }

    case "group_deleted": {
      const { gone, kept } = deletedOn(snaps, "group", point.id);
      const name = groupName(snaps, point.id);
      return view(`The subgroup “${name}” was deleted on ${gone}, but changed on ${kept}`, `${kept[0].toUpperCase()}${kept.slice(1)} added or moved sessions in it.`, [
        choice("keep_group", `Keep “${name}”`, `The subgroup comes back on ${gone}, with its sessions.`),
        choice("ungroup", `Remove “${name}”, keep its sessions`, "Its sessions stay in the class with no subgroup. No session is deleted."),
      ]);
    }

    case "group_class_mismatch":
      return view(`${sessionText(snaps, point.id)[0].toUpperCase()}${sessionText(snaps, point.id).slice(1)} ended up in the wrong subgroup`, "Its subgroup belongs to a different class after combining.", [
        choice("ungroup_session", "Keep the session in its class, without a subgroup", "The session is kept."),
      ]);

    case "session_removal":
      return view("A study session is missing on one side", "A session can only disappear together with its class, so this can’t be settled one session at a time.", [
        choice("restore", "Bring the session back", "Not offered yet."),
        choice("remove", "Remove the session", "Not offered: it would erase a study session."),
      ]);
  }
}

/** One screen choice, as the decision the engine takes. */
export function toDecision(view: ConflictView, key: string, names?: Record<string, string>): Decision {
  return names ? { fingerprint: view.fingerprint, choice: key, names } : { fingerprint: view.fingerprint, choice: key };
}

/** Conflicts that are not decisions (a running timer's class would be deleted): they settle once the timer stops. */
export function notDecisions(conflicts: MergeConflict[], points: DecisionPoint[]): MergeConflict[] {
  const covered = new Set(points.flatMap((p) => p.members));
  return conflicts.filter((_, i) => !covered.has(i));
}
