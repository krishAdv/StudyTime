"use client";

import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useStudyData } from "@/features/data/study-data-provider";
import { downloadText } from "@/lib/download";
import { exportFileName, serializeExport } from "@/lib/data-export";

/**
 * Shown when another tab changed this account's data (see `createAccountStore`). This tab then saves and syncs nothing, so
 * it can't overwrite the newer data. It never reloads by itself: reloading throws away this tab's unsaved work (and a
 * running timer), so the person decides, and can first download what this tab holds.
 */
export function StaleTabBanner({ onReload }: { onReload?: () => void }) {
  const { staleTab, classes, sessions } = useStudyData();
  const [note, setNote] = useState<string | null>(null);
  if (!staleTab) return null;

  const reload = onReload ?? (() => window.location.reload());

  function download() {
    try {
      downloadText(serializeExport({ classes, sessions }), exportFileName().replace("studytime-export", "studytime-this-tab"));
      setNote("Download started. It holds what this tab shows, including anything newer than the other tab’s data.");
    } catch {
      setNote("Couldn’t create the download. Nothing was changed.");
    }
  }

  return (
    <div role="alert" className="mb-4 rounded-2xl border border-danger/40 bg-card px-4 py-3 text-sm">
      <p className="flex items-start gap-2 font-medium">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        StudyTime was changed in another tab
      </p>
      <p className="mt-1 text-muted-foreground">
        This tab is out of date, so it has stopped saving and syncing to protect your newer data. Reload this tab to continue.
        Anything you change here before reloading is not saved. If you just finished a study session in this tab, download
        this tab’s data first.
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        <Button variant="primary" onClick={reload}>
          Reload this tab
        </Button>
        <Button variant="secondary" onClick={download}>
          Download this tab’s data
        </Button>
      </div>
      {note && (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
