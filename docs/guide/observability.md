# Observability
INF-007 operator guide for traces, metrics, logs, crash reporting, and on-call response. Canonical hand-off between the engineering team and the operators running the SaaS plane in production.
## Stack overview
| Layer | Tool | Wired up by |
| --- | --- | --- |
| Distributed traces | OpenTelemetry, OTLP collector | backend/src/otel-preload.mjs |
| Metrics | prom-client, Prometheus | backend/src/utils/metrics.js, scraped at GET /metrics |
| Structured logs | JSON via LOG_JSON=true | utils/logFormatter.js, utils/structuredLog.js |
| Crash reporting | Sentry (backend and frontend) | otel-preload.mjs, index.js, frontend/src/main.jsx |
| User context | Sentry tags and scope | middleware/workspaceScope.js, frontend/src/main.jsx |
| Alerting | Prometheus, Alertmanager, PagerDuty | monitoring/prometheus/alerts.yml |
Every layer is opt-in via env vars. The platform boots and serves traffic without any of them set. This guide assumes the production SaaS plane where they ARE set. Full env-var reference: [Environment Variables — Observability](./env-vars.md#observability-inf-007).
## Metric reference
All metrics use the brand-neutral `app_` prefix (see [Rebranding](./rebranding.md)). Workspace, project, and user IDs are NEVER emitted as metric labels — they would explode the time-series cardinality. Per-tenant detail belongs on OTel spans and Sentry tags.
| Metric | Type | Labels | Purpose |
| --- | --- | --- | --- |
| `app_http_requests_total` | Counter | method, route, status | Request rate per route |
| `app_http_request_duration_seconds` | Histogram | method, route, status | p50, p95, p99 latency per route |
| `app_runs_total` | Counter | type | Run creation rate per type |
| `app_run_outcome_total` | Counter | type, status | Per-type success or failure rate |
| `app_run_duration_seconds` | Histogram | type, status | Per-type run latency percentiles |
| `app_tests_executed_total` | Counter | status, browser | Test throughput by engine |
| `app_test_duration_seconds` | Histogram | status, browser | Per-test latency percentiles |
| `app_crawl_pages_total` | Counter | mode | Crawler throughput by mode |
| `app_pipeline_stage_duration_seconds` | Histogram | stage | Which pipeline stage is slow |
| `app_ai_provider_latency_seconds` | Histogram | provider, agent_role, outcome, operation, route_name | Per-route p99 latency |
| `app_ai_provider_tokens_total` | Counter | provider, agent_role, kind, operation, route_name | Token cost driver |
| `app_ai_provider_errors_total` | Counter | provider, agent_role, reason, operation, route_name | Per-route failure-mode breakdown |
| `app_ai_cost_usd_total` | Counter | provider, agent_role, operation, route_name | Realised USD spend, route-attributed |
| `app_ai_cache_hits_total` | Counter | route_name, agent_role | Response-cache hits per route |
| `app_ai_cache_misses_total` | Counter | route_name, agent_role | Cache misses (cold + TTL-expired) |
| `app_ai_cache_savings_usd_total` | Counter | route_name, agent_role | Cumulative USD saved by cache hits |
| `app_queue_depth` | Gauge | state | BullMQ waiting, active, failed |
| `app_active_runs` | Gauge | type | In-process active runs |
Default Node.js metrics (`nodejs_eventloop_lag_seconds`, `nodejs_heap_*`, `process_cpu_*`) are also exposed via `prom-client.collectDefaultMetrics`.
## Cardinality budget
The `route_name` Prometheus label is operator-controlled free text (sourced from `provider_routes.name`, `UNIQUE(workspaceId, name)`). Cardinality is bounded by the number of `provider_routes` rows across all workspaces — typically tens per deployment, never thousands. Concrete budget:
| Deployment scale | Workspaces | Routes/workspace | `route_name` cardinality |
| --- | --- | --- | --- |
| Single-tenant | 1 | 1–3 | 1–3 |
| Small SaaS | 10–50 | 1–5 | 10–250 |
| Multi-tenant SaaS | 100–500 | 1–10 | 100–5,000 |
Each AI metric carries `route_name` × `agent_role` × `provider` × … so the worst-case time-series count for `app_ai_provider_latency_seconds` on a 500-workspace deployment is roughly:
- 500 workspaces × 5 routes/ws × 7 agent roles × 2 outcomes × 2 operations × 12 histogram buckets ≈ 1.7M series
Prometheus comfortably handles this with `--storage.tsdb.retention.time=15d` on a 16 GiB instance. Operators on tighter Prometheus budgets should either limit routes per workspace via admin policy, or set a recording rule that drops `route_name` for low-traffic routes.
**Anti-pattern:** the cache metrics (`app_ai_cache_*`) deliberately omit the `provider` label. Cache effectiveness is per-route, not per-family — adding `provider` would inflate cardinality without information gain.
## Trace, log, error correlation
Every log line and Sentry event carries the same `requestId`. Every log line carries `traceId` and `spanId` when an OTel span is active. The operator pivot:
1. Sentry alert fires — grab `requestId` from the event tags.
2. Search Loki or ELK for `requestId = <id>` — full log trail for that request.
3. Read `traceId` from any log line — jump to Jaeger or Tempo — see the distributed trace including DB queries, AI calls, Redis ops.
This three-way pivot collapses "what happened?" investigations from hours to minutes.
## Prometheus scrape config
```yaml
scrape_configs:
  - job_name: sentri-backend
    metrics_path: /metrics
    bearer_token: ${METRICS_SCRAPE_KEY}
    static_configs:
      - targets: ["backend-1.internal:3001", "backend-2.internal:3001"]
rule_files:
  - /etc/prometheus/sentri/alerts.yml
alerting:
  alertmanagers:
    - static_configs:
        - targets: ["alertmanager.internal:9093"]
```
## Cache + quota dashboards (B4.2)
Bundles 3.7 and 3.8 added per-route quota enforcement and exact-match response caching. Operators tuning either need a Grafana panel; the dashboards aren't checked into this repo (deployment-environment-specific — Grafana version, datasource UID, folder structure all vary), but the PromQL queries below drop straight into a panel.
### Cache hit ratio per route
```promql
sum by (route_name) (rate(app_ai_cache_hits_total[5m]))
/
(
  sum by (route_name) (rate(app_ai_cache_hits_total[5m]))
  + sum by (route_name) (rate(app_ai_cache_misses_total[5m]))
)
```
A hit ratio above ~30% on a deterministic-prompt workload (T=0, self-healing disabled) means caching is paying its keep. Below 5% means the route's `cacheTtlSec` is too short, the workload's prompts vary more than expected, or the route has `cacheEnabled = 0` and shouldn't appear at all (filter via `app_ai_cache_hits_total{route_name=~".+"}`).
### Cumulative cache savings (USD)
```promql
sum by (route_name) (increase(app_ai_cache_savings_usd_total[24h]))
```
Per-route, last 24h. Compare against `sum by (route_name) (increase(app_ai_cost_usd_total[24h]))` to see savings as a percentage of total spend.
### Rate-limit rejections per route
The dispatcher rejects calls that fail the per-route token-bucket gate with `code: ERR_RATE_LIMIT_LOCAL` (B3.7). These surface in `app_ai_provider_errors_total` with `reason="rate_limit_local"`:
```promql
sum by (route_name) (rate(app_ai_provider_errors_total{reason="rate_limit_local"}[5m]))
```
Spike on a single route → the route's `rpmLimit` or `tpmLimit` is too tight for the workload. Spike across every route → a workspace is being aggressively retried; check the orchestrator's backoff config.
### Spend-cap utilization
`checkSpendCap` reads from `ai_request_log` (B2.5), not Prometheus, so there's no direct gauge. The closest proxy is the `app_ai_cost_usd_total` counter against the workspace's `dailySpendCapUsd` — operators have to join the two manually. A recording rule helps:
```yaml
- record: workspace:ai_spend_24h_usd:sum
  expr: sum by (workspace_id) (increase(app_ai_cost_usd_total[24h]))
```
Then alert on `workspace:ai_spend_24h_usd:sum > on(workspace_id) workspace_daily_cap_usd * 0.8` (where `workspace_daily_cap_usd` is exposed by a separate exporter that reads the `workspaces.dailySpendCapUsd` column). This is operator-environment specific — most deployments query the DB directly from a billing-ops script instead. The B3.7 alert path (`spendAlertThresholdPct` → webhook delivery via B4.0.1 `spendAlert.js`) covers the common case without a dashboard.
## On-call runbook
Every Prometheus alert in `monitoring/prometheus/alerts.yml` has a `runbook_url` anchor pointing at the matching section below. An on-call engineer should be able to resolve any alert by following the matching section with no tribal-knowledge dependency.
### HighHttpErrorRate
Severity: critical. Page: yes.
Means: more than 1% of HTTP requests returning 5xx over 5 min. Customer-visible outage.
Triage:
1. Sentry dashboard — top issue by event count is usually the root cause.
2. Recent deploy — if a deploy went out in the last 30 min, **roll back first**. Sentry `release` tags tie events to deploys via `VITE_APP_VERSION`.
3. Per-route breakdown via Grafana: `sum by (route, status) (rate(app_http_requests_total{status=~"5.."}[5m]))`. One route dominating = localised bug. Spread across routes = downstream dependency.
### HighApiLatencyP99
Severity: warning.
Means: API p99 above 2s for 5 min.
Triage: Grafana "p99 by route" panel — identify slow route — check OTel pg auto-instrumentation spans for slow queries — correlate with `app_ai_provider_latency_seconds` if the route involves AI.
### HighRunFailureRate
Severity: warning.
Means: more than 5% of runs reached `failed` in the last 15 min.
Triage:
1. `app_ai_provider_errors_total` — if `reason=rate_limit` is climbing, a vendor is throttling us. The FEA-003 fallback chain should be active.
2. Playwright failures — if AI errors are flat, the runner is failing. SSH into a worker; check Chromium install.
3. Customer-specific — trace failed run IDs through structured logs; check if they cluster on one workspace.
### TestRunP99LatencyRegression
Severity: warning.
Means: p99 `test_run` duration above 10 min.
Triage: same as `HighApiLatencyP99` scoped to runs via `app_run_duration_seconds_bucket{type="test_run"}`. Also check `app_pipeline_stage_duration_seconds` to see which stage slowed.
### QueueDepthSaturated
Severity: critical. Page: yes.
Means: more than 50 BullMQ jobs waiting above 15 min. Customers' runs are not making progress.
Triage:
1. Verify workers running — `kubectl get pods -l app=sentri-worker` (or `docker compose ps worker`).
2. Check `app_queue_depth{state="active"}` — if active equals 0 while waiting is high, workers are not picking up jobs. Likely Redis connectivity.
3. Scale workers — bump `WORKER_CONCURRENCY` or add replicas.
### QueueFailedJobsGrowing
Severity: warning.
Means: more than 10 BullMQ jobs in `failed` state in the last hour.
Triage: open Bull Board. Common causes — poison-pill payload (one malformed run looping through retries), external dependency outage, code regression. Inspect each job's failure reason.
### AiProviderHighErrorRate
Severity: warning.
Means: a specific `provider_routes` row failing more than 15% of LLM calls over 5 min. **B4.2** — alert is now keyed by `(provider, route_name)` so a single bad route surfaces independently of the rest of the family.
Triage:
1. Identify the failing route via `app_ai_provider_errors_total{route_name="..."} by reason`. `rate_limit` = vendor throttling; `server_error` = vendor outage; `timeout` = network or vendor latency; `auth` = our key is invalid (see next).
2. Check the vendor status page for the route's `provider` (Anthropic / OpenAI / Google all publish public status pages).
3. Verify fallback — the route's `fallbackRouteId` (Settings → AI Providers) needs to point at a healthy sibling, otherwise pipeline roles assigned to this route are stuck.
4. For workspace-scoped triage, check the workspace's `ai_request_log` (Settings → AI Request Log) filtered by `routeId` and `outcome="error"` for the redacted prompts that triggered the failures.
### AiProviderAuthFailures
Severity: critical. Page: yes.
Means: ANY auth failure on a `provider_routes` row. Keys should not be invalid in production. **B4.2** — `route_name` label tells you exactly which row's key needs rotating.
Triage:
1. Identify the failing route from the alert's `route_name` label, or via `app_ai_provider_errors_total{reason="auth"} by route_name`.
2. Rotate the key in Settings → AI Providers → Rotate key for the affected route. The endpoint runs a probe-before-persist gate so the new key is verified before it replaces the old ciphertext (B3.6).
3. Customer-visible — every workspace assigning this route to a pipeline role is broken until the rotation completes. Communicate via status page if outage above 10 min.
4. Pre-routes deployments (single env-var keys) still surface here with `route_name="unknown"` — for those, update the env var and redeploy.
### AiProviderHighLatencyP99
Severity: warning.
Means: per-route p99 latency above 30s for successful calls. **B4.2** — keyed by `(provider, route_name)` so a slow self-hosted vLLM proxy doesn't falsely indict the entire openai protocol family.
Triage:
1. Identify the slow route from the alert's `route_name` label. Check the vendor status page for the route's `provider`.
2. For self-hosted / compat routes (`family: "custom"`), check the operator-set `baseUrl` — a misconfigured proxy can absorb minutes of latency before timing out.
3. The FEA-003 fallback chain does not fire on slow calls (only hard errors), so this slowness is fully customer-visible. Configure `fallbackRouteId` on the slow route to a healthy sibling for automatic mitigation, or disable the route in Settings → AI Providers if the outage persists.
### AiSpendCapExceeded
Severity: warning.
Means: a workspace's daily or monthly AI spend cap has been hit; dispatch on the named route is being rejected with `ERR_SPEND_CAP_EXCEEDED`. The dispatcher's spend-alert webhook (B3.7 / B4.0.1) should have already notified the workspace admin via Slack / generic webhook.
Triage:
1. **Confirm the workspace admin saw the webhook.** `workspaces.spendAlertLastFiredAt` should be within the cooldown window. If it's NULL or stale, the webhook URL is misconfigured — check `workspaces.spendAlertWebhookUrl` and the dispatcher logs for `[spendAlert] webhook returned <status>` lines.
2. **Decide raise vs. wait.** If the burst is legitimate (real customer load, planned campaign), raise the cap via Settings → AI Providers → Spend Caps tab. If the burst is a runaway pipeline or unintended loop, the cap is doing its job — leave it and investigate the source (`ai_request_log` table, filter by workspaceId + recent createdAt).
3. **Cross-reference with `app_ai_cost_usd_total`** by `(provider, route_name)` to see which route is consuming the budget. If one route dominates, consider a per-route `tpmLimit` to throttle without blocking the whole workspace.
### AiQuotaRejectionRateHigh
Severity: warning.
Means: more than 10% of dispatch attempts on a given route are being locally rejected by the B3.7 token bucket (`ERR_RATE_LIMIT_LOCAL`). The vendor never sees these calls — our own `rpmLimit` / `tpmLimit` is too tight for the workload.
Triage:
1. **Check the route's configured limits.** Settings → AI Providers → click the row's **Edit** → expand **Advanced** → RPM / TPM fields. Common cause: an admin set `rpmLimit: 60` (1/sec) on a high-throughput route.
2. **Distribute load.** If the limit is correctly conservative for one vendor account, configure a sibling route (different key, same model) and chain them via `fallbackRouteId`. The dispatcher will automatically fail-over when the first route's bucket is exhausted.
3. **Verify estimate vs. actual drift.** The pre-call gate uses `maxTokens` as an upper-bound estimate. If most calls return far fewer tokens than `maxTokens`, the bucket is being pessimistically over-charged — `reportActual` corrects post-call but the rejection still happened. Lowering `maxTokens` on hot call sites can reduce false positives.
### EventLoopLagHigh
Severity: warning.
Means: Node event-loop lag above 100ms for 10 min. Process CPU-saturated or running sync work on the main thread.
Triage:
1. Sentry performance traces (if `SENTRY_TRACES_SAMPLE_RATE` above 0) show the slow operation.
2. Check `app_pipeline_stage_duration_seconds` — a stage running away will block the loop.
3. Check for runaway crawls via `app_active_runs{type="crawl"}` unusually high for workload.
### HeapUsageHigh
Severity: warning.
Means: Node heap above 90% for 15 min. OOM-kill risk on the next allocation spike.
Triage:
1. Short-term: bump container memory limit.
2. Long-term: hunt the leak. Common culprits are unbounded caches (`compatConfigCache`, AI provider response caches) and runaway `run.logs` buffers for long-lived runs.
### BackendScrapeDown
Severity: critical. Page: yes.
Means: Prometheus cannot reach `/metrics` for 3 min. Every other alert is silently dark.
Triage:
1. Backend health — `curl https://backend/health`. If down, page the on-call engineer.
2. Network — can Prometheus reach the backend? Firewall? mTLS rotation?
3. Auth — did `METRICS_SCRAPE_KEY` rotate without updating Prometheus config?
## Verification checklist
After deploying observability config to a new environment:
1. `curl -H "Authorization: Bearer $METRICS_SCRAPE_KEY" https://backend/metrics` returns Prometheus exposition text with `app_*` and `nodejs_*` metrics.
2. `curl -i https://backend/health` returns an `X-Request-Id` header on every response.
3. With `OTEL_EXPORTER_OTLP_ENDPOINT` set, the collector receives spans (check Jaeger UI for the `sentri-backend` service).
4. With `SENTRY_DSN` set, trigger a synthetic error (dev only) and confirm the event lands in Sentry with the `workspace_id` tag populated.
5. With Prometheus scraping, fire a synthetic alert via Alertmanager test mode and confirm it routes to PagerDuty.
