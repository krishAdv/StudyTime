"use client";

import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialogs";
import { useStudyData } from "@/features/data/study-data-provider";
import { useTimer } from "@/features/timer/timer-provider";
import { MAX_IMPORT_BYTES, exportFileName, parseExport, serializeExport } from "@/lib/data-export";
import type { StoredData } from "@/lib/storage";

type Notice = { kind: "ok" | "error"; text: string };

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Settings card: download a JSON backup of the study data, or replace it from one. */
export function DataTransferCard() {
  const data = useStudyData();
  const timer = useTimer();
  const fileInput = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, setPending] = useState<StoredData | null>(null);

  const ready = data.status === "ready";
  const timerActive = timer.state.status !== "idle";

  function exportData() {
    setNotice(null);
    try {
      const text = serializeExport({ classes: data.classes, sessions: data.sessions });
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = exportFileName();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setNotice({
        kind: "ok",
        text: `Export started: ${count(data.classes.length, "class", "classes")} and ${count(data.sessions.length, "session", "sessions")}. Check your downloads.`,
      });
    } catch {
      setNotice({ kind: "error", text: "Couldn’t create the export file. Your data hasn’t changed." });
    }
  }

  async function chooseFile(file: File | undefined) {
    setNotice(null);
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setNotice({ kind: "error", text: "That file is too large to be a StudyTime export. Nothing was imported." });
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setNotice({ kind: "error", text: "Couldn’t read that file. Nothing was imported." });
      return;
    }
    const parsed = parseExport(text);
    if (!parsed.ok) {
      setNotice({ kind: "error", text: `${parsed.error} Nothing was imported and your data is unchanged.` });
      return;
    }
    setPending(parsed.value);
  }

  function confirmReplace() {
    if (!pending) return;
    const r = data.replaceAllData(pending);
    setPending(null);
    setNotice(
      r.ok
        ? {
            kind: "ok",
            text: `Imported ${count(pending.classes.length, "class", "classes")} and ${count(pending.sessions.length, "session", "sessions")}. Your previous data was replaced.`,
          }
        : { kind: "error", text: `${r.error} Your data is unchanged.` },
    );
  }

  return (
    <Card>
      <CardTitle>Backup</CardTitle>
      <p className="mb-4 mt-0.5 text-sm text-muted-foreground">
        Download your classes, subgroups and sessions as a file, or restore them from one. Importing replaces what
        is saved here. Theme and countdown length aren’t included.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" onClick={exportData} disabled={!ready}>
          <Download className="h-4 w-4" aria-hidden /> Export data
        </Button>
        <Button variant="secondary" onClick={() => fileInput.current?.click()} disabled={!ready || timerActive}>
          <Upload className="h-4 w-4" aria-hidden /> Import data
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          aria-label="Choose an export file to import"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ""; // picking the same file again should still trigger onChange
            void chooseFile(file);
          }}
        />
      </div>
      {timerActive && (
        <p className="mt-3 text-xs text-muted-foreground">Stop the running timer before importing.</p>
      )}
      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={notice.kind === "error" ? "mt-3 text-sm text-danger" : "mt-3 text-sm text-muted-foreground"}
        >
          {notice.text}
        </p>
      )}

      <ConfirmDialog
        open={pending !== null}
        title="Replace your study data?"
        description={
          pending
            ? `This file has ${count(pending.classes.length, "class", "classes")} and ${count(pending.sessions.length, "session", "sessions")}. Your current ${count(data.classes.length, "class", "classes")} and ${count(data.sessions.length, "session", "sessions")} will be replaced. This can’t be undone, so export first if you might want them back.`
            : ""
        }
        confirmLabel="Replace my data"
        onConfirm={confirmReplace}
        onClose={() => setPending(null)}
      />
    </Card>
  );
}
