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
 * REFACTOR-NOTE (post-AUTO-003b): this file groups ~24 endpoint families
 * into one object literal. Splitting into per-domain modules
 * (`api/projects.js`, `api/tests.js`, `api/activities.js`, etc.) would
 * shrink each file, surface duplicates at lint time (the previous bug
 * where `getActivities` was defined twice would have been impossible),
 * and let unused families tree-shake out of bundles. The split is
 * mechanical but global — every consumer's `import { api } from "./api.js"`
 * has to resolve to the same shape — so it deserves its own PR rather
 * than bundling with feature work. Tracked as a follow-up MNT item.
 *
 * @example
 * import { api } from "./api.js";
 *
 * const projects = await api.getProjects();
 * const { runId } = await api.crawl("PRJ-1");
 * const dashboard = await api.getDashboard();
 */

import { API_BASE, API_PATH, parseJsonResponse } from "./utils/apiBase.js";
import { getCsrfToken, setCsrfToken } from "./utils/csrf.js";

/** @type {string} Full base URL for API endpoints. Derived from {@link API_PATH} in `apiBase.js`. */
const BASE = API_PATH;

/** @type {number} Default request timeout in milliseconds (30 seconds). */
const TIMEOUT_DEFAULT = 30_000;
/** @type {number} Extended timeout for long-running operations like crawl and test runs (5 minutes). */
const TIMEOUT_LONG    = 300_000;

const BASE_URL = (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL) ? import.meta.env.BASE_URL : "/";

