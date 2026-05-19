# NEXT.md — Current Sprint Target

> **Agents:** Start here. Everything needed to begin the current PR is in this file. Open `ROADMAP.md` only to look up a specific item by ID or review phase context.
>
> **Humans:** When a PR ships — move the item to `ROADMAP.md` ✅ table, promote the next queue item to Current PR, and update Recently Completed.

---

## Bundling guidance

Flag adjacent items as bundling candidates in your PR description rather than expanding scope mid-flight. Good signals: items touch the same module, one validates the other end-to-end, or both are S/XS effort and skipping a handoff saves more than it costs in review surface. Bad signals: different phases, M+ effort expansion, or the candidate surfaces after CI is already green. When in doubt, comment on the PR and let the human decide — never silently expand beyond the Current PR checklist.

---

## ▶ Current PR — AUTO-009 — Browser code coverage mapping
**Effort:** L | **Priority:** 🟢 Differentiator | **Dependencies:** none | **Source:** `ROADMAP.md` Phase 4 (AUTO-009)
Collect V8/Istanbul JS coverage during Playwright runs, aggregate per-test deltas, and surface a coverage heatmap on the Dashboard alongside DIF-011's existing site graph. Closes the loop between "we ran 50 tests" and "we exercised 73% of the shipped JS bundle, here are the uncovered functions" — a differentiator versus Mabl / Testim / SmartBear, none of whom ship in-product coverage attribution.

**Problem:** Sentri runs Playwright tests and tells operators which assertions passed / failed, but never answers the related question — *which lines of the application's JS bundle did those tests actually exercise?* Operators currently have to wire up `c8` / `nyc` separately, instrument the SUT manually, and correlate file-level coverage with test runs by hand. Worse, when reviewers approve an AI-generated test, they have no signal whether it covers anything *new* versus duplicating coverage from an existing test — the per-test deltas matter more than the absolute totals.
**Fix:**
1. Wire `page.coverage.startJSCoverage()` / `stopJSCoverage()` into every Playwright test in `backend/src/runner/executeTest.js`, scoped to the SUT origin (skip third-party scripts and Sentri's own injected helpers) and gated behind a per-project `coverageEnabled` toggle so the perf overhead is opt-in.
2. New `backend/src/pipeline/coverageAggregator.js` — pure helper that walks Playwright's per-script coverage output, normalises to source-mapped line ranges (using `source-map@^0.7` against the SUT's published `.js.map` files when available, raw bundle line numbers as fallback), aggregates per-test → per-run → per-project coverage, and computes per-test *deltas* (which lines this test exercised that no prior test in the same run already covered).
3. Persist per-run coverage as a new JSON column `runs.coverageSummary` (migration `038_run_coverage.sql`) — `{ totalLines, coveredLines, coveragePct, perTest: [{ testId, deltaLines, deltaPct }], topUncoveredFiles: […] }`. Per-test rows stay in-memory only; only aggregates persist (full per-line data is too heavy for SQLite / Postgres at scale).
4. Frontend coverage heatmap on `Dashboard.jsx` — sparkline of project-wide coverage % over 30 days, list of "Top Uncovered Files" with line counts, per-test delta badges on `RunDetail.jsx` (`+47 lines`) so reviewers can see which AI-generated tests added real coverage vs duplicated existing tests.
5. Per-project toggle on `ProjectQualityCard.jsx` (Quality → new **Coverage** tab) — `coverageEnabled` boolean + optional `sourcemapBaseUrl` override for SUTs whose source maps live on a CDN separate from the JS bundles.
**Files to change:**
- `backend/src/runner/executeTest.js` — wire `page.coverage.startJSCoverage()` / `stopJSCoverage()` into the per-test runner; flag-gated on `project.coverageEnabled`
- `backend/src/pipeline/coverageAggregator.js` (new) — pure helper: parses Playwright coverage output, applies source maps via `source-map@^0.7`, computes per-test deltas + per-run aggregates + top-uncovered-files
- `backend/src/database/migrations/038_run_coverage.sql` (new) — `runs.coverageSummary` JSON column + `projects.coverageEnabled INTEGER NOT NULL DEFAULT 0` + optional `projects.sourcemapBaseUrl TEXT`
- `backend/src/database/repositories/runRepo.js` — register `coverageSummary` in `JSON_FIELDS` + `INSERT_COLS`
- `backend/src/database/repositories/projectRepo.js` — round-trip `coverageEnabled` + `sourcemapBaseUrl`; add to `SINGLE_FIELD_BYPASS` whitelist
- `backend/src/routes/projects.js` — validate `coverageEnabled` (boolean) + `sourcemapBaseUrl` (URL via existing `validateUrl` SSRF guard)
- `backend/src/routes/dashboard.js` — surface `coverageTrend` block (per-project 30-day series of project-wide pct) in the dashboard payload
- `backend/tests/coverage-aggregator.test.js` (new, registered in `run-tests.js`) — covers source-map fallback, raw-bundle path, per-test delta math, third-party-script filtering, top-uncovered-files ranking
- `backend/tests/run-coverage-integration.test.js` (new) — wires a stub Playwright page with synthetic `startJSCoverage` output, asserts `runs.coverageSummary` is persisted with the expected shape
- `frontend/src/pages/Dashboard.jsx` — new `CoveragePanel` with 30-day sparkline + Top Uncovered Files list + per-project breakdown
- `frontend/src/pages/RunDetail.jsx` — per-test `+N lines` delta badge in the test-result rows
- `frontend/src/components/automation/ProjectQualityCard.jsx` — new "Coverage" inner tab with toggle + optional sourcemap base URL
- `frontend/src/api.js` — `api.getCoverageTrend(projectId)` helper
- `docs/guide/coverage-mapping.md` (new) — operator guide: enabling coverage per project, source-map publishing prerequisites, interpreting per-test deltas, perf overhead expectations
- `docs/changelog.md` — `## [Unreleased]` § Added
- `QA.md` — new section "Browser code coverage (AUTO-009)" with manual test plan

