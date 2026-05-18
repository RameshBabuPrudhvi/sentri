# NEXT.md — Current Sprint Target

> **Agents:** Start here. Everything needed to begin the current PR is in this file. Open `ROADMAP.md` only to look up a specific item by ID or review phase context.
>
> **Humans:** When a PR ships — move the item to `ROADMAP.md` ✅ table, promote the next queue item to Current PR, and update Recently Completed.

---

## Bundling guidance

Flag adjacent items as bundling candidates in your PR description rather than expanding scope mid-flight. Good signals: items touch the same module, one validates the other end-to-end, or both are S/XS effort and skipping a handoff saves more than it costs in review surface. Bad signals: different phases, M+ effort expansion, or the candidate surfaces after CI is already green. When in doubt, comment on the PR and let the human decide — never silently expand beyond the Current PR checklist.

---

## ▶ Current PR — AUTO-022 — AI eval harness with golden-set regression
**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** INF-007 ✅ (`metric_samples` infra) | **Source:** `ROADMAP.md` Phase 5 (AUTO-022)
Ship a deterministic AI eval harness so prompt / model / pipeline changes can't silently regress test-generation quality. 50-case golden-set fixture; `backend/src/eval/pipelineEval.js` scores selectors / actions / assertions via Levenshtein distance against the expected output; new CI job `eval.yml` path-filtered to `pipeline/`, `aiProvider.js`, and prompt template files; fails the build on >5% regression vs the last green main run; persists per-case eval scores as `metric_samples` rows so trend charts on the Dashboard surface drift without re-running CI.

**Problem:** Every prompt tweak today is a leap of faith — there's no measurement showing whether a model swap or a prompt change moved selector / action / assertion quality up or down. Regressions surface as customer-reported flake spikes weeks after the change ships. INF-007's `metric_samples` table already gives us a place to persist trend data per-run; what's missing is a deterministic harness that produces those samples on every PR touching the pipeline.
**Fix:**
1. New 50-case golden fixture under `backend/tests/fixtures/eval-goldens/` — frozen DOM snapshots + expected Playwright code (selectors / actions / assertions) curated from the existing E2E corpus, covering form fills, list clicks, modal flows, multi-page navigation, and assertion-heavy success paths.
2. New `backend/src/eval/pipelineEval.js` — runs each golden through the same pipeline used in production (`generateAllTests` → `runPostGenerationPipeline`), parses output into structured (selector, action, assertion) tuples, and scores against the expected tuples via Levenshtein distance with explicit per-dimension weight knobs.
3. New `.github/workflows/eval.yml` — path-filtered to `backend/src/pipeline/**`, `backend/src/aiProvider.js`, and prompt template files. Runs `node backend/scripts/run-eval.mjs`, compares aggregate score to the last green main run pulled from a checked-in `eval-baseline.json`, fails on >5% regression.
4. Persist per-case eval scores as `metric_samples` rows (`kind=eval_score`) so the Dashboard renders a trend chart per selector / action / assertion dimension without re-running CI.
5. New `Eval` panel on `Dashboard.jsx` — sparkline of aggregate score over the last 30 days, drill-down to per-case rows, view-diff link to compare current vs expected output.
**Files to change:**
- `backend/tests/fixtures/eval-goldens/` (new) — 50 frozen `{ snapshot, expected }` JSON files
- `backend/src/eval/pipelineEval.js` (new) — runner + Levenshtein scorer
- `backend/scripts/run-eval.mjs` (new) — CLI entrypoint used by CI
- `backend/tests/eval-pipeline.test.js` (new, registered in `run-tests.js`) — unit-test the scorer against synthetic fixtures
- `.github/workflows/eval.yml` (new) — path-filtered CI job
- `eval-baseline.json` (new) — checked-in baseline; updated by maintainers via a dedicated `chore(eval):` PR after a deliberate prompt / model change
- `backend/src/routes/dashboard.js` — surface `evalTrend` aggregation in the dashboard payload
- `frontend/src/pages/Dashboard.jsx` — new `EvalPanel` with sparkline + drill-down
- `frontend/src/api.js` — `api.getEvalRunDetail(runId)` helper
- `docs/guide/eval-harness.md` (new) — operator guide: how to inspect a regression, how to update the baseline, how to add a new golden
- `docs/changelog.md` — `## [Unreleased]` § Added
**Acceptance criteria:**
- `node backend/scripts/run-eval.mjs` exits 0 on the current tree and produces a `metric_samples` row per golden case under `kind=eval_score`.
- Modifying a prompt file to deliberately lower selector quality on ≥3 cases makes `eval.yml` exit non-zero with a "regression vs baseline" message naming each affected case.
- Dashboard `EvalPanel` renders a 30-day sparkline + drill-down list when at least one eval-run row exists in `metric_samples`; gracefully renders an empty state otherwise.
- Aggregate score, per-dimension breakdowns, and per-case Levenshtein diffs are reproducible across runs given the same goldens + model — the scorer is pure.
### PR checklist (AUTO-022)
- [ ] PR title follows Conventional Commits (`feat(eval): AUTO-022 — AI eval harness with golden-set regression`)
- [ ] Branch is off `develop`, not `main`
- [ ] `cd backend && npm test` passes locally
- [ ] `cd frontend && npm run build && npm test` passes locally
- [ ] `node backend/scripts/run-eval.mjs` exits 0 on the current tree and writes one `metric_samples` row per golden under `kind=eval_score`
- [ ] `.github/workflows/eval.yml` runs on the PR with path filters matching pipeline + aiProvider + prompt template files; fails non-zero when a synthetic regression is introduced
- [ ] New backend route `GET /api/v1/dashboard` `evalTrend` block has a frontend consumer (`Dashboard.jsx` `EvalPanel`) per PROC-001
- [ ] `docs/guide/eval-harness.md` documents inspect-regression / update-baseline / add-golden workflows
- [ ] `docs/changelog.md` updated under `## [Unreleased]` § Added
- [ ] `eval-baseline.json` checked in with the current-tree baseline (auto-generated by the harness on first run)
- [ ] ROADMAP.md `### AUTO-022` section flipped to `**Status:** ✅ Complete (PR #N)` and Completed Work Summary row added

