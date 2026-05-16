# Sentri — Engineering Roadmap

> **Last revised:** April 2026 · `sentri_v1_4`
> **Stack:** Node.js 20 (ESM) · Express 4 · SQLite → PostgreSQL · Playwright · React 18 · Vite 6
>
> Single source of truth for all planned and in-progress engineering work.

---

## ⚡ Agent fast path

> **Working on the next PR?** Read [`NEXT.md`](./NEXT.md) — it has the current item spec, files to change, and acceptance criteria. You do not need to read further in this file.
>
> Come back here only to look up a specific item by ID (Ctrl+F the ID e.g. `DIF-008`), check completed work history, or review phase/competitive context.
>
> **Current sprint:** `SEC-004` (MFA / TOTP). Queue: SEC-006 (slot 1), SEC-007 (slot 2), INF-007 (slot 3), INF-008 (slot 4).
>
> **Remaining:** ~15 planned items across Phases 2–5 + Maintenance (see Summary table).
>
> **Recent ships** (newest first): AUTO-008 #9 · DIF-015c Gaps 2/3/5/6 #8 · AUTO-010 #6 · DIF-012 #2 · CAP-001 #1 · CAP-002 #3 · AUTO-004 #18 · INT-002b #17 · AUTO-001 + INT-002 #15 · AI-001 #14 · CAP-003 + AUTO-002/002b + AUTO-015/015b #12 · DIF-015b Gap 3 + DIF-015c Gap 1 #11 · AUTO-003/003b + AUTO-019 #10 · AUTO-017.3 + PROC-001 + DIF-005 #9 · CAP-004 + MET-001 + AUTO-017 + UI-REFACTOR-001 #8. PROC-002 + PROC-003 reverted in #10.

---

## How to Read This Document

| Symbol | Meaning |
|--------|---------|
| 🔴 Blocker | Must ship before any team or production deployment |
| 🟡 High | Ship within the next two sprints |
| 🔵 Medium | Materially improves quality, DX, or coverage |
| 🟢 Differentiator | Builds competitive moat; schedule after blockers |
| ✅ Complete | Merged to `main` |
| 🔄 In Progress | Active branch or current sprint |
| 🔲 Planned | Scoped and ready to start |

**Effort sizing** (2-engineer team): `XS` < 1 day · `S` 1–2 days · `M` 3–5 days · `L` 1–2 weeks · `XL` 2–4 weeks

---

## Completed Work Summary

> **Naming note:** Items numbered `MAINT-*` are legacy. The current convention is `MNT-*`. Old IDs are preserved in git history — do not rename them.

