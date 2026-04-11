/**
 * @module api
 * @description Centralised API client for all backend communication.
 *
 * Every page and component uses `api.*` methods instead of raw `fetch`.
 * Provides automatic timeout, JSON parsing with non-JSON error guard,
 * authenticated requests via JWT Bearer token, and structured error messages.
 *
 * On 401 responses the stored token is cleared and the user is redirected
 * to the login page so stale sessions don't silently fail.
 *
 * @example
 * import { api } from "./api.js";
 *
 * const projects = await api.getProjects();
 * const { runId } = await api.crawl("PRJ-1");
 * const dashboard = await api.getDashboard();
 */

import { API_BASE, parseJsonResponse } from "./utils/apiBase.js";
import { getCsrfToken } from "./utils/csrf.js";

/** @type {string} Full base URL for API endpoints (e.g. `"/api"` or `"https://backend.example.com/api"`). */
const BASE = `${API_BASE}/api`;

/** @type {number} Default request timeout in milliseconds (30 seconds). */
const TIMEOUT_DEFAULT = 30_000;
/** @type {number} Extended timeout for long-running operations like crawl and test runs (5 minutes). */
const TIMEOUT_LONG    = 300_000;

const BASE_URL = (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL) ? import.meta.env.BASE_URL : "/";

/**
 * Handle a 401 Unauthorized response by clearing the stored user profile
 * and redirecting to the login page.
 * The HttpOnly cookie is cleared by the backend on logout — we just redirect.
 * @private
 */
function handleUnauthorized() {
  try { localStorage.removeItem("app_auth_user"); } catch { /* localStorage unavailable */ }
  const path = window.location.pathname;
  if (path.endsWith("/login") || path.endsWith("/forgot-password")) return;
  const base = BASE_URL.replace(/\/$/, "");
  window.location.href = `${base}/login`;
}

/**
 * Internal fetch wrapper with timeout, JSON parsing, auth, and error handling.
 *
 * Automatically injects the `Authorization: Bearer <token>` header when a
 * JWT token is available in localStorage. On 401 responses, clears the
 * session and redirects to `/login`.
 *
 * @param   {string}  method           - HTTP method (`GET`, `POST`, `PATCH`, `DELETE`).
 * @param   {string}  path             - API path relative to `/api` (e.g. `"/projects"`).
 * @param   {Object}  [body]           - Request body (auto-serialised to JSON).
 * @param   {number}  [timeout=30000]  - Request timeout in milliseconds.
 * @returns {Promise<Object>}            Parsed JSON response body.
 * @throws  {Error} On timeout, network failure, non-JSON response, or HTTP error status.
 * @private
 */
async function req(method, path, body, timeout = TIMEOUT_DEFAULT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  // All state-mutating methods need the CSRF double-submit token.
  // Safe methods (GET/HEAD/OPTIONS) are exempt per the backend middleware.
  const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
  const headers = {
    "Content-Type": "application/json",
    ...(!safeMethods.has(method.toUpperCase()) ? { "X-CSRF-Token": getCsrfToken() } : {}),
  };

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      // Send the HttpOnly auth cookie automatically on every request.
      // This replaces the old "Authorization: Bearer <token>" header approach.
      credentials: "include",
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error("Request timed out. Please try again.");
    throw err;
  }
  clearTimeout(timer);

  if (res.status === 401) {
    handleUnauthorized();
    throw new Error("Session expired. Please sign in again.");
  }

  if (!res.ok) {
    const err = await parseJsonResponse(res).catch(() => ({ error: res.statusText }));
    throw new Error(`[${res.status}] ${err.error || res.statusText || "Request failed"}`);
  }
  return parseJsonResponse(res);
}

/**
 * Centralised API client. All methods return `Promise<Object>` (parsed JSON).
 * @namespace
 */
