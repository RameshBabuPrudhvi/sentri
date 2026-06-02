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
  help: "Total runs that reached a terminal status. Combined with app_runs_total gives the per-type success rate via PromQL: sum(rate(app_run_outcome_total{status='completed'}[5m])) / sum(rate(app_runs_total[5m])). B3: `projectId` label added so per-project rejection-rate alerts can use this as the denominator.",
  labelNames: ["type", "status", "projectId"],
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
    const labels = { type: run?.type || defaultType, status: run?.status || "completed", projectId: run?.projectId || "" };
    runOutcomeTotal.inc(labels);
    // Duration histogram keeps the original (type, status) label set —
    // adding projectId to a histogram would explode bucket cardinality
    // (projects × types × statuses × buckets). Operators who need
    // per-project duration use the `app_run_p95_load_ms{projectId}` gauge.
    const durationLabels = { type: run?.type || defaultType, status: run?.status || "completed" };
    const seconds = Number(run?.duration || 0) / 1000;
    if (Number.isFinite(seconds) && seconds >= 0) runDurationSeconds.observe(durationLabels, seconds);
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


// AUTO-023 B4.5 — autonomous supervisor orchestration telemetry.
const AUTONOMOUS_STEP_BUCKETS = [1, 2, 3, 5, 8, 13, 20];
const AUTONOMOUS_DURATION_BUCKETS = [1, 3, 5, 10, 30, 60, 120, 300, 600];

// Naming: Prometheus convention reserves the `_total` suffix for Counters
// (so `*_total_bucket` / `*_total_sum` / `*_total_count` series read
// cleanly when histograms auto-expand). This is a Histogram, so the
// metric name is `app_agent_thread_steps` (no `_total`). Mirrors the
// `app_agent_review_rounds` convention documented above.
export const agentThreadStepsTotal = new client.Histogram({
  name: "app_agent_thread_steps",
  help: "AUTO-023 B4.5 — autonomous thread step count per terminal outcome.",
  labelNames: ["outcome"],
  buckets: AUTONOMOUS_STEP_BUCKETS,
  registers: [register],
});

export const agentSupervisorDecisionsTotal = new client.Counter({
  name: "app_agent_supervisor_decisions_total",
  help: "AUTO-023 B4.5 — supervisor routing decisions by nextRole.",
  labelNames: ["nextRole"],
  registers: [register],
});

export const agentThreadDurationSeconds = new client.Histogram({
  name: "app_agent_thread_duration_seconds",
  help: "AUTO-023 B4.5 — autonomous thread wall-clock duration in seconds.",
  labelNames: ["outcome"],
  buckets: AUTONOMOUS_DURATION_BUCKETS,
  registers: [register],
});

export const agentOrchestratorFallbackTotal = new client.Counter({
  name: "app_agent_orchestrator_fallback_total",
  help: "AUTO-023 B4.3 — orchestrator fallback count by reason when supervisor decision is ineligible.",
  labelNames: ["reason"],
  registers: [register],
});

export const agentToolCallsTotal = new client.Counter({
  name: "app_agent_tool_calls_total",
  help: "AUTO-023 B5 — total tool calls by tool and outcome.",
  labelNames: ["tool", "outcome"],
  registers: [register],
});

// B3 (AUDIT-ROADMAP Bundle 3) — reviewer-collapse counter. Increments
// once per run when the pre-run gate in `crawler.js` detects that the
// `author` and `reviewer` agent roles resolve to the SAME provider
// route id. In that configuration the "two-agent" review loop cannot
// produce independent signal — the reviewer is the author talking to
// itself at the same temperature against the same prompt vocabulary,
// so `runReviewerAuthorLoop`'s LLM reviewer pass is skipped in favour
// of the heuristic `validateTest` path.
//
// `projectId` label gives operators per-project attribution from
// Prometheus alone (no need to cross-reference with the activity
// log). Mirrors `app_vision_heal_budget_exhausted_total{projectId,
// reason}` and `app_run_p95_load_ms{projectId}` — the same pattern
// for "the gauge is interesting on its own but the per-tenant slice
// is where operators alert". Cardinality concern: self-hosted Sentri
// runs single-digit-to-low-hundreds projects per workspace; very
// large multi-tenant deployments can `relabel_configs`-drop the label
// at scrape time (documented at `monitoring/prometheus/alerts.yml`
// alongside the equivalent escape hatch for vision-heal). The
// equivalent "drop label on scrape" pattern is the industry default
// (AWS, GCP, Datadog all document this for high-cardinality
// per-tenant labels).
//
// Industry parallel: AWS Config "non-compliant resource" counter +
// Datadog monitor `notify_audit_log` count — surface the policy
// violation as a metric, not just a UI badge.
export const agentReviewerCollapsedTotal = new client.Counter({
  name: "app_agent_reviewer_collapsed_total",
  help: "B3 (AUDIT-ROADMAP) — runs where the author/reviewer route collapse gate fired, so the LLM reviewer pass was skipped in favour of heuristic-only validation. Sustained non-zero rate means operators should configure a distinct reviewer route in Settings → Agent Roles. Labelled by projectId for per-project attribution; multi-tenant operators can drop the label via `relabel_configs` at scrape time.",
  labelNames: ["projectId"],
  registers: [register],
});