| ID | Title | PR |
|----|-------|----|
| S3-02 | Shadow DOM support in crawler | #55 |
| S3-04 | DOM stability wait before snapshot | #55 |
| S3-08 | Disposable email address filter | #55 |
| ENH-004 | Persist AI provider keys encrypted in database | #80 |
| ENH-005 | Global API rate limiting (three-tier) | #78 |
| ENH-006 | Test scheduling engine (cron + timezone) | #86 |
| ENH-007 | Signed URL tokens for artifact serving | #79 |
| ENH-008 | Move `runs.logs` to append-only `run_logs` table | #86 |
| ENH-010 | Pagination on all list API endpoints | #78 |
| ENH-011 | CI/CD webhook receiver + GitHub Actions integration | #86 |
| ENH-013 | Persist password reset tokens in the database | #78 |
| ENH-020 | Soft-delete with recycle bin for tests, projects, runs | #81 |
| ENH-021 | `userId` + `userName` on activities for full audit trail | #78 |
| ENH-024 | Frontend code splitting (React.lazy + Suspense) | #78 |
| ENH-027 | Global React Error Boundary with crash reporting | #79 |
| ENH-029 | Diff view for AI-regenerated test code | #81 |
| ENH-030 | Secrets scanning in CI pipeline (Gitleaks) | #79 |
| ENH-034 | Empty crawl result `completed_empty` status | #86 |
| ENH-035 | No-provider-configured global banner (ProviderBanner) | #85 |
| MAINT-010 | Semantic deduplication via TF-IDF + fuzzy matching | #55 |
| MAINT-011 | Feature-sliced frontend component architecture | #81 |
| MAINT-012 | Deep test validation (locator, action, assertion) | #57 |
| MAINT-013 | Graceful shutdown with in-flight run draining | #86 |
| MAINT-016 | Renovate for automated dependency updates | Renovate |
| SEC-001 | Email verification on registration | #87 |
| INF-001 | PostgreSQL support with SQLite fallback | #87 |
| INF-002 | Redis for rate limiting, token revocation, and SSE pub/sub | #87 |
| INF-003 | BullMQ job queue for durable run execution | #92 |
| FEA-001 | Teams / email / webhook failure notifications | #92 |
| SEC-002 | Nonce-based Content Security Policy | #92 |
| SEC-003 | GDPR / CCPA account data export and deletion | #92 |
| INF-005 | API versioning (`/api/v1/`) with 308 redirects | #94 |
| FEA-003 | AI provider fallback chain + circuit breaker | #94 |
| DIF-003 | Mobile viewport / device emulation | #94 |
| DIF-011 | Coverage heatmap on site graph | #94 |
| DIF-014 | Cursor overlay on live browser view | #94 |
| DIF-016 | Step-level timing and per-step screenshots | #94 |
| AUTO-013 | Stale test detection and cleanup | #99 |
| MNT-007 | ARIA live regions for real-time updates | #99 |
| DIF-004 | Flaky test detection and reporting | #99 |
| MNT-009 | Tiered prompt system for local models (Ollama) | #100 |
| MNT-010 | Re-run button on Run Detail page | #100 |
| FEA-002 | TanStack React Query data layer | #107 |
| MNT-011 | Persist crawl/generate dialsConfig on run record | #107 |
| ACL-001 | Multi-tenancy: workspace ownership on all entities | #87 |
| ACL-002 | Role-based access control (Admin / QA Lead / Viewer) | #87 |
| INF-004 | OpenAPI specification and Swagger UI | #94 |
| DIF-001 | Visual regression testing with baseline diffing | #94 |
| DIF-002 | Cross-browser testing (Firefox, WebKit / Safari) | #94 |
| DIF-002b | Cross-browser polish: browser-aware baselines, UI badges, CI coverage | #107, #110 |
| DIF-015 | Interactive browser recorder for test creation | #94 |
| AUTO-007 | Geolocation / locale / timezone testing | #94 |
| DIF-006 | Standalone Playwright export (zero vendor lock-in) | #1 |
| AUTO-005 | Automatic test retry with flake isolation | #2 |
| DIF-013 | Anonymous usage telemetry (PostHog + opt-out) | #3 |
| AUTO-006 | Network condition simulation (slow 3G / offline) | #3 |
| DIF-015b | Recorder selector quality: Playwright `InjectedScript` delegation, `nth=N` disambiguation, `frameLocator` emission, shadow-DOM coverage | #3, #4, #11 |
| DIF-015c (Gap 1) | Recorder: paste action as single `fill` + opt-in keyboard shortcut capture | #11 |
| DIF-015c (Gaps 2+3+5+6) | Recorder gaps bundle: point-and-click assert UX, `assertCount`/`assertHasClass`, pause/resume/undo, device profiles, stealth launch profile | #8 |
| AUTO-016 (backend) | Accessibility testing — axe-core crawl scan + persistence | #121 |
| MNT-006 | Object storage abstraction — local-disk default + S3/R2 pre-signed URLs | #122 |
| DIF-007 | Conversational test editor — "Edit with AI" panel on TestDetail with diff preview | #123 |
| AUTO-016b | Frontend CrawlView accessibility panel + dashboard "Top Accessibility Offenders" rollup | #1 |
| ENH-036 | Project credential editing after creation (`PATCH /api/v1/projects/:id`) | #127 |
| ENH-036b | Auto-detect login form fields — semantic-first locator waterfall | #127 |
| INF-006 | Persistent storage on hosted deployments (Render disk blueprint) | #1 |
| AUTO-012 | SLA / quality gate enforcement — per-project config, run-time evaluator, `gateResult` on runs, frontend panels, CI consumer docs | #2 |
| AUTO-017 | Web Vitals performance budgets — per-project LCP/CLS/INP/TTFB config, capture, evaluation, and trigger response integration | #8 |
| DIF-005 | Embedded Playwright trace viewer | #9 |
| AUTO-019 | Run diffing: per-test comparison across runs | #10 |
| UI-REFACTOR-001 | `ConfigurablePanel` abstraction; Automation page redesign with four WAI-ARIA tabs | #6 |
| AUTO-017.3 | Web Vitals trend charts on `ProjectQualityCard` | #9 |
| PROC-001 | No-orphan-routes CI guard | #9 |
| ~~PROC-002~~ + ~~PROC-003~~ | Sprint-promotion automation — **reverted in PR #10** (too many edge cases; manual checklist in REVIEW.md is canonical) | #8 (added) / #10 (reverted) |
| CAP-003 | Secret scanner gate on AI-generated Playwright tests | #12 |
| AUTO-003 | Confidence scoring & auto-approval of low-risk tests | #10 |
| AUTO-003b | Auto-approval provenance & audit trail | #10 |
| AUTO-002 + AUTO-002b | Diff-aware crawling for link-crawl and state-explorer modes; `crawl_baselines` table; `pages_changed` SSE | #12 |
| INT-002b | GitHub integration polish — installation UX + App-level webhooks; `installationId` AES-encrypted at rest | #17 |
| INT-002 | GitHub PR Check Runs — queued → in_progress → success/failure lifecycle | #15 |
| AUTO-001 | Risk-based test selection / ordering; `budgetMinutes` cap; smoke-test pin | #15 |
| AUTO-004 | Test impact analysis from git diff / GitHub PR files; `skipped_no_impact` pre-seeding | #18 |
| CAP-001 | Data-driven test fixtures — CSV/JSON upload, per-row iteration, `iterationCap` | #1 |
| CAP-002 | Distributed test sharding — end-to-end cross-process sharding with atomic storage primitives, first-writer-wins finalization, abort propagation | #3 |
| DIF-012 | Multi-environment support (staging vs. production) — per-project environments with scoped URL + credentials override | #2 |
| AUTO-015 + AUTO-015b | Continuous test discovery on deployment events (Vercel/Netlify webhooks); "Last deployment run" badge | #12 |
| AUTO-008 | Distributed runner — standalone `worker` Compose service, `WORKER_CONCURRENCY`, dashboard worker-pool panel | #9 |
| AUTO-010 | Root-cause failure clustering — deterministic clusterer, `runs.rootCauses`, Run Detail panel | #6 |

