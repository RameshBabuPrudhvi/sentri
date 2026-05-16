# NEXT.md — Current Sprint Target

> **Agents:** Start here. Everything needed to begin the current PR is in this file. Open `ROADMAP.md` only to look up a specific item by ID or review phase context.
>
> **Humans:** When a PR ships — move the item to `ROADMAP.md` ✅ table, promote the next queue item to Current PR, and update Recently Completed.

---

## Bundling guidance

Flag adjacent items as bundling candidates in your PR description rather than expanding scope mid-flight. Good signals: items touch the same module, one validates the other end-to-end, or both are S/XS effort and skipping a handoff saves more than it costs in review surface. Bad signals: different phases, M+ effort expansion, or the candidate surfaces after CI is already green. When in doubt, comment on the PR and let the human decide — never silently expand beyond the Current PR checklist.

---

## ▶ Current PR — INF-007 — OTel / Sentry observability
**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** none — bundles naturally with MNT-013 (request-ID propagation) | **Source:** `ROADMAP.md` Phase 5 (INF-007)
`@opentelemetry/sdk-node` auto-instrumentation for Express/pg/Redis/HTTP; `requestId` via `AsyncLocalStorage` plumbed through `formatLogLine()`; Prometheus `/metrics` endpoint via `prom-client` (scrape-key protected); `@sentry/node` + `@sentry/react` behind `SENTRY_DSN` (no-op when unset).

**Problem:** Sentri has zero observability infrastructure. Backend errors surface only in `console.error`; there are no distributed traces, no structured metrics, no crash-reporting pipeline, and no Prometheus scrape endpoint. Operators deploying to production have no way to answer "what's slow?", "what's failing?", or "how many requests per second?" without grepping logs. Every competitor (Mabl, Testim, BrowserStack) ships with built-in APM.
**Fix:**
1. `@opentelemetry/sdk-node` with auto-instrumentations for Express (`@opentelemetry/instrumentation-express`), `pg` (`@opentelemetry/instrumentation-pg`), Redis (`@opentelemetry/instrumentation-ioredis`), and outbound HTTP (`@opentelemetry/instrumentation-http`). Exports traces via OTLP to any collector (Jaeger, Tempo, Datadog, Honeycomb) configured via `OTEL_EXPORTER_OTLP_ENDPOINT`.
2. `requestId` via `AsyncLocalStorage` — generated per-request in `appSetup.js`, plumbed through `formatLogLine()` so every log line carries a correlation ID. Exposed as `X-Request-Id` response header.
3. Prometheus `/metrics` endpoint via `prom-client` — default Node.js metrics + custom counters (`sentri_runs_total`, `sentri_tests_executed_total`, `sentri_crawl_pages_total`). Protected by `METRICS_SCRAPE_KEY` env var (Bearer token on the `/metrics` route).
4. `@sentry/node` + `@sentry/react` behind `SENTRY_DSN` env var — no-op when unset. Backend: Express error handler + `beforeSend` scrubber strips PII. Frontend: `ErrorBoundary` integration + breadcrumbs on route changes.
5. Bundle MNT-013 (request-ID propagation) into this PR since both touch `appSetup.js` + `formatLogLine()`.
**Files to change:**
- `backend/package.json` — add `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/exporter-trace-otlp-http`, `prom-client`, `@sentry/node`
- `frontend/package.json` — add `@sentry/react`
- `backend/src/middleware/appSetup.js` — OTel SDK init (must be first import), `AsyncLocalStorage` request-ID middleware, `/metrics` route
- `backend/src/utils/logFormatter.js` — read `requestId` from `AsyncLocalStorage` store, include in every `formatLogLine()` output
- `backend/src/utils/structuredLog.js` — add OTel span context to structured log events
- `backend/src/index.js` — Sentry init (after OTel), error handler registration
- `frontend/src/main.jsx` or `frontend/src/App.jsx` — Sentry browser init behind `VITE_SENTRY_DSN`
- `frontend/src/components/layout/ErrorBoundary.jsx` — wire Sentry `captureException`
- `backend/.env.example` — document `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `METRICS_SCRAPE_KEY`, `SENTRY_DSN`
- `docs/guide/env-vars.md` — new Observability section
- `docs/changelog.md` — `## [Unreleased]` § Added
- `backend/tests/observability.test.js` (new, registered in `run-tests.js`) — `/metrics` returns Prometheus text format, `X-Request-Id` header present on responses, OTel SDK initialises without throwing when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset
**Acceptance criteria:**
- `GET /metrics` returns `text/plain` Prometheus exposition format with `nodejs_*` default metrics + `sentri_runs_total` counter. Protected by `METRICS_SCRAPE_KEY` (401 without it).
- Every HTTP response carries `X-Request-Id` header; every `formatLogLine()` output includes the same ID.
- `OTEL_EXPORTER_OTLP_ENDPOINT` set → traces export to the configured collector (verify with Jaeger local). Unset → OTel SDK is a no-op (no crash, no console spam).
- `SENTRY_DSN` set → unhandled exceptions + unhandled rejections captured. Unset → Sentry is a no-op.
- Frontend `VITE_SENTRY_DSN` set → `ErrorBoundary` reports to Sentry. Unset → existing console-only behaviour unchanged.
- `cd backend && npm test` passes; new test file registered in `run-tests.js`.
- `cd frontend && npm run build` passes.
### PR checklist (INF-007)
- [x] PR title follows Conventional Commits (`feat(infra): INF-007 — OpenTelemetry + Sentry observability`)
- [x] Branch is off `develop`, not `main`
- [x] `cd backend && npm test` passes locally; new test file registered in `backend/tests/run-tests.js`
- [x] `cd frontend && npm run build && npm test` passes locally
- [x] OTel SDK init runs BEFORE any application module loads — via `node --import ./src/otel-preload.mjs` in `package.json` scripts, `Dockerfile` `CMD`, and the worker `docker-compose.yml` command (in-graph init was too late for `@opentelemetry/auto-instrumentations-node` to patch `express`/`pg`/`ioredis`).
- [x] `/metrics` endpoint protected by `METRICS_SCRAPE_KEY` — 401 without Bearer token
- [x] `X-Request-Id` header present on every response; same ID in log lines
- [x] `SENTRY_DSN` unset → zero runtime effect (no console warnings, no network calls)
- [x] `OTEL_EXPORTER_OTLP_ENDPOINT` unset → zero runtime effect
- [x] `backend/.env.example` documents all new env vars
- [x] `docs/guide/env-vars.md` updated with Observability section
- [x] `docs/changelog.md` updated under `## [Unreleased]`
- [x] `permissions.json` updated if `/metrics` route is added
- [x] No new `devDependencies` that should be `dependencies` (OTel + Sentry are runtime deps)
- [x] ROADMAP.md `### INF-007` section flipped to `**Status:** ✅ Complete (PR #14)`
- [x] Metric names use brand-neutral `app_*` prefix per `docs/guide/rebranding.md` (avoids adding rebrand-surface tokens for Prometheus dashboards / alerts).

