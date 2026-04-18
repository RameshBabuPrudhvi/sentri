/**
 * @module context/AuthContext
 * @description Provides authentication state (user) across the app via React Context.
 *
 * ### Security model (S1-02)
 * The JWT lives exclusively in an HttpOnly; Secure; SameSite=Strict cookie set by
 * the backend. JavaScript (including this file) can never read it — which eliminates
 * the entire class of XSS-based token theft.
 *
 * The backend also sets a companion `token_exp` cookie (Non-HttpOnly) that exposes
 * only the numeric expiry timestamp. This file reads that cookie to drive proactive
 * refresh and session-expiry warnings without ever touching the actual JWT.
 *
 * All API requests send `credentials: "include"` so the browser automatically
 * attaches the HttpOnly cookie on every fetch — no manual header injection needed.
 *
 * ### Exports
 * - {@link AuthProvider} — React context provider component.
 * - {@link useAuth} — Hook to access `{ user, login, logout, authFetch, loading }`.
 */

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from "react";
import { API_PATH } from "../utils/apiBase.js";
import { getCsrfToken } from "../utils/csrf.js";

const AuthContext = createContext(null);

/** localStorage key for the safe user profile (no token — only id/name/email/role/avatar). */
const USER_KEY = "app_auth_user";

/** Name of the Non-HttpOnly expiry-hint cookie written by the backend. */
const EXP_COOKIE = "token_exp";

/** Proactive refresh fires this many ms before the token actually expires. */
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// ─── Cookie helpers ───────────────────────────────────────────────────────────

function readCookie(name) {
  try {
    const match = document.cookie.split(";").find(c => c.trim().startsWith(`${name}=`));
    if (!match) return "";
    return match.split("=")[1]?.trim() || "";
  } catch { return ""; }
}

function readExpCookie() {
  const val = readCookie(EXP_COOKIE);
  const n   = parseInt(val, 10);
  return Number.isFinite(n) ? n : 0;
}

function isCookieSessionValid() {
  const exp = readExpCookie();
  if (!exp) return false;
  return exp * 1000 > Date.now() + 30_000;
}

function msUntilRefresh() {
  const exp = readExpCookie();
  if (!exp) return null;
  const refreshAt = exp * 1000 - REFRESH_BEFORE_EXPIRY_MS;
  const ms = refreshAt - Date.now();
  return ms > 0 ? ms : 0;
}

function sanitiseUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, avatar: u.avatar || null, role: u.role || "user",
    workspaceId: u.workspaceId || null,
    workspaceName: u.workspaceName || null,
    workspaceRole: u.workspaceRole || null,
    workspaces: Array.isArray(u.workspaces) ? u.workspaces : null,
  };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AuthProvider({ children }) {
  const [user, setUser]     = useState(() => {
    try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; }
  });
  const [loading, setLoading] = useState(true);
  const refreshTimerRef       = useRef(null);

  // ── Proactive refresh scheduler ──────────────────────────────────────────
  const scheduleRefresh = useCallback(function schedule() {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    const ms = msUntilRefresh();
    if (ms === null) {
      // Cross-origin: token_exp cookie may be unreadable (third-party cookie
      // restrictions). Fall back to a fixed interval so the session stays alive.
      refreshTimerRef.current = setTimeout(schedule, 55 * 60 * 1000);
      return;
    }
    refreshTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`${API_PATH}/auth/refresh`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": getCsrfToken() },
        });
        if (res.ok) {
          const data = await res.json();
          if (data.user) {
            const safe = sanitiseUser(data.user);
            localStorage.setItem(USER_KEY, JSON.stringify(safe));
            setUser(safe);
            schedule();
          } else {
            doLogout(false);
          }
        } else {
          doLogout(false);
        }
      } catch {
        // Network hiccup — retry in 60s
        refreshTimerRef.current = setTimeout(schedule, 60_000);
      }
    }, ms);
  }, []); // eslint-disable-line

  // ── Logout helper (shared by logout() and clearSession) ──────────────────
  function doLogout(shouldRedirect = true) {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    localStorage.removeItem(USER_KEY);
    setUser(null);
    if (shouldRedirect) {
      const path = window.location.pathname;
      if (!path.endsWith("/login") && !path.endsWith("/forgot-password")) {
        const base = (import.meta?.env?.BASE_URL || "/").replace(/\/$/, "");
        window.location.href = `${base}/login`;
      }
    }
  }

  // ── Mount: verify session via /api/auth/me ────────────────────────────────
  useEffect(() => {
    // If the cookie is readable and shows an expired session, skip the server
    // call — we know the session is dead. If the cookie is unreadable (returns 0,
    // e.g. cross-origin deployments), fall through to the server call since the
    // HttpOnly auth cookie may still be valid.
    if (readExpCookie() !== 0 && !isCookieSessionValid()) {
      doLogout(false);
      setLoading(false);
      return;
    }
    fetch(`${API_PATH}/auth/me`, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.id) {
          const safe = sanitiseUser(data);
          localStorage.setItem(USER_KEY, JSON.stringify(safe));
          setUser(safe);
          scheduleRefresh();
        } else {
          doLogout(false);
        }
      })
      .catch(() => { /* network error — keep cached user, next 401 will redirect */ })
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line

  useEffect(() => () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); }, []);

  // ─── Public actions ───────────────────────────────────────────────────────

  /**
   * Called after a successful login/OAuth response.
   * The JWT is already in the HttpOnly cookie — this just records the user profile.
   */
  function login(userData) {
    const safe = sanitiseUser(userData);
    localStorage.setItem(USER_KEY, JSON.stringify(safe));
    setUser(safe);
    scheduleRefresh();
  }

  /** Sign out — revokes token server-side, clears cookie, wipes local state. */
  async function logout() {
    try {
      await fetch(`${API_PATH}/auth/logout`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
    } catch { /* fire-and-forget */ }
    doLogout(true);
  }

  /**
   * Authenticated fetch wrapper.
   * Sends `credentials: "include"` so the HttpOnly cookie is attached automatically.
   * Injects X-CSRF-Token for mutating requests.
   * Handles 401 by clearing the session and redirecting.
   */
  const authFetch = useCallback(async (url, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    const safe   = new Set(["GET", "HEAD", "OPTIONS"]);
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
      ...(!safe.has(method) ? { "X-CSRF-Token": getCsrfToken() } : {}),
    };
    // authFetch callers pass paths like "/api/v1/…" — prepend the backend origin.
    const fullUrl = url.startsWith("/api/") ? `${API_PATH}${url.replace(/^\/api(\/v\d+)?/, "")}` : url;
    const res = await fetch(fullUrl, { ...options, headers, credentials: "include" });
    if (res.status === 401) {
      doLogout(true);
      throw new Error("Session expired. Please sign in again.");
    }
    return res;
  }, []); // eslint-disable-line

  return (
    <AuthContext.Provider value={{ user, login, logout, authFetch, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}