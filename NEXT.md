# NEXT.md — Current Sprint Target

> **Agents:** Start here. Everything needed to begin the current PR is in this file. Open `ROADMAP.md` only to look up a specific item by ID or review phase context.
>
> **Humans:** When a PR ships — move the item to `ROADMAP.md` ✅ table, promote the next queue item to Current PR, and update Recently Completed.

---

## Bundling guidance

Flag adjacent items as bundling candidates in your PR description rather than expanding scope mid-flight. Good signals: items touch the same module, one validates the other end-to-end, or both are S/XS effort and skipping a handoff saves more than it costs in review surface. Bad signals: different phases, M+ effort expansion, or the candidate surfaces after CI is already green. When in doubt, comment on the PR and let the human decide — never silently expand beyond the Current PR checklist.

---

## ▶ Current PR — INF-008 — Postgres-default + dual-DB CI matrix
**Effort:** M | **Priority:** 🔴 Blocker | **Dependencies:** INF-001 ✅ | **Source:** `ROADMAP.md` Phase 5 (INF-008)
Promote PostgreSQL to the default DB and add a dual-DB CI matrix so SQLite-only regressions cannot reach `main`. Rename colliding migration prefixes (`007_*` × 2, `015_*` × 2), fix `migrationRunner.js` sort, default `.env.example` + `docker-compose.yml` to Postgres, add a CI matrix `db: [sqlite, postgres]` that runs full `npm test` under both engines, and add a new `scripts/lint-migrations.mjs` that fails on duplicate prefixes.

**Problem:** Sentri ships with SQLite as the default DB but production deployments need PostgreSQL. CI runs against SQLite only, so any Postgres-only regression (dialect-specific SQL, JSON-column shape mismatches, migration ordering issues) sneaks through review and surfaces in production. Two pairs of migrations collide on numeric prefix (`007_*` × 2, `015_*` × 2); `migrationRunner.js` resolves the collision by lexical filename sort which is non-deterministic on case-insensitive filesystems. Operators copy-pasting `.env.example` start on SQLite and only discover the prod ↔ dev drift after their first deploy.
**Fix:**
1. Rename the colliding migration prefixes — bump the second of each conflicting pair to the next free slot. Document the rule in a comment at the top of `migrationRunner.js` so future migrations don't recreate the collision.
2. Fix `migrationRunner.js` sort to use the numeric prefix (`parseInt(filename.split("_")[0])`) before falling back to the full filename, so newly-added migrations never reorder behind existing ones on case-insensitive filesystems.
3. Flip `.env.example`, `docker-compose.yml`, and `docs/guide/getting-started.md` to Postgres-default. SQLite stays as the supported quick-start escape hatch — documented but no longer the unannotated default.
4. CI matrix `db: [sqlite, postgres]` in `.github/workflows/ci.yml` runs the full `backend/npm test` lane under both engines. Postgres lane spins up a Postgres 16 service container; SQLite lane stays in-process. Both lanes gate merge.
5. New `scripts/lint-migrations.mjs` walks `backend/src/database/migrations/`, asserts every numeric prefix is unique, and is wired into the CI lint lane so a duplicate-prefix migration fails the build the same day it's pushed.
**Files to change:**
- `backend/src/database/migrations/` — rename one of each colliding `007_*` pair and one of each `015_*` pair to the next free prefix; update any cross-migration references
- `backend/src/database/migrationRunner.js` — numeric-prefix sort with full-filename tiebreaker; add a comment block at the top documenting the unique-prefix rule
- `backend/.env.example` — flip `DATABASE_URL` default to the bundled `postgres://…`; keep the SQLite line as a commented escape hatch
- `docker-compose.yml` — surface `postgres` in the default profile; document the `--profile sqlite` opt-out
- `.github/workflows/ci.yml` — add `strategy.matrix.db: [sqlite, postgres]` to the backend job, Postgres service-container block, env-var switch in test setup
- `scripts/lint-migrations.mjs` (new) — duplicate-prefix detector, exits non-zero on conflict, wired into CI
- `docs/guide/getting-started.md` — Postgres-first quick-start; SQLite kept as the "fastest local boot" alternative
- `docs/changelog.md` — `## [Unreleased]` § Changed (call out the default-flip as BREAKING for operators relying on the implicit SQLite default)
- `backend/tests/migration-runner.test.js` (new or extended, registered in `run-tests.js`) — covers numeric-prefix sort, duplicate-prefix detection in `lint-migrations.mjs`, and the dialect switch via `DATABASE_URL`
**Acceptance criteria:**
- Both CI lanes (`db: sqlite` + `db: postgres`) pass on the PR; failure on either gates the merge.
- `scripts/lint-migrations.mjs` exits 0 on the current tree and exits non-zero if a duplicate prefix is introduced (unit-tested with a temp-dir fixture).
- Fresh `docker compose up` on `develop` brings up Postgres + the backend and `GET /health` reports `db: postgres`.
- `backend/src/database/migrations/` has zero duplicate numeric prefixes when sorted.
- `cd backend && npm test` passes on both engines locally (`DATABASE_URL=postgres://…` and unset).
### PR checklist (INF-008)
- [ ] PR title follows Conventional Commits (`feat(infra): INF-008 — Postgres-default + dual-DB CI matrix`)
- [ ] Branch is off `develop`, not `main`
- [ ] `cd backend && npm test` passes locally under SQLite (`DATABASE_URL` unset)
- [ ] `cd backend && npm test` passes locally under Postgres (`DATABASE_URL=postgres://…`)
- [ ] `cd frontend && npm run build && npm test` passes locally
- [ ] `scripts/lint-migrations.mjs` exits 0 on the current tree; unit test covers duplicate-prefix detection
- [ ] CI matrix `db: [sqlite, postgres]` is wired in `.github/workflows/ci.yml` and both lanes are required for merge
- [ ] `backend/src/database/migrations/` has zero duplicate numeric prefixes (verify with `ls backend/src/database/migrations/ | awk -F_ '{print $1}' | sort | uniq -d` returning empty)
- [ ] `backend/.env.example` + `docker-compose.yml` default to Postgres; SQLite path documented as the escape hatch
- [ ] `docs/guide/getting-started.md` rewritten Postgres-first with SQLite kept as the alternative
- [ ] `docs/changelog.md` updated under `## [Unreleased]` § Changed, with BREAKING flag for the default-DB flip
- [ ] No new `devDependencies` that should be `dependencies` (none expected — Postgres driver `pg` is already a runtime dep via INF-001)
- [ ] ROADMAP.md `### INF-008` section flipped to `**Status:** ✅ Complete (PR #N)` and Completed Work Summary row added

