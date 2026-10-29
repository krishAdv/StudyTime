"use client";

import { AuthProvider } from "@/features/auth/auth-provider";
import { AccountBoundary } from "@/features/data/account-boundary";
import { SettingsProvider } from "@/features/settings/settings-provider";
import { ThemeProvider } from "@/features/theme/theme-provider";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <SettingsProvider>
        <AuthProvider>
          {/* Study data and timer providers live inside the boundary: they are per account. */}
          <AccountBoundary>{children}</AccountBoundary>
        </AuthProvider>
      </SettingsProvider>
    </ThemeProvider>
  );
}