// B3 (AUDIT-ROADMAP Bundle 3) — review-rejection counter. Increments
// per individual test (not per run) every time the reviewer↔author
// loop terminates with `ReviewRejection` inside the post-run feedback
// loop. Pair with `app_runs_total` to compute the per-run rejection
// rate; sustained spikes are a leading signal of reviewer-prompt
// drift, brittle generation, or a regressed author model.
//
// `projectId` label — same rationale as `agentReviewerCollapsedTotal`
// above. Operators alerting on "which project's reviewer drifted?"
// need the per-tenant slice; the cross-reference to `activities` is
// possible but adds 1-3 seconds to every alert investigation. The
// label closes that gap.
export const reviewRejectionsTotal = new client.Counter({
  name: "app_review_rejections_total",
  help: "B3 (AUDIT-ROADMAP) — individual tests discarded by ReviewRejection inside the post-run feedback loop. Labelled by projectId for per-project attribution. Pair with app_runs_total for per-run rejection rate.",
  labelNames: ["projectId"],
  registers: [register],
});

// B3 (AUDIT-ROADMAP Bundle 3) — review-rejection notification delivery
// counter. One increment per (channel, outcome) tuple on every
// `fireReviewRejectionNotifications` dispatch. Closes the visibility
// gap industry-standard SaaS QA platforms ship with: operators can
// see "is the Teams webhook actually delivering?" from Prometheus
// alone, without grepping worker logs.
//
// Labels:
//   • channel  ∈ {teams, email, webhook} — which transport.
//   • outcome  ∈ {sent, failed, cooldown_skipped, threshold_skipped,
//                 disabled, no_settings} — the dispatch's terminal
//                 disposition. `sent` is the success path; everything
//                 else is a documented skip / failure reason so ops
//                 can alert on `outcome="failed"` rate per channel.
//
// Bounded cardinality: 3 channels × 6 outcomes = 18 series per
// deployment (no projectId — channel-level signal is global; per-project
// attribution lives in the audit log + DLQ). Mirrors
// `app_ai_provider_errors_total{reason}` shape.
//
// Industry parallel: Datadog `Monitor.notification.sent`, PagerDuty
// `incidents.notifications.delivered` — every alerting platform
// exposes per-channel delivery counters so operators can SLO against
// the integration itself, not just the source signal.
export const reviewRejectionNotificationsTotal = new client.Counter({
  name: "app_review_rejection_notifications_total",
  help: "B3 (AUDIT-ROADMAP) — review-rejection notification dispatches. `channel` ∈ {teams, email, webhook}; `outcome` ∈ {sent, failed, cooldown_skipped, threshold_skipped, disabled, no_settings}. Alert on `outcome=\"failed\"` rate per channel to detect broken webhooks before customers do.",
  labelNames: ["channel", "outcome"],
  registers: [register],
});

// Bundle-A fix #3 — Reviewer verdict downgrade counter. Increments every
// time `runReviewerAuthorLoop` downgrades a `request_revision` verdict to
// `accept` because every issue referenced an unknown testId (none of
// the issue.testId values matched a test in the author's artifact). A
// non-zero rate is a leading indicator of reviewer-prompt drift or
// hallucinated testIds — operators want a metric, not just an event row.
//
// `reason` is a closed-set label so cardinality stays bounded. Today the
// only documented reason is `unknown_test_ids`; future downgrade triggers
// (e.g. malformed verdict shape) get their own bucket.
export const reviewerVerdictDowngradedTotal = new client.Counter({
  name: "app_reviewer_verdict_downgraded_total",
  help: "Bundle-A fix #3 — reviewer verdict downgrades from `request_revision` → `accept`. `reason` ∈ {unknown_test_ids}. Non-zero rate signals reviewer-prompt drift or hallucinated testIds.",
  labelNames: ["reason"],
  registers: [register],
});