---
## ⏭ Queue (next 3 PRs after current)
### 1 · INF-009 — Helm chart + K8s readiness/liveness + DR playbook
**Effort:** L | **Priority:** 🟡 High | **Dependencies:** INF-008 ✅ (Postgres-default), INF-007 ✅ (metrics endpoint for liveness) | **Source:** `ROADMAP.md` Phase 5 (INF-009)
`helm/sentri/` chart with separate `backend` + `worker` Deployments, Postgres StatefulSet, Redis Deployment, ingress/configmap/secret; `readinessProbe`/`livenessProbe` on `GET /api/v1/health`; nightly `pg_dump` to S3 + restore playbook with explicit RTO (<4h) / RPO (<24h) targets.
### 2 · MNT-001 — Vision-based locator healing
**Effort:** XL | **Priority:** 🟢 Differentiator | **Dependencies:** none | **Source:** `ROADMAP.md` Maintenance row (MNT-001)
Add a vision-based fallback to `selfHealing.js` so locator failures route through an LLM screenshot pass before the test is marked broken. Wraps the existing DOM-only heal path; gated behind a per-project `visionHealing` toggle so OCR / vision-model spend stays opt-in. Touches `selfHealing.js` + `executeTest.js` only.
### 3 · AUTO-009 — Browser code coverage mapping
**Effort:** L | **Priority:** 🟢 Differentiator | **Dependencies:** none | **Source:** `ROADMAP.md` Phase 4 (AUTO-009)
Collect V8/Istanbul JS coverage during Playwright runs, aggregate per-test deltas, and surface a coverage heatmap on the Dashboard alongside DIF-011's existing site graph. Touches `executeTest.js`, new `coverageAggregator.js`, `Dashboard.jsx` — zero overlap with AUTO-022's eval-harness surface.

---

## 🔀 Parallel opportunities

Items that do not overlap AUTO-022's changed files and can land in a separate PR while it is in flight. AUTO-022 touches `backend/src/eval/`, `backend/src/aiProvider.js`, `backend/src/pipeline/`, prompt template files, `Dashboard.jsx`, and `.github/workflows/eval.yml` — any PR touching the AI pipeline or Dashboard payload will conflict and should wait.

