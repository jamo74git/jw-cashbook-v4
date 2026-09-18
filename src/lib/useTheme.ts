// ─────────────────────────────────────────────────────────────────────────────
// THEME HOOK — light | dark | system. Persists to localStorage ("theme") and toggles
// the `dark` class on <html>. In "system" mode it follows the OS preference and
// live-updates when that changes. Self-contained (no Next.js coupling).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "theme";

export function getStoredTheme(): Theme {
  if (typeof localStorage === "undefined") return "system";
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

function prefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Resolve the effective theme and toggle the `dark` class on the document root. */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const isDark = theme === "dark" || (theme === "system" && prefersDark());
  document.documentElement.classList.toggle("dark", isDark);
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => getStoredTheme());

  // Apply whenever the selection changes.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // While in "system" mode, follow OS changes live.
  useEffect(() => {
    if (theme !== "system" || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, t);
    setThemeState(t);
  }, []);

  return { theme, setTheme };
}
