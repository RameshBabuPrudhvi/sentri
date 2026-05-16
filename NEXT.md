# NEXT.md — Current Sprint Target

> **Agents:** Start here. Everything needed to begin the current PR is in this file. Open `ROADMAP.md` only to look up a specific item by ID or review phase context.
>
> **Humans:** When a PR ships — move the item to `ROADMAP.md` ✅ table, promote the next queue item to Current PR, and update Recently Completed.

---

## Bundling guidance

Flag adjacent items as bundling candidates in your PR description rather than expanding scope mid-flight. Good signals: items touch the same module, one validates the other end-to-end, or both are S/XS effort and skipping a handoff saves more than it costs in review surface. Bad signals: different phases, M+ effort expansion, or the candidate surfaces after CI is already green. When in doubt, comment on the PR and let the human decide — never silently expand beyond the Current PR checklist.

---

## ✅ Recently shipped — SEC-006 — PII firewall (PR #11)

**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** ACL-001 ✅ | **Source:** `ROADMAP.md` Phase 5 (SEC-006)

**Problem:** AI prompts include raw DOM snapshots from crawled pages. When the SUT renders PII (emails, SSNs, payment cards, auth tokens in URLs), that data is shipped to the configured LLM provider — a GDPR / HIPAA / PCI compliance hole for any customer running Sentri against a production-like environment.

**Fix:** Add a `domSanitizer.js` pipeline stage between the crawler and the AI prompt builder that scrubs known PII patterns (emails, phone numbers, SSNs, credit-card numbers, JWTs, Bearer tokens, query-string auth params) from the DOM snapshot before it reaches `aiProvider.js`. Replace each match with a deterministic placeholder (`<EMAIL_1>` / `<PHONE_1>` / `<CARD_1>` / `<TOKEN_1>`) so the AI can still reason about structure. Configurable allowlist for domains/fields that opt out (e.g. demo apps where the email IS the test data).

**Files to change:**
- `backend/src/pipeline/domSanitizer.js` — new pipeline stage with regex + Luhn-checked card detection
- `backend/src/pipeline/pipelineOrchestrator.js` — wire the sanitizer between crawler and prompt builder
- `backend/src/database/migrations/` — `projects.piiAllowlist` JSON column
- `frontend/src/pages/Settings.jsx` — workspace-level "Strict PII firewall" toggle + per-project allowlist UI
- `docs/changelog.md` `## [Unreleased]` § Added + § Security

**Acceptance criteria:**
- Crawler output is sanitized BEFORE it reaches `aiProvider.js`; verify by intercepting the prompt payload
- Emails, phones, SSNs, credit cards (Luhn-checked), JWTs, Bearer tokens, query-string `?token=` / `?code=` / `?access_token=` redacted
- Replacements are deterministic (same input → same placeholder ID within a single crawl) so the AI can correlate references
- Per-project allowlist lets users opt fields/patterns out for demo / training data
- Audit log emits `pipeline.pii_redacted` with counts per category per run

### PR checklist (SEC-006)
- [x] PII patterns covered: email, US/E.164 phone, SSN, credit card (Luhn), JWT, Bearer/Basic header, common auth query params
- [x] Deterministic placeholders within a single run; counters reset per run (shared `createPiiContext` across snapshots + classified pages; per-category `seq`)
- [x] Per-project allowlist persisted + enforced (exact-value match, case-insensitive)
- [x] `backend/tests/pii-sanitizer.test.js` — pattern coverage + Luhn cases + allowlist + determinism + audit-log shape
- [x] `permissions.json` — no new endpoint; reuses existing `PATCH /api/v1/projects/:id`
- [x] `docs/changelog.md` `## [Unreleased]` updated
- [x] `QA.md` § PII Firewall added with manual test plan
- [x] PROC-001: `strictPiiFirewall` / `piiAllowlist` consumed by `frontend/src/components/automation/ProjectQualityCard.jsx` (PII Firewall inner tab)

---

## ▶ Current PR — SEC-007 — Compliance audit log surface (Phase 1: immutability + auth events)

**Effort:** M | **Priority:** 🟡 High | **Dependencies:** SEC-004 ✅ (MFA emits `auth.mfa.*` rows), ACL-001 ✅ | **Source:** `ROADMAP.md` Phase 5 (SEC-007)

**Problem:** Sentri's `activities` table is the de-facto audit log but fails SOC 2 / ISO 27001 on six counts: (1) admins can truncate it via `DELETE /api/v1/data/activities` in `backend/src/routes/system.js`; (2) password-path auth events (`auth.login`, `auth.login.failed`, `auth.logout`, `auth.password.reset`, `auth.role.change`, `auth.api_key.{create,revoke}`, `auth.session.revoke`) are not emitted — only the MFA subset is; (3) rows lack `ipAddress` / `userAgent` so an auditor cannot reconstruct session context; (4) no admin compliance surface (the per-project Activity feed is a developer view); (5) no CSV / NDJSON export; (6) no retention policy or SIEM streaming.

