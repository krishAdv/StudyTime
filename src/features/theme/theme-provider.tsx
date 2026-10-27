"use client";

import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "studytime-theme";
const EVENT = "studytime-theme-change";

/** Runs before first paint (see layout.tsx) so there is no theme flash. */
export const THEME_INIT_SCRIPT = `(function(){try{var p=localStorage.getItem("${STORAGE_KEY}");var d=p==="dark"||((p===null||p==="system")&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;

function readPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // Storage can be unavailable (private mode); fall back to system.
  }
  return "system";
}

function applyTheme(pref: ThemePreference) {
  const dark =
    pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

type ThemeContextValue = {
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const preference = useSyncExternalStore(subscribe, readPreference, () => "system" as const);

  const setPreference = useCallback((p: ThemePreference) => {
    try {
      localStorage.setItem(STORAGE_KEY, p);
    } catch {
      // Ignore; the choice still applies for this page load.
    }
    applyTheme(p);
    window.dispatchEvent(new Event(EVENT));
  }, []);

  useEffect(() => {
    applyTheme(preference);
    if (preference !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [preference]);

  return (
    <ThemeContext.Provider value={{ preference, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
