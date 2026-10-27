"use client";

import { createContext, useCallback, useContext, useState } from "react";

/** Countdown length limits, in minutes. */
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 24 * 60;
export const DEFAULT_COUNTDOWN_MINUTES = 45;

const STORAGE_KEY = "studytime:countdown-minutes";

function load(): number {
  if (typeof window === "undefined") return DEFAULT_COUNTDOWN_MINUTES;
  try {
    const n = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isInteger(n) && n >= MIN_MINUTES && n <= MAX_MINUTES) return n;
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_COUNTDOWN_MINUTES;
}

type SettingsContextValue = {
  /** Last valid countdown length the user entered. */
  countdownMinutes: number;
  setCountdownMinutes: (m: number) => void;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [countdownMinutes, setMinutes] = useState(load);

  const setCountdownMinutes = useCallback((m: number) => {
    if (!Number.isInteger(m) || m < MIN_MINUTES || m > MAX_MINUTES) return;
    setMinutes(m);
    try {
      localStorage.setItem(STORAGE_KEY, String(m));
    } catch {
      // Non-critical preference.
    }
  }, []);

  return (
    <SettingsContext.Provider value={{ countdownMinutes, setCountdownMinutes }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
