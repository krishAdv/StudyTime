"use client";

import { useState } from "react";
import { ChevronRight, FolderPlus, FolderTree, Info, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, NameDialog } from "@/components/ui/dialogs";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { useStudyData } from "@/features/data/study-data-provider";
import { validateClassName, validateGroupName } from "@/lib/class-rules";
import { findGroup } from "@/lib/class-tree";
import { sessionsForGroup } from "@/lib/session-rules";
import { SubgroupSessions } from "./subgroup-sessions";
import { formatDuration } from "@/lib/utils";

type Dialog =
  | { kind: "newClass" }
  | { kind: "renameClass" }
  | { kind: "deleteClass" }
  | { kind: "newGroup" }
  | { kind: "renameGroup"; id: string }
  | { kind: "deleteGroup"; id: string }
  | null;

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button variant="ghost" size="icon" aria-label={label} onClick={onClick} className="text-muted-foreground">
      {children}
    </Button>
  );
}

export function ClassesView() {
  const data = useStudyData();
  const { classes } = data;

  const [classId, setClassId] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);

  const cls = classes.find((c) => c.id === classId) ?? null;
  // The subgroup being viewed, if any. Subgroups sit directly under a class and have no children.
  const current = cls && groupId ? findGroup(cls.groups, groupId) : null;
  const subgroups = cls?.groups ?? [];

  const openClass = (id: string) => {
    setClassId(id);
    setGroupId(null);
  };

  /* ---------- Class list ---------- */
  if (!cls) {
    return (
      <>
        <PageHeader
          title="Classes"
          description="Organize what you study."
          action={
            <Button onClick={() => setDialog({ kind: "newClass" })}>
              <Plus className="h-4 w-4" aria-hidden /> New class
            </Button>
          }
        />
        {classes.length === 0 ? (
          <EmptyState
            icon={<FolderTree className="h-6 w-6" aria-hidden />}
            title="No classes yet"
            description="Create a class to start organizing your study sessions."
            action={<Button onClick={() => setDialog({ kind: "newClass" })}>Create a class</Button>}
          />
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {classes.map((c) => (
              <li key={c.id} className="flex items-center rounded-2xl border border-border bg-card pr-1">
                <button
                  onClick={() => openClass(c.id)}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl p-4 text-left"
                >
                  <span className="h-10 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: c.color }} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{c.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {formatDuration(data.secondsFor(c.id))} · {c.groups.length}{" "}
                      {c.groups.length === 1 ? "subgroup" : "subgroups"}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}

        <NameDialog
          open={dialog?.kind === "newClass"}
          title="New class"
          label="Class name"
          submitLabel="Create"
          validate={(n) => {
            const v = validateClassName(classes, n);
            return v.ok ? null : v.error;
          }}
          onSubmit={(n) => {
            const r = data.addClass(n);
            return r.ok ? null : r.error;
          }}
          onClose={close}
        />
      </>
    );
  }

  /* ---------- Class / subgroup detail ---------- */
  const title = current?.name ?? cls.name;
  const seconds = data.secondsFor(cls.id, current?.id);

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-4">
        <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          <li>
            <button onClick={() => setClassId(null)} className="rounded-md px-1 py-1.5 hover:text-foreground">
              Classes
            </button>
          </li>
          <Crumb label={cls.name} onClick={current ? () => setGroupId(null) : undefined} />
          {current && <Crumb label={current.name} />}
        </ol>
      </nav>

      <PageHeader
        title={title}
        back={
          current
            ? { label: `Back to ${cls.name}`, onClick: () => setGroupId(null) }
            : { label: "Back to classes", onClick: () => setClassId(null) }
        }
        description={
          current
            ? `${formatDuration(seconds)} studied · Subgroup of ${cls.name}`
            : `${formatDuration(seconds)} studied · ${subgroups.length} ${subgroups.length === 1 ? "subgroup" : "subgroups"}`
        }
        action={
          <div className="flex shrink-0">
            <IconButton
              label={`Rename ${title}`}
              onClick={() => setDialog(current ? { kind: "renameGroup", id: current.id } : { kind: "renameClass" })}
            >
              <Pencil className="h-4 w-4" />
            </IconButton>
            <IconButton
              label={`Delete ${title}`}
              onClick={() => setDialog(current ? { kind: "deleteGroup", id: current.id } : { kind: "deleteClass" })}
            >
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </div>
        }
      />

      {current ? (
        // A subgroup is a leaf: no nested-group controls are offered here.
        <>
          <div className="flex items-start gap-3 rounded-2xl border border-border bg-card p-4 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>Subgroups sit directly under a class and can’t contain other groups.</p>
          </div>
          <SubgroupSessions
            name={current.name}
            cls={cls}
            sessions={sessionsForGroup(data.sessions, cls.id, current.id)}
          />
        </>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Subgroups</h2>
            <Button variant="secondary" onClick={() => setDialog({ kind: "newGroup" })}>
              <FolderPlus className="h-4 w-4" aria-hidden /> Add subgroup
            </Button>
          </div>

          {subgroups.length === 0 ? (
            <EmptyState
              icon={<FolderTree className="h-6 w-6" aria-hidden />}
              title="No subgroups yet"
              description={`Break ${cls.name} into parts, e.g. Unit 1, Unit 2, Unit 3. Subgroups go one level deep.`}
              action={<Button onClick={() => setDialog({ kind: "newGroup" })}>Add a subgroup</Button>}
            />
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
              {subgroups.map((g) => (
                <li key={g.id} className="flex items-center pr-1">
                  <button
                    onClick={() => setGroupId(g.id)}
                    className="flex min-w-0 flex-1 items-center gap-3 p-4 text-left"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{g.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {formatDuration(data.secondsFor(cls.id, g.id))}
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  </button>
                  <IconButton label={`Rename ${g.name}`} onClick={() => setDialog({ kind: "renameGroup", id: g.id })}>
                    <Pencil className="h-4 w-4" />
                  </IconButton>
                  <IconButton label={`Delete ${g.name}`} onClick={() => setDialog({ kind: "deleteGroup", id: g.id })}>
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <NameDialog
        open={dialog?.kind === "newGroup"}
        title={`New subgroup in ${cls.name}`}
        label="Subgroup name"
        submitLabel="Add"
        validate={(n) => {
          const v = validateGroupName(cls.groups, n);
          return v.ok ? null : v.error;
        }}
        onSubmit={(name) => {
          const r = data.addGroup(cls.id, name);
          return r.ok ? null : r.error;
        }}
        onClose={close}
      />
      <NameDialog
        open={dialog?.kind === "renameClass"}
        title="Rename class"
        label="Class name"
        initial={cls.name}
        submitLabel="Save"
        validate={(n) => {
          const v = validateClassName(classes, n, cls.id);
          return v.ok ? null : v.error;
        }}
        onSubmit={(name) => {
          const r = data.renameClass(cls.id, name);
          return r.ok ? null : r.error;
        }}
        onClose={close}
      />
      <NameDialog
        open={dialog?.kind === "renameGroup"}
        title="Rename subgroup"
        label="Subgroup name"
        initial={dialog?.kind === "renameGroup" ? (findGroup(cls.groups, dialog.id)?.name ?? "") : ""}
        submitLabel="Save"
        validate={(n) => {
          const v = validateGroupName(cls.groups, n, dialog?.kind === "renameGroup" ? dialog.id : undefined);
          return v.ok ? null : v.error;
        }}
        onSubmit={(name) => {
          if (dialog?.kind !== "renameGroup") return null;
          const r = data.renameGroup(cls.id, dialog.id, name);
          return r.ok ? null : r.error;
        }}
        onClose={close}
      />
      <ConfirmDialog
        open={dialog?.kind === "deleteClass"}
        title={`Delete ${cls.name}?`}
        description="This removes the class, all of its subgroups, and its sessions from History. This can’t be undone."
        confirmLabel="Delete class"
        onConfirm={() => {
          data.deleteClass(cls.id);
          setClassId(null);
        }}
        onClose={close}
      />
      <ConfirmDialog
        open={dialog?.kind === "deleteGroup"}
        title="Delete this subgroup?"
        description="The subgroup will be removed. Past sessions stay in History under the class."
        confirmLabel="Delete subgroup"
        onConfirm={() => {
          if (dialog?.kind !== "deleteGroup") return;
          data.deleteGroup(cls.id, dialog.id);
          if (groupId === dialog.id) setGroupId(null);
        }}
        onClose={close}
      />
    </>
  );
}

function Crumb({ label, onClick }: { label: string; onClick?: () => void }) {
  return (
    <li className="flex items-center gap-1">
      <ChevronRight className="h-3.5 w-3.5" aria-hidden />
      {onClick ? (
        <button onClick={onClick} className="max-w-40 truncate rounded-md px-1 py-1.5 hover:text-foreground">
          {label}
        </button>
      ) : (
        <span aria-current="page" className="max-w-40 truncate px-1 font-medium text-foreground">
          {label}
        </span>
      )}
    </li>
  );
}