// Bundle-A fix #9 — feedback-loop regeneration failure counter. Bumps
// every time `regenerateFailingTest` catches a non-abort error and
// returns null (i.e. the auto-regen path failed for reasons OTHER than
// user cancellation). Pre-fix these failures were swallowed silently
// — operators had no signal that regeneration was failing en masse
// (LLM provider outage, JSON parse failure, validator exception). The
// metric closes the observability gap so dashboards / alerts can fire
// when the auto-regen success rate drops.
//
// `reason` is a closed-set label so cardinality stays bounded:
//   • parse_error      — `parseJSON` threw on the LLM response
//   • provider_error   — `generateText` threw (rate limit, auth, 5xx)
//   • internal_error   — any other unexpected throw (validator,
//                        repo, etc.) — operators investigate via the
//                        accompanying structured warn log line.
export const feedbackLoopRegenerationFailuresTotal = new client.Counter({
  name: "app_feedback_loop_regeneration_failures_total",
  help: "Bundle-A fix #9 — non-abort failures inside `regenerateFailingTest`. `reason` ∈ {parse_error, provider_error, internal_error}. Pair with the structured warn log to triage feedback-loop regression.",
  labelNames: ["reason"],
  registers: [register],
});

// Bundle-B fix #8 — healing-hint discard counter. Bumps every time a stored
// hint is rejected because its `strategyVersion` doesn't match the current
// `STRATEGY_VERSION`. Operators alert on a sustained non-zero rate to spot
// a stale-hint backlog after a strategies-array reorder. `reason` is a
// closed-set label so cardinality stays bounded; today the only documented
// reason is `version_mismatch`, but the label leaves room for future
// discard triggers (e.g. `decay_expired` for stale hints) without a
// schema break.
export const healingHintsDiscardedTotal = new client.Counter({
  name: "app_healing_hints_discarded_total",
  help: "Bundle-B fix #8 — healing hints discarded by `getHealingHint` / `getHealingHistoryForTest`. `reason` ∈ {version_mismatch}. Non-zero rate signals a stale-hint backlog after a STRATEGY_VERSION bump.",
  labelNames: ["reason"],
  registers: [register],
});

// ─── Bundle-B fix #19 — state-explorer metrics ───────────────────────────────
// Five metrics covering the explorer's hot path so operators can answer
// "is exploration making progress / hitting bot blocks / running long?"
// without grepping run logs.
const EXPLORER_DURATION_BUCKETS = [1, 5, 15, 30, 60, 120, 300, 600, 900];

// Aggregate counter — no `projectId` label. Unbounded labels are a
// Prometheus anti-pattern (one time series per project blows up TSDB
// memory on multi-tenant deployments). Per-project attribution lives in
// the structured `New state` log line emitted alongside each increment;
// dashboards aggregate the counter rate platform-wide.
export const explorerStatesDiscoveredTotal = new client.Counter({
  name: "app_explorer_states_discovered_total",
  help: "Novel states recorded by the state explorer. Counts only novel snapshots (per `captureState`'s isNovel branch), not every visit. Per-project attribution is in the structured run log.",
  registers: [register],
});

export const explorerActionsAttemptedTotal = new client.Counter({
  name: "app_explorer_actions_attempted_total",
  help: "Bundle-B fix #19 — actions the explorer attempted to dispatch on a page, labelled by action type (click/fill/submit/select/check). Counted PRE-dispatch so the counter reflects intent even when the action fails to resolve a target.",
  labelNames: ["type"],
  registers: [register],
});

export const explorerBotBlockSkipsTotal = new client.Counter({
  name: "app_explorer_bot_block_skips_total",
  help: "Bundle-B fix #19 — actions / forms that triggered an off-origin or bot-block navigation and were skipped + restored. A sustained non-zero rate signals the target site is rate-limiting or fingerprinting the crawler.",
  registers: [register],
});

export const explorerGlobalTimeoutTotal = new client.Counter({
  name: "app_explorer_global_timeout_total",
  help: "Bundle-B fix #19 — explorations that hit the global 15-minute hard cap (`GLOBAL_TIMEOUT_HARD_CAP_MS`). Any non-zero rate signals operator tuning that's exceeding the budget — investigate via the `Global timeout capped` log line.",
  registers: [register],
});

export const explorerDurationSeconds = new client.Histogram({
  name: "app_explorer_duration_seconds",
  help: "Bundle-B fix #19 — end-to-end state-exploration duration in seconds. Buckets sized to surface p95/p99 against the 15-minute hard cap.",
  buckets: EXPLORER_DURATION_BUCKETS,
  registers: [register],
});

