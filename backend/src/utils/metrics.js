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

// INF-007: `collectDefaultMetrics` registers process / heap / GC / event-loop
// collectors. In `prom-client` v15 the function returns `void` (the v14 timer
// handle was removed), so there is no public API surface to `.unref()` the
// internal handles — notably the `perf_hooks.monitorEventLoopDelay()` handle
// behind `nodejs_eventloop_lag_*` keeps the loop alive on its own.
//
// Test/CLI exit is handled at the test runner instead: `tests/helpers/
// test-base.js#summary` calls `process.exit(0)` on success rather than
// relying on the event loop draining. This matches the pattern used by
// node:test / Jest / Mocha and is robust against any future dep that
// transitively keeps handles ref'd.
//
// In production this is a no-op anyway: the HTTP server, BullMQ worker, and
// SSE listeners all hold the event loop open on their own.
client.collectDefaultMetrics({ register });

// ─── Histogram bucket presets ────────────────────────────────────────────────
// Bucket choice is the most important histogram tuning decision. Different
// metrics need different bucket sets so percentile estimates stay accurate
// over the realistic value range. Reused across the registrations below.
const HTTP_BUCKETS = [0.01, 0.05, 0.1, 0.3, 1, 3, 10];
const RUN_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 1800];
const AI_BUCKETS = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120];
const PIPELINE_BUCKETS = [0.5, 1, 3, 10, 30, 60, 180];
const REVIEW_ROUND_BUCKETS = [0, 1, 2, 3];

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
//
// MNT-001b — every AI-call counter carries an `operation` label
// (`generation` | `vision_heal`) so the dashboards can split SaaS cost-
// per-customer per surface. Existing call sites in aiProvider.js pass
// `"generation"` by default; the vision-heal path in `callVisionModel`
// passes `"vision_heal"` so token / latency / cost / error rates can be
// attributed to the healing waterfall vs. test-generation traffic.
//
// Migration note for dashboards: queries that previously aggregated
// across `{provider, kind}` will now see two rows per (provider, kind)
// — one per operation. Update Grafana queries to `sum(...) by (kind)`
// or filter `operation="generation"` to recover the old shape.
export const aiProviderLatencySeconds = new client.Histogram({
  name: "app_ai_provider_latency_seconds",
  help: "Latency of outbound LLM calls. `provider` ∈ {anthropic, openai, google, openrouter, ollama, compat}; `outcome` ∈ {success, rate_limited, error}; `operation` ∈ {generation, vision_heal}. Histograms enable p99 SLO dashboards per provider so a degraded vendor can be detected and the fallback chain (FEA-003) verified.",
  labelNames: ["provider", "agent_role", "outcome", "operation", "route_name"],
  buckets: AI_BUCKETS,
  registers: [register],
});

export const aiProviderTokensTotal = new client.Counter({
  name: "app_ai_provider_tokens_total",
  help: "Total tokens consumed across all LLM calls. `kind` ∈ {input, output}; `operation` ∈ {generation, vision_heal}. Combined with provider-specific pricing, this is the canonical SaaS unit-economics input: cost per workspace per day = sum(rate(app_ai_provider_tokens_total[1d])) × price_per_token, split by operation so vision-heal cost can be tracked against the per-project budget cap.",
  labelNames: ["provider", "agent_role", "kind", "operation", "route_name"],
  registers: [register],
});

export const aiProviderErrorsTotal = new client.Counter({
  name: "app_ai_provider_errors_total",
  help: "AI provider failures bucketed by category. `reason` ∈ {rate_limit, rate_limit_local, spend_cap_exceeded, timeout, auth, server_error, network, unknown}; `operation` ∈ {generation, vision_heal}. `rate_limit` = vendor-side 429; `rate_limit_local` = B3.7 quotaGuard rejected before SDK; `spend_cap_exceeded` = B3.7 workspace USD cap reached. Drives the AI provider health alert and the circuit-breaker (FEA-003) trip decisions.",
  labelNames: ["provider", "agent_role", "reason", "operation", "route_name"],
  registers: [register],
});

