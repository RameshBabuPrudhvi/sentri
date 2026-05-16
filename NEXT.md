# NEXT.md — Current Sprint Target

> **Agents:** Start here. Everything needed to begin the current PR is in this file. Open `ROADMAP.md` only to look up a specific item by ID or review phase context.
>
> **Humans:** When a PR ships — move the item to `ROADMAP.md` ✅ table, promote the next queue item to Current PR, and update Recently Completed.

---

## Bundling guidance

Flag adjacent items as bundling candidates in your PR description rather than expanding scope mid-flight. Good signals: items touch the same module, one validates the other end-to-end, or both are S/XS effort and skipping a handoff saves more than it costs in review surface. Bad signals: different phases, M+ effort expansion, or the candidate surfaces after CI is already green. When in doubt, comment on the PR and let the human decide — never silently expand beyond the Current PR checklist.

---

## ▶ Current PR — SEC-006 — PII firewall

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
- [ ] `backend/tests/pii-sanitizer.test.js` — pattern coverage + Luhn cases + allowlist *(deferred — tracked as Gap 3 follow-up)*
- [x] `permissions.json` — no new endpoint; reuses existing `PATCH /api/v1/projects/:id`
- [x] `docs/changelog.md` `## [Unreleased]` updated
- [x] `QA.md` § PII Firewall added with manual test plan
- [x] PROC-001: `strictPiiFirewall` / `piiAllowlist` consumed by `frontend/src/components/automation/ProjectQualityCard.jsx` (PII Firewall inner tab)

---

## ⏭ Queue (next 4 PRs after current)

### 1 · SEC-007 — Compliance audit log surface (immutability + auth events + admin export)
**Effort:** M | **Priority:** 🟡 High | **Dependencies:** SEC-004 ✅ (auth events from MFA routes are now emitted) | **Source:** `ROADMAP.md` Phase 5 (SEC-007)

Six gaps block SOC 2 / ISO 27001: the activity log is purgeable by admins, auth events are not emitted, there is no admin compliance surface or export, and no retention policy or SIEM streaming. Phased fix: P1 immutability + auth events, P2 admin page + export + retention, P3 SIEM on demand. SEC-004 unblocked Phase 1 by emitting the `auth.mfa.*` activity rows; password-only `auth.login_success` / `auth.login_failed` / `auth.logout` / `auth.password_reset` events are still pending and should land as part of P1.

### 2 · INF-007 — OTel / Sentry observability
**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** none | **Source:** `ROADMAP.md` Phase 5 (INF-007)

### 3 · INF-008 — Postgres-default + dual-DB CI matrix
**Effort:** M | **Priority:** 🔴 Blocker | **Dependencies:** INF-001 ✅ | **Source:** `ROADMAP.md` Phase 5 (INF-008)

### 4 · AUTO-022 — AI eval harness with golden-set regression
**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** none | **Source:** `ROADMAP.md` Phase 5 (AUTO-022)

---

## 🔀 Parallel opportunities

Items that do not overlap SEC-006's changed files and can land in a separate PR while SEC-006 is in flight. "Shared files?" lists any files that *would* conflict if merged concurrently — flag in your PR description if you pick one up.

| ID | Title | Effort | Priority | Shared files? |
|----|-------|--------|----------|---------------|
| INF-007 | OTel / Sentry observability | L | 🔴 Blocker | None — touches `appSetup.js`, `otel.js`, `metrics.js`, `aiProvider.js`, `testRunner.js`, `selfHealing.js`, `main.jsx`; no overlap with the PII sanitizer |
| AUTO-022 | AI eval harness with golden-set regression | L | 🔴 Blocker | ⚠️ `pipelineOrchestrator.js` — SEC-006 wires the new sanitizer stage; AUTO-022's `promptVersion` emit is additive but must rebase if it lands second |
| INF-008 | Postgres-default + dual-DB CI matrix | M | 🔴 Blocker | None — `backend/src/database/migrations/` only adds one new column on `projects` here, so collision risk is minimal |
| MNT-001 | Vision-based locator healing | XL | 🟢 Differentiator | None — `selfHealing.js`, `executeTest.js` only |
| AUTO-009 | Browser code coverage mapping | L | 🟢 Differentiator | None — `executeTest.js`, `coverageAggregator.js`, `Dashboard.jsx` |
| SEC-007 (P1) | Compliance audit log immutability + remaining auth event emission (login_success/failed/logout/password_reset) | M | 🟡 High | ⚠️ `backend/src/routes/auth.js` — small additive `logActivity` calls; coordinate with any in-flight auth work |

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| SEC-004 | MFA — TOTP enrollment + recovery codes + WebAuthn passkeys, per-workspace enforcement with grace period, JWT `amr` claim, login factor picker, audit logging | #10 |
| AUTO-008 | Distributed runner — standalone `worker` Compose service, `WORKER_CONCURRENCY` env var, dashboard worker-pool panel (Runner Mode / Queue Depth / Active Workers / Completed Jobs) | #9 |
| DIF-015c (Gaps 2/3/5/6) | Recorder gaps — point-and-click assert UX, `assertCount`/`assertHasClass` kinds, pause/resume/undo, device profiles (launch + mid-session switch), stealth launch profile | #8 |
| AUTO-010 | Root-cause failure clustering — deterministic clusterer grouping failed results by error fingerprint, URL prefix, and selector edit-distance; `runs.rootCauses` persisted; Run Detail "Root Cause Summary" panel | #6 |

*Full completed list → ROADMAP.md § Completed Work Summary*