---

## Phase Summary

| Phase | Scope | Status | Est. Duration |
|-------|-------|--------|---------------|
| Phase 1 — Production Hardening | Security, reliability, data integrity | ✅ Complete | — |
| Phase 2 — Team & Enterprise Foundation | Auth hardening, multi-tenancy, RBAC, queues | ✅ Mostly complete — SEC-004 (MFA) promoted to 🔴 Blocker in Phase 5; SEC-005 (SSO) deferred as 🟢 Strategic | 8–10 weeks |
| Phase 3 — AI-Native Differentiation | Visual regression, cross-browser, competitive features | 🔄 In progress — most differentiators shipped; remaining: DIF-008–010, DIF-002c, DIF-015c Gap 4 | 10–12 weeks |
| Phase 4 — Autonomous Intelligence | Risk-based testing, change detection, quality gates | 🔄 In progress — AUTO-001/002/003/004/005/006/007/008/010/012/013/015/016/017/019 ✅; remaining: AUTO-009/011/014/018/021/022/023/024/025 | 14–18 weeks |
| Phase 5 — Industry Hardening (AUDIT.md) | OTel, Postgres-default, MFA, SSO, PII firewall, eval harness, Helm/DR, SDK, DAG runner | 🔲 New phase — 6× 🔴 Blocker. Target: industry-readiness 6.0/10 → 9.0/10 | 12–16 weeks |
| Ongoing — Maintenance & Platform Health | Healing AI, DX, exports, accessibility | 🔄 Continuous | — |

---

## Phase 2 — Team & Enterprise Foundation

*Goal: Multi-user, secure, and durable enough for team deployment. Largely complete — only the two deferred enterprise-auth items remain.*

---

### SEC-004 — MFA (TOTP / passkey) support 🔴 Blocker

**Status:** 🔲 Planned | **Effort:** L | **Source:** AUDIT.md S1

**Problem:** No multi-factor authentication. MFA is a compliance requirement (SOC 2, ISO 27001) and a sales blocker for regulated industries.

**Fix:** Add TOTP-based MFA using `otplib`. Store the encrypted TOTP secret in `users`. Add a setup flow (QR code), MFA verification at login, and recovery codes. Passkey (WebAuthn) can follow in a subsequent sprint.

**Files to change:**
- `backend/src/routes/auth.js` — enroll, verify, and recovery endpoints
- `backend/src/database/migrations/` — `mfaSecret`, `mfaEnabled`, `mfaRecoveryCodes` on `users`
- `frontend/src/pages/Login.jsx` — MFA verification step
- `frontend/src/pages/Settings.jsx` — MFA setup and management

**Dependencies:** ACL-001 ✅

---

### SEC-005 — SAML / OIDC SSO federation 🟢 Strategic

**Status:** 🔲 Planned | **Effort:** L | **Source:** AUDIT.md S2

**Problem:** No SAML 2.0 or OIDC federation. Enterprise procurement requires SSO with Okta, Azure AD, OneLogin, or Ping. This is distinct from MFA — SSO replaces the login flow entirely.

**Fix:** Integrate `openid-client` (OIDC) and `@node-saml/passport-saml` (SAML 2.0). Add per-workspace SSO configuration (metadata URL, client ID, certificate). Redirect login to the IdP when SSO is enabled. Auto-provision users on first SSO login.

**Files to change:**
- `backend/src/middleware/authenticate.js` — `saml` and `oidc` strategies
- `backend/src/routes/auth.js` — SSO callback and IdP-initiated login endpoints
- `backend/src/database/migrations/` — `sso_configurations` table per workspace
- `frontend/src/pages/Settings.jsx` — SSO configuration panel
- `backend/package.json` — `openid-client`, `@node-saml/passport-saml`

**Dependencies:** ACL-001 ✅

---

## Phase 3 — AI-Native Differentiation

