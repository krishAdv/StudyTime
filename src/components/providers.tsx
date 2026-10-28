"use client";

import { AuthProvider } from "@/features/auth/auth-provider";
import { StudyDataProvider } from "@/features/data/study-data-provider";
import { SettingsProvider } from "@/features/settings/settings-provider";
import { ThemeProvider } from "@/features/theme/theme-provider";
import { TimerProvider } from "@/features/timer/timer-provider";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <SettingsProvider>
        <AuthProvider>
          <StudyDataProvider>
            <TimerProvider>{children}</TimerProvider>
          </StudyDataProvider>
        </AuthProvider>
      </SettingsProvider>
    </ThemeProvider>
  );
}
