/**
 * api.js — Shared API base URL helper.
 *
 * In development (Vite dev server), API calls are proxied via vite.config.js
 * so the base is empty ("").
 *
 * On GitHub Pages (or any static deploy without a co-located backend),
 * set VITE_API_URL to point at the deployed backend, e.g.:
 *   VITE_API_URL=https://sentri-api.example.com
 *
 * In Docker (nginx proxies /api → backend:3001), the base is also empty.
 */

export const API_BASE = import.meta.env.VITE_API_URL || "";

/**
 * Safely parse a JSON response.
 * Throws a user-friendly error when the server returns non-JSON (e.g. HTML
 * from Vite's SPA fallback, nginx, or a misconfigured proxy).
 */
export async function parseJsonResponse(res) {
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    throw new Error("Unable to reach the server. Please check that the backend is running.");
  }
  return res.json();
}