---
## ⏭ Queue (next 3 PRs after current)
### 1 · INF-008 — Postgres-default + dual-DB CI matrix
**Effort:** M | **Priority:** 🔴 Blocker | **Dependencies:** INF-001 ✅ | **Source:** `ROADMAP.md` Phase 5 (INF-008)
Rename colliding migration prefixes (`007_*` × 2, `015_*` × 2); fix `migrationRunner.js` sort; default `.env.example` + `docker-compose.yml` to Postgres; CI matrix `db: [sqlite, postgres]` runs full `npm test` under both; new `lint-migrations.mjs` fails on duplicate prefixes.
### 2 · AUTO-022 — AI eval harness with golden-set regression
**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** INF-007 (`metric_samples` infra) | **Source:** `ROADMAP.md` Phase 5 (AUTO-022)
50-case golden-set fixture; `backend/src/eval/pipelineEval.js` scores selectors/actions/assertions via Levenshtein; CI job `eval.yml` path-filtered to `pipeline/` / `aiProvider.js` / prompt files; fails build on >5% regression; persists eval scores as `metric_samples` rows.
### 3 · INF-009 — Helm chart + K8s readiness/liveness + DR playbook
**Effort:** L | **Priority:** 🟡 High | **Dependencies:** INF-008 (Postgres-default), INF-007 (metrics endpoint for liveness) | **Source:** `ROADMAP.md` Phase 5 (INF-009)
`helm/sentri/` chart with separate `backend` + `worker` Deployments, Postgres StatefulSet, Redis Deployment, ingress/configmap/secret; `readinessProbe`/`livenessProbe` on `GET /api/v1/health`; nightly `pg_dump` to S3 + restore playbook with explicit RTO (<4h) / RPO (<24h) targets.