// AI-003 — cumulative LLM spend in USD, bucketed by provider + operation.
// Every adapter call (generation + vision_heal) increments this from the
// per-(provider, model) catalog in `aiProvider/modelCatalog.js`. Models
// missing pricing emit `costUsd: null` from adapters and are SKIPPED on
// the counter — distinguishing "no data" from "$0" matters for accuracy:
// dashboards that divide by workspace_active_count must not be biased by
// fake zeros. Vision-heal falls back to the MNT-001 $5/M-input + $15/M-
// output midpoint estimate when the resolved vision model isn't in the
// catalog so the budget circuit-breaker still has *some* signal.
//
// Pricing data is maintainer-owned in modelCatalog.js#MODEL_PRICING with an
// `asOf` field per entry — see docs/guide/ai-cost-tracking.md for the
// vendor-price refresh workflow.
export const aiProviderCostUsdTotal = new client.Counter({
  name: "app_ai_cost_usd_total",
  help: "Cumulative LLM spend in USD, bucketed by provider + operation. Computed per call from the per-(provider, model) catalog at aiProvider/modelCatalog.js#MODEL_PRICING. Catalog misses emit no increment (no fake zeros); known-free models (Ollama) emit increment of 0. Vision-heal uses the MNT-001 $5/M input + $15/M output midpoint when the model isn't in the catalog. SaaS unit-economics dashboard divides by workspace count to get cost-per-customer.",
  labelNames: ["provider", "agent_role", "operation", "route_name"],
  registers: [register],
});

// B3.8 — Response-cache telemetry. Three counters give the operator a
// per-route view of cache effectiveness:
//
//   • hits / misses → hit rate per route + role
//   • savings_usd  → cumulative dollars saved (sum of `costUsd` from the
//                    original dispatch on every hit)
//
// All three carry `route_name` + `agent_role` to match the existing AI
// dispatch label set. `route_name` is operator-controlled free text,
// same cardinality concern documented in `aiProviderLatencySeconds`.
export const aiCacheHitsTotal = new client.Counter({
  name: "app_ai_cache_hits_total",
  help: "B3.8 — Response cache hits. Each increment represents one AI call returned from `ai_response_cache` instead of dispatching to the provider. Combined with misses, gives the cache hit rate; combined with savings_usd, gives the spend reduction operators get from caching deterministic prompts.",
  labelNames: ["route_name", "agent_role"],
  registers: [register],
});

export const aiCacheMissesTotal = new client.Counter({
  name: "app_ai_cache_misses_total",
  help: "B3.8 — Response cache misses. Includes both first-time prompts (cold cache) and TTL expiries. Hit rate = hits / (hits + misses).",
  labelNames: ["route_name", "agent_role"],
  registers: [register],
});

export const aiCacheSavingsUsdTotal = new client.Counter({
  name: "app_ai_cache_savings_usd_total",
  help: "B3.8 — Cumulative USD saved by cache hits. Computed by summing the `costUsd` field stored alongside each cached response, so the metric represents what the operator WOULD have paid had the cache been disabled. Catalog-miss responses contribute 0.",
  labelNames: ["route_name", "agent_role"],
  registers: [register],
});