**Fix (Phase 1 only — Phase 2 admin surface + export and Phase 3 SIEM are tracked in `ROADMAP.md` § SEC-007 and ship in follow-ups):**
1. Env-gate `DELETE /api/v1/data/activities` behind `DANGER_ALLOW_AUDIT_PURGE=true` (default off). 403 with `AUDIT_PURGE_DISABLED` error code otherwise.
2. Additive migration `031_activities_compliance.sql` adding `ipAddress TEXT NULL`, `userAgent TEXT NULL` to `activities`. Null-tolerant for historical rows.
3. `backend/src/utils/activityLogger.js` — extend `logActivity({ req, … })` to capture `req.ip` (honouring `app.set('trust proxy')`) + `req.get('user-agent')`. Backwards-compatible: callers without `req` keep working with nulls.
4. New `ACTIVITY_TYPES` entries in `backend/src/constants/activityTypes.js` mirrored in `frontend/src/constants/activityTypes.js`: `auth.login`, `auth.login.failed`, `auth.logout`, `auth.password.reset`, `auth.role.change`, `auth.api_key.create`, `auth.api_key.revoke`, `auth.session.revoke`.
5. Emit each new event from the matching handler in `backend/src/routes/auth.js`.

**Files to change:**
- `backend/src/database/migrations/031_activities_compliance.sql` — new (additive `ipAddress` + `userAgent` columns)
- `backend/src/utils/activityLogger.js` — capture `req.ip` + `req.get('user-agent')`
- `backend/src/database/repositories/activityRepo.js` — persist + surface the two new columns
- `backend/src/constants/activityTypes.js` + `frontend/src/constants/activityTypes.js` — add `auth.*` event literals (keep in sync per existing convention)
- `backend/src/routes/auth.js` — emit the 7 new `auth.*` activity rows on the matching success/failure branches
- `backend/src/routes/system.js` — env-gate `DELETE /api/v1/data/activities` behind `DANGER_ALLOW_AUDIT_PURGE`
- `backend/.env.example` — document `DANGER_ALLOW_AUDIT_PURGE` (default unset / off)
- `docs/changelog.md` `## [Unreleased]` § Security + § Added
- `QA.md` § Compliance audit log (SEC-007 Phase 1) — manual test plan
- `backend/tests/audit-log-phase1.test.js` (new, registered in `backend/tests/run-tests.js`) — covers each `auth.*` emission with `ipAddress` + `userAgent` assertions, `DELETE /activities` 403/200 env-gate cases, and null-tolerant read of historical rows

**Acceptance criteria:**
- `DELETE /api/v1/data/activities` returns `403 AUDIT_PURGE_DISABLED` on a default deployment; only succeeds when `DANGER_ALLOW_AUDIT_PURGE=true` is set.
- Every successful login, failed login, logout, password reset, role change, API-key create/revoke, and session revoke produces exactly one row in `activities` with the matching `type`, `userId`, `ipAddress`, and `userAgent`.
- Reading historical rows (created before the migration) returns `ipAddress: null` / `userAgent: null` without crashing the `/activities` list endpoint.
- `permissions.json` unchanged for Phase 1 (no new admin endpoint yet — Phase 2 adds `/workspaces/:id/audit-log`).

### PR checklist (SEC-007 Phase 1)
- [ ] PR title follows Conventional Commits (e.g. `feat(security): SEC-007 P1 — audit log immutability + auth events`)
- [ ] Branch is off `develop`, not `main`
- [ ] `cd backend && npm test` passes locally; `audit-log-phase1.test.js` registered in `backend/tests/run-tests.js`
- [ ] `cd frontend && npm run build && npm test` passes locally (activity-type literal sync verified)
- [ ] Migration `031_activities_compliance.sql` is additive and null-tolerant; verified on both SQLite and Postgres adapters
- [ ] `DELETE /api/v1/data/activities` env-gate verified — default deployment returns 403 `AUDIT_PURGE_DISABLED`
- [ ] All 7 password-path `auth.*` activity emissions wired in `backend/src/routes/auth.js` and asserted by the test
- [ ] `docs/changelog.md` `## [Unreleased]` updated with § Security + § Added entries
- [ ] `QA.md` § Compliance audit log (SEC-007 Phase 1) added with manual test plan
- [ ] PROC-001: no new backend route in Phase 1 (purge route is mutated, not added) — `[no-ui]` opt-out not required