**Acceptance criteria:**
- A run on a project with `coverageEnabled=true` against any SUT that ships source maps populates `run.coverageSummary` with `coveragePct` ∈ [0,1], non-empty `perTest[]`, and a `topUncoveredFiles[]` list capped at 20 entries.
- Disabling `coverageEnabled` (default) ships zero perf overhead and zero new columns populated — bit-for-bit identical to pre-AUTO-009 behaviour.
- A second test in the same run that exercises only already-covered code surfaces with `deltaLines: 0` (catches duplicate-coverage AI tests).
- Dashboard `CoveragePanel` renders a 30-day sparkline when at least one run has `coverageSummary != null`; gracefully renders an empty state with "Enable coverage on a project to start tracking" otherwise.
- Source-map resolution failures (404, malformed `.map`, no source map at all) degrade gracefully: aggregator falls back to raw bundle line numbers, marks `coverageSummary.sourceMapStatus: "fallback"` so operators can see why filenames look ugly. Coverage capture never fails the underlying test run (best-effort try/catch around the entire instrumentation block).

### PR checklist (AUTO-009)
- [ ] PR title follows Conventional Commits (`feat(auto): AUTO-009 — browser code coverage mapping`)
- [ ] Branch is off `develop`, not `main`
- [ ] `cd backend && npm test` passes locally (incl. new `coverage-aggregator.test.js` + `run-coverage-integration.test.js`)
- [ ] `cd frontend && npm run build && npm test` passes locally
- [ ] Dashboard `CoveragePanel` renders correctly with both populated runs AND empty state on a project with `coverageEnabled=false`
- [ ] Per-test delta badge on `RunDetail.jsx` correctly attributes `+N lines` to the test that first exercised them (no double-counting across tests in the same run)
- [ ] Source-map fallback path tested (point at a SUT without `.map` files; verify `sourceMapStatus: "fallback"` and raw bundle line numbers)
- [ ] Perf overhead measured: a 50-test run with coverage enabled completes within 1.3× the wall-clock time of the same run with coverage disabled (delta documented in PR description)
- [ ] New backend route `GET /api/v1/dashboard` `coverageTrend` block has a frontend consumer (`Dashboard.jsx` `CoveragePanel`) per PROC-001
- [ ] `docs/guide/coverage-mapping.md` documents enable / disable / interpret-deltas / source-map-prerequisites flows
- [ ] `docs/changelog.md` updated under `## [Unreleased]` § Added
- [ ] ROADMAP.md `### AUTO-009` section flipped to `**Status:** ✅ Complete (PR #N)` and Completed Work Summary row added

