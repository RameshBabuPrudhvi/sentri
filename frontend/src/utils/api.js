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
