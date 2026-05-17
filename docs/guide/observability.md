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
| `app_ai_provider_latency_seconds` | Histogram | provider, outcome | Per-provider p99 latency |
| `app_ai_provider_tokens_total` | Counter | provider, kind | Token cost driver |
| `app_ai_provider_errors_total` | Counter | provider, reason | Per-provider failure-mode breakdown |
| `app_queue_depth` | Gauge | state | BullMQ waiting, active, failed |
| `app_active_runs` | Gauge | type | In-process active runs |

Default Node.js metrics (`nodejs_eventloop_lag_seconds`, `nodejs_heap_*`, `process_cpu_*`) are also exposed via `prom-client.collectDefaultMetrics`.

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

Means: a specific AI provider failing more than 15% of LLM calls over 5 min.

Triage:

1. Check the vendor status page — Anthropic / OpenAI / Google all publish public status pages.
2. Verify fallback — Sentri Settings: at least one OTHER provider needs a valid key, otherwise customers on that provider are stuck.
3. Reason breakdown via `app_ai_provider_errors_total{provider="..."} by reason`. `rate_limit` = vendor throttling; `server_error` = vendor outage; `timeout` = network or vendor latency; `auth` = our key is invalid (see next).

### AiProviderAuthFailures

Severity: critical. Page: yes.

Means: ANY auth failure from a provider. Keys should not be invalid in production.

Triage:

1. Identify which provider via `app_ai_provider_errors_total{reason="auth"}` by `provider`.
2. Rotate the key in Sentri Settings (or update the env var and redeploy).
3. Customer-visible — every workspace using this provider as primary is broken. Communicate via status page if outage above 10 min.

### AiProviderHighLatencyP99

Severity: warning.

Means: per-provider p99 latency above 30s for successful calls.

Triage: check the vendor status page. The FEA-003 fallback chain does not fire on slow calls (only hard errors), so this slowness is fully customer-visible. Consider pinning a faster provider via the Settings dropdown if the outage persists.

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