---
## ⏭ Queue (next 3 PRs after current)
### 1 · INF-009 — Helm chart + K8s readiness/liveness + DR playbook
**Effort:** L | **Priority:** 🟡 High | **Dependencies:** INF-008 ✅ (Postgres-default), INF-007 ✅ (metrics endpoint for liveness) | **Source:** `ROADMAP.md` Phase 5 (INF-009)
`helm/sentri/` chart with separate `backend` + `worker` Deployments, Postgres StatefulSet, Redis Deployment, ingress/configmap/secret; `readinessProbe`/`livenessProbe` on `GET /api/v1/health`; nightly `pg_dump` to S3 + restore playbook with explicit RTO (<4h) / RPO (<24h) targets.
### 2 · AUTO-022b — Eval harness: record real LLM cache + first real baseline
**Effort:** M (4–8h focused maintainer session) | **Priority:** 🔴 Blocker (deferred — needs LLM API key) | **Dependencies:** AUTO-022 ✅ PR #17 plumbing | **Source:** `ROADMAP.md` Phase 5 (AUTO-022b) + `docs/guide/eval-harness-record-goldens.md`
Activate the dormant AUTO-022 regression gate by replacing the 50 synthetic golden snapshots with real DOM captures, recording `.cache/*.txt` against the live LLM via `EVAL_RECORD=1`, and committing the first real `eval-baseline.json`. Pure data PR — no new code, no schema changes. Currently deferred per maintainer call (recording requires LLM API key + 4–8h focused per-case iteration).
### 3 · AUTO-014 — Test dependency and execution ordering
**Effort:** M | **Priority:** 🔵 Medium | **Dependencies:** none | **Source:** `ROADMAP.md` Phase 4 (AUTO-014)
Add explicit per-test `dependsOn: [testId, ...]` declarations so prerequisite tests (login → create record → edit record → delete record) execute in topological order, downstream tests auto-skip when an upstream blocker fails (`skipReason: "upstream_failed"` marker), and circular-dependency declarations are rejected at save time. Closes the silent flakiness where AI-generated tests assume state from a previous test that ran in the wrong order. Touches `executeTest.js` dispatch loop, new `testDependencyResolver.js`, `RunDetail.jsx` (upstream-failure attribution badge), `TestDetail.jsx` (dependency picker). Zero overlap with AUTO-009's coverage surface.

---

## 🔀 Parallel opportunities

Items that do not overlap AUTO-009's changed files and can land in a separate PR while it is in flight. AUTO-009 touches `backend/src/runner/executeTest.js`, new `backend/src/pipeline/coverageAggregator.js`, `runs.coverageSummary` column, `Dashboard.jsx` (new CoveragePanel), `RunDetail.jsx` (per-test delta badges), and `ProjectQualityCard.jsx` (new Coverage tab) — any PR touching the runner, the Dashboard payload, or `ProjectQualityCard` inner tabs will conflict and should wait.

