/**
 * @module utils/apiBase
 * @description Shared API base URL helper and response parser.
 *
 * - **Development** (Vite dev server): API calls are proxied via `vite.config.js`, so the base is `""`.
 * - **GitHub Pages** (or any static deploy without a co-located backend):
 *   set `VITE_API_URL` to point at the deployed backend, e.g. `https://sentri-api.example.com`.
 * - **Docker** (nginx proxies `/api` → `backend:3001`): the base is also `""`.
 *
 * ### Version prefix (INF-005)
 * `API_VERSION` is the single source of truth for the API version prefix.
 * All frontend code that constructs API URLs should use `API_PATH` instead of
 * hardcoding `/api/v1`. When the API version changes, update `API_VERSION`
 * here — no other frontend file needs to change.
 */

const viteEnv = (typeof import.meta !== "undefined" && import.meta.env) ? import.meta.env : {};

/**
 * Base URL for the backend server.
 * Empty string in dev/Docker (same-origin), or the deployed backend URL on static hosts.
 *
 * @type {string}
 * @example
 * // In .env for GitHub Pages deploy:
 * // VITE_API_URL=https://my-backend.onrender.com
 */
export const API_BASE = viteEnv.VITE_API_URL || "";

/**
 * API version prefix. Change this single constant to bump the frontend to a
 * new API version — all files that import `API_PATH` will pick it up automatically.
 *
 * @type {string}
 */
export const API_VERSION = "v1";

/**
 * Full versioned API path prefix.
 * Use this for all API URL construction instead of hardcoding `/api/v1`.
 *
 * @type {string}
 * @example
 * fetch(`${API_PATH}/auth/me`, { credentials: "include" });
 * // → "/api/v1/auth/me" (dev) or "https://backend.example.com/api/v1/auth/me" (cross-origin)
 */
export const API_PATH = `${API_BASE}/api/${API_VERSION}`;

/**
 * Safely parse a JSON response from the backend.
 * Checks the `Content-Type` header before calling `res.json()`.
 * Throws a user-friendly error when the server returns non-JSON
 * (e.g. HTML from Vite's SPA fallback, nginx, or a misconfigured proxy).
 *
 * @param   {Response} res - The Fetch API response object.
 * @returns {Promise<Object>}  The parsed JSON body.
 * @throws  {Error} If the response is not `application/json`.
 *
 * @example
 * const res = await fetch(`${API_BASE}/api/auth/login`, { method: "POST", ... });
 * const data = await parseJsonResponse(res); // throws if backend returned HTML
 */
export async function parseJsonResponse(res) {
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    throw new Error("Unable to reach the server. Please check that the backend is running.");
  }
  return res.json();
}