---
## ⏭ Queue (next 3 PRs after current)
### 1 · AUTO-022 — AI eval harness with golden-set regression
**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** INF-007 ✅ (`metric_samples` infra) | **Source:** `ROADMAP.md` Phase 5 (AUTO-022)
50-case golden-set fixture; `backend/src/eval/pipelineEval.js` scores selectors/actions/assertions via Levenshtein; CI job `eval.yml` path-filtered to `pipeline/` / `aiProvider.js` / prompt files; fails build on >5% regression; persists eval scores as `metric_samples` rows.
### 2 · INF-009 — Helm chart + K8s readiness/liveness + DR playbook
**Effort:** L | **Priority:** 🟡 High | **Dependencies:** INF-008 (Postgres-default), INF-007 ✅ (metrics endpoint for liveness) | **Source:** `ROADMAP.md` Phase 5 (INF-009)
`helm/sentri/` chart with separate `backend` + `worker` Deployments, Postgres StatefulSet, Redis Deployment, ingress/configmap/secret; `readinessProbe`/`livenessProbe` on `GET /api/v1/health`; nightly `pg_dump` to S3 + restore playbook with explicit RTO (<4h) / RPO (<24h) targets.
### 3 · MNT-001 — Vision-based locator healing
**Effort:** XL | **Priority:** 🟢 Differentiator | **Dependencies:** none | **Source:** `ROADMAP.md` Maintenance row (MNT-001)
Add a vision-based fallback to `selfHealing.js` so locator failures route through an LLM screenshot pass before the test is marked broken. Wraps the existing DOM-only heal path; gated behind a per-project `visionHealing` toggle so OCR / vision-model spend stays opt-in. Touches `selfHealing.js` + `executeTest.js` only — zero overlap with INF-008's database surface.

---

## 🔀 Parallel opportunities

Items that do not overlap INF-008's changed files and can land in a separate PR while it is in flight. INF-008 touches `backend/src/database/migrations/`, `migrationRunner.js`, `.env.example`, `docker-compose.yml`, and `.github/workflows/ci.yml` — any PR adding a new migration or a new CI lane will conflict and should wait.

