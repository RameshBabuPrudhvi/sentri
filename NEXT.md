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
6. New `GET /api/v1/audit/verify` admin-gated route walks the chain in date order and returns `{ verified: boolean, firstBrokenRowId, total }`. No-op (`{ verified: true, chainDisabled: true }`) when `AUDIT_HASH_CHAIN` is unset.
### Part B — Admin compliance surface + CSV/NDJSON export + retention sweep
7. New `GET /api/v1/workspaces/:workspaceId/audit-log` (admin-gated) with filters `userId`, `type[]` (multi-select), `dateFrom`, `dateTo`, `ipAddress`; paginated via ENH-010 cursor; returns rows with the new IP/UA columns.
8. `?format=csv` and `?format=ndjson` export params on the same route. Streamed response when result set ≤5MB; switches to ENH-007 signed-URL pattern (write to object storage, return `{ downloadUrl, expiresAt }`) above the threshold.
9. New `frontend/src/pages/AuditLog.jsx` mounted under Settings → Compliance (admin-only via `userHasRole(authUser, "admin")` in the route guard). Workspace-scoped filters, virtualized table for 10k+ rows, "Export CSV" / "Export NDJSON" buttons hit the new route. Distinct from the per-project Activity feed (developer view) — this is the compliance surface.
10. Daily retention sweep added to `backend/src/scheduler.js` honouring `AUDIT_RETENTION_DAYS` env var. Default 365 (matches SOC 2 Common Criteria CC7.2); hard floor 90 (rejected with boot-time error if operator sets lower). Sweep deletes rows older than the retention window unless `AUDIT_RETENTION_DAYS=0` (never delete).
11. New `docs/guide/compliance.md` documents retention policy, immutability contract, hash-chain verification procedure, and the SIEM integration shape.
### Part C — SIEM streaming (webhook forwarder)
12. Admin-configurable webhook target reusing `backend/src/utils/notifications.js` (FEA-001's dispatcher). Per-workspace config in the same Settings → Compliance panel: target URL, HMAC secret, optional headers.
13. Every audit-log INSERT enqueues a POST to the configured Splunk HEC / Datadog Logs Intake / Elastic ingest endpoint. NDJSON event payload, HMAC-SHA256-signed body (`X-Sentri-Audit-Signature: sha256=…`), retry with exponential backoff (3 attempts), dead-letter to a new `audit_dlq` table on persistent 5xx — surfaced as a count + "retry failed" badge on the AuditLog UI.
14. New `backend/src/database/repositories/auditDlqRepo.js` exposes `enqueue(row, error)` and `replay(id)` (admin-only route `POST /api/v1/workspaces/:id/audit-log/dlq/:dlqId/replay`).
15. Document the integration shape in `docs/guide/compliance.md` so customers can wire their own SIEM without proprietary connectors.
**Files to change:**
- `backend/src/database/migrations/031_activities_compliance.sql` — new; adds `ipAddress`, `userAgent`, `prevHash` (nullable) columns; creates `audit_dlq (id, workspaceId, rowSnapshot, lastError, attempts, createdAt)` table
- `backend/src/utils/activityLogger.js` — capture `req.ip` + `req.get('user-agent')`; optional hash-chain when `AUDIT_HASH_CHAIN=true`; fire-and-forget SIEM dispatch on every INSERT
- `backend/src/database/repositories/activityRepo.js` — persist new columns; new `getByWorkspace(workspaceId, filters, cursor)` accessor with paginated cursor; surface `ipAddress` / `userAgent` on read
- `backend/src/database/repositories/auditDlqRepo.js` — new; `enqueue`, `list`, `replay`
- `backend/src/constants/activityTypes.js` + `frontend/src/constants/activityTypes.js` — add 8 `auth.*` event literals (keep both files in sync per existing convention)
- `backend/src/routes/auth.js` — emit the 7 new `auth.*` activity rows on the matching success/failure branches
- `backend/src/routes/system.js` — env-gate `DELETE /api/v1/data/activities` behind `DANGER_ALLOW_AUDIT_PURGE`
- `backend/src/routes/workspaces.js` (or new `backend/src/routes/audit.js`) — `GET /workspaces/:workspaceId/audit-log` with CSV/NDJSON export, `GET /audit/verify`, `POST /workspaces/:id/audit-log/dlq/:dlqId/replay`
- `backend/src/utils/notifications.js` — extend dispatcher to support the SIEM webhook target type (HMAC-SHA256, NDJSON body, DLQ on persistent 5xx)
- `backend/src/scheduler.js` — daily retention sweep honouring `AUDIT_RETENTION_DAYS`
- `backend/src/middleware/permissions.json` — register `GET /api/v1/workspaces/:workspaceId/audit-log` (admin), `GET /audit/verify` (admin), `POST /workspaces/:id/audit-log/dlq/:dlqId/replay` (admin)
- `backend/.env.example` — document `DANGER_ALLOW_AUDIT_PURGE` (off), `AUDIT_HASH_CHAIN` (off), `AUDIT_RETENTION_DAYS` (365, floor 90)
- `frontend/src/pages/AuditLog.jsx` — new; admin-only Settings → Compliance surface with virtualized table, type/user/date/IP filters, CSV/NDJSON export buttons, SIEM config panel, DLQ inspector + replay button
- `frontend/src/api.js` — `getWorkspaceAuditLog(workspaceId, filters)`, `exportWorkspaceAuditLog(workspaceId, filters, format)`, `verifyAuditChain()`, `replayAuditDlq(workspaceId, dlqId)`, `getWorkspaceSiemConfig(workspaceId)`, `updateWorkspaceSiemConfig(workspaceId, config)` helpers (PROC-001 invariant — every new route gets a real consumer)
- `docs/changelog.md` `## [Unreleased]` § Security + § Added
- `docs/guide/compliance.md` — new; retention policy, immutability contract, hash-chain verification, SIEM integration shape (HMAC scheme, NDJSON schema, retry semantics)
- `QA.md` § Compliance audit log (SEC-007) — manual test plan covering each new event type, IP/UA capture, the purge-route env-gate, the admin surface filters, CSV/NDJSON export round-trip, retention boundary, hash-chain verification, SIEM forwarder happy path + DLQ replay
- `backend/tests/audit-log-routes.test.js` (new, registered in `backend/tests/run-tests.js`) — covers admin-gating, workspace-scoped filtering, CSV/NDJSON export (small + large via signed-URL fallback), retention-sweep correctness, hash-chain verification round-trip, SIEM webhook dispatch + DLQ enqueue on 5xx + replay
- `backend/tests/audit-auth-events.test.js` (new) — each `auth.*` emission path asserts `ipAddress` + `userAgent` columns; `DELETE /activities` 403/200 env-gate cases; null-tolerant read of historical rows
**Acceptance criteria:**
- `DELETE /api/v1/data/activities` returns `403 AUDIT_PURGE_DISABLED` on a default deployment; only succeeds when `DANGER_ALLOW_AUDIT_PURGE=true` is set in env.
- Every successful login, failed login, logout, password reset, role change, API-key create/revoke, and session revoke produces exactly one row in `activities` with the matching `type`, `userId`, `ipAddress`, and `userAgent`.
- Reading historical rows (created before the migration) returns `ipAddress: null` / `userAgent: null` without crashing the `/activities` or new `/audit-log` list endpoints.
- `GET /api/v1/workspaces/:workspaceId/audit-log?format=ndjson&dateFrom=…&dateTo=…` streams NDJSON with all matching rows. Viewer role gets 403; only `admin` reads the workspace audit log.
- `?format=csv` returns headers `timestamp,userId,userName,type,meta,ipAddress,userAgent,workspaceId` and an RFC 4180-compliant body. Responses ≤5MB stream inline; larger writes to object storage and returns `{ downloadUrl, expiresAt }` (ENH-007 signed URL).
- Retention sweep deletes rows older than `AUDIT_RETENTION_DAYS` once daily; `AUDIT_RETENTION_DAYS=0` disables; values <90 are rejected at boot with a clear error.
- With `AUDIT_HASH_CHAIN=true`, `GET /audit/verify` returns `{ verified: true, total: N }` on a clean chain and `{ verified: false, firstBrokenRowId }` after a tampered row.
- SIEM webhook fires on every new audit row when configured; HMAC `X-Sentri-Audit-Signature: sha256=…` matches `sha256(secret + body)`; persistent 5xx after 3 attempts lands in `audit_dlq`, surfaces on AuditLog UI, and `POST /audit-log/dlq/:id/replay` re-enqueues exactly that row.
- `permissions.json` registers the 3 new admin endpoints; PROC-001 satisfied by `AuditLog.jsx` consuming every new route via `api.js` helpers.
### PR checklist (SEC-007 full scope)
- [ ] PR title follows Conventional Commits (e.g. `feat(security): SEC-007 — compliance audit log surface (immutability + export + retention + SIEM)`)
- [ ] Branch is off `develop`, not `main`
- [ ] `cd backend && npm test` passes locally; both new test files registered in `backend/tests/run-tests.js`
- [ ] `cd frontend && npm run build && npm test` passes locally (activity-type literal sync verified between `backend/src/constants/activityTypes.js` and `frontend/src/constants/activityTypes.js`)
- [ ] Migration `031_activities_compliance.sql` is additive and null-tolerant; verified on both SQLite and Postgres adapters; rolls forward cleanly on a DB that already has historical `activities` rows
- [ ] `DELETE /api/v1/data/activities` env-gate verified — default deployment returns 403 `AUDIT_PURGE_DISABLED`
- [ ] All 7 password-path `auth.*` activity emissions wired in `backend/src/routes/auth.js` and asserted by `backend/tests/audit-auth-events.test.js`
- [ ] CSV + NDJSON export tested for both inline-streaming (≤5MB) and signed-URL (>5MB) paths
- [ ] Retention sweep boot-error verified for `AUDIT_RETENTION_DAYS < 90`; sweep no-op verified for `AUDIT_RETENTION_DAYS=0`
- [ ] Hash-chain feature flag verified — chain disabled by default, `/audit/verify` no-ops correctly; chain enabled produces deterministic `prevHash` round-trip and detects a manually-tampered row
- [ ] SIEM webhook: happy path POST verified end-to-end; 5xx triggers DLQ insert after 3 attempts; replay route re-emits the exact stored payload
- [ ] `permissions.json` updated for the 3 new admin endpoints (`GET /workspaces/:id/audit-log`, `GET /audit/verify`, `POST /workspaces/:id/audit-log/dlq/:dlqId/replay`)
- [ ] `docs/changelog.md` `## [Unreleased]` updated under § Security + § Added (single `### Security` and `### Added` heading per Keep a Changelog — no duplicate headings)
- [ ] `docs/guide/compliance.md` published with retention policy, immutability contract, hash-chain verification procedure, and SIEM integration shape (HMAC scheme, NDJSON event schema, retry semantics)
- [ ] `QA.md` § Compliance audit log (SEC-007) added with full manual test plan
- [ ] PROC-001: `AuditLog.jsx` consumes every new route via `api.js` helpers — no orphan backend routes
- [ ] ROADMAP.md `### SEC-007` section flipped from queue-text to `**Status:** ✅ Complete (PR #N)` stub with full implementation prose moved to the Completed Work Summary table
---
## ⏭ Queue (next 4 PRs after current)
### 1 · INF-008 — Postgres-default + dual-DB CI matrix
**Effort:** M | **Priority:** 🔴 Blocker | **Dependencies:** INF-001 ✅ | **Source:** `ROADMAP.md` Phase 5 (INF-008)
Rename colliding migration prefixes (`007_*` × 2, `015_*` × 2); fix `migrationRunner.js` sort; default `.env.example` + `docker-compose.yml` to Postgres; CI matrix `db: [sqlite, postgres]` runs full `npm test` under both; new `lint-migrations.mjs` fails on duplicate prefixes.
### 3 · AUTO-022 — AI eval harness with golden-set regression
**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** INF-007 (`metric_samples` infra) | **Source:** `ROADMAP.md` Phase 5 (AUTO-022)
50-case golden-set fixture; `backend/src/eval/pipelineEval.js` scores selectors/actions/assertions via Levenshtein; CI job `eval.yml` path-filtered to `pipeline/` / `aiProvider.js` / prompt files; fails build on >5% regression; persists eval scores as `metric_samples` rows.
### 4 · INF-009 — Helm chart + K8s readiness/liveness + DR playbook
**Effort:** L | **Priority:** 🟡 High | **Dependencies:** INF-008 (Postgres-default), INF-007 (metrics endpoint for liveness) | **Source:** `ROADMAP.md` Phase 5 (INF-009)
`helm/sentri/` chart with separate `backend` + `worker` Deployments, Postgres StatefulSet, Redis Deployment, ingress/configmap/secret; `readinessProbe`/`livenessProbe` on `GET /api/v1/health`; nightly `pg_dump` to S3 + restore playbook with explicit RTO (<4h) / RPO (<24h) targets.

---


## 🔀 Parallel opportunities

Items that do not overlap SEC-007 Phase 1's changed files and can land in a separate PR while it is in flight. "Shared files?" lists any files that *would* conflict if merged concurrently — flag in your PR description if you pick one up.

| ID | Title | Effort | Priority | Shared files? |
|----|-------|--------|----------|---------------|
| INF-007 | OTel / Sentry observability | L | 🔴 Blocker | ⚠️ `backend/src/utils/activityLogger.js` (request-context plumbing overlaps with SEC-007's `req.ip` capture) and `backend/src/utils/notifications.js` (SEC-007 extends the dispatcher for SIEM) — coordinate timing; SEC-007 should merge first |
| INF-008 | Postgres-default + dual-DB CI matrix | M | 🔴 Blocker | ⚠️ `backend/src/database/migrations/` — INF-008 renames colliding prefixes; coordinate with the new `031_activities_compliance.sql` ordering so it doesn't get renumbered mid-flight |
| AUTO-022 | AI eval harness with golden-set regression | L | 🔴 Blocker | None — `backend/src/eval/`, `pipelineOrchestrator.js`, `metricSampleRepo.js`; no overlap with audit-log work |
| MNT-001 | Vision-based locator healing | XL | 🟢 Differentiator | None — `selfHealing.js`, `executeTest.js` only |
| AUTO-009 | Browser code coverage mapping | L | 🟢 Differentiator | None — `executeTest.js`, `coverageAggregator.js`, `Dashboard.jsx` |
| MNT-013 | Request-ID propagation via `AsyncLocalStorage` | S | 🟡 High | ⚠️ Bundles naturally with INF-007 and SEC-007 — all three touch `appSetup.js` + `activityLogger.js` / `logFormatter.js`; consider landing inside SEC-007 if scope allows |

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| SEC-007 | Compliance audit log — immutability gate (`DANGER_ALLOW_AUDIT_PURGE`), 8 password-path `auth.*` events with IP+UA, SHA-256 hash chain (`AUDIT_HASH_CHAIN`), cursor-paginated admin surface with CSV/NDJSON export + anti-exfiltration rate-limiter, meta-audit (`audit.read`/`audit.export` per PCI-DSS 10.2.6), daily retention sweep (`AUDIT_RETENTION_DAYS`), SIEM forwarder (`dispatchSiemEvent` with HMAC-SHA256 + 3-retry + DLQ), per-workspace SIEM config (AES-256-GCM encrypted secret), DLQ inspector + replay, `docs/guide/compliance.md`, 44-step QA.md manual test plan, 3 backend test suites (audit-log-routes + audit-auth-events + audit-siem-forwarder) | #12 |
| SEC-006 | PII firewall — `domSanitizer` pipeline stage redacting emails / phones / SSNs / Luhn-checked cards / JWTs / Bearer & Basic auth headers / `?token=` / `?code=` / `?access_token=` query params before crawler snapshots reach `aiProvider.js`; deterministic placeholders, per-project `strictPiiFirewall` toggle + `piiAllowlist`, migration `030_projects_pii_firewall.sql`, `pipeline.pii_redacted` structured audit log | #11 |
| SEC-004 | MFA — TOTP enrollment + recovery codes + WebAuthn passkeys, per-workspace enforcement with grace period, JWT `amr` claim, login factor picker, audit logging | #10 |
| AUTO-008 | Distributed runner — standalone `worker` Compose service, `WORKER_CONCURRENCY` env var, dashboard worker-pool panel (Runner Mode / Queue Depth / Active Workers / Completed Jobs) | #9 |

*Full completed list → ROADMAP.md § Completed Work Summary*
