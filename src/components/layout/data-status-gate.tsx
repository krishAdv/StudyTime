"use client";

import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useStudyData } from "@/features/data/study-data-provider";

/**
 * Shows the pages only once the study data has really loaded, so a loading or
 * failed load is never shown as an empty app. Instant for localStorage.
 */
export function DataStatusGate({ children }: { children: React.ReactNode }) {
  const { status, loadError, retryLoad, saveError, retrySave } = useStudyData();

  if (status === "loading") {
    return (
      <p className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading your data…
      </p>
    );
  }

  if (status === "error") {
    return (
      <EmptyState
        icon={<AlertTriangle className="h-6 w-6" aria-hidden />}
        title="Couldn’t load your data"
        description={`${loadError ?? "Something went wrong."} Your saved data hasn’t been changed.`}
        action={<Button onClick={retryLoad}>Try again</Button>}
      />
    );
  }

  return (
    <>
      {saveError && (
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-danger/40 bg-card px-4 py-3 text-sm"
        >
          <span>Your latest changes haven’t been saved yet.</span>
          <Button variant="secondary" onClick={retrySave}>
            Retry save
          </Button>
        </div>
      )}
      {children}
    </>
  );
}
