"use client";

import { StudyDataProvider } from "@/features/data/study-data-provider";
import { SettingsProvider } from "@/features/settings/settings-provider";
import { ThemeProvider } from "@/features/theme/theme-provider";
import { TimerProvider } from "@/features/timer/timer-provider";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <SettingsProvider>
        <StudyDataProvider>
          <TimerProvider>{children}</TimerProvider>
        </StudyDataProvider>
      </SettingsProvider>
    </ThemeProvider>
  );
}
