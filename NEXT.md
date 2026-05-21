# NEXT.md — Current Sprint Target

> **Agents:** Start here. Everything needed to begin the current PR is in this file. Open `ROADMAP.md` only to look up a specific item by ID or review phase context.
>
> **Humans:** When a PR ships — move the item to `ROADMAP.md` ✅ table, promote the next queue item to Current PR, and update Recently Completed.

---

## Bundling guidance

Flag adjacent items as bundling candidates in your PR description rather than expanding scope mid-flight. Good signals: items touch the same module, one validates the other end-to-end, or both are S/XS effort and skipping a handoff saves more than it costs in review surface. Bad signals: different phases, M+ effort expansion, or the candidate surfaces after CI is already green. When in doubt, comment on the PR and let the human decide — never silently expand beyond the Current PR checklist.

---

## ▶ Current PR — INF-009 — Helm chart + K8s readiness/liveness + DR playbook
**Effort:** L | **Priority:** 🟡 High | **Dependencies:** INF-008 ✅ (Postgres-default), INF-007 ✅ (metrics endpoint for liveness) | **Source:** `ROADMAP.md` Phase 5 (INF-009)
Ship a production-grade `helm/sentri/` chart (separate `backend` + `worker` Deployments, Postgres StatefulSet, Redis Deployment, ingress / configmap / secret), wire `readinessProbe` / `livenessProbe` against `GET /api/v1/health`, and codify a disaster-recovery playbook with explicit RTO (<4h) / RPO (<24h) targets backed by a nightly `pg_dump` → S3 backup workflow. Closes the gap between "you can run Sentri in Docker Compose" and "you can deploy Sentri on a managed Kubernetes cluster with the same operational guarantees as INF-007's observability stack."