| ID | Title | Effort | Priority | Shared files? |
|----|-------|--------|----------|---------------|
| AUTO-022 | AI eval harness with golden-set regression | L | 🔴 Blocker | ⚠️ `.github/workflows/` — new `eval.yml` workflow file is independent of `ci.yml`, but coordinate the matrix-strategy change with INF-008 |
| MNT-001 | Vision-based locator healing | XL | 🟢 Differentiator | None — `selfHealing.js`, `executeTest.js` only |
| AUTO-009 | Browser code coverage mapping | L | 🟢 Differentiator | None — `executeTest.js`, `coverageAggregator.js`, `Dashboard.jsx` |
| DIF-008 | Jira / Linear issue sync | L | 🟢 Differentiator | None — `routes/settings.js`, `Settings.jsx`, new `utils/integrations.js` |

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| INF-007 | OpenTelemetry + Sentry observability — preloaded OTel SDK (`node --import ./src/otel-preload.mjs`) with auto-instrumentation for Express/pg/ioredis/HTTP; `requestId` via `AsyncLocalStorage` + `X-Request-Id` response header + `requestId`/`traceId`/`spanId` on every `formatLogLine()` + `structuredLog()` output (3-way Sentry→Loki→Jaeger correlation pivot); Prometheus `/metrics` endpoint with timing-safe Bearer-token auth via `crypto.timingSafeEqual` over SHA-256 digests and live `app_queue_depth` gauge refresh on every scrape; 14 brand-neutral `app_*` metrics (HTTP RED histograms with route-template labels never raw URLs, run lifecycle `app_runs_total` + `app_run_outcome_total` + `app_run_duration_seconds`, per-test `app_tests_executed_total` + `app_test_duration_seconds`, pipeline stage histogram, AI provider latency/token/error counters with `classifyAiError` cardinality-bounded label, BullMQ queue gauges); backend Sentry with multi-tenant `Sentry.setUser({ id })` + `workspace_id`/`user_role` tags from `workspaceScope.attachSentryContext` + `beforeSend` PII scrub of request headers; frontend `@sentry/react` with `browserTracingIntegration` route-change breadcrumbs + `stripUrlSecrets` query-string scrubber + `sendDefaultPii: false` + explicit deletion of auto-collected `email`/`username`/`ip_address`; 11 Prometheus alert rules in `monitoring/prometheus/alerts.yml` each with `runbook_url` anchors in new `docs/guide/observability.md` on-call runbook; every layer no-op when its env var is unset (`OTEL_EXPORTER_OTLP_ENDPOINT`, `METRICS_SCRAPE_KEY`, `SENTRY_DSN`, `VITE_SENTRY_DSN`); 9 integration tests in `backend/tests/observability.test.js` covering `/metrics` auth (no key / wrong token / correct token), Prometheus exposition format, `X-Request-Id` minting + inbound echo, OTel no-op behaviour, `formatLogLine` requestId propagation through `AsyncLocalStorage`. | #14 |
| SEC-007 | Compliance audit log — immutability gate (`DANGER_ALLOW_AUDIT_PURGE` + `audit.purge` meta-audit row emitted BEFORE truncate), 8 password-path `auth.*` events with IP+UA (rendered in dedicated column, not just tooltip), SHA-256 hash chain (`AUDIT_HASH_CHAIN`, boot-time mutual exclusion with `AUDIT_RETENTION_DAYS > 0`, skips pre-chain `prevHash IS NULL` rows on verify), cursor-paginated admin surface with CSV/NDJSON export (`createdAt` header column for SIEM importer parity) + anti-exfiltration rate-limiter, meta-audit (`audit.read`/`audit.export` per PCI-DSS 10.2.6), industry-standard event dedup matching Splunk / CloudTrail / Auth0 / Datadog convention (`AUDIT_DEDUP_WINDOW_SEC` default 60s, collapses identical reads with `count++`/`lastAt`, never deduped for destructive user actions, mutually exclusive with hash chain at the row level, migration `034_activities_dedup.sql`), UTC second-precision timestamps via `fmtAuditTimestamp` (PCI-DSS 10.3.3), daily retention sweep (`AUDIT_RETENTION_DAYS`), `SYSTEM_WORKSPACE_ID` sentinel + admin-only `GET /api/v1/system/security-events` for cross-tenant probe rows (unknown-email failed logins), SIEM forwarder (`dispatchSiemEvent` with HMAC-SHA256 signed NDJSON + system-headers-first spread + 32-char min key per NIST SP 800-107 + reserved-header rejection + 3-retry [0s/1s/2s] + DLQ), per-workspace SIEM config (AES-256-GCM encrypted secret with rotation-optional UPDATE), DLQ inspector + replay (`SIEM_NOT_CONFIGURED` 503 distinct from `SIEM_DISPATCH_FAILED` 502), `docs/guide/compliance.md` (incl. dedup section mapping to PCI-DSS 10.5.3), 44-step QA.md manual test plan, 3 backend test suites (audit-log-routes + audit-auth-events + audit-siem-forwarder) | #12 |
| SEC-006 | PII firewall — `domSanitizer` pipeline stage redacting emails / phones / SSNs / Luhn-checked cards / JWTs / Bearer & Basic auth headers / `?token=` / `?code=` / `?access_token=` query params before crawler snapshots reach `aiProvider.js`; deterministic placeholders, per-project `strictPiiFirewall` toggle + `piiAllowlist`, migration `030_projects_pii_firewall.sql`, `pipeline.pii_redacted` structured audit log | #11 |
| SEC-004 | MFA — TOTP enrollment + recovery codes + WebAuthn passkeys, per-workspace enforcement with grace period, JWT `amr` claim, login factor picker, audit logging | #10 |

*Full completed list → ROADMAP.md § Completed Work Summary*
