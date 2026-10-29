"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialogs";
import { useAuth } from "@/features/auth/auth-provider";
import { peekLegacyData } from "@/lib/account-store";
import { exportFileName, serializeExport } from "@/lib/data-export";
import { downloadText } from "@/lib/download";
import type { StorageLike } from "@/lib/data-store";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Data saved on this device before accounts existed is not shown, uploaded or claimed by
 * any account. This card only tells a signed-in user it exists and lets them download a
 * copy after confirming which account is asking. It never changes the stored data.
 * Linking it to an account (M4.3) is not built yet.
 */
export function LegacyDataCard({ getStorage }: { getStorage?: () => StorageLike | null }) {
  const { status, user } = useAuth();
  const [legacy] = useState(() => peekLegacyData(getStorage));
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  if (status !== "signed-in" || !legacy) return null;

  const summary = `${count(legacy.classes.length, "class", "classes")} and ${count(legacy.sessions.length, "session", "sessions")}`;
  const who = user?.email ?? "this account";

  function download() {
    setAsking(false);
    if (!legacy) return;
    try {
      downloadText(serializeExport(legacy), exportFileName().replace("studytime-export", "studytime-legacy-export"));
      setNotice({ ok: true, text: "Download started. The data on this device was not changed." });
    } catch {
      setNotice({ ok: false, text: "Couldn’t create the file. The data on this device was not changed." });
    }
  }

  return (
    <Card>
      <CardTitle>Saved before accounts</CardTitle>
      <p className="mb-4 mt-0.5 text-sm text-muted-foreground">
        This device has {summary} from before accounts. They aren’t linked to any account, aren’t shown in the
        app, and haven’t been deleted or uploaded. Linking them to an account will come in a later update. Until
        then you can download a copy and, if it’s yours, restore it with Backup → Import data.
      </p>
      <Button variant="secondary" onClick={() => setAsking(true)}>
        <Download className="h-4 w-4" aria-hidden /> Download saved data
      </Button>
      {notice && (
        <p
          role={notice.ok ? "status" : "alert"}
          className={notice.ok ? "mt-3 text-sm text-muted-foreground" : "mt-3 text-sm text-danger"}
        >
          {notice.text}
        </p>
      )}
      <ConfirmDialog
        open={asking}
        title="Download data from before accounts?"
        description={`You’re signed in as ${who}. This will download ${summary} that were saved on this device before accounts existed. Only continue if this data is yours.`}
        confirmLabel="Download"
        onConfirm={download}
        onClose={() => setAsking(false)}
      />
    </Card>
  );
}