// MNT-015 — browser pool and per-workspace AI limiter telemetry.
export const browserPoolSize = new client.Gauge({
  name: "app_browser_pool_size",
  help: "MNT-015 — configured warm browser slot capacity by browser type.",
  labelNames: ["type"],
  registers: [register],
});

export const browserPoolInUse = new client.Gauge({
  name: "app_browser_pool_in_use",
  help: "MNT-015 — currently checked-out browser contexts by browser type.",
  labelNames: ["type"],
  registers: [register],
});

export const browserPoolAcquiresTotal = new client.Counter({
  name: "app_browser_pool_acquires_total",
  help: "MNT-015 — browser pool acquisitions by browser type and outcome (hit, miss, queue).",
  labelNames: ["type", "outcome"],
  registers: [register],
});

export const aiRateLimitedTotal = new client.Counter({
  name: "app_ai_rate_limited_total",
  help: "MNT-015 — per-workspace AI limiter rejections by workspace role bucket.",
  labelNames: ["workspace_role"],
  registers: [register],
});

// MNT-015 — pool acquisition latency histogram. Captures both fast-path
// "hit" leases (single-digit ms) and queued waits when the pool is full.
// Buckets chosen to span: warm-hit (<10 ms), cold-launch miss (200 ms – 2 s),
// queued wait under contention (>2 s). Mirrors HikariCP `pool.Wait` and
// pgbouncer `cl_waiting` exposition shapes so operators can SLO against
// queue depth.
export const browserPoolAcquireWaitSeconds = new client.Histogram({
  name: "app_browser_pool_acquire_wait_seconds",
  help: "MNT-015 — browser pool acquisition wait time by type and outcome.",
  labelNames: ["type", "outcome"],
  buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

// MNT-015 — unhandled browser disconnects (Chromium crash, OOM kill,
// remote endpoint hang-up). Operators alert on a non-zero rate; a healthy
// long-running deployment should see this at zero outside the rare
// upstream-Playwright crash. Counts the eviction event, NOT downstream
// failures the disconnect may cause.
export const browserPoolDisconnectsTotal = new client.Counter({
  name: "app_browser_pool_disconnects_total",
  help: "MNT-015 — unexpected browser disconnects detected by the pool, by type.",
  labelNames: ["type"],
  registers: [register],
});

// ─── B1.2 — DB write-batching queue ──────────────────────────────────────────
// Three metrics that together answer "is the SQLite write queue healthy?":
//   • depth gauge — current backlog; sustained non-zero signals undersized
//     batch / flush interval relative to write volume.
//   • batch duration — flush wall-clock; drives the queue-write latency SLO.
//   • batch size — operations per flush; combined with depth tells operators
//     whether flushes are size-triggered (good — saturating the batch) or
//     time-triggered (queue is under-utilised and the per-op overhead of
//     setTimeout dominates).
const DB_BATCH_DURATION_BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1];
const DB_BATCH_SIZE_BUCKETS = [1, 5, 10, 25, 50, 100, 250];

export const dbWriteQueueDepth = new client.Gauge({
  name: "app_db_write_queue_depth",
  help: "B1.2 — current size of the SQLite write-batching queue. Sustained non-zero values signal `DB_WRITE_BATCH_SIZE` / `DB_WRITE_FLUSH_MS` are undersized relative to write volume — operators tune via env. Postgres deployments always read 0 (queue is a passthrough).",
  registers: [register],
});

export const dbWriteBatchDurationSeconds = new client.Histogram({
  name: "app_db_write_batch_duration_seconds",
  help: "B1.2 — wall-clock duration per batched-write flush. Drives the queue-write latency SLO and helps detect SQLite WAL contention regressions.",
  buckets: DB_BATCH_DURATION_BUCKETS,
  registers: [register],
});

export const dbWriteBatchSize = new client.Histogram({
  name: "app_db_write_batch_size",
  help: "B1.2 — operations per flush. Combined with `app_db_write_queue_depth`, distinguishes size-triggered flushes (saturating the batch) from time-triggered ones (queue under-utilised).",
  buckets: DB_BATCH_SIZE_BUCKETS,
  registers: [register],
});

// B1.1 — Duplicate-write counter on the `run_test_results` append path.
// Bumped every time `runTestResultRepo.append()` detects an existing row
// for `(runId, testId, iterationIndex)`. `reason` is closed-set so
// cardinality stays bounded:
//   • resume_replay     — expected when `POST /runs/:id/resume` re-enqueues a
//                         test whose result was almost-persisted before crash.
//   • duplicate_dispatch — unexpected; indicates a bug double-dispatching the
//                         same test in the runner / shard worker. Any
//                         sustained non-zero rate fires an alert.
// Matches the Splunk / Datadog convention of logging every dedup decision
// rather than silently swallowing — operators must be able to distinguish
// "the resume path worked" from "we have a write-amplification bug".
export const runTestResultDuplicatesTotal = new client.Counter({
  name: "app_run_test_result_duplicates_total",
  help: "B1.1 — duplicate-write rejections on `run_test_results.append`. `reason='resume_replay'` is expected (POST /runs/:id/resume replaying a near-persisted result); `reason='duplicate_dispatch'` signals a runner bug double-dispatching the same test — alert on any sustained non-zero rate.",
  labelNames: ["reason"],
  registers: [register],
});

// ─── B2 — iframe + SPA hydration + adaptive timeout (AUDIT-ROADMAP Bundle 2) ──
// Five metrics mirroring B1's "four named metrics" bar so operators can answer
// "is the adaptive-timeout math actually helping?" and "is iframe enumeration
// recovering content for embedded widgets?" without re-reading run logs.
//
// Histogram bucket choices:
//   • p95 page-load + adaptive timeout share `AI_BUCKETS` (0.1 s – 2 min):
//     covers fast pages (<500 ms) through enterprise SPAs with multi-second
//     hydration. Same bucket set as `app_ai_provider_latency_seconds` so
//     dashboards can co-plot "AI latency vs page-load latency" without
//     re-tuning percentile widgets.
//   • Hydration wait shares `HTTP_BUCKETS` (10 ms – 10 s): the wait is
//     bounded by `HYDRATION_WAIT_MS` (env, default 5 000), and the histogram
//     must surface both "near-zero" (no indicators present, fast fallthrough)
//     and "near-bound" (operator should raise the env) without log-binning
//     loss at the bound.

export const runP95LoadMs = new client.Gauge({
  name: "app_run_p95_load_ms",
  help: "B2 — last-computed `runs.p95LoadMs` per project. Set at run-start from `crawlSnapshotRepo.getLoadTimesByRunId()` via the R-7 percentile in `testRunner.js#p95`. Operators alert on a sustained increase (latent app regression) and compare against `app_run_adaptive_timeout_ms` to verify the adaptive-clamp math.",
  labelNames: ["projectId"],
  registers: [register],
});

export const runAdaptiveTimeoutMs = new client.Gauge({
  name: "app_run_adaptive_timeout_ms",
  help: "B2 — last-derived per-run element timeout. `source` ∈ {project_override, adaptive, default} mirrors the precedence chain in `testRunner.js`: operator override beats `2 * p95LoadMs` beats env floor. Compare against `app_run_p95_load_ms` to verify the clamp math and against `HEALING_ELEMENT_TIMEOUT` / `MAX_ELEMENT_TIMEOUT` env bounds.",
  labelNames: ["projectId", "source"],
  registers: [register],
});

export const iframeEnumeratedTotal = new client.Counter({
  name: "app_iframe_enumerated_total",
  help: "B2 — iframes processed by `crawlBrowser.js#enumerateFrameSnapshots`. `outcome` ∈ {captured, skipped_cross_origin, skipped_strategy, error}: `captured` = snapshot persisted + elements merged; `skipped_cross_origin` = SecurityError on DOM access (Stripe / Intercom / etc.); `skipped_strategy` = `shouldEnumerateFrame` rejected before snapshot attempt; `error` = unexpected throw inside the snapshot path. `strategy` ∈ {same-origin, allowlist, all, none} matches `project.iframeStrategy`.",
  labelNames: ["strategy", "outcome"],
  registers: [register],
});

export const spaHydrationWaitSeconds = new client.Histogram({
  name: "app_spa_hydration_wait_seconds",
  help: "B2 — wall-clock duration of the SPA hydration wait in `pageSnapshot.js#waitForSpaHydration`. `mode` ∈ {auto, custom, domcontentloaded} mirrors `project.hydrationType`. `domcontentloaded` observations are always 0 (the function early-returns); included for symmetry so dashboards can split mode prevalence without an extra label query. Near-bound values (within ~10% of `HYDRATION_WAIT_MS`) signal the env default is too tight for the SPA in question.",
  labelNames: ["mode"],
  buckets: HTTP_BUCKETS,
  registers: [register],
});
