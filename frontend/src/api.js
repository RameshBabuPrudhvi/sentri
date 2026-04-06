/**
 * @module api
 * @description Centralised API client for all backend communication.
 *
 * Every page and component uses `api.*` methods instead of raw `fetch`.
 * Provides automatic timeout, JSON parsing with non-JSON error guard,
 * and structured error messages.
 *
 * @example
 * import { api } from "./api.js";
 *
 * const projects = await api.getProjects();
 * const { runId } = await api.crawl("PRJ-1");
 * const dashboard = await api.getDashboard();
 */

import { API_BASE, parseJsonResponse } from "./utils/api.js";

/** @type {string} Full base URL for API endpoints (e.g. `"/api"` or `"https://backend.example.com/api"`). */
const BASE = `${API_BASE}/api`;

/** @type {number} Default request timeout in milliseconds (30 seconds). */
const TIMEOUT_DEFAULT = 30_000;
/** @type {number} Extended timeout for long-running operations like crawl and test runs (5 minutes). */
const TIMEOUT_LONG    = 300_000;

/**
 * Internal fetch wrapper with timeout, JSON parsing, and error handling.
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
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error("Request timed out. Please try again.");
    throw err;
  }
  clearTimeout(timer);

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
  /** @param {string} id - Execute all approved tests for a project. */
  runTests:      (id)    => req("POST", `/projects/${id}/run`,   undefined, TIMEOUT_LONG),
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

  // ── Export (returns download URLs, not JSON) ────────────────────────────────
  /** @param {string} projectId @param {string} [status] @returns {string} Download URL. */
  exportZephyrUrl:   (projectId, status) => `${BASE}/projects/${projectId}/tests/export/zephyr${status ? `?status=${status}` : ""}`,
  /** @param {string} projectId @param {string} [status] @returns {string} Download URL. */
  exportTestRailUrl: (projectId, status) => `${BASE}/projects/${projectId}/tests/export/testrail${status ? `?status=${status}` : ""}`,
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
};
