/**
 * @module utils/metrics
 * @description INF-007 — Prometheus metrics registry and custom counters.
 *
 * Extracted from `middleware/appSetup.js` so call-sites (testRunner, crawler,
 * runRepo) can import the counters without pulling Express + Helmet + the
 * entire request-pipeline graph through their dependency tree.
 *
 * The registry is owned here; `appSetup.js` imports `register` to expose
 * `GET /metrics`. Default Node.js process metrics (heap, GC, event-loop lag,
 * file descriptors) are auto-collected via `prom-client.collectDefaultMetrics`.
 *
 * ### Naming convention
 * Counter names use a brand-neutral `app_` prefix per `docs/guide/rebranding.md`
 * — every product-name token in the codebase is a rebranding-surface item, and
 * Prometheus metric names baked into operator dashboards / alerts are
 * particularly painful to migrate after the fact. JS export identifiers
 * mirror the metric names (no product prefix) for the same reason.
 *
 * ### Custom counters
 * | Counter                    | Incremented at                                  |
 * |----------------------------|-------------------------------------------------|
 * | `app_runs_total`           | Every `runRepo.create()` call (all run types)   |
 * | `app_tests_executed_total` | Each result appended in `testRunner` / shard    |
 * | `app_crawl_pages_total`    | Each page persisted by `crawler.js`             |
 *
 * Counters are best-effort: `.inc()` is wrapped at call sites in `try/catch`
 * so a metric-registry hiccup never fails an actual run.
 */

import client from "prom-client";

export const register = new client.Registry();

// INF-007: `collectDefaultMetrics` starts an internal `setInterval` to sample
// process / heap / GC / event-loop stats. The returned handle is the timer
// reference — we `.unref()` it so an idle metrics tick can NEVER keep the
// Node event loop alive on its own.
//
// Without the `.unref()`:
//   - `npm test` would hang for up to 10s per test file after assertions
//     pass because `runner.summary()` only `process.exit()`s on failure
//     (see `tests/helpers/test-base.js:355`); on success the process must
//     idle out, and an active interval blocks that.
//   - CLI tooling that imports anything which transitively pulls in this
//     module (run-once scripts, migration runners, the `lint-migrations.mjs`
//     INF-008 helper) would have the same hang at exit.
//
// In production this is a no-op: the HTTP server, BullMQ worker, and SSE
// listeners all hold the event loop open on their own — the unref'd
// interval still fires every 10s for as long as the process is alive.
const _defaultMetricsTimer = client.collectDefaultMetrics({ register });
if (_defaultMetricsTimer && typeof _defaultMetricsTimer.unref === "function") {
  _defaultMetricsTimer.unref();
}

// ─── Histogram bucket presets ────────────────────────────────────────────────
// Bucket choice is the most important histogram tuning decision. Different
// metrics need different bucket sets so percentile estimates stay accurate
// over the realistic value range. Reused across the registrations below.
const HTTP_BUCKETS = [0.01, 0.05, 0.1, 0.3, 1, 3, 10];
const RUN_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 1800];
const AI_BUCKETS = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120];
const PIPELINE_BUCKETS = [0.5, 1, 3, 10, 30, 60, 180];

// ─── Run lifecycle ───────────────────────────────────────────────────────────
export const runsTotal = new client.Counter({
  name: "app_runs_total",
  help: "Total run records created. Labelled by run type so operators can split crawl vs. test_run vs. generate vs. record volume in dashboards.",
  labelNames: ["type"],
  registers: [register],
});

export const runOutcomeTotal = new client.Counter({
  name: "app_run_outcome_total",
  help: "Total runs that reached a terminal status. Combined with app_runs_total gives the per-type success rate via PromQL: sum(rate(app_run_outcome_total{status='completed'}[5m])) / sum(rate(app_runs_total[5m])).",
  labelNames: ["type", "status"],
  registers: [register],
});

export const runDurationSeconds = new client.Histogram({
  name: "app_run_duration_seconds",
  help: "End-to-end run duration (start → terminal status), in seconds. Answers 'what's slow?' for the platform's most expensive operation.",
  labelNames: ["type", "status"],
  buckets: RUN_BUCKETS,
  registers: [register],
});

// ─── Individual test execution ───────────────────────────────────────────────
export const testsExecutedTotal = new client.Counter({
  name: "app_tests_executed_total",
  help: "Total individual test executions that actually ran (passed + warning + failed). Skipped tests are pre-seeded at the route layer and never reach the increment site, so this is a clean 'tests-that-ran' counter.",
  labelNames: ["status", "browser"],
  registers: [register],
});

export const testDurationSeconds = new client.Histogram({
  name: "app_test_duration_seconds",
  help: "Per-test execution duration in seconds. Drives p50/p95/p99 latency dashboards split by browser engine and outcome.",
  labelNames: ["status", "browser"],
  buckets: RUN_BUCKETS,
  registers: [register],
});

// ─── Crawler ─────────────────────────────────────────────────────────────────
export const crawlPagesTotal = new client.Counter({
  name: "app_crawl_pages_total",
  help: "Total pages discovered by the crawler. Labelled by explorer mode so link-crawl vs. state-exploration cost can be tracked independently.",
  labelNames: ["mode"],
  registers: [register],
});