| ID | Title | Effort | Priority | Shared files? |
|----|-------|--------|----------|---------------|
| INF-009 | Helm chart + K8s readiness/liveness + DR playbook | L | 🟡 High | None — `helm/sentri/` (new), `.github/workflows/nightly-backup.yml` (new) |
| AUTO-022b | Eval harness: record real LLM cache + first real baseline | M | 🔴 Blocker (deferred) | None — pure data PR in `backend/tests/fixtures/eval-goldens/` + `eval-baseline.json` |
| AUTO-014 | Test dependency and execution ordering | M | 🔵 Medium | ⚠️ Shares `executeTest.js` dispatch loop with AUTO-009's coverage instrumentation — must serialise these two PRs |
| DIF-008 | Jira / Linear issue sync | L | 🟢 Differentiator | None — `routes/settings.js`, `Settings.jsx`, new `utils/integrations.js` |
| SEC-005 | SAML / OIDC SSO federation | L | 🟢 Strategic | None — `routes/auth.js`, `middleware/authenticate.js`, `Settings.jsx` (different tab from AUTO-009's Coverage panel) |

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| INF-007 | OpenTelemetry + Sentry observability — preloaded OTel SDK (`node --import ./src/otel-preload.mjs`) with auto-instrumentation for Express/pg/ioredis/HTTP; `requestId` via `AsyncLocalStorage` + `X-Request-Id` response header + `requestId`/`traceId`/`spanId` on every `formatLogLine()` + `structuredLog()` output (3-way Sentry→Loki→Jaeger correlation pivot); Prometheus `/metrics` endpoint with timing-safe Bearer-token auth via `crypto.timingSafeEqual` over SHA-256 digests and live `app_queue_depth` gauge refresh on every scrape; 14 brand-neutral `app_*` metrics (HTTP RED histograms with route-template labels never raw URLs, run lifecycle `app_runs_total` + `app_run_outcome_total` + `app_run_duration_seconds`, per-test `app_tests_executed_total` + `app_test_duration_seconds`, pipeline stage histogram, AI provider latency/token/error counters with `classifyAiError` cardinality-bounded label, BullMQ queue gauges); backend Sentry with multi-tenant `Sentry.setUser({ id })` + `workspace_id`/`user_role` tags from `workspaceScope.attachSentryContext` + `beforeSend` PII scrub of request headers; frontend `@sentry/react` with `browserTracingIntegration` route-change breadcrumbs + `stripUrlSecrets` query-string scrubber + `sendDefaultPii: false` + explicit deletion of auto-collected `email`/`username`/`ip_address`; 11 Prometheus alert rules in `monitoring/prometheus/alerts.yml` each with `runbook_url` anchors in new `docs/guide/observability.md` on-call runbook; every layer no-op when its env var is unset (`OTEL_EXPORTER_OTLP_ENDPOINT`, `METRICS_SCRAPE_KEY`, `SENTRY_DSN`, `VITE_SENTRY_DSN`); 9 integration tests in `backend/tests/observability.test.js` covering `/metrics` auth (no key / wrong token / correct token), Prometheus exposition format, `X-Request-Id` minting + inbound echo, OTel no-op behaviour, `formatLogLine` requestId propagation through `AsyncLocalStorage`. | #14 |
| SEC-007 | Compliance audit log — immutability gate (`DANGER_ALLOW_AUDIT_PURGE` + `audit.purge` meta-audit row emitted BEFORE truncate), 8 password-path `auth.*` events with IP+UA (rendered in dedicated column, not just tooltip), SHA-256 hash chain (`AUDIT_HASH_CHAIN`, boot-time mutual exclusion with `AUDIT_RETENTION_DAYS > 0`, skips pre-chain `prevHash IS NULL` rows on verify), cursor-paginated admin surface with CSV/NDJSON export (`createdAt` header column for SIEM importer parity) + anti-exfiltration rate-limiter, meta-audit (`audit.read`/`audit.export` per PCI-DSS 10.2.6), industry-standard event dedup matching Splunk / CloudTrail / Auth0 / Datadog convention (`AUDIT_DEDUP_WINDOW_SEC` default 60s, collapses identical reads with `count++`/`lastAt`, never deduped for destructive user actions, mutually exclusive with hash chain at the row level, migration `034_activities_dedup.sql`), UTC second-precision timestamps via `fmtAuditTimestamp` (PCI-DSS 10.3.3), daily retention sweep (`AUDIT_RETENTION_DAYS`), `SYSTEM_WORKSPACE_ID` sentinel + admin-only `GET /api/v1/system/security-events` for cross-tenant probe rows (unknown-email failed logins), SIEM forwarder (`dispatchSiemEvent` with HMAC-SHA256 signed NDJSON + system-headers-first spread + 32-char min key per NIST SP 800-107 + reserved-header rejection + 3-retry [0s/1s/2s] + DLQ), per-workspace SIEM config (AES-256-GCM encrypted secret with rotation-optional UPDATE), DLQ inspector + replay (`SIEM_NOT_CONFIGURED` 503 distinct from `SIEM_DISPATCH_FAILED` 502), `docs/guide/compliance.md` (incl. dedup section mapping to PCI-DSS 10.5.3), 44-step QA.md manual test plan, 3 backend test suites (audit-log-routes + audit-auth-events + audit-siem-forwarder) | #12 |


*Full completed list → ROADMAP.md § Completed Work Summary*