*Goal: Pull ahead of Mabl, Testim, and BearQ with AI-powered capabilities and advanced testing features.*

---

### DIF-002c — Cross-browser crawl and recorder support 🔲 Backlog

**Status:** 🔲 Planned | **Effort:** XL | **Source:** Follow-on from DIF-002

**Problem:** Crawler, state explorer, recorder, and live screencast are pinned to Chromium via CDP APIs (`Page.startScreencast`, `DOM.getFlattenedDocument`). No equivalent exists in Firefox or WebKit.

**Fix (high-level; deferred until there is customer demand):**
- Replace CDP screencast with Playwright's cross-browser `page.screenshot()` polling at ~8–12 fps.
- Replace the CDP shadow-DOM walker with Playwright `page.locator()` serialisation.
- Add a `browser` param to `POST /record` and `POST /crawl` routes.

**Files to change:**
- `backend/src/pipeline/crawlBrowser.js`, `stateExplorer.js` — accept `browser` param, swap CDP calls
- `backend/src/runner/recorder.js`, `screencast.js` — dual-path (CDP for Chromium, screenshot-poll fallback)
- `frontend/src/components/run/RecorderModal.jsx`, `frontend/src/pages/TestLab.jsx` — browser selector

**Dependencies:** DIF-002 ✅, DIF-002b ✅

---

### DIF-015c — Recorder gaps backlog 🔵 Medium