// ─── 8-stage AI pipeline ─────────────────────────────────────────────────────
export const pipelineStageDurationSeconds = new client.Histogram({
  name: "app_pipeline_stage_duration_seconds",
  help: "Wall-clock duration per pipeline stage. `stage` ∈ {crawl, filter, classify, generate, dedup, enhance, validate, persist}. Pinpoints which stage of the 8-stage pipeline is slow without re-running with verbose logging.",
  labelNames: ["stage"],
  buckets: PIPELINE_BUCKETS,
  registers: [register],
});

// ─── AI provider calls (unit-economics critical for SaaS) ────────────────────
export const aiProviderLatencySeconds = new client.Histogram({
  name: "app_ai_provider_latency_seconds",
  help: "Latency of outbound LLM calls. `provider` ∈ {anthropic, openai, google, openrouter, ollama, compat}; `outcome` ∈ {success, rate_limited, error}. Histograms enable p99 SLO dashboards per provider so a degraded vendor can be detected and the fallback chain (FEA-003) verified.",
  labelNames: ["provider", "outcome"],
  buckets: AI_BUCKETS,
  registers: [register],
});

export const aiProviderTokensTotal = new client.Counter({
  name: "app_ai_provider_tokens_total",
  help: "Total tokens consumed across all LLM calls. `kind` ∈ {input, output}. Combined with provider-specific pricing, this is the canonical SaaS unit-economics input: cost per workspace per day = sum(rate(app_ai_provider_tokens_total[1d])) × price_per_token.",
  labelNames: ["provider", "kind"],
  registers: [register],
});

export const aiProviderErrorsTotal = new client.Counter({
  name: "app_ai_provider_errors_total",
  help: "AI provider failures bucketed by category. `reason` ∈ {rate_limit, timeout, auth, server_error, network, unknown}. Drives the AI provider health alert and the circuit-breaker (FEA-003) trip decisions.",
  labelNames: ["provider", "reason"],
  registers: [register],
});

// ─── HTTP request layer (RED metrics) ────────────────────────────────────────
export const httpRequestDurationSeconds = new client.Histogram({
  name: "app_http_request_duration_seconds",
  help: "End-to-end HTTP request duration. `route` is the Express route template (e.g. `/api/v1/projects/:id`), NEVER the raw URL — raw URLs would explode cardinality and bankrupt the TSDB. Drives the platform-wide latency SLO.",
  labelNames: ["method", "route", "status"],
  buckets: HTTP_BUCKETS,
  registers: [register],
});

export const httpRequestsTotal = new client.Counter({
  name: "app_http_requests_total",
  help: "Total HTTP requests bucketed by method / route template / status. Same RED dimensions as the duration histogram — by-status request rate gives the platform error-rate SLI: sum(rate(app_http_requests_total{status=~'5..'}[5m])) / sum(rate(app_http_requests_total[5m])).",
  labelNames: ["method", "route", "status"],
  registers: [register],
});

// ─── Background queue / in-flight gauges ─────────────────────────────────────
export const queueDepth = new client.Gauge({
  name: "app_queue_depth",
  help: "Current BullMQ queue depth. `state` ∈ {waiting, active, delayed, failed, completed}. The single most operationally critical metric for a SaaS QA platform — `waiting` spiking signals customer-visible queueing delays before any other symptom surfaces.",
  labelNames: ["state"],
  registers: [register],
});

export const activeRuns = new client.Gauge({
  name: "app_active_runs",
  help: "Currently-running runs in process. Mirrors `runAbortControllers.size` for in-process execution and BullMQ active-job count for distributed mode. Set from the dashboard route's introspection block on each scrape via a setter helper.",
  labelNames: ["type"],
  registers: [register],
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * INF-007 — Record run-level outcome + duration metrics in one shot. Extracted
 * because three finalize sites (testRunner.js, crawler.js's description-mode
 * branch, and crawler.js's crawl-mode branch) each used a verbatim copy of
 * this 7-line try/catch block; a single helper keeps the label set + ms→s
 * conversion + best-effort guard in one place so future metric additions
 * (e.g. `app_run_total_seconds_quality_gate_outcome`) only need touching
 * here.
 *
 * Best-effort: a metrics-registry hiccup must never block the finalize
 * callback, so the whole body is wrapped in `try/catch`.
 *
 * @param {Object} run - Mutable run object (`type`, `status`, `duration` are read).
 * @param {string} [defaultType="unknown"] - Fallback when `run.type` is unset
 *   (description-mode passes `"generate"`, crawl-mode passes `"crawl"`).
 */
export function recordRunOutcome(run, defaultType = "unknown") {
  try {
    const labels = { type: run?.type || defaultType, status: run?.status || "completed" };
    runOutcomeTotal.inc(labels);
    const seconds = Number(run?.duration || 0) / 1000;
    if (Number.isFinite(seconds) && seconds >= 0) runDurationSeconds.observe(labels, seconds);
  } catch { /* best-effort */ }
}

/**
 * Map an Error / response object to an AI provider error reason label.
 * Constrains the label cardinality to a small, stable enumeration — never
 * emit raw error messages as labels (cardinality bomb).
 *
 * @param {unknown} err
 * @returns {"rate_limit"|"timeout"|"auth"|"server_error"|"network"|"unknown"}
 */
export function classifyAiError(err) {
  if (!err) return "unknown";
  const status = Number(err?.status || err?.statusCode || err?.response?.status);
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500 && status < 600) return "server_error";
  const msg = String(err?.message || err || "").toLowerCase();
  if (msg.includes("timeout") || msg.includes("etimedout")) return "timeout";
  if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("network")) return "network";
  return "unknown";
}
