/**
 * @module context/ThemeContext
 * @description Provides theme state (light / dark / system) across the app.
 *
 * The resolved theme is applied as `data-theme="light|dark"` on `<html>`,
 * which tokens.css uses to swap CSS custom properties.
 *
 * Persistence: saved in localStorage under `app_theme`.
 * Default: "system" — follows the OS `prefers-color-scheme` preference.
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";

const ThemeContext = createContext(null);

const STORAGE_KEY = "app_theme";

/** @returns {"light"|"dark"} The OS-level color scheme preference. */
function getSystemTheme() {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Read the saved preference from localStorage.
 * @returns {"light"|"dark"|"system"}
 */
function getSavedPreference() {
  try {
    const val = localStorage.getItem(STORAGE_KEY);
    if (val === "light" || val === "dark" || val === "system") return val;
  } catch { /* localStorage unavailable */ }
  return "system";
}

/**
 * Resolve the effective theme from a preference.
 * @param {"light"|"dark"|"system"} pref
 * @returns {"light"|"dark"}
 */
function resolveTheme(pref) {
  if (pref === "light" || pref === "dark") return pref;
  return getSystemTheme();
}

/** Apply the resolved theme to the document root. */
function applyTheme(resolved) {
  document.documentElement.setAttribute("data-theme", resolved);
  // Also set color-scheme so native form controls (scrollbars, inputs) match
  document.documentElement.style.colorScheme = resolved;
}

export function ThemeProvider({ children }) {
  const [preference, setPreference] = useState(getSavedPreference);
  const [resolved, setResolved] = useState(() => resolveTheme(getSavedPreference()));

  // Apply on mount and whenever preference changes
  useEffect(() => {
    const r = resolveTheme(preference);
    setResolved(r);
    applyTheme(r);
    try { localStorage.setItem(STORAGE_KEY, preference); } catch { /* no-op */ }
  }, [preference]);

  // Listen for OS theme changes when preference is "system"
  useEffect(() => {
    if (preference !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    function onChange() {
      const r = resolveTheme("system");
      setResolved(r);
      applyTheme(r);
    }
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [preference]);

  /** Toggle between light and dark (skips system). */
  const toggle = useCallback(() => {
    setPreference(prev => {
      const current = resolveTheme(prev);
      return current === "dark" ? "light" : "dark";
    });
  }, []);

  /** Set an explicit preference. */
  const setTheme = useCallback((pref) => {
    if (pref === "light" || pref === "dark" || pref === "system") {
      setPreference(pref);
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, resolved, toggle, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

/**
 * Hook to access theme state and actions.
 * @returns {{ preference: "light"|"dark"|"system", resolved: "light"|"dark", toggle: () => void, setTheme: (pref) => void }}
 */
export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
