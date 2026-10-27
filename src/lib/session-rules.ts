import { findGroup } from "./class-tree";
import type { Result } from "./class-rules";
import type { ClassItem, Session } from "./types";

/**
 * Reassigns a completed session to another class / subgroup. Only `classId` and
 * `groupId` change: the id, start time, duration, mode and any other fields are
 * carried over untouched. `groupId` null means "the class itself, no subgroup".
 */
export function reassignSession(
  classes: ClassItem[],
  sessions: Session[],
  sessionId: string,
  classId: string,
  groupId: string | null,
): Result<Session[]> {
  if (!sessions.some((s) => s.id === sessionId)) return { ok: false, error: "That session no longer exists." };
  const cls = classes.find((c) => c.id === classId);
  if (!cls) return { ok: false, error: "Choose a class for this session." };
  if (groupId !== null && !findGroup(cls.groups, groupId)) {
    return { ok: false, error: "That subgroup doesn’t belong to the selected class." };
  }
  return {
    ok: true,
    value: sessions.map((s) => (s.id === sessionId ? { ...s, classId, groupId } : s)),
  };
}

/**
 * Sessions saved against one subgroup of a class, newest first (same order as
 * History). Class-level sessions (no subgroup) and other subgroups' sessions
 * are never included.
 */
export function sessionsForGroup(sessions: Session[], classId: string, groupId: string): Session[] {
  return sessions
    .filter((s) => s.classId === classId && s.groupId === groupId)
    .sort((a, b) => b.startedAt - a.startedAt);
}
