/**
 * @module context/AuthContext
 * @description Provides authentication state (user, token) across the app via React Context.
 *
 * Token is stored in `localStorage` with a short-lived accessToken pattern.
 * Sensitive data is never stored — only the JWT string and safe user fields.
 *
 * ### Security notes
 * - Passwords are NEVER handled here — they go straight to the API.
 * - Tokens are validated on every protected API call via `Authorization` header.
 * - On 401 responses, the user is automatically signed out (token revoked or expired).
 * - Token expiry is decoded client-side only for UX (redirect before it expires).
 *   The server always validates independently.
 *
 * ### Exports
 * - {@link AuthProvider} — React context provider component.
 * - {@link useAuth} — Hook to access `{ user, token, login, logout, authFetch, loading }`.
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE } from "../utils/api.js";

const AuthContext = createContext(null);

const TOKEN_KEY = "app_auth_token";
const USER_KEY  = "app_auth_user";

/**
 * Decode a JWT payload without verifying the signature.
 * Verification always happens server-side — this is only for client-side UX
 * (e.g. checking expiry before making a request).
 *
 * @param   {string}      token - The JWT string.
 * @returns {Object|null}         Decoded payload, or `null` on failure.
 * @private
 */
function decodeJwt(token) {
  try {
    let payload = token.split(".")[1];
    // Convert base64url → base64 and add padding so atob never fails
    payload = payload.replace(/-/g, "+").replace(/_/g, "/");
    payload = payload.padEnd(payload.length + (4 - (payload.length % 4)) % 4, "=");
    return JSON.parse(atob(payload));
  } catch {
    return null;
  }
}

/**
 * Check if a decoded JWT payload is still valid (not expired).
 * Includes a 30-second buffer so the client redirects before the server rejects.
 *
 * @param   {Object|null} decoded - Decoded JWT payload (from {@link decodeJwt}).
 * @returns {boolean}               `true` if the token has not expired.
 * @private
 */
function isTokenValid(decoded) {
  if (!decoded?.exp) return false;
  // Give a 30-second buffer so we refresh before the server rejects it
  return decoded.exp * 1000 > Date.now() + 30_000;
}

/**
 * React context provider that manages authentication state.
 * Wrap your app's root with this to enable `useAuth()` in child components.
 *
 * Provides: `{ user, token, login, logout, authFetch, loading }`.
 *
 * @param {Object} props
 * @param {React.ReactNode} props.children - Child components.
 * @returns {React.ReactElement}
 *
 * @example
 * <AuthProvider>
 *   <App />
 * </AuthProvider>
 */
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

  /**
   * Store a new token and user profile after successful sign-in or OAuth callback.
   * Validates the token before storing. Only safe fields are persisted.
   *
   * @param {string} newToken - The JWT string from the backend.
   * @param {Object} userData - User profile `{ id, name, email, avatar?, role? }`.
   * @throws {Error} If the token is invalid or expired.
   */
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

  /**
   * Sign out the current user. Revokes the token server-side (fire-and-forget)
   * and clears localStorage immediately.
   */
  function logout() {
    // Call /api/auth/logout to invalidate server-side session
    fetch(`${API_BASE}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => { /* fire-and-forget */ });
    clearSession();
  }

  /**
   * Authenticated fetch wrapper.
   * Automatically injects the `Authorization: Bearer` header and handles
   * 401 responses by clearing the session and throwing.
   *
   * @param {string} url     - API path (e.g. `"/api/projects"`) or full URL.
   * @param {Object} [options] - Standard `fetch` options (method, headers, body, etc.).
   * @returns {Promise<Response>} The raw Fetch API response (caller must parse).
   * @throws {Error} If the server responds with 401 (session expired).
   */
  const authFetch = useCallback(async (url, options = {}) => {
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const fullUrl = url.startsWith("/api") ? `${API_BASE}${url}` : url;
    const res = await fetch(fullUrl, { ...options, headers });
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

/**
 * Hook to access authentication state and actions.
 * Must be called inside an `<AuthProvider>`.
 *
 * @returns {AuthContextValue}
 *
 * @typedef {Object} AuthContextValue
 * @property {Object|null}  user      - Current user `{ id, name, email, avatar, role }`, or `null`.
 * @property {string|null}  token     - JWT string, or `null` if not signed in.
 * @property {Function}     login     - `(token, userData) => Promise<void>` — store credentials.
 * @property {Function}     logout    - `() => void` — clear session and revoke token.
 * @property {Function}     authFetch - `(url, options?) => Promise<Response>` — fetch with auth header.
 * @property {boolean}      loading   - `true` while initial token validation is in progress.
 *
 * @example
 * const { user, logout } = useAuth();
 * if (user) console.log(`Signed in as ${user.name}`);
 */
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