**Status:** ✅ Gaps 1/2/3/5/6 complete (PR #11, PR #8). Gap 4 🔲 Planned, blocked on DIF-010.

Gaps 1/2/3/5/6 shipped — see Completed Work Summary. Only Gap 4 remains.

#### Gap 4 — Authentication / pre-logged-in state handling

The recorder starts with a fresh browser context. Three flows are unsupported: recording against an authenticated app without re-recording login each time, recording behind SSO/OAuth (IdP selectors are unreplayable), and MFA-protected logins. Fix: seed the recorder browser context with `storageState` from a captured credential profile (DIF-010).

**Sub-item status:**

| Sub-item | Effort | Priority | Status |
|---|---|---|---|
| Gap 1 — Expanded action vocabulary | M | 🟡 High | ✅ PR #118, #11 |
| Gap 2 — Inline assertion authoring | S | 🟢 Differentiator | ✅ PR #118, #8 |
| Gap 3 — Pause / resume + undo | S | 🔵 Medium | ✅ PR #8 |
| Gap 4 — Auth / storageState integration | M | 🔵 Medium | 🔲 Planned |
| Gap 5 — Device profile during recording | S | 🔵 Medium | ✅ PR #8 |
| Gap 6 — Stealth launch profile | S | 🔵 Medium | ✅ PR #8 |

**Remaining files to change** (Gap 4 only):
- `backend/src/runner/recorder.js` — seed `storageState` from selected credential profile
- `backend/src/routes/tests.js` — accept `authProfileId` on `POST /record`
- `frontend/src/components/run/RecorderModal.jsx` — auth profile picker

**Dependencies:** DIF-010 (hard prerequisite)

---

### DIF-008 — Jira / Linear issue sync 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive

**Problem:** `linkedIssueKey` and `tags` exist on tests but there is no outbound sync. Test failures don't automatically create tickets.

**Fix:** Add settings endpoints to store OAuth tokens for Jira and Linear. On failure, auto-create a bug ticket with screenshot, error message, and trace attached. Sync pass/fail status back to the linked issue.

**Files to change:**
- New `backend/src/utils/integrations.js` — Jira and Linear API clients
- `backend/src/testRunner.js` — `syncFailureToIssue(test, run)` on completion
- `backend/src/routes/settings.js` — integration config endpoints
- `frontend/src/pages/Settings.jsx` — Integrations tab

**Dependencies:** FEA-001 ✅

---

### DIF-009 — Autonomous monitoring mode (always-on QA agent) 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive

**Problem:** Sentri is a triggered tool. The "autonomous QA" brand promise implies continuous production monitoring.

**Fix:** Add a monitoring mode per project: run smoke tests on a schedule against the production URL. Two consecutive failures = confirmed regression. Fire notifications on confirmation. Show a "Monitor" badge on the dashboard.

**Files to change:**
- `backend/src/scheduler.js` — monitoring job type alongside scheduled runs
- `backend/src/routes/projects.js` — `PATCH /projects/:id/monitor`
- `frontend/src/pages/Dashboard.jsx` — monitoring status indicators
- `frontend/src/pages/ProjectDetail.jsx` — monitoring config panel

**Dependencies:** INF-003 ✅, FEA-001 ✅

---

### DIF-010 — Multi-auth profile support per project 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive

**Problem:** Only one auth profile per project. Testing RBAC ("admin sees this, viewer does not") requires running the same suite under different identities. The `multi_role` Test Dial exists but is not wired to credential profiles.

**Fix:** Add named credential profiles (e.g., "admin", "viewer") per project. Wire the `multi_role` dial to the profile selector. Surface per-profile result columns in Run Detail.

**Files to change:**
- `backend/src/utils/credentialEncryption.js` — multiple named profiles
- `backend/src/routes/projects.js` — profile CRUD endpoints
- `backend/src/pipeline/stateExplorer.js` — accept `profileId`
- `frontend/src/pages/ProjectDetail.jsx` — credential profiles panel
- `frontend/src/components/test/TestConfig.jsx` — connect `multi_role` dial to profile selector

**Dependencies:** None

---

## Phase 4 — Autonomous Intelligence

*Goal: Advance Sentri from triggered QA into a genuinely autonomous system.*

Most Phase 4 items have shipped: AUTO-001/002/002b/003/003b/004/005/006/007/008/010/012/013/015/015b/016/016b/017/017.3/019 and CAP-001/002 are all ✅ — see Completed Work Summary. Remaining items are scoped below.

---

### CAP-002b — Sharding production hardening (chaos / load / SaaS-readiness) 🔵 Medium

**Status:** 🔲 Planned | **Effort:** L | **Source:** PR #3 audit

**Context:** CAP-002 (PR #3) is industry-standard for self-hosted deployments. This tracks the gaps needed for managed multi-tenant SaaS parity (Cypress Cloud / BrowserStack tier).

| Sub-item | Effort | Priority | Status |
|---|---|---|---|
| Gap 1 — Wall-clock E2E harness | M | 🟡 High | 🔲 Planned — spec scaffolded at `tests/e2e/specs/run-sharding-wallclock.spec.mjs`, harness is the work |
| Gap 2 — BullMQ-kill chaos test | M | 🟡 High | 🔲 Planned |
| Gap 3 — Coordinator fan-out unit test | S | 🔵 Medium | 🔲 Planned |
| Gap 4 — Auto-scaling shard workers | XL | 🟢 Strategic | 🔲 Planned — depends on INF-007 |
| Gap 5 — Deadletter queue + replay UI | L | 🔵 Medium | 🔲 Planned |
| Gap 6 — Per-tenant fair scheduling | XL | 🟢 Strategic | 🔲 Planned — depends on FEA-004 |
| Gap 7 — Duration-aware shard balancing | M | 🔵 Medium | 🔲 Planned |
| Gap 8 — Cross-region distribution | XL | 🟢 Strategic | 🔲 Out of scope (self-hosted) |
| Gap 9 — Container-per-shard isolation | XL | 🟢 Strategic | 🔲 Out of scope (self-hosted) |
| Gap 10 — Redis HA enforcement | S | 🔵 Medium | 🔲 Planned |

**Acceptance criteria (selected sub-items):**
- Gap 1: CI `wallclock` lane proves `shards: 4` completes in ≤ 50% wall-clock time of `shards: 1`.
- Gap 2: Chaos harness kills a shard mid-execution and asserts run reaches `failed`, `shardsCompleted < shardCount` preserved, sibling shards drain within 2s.
- Gap 5: `/runs/:runId/replay-shard/:shardIndex` (admin-only) re-enqueues a single shard; UI exposes replay button for failed runs with `shardsCompleted < shardCount`.
- Gap 7: `partitionTestIdsByDuration` performs bin-packing; falls back to even-split when durations are unavailable.
- Gap 10: Boot-time `/health/redis` returns `{ topology: "single-node" | "sentinel" | "cluster" }`; one-shot WARN when topology is `single-node`.

**Dependencies:** CAP-002 ✅. Gaps 4, 6, 8 also depend on Phase 5 items.

---

### AUTO-008 — Distributed runner across multiple machines
**Status:** ✅ Complete (PR #9)

---

### AUTO-009 — Browser code coverage mapping 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive Gap Analysis

**Problem:** No way to know what percentage of application code the test suite exercises.

**Fix:** Optionally enable V8 JS coverage per run via `page.coverage.startJSCoverage()` / `stopJSCoverage()`. Aggregate per-URL coverage into a project-level report. Surface as a "Code Coverage" metric on the dashboard.

**Files to change:**
- `backend/src/runner/executeTest.js` — start/stop coverage collection
- New `backend/src/utils/coverageAggregator.js`
- `frontend/src/pages/Dashboard.jsx` — coverage metric card

**Dependencies:** None

---

### AUTO-011 — Historical trend analysis and anomaly detection 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** The dashboard shows pass/fail trends but never detects anomalies or alerts on regressions.

**Fix:** Lightweight anomaly detector using rolling mean + standard deviation. Alert when pass rate drops more than a configurable threshold (default 15%) vs. the prior 5-run baseline. Surface as a warning banner on the dashboard and include in run completion notifications.

**Files to change:**
- New `backend/src/utils/anomalyDetector.js`
- `backend/src/routes/dashboard.js` — add `anomalyAlert` to dashboard response
- `frontend/src/pages/Dashboard.jsx` — anomaly alert banner

**Dependencies:** FEA-001 ✅

---

### AUTO-014 — Test dependency and execution ordering 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** No concept of test dependencies. A failed login test produces cascading failures with no indication the root cause is upstream.

**Fix:** Add optional `dependsOn: [testId]` to tests. Topologically sort the test queue before execution. Mark dependent tests `skipped` if a dependency fails.

**Files to change:**
- `backend/src/database/migrations/` — `dependsOn` array on `tests`
- `backend/src/testRunner.js` — topological sort and dependency-aware skip logic
- `frontend/src/pages/TestDetail.jsx` — dependency management UI

**Dependencies:** None

---

### AUTO-018 — Plugin and extension system 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** XL | **Source:** Competitive Gap Analysis

**Problem:** No way to extend Sentri without forking. All integration points are hardcoded.

**Fix:** Define a plugin interface (`beforeRun`, `afterStep`, `onFailure`, `onHealAttempt`, `onRunComplete`). Load plugins from a configurable `PLUGINS_DIR`. Ship three reference implementations: Teams notification formatter, custom assertion library, custom HTML report.

**Files to change:**
- New `backend/src/plugins/pluginLoader.js`
- `backend/src/testRunner.js` — plugin lifecycle hooks
- `backend/src/selfHealing.js` — `onHealAttempt` hook
- `backend/.env.example` — document `PLUGINS_DIR`

**Dependencies:** All Phase 3 items (plugin system should wrap stable APIs)

---

### AUTO-021 — AI-generated test suite health insights 🔵 Medium

**Status:** 🔲 Planned | **Effort:** S | **Source:** Competitive (BearQ)

**Problem:** The dashboard shows pass rate and MTTR but never explains *why* metrics changed. Existing `feedbackLoop.js` insights are static rule-based templates, not AI-generated.

**Fix:** After each run, feed the quality analytics summary (failure categories, flaky tests, healing events, pass-rate delta) to the LLM and generate a 3–5 sentence natural-language insight. Surface as an "AI Insights" card on the dashboard and include in run completion notifications.

**Files to change:**
- `backend/src/routes/dashboard.js` — generate and cache AI insight on run completion
- `frontend/src/pages/Dashboard.jsx` — AI Insights card
- `backend/src/testRunner.js` — trigger after `applyFeedbackLoop()`

**Dependencies:** FEA-001 ✅

---

## Phase 5 — Industry Hardening (from AUDIT.md May 2026)

*Goal: Bring Sentri to enterprise readiness (industry score 6.0/10 → 9.0/10). All items originate from `AUDIT.md`. AUDIT.md severity takes precedence over historical ROADMAP severity for items in this phase.*

---

### INF-007 — OpenTelemetry instrumentation + Sentry crash reporting 🔴 Blocker

**Status:** 🔲 Planned | **Effort:** L | **Source:** AUDIT.md B1, B2, F7, O1, O2

**Problem:** No distributed observability. No `requestId` propagation, no OTel spans, no Prometheus metrics endpoint, no frontend crash reporting. LLM calls, Playwright runs, and DB queries are black boxes.

**Fix:** Add `@opentelemetry/sdk-node` with auto-instrumentation for Express, pg, Redis, HTTP. Propagate `requestId` (UUID v4) via `AsyncLocalStorage` into every `formatLogLine()` call. Add a Prometheus `/metrics` endpoint via `prom-client`. Add Sentry to frontend (`@sentry/react`) and backend (`@sentry/node`) behind `SENTRY_DSN` (no-op when unset).

**Files to change:**
- `backend/package.json` — `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, `prom-client`, `@sentry/node`
- New `backend/src/telemetry/otel.js` — OTel SDK bootstrap (import before all others in `index.js`)
- New `backend/src/telemetry/metrics.js` — Prometheus registry
- `backend/src/middleware/appSetup.js` — `requestId` via `AsyncLocalStorage`; `GET /metrics` (scrape-key protected)
- `backend/src/utils/logFormatter.js`, `aiProvider.js`, `testRunner.js`, `selfHealing.js` — spans + counters
- `frontend/package.json` + `frontend/src/main.jsx` — Sentry init (guard on `VITE_SENTRY_DSN`)
- `backend/.env.example` — `OTEL_EXPORTER_OTLP_ENDPOINT`, `SENTRY_DSN`, `METRICS_BEARER_TOKEN`

**Acceptance criteria:**
- `GET /metrics` returns valid Prometheus text with `sentri_runs_total`, `sentri_ai_tokens_total`, `sentri_healing_attempts_total`
- Every structured log line (`LOG_JSON=true`) carries `requestId` and `runId` (when in run context)
- Frontend exceptions reach Sentry (verified via test throw in dev)
- OTel traces appear in a local Jaeger via `docker-compose --profile observability`
- No observable performance regression on CI benchmark (p95 ±10%)

**Dependencies:** None. Unblocks: MNT-013, MNT-015, AUTO-022, FEA-004.

---

### INF-008 — Promote PostgreSQL to default; add dual-DB CI matrix 🔴 Blocker

**Status:** 🔲 Planned | **Effort:** M | **Source:** AUDIT.md A3, P1, B4

**Problem:** SQLite is the `.env.example` default. The PostgreSQL adapter exists (INF-001 ✅) but has known `_COL_MAP` drift bugs. Migration prefix collisions (`007_*` × 2, `015_*` × 2) compound the risk.

**Fix:** Rename conflicting migration files; update `migrationRunner.js` to sort numerically then alpha. Change `.env.example` and `docker-compose.yml` default to `DATABASE_URL=postgresql://...`. Add CI matrix job `db: [sqlite, postgres]` running the full `npm test` suite under both. Add a migration linter (`backend/scripts/lint-migrations.mjs`) that fails on duplicate numeric prefixes. Add a nightly `pg_dump` CI job as DR baseline.

**Files to change:**
- Rename two migration files; `backend/src/database/migrationRunner.js` sort fix
- `backend/scripts/lint-migrations.mjs` (new)
- `backend/.env.example`, `docker-compose.yml`, `.github/workflows/ci.yml`
- `.github/workflows/nightly-backup.yml` (new)

**Acceptance criteria:**
- `npm test` passes with both `DATABASE_URL=postgres://...` and `DATABASE_URL=file:./...` in CI
- Migration linter fails the build on a prefix collision
- `docker compose up` works out-of-the-box with Postgres with zero extra steps
- No existing migration files removed or reordered — only the two colliding files renamed

**Dependencies:** Recommended to land in same sprint as INF-007.

---

### SEC-006 — Prompt-injection / PII firewall between crawler and LLM 🔴 Blocker

**Status:** 🔲 Planned | **Effort:** M | **Source:** AUDIT.md S11, S12

**Problem:** The crawler passes raw DOM content directly to the LLM. A malicious site can embed hidden prompt-injection text. PII (names, emails, SSNs) scraped from apps under test can leak to external LLM APIs. Distinct from CAP-003 ✅ which scans LLM *output* — this scans LLM *input*.

**Fix:** Add `backend/src/pipeline/domSanitizer.js` before `testGenerator.js`. Strip `<script>` / `<style>` / `<noscript>` / `<iframe>` tags and HTML comments. Detect and redact prompt-injection patterns. Detect and redact PII (email, phone, credit card via Luhn, SSN) as `[REDACTED:<type>]`. Mandatory stage — cannot be bypassed by config.

**Files to change:**
- New `backend/src/pipeline/domSanitizer.js`
- `backend/src/pipeline/pipelineOrchestrator.js` — insert stage before `testGenerator`
- New `backend/tests/dom-sanitizer.test.js` (registered in `run-tests.js`)
- `backend/.env.example` — `PII_REDACTION=true` (default true)

**Acceptance criteria:**
- Hidden `Ignore all previous instructions` text does not reach the LLM prompt
- `user@example.com` and `4111 1111 1111 1111` in visible text produce `[REDACTED:email]` and `[REDACTED:card]`
- No false-positives on 10 representative real-world page snapshots from the AUTO-022 golden eval set
- Stage completes in < 50ms for a 200KB DOM

**Dependencies:** AUTO-022 (golden-set snapshots reused as sanitizer test fixtures — can be authored in parallel)

---

## Competitive Gap Analysis

> **Note:** The SmartBear column reflects both their legacy portfolio and the new **BearQ** AI-native platform (early access). Capabilities marked † are BearQ-specific.

| Capability | Sentri | Mabl | Testim | SmartBear / BearQ | Playwright OSS |
|---|---|---|---|---|---|
| AI test generation | ✅ 8-stage pipeline | ✅ Auto-heal only | ✅ AI recorder | ✅ BearQ † | ❌ Manual |
| Interactive recorder | ✅ DIF-015 | ✅ | ✅ | ✅ BearQ † | Via codegen |
| Self-healing selectors | ✅ Multi-strategy waterfall | ✅ ML-based | ✅ Smart locators | ✅ BearQ † | ❌ |
| AI auto-repair on failure | ✅ Feedback loop | ✅ | ✅ | ✅ BearQ † | ❌ |
| Human review queue | ✅ Draft → Approve flow | ❌ | ❌ | ❌ | ❌ |
| NL test editing | ✅ AI chat + fix | ❌ | ❌ | ✅ BearQ † | ❌ |
| API test generation | ✅ HAR-based | ✅ | ❌ | ✅ ReadyAPI | ✅ Manual |
| Scheduled runs | ✅ Cron + timezone | ✅ | ✅ | ✅ | Via CI cron |
| CI/CD integration | ✅ Webhook + token auth | ✅ Native | ✅ Native | ✅ Native | ✅ CLI |
| Self-hosted / private | ✅ Docker | ❌ SaaS only | ❌ SaaS only | Partial | ✅ |
| Multi-provider LLM | ✅ Anthropic/OpenAI/Google/OpenRouter/Ollama | ❌ | ❌ | ❌ | ❌ |
| Parallel execution | ✅ 1–10 workers | ✅ Cloud | ✅ Cloud | ✅ Cloud | ✅ CLI sharding |
| Visual regression | ✅ DIF-001 | ✅ Native | ✅ Native | ✅ VisualTest | Via plugins |
| Cross-browser | ✅ DIF-002 | ✅ Chrome+Firefox | ✅ Chrome+Firefox | ✅ All | ✅ All 3 |
| Mobile / device emulation | ✅ DIF-003 | ✅ | ✅ | ✅ | ✅ Native |
| Failure notifications | ✅ Teams/email/webhook | ✅ Slack/email | ✅ Slack/email | ✅ | N/A |
| Multi-tenancy / RBAC | ✅ ACL-001/ACL-002 | ✅ | ✅ | ✅ | N/A |
| Standalone export | ✅ DIF-006 | ❌ Lock-in | ❌ Lock-in | ❌ Lock-in | N/A |
| Flaky test detection | ✅ DIF-004 | ✅ | ✅ | ✅ | ❌ |
| Risk-based test selection | ✅ AUTO-001 | ✅ | Partial | ✅ BearQ † | ❌ |
| Accessibility testing | ✅ AUTO-016/016b | ✅ | ❌ | Partial | Via plugins |
| Performance budgets | ✅ AUTO-017 | ❌ | ❌ | Via Lighthouse | ❌ |
| Quality gate enforcement | ✅ AUTO-012 | ✅ | ✅ | ✅ | Via Playwright |

**Sentri's unique strengths:** Self-hosted + AI generation + human review queue + multi-provider LLM + standalone Playwright export. No competitor offers all five together.

**Critical gaps to close next:** SEC-004 (MFA) · SEC-006 (PII firewall) · INF-007 (OTel) · INF-008 (Postgres-default).

---

## Summary

| Category | Total | ✅ Done | 🔄 In Progress | 🔲 Pending | Remaining |
|----------|------:|--------:|---------------:|----------:|-----------|
| Security & Compliance | 7 | 3 | 0 | 4 | SEC-004 🔴, SEC-005, SEC-006 🔴, SEC-007 🟡 |
| Infrastructure | 10 | 6 | 0 | 4 | INF-007 🔴, INF-008 🔴, INF-009, INF-010 |
| Access Control | 2 | 2 | 0 | 0 | — |
| Platform Features | 7 | 4 | 0 | 3 | FEA-004, FEA-005, FEA-006 |
| Differentiators | 22 | 16 | 0 | 6 | DIF-002c, 008, 009, 010, 015c Gap 4 |
| Autonomous Intelligence | 29 | 20 | 0 | 9 | AUTO-009, 011, 014, 018, 021, 022 🔴, 023, 024, 025 |
| Capabilities | 4 | 4 | 0 | 0 | — |
| Process automation | 1 | 1 | 0 | 0 | — |
| Maintenance | 17 | 5 | 0 | 12 | MNT-001/002/003/004/005/008/012/013/014/015/016/017 |
| **Totals** | **99** | **61** | **0** | **38** | |

**Total tracked items:** 99 — **61 complete** (62%), **0 in current PR**, **38 remaining**

**Blockers (must ship before paid tier / enterprise demo):**
- ✅ All Phase 1–4 blockers resolved.
- 🔴 Phase 5 — 5 items unresolved: SEC-004 (MFA), SEC-006 (PII firewall), INF-007 (OTel), INF-008 (Postgres-default), AUTO-022 (AI eval harness).

**Recommended PR order (next 6 sprints):**
1. `SEC-004` — MFA / TOTP (compliance prerequisite for SOC 2 / ISO 27001; gates regulated-industry sales)
2. `SEC-006` — PII firewall (redacts captured credentials / PII from crawler → LLM pipeline)
3. `INF-007` — OTel + Sentry (required before any meaningful SLO or on-call rotation)
4. `INF-008` — Postgres-default + dual-DB CI matrix
5. `AUTO-022` — AI eval harness (regression-safety net for prompt / model changes)
6. `DIF-008` — Jira / Linear issue sync (competitive parity)

---

## Contributing

Before starting any item:

1. Open a GitHub Issue referencing the item ID (e.g. `SEC-004`)
2. Assign yourself and add to the current sprint milestone
3. Create a branch: `feat/SEC-004-mfa` or `fix/INF-002-redis-sse`
4. Reference the issue in your PR description
5. Update the item status in this file (`🔲 Planned` → `🔄 In Progress` → move to Completed Work Summary)
6. Add an entry to `docs/changelog.md` under `## [Unreleased]`