// MNT-001b — budget circuit-breaker trip counter. Increments every time
// stage 8 is skipped due to per-project daily-call OR monthly-cost cap.
// Drives the `VisionHealBudgetExhausted` alert in alerts.yml — any non-zero
// value over a 1h window fires the warning so an operator visits the
// project's Vision Healing tab to confirm intent (legitimate cap hit) or
// raise the cap.
//
// The `projectId` label is intentionally unbounded — Prometheus operators
// who run very large multi-tenant deployments can drop it via relabel_configs
// if cardinality is a concern; the default for self-hosted Sentri (single
// digits to low hundreds of projects) is well within the comfort zone.
export const visionHealBudgetExhaustedTotal = new client.Counter({
  name: "app_vision_heal_budget_exhausted_total",
  help: "Stage-8 LLM vision heals skipped due to budget cap. Labelled by projectId and reason (daily_calls vs monthly_cost). The presence of any non-zero value over a 1h window fires the VisionHealBudgetExhausted alert — operator visits the project's Vision Healing tab to confirm intent or raise the cap. Runbook: docs/guide/vision-healing.md#incident-disable.",
  labelNames: ["projectId", "reason"],
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

// AUTO-023 B3.3 — reviewer↔author loop termination visibility.
//
// `outcome` is the bounded terminal enum from `agentLoop.js`:
// `accept` | `max_rounds` | `timeout` | `quota_exhausted` | `reject_final`.
//
// Naming: Prometheus convention reserves the `_total` suffix for Counters
// (so `*_total_bucket` / `*_total_sum` / `*_total_count` series read
// cleanly when histograms auto-expand). This is a Histogram, so the
// metric name is `app_agent_review_rounds` (no `_total`). The JS export
// keeps a literal name match.
//
// Observation contract: the loop calls `observe({ outcome }, round)` once
// per terminal path with the 0-indexed round (-1 sentinel for "timeout /
// quota_exhausted fired before round 0 completed"). The metric clamps
// `round` into the `[0, 1, 2, 3]` bucket range via `Math.max(0, …)` at
// the call site (`agentLoop.js#observeLoopOutcome`), so the `-1`
// sentinel collapses into the same bucket as "accept on round 0" in
// the histogram. The structured `round` field on `runReviewerAuthorLoop`'s
// return value preserves the distinction for callers that need it.
export const agentReviewRounds = new client.Histogram({
  name: "app_agent_review_rounds",
  help: "Reviewer↔author loop rounds completed before termination. `round` index is 0-based and bucketed 0..3 to mirror Bundle-3 defaults. Labelled by terminal outcome (`accept` / `max_rounds` / `timeout` / `quota_exhausted` / `reject_final`) for operator debugging.",
  labelNames: ["outcome"],
  buckets: REVIEW_ROUND_BUCKETS,
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
 * @returns {"rate_limit"|"rate_limit_local"|"spend_cap_exceeded"|"timeout"|"auth"|"server_error"|"network"|"unknown"}
 */
export function classifyAiError(err) {
  if (!err) return "unknown";
  // B4.2 — typed `.code` errors thrown by the dispatcher's pre-call gates
  // (B3.7 `quotaGuard`) deserve their own reason buckets so dashboards can
  // distinguish "we rejected the call locally" (operator config / workspace
  // policy) from "the vendor rejected it" (rate_limit / auth / server_error).
  // Without this branch every `ERR_RATE_LIMIT_LOCAL` lands under
  // `reason="unknown"` alongside genuinely unclassifiable failures, which
  // (a) hides the most actionable signal — a route's `rpmLimit`/`tpmLimit`
  // is too tight — inside a noisy bucket, and (b) bankrupts the
  // observability runbook recipe at `docs/guide/observability.md` (which
  // documents `reason="rate_limit_local"` as the rate-limit-rejection key).
  // Check `.code` BEFORE status / message heuristics so a typed error wins
  // over any incidental status that happens to be set on the Error object.
  if (err?.code === "ERR_RATE_LIMIT_LOCAL") return "rate_limit_local";
  if (err?.code === "ERR_SPEND_CAP_EXCEEDED") return "spend_cap_exceeded";
  const status = Number(err?.status || err?.statusCode || err?.response?.status);
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500 && status < 600) return "server_error";
  const msg = String(err?.message || err || "").toLowerCase();
  if (msg.includes("timeout") || msg.includes("etimedout")) return "timeout";
  if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("network")) return "network";
  return "unknown";
}
