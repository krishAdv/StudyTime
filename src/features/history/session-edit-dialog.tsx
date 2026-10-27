"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialogs";
import { Select } from "@/components/ui/select";
import { useStudyData } from "@/features/data/study-data-provider";
import { findGroup } from "@/lib/class-tree";
import type { Session } from "@/lib/types";
import { formatDuration, timeLabel } from "@/lib/utils";

/** Lets the user correct which class / subgroup a completed session belongs to. */
export function SessionEditDialog({ session, onClose }: { session: Session | null; onClose: () => void }) {
  return (
    <Modal open={session !== null} onClose={onClose} title="Edit session">
      {/* Mounted only while open, so the draft resets for every session. */}
      {session && <EditForm key={session.id} session={session} onClose={onClose} />}
    </Modal>
  );
}

function EditForm({ session, onClose }: { session: Session; onClose: () => void }) {
  const { classes, reassignSession } = useStudyData();

  const origClass = classes.find((c) => c.id === session.classId);
  const origGroup = origClass && session.groupId ? findGroup(origClass.groups, session.groupId) : null;
  const origGroupOk = !!origClass && (session.groupId === null || !!origGroup);

  const [classId, setClassId] = useState(origClass?.id ?? "");
  const [groupId, setGroupId] = useState(origGroupOk ? (session.groupId ?? "") : "");
  const [error, setError] = useState<string | null>(null);

  const selected = classes.find((c) => c.id === classId);
  const changed = classId !== session.classId || (groupId || null) !== session.groupId;
  const canSave = !!selected && (changed || !origGroupOk);

  const onClassChange = (id: string) => {
    setClassId(id);
    // Keep the subgroup only if it belongs to the newly selected class.
    const next = classes.find((c) => c.id === id);
    if (!next || !findGroup(next.groups, groupId)) setGroupId("");
    setError(null);
  };

  const save = () => {
    const r = reassignSession(session.id, classId, groupId || null);
    if (!r.ok) return setError(r.error);
    onClose();
  };

  const start = new Date(session.startedAt);
  return (
    <form
      className="mt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) save();
      }}
    >
      <dl className="grid grid-cols-3 gap-2 rounded-xl bg-muted p-3 text-center text-xs">
        <div>
          <dt className="text-muted-foreground">Date</dt>
          <dd className="mt-0.5 font-medium">
            {start.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Started</dt>
          <dd className="mt-0.5 font-medium">{timeLabel(session.startedAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Duration</dt>
          <dd className="mt-0.5 font-medium tabular-nums">{formatDuration(session.seconds)}</dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">
        Currently: {origClass ? origClass.name : "Unknown class"}
        {session.groupId ? ` › ${origGroup?.name ?? "removed subgroup"}` : ""}
      </p>

      <div className="mt-4 space-y-3">
        <Select label="Class" value={classId} onChange={(e) => onClassChange(e.target.value)}>
          {!selected && <option value="">Select a class…</option>}
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select
          label="Subgroup"
          value={groupId}
          disabled={!selected}
          onChange={(e) => {
            setGroupId(e.target.value);
            setError(null);
          }}
        >
          <option value="">No subgroup</option>
          {selected?.groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </Select>
      </div>

      {!origClass && (
        <p role="alert" className="mt-3 text-xs text-danger">
          This session’s original class is no longer available. Choose a class to keep it in your history.
        </p>
      )}
      {origClass && !origGroupOk && (
        <p className="mt-3 text-xs text-muted-foreground">
          This session’s subgroup no longer exists. Pick another or save with no subgroup.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-danger">
          {error}
        </p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSave}>
          Save
        </Button>
      </div>
    </form>
  );
}
