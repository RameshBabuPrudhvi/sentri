/**
 * @module utils/csrf
 * @description Read the CSRF double-submit cookie value.
 *
 * Extracted into a plain .js file (not .jsx) so it can be imported by both
 * React components (AuthContext.jsx) and the api.js module — the latter is
 * tested under plain Node.js which cannot parse .jsx files.
 *
 * ### Cross-origin deployments
 * When the frontend and backend live on different origins (e.g. GitHub Pages +
 * Render), the `_csrf` cookie is set on the backend's domain and is invisible
 * to `document.cookie`.  In that case the backend echoes the token in a
 * `X-CSRF-Token` **response** header.  The frontend captures it via
 * {@link setCsrfToken} after every fetch and stores it in a module-level
 * variable so {@link getCsrfToken} can return it.
 */

/** @type {string} In-memory CSRF token captured from response headers. */
let _csrfToken = "";

/**
 * Store a CSRF token received from a backend response header.
 * Called by the api.js fetch wrapper after every response.
 *
 * @param {string} token - The token value from the `X-CSRF-Token` response header.
 */
export function setCsrfToken(token) {
  if (token) _csrfToken = token;
}

/**
 * Read the CSRF token — first from the in-memory cache (set by
 * {@link setCsrfToken}), then from the `_csrf` cookie (same-origin fallback).
 * @returns {string}
 */
export function getCsrfToken() {
  if (_csrfToken) return _csrfToken;
  try {
    const match = document.cookie.split(";").find(c => c.trim().startsWith("_csrf="));
    if (!match) return "";
    return match.split("=")[1]?.trim() || "";
  } catch { return ""; }
}