**Problem:** Sentri ships a Docker Compose for self-hosted demos, but operators running production Kubernetes clusters have no first-class deployment artefact — they hand-write Deployments / Services / Ingresses from the compose file, miss the SIGTERM graceful-shutdown drain that `MAINT-013` already implements in code, and have no canonical disaster-recovery story. The `INF-007` Prometheus `/metrics` endpoint and `GET /api/v1/health` route exist but no probe configuration ties them to a kubelet. There is no nightly database backup; an operator who loses the Postgres volume loses every project, run, test, audit log, and SIEM-replay DLQ row with no documented recovery path.
**Fix:**
1. New `helm/sentri/` Helm chart with parameterised `values.yaml` — separate `backend` + `worker` Deployments (matching the `docker-compose.yml --profile redis --profile postgres` topology), Postgres as a StatefulSet with PVC, Redis as a single Deployment (cluster-mode opt-in via `values.redis.cluster.enabled`), HorizontalPodAutoscaler on the worker Deployment driven by BullMQ queue depth via the `app_queue_depth` Prometheus gauge, ingress for the backend HTTP surface, ConfigMap for non-secret env vars (`DATABASE_URL`, `REDIS_URL`, `WORKER_CONCURRENCY`, etc.), Secret for AES + JWT keys + AI provider keys.
2. `readinessProbe` + `livenessProbe` on both `backend` and `worker` Deployments. Backend probes `GET /api/v1/health` (verifies DB + Redis reachable); worker probes a new `GET /healthz` endpoint binding only on a sidecar port that returns `200` when BullMQ is connected and `503` otherwise (avoids exposing the worker via the public ingress).
3. New `.github/workflows/nightly-backup.yml` runs `pg_dump` against the configured `DATABASE_URL` and uploads to S3 (or any S3-compatible bucket configured via `S3_BACKUP_BUCKET` + reusing `MNT-006`'s S3 client). Retention: 30 daily + 12 monthly snapshots, lifecycle policy documented in the runbook.
4. New `docs/guide/disaster-recovery.md` ships the operator hand-off: explicit RTO (<4h) / RPO (<24h) targets, restore playbook (`pg_restore` against a fresh StatefulSet PVC), Redis loss tolerance (durable BullMQ jobs replay from Postgres-side run state, ephemeral session data is acceptable to lose), `helm upgrade --rollback` runbook for failed deploys.
5. Helm chart smoke test in `tests/helm/` via `helm template` + `kubeval` (or `kubeconform`) in CI — guarantees the chart renders into valid Kubernetes manifests against the current minor version. Mirrors the pattern from `INF-007`'s `monitoring/prometheus/alerts.yml` validation.
**Files to change:**
- `helm/sentri/Chart.yaml` (new) — chart metadata, version 0.1.0
- `helm/sentri/values.yaml` (new) — defaults for image tags, replicas, ingress host, Postgres/Redis sizing, autoscaling thresholds
- `helm/sentri/templates/backend-deployment.yaml` (new) — Deployment with `readinessProbe` / `livenessProbe` on `GET /api/v1/health`; env from ConfigMap + Secret; `terminationGracePeriodSeconds` aligned with `MAINT-013`'s drain timeout
- `helm/sentri/templates/worker-deployment.yaml` (new) — Deployment with `readinessProbe` / `livenessProbe` on the new `GET /healthz` worker endpoint
- `helm/sentri/templates/postgres-statefulset.yaml` (new) — StatefulSet + PVC + headless Service
- `helm/sentri/templates/redis-deployment.yaml` (new) — Deployment + Service (cluster-mode opt-in via `values.redis.cluster.enabled`)
- `helm/sentri/templates/ingress.yaml` (new) — ingress for backend HTTP surface
- `helm/sentri/templates/configmap.yaml` (new) — non-secret env (`DATABASE_URL`, `REDIS_URL`, `WORKER_CONCURRENCY`, …)
- `helm/sentri/templates/secret.yaml` (new) — AES + JWT keys + AI provider keys stub
- `helm/sentri/templates/hpa.yaml` (new) — HorizontalPodAutoscaler on worker driven by `app_queue_depth`
- `backend/src/worker.js` — add `GET /healthz` sidecar HTTP endpoint binding on `WORKER_HEALTH_PORT` (default 3002) returning 200/503 based on BullMQ connection state
- `backend/src/middleware/appSetup.js` — extend `/api/v1/health` to verify Postgres + Redis reachable before returning 200
- `.github/workflows/nightly-backup.yml` (new) — `pg_dump` → S3 daily at 02:00 UTC, 30-day + 12-month retention
- `.github/workflows/helm-validate.yml` (new) — `helm template helm/sentri/ | kubeconform` on every PR touching `helm/`
- `tests/helm/values-overrides.yaml` (new) — minimal `values.yaml` overrides used by the validate workflow
- `docs/guide/disaster-recovery.md` (new) — RTO/RPO targets, restore playbook, Redis loss tolerance, `helm upgrade --rollback` runbook
- `docs/guide/kubernetes-deployment.md` (new) — Helm install walkthrough mirroring `docs/guide/getting-started.md`'s Docker Compose structure
- `docs/guide/env-vars.md` — document `WORKER_HEALTH_PORT` + `S3_BACKUP_BUCKET` + `S3_BACKUP_REGION` + `S3_BACKUP_ACCESS_KEY_ID` + `S3_BACKUP_SECRET_ACCESS_KEY`
- `docs/changelog.md` — `## [Unreleased]` § Added
- `QA.md` — new section "Kubernetes deployment + DR (INF-009)" with manual test plan

**Acceptance criteria:**
- `helm template helm/sentri/ --set ingress.host=test.local | kubeconform --strict --schema-location default` exits 0 against the current Kubernetes minor version.
- `helm install sentri ./helm/sentri/` on a clean `kind` cluster brings up backend + worker + Postgres + Redis. `kubectl wait --for=condition=Ready` succeeds on every pod within 90s.
- `kubectl delete pod -l app=backend` flips the readiness probe red, ingress stops routing to the deleted pod, the new pod's `/api/v1/health` returns 200, and zero in-flight runs are lost (MAINT-013's drain semantics preserved under SIGTERM).
- `pg_restore` from a snapshot uploaded by `.github/workflows/nightly-backup.yml` into a fresh StatefulSet PVC restores the workspace bit-for-bit (projects + runs + tests + audit log + SIEM DLQ rows). RTO documented as <4h; RPO documented as <24h.
- Worker `/healthz` returns 503 within 2s of Redis connection loss; readiness probe flips, HPA stops scaling against a stale queue gauge.
- `docs/guide/disaster-recovery.md` includes the explicit `pg_restore` invocation, the S3 bucket layout, and the `helm rollback` step-by-step for failed deploys.

