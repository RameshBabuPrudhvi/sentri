/**
 * AuthContext.jsx
 *
 * Provides authentication state (user, token) across the app.
 * Token is stored in localStorage with a short-lived accessToken pattern.
 * Sensitive data is never stored — only the JWT string and safe user fields.
 *
 * Security notes:
 *   • Passwords are NEVER handled here — they go straight to the API.
 *   • Tokens are validated on every protected API call via Authorization header.
 *   • On 401 responses, the user is automatically logged out (token revoked or expired).
 *   • The token expiry is decoded client-side only for UX (redirect before it expires).
 *     The server always validates independently.
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";

const AuthContext = createContext(null);

const TOKEN_KEY = "sentri_token";
const USER_KEY  = "sentri_user";

/** Decode JWT payload without verifying (verification happens server-side) */
function decodeJwt(token) {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

/** Check if a decoded JWT payload is still valid */
function isTokenValid(decoded) {
  if (!decoded?.exp) return false;
  // Give a 30-second buffer so we refresh before the server rejects it
  return decoded.exp * 1000 > Date.now() + 30_000;
}

export function AuthProvider({ children }) {
  const [token, setToken]   = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser]     = useState(() => {
    try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; }
  });
  const [loading, setLoading] = useState(true);

  // On mount, verify the stored token is still valid
  useEffect(() => {
    const stored = localStorage.getItem(TOKEN_KEY);
    if (stored) {
      const decoded = decodeJwt(stored);
      if (!isTokenValid(decoded)) {
        // Token expired — clear silently
        clearSession();
      } else {
        setToken(stored);
        try { setUser(JSON.parse(localStorage.getItem(USER_KEY))); } catch { /* no-op */ }
      }
    }
    setLoading(false);
  }, []);

  // Auto-logout when token expires (poll every 60s)
  useEffect(() => {
    if (!token) return;
    const interval = setInterval(() => {
      const decoded = decodeJwt(token);
      if (!isTokenValid(decoded)) clearSession();
    }, 60_000);
    return () => clearInterval(interval);
  }, [token]);

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
  }

  /** Called after successful login or OAuth callback */
  async function login(newToken, userData) {
    const decoded = decodeJwt(newToken);
    if (!decoded || !isTokenValid(decoded)) {
      throw new Error("Received an invalid or expired token.");
    }
    // Only store safe fields — never full profile blobs from OAuth providers
    const safeUser = {
      id:     userData.id,
      name:   userData.name,
      email:  userData.email,
      avatar: userData.avatar || null,
      role:   userData.role  || "user",
    };
    localStorage.setItem(TOKEN_KEY, newToken);
    localStorage.setItem(USER_KEY, JSON.stringify(safeUser));
    setToken(newToken);
    setUser(safeUser);
  }

  function logout() {
    // Optionally call /api/auth/logout to invalidate server-side session
    fetch("/api/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => { /* fire-and-forget */ });
    clearSession();
  }

  /**
   * Authenticated fetch wrapper.
   * Automatically injects the Bearer token and handles 401 (session expired).
   */
  const authFetch = useCallback(async (url, options = {}) => {
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      clearSession();
      throw new Error("Session expired. Please sign in again.");
    }
    return res;
  }, [token]);

  return (
    <AuthContext.Provider value={{ user, token, login, logout, authFetch, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