export const api = {
  // ── Projects ────────────────────────────────────────────────────────────────
  /** @param {Object} data - `{ name, url, credentials? }` */
  createProject: (data) => req("POST", "/projects", data),
  /** @returns {Promise<Array>} List of all projects. */
  getProjects:   ()     => req("GET",  "/projects"),
  /** @param {string} id - Project ID (e.g. `"PRJ-1"`). */
  getProject:    (id)   => req("GET",  `/projects/${id}`),
  /** @param {string} id - Deletes project and all its tests, runs, and history. */
  deleteProject: (id)   => req("DELETE", `/projects/${id}`),

  // ── Crawl & Run ─────────────────────────────────────────────────────────────
  /**
   * Start a crawl + AI test generation run.
   * @param {string} id   - Project ID.
   * @param {Object} [body] - Optional `{ maxDepth, dialsConfig }`.
   * @returns {Promise<{runId: string}>}
   */
  crawl:         (id, body) => req("POST", `/projects/${id}/crawl`, body || undefined, TIMEOUT_LONG),
  /**
   * Execute all approved tests for a project.
   * @param {string} id   - Project ID.
   * @param {Object} [body] - Optional `{ dialsConfig }` for parallel workers etc.
   */
  runTests:      (id, body) => req("POST", `/projects/${id}/run`, body || undefined, TIMEOUT_LONG),
  /** @param {string} testId - Execute a single test. */
  runSingleTest: (testId)=> req("POST", `/tests/${testId}/run`,  undefined, TIMEOUT_LONG),

  // ── Tests ───────────────────────────────────────────────────────────────────
  /** @param {string} id - Project ID. Returns tests for that project. */
  getTests:     (id)                => req("GET",    `/projects/${id}/tests`),
  /** @returns {Promise<Array>} All tests across all projects. */
  getAllTests:   ()                  => req("GET",    "/tests"),
  /** @param {string} testId */
  getTest:      (testId)            => req("GET",    `/tests/${testId}`),
  /** @param {string} testId @param {Object} data - Fields to update. */
  updateTest:   (testId, data)      => req("PATCH",  `/tests/${testId}`, data),
  /** @param {string} projectId @param {Object} data - `{ name, steps }`. Saved as Draft. */
  createTest:   (projectId, data)   => req("POST",   `/projects/${projectId}/tests`, data),
  /**
   * Generate a test from a plain-English description using AI.
   * @param {string} projectId
   * @param {Object} data - `{ name, description, dialsConfig? }`.
   * @returns {Promise<{runId: string}>}
   */
  generateTest: (projectId, data)   => req("POST",   `/projects/${projectId}/tests/generate`, data, TIMEOUT_LONG),
  /** @param {string} projectId @param {string} testId */
  deleteTest:   (projectId, testId) => req("DELETE", `/projects/${projectId}/tests/${testId}`),

  // ── Test review actions ─────────────────────────────────────────────────────
  /** @param {string} projectId @param {string} testId - Promote Draft → Approved. */
  approveTest:     (projectId, testId) => req("PATCH", `/projects/${projectId}/tests/${testId}/approve`),
  /** @param {string} projectId @param {string} testId - Mark as Rejected. */
  rejectTest:      (projectId, testId) => req("PATCH", `/projects/${projectId}/tests/${testId}/reject`),
  /** @param {string} projectId @param {string} testId - Restore to Draft. */
  restoreTest:     (projectId, testId) => req("PATCH", `/projects/${projectId}/tests/${testId}/restore`),
  /**
   * Bulk update tests.
   * @param {string}   projectId
   * @param {string[]} testIds
   * @param {string}   action - `"approve"` | `"reject"` | `"restore"` | `"delete"`.
   */
  bulkUpdateTests: (projectId, testIds, action) =>
    req("POST", `/projects/${projectId}/tests/bulk`, { testIds, action }),
  /** @param {string} projectId @param {string[]} testIds */
  bulkDeleteTests: (projectId, testIds) =>
    req("POST", `/projects/${projectId}/tests/bulk`, { testIds, action: "delete" }),

  // ── Runs ────────────────────────────────────────────────────────────────────
  /** @param {string} id - Project ID. Returns runs sorted newest-first. */
  getRuns:   (id)    => req("GET", `/projects/${id}/runs`),
  /** @param {string} runId - Get full run detail with per-test results. */
  getRun:    (runId) => req("GET", `/runs/${runId}`),
  /** @param {string} runId - Abort a running crawl or test run. */
  abortRun:  (runId) => req("POST", `/runs/${runId}/abort`),

  // ── Dashboard ───────────────────────────────────────────────────────────────
  /** @returns {Promise<Object>} Analytics: pass rate, defects, flaky tests, MTTR, etc. */
  getDashboard: () => req("GET", "/dashboard"),

  // ── Config & Settings ───────────────────────────────────────────────────────
  /** @returns {Promise<Object>} Active AI provider info `{ hasProvider, providerName, model }`. */
  getConfig:    ()                 => req("GET",    "/config"),
  /** @returns {Promise<Object>} Masked API key status per provider. */
  getSettings:  ()                 => req("GET",    "/settings"),

  /**
   * Save an AI provider API key (or activate Ollama).
   * @param {string}      provider   - `"anthropic"` | `"openai"` | `"google"` | `"local"`.
   * @param {string|null} apiKey     - API key (null for Ollama).
   * @param {Object}      [ollamaOpts] - `{ baseUrl, model }` for local provider.
   */
  saveApiKey: (provider, apiKey, ollamaOpts) =>
    provider === "local"
      ? req("POST", "/settings", { provider, ...ollamaOpts })
      : req("POST", "/settings", { provider, apiKey }),
  /** @param {string} provider - Remove API key or deactivate Ollama. */
  deleteApiKey: (provider) => req("DELETE", `/settings/${provider}`),

  // ── Ollama ──────────────────────────────────────────────────────────────────
  /** @returns {Promise<{ok: boolean, model?: string, availableModels?: string[], error?: string}>} */
  getOllamaStatus: () => req("GET", "/ollama/status"),

  // ── URL reachability ────────────────────────────────────────────────────────
  /** @param {string} url - Verify a URL is reachable before creating a project. */
  testConnection: (url) => req("POST", "/test-connection", { url }),

  // ── Export (returns download URLs) ──────────────────────────────────────────
  // With cookie-based auth, same-origin anchor clicks automatically include the
  // auth cookie — no need to append a ?token= query param.
  // For cross-origin static deployments (GitHub Pages + separate backend), the
  // backend must set CORS credentials headers; same-origin Docker/dev works out of box.
  /** @param {string} projectId @param {string} [status] @returns {string} Download URL. */
  exportZephyrUrl:   (projectId, status) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    const qs = params.toString();
    return `${BASE}/projects/${projectId}/tests/export/zephyr${qs ? `?${qs}` : ""}`;
  },
  /** @param {string} projectId @param {string} [status] @returns {string} Download URL. */
  exportTestRailUrl: (projectId, status) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    const qs = params.toString();
    return `${BASE}/projects/${projectId}/tests/export/testrail${qs ? `?${qs}` : ""}`;
  },
  /** @param {string} projectId @returns {Promise<Object>} Traceability matrix. */
  getTraceability:   (projectId)         => req("GET", `/projects/${projectId}/tests/traceability`),

  // ── System info & data management ───────────────────────────────────────────
  /** @returns {Promise<Object>} Uptime, Node/Playwright versions, memory, DB counts. */
  getSystemInfo:   () => req("GET",    "/system"),
  /** @returns {Promise<{cleared: number}>} Clear all run history. */
  clearRuns:       () => req("DELETE", "/data/runs"),
  /** @returns {Promise<{cleared: number}>} Clear activity log. */
  clearActivities: () => req("DELETE", "/data/activities"),
  /** @returns {Promise<{cleared: number}>} Clear self-healing history. */
  clearHealing:    () => req("DELETE", "/data/healing"),

  // ── AI Test Fix ──────────────────────────────────────────────────────────────

  /**
   * Stream an AI-generated fix for a failing test via SSE.
   *
   * @param   {string}                testId   - The test ID to fix.
   * @param   {function(string):void} onToken  - Called with each streamed token.
   * @param   {function({done: boolean, fixedCode: string, explanation: string, diff: string}):void} onDone - Called when the stream completes.
   * @param   {function(string):void} onError  - Called if the stream returns an error event.
   * @param   {AbortSignal}           [signal] - Optional abort signal to cancel the stream.
   * @returns {Promise<void>}
   */
  fixTest: async (testId, onToken, onDone, onError, signal) => {
    const res = await fetch(`${BASE}/tests/${testId}/fix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": getCsrfToken(),
      },
      body: JSON.stringify({}),
      credentials: "include",
      signal,
    });
    if (res.status === 401) {
      handleUnauthorized();
      throw new Error("Session expired. Please sign in again.");
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Fix request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") return;
        try {
          const parsed = JSON.parse(payload);
          if (parsed.error) { onError?.(parsed.error); return; }
          if (parsed.done) { onDone?.(parsed); return; }
          if (parsed.token) onToken(parsed.token);
        } catch { /* malformed SSE line — skip */ }
      }
    }
    // Flush any data remaining in the buffer after the stream closes.
    // This handles the case where the final SSE message straddles two read()
    // chunks and the trailing \n\n lands in the last chunk that sets done=true.
    if (buf.trim()) {
      const line = buf.trim();
      if (line.startsWith("data: ")) {
        try {
          const parsed = JSON.parse(line.slice(6).trim());
          if (parsed.error) { onError?.(parsed.error); return; }
          if (parsed.done) { onDone?.(parsed); return; }
        } catch { /* malformed — ignore */ }
      }
    }
  },

  /**
   * Apply an AI-generated fix to a test.
   * @param {string} testId - The test ID.
   * @param {string} code   - The fixed Playwright code.
   * @returns {Promise<Object>} The updated test object.
   */
  applyTestFix: (testId, code) => req("POST", `/tests/${testId}/apply-fix`, { code }),

  /**
   * Stream a chat message through the configured AI provider via SSE.
   *
   * @param   {Array<{role: string, content: string}>} messages - Full conversation history.
   * @param   {function(string):void}  onToken  - Called with each streamed token.
   * @param   {function(string):void}  onError  - Called if the stream returns an error event.
   * @param   {AbortSignal}            [signal] - Optional abort signal to cancel the stream.
   * @returns {Promise<void>}
   */
  chat: async (messages, onToken, onError, signal) => {
    const res = await fetch(`${BASE}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": getCsrfToken(),
      },
      body: JSON.stringify({ messages }),
      credentials: "include",
      signal,
    });
    if (res.status === 401) {
      handleUnauthorized();
      throw new Error("Session expired. Please sign in again.");
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Chat request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop(); // keep incomplete line in buffer
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") return;
        try {
          const parsed = JSON.parse(payload);
          if (parsed.error) { onError?.(parsed.error); return; }
          if (parsed.token) onToken(parsed.token);
        } catch { /* malformed SSE line — skip */ }
      }
    }
    // Flush any data remaining in the buffer after the stream closes.
    if (buf.trim()) {
      const line = buf.trim();
      if (line.startsWith("data: ")) {
        try {
          const parsed = JSON.parse(line.slice(6).trim());
          if (parsed.error) { onError?.(parsed.error); return; }
          if (parsed.token) onToken(parsed.token);
        } catch { /* malformed — ignore */ }
      }
    }
  },
};