### PR checklist (INF-009)
- [ ] PR title follows Conventional Commits (`feat(inf): INF-009 — Helm chart + K8s probes + DR playbook`)
- [ ] Branch is off `develop`, not `main`
- [ ] `cd backend && npm test` passes locally (incl. any new `health.test.js` for the worker `/healthz` endpoint + extended `/api/v1/health` DB+Redis check)
- [ ] `cd frontend && npm run build && npm test` passes locally
- [ ] `helm template helm/sentri/ | kubeconform --strict` passes locally
- [ ] `helm install sentri ./helm/sentri/` on a local `kind` cluster brings up all pods Ready within 90s
- [ ] Pod-deletion drain verified — no in-flight run lost under SIGTERM
- [ ] `pg_dump` → S3 → `pg_restore` round-trip verified on a copy of the cluster's database
- [ ] `docs/guide/disaster-recovery.md` + `docs/guide/kubernetes-deployment.md` ship the full operator hand-off
- [ ] `docs/changelog.md` updated under `## [Unreleased]` § Added
- [ ] ROADMAP.md `### INF-009` section flipped to `**Status:** ✅ Complete (PR #N)` and Completed Work Summary row added

---
## ⏭ Queue (AI platform foundation track elevated)

> **Heads up:** the AI platform foundation track is well underway. **AI-002 + AI-003** (provider modularization + per-call cost tracking) shipped in PR #20 — `backend/src/aiProvider.js` is now a 1-line re-export shim over 7 focused modules + 4 adapters, with `MODEL_PRICING` driving per-call cost telemetry. Full entries live in `ROADMAP.md` § Phase 5. Remaining order: **AI-004** (M, agent config schema, dormant — next slot) → **AI-005** (L, multi-agent dispatch — inherits 4 PR #20 post-ship tripwires: per-role sticky fallback, planner→author handshake, distributed trace ID, pre-run agent health check) → **AI-006** (M, per-role eval — inherits AST-scorer tripwire) → **AI-007** (M, cost governance — inherits atomic pre-flight + mid-stream-abort tripwires). AUTO-022b stays deferred (external LLM-key dependency); AUTO-014 and DIF-008 slot behind the AI track without conflict.

### 1 · AUTO-022b — Eval harness: record real LLM cache + first real baseline
**Effort:** M (4–8h focused maintainer session) | **Priority:** 🔴 Blocker (deferred — needs LLM API key) | **Dependencies:** AUTO-022 ✅ PR #17 plumbing | **Source:** `ROADMAP.md` Phase 5 (AUTO-022b) + `docs/guide/eval-harness-record-goldens.md`
Activate the dormant AUTO-022 regression gate by replacing the 50 synthetic golden snapshots with real DOM captures, recording `.cache/*.txt` against the live LLM via `EVAL_RECORD=1`, and committing the first real `eval-baseline.json`. Pure data PR — no new code, no schema changes. Currently deferred per maintainer call (recording requires LLM API key + 4–8h focused per-case iteration).
### 2 · AUTO-014 — Test dependency and execution ordering
**Effort:** M | **Priority:** 🔵 Medium | **Dependencies:** none | **Source:** `ROADMAP.md` Phase 4 (AUTO-014)
Add explicit per-test `dependsOn: [testId, ...]` declarations so prerequisite tests (login → create record → edit record → delete record) execute in topological order, downstream tests auto-skip when an upstream blocker fails (`skipReason: "upstream_failed"` marker), and circular-dependency declarations are rejected at save time. Closes the silent flakiness where AI-generated tests assume state from a previous test that ran in the wrong order. Touches `executeTest.js` dispatch loop, new `testDependencyResolver.js`, `RunDetail.jsx` (upstream-failure attribution badge), `TestDetail.jsx` (dependency picker). Zero overlap with INF-009's Helm / K8s deployment surface.
### 3 · DIF-008 — Jira / Linear issue sync
**Effort:** L | **Priority:** 🟢 Differentiator | **Dependencies:** FEA-001 ✅ (notification dispatch pattern) | **Source:** `ROADMAP.md` Phase 3 (DIF-008)
Add `POST /api/integrations/jira` and `POST /api/integrations/linear` settings endpoints to store OAuth tokens; on test-run failure auto-create a bug ticket (screenshot + error + Playwright trace attached); sync pass/fail status back to the linked issue's status field. Touches new `backend/src/utils/integrations.js`, `testRunner.js` `onComplete` hook, `routes/settings.js`, `Settings.jsx` Integrations tab.

---

## 🔀 Parallel opportunities

