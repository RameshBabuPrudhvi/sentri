/**
 * @module utils/csrf
 * @description Read the CSRF double-submit cookie value.
 *
 * Extracted into a plain .js file (not .jsx) so it can be imported by both
 * React components (AuthContext.jsx) and the api.js module — the latter is
 * tested under plain Node.js which cannot parse .jsx files.
 */

/**
 * Read the CSRF token from the `_csrf` cookie (Non-HttpOnly).
 * @returns {string}
 */
export function getCsrfToken() {
  try {
    const match = document.cookie.split(";").find(c => c.trim().startsWith("_csrf="));
    if (!match) return "";
    return match.split("=")[1]?.trim() || "";
  } catch { return ""; }
}