| ID | Title | Effort | Priority | Shared files? |
|----|-------|--------|----------|---------------|
| INF-009 | Helm chart + K8s readiness/liveness + DR playbook | L | 🟡 High | None — `helm/sentri/` (new), `.github/workflows/nightly-backup.yml` (new) |
| MNT-001 | Vision-based locator healing | XL | 🟢 Differentiator | None — `selfHealing.js`, `executeTest.js` only |
| DIF-008 | Jira / Linear issue sync | L | 🟢 Differentiator | None — `routes/settings.js`, `Settings.jsx`, new `utils/integrations.js` |
| SEC-005 | SAML / OIDC SSO federation | L | 🟢 Strategic | None — `routes/auth.js`, `middleware/authenticate.js`, `Settings.jsx` (different tab from AUTO-022's Eval panel) |

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| INF-007 | OpenTelemetry + Sentry observability — preloaded OTel SDK (`node --import ./src/otel-preload.mjs`) with auto-instrumentation for Express/pg/ioredis/HTTP; `requestId` via `AsyncLocalStorage` + `X-Request-Id` response header + `requestId`/`traceId`/`spanId` on every `formatLogLine()` + `structuredLog()` output (3-way Sentry→Loki→Jaeger correlation pivot); Prometheus `/metrics` endpoint with timing-safe Bearer-token auth via `crypto.timingSafeEqual` over SHA-256 digests and live `app_queue_depth` gauge refresh on every scrape; 14 brand-neutral `app_*` metrics (HTTP RED histograms with route-template labels never raw URLs, run lifecycle `app_runs_total` + `app_run_outcome_total` + `app_run_duration_seconds`, per-test `app_tests_executed_total` + `app_test_duration_seconds`, pipeline stage histogram, AI provider latency/token/error counters with `classifyAiError` cardinality-bounded label, BullMQ queue gauges); backend Sentry with multi-tenant `Sentry.setUser({ id })` + `workspace_id`/`user_role` tags from `workspaceScope.attachSentryContext` + `beforeSend` PII scrub of request headers; frontend `@sentry/react` with `browserTracingIntegration` route-change breadcrumbs + `stripUrlSecrets` query-string scrubber + `sendDefaultPii: false` + explicit deletion of auto-collected `email`/`username`/`ip_address`; 11 Prometheus alert rules in `monitoring/prometheus/alerts.yml` each with `runbook_url` anchors in new `docs/guide/observability.md` on-call runbook; every layer no-op when its env var is unset (`OTEL_EXPORTER_OTLP_ENDPOINT`, `METRICS_SCRAPE_KEY`, `SENTRY_DSN`, `VITE_SENTRY_DSN`); 9 integration tests in `backend/tests/observability.test.js` covering `/metrics` auth (no key / wrong token / correct token), Prometheus exposition format, `X-Request-Id` minting + inbound echo, OTel no-op behaviour, `formatLogLine` requestId propagation through `AsyncLocalStorage`. | #14 |
| SEC-007 | Compliance audit log — immutability gate (`DANGER_ALLOW_AUDIT_PURGE` + `audit.purge` meta-audit row emitted BEFORE truncate), 8 password-path `auth.*` events with IP+UA (rendered in dedicated column, not just tooltip), SHA-256 hash chain (`AUDIT_HASH_CHAIN`, boot-time mutual exclusion with `AUDIT_RETENTION_DAYS > 0`, skips pre-chain `prevHash IS NULL` rows on verify), cursor-paginated admin surface with CSV/NDJSON export (`createdAt` header column for SIEM importer parity) + anti-exfiltration rate-limiter, meta-audit (`audit.read`/`audit.export` per PCI-DSS 10.2.6), industry-standard event dedup matching Splunk / CloudTrail / Auth0 / Datadog convention (`AUDIT_DEDUP_WINDOW_SEC` default 60s, collapses identical reads with `count++`/`lastAt`, never deduped for destructive user actions, mutually exclusive with hash chain at the row level, migration `034_activities_dedup.sql`), UTC second-precision timestamps via `fmtAuditTimestamp` (PCI-DSS 10.3.3), daily retention sweep (`AUDIT_RETENTION_DAYS`), `SYSTEM_WORKSPACE_ID` sentinel + admin-only `GET /api/v1/system/security-events` for cross-tenant probe rows (unknown-email failed logins), SIEM forwarder (`dispatchSiemEvent` with HMAC-SHA256 signed NDJSON + system-headers-first spread + 32-char min key per NIST SP 800-107 + reserved-header rejection + 3-retry [0s/1s/2s] + DLQ), per-workspace SIEM config (AES-256-GCM encrypted secret with rotation-optional UPDATE), DLQ inspector + replay (`SIEM_NOT_CONFIGURED` 503 distinct from `SIEM_DISPATCH_FAILED` 502), `docs/guide/compliance.md` (incl. dedup section mapping to PCI-DSS 10.5.3), 44-step QA.md manual test plan, 3 backend test suites (audit-log-routes + audit-auth-events + audit-siem-forwarder) | #12 |


*Full completed list → ROADMAP.md § Completed Work Summary*
