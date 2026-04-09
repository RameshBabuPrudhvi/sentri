/**
 * @module utils/api
 * @description Shared API base URL helper and response parser.
 *
 * - **Development** (Vite dev server): API calls are proxied via `vite.config.js`, so the base is `""`.
 * - **GitHub Pages** (or any static deploy without a co-located backend):
 *   set `VITE_API_URL` to point at the deployed backend, e.g. `https://sentri-api.example.com`.
 * - **Docker** (nginx proxies `/api` → `backend:3001`): the base is also `""`.
 */

/**
 * Base URL for all API requests.
 * Empty string in dev/Docker (same-origin), or the deployed backend URL on static hosts.
 *
 * @type {string}
 * @example
 * // In .env for GitHub Pages deploy:
 * // VITE_API_URL=https://my-backend.onrender.com
 * fetch(`${API_BASE}/api/projects`);
 */
const viteEnv = (typeof import.meta !== "undefined" && import.meta.env) ? import.meta.env : {};
export const API_BASE = viteEnv.VITE_API_URL || "";

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