---

## 🔀 Parallel opportunities

Items that do not overlap INF-007's changed files and can land in a separate PR while it is in flight.

| ID | Title | Effort | Priority | Shared files? |
|----|-------|--------|----------|---------------|
| INF-008 | Postgres-default + dual-DB CI matrix | M | 🔴 Blocker | ⚠️ `backend/src/database/migrations/` — coordinate with any new migrations from INF-007 |
| AUTO-022 | AI eval harness with golden-set regression | L | 🔴 Blocker | None — `backend/src/eval/`, `pipelineOrchestrator.js`; no overlap with observability |
| MNT-001 | Vision-based locator healing | XL | 🟢 Differentiator | None — `selfHealing.js`, `executeTest.js` only |
| AUTO-009 | Browser code coverage mapping | L | 🟢 Differentiator | None — `executeTest.js`, `coverageAggregator.js`, `Dashboard.jsx` |

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| SEC-007 | Compliance audit log — immutability gate (`DANGER_ALLOW_AUDIT_PURGE` + `audit.purge` meta-audit row emitted BEFORE truncate), 8 password-path `auth.*` events with IP+UA (rendered in dedicated column, not just tooltip), SHA-256 hash chain (`AUDIT_HASH_CHAIN`, boot-time mutual exclusion with `AUDIT_RETENTION_DAYS > 0`, skips pre-chain `prevHash IS NULL` rows on verify), cursor-paginated admin surface with CSV/NDJSON export (`createdAt` header column for SIEM importer parity) + anti-exfiltration rate-limiter, meta-audit (`audit.read`/`audit.export` per PCI-DSS 10.2.6), industry-standard event dedup matching Splunk / CloudTrail / Auth0 / Datadog convention (`AUDIT_DEDUP_WINDOW_SEC` default 60s, collapses identical reads with `count++`/`lastAt`, never deduped for destructive user actions, mutually exclusive with hash chain at the row level, migration `034_activities_dedup.sql`), UTC second-precision timestamps via `fmtAuditTimestamp` (PCI-DSS 10.3.3), daily retention sweep (`AUDIT_RETENTION_DAYS`), `SYSTEM_WORKSPACE_ID` sentinel + admin-only `GET /api/v1/system/security-events` for cross-tenant probe rows (unknown-email failed logins), SIEM forwarder (`dispatchSiemEvent` with HMAC-SHA256 signed NDJSON + system-headers-first spread + 32-char min key per NIST SP 800-107 + reserved-header rejection + 3-retry [0s/1s/2s] + DLQ), per-workspace SIEM config (AES-256-GCM encrypted secret with rotation-optional UPDATE), DLQ inspector + replay (`SIEM_NOT_CONFIGURED` 503 distinct from `SIEM_DISPATCH_FAILED` 502), `docs/guide/compliance.md` (incl. dedup section mapping to PCI-DSS 10.5.3), 44-step QA.md manual test plan, 3 backend test suites (audit-log-routes + audit-auth-events + audit-siem-forwarder) | #12 |
| SEC-006 | PII firewall — `domSanitizer` pipeline stage redacting emails / phones / SSNs / Luhn-checked cards / JWTs / Bearer & Basic auth headers / `?token=` / `?code=` / `?access_token=` query params before crawler snapshots reach `aiProvider.js`; deterministic placeholders, per-project `strictPiiFirewall` toggle + `piiAllowlist`, migration `030_projects_pii_firewall.sql`, `pipeline.pii_redacted` structured audit log | #11 |
| SEC-004 | MFA — TOTP enrollment + recovery codes + WebAuthn passkeys, per-workspace enforcement with grace period, JWT `amr` claim, login factor picker, audit logging | #10 |
| AUTO-008 | Distributed runner — standalone `worker` Compose service, `WORKER_CONCURRENCY` env var, dashboard worker-pool panel (Runner Mode / Queue Depth / Active Workers / Completed Jobs) | #9 |

*Full completed list → ROADMAP.md § Completed Work Summary*