Items that do not overlap INF-009's changed files and can land in a separate PR while it is in flight. INF-009 touches `helm/sentri/` (new), `.github/workflows/nightly-backup.yml` + `helm-validate.yml` (new), `backend/src/worker.js` (new `/healthz` sidecar), `backend/src/middleware/appSetup.js` (extended `/api/v1/health` DB+Redis check), and new operator docs (`disaster-recovery.md`, `kubernetes-deployment.md`). Any PR touching the worker boot sequence, the health endpoint, or the deployment topology will conflict and should serialise.

| ID | Title | Effort | Priority | Shared files? |
|----|-------|--------|----------|---------------|
| AUTO-022b | Eval harness: record real LLM cache + first real baseline | M | 🔴 Blocker (deferred) | None — pure data PR in `backend/tests/fixtures/eval-goldens/` + `eval-baseline.json` |
| AUTO-014 | Test dependency and execution ordering | M | 🔵 Medium | None — `executeTest.js` dispatch loop, new `testDependencyResolver.js`, `RunDetail.jsx`, `TestDetail.jsx`. Zero overlap with INF-009's Helm / K8s surface. |
| DIF-008 | Jira / Linear issue sync | L | 🟢 Differentiator | None — `routes/settings.js`, `Settings.jsx`, new `utils/integrations.js` |
| SEC-005 | SAML / OIDC SSO federation | L | 🟢 Strategic | None — `routes/auth.js`, `middleware/authenticate.js`, `Settings.jsx` (different tab) |

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| AUTO-009 | Browser code coverage mapping (MVP + AUTO-009b/c/d/f/g/h/i/j follow-ups landed in the same PR). Opt-in per-project Playwright V8 JS coverage capture, `coverageAggregator.js` + `finalizeCoverage.js` (single source of truth for single-process AND sharded runs — fixes the parity gap that silently persisted `coverageSummary: null` on multi-shard runs), source-map resolution via `sourceMapResolver.js` (`source-map@^0.7` LRU cache, SSRF-guarded), `v8ToIstanbul.js` lift for statement/branch/function granularity, PR-scoped coverage diff via `coveragePrDiff.js` + `getChangedFilesWithRangesForPr` (single pagination pass against `/pulls/:n/files`), four new quality gates (`minCoveragePct`, `minBranchPct`, `minPrCoveragePct`, `maxCoverageRegressionPct`), AUTO-009g memory ceiling (`COVERAGE_MEMORY_CEILING_MB`, default 500), AUTO-009h server-side Istanbul/NYC coverage for API tests via `serverCoverageProxy.js` (HTTP `GET /__coverage__` SSRF-guarded + `file://` shared-FS modes, browser/server `layer` discriminator on `topUncoveredFiles[]`), AUTO-009i regression alerting via `coverageRegressionDetector.js` (Teams adaptive card / email / webhook through FEA-001 channels + `coverage.regression` audit row), AUTO-009j daily retention sweep in `scheduler.js`. 8 DB migrations (038–045), 8 new tests, E2E `coverage-ui.spec.mjs`, Dashboard `CoveragePanel` with Browser/Server/Combined layer toggle + Lines/Branches/Functions metric toggle + `sourceMapStatus` badge, `ProjectQualityCard` new "Coverage" tab, `TestRunView.jsx` per-test `+47L · +12B · +3F` delta badges, `RunDetail.jsx` `priorCoveragePct` regression context. `docs/guide/coverage-mapping.md` + `docs/guide/coverage-server-side.md` operator guides; QA.md AUTO-009 manual test checklist; `docs/changelog.md` updated. New deps: `source-map@^0.7.4`, `v8-to-istanbul@^9.3.0`. | #19 |
| MNT-001 + AUTO-022 | Vision-based locator healing (host-side stages 7 pixelmatch CV + 8 LLM vision with per-project budget circuit-breaker, SEC-007-compatible audit trail, `STRATEGY_VERSION` 3→4, baseline crop capture on green runs, coordinate re-action on heal, new Vision Healing tab on Quality card + Vision-based healing panel on Healing dashboard) **plus** AI eval harness plumbing (deterministic Levenshtein scorer over selector/action/assertion tuples, record/replay adapters keyed on `sha256(promptVersion + model + snapshot + url)`, 50-case golden fixture set with 5 canonical templates, path-filtered `eval.yml` CI workflow, Dashboard `EvalPanel` with 30-day trend + drill-down backed by `metric_samples`, cold-start guard so the merge isn't blocked on missing recordings — gate dormant until AUTO-022b records real LLM cache). | #17 |
| INF-007 | OpenTelemetry + Sentry observability — preloaded OTel SDK (`node --import ./src/otel-preload.mjs`) with auto-instrumentation for Express/pg/ioredis/HTTP; `requestId` via `AsyncLocalStorage` + `X-Request-Id` response header + `requestId`/`traceId`/`spanId` on every `formatLogLine()` + `structuredLog()` output (3-way Sentry→Loki→Jaeger correlation pivot); Prometheus `/metrics` endpoint with timing-safe Bearer-token auth via `crypto.timingSafeEqual` over SHA-256 digests and live `app_queue_depth` gauge refresh on every scrape; 14 brand-neutral `app_*` metrics (HTTP RED histograms with route-template labels never raw URLs, run lifecycle `app_runs_total` + `app_run_outcome_total` + `app_run_duration_seconds`, per-test `app_tests_executed_total` + `app_test_duration_seconds`, pipeline stage histogram, AI provider latency/token/error counters with `classifyAiError` cardinality-bounded label, BullMQ queue gauges); backend Sentry with multi-tenant `Sentry.setUser({ id })` + `workspace_id`/`user_role` tags from `workspaceScope.attachSentryContext` + `beforeSend` PII scrub of request headers; frontend `@sentry/react` with `browserTracingIntegration` route-change breadcrumbs + `stripUrlSecrets` query-string scrubber + `sendDefaultPii: false` + explicit deletion of auto-collected `email`/`username`/`ip_address`; 11 Prometheus alert rules in `monitoring/prometheus/alerts.yml` each with `runbook_url` anchors in new `docs/guide/observability.md` on-call runbook; every layer no-op when its env var is unset (`OTEL_EXPORTER_OTLP_ENDPOINT`, `METRICS_SCRAPE_KEY`, `SENTRY_DSN`, `VITE_SENTRY_DSN`); 9 integration tests in `backend/tests/observability.test.js` covering `/metrics` auth (no key / wrong token / correct token), Prometheus exposition format, `X-Request-Id` minting + inbound echo, OTel no-op behaviour, `formatLogLine` requestId propagation through `AsyncLocalStorage`. | #14 |
| SEC-007 | Compliance audit log — immutability gate (`DANGER_ALLOW_AUDIT_PURGE` + `audit.purge` meta-audit row emitted BEFORE truncate), 8 password-path `auth.*` events with IP+UA (rendered in dedicated column, not just tooltip), SHA-256 hash chain (`AUDIT_HASH_CHAIN`, boot-time mutual exclusion with `AUDIT_RETENTION_DAYS > 0`, skips pre-chain `prevHash IS NULL` rows on verify), cursor-paginated admin surface with CSV/NDJSON export (`createdAt` header column for SIEM importer parity) + anti-exfiltration rate-limiter, meta-audit (`audit.read`/`audit.export` per PCI-DSS 10.2.6), industry-standard event dedup matching Splunk / CloudTrail / Auth0 / Datadog convention (`AUDIT_DEDUP_WINDOW_SEC` default 60s, collapses identical reads with `count++`/`lastAt`, never deduped for destructive user actions, mutually exclusive with hash chain at the row level, migration `034_activities_dedup.sql`), UTC second-precision timestamps via `fmtAuditTimestamp` (PCI-DSS 10.3.3), daily retention sweep (`AUDIT_RETENTION_DAYS`), `SYSTEM_WORKSPACE_ID` sentinel + admin-only `GET /api/v1/system/security-events` for cross-tenant probe rows (unknown-email failed logins), SIEM forwarder (`dispatchSiemEvent` with HMAC-SHA256 signed NDJSON + system-headers-first spread + 32-char min key per NIST SP 800-107 + reserved-header rejection + 3-retry [0s/1s/2s] + DLQ), per-workspace SIEM config (AES-256-GCM encrypted secret with rotation-optional UPDATE), DLQ inspector + replay (`SIEM_NOT_CONFIGURED` 503 distinct from `SIEM_DISPATCH_FAILED` 502), `docs/guide/compliance.md` (incl. dedup section mapping to PCI-DSS 10.5.3), 44-step QA.md manual test plan, 3 backend test suites (audit-log-routes + audit-auth-events + audit-siem-forwarder) | #12 |


*Full completed list → ROADMAP.md § Completed Work Summary*
