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
- [ ] PR title follows Conventional Commits (`feat(infra): INF-007 — OpenTelemetry + Sentry observability`)
- [ ] Branch is off `develop`, not `main`
- [ ] `cd backend && npm test` passes locally; new test file registered in `backend/tests/run-tests.js`
- [ ] `cd frontend && npm run build && npm test` passes locally
- [ ] OTel SDK init is the FIRST import in `backend/src/index.js` (before Express, before DB)
- [ ] `/metrics` endpoint protected by `METRICS_SCRAPE_KEY` — 401 without Bearer token
- [ ] `X-Request-Id` header present on every response; same ID in log lines
- [ ] `SENTRY_DSN` unset → zero runtime effect (no console warnings, no network calls)
- [ ] `OTEL_EXPORTER_OTLP_ENDPOINT` unset → zero runtime effect
- [ ] `backend/.env.example` documents all new env vars
- [ ] `docs/guide/env-vars.md` updated with Observability section
- [ ] `docs/changelog.md` updated under `## [Unreleased]`
- [ ] `permissions.json` updated if `/metrics` route is added
- [ ] No new `devDependencies` that should be `dependencies` (OTel + Sentry are runtime deps)
- [ ] ROADMAP.md `### INF-007` section flipped to `**Status:** ✅ Complete (PR #N)`

---
## ⏭ Queue (next 4 PRs after current)
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
| SEC-007 | Compliance audit log — immutability gate (`DANGER_ALLOW_AUDIT_PURGE`), 8 password-path `auth.*` events with IP+UA, SHA-256 hash chain (`AUDIT_HASH_CHAIN`), cursor-paginated admin surface with CSV/NDJSON export + anti-exfiltration rate-limiter, meta-audit (`audit.read`/`audit.export` per PCI-DSS 10.2.6), daily retention sweep (`AUDIT_RETENTION_DAYS`), SIEM forwarder (`dispatchSiemEvent` with HMAC-SHA256 + 3-retry + DLQ), per-workspace SIEM config (AES-256-GCM encrypted secret), DLQ inspector + replay, `docs/guide/compliance.md`, 44-step QA.md manual test plan, 3 backend test suites (audit-log-routes + audit-auth-events + audit-siem-forwarder) | #12 |
| SEC-006 | PII firewall — `domSanitizer` pipeline stage redacting emails / phones / SSNs / Luhn-checked cards / JWTs / Bearer & Basic auth headers / `?token=` / `?code=` / `?access_token=` query params before crawler snapshots reach `aiProvider.js`; deterministic placeholders, per-project `strictPiiFirewall` toggle + `piiAllowlist`, migration `030_projects_pii_firewall.sql`, `pipeline.pii_redacted` structured audit log | #11 |
| SEC-004 | MFA — TOTP enrollment + recovery codes + WebAuthn passkeys, per-workspace enforcement with grace period, JWT `amr` claim, login factor picker, audit logging | #10 |
| AUTO-008 | Distributed runner — standalone `worker` Compose service, `WORKER_CONCURRENCY` env var, dashboard worker-pool panel (Runner Mode / Queue Depth / Active Workers / Completed Jobs) | #9 |

*Full completed list → ROADMAP.md § Completed Work Summary*
