"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useTheme, type ThemePreference } from "@/features/theme/theme-provider";
import { AccountCard } from "@/features/auth/account-card";
import { useSync } from "@/features/sync/sync-provider";
import { SyncCard } from "@/features/sync/sync-ui";
import { useTimer } from "@/features/timer/timer-provider";
import { DataTransferCard } from "./data-transfer";
import { LegacyDataCard } from "./legacy-data-card";

const THEMES = [
  { value: "system" as const, label: "System", icon: <Monitor className="h-4 w-4" aria-hidden /> },
  { value: "light" as const, label: "Light", icon: <Sun className="h-4 w-4" aria-hidden /> },
  { value: "dark" as const, label: "Dark", icon: <Moon className="h-4 w-4" aria-hidden /> },
];

export function SettingsView() {
  const { preference, setPreference } = useTheme();
  const timer = useTimer();
  const sync = useSync();

  return (
    <>
      <PageHeader title="Settings" description="Appearance and data." />
      <div className="max-w-2xl space-y-6">
        <Card>
          <CardTitle>Appearance</CardTitle>
          <p className="mb-4 mt-0.5 text-xs text-muted-foreground">System follows your device’s light or dark setting.</p>
          <SegmentedControl
            label="Theme"
            value={preference}
            options={THEMES}
            onChange={(v: ThemePreference) => setPreference(v)}
          />
        </Card>

        <Card>
          <CardTitle>Your data</CardTitle>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Classes, groups, sessions and your theme are saved in this browser on this device, and clearing site data
            removes them. When you’re signed in, your study data is kept separately for your account on this device.{" "}
            {sync.available
              ? "Syncing between your devices is optional: it stays off until you turn it on for this device in “Sync between devices” below."
              : "Your data stays on this device."}
          </p>
        </Card>

        <AccountCard timerActive={timer.state.status !== "idle"} />

        <SyncCard />

        <DataTransferCard />

        <LegacyDataCard />
      </div>
    </>
  );
}