---

## ⏭ Queue (next 4 PRs after current)

### 1 · SEC-007 Phase 2 — Admin compliance surface + CSV/NDJSON export + retention sweep
**Effort:** M | **Priority:** 🟡 High | **Dependencies:** SEC-007 P1 (this sprint), ENH-007 ✅ (signed URL), ENH-010 ✅ (pagination) | **Source:** `ROADMAP.md` Phase 5 (SEC-007 Phase 2)

New `GET /api/v1/workspaces/:workspaceId/audit-log` (admin-gated) with filters (`userId`, `type[]`, `dateFrom`, `dateTo`, `ipAddress`) and `?format=csv|ndjson` export (signed-URL when >5MB). New `frontend/src/pages/AuditLog.jsx` under Settings → Compliance. Daily retention sweep in `backend/src/scheduler.js` honouring `AUDIT_RETENTION_DAYS` (default 365, floor 90). New `docs/guide/compliance.md`.

### 2 · INF-007 — OTel / Sentry observability
**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** none | **Source:** `ROADMAP.md` Phase 5 (INF-007)

### 3 · INF-008 — Postgres-default + dual-DB CI matrix
**Effort:** M | **Priority:** 🔴 Blocker | **Dependencies:** INF-001 ✅ | **Source:** `ROADMAP.md` Phase 5 (INF-008)

### 4 · AUTO-022 — AI eval harness with golden-set regression
**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** INF-007 (metric_samples infra) | **Source:** `ROADMAP.md` Phase 5 (AUTO-022)

---

## 🔀 Parallel opportunities

Items that do not overlap SEC-007 Phase 1's changed files and can land in a separate PR while it is in flight. "Shared files?" lists any files that *would* conflict if merged concurrently — flag in your PR description if you pick one up.

| ID | Title | Effort | Priority | Shared files? |
|----|-------|--------|----------|---------------|
| INF-007 | OTel / Sentry observability | L | 🔴 Blocker | ⚠️ `backend/src/utils/activityLogger.js` (request-context plumbing may overlap with SEC-007 Phase 1's `req.ip` / `req.get('user-agent')` capture); coordinate |
| INF-008 | Postgres-default + dual-DB CI matrix | M | 🔴 Blocker | ⚠️ `backend/src/database/migrations/` — adds rename + linter, must coordinate with the new `031_activities_compliance.sql` ordering |
| AUTO-022 | AI eval harness with golden-set regression | L | 🔴 Blocker | None — `backend/src/eval/`, `pipelineOrchestrator.js`, `metricSampleRepo.js`; no overlap with audit-log work |
| MNT-001 | Vision-based locator healing | XL | 🟢 Differentiator | None — `selfHealing.js`, `executeTest.js` only |
| AUTO-009 | Browser code coverage mapping | L | 🟢 Differentiator | None — `executeTest.js`, `coverageAggregator.js`, `Dashboard.jsx` |
| MNT-013 | Request-ID propagation via `AsyncLocalStorage` | S | 🟡 High | ⚠️ Bundles naturally with INF-007 and SEC-007 P1 — all three touch `appSetup.js` + `activityLogger.js`/`logFormatter.js`; consider landing as a single PR |

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| SEC-006 | PII firewall — `domSanitizer` pipeline stage redacting emails / phones / SSNs / Luhn-checked cards / JWTs / Bearer & Basic auth headers / `?token=` / `?code=` / `?access_token=` query params before crawler snapshots reach `aiProvider.js`; deterministic placeholders, per-project `strictPiiFirewall` toggle + `piiAllowlist`, migration `030_projects_pii_firewall.sql`, `pipeline.pii_redacted` structured audit log | #11 |
| SEC-004 | MFA — TOTP enrollment + recovery codes + WebAuthn passkeys, per-workspace enforcement with grace period, JWT `amr` claim, login factor picker, audit logging | #10 |
| AUTO-008 | Distributed runner — standalone `worker` Compose service, `WORKER_CONCURRENCY` env var, dashboard worker-pool panel (Runner Mode / Queue Depth / Active Workers / Completed Jobs) | #9 |
| DIF-015c (Gaps 2/3/5/6) | Recorder gaps — point-and-click assert UX, `assertCount`/`assertHasClass` kinds, pause/resume/undo, device profiles (launch + mid-session switch), stealth launch profile | #8 |
| AUTO-010 | Root-cause failure clustering — deterministic clusterer grouping failed results by error fingerprint, URL prefix, and selector edit-distance; `runs.rootCauses` persisted; Run Detail "Root Cause Summary" panel | #6 |

*Full completed list → ROADMAP.md § Completed Work Summary*