function toQuery(obj = {}) {
  const params = new URLSearchParams();
  for (const [k,v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((item) => params.append(k, String(item)));
    else params.set(k, String(v));
  }
  const q = params.toString();
  return q ? `?${q}` : "";
}

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
async function req(method, path, body, timeout = TIMEOUT_DEFAULT, opts = {}) {
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

  // Cross-origin: capture the CSRF token from the response header so
  // subsequent mutating requests can include it.  In same-origin deploys
  // this header is absent and setCsrfToken is a no-op.
  const csrfHeader = res.headers.get("X-CSRF-Token");
  if (csrfHeader) setCsrfToken(csrfHeader);

  if (res.status === 401 && !opts.skipUnauthorizedRedirect) {
    handleUnauthorized();
    throw new Error("Session expired. Please sign in again.");
  }

  if (!res.ok) {
    const err = await parseJsonResponse(res).catch(() => ({ error: res.statusText }));
    const error = new Error(err.error || res.statusText || "Request failed");
    // Attach the parsed response body so callers can inspect structured
    // fields (e.g. `error.body.code === "EMAIL_NOT_VERIFIED"`).
    error.body = err;
    error.status = res.status;
    throw error;
  }
  const data = await parseJsonResponse(res);
  // SEC-004: opt-in raw response (data + headers) so callers can read custom
  // response headers like `X-MFA-Grace-Period-Days-Remaining`. Default return
  // shape is unchanged so the existing ~50 callers keep working.
  if (opts.returnRaw) {
    const headers = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return { data, headers };
  }
  return data;
}

/**
 * Centralised API client. All methods return `Promise<Object>` (parsed JSON).
 * @namespace
 */
export const api = {
  
  getAgentRoles: () => req("GET", "/settings/agent-roles"),
  createAgentRole: (data) => req("POST", "/settings/agent-roles", data),
  updateAgentRole: (role, data) => req("PATCH", `/settings/agent-roles/${role}`, data),
  deleteAgentRole: (role) => req("DELETE", `/settings/agent-roles/${role}`),
  /**
   * AI-005 — Run the 1-token health probe for a single configured agent role.
   * Surfaces the same `{ ok, reason, provider }` shape the crawler pre-flight
   * uses, so the Settings UI "Test agent" button can show a green / red
   * badge inline without kicking off a real run.
   * @param {string} role - Canonical role name (planner, author, etc).
   * @returns {Promise<{role: string, ok: boolean, reason: string|null, provider: string|null}>}
   */
  testAgentRole: (role) => req("POST", `/settings/agent-roles/${role}/test`),

  // ── Provider Routes (B2/B3 — Settings UI) ──────────────────────────────────
  // Backend endpoints assumed per the B3.1 spec; companion PR adds them.
  // Until that lands, every call here returns a 404 and the tab renders its
  // empty / error state — no other surface depends on these helpers.
  /**
   * List every `provider_routes` row in the current workspace. Secret
   * blobs (`apiKeyEncrypted`, `apiKeyNonce`) are omitted by the repo's
   * default SELECT — only `apiKeyLastFour` comes back for UI display.
   * @returns {Promise<{routes: Array<Object>}>}
   */
  listProviderRoutes:   () => req("GET", "/settings/provider-routes"),
  /**
   * Create a new provider route. `apiKey` is plaintext on the wire,
   * encrypted server-side via `secrets.encryptKey` before persist.
   * @param {{name: string, family: string, protocol: string, baseUrl?: string|null, model: string, apiKey?: string|null, enabled?: boolean, rpmLimit?: number|null, tpmLimit?: number|null, cacheEnabled?: boolean, cacheTtlSec?: number, fallbackRouteId?: string|null}} payload
   */
  createProviderRoute:  (payload) => req("POST", "/settings/provider-routes", payload),
  /**
   * Partial-patch an existing route. Omit `apiKey` to keep the stored
   * key intact — rotation MUST go through `rotateProviderRouteKey`
   * (B3.6) so the audit row is tagged `action: "rotate_key"`.
   * @param {string} id
   * @param {Object} payload
   */
  updateProviderRoute:  (id, payload) => req("PATCH", `/settings/provider-routes/${id}`, payload),
  /** @param {string} id */
  deleteProviderRoute:  (id) => req("DELETE", `/settings/provider-routes/${id}`),
  /**
   * B2.2 — Run a real network capability probe and persist the result
   * to `provider_routes.capabilities`. Response carries the updated
   * row regardless of probe outcome — caller inspects
   * `capabilities.reachable` to render the badge.
   * @param {string} id
   * @returns {Promise<{ok: boolean, route: Object, capabilities: Object}>}
   */
  probeProviderRoute:   (id) => req("POST", `/settings/provider-routes/${id}/probe`),
  /**
   * B3.6 — Rotate the route's API key. New plaintext on the wire,
   * encrypted server-side. Server is expected to gate on a probe pass
   * before accepting the rotation (B3.6 "rejects on probe fail").
   * @param {string} id
   * @param {string} apiKey
   * @returns {Promise<{ok: boolean, lastFour: string}>}
   */
  rotateProviderRouteKey: (id, apiKey) => req("POST", `/settings/provider-routes/${id}/rotate-key`, { apiKey }),
  /**
   * B3.5 — Download a schema-v1 JSON dump of every provider_routes row
   * in the current workspace. Secrets are NEVER in the payload (only
   * `apiKeyLastFour` round-trips), so the file is safe to share with
   * another workspace's operator who'll re-supply keys out-of-band.
   *
   * Uses fetch + Blob so the cross-origin deploy path (cookies aren't
   * sent on bare anchor navigations there) keeps working. Same-origin
   * deploys could `window.open` the URL directly, but the Blob path
   * is uniform and trivially correct in both.
   *
   * Returns the parsed JSON payload AS WELL AS triggering a download —
   * callers that want to inspect the payload (e.g. to show "exported N
   * routes" inline) can use the return value without re-fetching.
   *
   * @returns {Promise<Object>} The schema-v1 payload.
   */
  exportRoutes: async () => {
    const url = `${BASE}/settings/provider-routes/export`;
    const res = await fetch(url, { credentials: "include" });
    const csrfHdr = res.headers.get("X-CSRF-Token");
    if (csrfHdr) setCsrfToken(csrfHdr);
    if (res.status === 401) { handleUnauthorized(); throw new Error("Session expired."); }
    if (!res.ok) {
      const err = await parseJsonResponse(res).catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Export failed (${res.status})`);
    }
    const blob = await res.blob();
    const disposition = res.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match?.[1] || `sentri-provider-routes-${new Date().toISOString().slice(0, 10)}.json`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
    // Re-parse so callers can read counts inline. Cheap — the export is
    // bounded by `provider_routes` rows per workspace, never a large blob.
    return JSON.parse(await blob.text());
  },
  /**
   * B3.5 — Upload a schema-v1 JSON file to upsert routes into the
   * current workspace. The file is read into memory client-side and
   * POSTed as the request body so the existing `req()` wrapper handles
   * auth + CSRF + JSON; no multipart needed since the file IS the
   * JSON body.
   *
   * @param {File}    file - Browser `File` from the upload input.
   * @param {"skip"|"overwrite"|"rename"} mode - Collision resolution.
   * @returns {Promise<{ok: boolean, created: number, overwritten: number, skipped: number, renamed: number, errors: Array, probesReachable: number, total: number}>}
   */
  importRoutes: async (file, mode) => {
    const text = await file.text();
    let payload;
    try { payload = JSON.parse(text); }
    catch { throw new Error("Selected file is not valid JSON."); }
    return req("POST", "/settings/provider-routes/import", { ...payload, mode });
  },
  /**
   * B3.9 — Paginated, filterable provider-routes audit log. Workspace-
   * scoped on the backend; admins see every mutation across every
   * route in the workspace. `metadata` round-trips as a JSON string;
   * the UI parses on render.
   *
   * @param {Object} [filters]
   * @param {string} [filters.routeId]  - Filter to one route's history.
   * @param {string} [filters.action]   - One of {create, update, delete, rotate_key, probe, export, import}.
   * @param {string} [filters.since]    - ISO timestamp; rows with `createdAt >= since`.
   * @param {string} [filters.before]   - ISO timestamp cursor; rows with `createdAt < before`.
   * @param {number} [filters.limit=50]
   * @returns {Promise<{ items: Array, nextCursor: string|null }>}
   */
  listProviderRouteAudit: (filters = {}) => {
    const params = new URLSearchParams();
    if (filters.routeId) params.set("routeId", filters.routeId);
    if (filters.action) params.set("action", filters.action);
    if (filters.since) params.set("since", filters.since);
    if (filters.before) params.set("before", filters.before);
    if (filters.limit != null) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return req("GET", `/settings/provider-routes/audit${qs ? `?${qs}` : ""}`);
  },
  /**
   * B2.5 — Paginated AI request-log viewer. Workspace-scoped on the
   * backend. Returns the same cursor shape as `listProviderRouteAudit`
   * for UI consistency. `promptRedacted` / `responseRedacted` carry
   * PII-stripped content under `redacted` mode, raw content under
   * `full` mode, and `null` under `none` (the workspace default).
   *
   * @param {Object} [filters]
   * @param {string} [filters.routeId]
   * @param {string} [filters.agentRole]
   * @param {string} [filters.traceId]
   * @param {string} [filters.outcome]    - `success` | `error` | `rate_limited`
   * @param {string} [filters.before]     - ISO timestamp cursor
   * @param {number} [filters.limit=50]
   * @returns {Promise<{ items: Array, nextCursor: string|null }>}
   */
  listAiRequests: (filters = {}) => {
    const params = new URLSearchParams();
    if (filters.routeId) params.set("routeId", filters.routeId);
    if (filters.agentRole) params.set("agentRole", filters.agentRole);
    if (filters.traceId) params.set("traceId", filters.traceId);
    if (filters.outcome) params.set("outcome", filters.outcome);
    if (filters.before) params.set("before", filters.before);
    if (filters.limit != null) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return req("GET", `/settings/ai-requests${qs ? `?${qs}` : ""}`);
  },
  /**
   * B2.5 — Replay a logged AI request. The server refuses with HTTP
   * 400 when the row was captured under storage mode `none` (no prompt
   * stored) or `redacted` (replaying sentinel strings is meaningless).
   * Pass `routeId` to dispatch the replay against a different route
   * than the original — useful for "would this work on a cheaper
   * model?" debugging.
   *
   * @param {string} id - Request log id (`air-<uuid>`).
   * @param {{ routeId?: string }} [opts]
   * @returns {Promise<{ ok: boolean, replayedFrom: string, routeId: string|null, text: string }>}
   */
  replayAiRequest: (id, opts = {}) =>
    req("POST", `/settings/ai-requests/${id}/replay`, opts || {}),

// ── Projects ────────────────────────────────────────────────────────────────
  /** @param {Object} data - `{ name, url, credentials? }` */
  createProject: (data) => req("POST", "/projects", data),
  /** @returns {Promise<Array>} List of all projects. */
  getProjects:   ()     => req("GET",  "/projects"),
  /** @param {string} id - Project ID (e.g. `"PRJ-1"`). */
  getProject:    (id)   => req("GET",  `/projects/${id}`),
  /**
   * Update a project's name, URL, and/or credentials.
   * @param {string} id   - Project ID.
   * @param {Object} data - `{ name, url, credentials? }`.
   */
  updateProject: (id, data) => req("PATCH", `/projects/${id}`, data),
  /** @param {string} id - Deletes project and all its tests, runs, and history. */
  deleteProject: (id)   => req("DELETE", `/projects/${id}`),
  /**
   * List candidate URLs for the recorder Start-URL dropdown — seed URL plus
   * any pages discovered on the latest successful crawl.
   * @param {string} id - Project ID.
   * @returns {Promise<{urls: string[]}>}
   */
  getProjectPages: (id) => req("GET", `/projects/${id}/pages`),

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
   * @param {Object} [body] - Optional `{ dialsConfig, budgetMinutes }`.
   *   `budgetMinutes` (AUTO-001) caps wall-clock dispatch time — risk-ordered
   *   tests fill the budget first, low-risk tests are recorded as
   *   `status: "skipped"` + `skipReason: "over_budget"` on the run. Server
   *   caps the value at `MAX_BUDGET_MINUTES` (240).
   */
  runTests:      (id, body) => req("POST", `/projects/${id}/run`, body || undefined, TIMEOUT_LONG),
  /** @param {string} testId - Execute a single test. */
  runSingleTest: (testId)=> req("POST", `/tests/${testId}/run`,  undefined, TIMEOUT_LONG),

  // ── Tests ───────────────────────────────────────────────────────────────────
  /** @param {string} id - Project ID. Returns tests for that project. */
  getTests:     (id)                => req("GET",    `/projects/${id}/tests`),
  /**
   * Get tests for a project with server-side pagination and optional filters.
   * @param {string} id       - Project ID.
   * @param {number} [page=1]
   * @param {number} [pageSize=10]
   * @param {Object} [filters]
   * @param {string} [filters.reviewStatus] - "draft", "approved", "rejected", or "all".
   * @param {string} [filters.category]     - "api", "ui", or "all".
   * @param {string} [filters.search]       - Free-text search.
   * @returns {Promise<{data: Object[], meta: {total: number, page: number, pageSize: number, hasMore: boolean}}>}
   */
  getTestsPaged: (id, page = 1, pageSize = 10, filters = {}) => {
    const params = new URLSearchParams({ page, pageSize });
    if (filters.reviewStatus && filters.reviewStatus !== "all") params.set("reviewStatus", filters.reviewStatus);
    if (filters.category && filters.category !== "all") params.set("category", filters.category);
    if (filters.search) params.set("search", filters.search);
    if (filters.stale) params.set("stale", "true");
    return req("GET", `/projects/${id}/tests?${params}`);
  },
  /**
   * Get per-status test counts for a project (lightweight — no row data).
   * @param {string} id - Project ID.
   * @returns {Promise<{draft: number, approved: number, rejected: number, total: number}>}
   */
  getTestCounts: (id) => req("GET", `/projects/${id}/tests/counts`),
  /**
   * Workspace-wide per-status test counts — powers the Review Queue's
   * tab badges in one round-trip. Same filter shape as `getAllTestsPaged`
   * minus `reviewStatus` (which is what we're partitioning) and `sortBy`
   * (irrelevant for COUNT). Replaces the previous trio of `pageSize: 1`
   * paginated probes that fired on every filter change.
   *
   * @param {Object} [filters]
   * @param {string} [filters.category]   - "api" | "ui" | "journey"
   * @param {string} [filters.search]
   * @param {string} [filters.projectId]  - Narrow to a single project.
   * @param {boolean} [filters.stale]
   * @returns {Promise<{draft: number, approved: number, rejected: number, total: number}>}
   */
  getReviewQueueCounts: (filters = {}) => {
    const params = new URLSearchParams();
    if (filters.category && filters.category !== "all") params.set("category", filters.category);
    if (filters.search) params.set("search", filters.search);
    if (filters.projectId && filters.projectId !== "all") params.set("projectId", filters.projectId);
    if (filters.stale) params.set("stale", "true");
    const qs = params.toString();
    return req("GET", `/tests/counts${qs ? `?${qs}` : ""}`);
  },
  /**
   * GAP-001 (audit) — Global data search across tests, projects, and runs.
   * Powers the ⌘K command palette's data-search layer. Workspace-scoped
   * server-side; cross-tenant rows are filtered out by `projectRepo.getAll`
   * before the LIKE queries run.
   *
   * Returns an empty payload (not an error) when `q.length < 2` so the
   * palette can render a "type to search" hint cleanly.
   *
   * @param {string} q - Free-text search query (caller is responsible for
   *                     debouncing the keystroke firehose; backend caps q
   *                     at 200 chars).
   * @returns {Promise<{
   *   query: string,
   *   groups: {
   *     projects: Array<{id: string, name: string, url: string}>,
   *     tests:    Array<{id: string, name: string, projectId: string, projectName: string|null, reviewStatus: string}>,
   *     runs:     Array<{id: string, projectId: string, projectName: string|null, type: string, status: string, startedAt: string}>,
   *   },
   *   totalCount: number,
   *   truncated: boolean,
   * }>}
   */
  search: (q) => req("GET", `/search?q=${encodeURIComponent(q || "")}`),
  /** @returns {Promise<Array>} All tests across all projects. */
  getAllTests:   ()                  => req("GET",    "/tests"),
  /**
   * Cross-project paginated tests with optional filters — used by the
   * Review Queue so it doesn't have to fetch the entire workspace.
   * @param {number} [page=1]
   * @param {number} [pageSize=50]
   * @param {Object} [filters]
   * @param {string} [filters.reviewStatus] - "draft" | "approved" | "rejected"
   * @param {string} [filters.category]     - "api" | "ui"
   * @param {string} [filters.search]
   * @param {string} [filters.projectId]    - Narrow to a single project (must be in workspace).
   * @param {string} [filters.sortBy]       - "newest" | "oldest" | "quality" | "name".
   *                                          Forwarded as-is to the backend so the
   *                                          ORDER BY happens BEFORE pagination —
   *                                          a client-side sort would only reorder
   *                                          the current page's rows. Unknown
   *                                          values fall back to "newest" server-side.
   * @returns {Promise<{data: Object[], meta: {total: number, page: number, pageSize: number, hasMore: boolean}}>}
   */
  getAllTestsPaged: (page = 1, pageSize = 50, filters = {}) => {
    const params = new URLSearchParams({ page, pageSize });
    if (filters.reviewStatus && filters.reviewStatus !== "all") params.set("reviewStatus", filters.reviewStatus);
    if (filters.category && filters.category !== "all") params.set("category", filters.category);
    if (filters.search) params.set("search", filters.search);
    if (filters.projectId && filters.projectId !== "all") params.set("projectId", filters.projectId);
    if (filters.stale) params.set("stale", "true");
    if (filters.sortBy) params.set("sortBy", filters.sortBy);
    return req("GET", `/tests?${params}`);
  },
  /** @param {string} testId */
  getTest:      (testId)            => req("GET",    `/tests/${testId}`),
  /** @param {string} testId @param {Object} data - Fields to update. */
  updateTest:   (testId, data)      => req("PATCH",  `/tests/${testId}`, data),

  uploadTestFixture: (testId, payload) => req("POST", `/tests/${testId}/fixtures`, payload),
  getTestFixtures: (testId) => req("GET", `/tests/${testId}/fixtures`),

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
  /** @param {string} projectId @param {string} testId @param {Object} [body] - `{ reviewComment?: string }` */
  approveTest:     (projectId, testId, body) => req("PATCH", `/projects/${projectId}/tests/${testId}/approve`, body || undefined),
  /** @param {string} projectId @param {string} testId @param {Object} [body] - `{ reviewComment?: string }` */
  rejectTest:      (projectId, testId, body) => req("PATCH", `/projects/${projectId}/tests/${testId}/reject`, body || undefined),
  /** @param {string} projectId @param {string} testId - Restore to Draft. */
  restoreTest:     (projectId, testId) => req("PATCH", `/projects/${projectId}/tests/${testId}/restore`),
  /**
   * Revoke an approval (auto- or human-approved) back to draft (AUTO-003b).
   * Clears the four provenance columns (`approvalSource`, `approvalThreshold`,
   * `approvedAt`, `approvedBy`) so a future approval writes a fresh
   * decision-time snapshot. `qa_lead`+ on the backend.
   * @param {string} testId
   */
  revokeApproval:  (testId) => req("POST", `/tests/${testId}/revoke`),
  /**
   * List activity-log rows, optionally filtered by `type` and/or `projectId`.
   * Workspace-scoped on the backend (`backend/src/routes/system.js`).
   * Used by `pages/ApprovalsTimeline.jsx` to fetch `test.auto_approve` and
   * `test.approve` rows for the daily-grouped audit feed.
   * @param {{ type?: string, projectId?: string, limit?: number }} [filters]
   */
  getActivities:   (filters = {}) => {
    const params = new URLSearchParams();
    if (filters.type) params.set("type", filters.type);
    if (filters.projectId) params.set("projectId", filters.projectId);
    // ENT-004 (audit) — per-entity scoping. Pass-through to the route's
    // `testId = ?` filter so TestDetail's "View activity" link can hit
    // the same workspace-scoped activities endpoint without pulling the
    // whole project's feed and filtering client-side.
    if (filters.testId) params.set("testId", filters.testId);
    // ENT-004 (migration 055) — matching per-run filter. RunDetail's
    // "View activity →" deep-link uses `?runId=` for server-side
    // filtering via the indexed `activities.runId` column.
    if (filters.runId) params.set("runId", filters.runId);
    if (filters.after) params.set("after", filters.after);
    if (filters.before) params.set("before", filters.before);
    if (filters.limit != null) params.set("limit", String(filters.limit));
    if (filters.offset != null) params.set("offset", String(filters.offset));
    const qs = params.toString();
    return req("GET", `/activities${qs ? `?${qs}` : ""}`);
  },
  /**
   * Approval-decision counts for a project (AUTO-003b) — powers the
   * project-settings calibration line under the `autoApproveThreshold` input.
   * @param {string} projectId
   * @returns {Promise<{human: number, auto: number, draft: number, total: number}>}
   */
  getApprovalStats: (projectId) => req("GET", `/projects/${projectId}/approval-stats`),

  // AUTO-015b: most-recent deployment-triggered run for this project within
  // the last 24h. Powers the "Last deployment run" badge on the project
  // header. Returns `{ run: null }` when there's no qualifying activity.
  getLastDeploymentRun: (projectId) => req("GET", `/projects/${projectId}/last-deployment-run`),
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

  // ── Visual regression baselines (DIF-001) ──────────────────────────────────
  /**
   * List saved visual baselines for a test.
   * @param {string} testId
   * @returns {Promise<Array<{testId: string, stepNumber: number, imagePath: string, width: number|null, height: number|null, createdAt: string, updatedAt: string}>>}
   */
  getBaselines: (testId) => req("GET", `/tests/${testId}/baselines`),
  /**
   * Accept a captured screenshot from an earlier run as the new baseline for
   * the given test + step. Called from the "Accept visual changes" action.
   * @param {string} testId
   * @param {number} stepNumber - 0 for the final screenshot; >= 1 for per-step captures.
   * @param {string} runId
   */
  acceptBaseline: (testId, stepNumber, runId) =>
    req("POST", `/tests/${testId}/baselines/${stepNumber}/accept`, { runId }),
  /**
   * Delete a baseline so the next run generates a fresh one.
   * @param {string} testId
   * @param {number} stepNumber
   */
  deleteBaseline: (testId, stepNumber) =>
    req("DELETE", `/tests/${testId}/baselines/${stepNumber}`),

  // ── Interactive browser recorder (DIF-015) ─────────────────────────────────
  /**
   * Start an interactive recording session. The browser opens server-side
   * and streams a live CDP screencast to the returned `sessionId` over SSE.
   * @param {string} projectId
   * @param {Object} [body] - `{ startUrl?: string }`
   * @returns {Promise<{sessionId: string, startUrl: string}>}
   */
  recordStart: (projectId, body) => req("POST", `/projects/${projectId}/record`, body || {}),
  /**
   * Stop an in-flight recording and persist the captured actions as a
   * Draft Playwright test.
   * @param {string} projectId
   * @param {string} sessionId
   * @param {Object} body - `{ name: string }`
   * @returns {Promise<{test: Object, actionCount: number}>}
   */
  recordStop: (projectId, sessionId, body) =>
    req("POST", `/projects/${projectId}/record/${sessionId}/stop`, body || {}),
  /**
   * Abort an in-flight recording without persisting a Draft test. Used when
   * the user clicks "Discard" in the RecorderModal — closes the browser
   * server-side and returns `{ ok, discarded: true }`.
   * @param {string} projectId
   * @param {string} sessionId
   * @returns {Promise<{ok: boolean, discarded: boolean}>}
   */
  recordDiscard: (projectId, sessionId) =>
    req("POST", `/projects/${projectId}/record/${sessionId}/stop`, { discard: true }),
  /**
   * Poll a live recording session for status and captured-action preview.
   * @param {string} projectId
   * @param {string} sessionId
   */
  recordStatus: (projectId, sessionId) =>
    req("GET", `/projects/${projectId}/record/${sessionId}`),
  /**
   * Forward a single input event from the canvas overlay to the headless
   * browser. Called at pointer/keyboard event frequency (~60fps on fast
   * machines) so it intentionally skips JSON response parsing on success.
   * @param {string} projectId
   * @param {string} sessionId
   * @param {Object} event - { type, x?, y?, button?, key?, text?, ... }
   */
  recordInput: (projectId, sessionId, event) =>
    req("POST", `/projects/${projectId}/record/${sessionId}/input`, event),
  /**
   * Add a manual assertion action during recording.
   * @param {string} projectId
   * @param {string} sessionId
   * @param {{kind: "assertVisible"|"assertText"|"assertValue"|"assertUrl", selector?: string, label?: string, value?: string}} action
   */
  recordAddAssertion: (projectId, sessionId, action) =>
    req("POST", `/projects/${projectId}/record/${sessionId}/assertion`, action),
  recordPause: (projectId, sessionId) =>
    req("POST", `/projects/${projectId}/record/${sessionId}/pause`, {}),
  recordResume: (projectId, sessionId) =>
    req("POST", `/projects/${projectId}/record/${sessionId}/resume`, {}),
  recordPopLast: (projectId, sessionId) =>
    req("POST", `/projects/${projectId}/record/${sessionId}/pop-last`, {}),
  /**
   * DIF-015c Gap 5 — switch the active device profile mid-recording.
   * The server tears down the current page+context and rebuilds them at
   * the new descriptor. Captured `actions[]` survive; page state does not.
   * Returns `{ device, viewport: {width, height}, url }` so the caller
   * can resize the canvas and reconcile its viewport state.
   * @param {string} projectId
   * @param {string} sessionId
   * @param {string} device - One of `DEVICE_PRESETS[].value` (empty string = desktop default).
   */
  recordSwitchDevice: (projectId, sessionId, device) =>
    req("POST", `/projects/${projectId}/record/${sessionId}/device`, { device }),
  /**
   * DIF-015c Gap 2 (point-and-click assert UX) — read-only probe that
   * resolves the `{selector, label, rect}` for an arbitrary viewport
   * coordinate. Used by `LiveBrowserView` in assert-mode to highlight the
   * hovered element and pre-fill the verification form on click. Returns
   * `{ probe: null }` when no interactive ancestor is found.
   * @param {string} projectId
   * @param {string} sessionId
   * @param {{x: number, y: number}} point - Viewport coordinates (scaled).
   */
  recordProbe: (projectId, sessionId, point) =>
    req("POST", `/projects/${projectId}/record/${sessionId}/probe`, point),

  // ── Runs ────────────────────────────────────────────────────────────────────
  /** @param {string} id - Project ID. Returns runs sorted newest-first. */
  getRuns:   (id)    => req("GET", `/projects/${id}/runs`),
  /**
   * Get runs for a project with server-side pagination.
   * @param {string} id       - Project ID.
   * @param {number} [page=1]
   * @param {number} [pageSize=10]
   * @returns {Promise<{data: Object[], meta: {total: number, page: number, pageSize: number, hasMore: boolean}}>}
   */
  getRunsPaged: (id, page = 1, pageSize = 10) =>
    req("GET", `/projects/${id}/runs?page=${page}&pageSize=${pageSize}`),
  /** @param {string} runId - Get full run detail with per-test results. */
  getRun:    (runId) => req("GET", `/runs/${runId}`),
  getRunCompare: (runId, otherRunId) => req("GET", `/runs/${runId}/compare/${otherRunId}`),
  /** @param {string} runId - Abort a running crawl or test run. */
  abortRun:  (runId) => req("POST", `/runs/${runId}/abort`),

  // ── CI/CD Trigger tokens ─────────────────────────────────────────────────
  /**
   * List all trigger tokens for a project.
   * @param {string} projectId
   * @returns {Promise<Array<{id: string, label: string|null, createdAt: string, lastUsedAt: string|null}>>}
   */
  getTriggerTokens: (projectId) => req("GET", `/projects/${projectId}/trigger-tokens`),
  /**
   * Create a new trigger token. Returns the plaintext token exactly once.
   * @param {string}  projectId
   * @param {Object}  [body]         - `{ label?: string }`
   * @returns {Promise<{id: string, token: string, label: string|null, createdAt: string}>}
   */
  createTriggerToken: (projectId, body) => req("POST", `/projects/${projectId}/trigger-tokens`, body),
  /**
   * Revoke (permanently delete) a trigger token.
   * @param {string} projectId
   * @param {string} tokenId
   */
  deleteTriggerToken: (projectId, tokenId) => req("DELETE", `/projects/${projectId}/trigger-tokens/${tokenId}`),

  // ── Quality Gates (AUTO-012) ────────────────────────────────────────────────
  /**
   * Get the quality-gate config for a project, or null if unconfigured.
   * Viewer+ can read.
   * @param {string} projectId
   * @returns {Promise<{qualityGates: {minPassRate?: number, maxFlakyPct?: number, maxFailures?: number} | null}>}
   */
  getQualityGates: (projectId) => req("GET", `/projects/${projectId}/quality-gates`),
  /**
   * Create or update the quality-gate config (qa_lead+).
   * Server validates ranges (`minPassRate`/`maxFlakyPct` ∈ [0,100], `maxFailures` ≥ 0 integer).
   * @param {string} projectId
   * @param {{minPassRate?: number, maxFlakyPct?: number, maxFailures?: number}} gates
   * @returns {Promise<{qualityGates: Object|null}>}
   */
  updateQualityGates: (projectId, gates) =>
    req("PATCH", `/projects/${projectId}/quality-gates`, { qualityGates: gates }),
  /**
   * Clear the quality-gate config (qa_lead+) — runs will report `gateResult: null`.
   * @param {string} projectId
   * @returns {Promise<{ok: boolean, qualityGates: null}>}
   */
  deleteQualityGates: (projectId) => req("DELETE", `/projects/${projectId}/quality-gates`),

  // ── Web Vitals Budgets (AUTO-017) ───────────────────────────────────────────
  /**
   * Get the Web Vitals budgets config for a project, or null if unconfigured.
   * Viewer+ can read.
   * @param {string} projectId
   * @returns {Promise<{webVitalsBudgets: {lcp?: number, cls?: number, inp?: number, ttfb?: number} | null}>}
   */
  getWebVitalsBudgets: (projectId) => req("GET", `/projects/${projectId}/web-vitals-budgets`),
  /**
   * Create or update the Web Vitals budgets config (qa_lead+).
   * Server validates each field as a non-negative finite number; payload must
   * include at least one of `lcp`, `cls`, `inp`, `ttfb`.
   * @param {string} projectId
   * @param {{lcp?: number, cls?: number, inp?: number, ttfb?: number}} budgets
   * @returns {Promise<{webVitalsBudgets: Object|null}>}
   */
  updateWebVitalsBudgets: (projectId, budgets) =>
    req("PATCH", `/projects/${projectId}/web-vitals-budgets`, { webVitalsBudgets: budgets }),
  /**
   * Clear the Web Vitals budgets (qa_lead+) — runs will report `webVitalsResult: null`.
   * @param {string} projectId
   * @returns {Promise<{ok: boolean, webVitalsBudgets: null}>}
   */
  deleteWebVitalsBudgets: (projectId) => req("DELETE", `/projects/${projectId}/web-vitals-budgets`),

  // ── Project metric samples (MET-001 / AUTO-017.3) ───────────────────────────
  /**
   * Read a project's time-series samples for a single `metricKey`. Powers
   * the `<TrendChart>` instances in `ProjectQualityCard`'s Web Vitals tab
   * (`webVitals.lcp` / `.cls` / `.inp` / `.ttfb`) and any future per-project
   * trend surface. Server caps `limit` at 200; the chart slices to 30.
   *
   * @param {string} projectId
   * @param {string} metricKey - e.g. `"webVitals.lcp"`.
   * @param {Object} [opts]
   * @param {number} [opts.since=0] - Lower-bound timestamp (epoch ms).
   * @param {number} [opts.limit=200]
   * @returns {Promise<{samples: Array<{ts: number, value: number, tags: Object|null}>}>}
   */
  getProjectMetric: (projectId, metricKey, { since = 0, limit = 200 } = {}) => {
    const params = new URLSearchParams({ key: metricKey });
    if (since) params.set("since", String(since));
    if (limit !== 200) params.set("limit", String(limit));
    return req("GET", `/projects/${projectId}/metrics?${params}`);
  },

  // ── Notifications (FEA-001) ──────────────────────────────────────────────────
  /**
   * Get the notification settings for a project, or null if none exist.
   * @param {string} projectId
   * @returns {Promise<{notifications: Object|null}>}
   */
  getNotifications: (projectId) => req("GET", `/projects/${projectId}/notifications`),
  /**
   * Create or update notification settings for a project.
   * @param {string} projectId
   * @param {{ teamsWebhookUrl: string, emailRecipients: string, webhookUrl: string, enabled: boolean }} body
   * @returns {Promise<{ok: boolean, notifications: Object}>}
   */
  upsertNotifications: (projectId, body) => req("PATCH", `/projects/${projectId}/notifications`, body),
  /**
   * Remove notification settings for a project.
   * @param {string} projectId
   * @returns {Promise<{ok: boolean}>}
   */
  deleteNotifications: (projectId) => req("DELETE", `/projects/${projectId}/notifications`),

  // ── Schedules (ENH-006) ─────────────────────────────────────────────────────
  /**
   * Get the cron schedule for a project, or null if none exists.
   * @param {string} projectId
   * @returns {Promise<{schedule: Object|null}>}
   */
  getSchedule: (projectId) => req("GET", `/projects/${projectId}/schedule`),
  /**
   * Create or update the cron schedule for a project.
   * @param {string} projectId
   * @param {{ cronExpr: string, timezone: string, enabled: boolean }} body
   * @returns {Promise<{ok: boolean, schedule: Object}>}
   */
  upsertSchedule: (projectId, body) => req("PATCH", `/projects/${projectId}/schedule`, body),
  /**
   * Remove the cron schedule for a project.
   * @param {string} projectId
   * @returns {Promise<{ok: boolean}>}
   */
  deleteSchedule: (projectId) => req("DELETE", `/projects/${projectId}/schedule`),


  // ── Environments (DIF-012) ───────────────────────────────────────────────
  /** @param {string} projectId */
  getProjectEnvironments:    (projectId)               => req("GET",    `/projects/${projectId}/environments`),
  /** @param {string} projectId @param {{name: string, baseUrl: string, credentials?: Object}} payload */
  createProjectEnvironment:  (projectId, payload)      => req("POST",   `/projects/${projectId}/environments`, payload),
  /** @param {string} projectId @param {string} environmentId @param {Object} payload */
  updateProjectEnvironment:  (projectId, environmentId, payload) =>
    req("PATCH", `/projects/${projectId}/environments/${environmentId}`, payload),
  /** @param {string} projectId @param {string} environmentId */
  deleteProjectEnvironment:  (projectId, environmentId) =>
    req("DELETE", `/projects/${projectId}/environments/${environmentId}`),

  // ── Dashboard ───────────────────────────────────────────────────────────────
  /** @returns {Promise<Object>} Analytics: pass rate, defects, flaky tests, MTTR, etc. */
  getDashboard: () => req("GET", "/dashboard"),
  /**
   * AUTO-009 — read the 30-day project-wide coverage trend.
   *
   * Backed by `GET /api/v1/dashboard`'s `coverageTrend` block. The
   * `projectId` parameter narrows the series to one project client-side.
   *
   * **Consumers:** `ProjectQualityCard.jsx` → Coverage tab (fetches the
   * per-project series on mount to render a latest-% badge + text sparkline
   * without navigating to the Dashboard). The Dashboard `CoveragePanel`
   * reads `data.coverageTrend` directly from `getDashboard()` instead
   * (avoids a second fetch for the workspace-wide view).
   *
   * @param {string} [projectId] — Narrow the series to one project.
   * @returns {Promise<Object|null>}
   */
  getCoverageTrend: (projectId) => req("GET", "/dashboard").then((d) => {
    const trend = d?.coverageTrend;
    if (!trend?.series?.length) return null;
    if (!projectId) return trend;
    const series = trend.series.filter((p) => p.projectId === projectId);
    return series.length > 0 ? { ...trend, series } : null;
  }),
  /**
   * AUTO-022 — read the per-case breakdown for one AI eval-harness run.
   * Powers the Dashboard `EvalPanel` drill-down side panel.
   *
   * @param {string} runId - UUID minted by `persistEvalRun` when the harness
   *                         ran with `--persist`.
   * @returns {Promise<{runId: string, createdAt: string|null, cases: Array<{
   *   caseId: string, category: string,
   *   score: { aggregate: number, selectors: number, actions: number, assertions: number },
   *   expected: string|null, actual: string|null
   * }>}>}
   */
  getEvalRunDetail: (runId) => req("GET", `/dashboard/eval/${runId}`),

  // ── Healing Dashboard (CAP-004) ─────────────────────────────────────────────
  /**
   * Self-healing telemetry summary across the current workspace.
   * Powers the `/healing` page: per-strategy success rates, top-healed
   * selectors (deduplicated, sorted by real heal count), the
   * "tests that would have failed without healing" estimate, and the
   * `healing.savings` metric-sample trend (merged across all projects in
   * the workspace by timestamp).
   *
   * @returns {Promise<{
   *   strategies: Array<{ strategyIndex: number, total: number, successes: number, successRate: number }>,
   *   topSelectors: Array<{ selector: string, healCount: number, totalCount: number }>,
   *   estimates: { testsThatWouldHaveFailed: number },
   *   savingsTrend: Array<{ ts: number, value: number }>,
   * }>}
   */
  getHealingSummary: () => req("GET", "/healing/summary"),

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
  saveApiKey: (provider, apiKey, opts = {}) =>
    provider === "local"
      ? req("POST", "/settings", { provider, ...opts })
      : provider?.startsWith("compat:")
      ? req("POST", "/settings", { provider, apiKey, ...opts })
      : req("POST", "/settings", { provider, apiKey }),
  /** @param {string} provider - Remove API key or deactivate Ollama. */
  deleteApiKey: (provider) => req("DELETE", `/settings/${provider}`),
  /** @returns {Promise<{projects: Object[]}>} GitHub PR check settings per project. */
  getGithubCheckSettings: () => req("GET", "/settings/github-checks"),
  /** @param {string} projectId @returns {Promise<{url: string}>} GitHub App install redirect URL. */
  getGithubInstallStartUrl: (projectId) => req("GET", `/integrations/github/install/start/${projectId}`),
  /** @param {string} projectId @param {{enabled: boolean, repo?: string, installationId?: string}} body */
  updateGithubCheckSettings: (projectId, body) => req("PATCH", `/settings/github-checks/${projectId}`, body),

  // ── Ollama ──────────────────────────────────────────────────────────────────
  /** @returns {Promise<{ok: boolean, model?: string, availableModels?: string[], error?: string}>} */
  getOllamaStatus: () => req("GET", "/ollama/status"),

  // ── URL reachability ────────────────────────────────────────────────────────
  /** @param {string} url - Verify a URL is reachable before creating a project. */
  testConnection: (url) => req("POST", "/test-connection", { url }),

  // ── Export (download helpers) ────────────────────────────────────────────────
  // With cookie-based auth, same-origin anchor clicks automatically include the
  // auth cookie. For cross-origin deploys (GitHub Pages + Render), we use fetch
  // with credentials: "include" and trigger a Blob download programmatically.

  /**
   * Build export URL for a given format.
   * @param {string} projectId @param {string} format @param {string} [status]
   * @returns {string}
   * @private
   */
  _exportUrl: (projectId, format, status) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    const qs = params.toString();
    return `${BASE}/projects/${projectId}/tests/export/${format}${qs ? `?${qs}` : ""}`;
  },

  /**
   * Download an export file. Uses a simple <a> navigation for same-origin,
   * or fetch + Blob for cross-origin (where cookies aren't sent on navigations).
   * @param {string} projectId @param {string} format @param {string} [status]
   * @returns {Promise<void>}
   */
  downloadExport: async (projectId, format, status) => {
    const url = api._exportUrl(projectId, format, status);
    // Same-origin: simple navigation works (cookies sent automatically)
    if (!API_BASE || new URL(url).origin === window.location.origin) {
      window.open(url, "_blank");
      return;
    }
    // Cross-origin: fetch with credentials and trigger Blob download
    const res = await fetch(url, { credentials: "include" });
    const csrfHdr = res.headers.get("X-CSRF-Token");
    if (csrfHdr) setCsrfToken(csrfHdr);
    if (res.status === 401) { handleUnauthorized(); throw new Error("Session expired."); }
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    const blob = await res.blob();
    const disposition = res.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match?.[1] || `export-${format}.csv`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  },

  /** @param {string} projectId @param {string} [status] @returns {string} Download URL (same-origin only). */
  exportZephyrUrl:   (projectId, status) => api._exportUrl(projectId, "zephyr", status),
  /** @param {string} projectId @param {string} [status] @returns {string} Download URL (same-origin only). */
  exportTestRailUrl: (projectId, status) => api._exportUrl(projectId, "testrail", status),

  /**
   * Download a runnable Playwright project ZIP for the given project (DIF-006).
   * Endpoint path differs from the CSV exports (`/projects/:id/export/playwright`
   * vs `/projects/:id/tests/export/:format`), so it can't reuse `_exportUrl`.
   * Filters to approved tests server-side — no `status` param is accepted.
   * @param {string} projectId
   * @returns {Promise<void>}
   */
  downloadPlaywrightExport: async (projectId) => {
    const url = `${BASE}/projects/${projectId}/export/playwright`;
    if (!API_BASE || new URL(url).origin === window.location.origin) {
      window.open(url, "_blank");
      return;
    }
    const res = await fetch(url, { credentials: "include" });
    const csrfHdr = res.headers.get("X-CSRF-Token");
    if (csrfHdr) setCsrfToken(csrfHdr);
    if (res.status === 401) { handleUnauthorized(); throw new Error("Session expired."); }
    if (!res.ok) throw new Error(`Playwright export failed (${res.status})`);
    const blob = await res.blob();
    const disposition = res.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match?.[1] || `sentri-${projectId}-playwright.zip`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  },
  /** @param {string} projectId @returns {Promise<Object>} Traceability matrix. */
  getTraceability:   (projectId)         => req("GET", `/projects/${projectId}/tests/traceability`),

  // ── Auth (login, register, forgot/reset password, verify, OAuth) ─────────────
  // These endpoints intentionally return 401/403 for invalid credentials or
  // unverified accounts — NOT expired sessions. skipUnauthorizedRedirect
  // prevents req() from intercepting 401 and showing "Session expired".
  /**
   * Log in with email and password.
   * @param {{ email: string, password: string }} body
   * @returns {Promise<Object>}
   */
  /**
   * Log in. Uses `returnRaw` so the caller can read the
   * `X-MFA-Grace-Period-Days-Remaining` header set by the backend when the
   * workspace requires MFA but the user is still within grace.
   * @returns {Promise<{data: Object, headers: Object<string,string>}>}
   */
  login: (body) => req("POST", "/auth/login", body, TIMEOUT_DEFAULT, { skipUnauthorizedRedirect: true, returnRaw: true }),
  /**
   * Register a new account.
   * @param {{ name: string, email: string, password: string }} body
   * @returns {Promise<Object>}
   */
  register: (body) => req("POST", "/auth/register", body, TIMEOUT_DEFAULT, { skipUnauthorizedRedirect: true }),
  /**
   * Request a password reset link for the given email.
   * @param {string} email
   * @returns {Promise<Object>}
   */
  forgotPassword: (email) => req("POST", "/auth/forgot-password", { email }),
  /**
   * Reset password using a token from the reset email.
   * @param {string} token
   * @param {string} newPassword
   * @returns {Promise<Object>}
   */
  resetPassword: (token, newPassword) => req("POST", "/auth/reset-password", { token, newPassword }),
  /**
   * Verify an email address using a signed token from the verification email.
   * @param {string} token
   * @returns {Promise<Object>}
   */
  verifyEmail: (token) => req("GET", `/auth/verify?token=${encodeURIComponent(token)}`, undefined, TIMEOUT_DEFAULT, { skipUnauthorizedRedirect: true }),
  /**
   * Exchange an OAuth authorization code for a session.
   *
   * SEC-004: returns `{ data, headers }` via `returnRaw` so the caller can
   * read the `X-MFA-Grace-Period-Days-Remaining` header the backend sets on
   * a successful OAuth callback when the user's workspace requires MFA but
   * they're still inside the grace window. Without this, the post-grace
   * banner only fires for password-login users, not OAuth users.
   *
   * @param {string} provider - `"github"` or `"google"`.
   * @param {string} code     - Authorization code from the OAuth redirect.
   * @returns {Promise<{data: Object, headers: Object<string,string>}>}
   */
  oauthCallback: (provider, code) => req("GET", `/auth/${provider}/callback?code=${encodeURIComponent(code)}`, undefined, TIMEOUT_DEFAULT, { skipUnauthorizedRedirect: true, returnRaw: true }),

  // ── Email verification (SEC-001) ──────────────────────────────────────────────
  /**
   * Resend the email verification link for an unverified account.
   * @param {string} email - The email address of the unverified account.
   * @returns {Promise<{message: string}>}
   */
  resendVerification: (email) => req("POST", "/auth/resend-verification", { email }),

  // ── MFA / TOTP (SEC-004) ────────────────────────────────────────────────────
  /**
   * Submit a 6-digit TOTP or recovery code during the login challenge.
   * Public — authenticated by the `pendingToken` from `/auth/login`.
   * @param {string} pendingToken
   * @param {string} token - 6-digit TOTP code OR an 8-char recovery code.
   */
  mfaVerify: (pendingToken, token) => req("POST", "/auth/mfa/verify", { pendingToken, token }, TIMEOUT_DEFAULT, { skipUnauthorizedRedirect: true }),
  /** @returns {Promise<{enabled: boolean}>} */
  mfaStatus: () => req("GET", "/auth/mfa/status"),
  /**
   * Aggregate view of every second factor — TOTP, recovery count, passkeys.
   * @returns {Promise<{totp: boolean, recoveryCodesRemaining: number, webauthn: Array<{id: string, deviceName: string|null, transports: string[], createdAt: string, lastUsedAt: string|null}>}>}
   */
  mfaFactors: () => req("GET", "/auth/mfa/factors"),
  /**
   * Begin TOTP enrollment — returns the otpauth URL for QR rendering.
   * @returns {Promise<{secret: string, otpauth: string}>}
   */
  mfaEnroll: () => req("POST", "/auth/mfa/enroll"),
  /**
   * Finalize TOTP enrollment by verifying the user's first code.
   * @param {string} token
   * @returns {Promise<{ok: boolean, recoveryCodes: string[]}>}
   */
  mfaEnable: (token) => req("POST", "/auth/mfa/enable", { token }),
  /**
   * Disable MFA. Clears TOTP secret + recovery codes. Password required for
   * non-OAuth-only users (OAuth-only authenticates by session).
   * @param {string} [password]
   */
  mfaDisable: (password) => req("POST", "/auth/mfa/disable", { password }),
  /**
   * Regenerate the set of one-time recovery codes. Invalidates the previous
   * set. Returns the raw codes (shown once — save immediately).
   * @param {string} [password]
   * @returns {Promise<{recoveryCodes: string[]}>}
   */
  mfaRegenerateRecoveryCodes: (password) =>
    req("POST", "/auth/mfa/recovery-codes/regenerate", { password }),

  // ── WebAuthn / passkeys (SEC-004) ───────────────────────────────────────────
  /**
   * Begin passkey registration — returns options for `startRegistration()`
   * from `@simplewebauthn/browser` plus a challengeToken for verify.
   * @returns {Promise<{options: Object, challengeToken: string}>}
   */
  webauthnRegisterOptions: () => req("POST", "/auth/webauthn/register/options"),
  /**
   * Submit the browser's attestation to finalise passkey registration.
   * @param {string} challengeToken
   * @param {Object} attestation - The browser's `PublicKeyCredential` shape.
   * @param {string} [deviceName] - User-supplied label.
   */
  webauthnRegisterVerify: (challengeToken, attestation, deviceName) =>
    req("POST", "/auth/webauthn/register/verify", { challengeToken, attestation, deviceName }),
  /**
   * Begin passkey authentication during the login challenge. Returns options
   * for `startAuthentication()`. Public — uses the `pendingToken` from `/login`.
   * @param {string} pendingToken
   * @returns {Promise<{options: Object, challengeToken: string}>}
   */
  webauthnAuthOptions: (pendingToken) =>
    req("POST", "/auth/webauthn/authenticate/options", { pendingToken }, TIMEOUT_DEFAULT, { skipUnauthorizedRedirect: true }),
  /**
   * Submit the browser's assertion to complete passkey authentication.
   * On success the auth cookie is set with `amr: ["pwd","mfa"]`.
   * @param {string} challengeToken
   * @param {Object} assertion - The browser's `PublicKeyCredential` shape.
   */
  webauthnAuthVerify: (challengeToken, assertion) =>
    req("POST", "/auth/webauthn/authenticate/verify", { challengeToken, assertion }, TIMEOUT_DEFAULT, { skipUnauthorizedRedirect: true }),
  /** @returns {Promise<{credentials: Array<{id: string, deviceName: string|null, transports: string[], createdAt: string, lastUsedAt: string|null}>}>} */
  webauthnListCredentials: () => req("GET", "/auth/webauthn/credentials"),
  /**
   * Remove a passkey. Password required for non-OAuth-only users. Rejects
   * with 400 `MFA_LAST_FACTOR_PROTECTED` when removing it would lock the
   * user out under workspace MFA enforcement.
   * @param {string} id
   * @param {string} [password]
   */
  webauthnDeleteCredential: (id, password) =>
    req("DELETE", `/auth/webauthn/credentials/${id}`, { password }),

  // ── Workspace MFA compliance (SEC-004, admin) ──────────────────────────────
  /**
   * Admin-only — preview enrollment status before flipping the enforcement
   * toggle.
   * @returns {Promise<{totalMembers: number, enrolled: number, notEnrolled: number, members: Array<{userId: string, name: string, email: string, role: string, mfaEnabled: boolean}>}>}
   */
  getWorkspaceMfaCompliance: () => req("GET", "/workspaces/current/mfa-compliance"),
  /**
   * SEC-007: workspace-scoped audit log with cursor pagination.
   * @param {string} workspaceId — Must match the authenticated workspace; the
   *   backend returns 403 `AUDIT_WORKSPACE_MISMATCH` on mismatch.
   * @param {{ userId?: string, type?: string|string[], dateFrom?: string, dateTo?: string, ipAddress?: string, cursor?: string, limit?: number }} [filters]
   * @returns {Promise<{ rows: Object[], nextCursor: string|null }>}
   */
  getWorkspaceAuditLog: (workspaceId, filters = {}) => req("GET", `/workspaces/${workspaceId}/audit-log${toQuery(filters)}`),
  /**
   * Trigger a CSV or NDJSON export of the current page of audit-log rows.
   * Same filter shape as `getWorkspaceAuditLog`. The backend sets
   * `Content-Disposition: attachment` so callers can either
   * `window.location.assign` the URL or stream via fetch + Blob.
   * @param {string} workspaceId
   * @param {Object} [filters]
   * @param {"csv"|"ndjson"} [format="csv"]
   */
  exportWorkspaceAuditLog: (workspaceId, filters = {}, format = "csv") => req("GET", `/workspaces/${workspaceId}/audit-log${toQuery({ ...filters, format })}`),
  /**
   * Verify the audit-log hash chain for the current workspace. Returns
   * `{ verified: true, chainDisabled: true }` when `AUDIT_HASH_CHAIN` is
   * unset on the server.
   * @returns {Promise<{ verified: boolean, chainDisabled?: boolean, total?: number, firstBrokenRowId?: string }>}
   */
  verifyAuditChain: () => req("GET", "/audit/verify"),
  /**
   * SEC-007: list deployment-wide security events (workspaceId =
   * SYSTEM_WORKSPACE_ID sentinel). Surfaces rows that have no resolvable
   * tenant — chiefly `auth.login.failed` against unknown emails. Admin-only,
   * cross-tenant by design.
   * @param {{ type?: string, after?: string, before?: string, limit?: number, offset?: number }} [filters]
   * @returns {Promise<{ rows: Object[], count: number }>}
   */
  getSystemSecurityEvents: (filters = {}) => req("GET", `/system/security-events${toQuery(filters)}`),
  /**
   * SEC-007: list SIEM dead-letter queue entries for the workspace. Used by
   * the AuditLog DLQ inspector to render the "N retry-failed" badge and the
   * per-row replay actions.
   * @param {string} workspaceId
   * @param {{ limit?: number }} [filters]
   * @returns {Promise<{ rows: Array<{id: string, workspaceId: string, rowSnapshot: Object|null, lastError: string, attempts: number, createdAt: string}>, count: number }>}
   */
  listAuditDlq: (workspaceId, filters = {}) => req("GET", `/workspaces/${workspaceId}/audit-log/dlq${toQuery(filters)}`),
  /**
   * Re-dispatch a DLQ entry against the SIEM forwarder. Returns
   * `503 SIEM_NOT_CONFIGURED` when no SIEM target is configured for
   * the workspace.
   * @param {string} workspaceId
   * @param {string} dlqId
   * @returns {Promise<{ ok: boolean, id: string, replayedAt: string }>}
   */
  replayAuditDlq: (workspaceId, dlqId) => req("POST", `/workspaces/${workspaceId}/audit-log/dlq/${dlqId}/replay`),
  /**
   * SEC-007 Part C: read the per-workspace SIEM forwarder config.
   * Server returns the masked `hmacSecret` (`••••••••<last4>`) so admins
   * can confirm which secret is configured without exposing it.
   * @param {string} workspaceId
   * @returns {Promise<{ config: { workspaceId: string, targetUrl: string, hmacSecret: string, headers: Object|null, enabled: boolean, createdAt: string, updatedAt: string } | null }>}
   */
  getWorkspaceSiemConfig: (workspaceId) => req("GET", `/workspaces/${workspaceId}/siem-config`),
  /**
   * SEC-007 Part C: upsert the per-workspace SIEM forwarder config.
   * The plaintext `hmacSecret` is sent on every save (the server encrypts
   * it at rest); subsequent reads only return the masked form.
   * @param {string} workspaceId
   * @param {{ targetUrl: string, hmacSecret: string, headers?: Object|null, enabled?: boolean }} config
   */
  upsertWorkspaceSiemConfig: (workspaceId, config) => req("PUT", `/workspaces/${workspaceId}/siem-config`, config),
  /**
   * SEC-007 Part C: delete the per-workspace SIEM forwarder config.
   * Idempotent — `removed: false` when no config existed.
   * @param {string} workspaceId
   * @returns {Promise<{ ok: boolean, removed: boolean }>}
   */
  deleteWorkspaceSiemConfig: (workspaceId) => req("DELETE", `/workspaces/${workspaceId}/siem-config`),

  // ── Account data portability / deletion (SEC-003) ───────────────────────────
  /**
   * Export account data as JSON. Password confirmation is required.
   *
   * NOTE: This intentionally bypasses `req()` because it needs a custom
   * `X-Account-Password` header for password confirmation. It replicates
   * the 401 handling via `handleUnauthorized()` and includes
   * `credentials: "include"` for the HttpOnly auth cookie.
   *
   * @param {string} password
   * @returns {Promise<Object>}
   */
  exportAccountData: async (password) => {
    const res = await fetch(`${BASE}/auth/export`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Account-Password": password,
      },
      credentials: "include",
    });
    // Capture CSRF token from response header (cross-origin support)
    const csrfHdr = res.headers.get("X-CSRF-Token");
    if (csrfHdr) setCsrfToken(csrfHdr);
    if (res.status === 401) {
      handleUnauthorized();
      throw new Error("Session expired. Please sign in again.");
    }
    // 403 = wrong password confirmation — do NOT trigger logout redirect.
    if (!res.ok) {
      const err = await parseJsonResponse(res).catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText || "Request failed");
    }
    return parseJsonResponse(res);
  },
  /**
   * Delete user account and owned data. Password confirmation is required.
   * @param {string} password
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  deleteAccount: (password) => req("DELETE", "/auth/account", { password }),

  // ── Workspace & Members (ACL-001, ACL-002) ───────────────────────────────────
  /** @returns {Promise<Object>} Current workspace details. */
  getWorkspace:      ()              => req("GET",    "/workspaces/current"),
  /** @returns {Promise<Array>} All workspaces the user belongs to. */
  getWorkspaces:     ()              => req("GET",    "/workspaces"),
  /** @param {string} workspaceId — Switch to a different workspace. Returns updated user. */
  switchWorkspace:   (workspaceId)   => req("POST",   "/workspaces/switch", { workspaceId }),
  /** @param {Object} data - `{ name?, slug? }` */
  updateWorkspace:   (data)          => req("PATCH",  "/workspaces/current", data),
  /** @returns {Promise<Array>} List of workspace members with roles. */
  getMembers:        ()              => req("GET",    "/workspaces/current/members"),
  /** @param {Object} data - `{ email, role? }` */
  inviteMember:      (data)          => req("POST",   "/workspaces/current/members", data),
  /** @param {string} userId @param {string} role */
  updateMemberRole:  (userId, role)  => req("PATCH",  `/workspaces/current/members/${userId}`, { role }),
  /** @param {string} userId */
  removeMember:      (userId)        => req("DELETE", `/workspaces/current/members/${userId}`),

  // ── System info & data management ───────────────────────────────────────────
  /** @returns {Promise<Object>} Uptime, Node/Playwright versions, memory, DB counts. */
  getSystemInfo:   () => req("GET",    "/system"),
  /**
   * MNT-001 — vision-capable LLM provider availability check. Used by
   * `VisionHealingPanel` on mount to disable the `pixelmatch_and_llm` radio
   * (with a tooltip) when no vision-capable model is configured server-side,
   * rather than waiting for a save-time `VISION_PROVIDER_NOT_CONFIGURED`
   * error. Backend resolves via `aiProvider.hasVisionProvider()` /
   * `resolveVisionModel()` (`backend/src/routes/system.js`).
   *
   * @returns {Promise<{available: boolean, model: string|null}>}
   */
  getVisionProviderStatus: () => req("GET", "/system/vision-provider-status"),
  /** @returns {Promise<{cleared: number}>} Clear all run history. */
  clearRuns:       () => req("DELETE", "/data/runs"),
  // NOTE: `getActivities` is defined once above (in the Test review actions
  // block). A duplicate definition previously lived here and silently won
  // over the first per JS object-literal semantics, producing dead code and
  // a subtle behaviour divergence (`filters.limit` truthy check vs
  // `!= null`). Consolidated to a single definition — do not re-add here.
  /** @returns {Promise<{cleared: number}>} Clear activity log. */
  clearActivities: () => req("DELETE", "/data/activities"),
  /** @returns {Promise<{cleared: number}>} Clear self-healing history. */
  clearHealing:    () => req("DELETE", "/data/healing"),

  // ── Recycle bin ──────────────────────────────────────────────────────────────

  /** @returns {Promise<{projects: Object[], tests: Object[], runs: Object[]}>} All soft-deleted entities. */
  getRecycleBin:   () => req("GET",    "/recycle-bin"),
  /** @param {"project"|"test"|"run"} type @param {string} id @returns {Promise<{ok: boolean}>} */
  restoreItem:     (type, id) => req("POST",   `/restore/${type}/${id}`),
  /** @param {"project"|"test"|"run"} type @param {string} id @returns {Promise<{ok: boolean}>} */
  purgeItem:       (type, id) => req("DELETE", `/purge/${type}/${id}`),

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
    // Capture CSRF token from response header (cross-origin support)
    const csrfHeader = res.headers.get("X-CSRF-Token");
    if (csrfHeader) setCsrfToken(csrfHeader);
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
  chat: async (messages, onToken, onError, signal, context = null) => {
    const res = await fetch(`${BASE}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": getCsrfToken(),
      },
      body: JSON.stringify({ messages, context }),
      credentials: "include",
      signal,
    });
    // Capture CSRF token from response header (cross-origin support)
    const csrfHeader = res.headers.get("X-CSRF-Token");
    if (csrfHeader) setCsrfToken(csrfHeader);
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
