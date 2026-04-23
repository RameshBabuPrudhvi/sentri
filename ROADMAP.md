# Sentri — Engineering Roadmap

> **Last revised:** April 2026 · `sentri_v1_4` 
> **Stack:** Node.js 20 (ESM) · Express 4 · SQLite → PostgreSQL · Playwright · React 18 · Vite 6
>
> This document is the single source of truth for all planned and in-progress engineering work.
> It is a full rewrite based on a comprehensive codebase audit, resolving numbering gaps, orphaned items,
> duplicate entries, and stale statuses present in prior versions.

---

## How to Read This Document

| Symbol | Meaning |
|--------|---------|
| 🔴 Blocker | Must ship before any team or production deployment |
| 🟡 High | Ship within the next two sprints |
| 🔵 Medium | Materially improves quality, DX, or coverage |
| 🟢 Differentiator | Builds competitive moat; schedule freely after blockers |
| ✅ Complete | Merged to `main`; included in summary only |
| 🔄 In Progress | Active branch or current sprint |
| 🔲 Planned | Scoped and ready to start |

**Effort sizing** (2-engineer team): `XS` < 1 day · `S` 1–2 days · `M` 3–5 days · `L` 1–2 weeks · `XL` 2–4 weeks

---

## Timeline & Sequencing

| Phase | Status | Target Start | Est. Duration | Expected Completion |
|-------|--------|--------------|---------------|---------------------|
| **Phase 1** — Production Hardening | ✅ Complete | — | — | — |
| **Phase 2** — Team & Enterprise Foundation | 🔄 In Progress | Jan 2026 | 8–10 weeks | May 2026 |
| **Phase 3** — AI-Native Differentiation | 🔲 Planned | Jun 2026 | 10–12 weeks | Aug 2026 |
| **Phase 4** — Autonomous Intelligence | 🔲 Planned | Sep 2026 | 14–18 weeks | Dec 2026 |

**Critical Path:** Phase 2 blockers (INF-001, INF-002, INF-003, ACL-001, ACL-002) must complete before Phase 3 begins.

---

## Phase 2 Critical Dependencies

The following diagram shows the dependency tree for Phase 2. All blockers must complete before external team deployment:

```
┌─────────────────────────────────────────────────────────────┐
│  PHASE 2: TEAM & ENTERPRISE FOUNDATION                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Infrastructure Foundation (MUST COMPLETE FIRST)            │
│  ├── INF-001: PostgreSQL ✅ (XL, 2-4 weeks)                 │
│  ├── INF-002: Redis ✅ (L, 1-2 weeks) → depends on INF-001  │
│  └── INF-003: BullMQ ✅ (L, 1-2 weeks) → depends on INF-002 │
│                                                              │
│  Access Control (BLOCKS MULTI-USER DEPLOYMENTS)             │
│  ├── ACL-001: Multi-tenancy ✅ (L, 1-2 weeks)               │
│  └── ACL-002: RBAC ✅ (M, 3-5 days) → depends on ACL-001    │
│                                                              │
│  Features (Can run in parallel after infrastructure)        │
│  ├── SEC-001: Email verification ✅ (M)                     │
│  ├── SEC-002: CSP nonces ✅ (M)                             │
│  ├── SEC-003: GDPR/CCPA ✅ (M)                              │
│  ├── FEA-001: Notifications ✅ (M)                          │
│  ├── INF-004: OpenAPI ✅ (M) → after INF-005                │
│  ├── INF-005: API versioning ✅ (S)                         │
│  ├── FEA-003: AI fallback ✅ (M)                            │
│  └── SEC-004: MFA 🔲 (L) → after ACL-001                   │
│                                                              │
│  Data Layer (Planned)                                       │
│  └── FEA-002: TanStack React Query 🔲 (L)                  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Key:** Green items are complete (✅), red items are in progress (🔄), blue items are planned (🔲).

---

## Completed Work Summary

The following items have been verified complete against the codebase and are **not** detailed below.
See the [Archive](#archive--completed-items) section to view full details if needed.

| ID | Title | PR / Commit |
|----|-------|-------------|
| S3-02 | Shadow DOM support in crawler | PR #55 |
| S3-04 | DOM stability wait before snapshot | PR #55 |
| S3-08 | Disposable email address filter | PR #55 |
| ENH-004 | Persist AI provider keys encrypted in database | PR #80 |
| ENH-005 | Global API rate limiting (three-tier) | PR #78 |
| ENH-006 | Test scheduling engine (cron + timezone) | PR #86 |
| ENH-007 | Signed URL tokens for artifact serving | PR #79 |
| ENH-008 | Move `runs.logs` to append-only `run_logs` table | PR #86 |
| ENH-010 | Pagination on all list API endpoints | PR #78 |
| ENH-011 | CI/CD webhook receiver + GitHub Actions integration | PR #86 |
| ENH-013 | Persist password reset tokens in the database | PR #78 |
| ENH-020 | Soft-delete with recycle bin for tests, projects, runs | PR #81 |
| ENH-021 | `userId` + `userName` on activities for full audit trail | PR #78 |
| ENH-024 | Frontend code splitting (React.lazy + Suspense) | PR #78 |
| ENH-027 | Global React Error Boundary with crash reporting | PR #79 |
| ENH-029 | Diff view for AI-regenerated test code | PR #81 |
| ENH-030 | Secrets scanning in CI pipeline (Gitleaks) | PR #79 |
| ENH-034 | Empty crawl result `completed_empty` status | PR #86 |
| ENH-035 | No-provider-configured global banner (ProviderBanner) | PR #85 |
| MAINT-010 | Semantic deduplication via TF-IDF + fuzzy matching | PR #55 |
| MAINT-011 | Feature-sliced frontend component architecture | PR #81 |
| MAINT-012 | Deep test validation (locator, action, assertion) | PR #57 |
| MAINT-013 | Graceful shutdown with in-flight run draining | PR #86 |
| MAINT-016 | Renovate for automated dependency updates | Renovate |
| SEC-001 | Email verification on registration | PR #87 |
| INF-001 | PostgreSQL support with SQLite fallback | PR #87 |
| INF-002 | Redis for rate limiting, token revocation, and SSE pub/sub | PR #87 |
| INF-003 | BullMQ job queue for durable run execution | PR #92 |
| FEA-001 | Teams / email / webhook failure notifications | PR #92 |
| SEC-002 | Nonce-based Content Security Policy | PR #92 |
| SEC-003 | GDPR / CCPA account data export and deletion | PR #92 |
| INF-005 | API versioning (`/api/v1/`) with 308 redirects | PR #94 |
| FEA-003 | AI provider fallback chain + circuit breaker | PR #94 |
| DIF-003 | Mobile viewport / device emulation | PR #94 |
| DIF-011 | Coverage heatmap on site graph | PR #94 |
| DIF-014 | Cursor overlay on live browser view | PR #94 |
| DIF-016 | Step-level timing and per-step screenshots | PR #94 |
| AUTO-013 | Stale test detection and cleanup | PR #99 |
| MNT-007 | ARIA live regions for real-time updates | PR #99 |
| DIF-004 | Flaky test detection and reporting | PR #99 |
| MNT-009 | Tiered prompt system for local models (Ollama) | PR #100 |
| MNT-010 | Re-run button on Run Detail page for crawl/generate runs | PR #100 |
| INF-004 | OpenAPI specification and Swagger UI | PR #101 |
| AUTO-007 | Geolocation / locale / timezone testing | PR #101 |

---

## Phase Summary

| Phase | Scope | Status | Est. Duration | Key Blockers |
|-------|-------|--------|---------------|--------------|
| Phase 1 — Production Hardening | Security, reliability, data integrity | ✅ Complete | — | None |
| Phase 2 — Team & Enterprise Foundation | Auth hardening, multi-tenancy, RBAC, queues | 🔄 In Progress | 8–10 weeks | None (all blockers complete) |
| Phase 3 — AI-Native Differentiation | Visual regression, cross-browser, competitive features | 🔲 Planned | 10–12 weeks | Phase 2 completion |
| Phase 4 — Autonomous Intelligence | Risk-based testing, change detection, quality gates | 🔲 Planned | 14–18 weeks | Phase 3 completion |
| Ongoing — Maintenance & Platform Health | Healing AI, DX, exports, accessibility | 🔄 Continuous | — | None |

---

## Phase 2 — Team & Enterprise Foundation

*Goal: Multi-user, secure, and durable enough for team deployment (5–50 users). Blockers must be resolved before inviting external users or handling real customer data.*

### SEC-001 — Email verification on registration 🔴 Blocker

**Status:** ✅ Complete | **Effort:** M | **Source:** Quality Review (GAP-01)

**Problem:** `POST /api/auth/register` creates accounts immediately with no email verification. Any actor can claim any email address, enabling account spoofing.

**Acceptance Criteria:**
- ✅ Users cannot log in until email is verified
- ✅ Verification token expires after 24 hours
- ✅ Resend link available on login page
- ✅ Email sent via Resend/SendGrid/SMTP

**Files Changed:**
- `backend/src/database/migrations/` — `verification_tokens` table; `emailVerified` column on `users`
- `backend/src/routes/auth.js` — verification endpoint; login guard
- `backend/src/utils/emailSender.js` — email transport

**Dependencies:** None

---

### SEC-002 — Nonce-based Content Security Policy 🟡 High

**Status:** ✅ Complete | **Effort:** M | **Source:** Quality Review (GAP-03)

**Problem:** `appSetup.js:55` uses `'unsafe-inline'` for scripts and styles, enabling XSS attacks.

**Acceptance Criteria:**
- ✅ Per-request nonce generated and injected into `<script>` tags
- ✅ CSP header includes `'nonce-<value>'` only (no unsafe-inline)
- ✅ Vite build process automatically injects nonces

**Files Changed:**
- `backend/src/middleware/appSetup.js` — nonce generation and CSP directives
- `frontend/vite.config.js` — nonce injection plugin

**Dependencies:** None

---

### SEC-003 — GDPR / CCPA account data export and deletion 🟡 High

**Status:** ✅ Complete | **Effort:** M | **Source:** Quality Review (GAP-04)

**Problem:** No way for users to export their data or delete their accounts. GDPR Article 17 & 20 are legal requirements.

**Acceptance Criteria:**
- ✅ `DELETE /api/auth/account` hard-deletes user and all owned data
- ✅ `GET /api/auth/export` returns JSON archive of all user data within 30 days
- ✅ Deletion request requires email confirmation
- ✅ Audit log records all exports and deletions

**Files Changed:**
- `backend/src/routes/auth.js` — export and deletion endpoints
- All repositories — cascade delete logic
- `frontend/src/pages/Settings.jsx` — Account tab with delete/export buttons

**Dependencies:** None

---

### INF-001 — PostgreSQL support with SQLite fallback 🔴 Blocker

**Status:** ✅ Complete | **Effort:** XL | **Source:** Audit

**Problem:** SQLite is single-writer only. No horizontal scaling, no read replicas, permanent data loss on container restart without persistent volume.

**Acceptance Criteria:**
- ✅ Adapter pattern abstracts DB implementation (query, run, get, all)
- ✅ PostgreSQL adapter uses connection pooling (pg)
- ✅ SQLite adapter remains for development/single-instance deployments
- ✅ Migrations run against both databases
- ✅ No performance regression on read-heavy workloads

**Files Changed:**
- `backend/src/database/adapters/sqlite-adapter.js` — SQLite implementation
- `backend/src/database/adapters/postgres-adapter.js` — PostgreSQL implementation
- `backend/src/database/migrationRunner.js` — dialect-aware migrations
- `docker-compose.yml` — optional PostgreSQL service

**Dependencies:** None

**Breaking Change Notice:** ⚠️ After June 2026, SQLite will no longer be supported in production. Migrate to PostgreSQL via [MIGRATION_GUIDE.md](MIGRATION_GUIDE.md).

---

### INF-002 — Redis for rate limiting, token revocation, and SSE pub/sub 🔴 Blocker

**Status:** ✅ Complete | **Effort:** L | **Source:** Audit

**Problem:** Three critical components are process-local and broken in multi-instance deployments: (1) `revokedTokens` Map, (2) in-memory rate-limit store, (3) SSE broadcasting.

**Acceptance Criteria:**
- ✅ Logged-out users cannot reuse tokens after server restart
- ✅ Rate limiting enforced across all instances
- ✅ SSE events broadcast to all connected clients regardless of instance
- ✅ Redis pub/sub pub/sub handles 1000+ concurrent connections

**Files Changed:**
- `backend/src/utils/redisClient.js` — shared ioredis client
- `backend/src/routes/auth.js` — token revocation via Redis
- `backend/src/middleware/appSetup.js` — Redis rate-limit store
- `backend/src/routes/sse.js` — Redis pub/sub subscriber

**Dependencies:** INF-001 recommended; can introduce independently but coordinate to avoid double-touching infrastructure

---

### ACL-001 — Multi-tenancy: workspace ownership on all entities 🔴 Blocker

**Status:** ✅ Complete | **Effort:** L | **Source:** Audit

**Problem:** Every authenticated user sees every project, test, and run. No workspace, organisation, or team concept. Data isolation is non-existent.

**Acceptance Criteria:**
- ✅ `GET /api/tests` returns only tests owned by user's workspace
- ✅ User can belong to multiple workspaces
- ✅ `workspaceId` in JWT payload; enforced at middleware layer
- ✅ All entities (projects, tests, runs, activities) scoped to workspace
- ✅ Workspace switching in frontend without re-authentication

**Files Changed:**
- `backend/src/database/migrations/` — `workspaces` table; FKs on all entity tables
- `backend/src/database/repositories/workspaceRepo.js` — workspace CRUD
- `backend/src/middleware/appSetup.js` — `req.workspaceId` injection
- All route and repository files — workspace scoping

**Dependencies:** INF-001 (PostgreSQL strongly recommended before production)

---

### ACL-002 — Role-based access control (Admin / QA Lead / Viewer) 🔴 Blocker

**Status:** ✅ Complete | **Effort:** M | **Source:** Audit

**Problem:** All authenticated users have identical permissions. Admin-only operations (settings, deletion, user management) are only frontend-guarded; API accepts all requests.

**Acceptance Criteria:**
- ✅ Three roles: `admin`, `qa_lead`, `viewer` with distinct permissions
- ✅ API endpoints return 403 Forbidden for unauthorized roles
- ✅ Frontend hides UI for unauthorized users
- ✅ Role changes take effect immediately (no token caching)
- ✅ Audit log records all role changes

**Files Changed:**
- `backend/src/database/migrations/` — `role` column on `workspace_members`
- `backend/src/middleware/appSetup.js` — `requireRole()` middleware
- All route files for mutation operations — role guards
- `frontend/src/pages/Settings.jsx` — Members / Role management tab

**Dependencies:** ACL-001 (workspaces must exist first)

---

### INF-003 — BullMQ job queue for run execution 🟡 High

**Status:** ✅ Complete | **Effort:** L | **Source:** Audit

**Problem:** Run execution is fire-and-forget on HTTP handler thread. Process crash mid-run = lost work and stalled runs. No job persistence or retry logic.

**Acceptance Criteria:**
- ✅ All run executions enqueued to Redis-backed BullMQ queue
- ✅ Failed jobs automatically retry up to 3 times with exponential backoff
- ✅ Worker can scale horizontally; multiple workers process queue
- ✅ Run status updates in real-time via Redis pub/sub
- ✅ Job history persisted for audit trail

**Files Changed:**
- `backend/src/routes/runs.js` — replace `runWithAbort` with `queue.add()`
- `backend/src/workers/runWorker.js` — BullMQ Worker implementation
- `backend/src/queue.js` — shared Queue definition
- `docker-compose.yml` — worker service configuration

**Dependencies:** INF-002 (BullMQ requires Redis)

---

### FEA-001 — Teams / email / webhook failure notifications 🟡 High

**Status:** ✅ Complete | **Effort:** M | **Source:** Competitive (S2-03)

**Problem:** When a test run fails, there is no notification. Teams must poll the dashboard.

**Acceptance Criteria:**
- ✅ Send to Microsoft Teams, email, or generic webhook on failure
- ✅ Per-project notification settings (configurable recipients)
- ✅ Notification includes test name, failure message, link to run
- ✅ Notifications respect timezone for scheduling
- ✅ Failure notifications can be muted per project for 1–24 hours

**Files Changed:**
- `backend/src/utils/notifications.js` — Teams / email / generic webhook dispatcher
- `backend/src/testRunner.js` — call `fireNotifications()` on completion
- `backend/src/routes/projects.js` — notification config CRUD
- `frontend/src/pages/Settings.jsx` — per-project notification UI

**Dependencies:** None (scheduling already complete)

---

### FEA-002 — TanStack React Query data layer 🔵 Medium

**Status:** 🔲 Planned | **Effort:** L | **Source:** Audit

**Problem:** All data fetching uses manual `useEffect` + `useState` with no cache, background refresh, optimistic updates, or retry. UX feels sluggish.

**Acceptance Criteria:**
- ✅ All `api.get()` calls wrapped in `useQuery` with automatic caching
- ✅ Mutations use `useMutation` with optimistic updates (e.g., test approval)
- ✅ Failed requests auto-retry with exponential backoff
- ✅ Background refetch every 30s for real-time list updates
- ✅ Stale data clearly marked in UI (faded text, "refreshing..." spinner)

**Files Changed:**
- `frontend/src/main.jsx` — add `QueryClientProvider`
- All `frontend/src/pages/*.jsx` — migrate fetches to `useQuery`
- All `frontend/src/hooks/use*.js` — refactor to TanStack Query

**Dependencies:** None

---

### SEC-004 — MFA (TOTP / passkey) support 🔵 Medium

**Status:** 🔲 Planned | **Effort:** L | **Source:** Audit

**Problem:** No multi-factor authentication. MFA is a compliance requirement (SOC 2, ISO 27001) and a sales blocker for regulated industries.

**Acceptance Criteria:**
- ✅ Users can enable TOTP-based MFA via QR code + authenticator app
- ✅ Recovery codes generated during MFA setup
- ✅ Users must provide TOTP token at login if MFA enabled
- ✅ Admin can mandate MFA for all workspace members
- ✅ Passkey (WebAuthn) support for passwordless login (stretch goal)

**Files Changed:**
- `backend/src/routes/auth.js` — MFA enroll, verify, recovery endpoints
- `backend/src/database/migrations/` — `mfaSecret`, `mfaEnabled`, `mfaRecoveryCodes` columns
- `frontend/src/pages/Login.jsx` — MFA verification step
- `frontend/src/pages/Settings.jsx` — MFA setup and management

**Dependencies:** ACL-001 (allows per-workspace MFA policy)

---

## Phase 3 — AI-Native Differentiation

*Goal: Pull ahead of Mabl, Testim, and SmartBear (including BearQ) with AI-powered capabilities and advanced testing features. These items build the competitive moat.*

---

### DIF-001 — Visual regression testing with baseline diffing 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive

**Problem:** Detects functional failures but not visual regressions — layout shifts, colour changes, component repositioning. Competitors (Mabl, Testim) all have this.

**Acceptance Criteria:**
- ✅ First approved run captures full-page screenshot as baseline
- ✅ Subsequent runs diff against baseline using pixelmatch
- ✅ Diff view overlays changes (red highlights) on baseline
- ✅ Configurable pixel diff threshold (default: 0.1%)
- ✅ Per-step baseline capture for fine-grained regression detection

**Files Changed:**
- `backend/src/runner/visualDiff.js` — pixelmatch wrapper
- `backend/src/runner/executeTest.js` — baseline capture and comparison
- `backend/src/database/migrations/` — `baseline_screenshots` table
- `frontend/src/components/run/StepResultsView.jsx` — visual diff overlay

**Dependencies:** None

---

### DIF-002 — Cross-browser testing (Firefox, WebKit / Safari) 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive

**Problem:** Only Chromium supported. Playwright natively supports Firefox and WebKit. Many enterprise customers require Safari compatibility testing.

**Acceptance Criteria:**
- ✅ Run modal includes browser selector (Chromium, Firefox, WebKit)
- ✅ Test results include browser used
- ✅ Run detail page shows browser-specific failures
- ✅ Cross-browser runs can execute in parallel

**Files Changed:**
- `backend/src/runner/config.js` — parameterise `launchBrowser(browserName)`
- `backend/src/testRunner.js` — pass `browserName` from run config
- `frontend/src/components/run/RunRegressionModal.jsx` — browser selector

**Dependencies:** None

---

### DIF-005 — Embedded Playwright trace viewer 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** M | **Source:** Audit

**Problem:** Playwright traces linked as `.zip` downloads requiring local Trace Viewer installation. Significant debugging friction.

**Acceptance Criteria:**
- ✅ Trace viewer embedded and accessible at `/trace-viewer/`
- ✅ Run detail page includes "Open Trace" button
- ✅ Users can inspect network requests, DOM changes, console logs inline
- ✅ No local installation required

**Files Changed:**
- `backend/src/middleware/appSetup.js` — serve trace viewer static files
- `frontend/src/pages/RunDetail.jsx` — "Open Trace" button
- Build tooling — copy trace viewer assets on `npm install`

**Dependencies:** None

---

### DIF-015 — Interactive browser recorder for test creation 🟡 High

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive (BearQ)

**Problem:** Users must write descriptions or wait for crawl to create tests. BearQ's primary UX is a visual recorder: click through the app, and it records actions as Playwright code.

**Acceptance Criteria:**
- ✅ "Record a test" button opens live CDP screencast
- ✅ User interactions captured: clicks, fills, navigations, waits
- ✅ Recording stops automatically on timeout or user action
- ✅ Generated Playwright code matches Sentri's style guide
- ✅ Recorded test can be edited before saving

**Files Changed:**
- `backend/src/runner/recorder.js` — Playwright action capture
- `backend/src/routes/runs.js` — recording endpoints
- `frontend/src/components/run/RecorderModal.jsx` — live browser view
- `frontend/src/pages/Tests.jsx` — "Record a test" button

**Dependencies:** None (reuses existing CDP screencast infrastructure)

---

### DIF-006 — Standalone Playwright export (zero vendor lock-in) 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive

**Problem:** Vendor lock-in is the biggest objection to AI QA tools. QA Wolf offers this; Sentri does not. Teams want to eject at any time.

**Acceptance Criteria:**
- ✅ `GET /api/projects/:id/export/playwright` generates a zip
- ✅ Zip includes `playwright.config.ts`, `package.json`, one `.spec.ts` per test
- ✅ Exported code runs standalone without Sentri
- ✅ Export includes source URLs and test metadata in comments
- ✅ Frontend "Export as Playwright" button on Projects page

**Files Changed:**
- `backend/src/utils/exportFormats.js` — `buildPlaywrightZip()` function
- `backend/src/routes/tests.js` — export endpoint
- `frontend/src/pages/Projects.jsx` — export button

**Dependencies:** None
**See also:** MNT-005 (BDD/Gherkin export) — both should share packaging scaffolding

---

### DIF-007 — Conversational test editor connected to /chat 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive

**Problem:** `/chat` route exists but is disconnected from tests. Users who want to modify tests must edit Playwright code directly. Natural-language test editing would be powerful.

**Acceptance Criteria:**
- ✅ TestDetail.jsx includes "Edit with AI" panel
- ✅ Chat pre-seeded with test's current Playwright code
- ✅ AI response proposes code change
- ✅ Myers diff shows proposed changes inline
- ✅ User can accept, reject, or iterate on suggestion

**Files Changed:**
- `frontend/src/pages/TestDetail.jsx` — AI edit panel
- `backend/src/routes/chat.js` — test-context mode with code diff

**Dependencies:** None (DiffView component ✅ complete)

---

### DIF-008 — Jira / Linear issue sync 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive

**Problem:** Traceability data model stores `linkedIssueKey` and `tags` but no outbound sync. Test failures don't auto-create tickets.

**Acceptance Criteria:**
- ✅ OAuth integration with Jira and Linear
- ✅ On test failure, auto-create bug ticket with screenshot, error message, run link
- ✅ Per-project sync configuration (enabled/disabled, default project)
- ✅ Sync failures logged but don't block test runs

**Files Changed:**
- `backend/src/utils/integrations.js` — Jira and Linear API clients
- `backend/src/testRunner.js` — call `syncFailureToIssue()` on completion
- `backend/src/routes/settings.js` — integration config endpoints
- `frontend/src/pages/Settings.jsx` — Integrations tab

**Dependencies:** FEA-001 (shares notification dispatch pattern)

---

### DIF-009 — Autonomous monitoring mode (always-on QA agent) 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive

**Problem:** Sentri is currently triggered. Brand promise is "autonomous QA" — it should watch production continuously.

**Acceptance Criteria:**
- ✅ Per-project monitoring mode: run smoke tests on schedule (configurable frequency)
- ✅ On failure, auto-trigger re-run to distinguish regression from transient
- ✅ Alert on 2 consecutive failures
- ✅ Monitoring status dashboard showing last run, next scheduled run
- ✅ Can be paused/resumed per project

**Files Changed:**
- `backend/src/scheduler.js` — monitoring job type
- `backend/src/routes/projects.js` — monitoring config
- `frontend/src/pages/Dashboard.jsx` — monitoring status
- `frontend/src/pages/ProjectDetail.jsx` — monitoring config panel

**Dependencies:** INF-003 (BullMQ), FEA-001 (notifications)

---

### DIF-010 — Multi-auth profile support per project 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive (unique to Sentri)

**Problem:** Only single auth profile per project. Testing role-based access requires running same test suite multiple times with different credentials.

**Acceptance Criteria:**
- ✅ Named credential profiles per project (e.g., "admin", "viewer", "guest")
- ✅ Each profile has separate username/password or cookie payload
- ✅ `multi_role` Test Dial connected to profile selector
- ✅ Run can test against multiple profiles in parallel
- ✅ Per-profile audit trail of test results

**Files Changed:**
- `backend/src/utils/credentialEncryption.js` — multi-profile support
- `backend/src/routes/projects.js` — profile CRUD
- `backend/src/pipeline/stateExplorer.js` — accept `profileId`
- `frontend/src/pages/ProjectDetail.jsx` — credential profiles panel

**Dependencies:** None

---

### DIF-012 — Multi-environment support (staging vs. production) 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive

**Problem:** No concept of environments. Teams need to run same suite against `staging.myapp.com` and `myapp.com` separately.

**Acceptance Criteria:**
- ✅ `environments` table per project (name, baseUrl, credentials)
- ✅ Each run scoped to environment; separate run history per environment
- ✅ Dashboard shows per-environment pass rates
- ✅ Run modal includes environment selector
- ✅ Promotion workflow: tests pass on staging before production (optional gate)

**Files Changed:**
- `backend/src/database/migrations/` — new `environments` table
- All run and project routes — environment scoping
- `frontend/src/pages/ProjectDetail.jsx` — environment management
- `frontend/src/components/run/RunRegressionModal.jsx` — environment selector

**Dependencies:** ACL-001 (ensures environments are workspace-scoped)

---

### DIF-013 — Anonymous usage telemetry with opt-out 🔵 Medium

**Status:** 🔲 Planned | **Effort:** S | **Source:** Internal

**Problem:** Zero visibility into feature usage, crawl success rates, or error frequency. Data-driven prioritisation is impossible.

**Acceptance Criteria:**
- ✅ PostHog telemetry for crawl/run events, test generation counts, approval rates
- ✅ Respects `DO_NOT_TRACK=1` environment variable
- ✅ Self-hosted instances can disable telemetry via `SENTRI_TELEMETRY=0`
- ✅ No personal data collected (no email, no test content)
- ✅ Privacy policy and opt-out documented

**Files Changed:**
- `backend/src/utils/telemetry.js` — PostHog wrapper
- `backend/src/crawler.js` — crawl event instrumentation
- `backend/src/testRunner.js` — run event instrumentation
- `backend/.env.example` — telemetry documentation

**Dependencies:** None

---

## Phase 4 — Autonomous Intelligence

*Goal: Advance Sentri beyond triggered QA into a genuinely autonomous system. Items are postnoon Phase 3 completion and require stable APIs.*

---

### AUTO-001 — Intelligent test selection (risk-based run ordering) 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive Gap Analysis

**Problem:** Runs all tests in insertion order. Autonomous system should prioritise: tests covering changed code, previously-failing tests, flaky tests.

**Acceptance Criteria:**
- ✅ Risk score formula: `(daysSinceLastFail × 0.4) + (isAffectedByChange × 0.4) + (flakyScore × 0.2)`
- ✅ Tests reordered before execution based on risk
- ✅ Run detail shows why test was ordered (risk factors)
- ✅ Can be disabled per project if deterministic ordering required

**Files Changed:**
- `backend/src/utils/riskScorer.js` — compute risk score
- `backend/src/testRunner.js` — topological sort before execution
- `backend/src/database/repositories/testRepo.js` — expose scoring inputs

**Dependencies:** DIF-004 (flaky score), AUTO-002 (change detection)

---

### AUTO-002 — Change detection / diff-aware crawling 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive Gap Analysis

**Problem:** Re-crawls entire site every run. Autonomous system should detect changes and only regenerate tests for changed pages.

**Acceptance Criteria:**
- ✅ Post-crawl baseline snapshot: page URL → DOM fingerprint hash
- ✅ Next crawl diffs against baseline
- ✅ Only changed pages trigger test generation
- ✅ Removed pages flagged; associated tests marked stale
- ✅ Run response includes `changedPages[]`

**Files Changed:**
- `backend/src/pipeline/crawlBrowser.js` — baseline comparison
- `backend/src/pipeline/crawlDiff.js` — DOM fingerprint diff engine
- `backend/src/database/migrations/` — `crawl_baselines` table

**Dependencies:** None

---

### AUTO-003 — Confidence scoring and auto-approval of low-risk tests 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** Every generated test requires manual approval. True autonomy requires auto-approval above confidence threshold.

**Acceptance Criteria:**
- ✅ Quality score exposed as `tests.confidenceScore` (0–100)
- ✅ Per-project `autoApproveThreshold` setting (default: disabled)
- ✅ Tests above threshold auto-approved; below threshold stay draft
- ✅ Auto-approvals logged separately for audit trail
- ✅ Admin can override approval on any test

**Files Changed:**
- `backend/src/pipeline/deduplicator.js` — expose quality score
- `backend/src/pipeline/testPersistence.js` — auto-approve logic
- `backend/src/routes/projects.js` — threshold setting
- `frontend/src/pages/Tests.jsx` — auto-approved filter badge

**Dependencies:** None

---

### AUTO-004 — Test impact analysis from git diff / deployment webhook 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive Gap Analysis

**Problem:** Cannot determine which tests are affected by code changes. Mapping test URLs to changed files is manual.

**Acceptance Criteria:**
- ✅ Trigger endpoint accepts optional `changedFiles[]` array
- ✅ Configurable route-to-file map maps changed files to app routes
- ✅ Each test scored by relevance to changes (0–1.0)
- ✅ Run includes `affectedTests[]` with scores
- ✅ Can fail CI if affected tests don't pass (integration with AUTO-012)

**Files Changed:**
- `backend/src/routes/trigger.js` — accept `changedFiles[]`
- `backend/src/utils/impactAnalyzer.js` — route mapping and scoring
- `backend/.env.example` — `ROUTE_MAP_PATH` documentation

**Dependencies:** AUTO-002 (change detection baseline)

---

### AUTO-005 — Automatic test retry with flake isolation 🟡 High

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** Failed tests marked as failed immediately. Autonomous system should auto-retry before recording true failure, isolating flakes.

**Acceptance Criteria:**
- ✅ Failed tests auto-retry up to `MAX_TEST_RETRIES` (default: 2) times
- ✅ `retryCount` and `failedAfterRetry` recorded on results
- ✅ Only notify and increment failure count if failed after retries
- ✅ Flaky tests (inconsistent retries) logged separately
- ✅ Can be disabled per project for deterministic testing

**Files Changed:**
- `backend/src/testRunner.js` — retry loop
- `backend/src/database/migrations/` — `retryCount`, `failedAfterRetry` columns
- `backend/.env.example` — `MAX_TEST_RETRIES` documentation

**Dependencies:** None

---

### AUTO-010 — Root cause analysis and failure clustering 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive Gap Analysis

**Problem:** When 15 tests fail, they often share a root cause (e.g., login endpoint down). Reported independently instead of clustered.

**Acceptance Criteria:**
- ✅ Group failures by shared error message fingerprint
- ✅ Group failures by shared `sourceUrl` and failing step
- ✅ Report top-N clusters with "likely root cause" labels
- ✅ Cluster summary in run detail and notifications
- ✅ Single click to view all tests in a cluster

**Files Changed:**
- `backend/src/utils/failureClusterer.js` — clustering algorithm
- `backend/src/testRunner.js` — call clusterer on completion
- `frontend/src/pages/RunDetail.jsx` — Root Cause Summary panel

**Dependencies:** None

---

### AUTO-011 — Historical trend analysis and anomaly detection 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** Dashboard shows trends but never detects anomalies. Should alert: "Pass rate dropped 20% in the last 3 runs — likely regression."

**Acceptance Criteria:**
- ✅ Lightweight anomaly detector using rolling mean + standard deviation
- ✅ Alert when pass rate drops >15% (configurable) vs. prior 5-run baseline
- ✅ Anomaly alerts included in notifications
- ✅ Dashboard anomaly alert banner with explanation
- ✅ Can disable per project if expected volatility

**Files Changed:**
- `backend/src/utils/anomalyDetector.js` — rolling baseline analysis
- `backend/src/routes/dashboard.js` — add `anomalyAlert` to response
- `frontend/src/pages/Dashboard.jsx` — anomaly alert banner

**Dependencies:** FEA-001 (notifications)

---

### AUTO-012 — SLA / quality gate enforcement 🟡 High

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** No ability to define "this project must maintain >95% pass rate" and block deployments. CI/CD integration requires manual threshold checking.

**Acceptance Criteria:**
- ✅ Per-project `qualityGates`: minimum pass rate, max flaky %, max failures
- ✅ Evaluated on run completion; gates passed/failed included in response
- ✅ Can block CI/CD deployments if gates fail (webhook returns 400)
- ✅ Dashboard displays gate status and historical compliance
- ✅ Notifications alert when gates are about to fail

**Files Changed:**
- `backend/src/routes/projects.js` — quality gate CRUD
- `backend/src/testRunner.js` — evaluate gates
- `backend/src/routes/trigger.js` — include gate result in response
- `frontend/src/pages/ProjectDetail.jsx` — gate configuration

**Dependencies:** None

---

### AUTO-015 — Continuous test discovery on deployment events 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive Gap Analysis

**Problem:** Crawling is manually triggered. Autonomous system should auto-crawl on deployment, generate tests for new features.

**Acceptance Criteria:**
- ✅ Trigger endpoint accepts `triggerCrawl: true` flag
- ✅ Deployment event triggers diff-aware crawl (AUTO-002)
- ✅ New/changed pages auto-generate tests
- ✅ Vercel and Netlify deployment webhook support

**Files Changed:**
- `backend/src/routes/trigger.js` — add `triggerCrawl` parameter
- `backend/src/crawler.js` — target URLs from change diff
- `frontend/src/components/automation/IntegrationSnippets.jsx` — Vercel/Netlify snippets

**Dependencies:** AUTO-002, INF-003

---

### AUTO-016 — Accessibility testing (axe-core integration) 🟡 High

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** No accessibility testing. Playwright has first-class axe-core support. WCAG 2.1 checks on every crawled page would be powerful.

**Acceptance Criteria:**
- ✅ During crawl, inject @axe-core/playwright
- ✅ Run `checkA11y()` on each page; store violations
- ✅ Per-page accessibility report in crawl view
- ✅ Violations categorized by severity (critical, serious, minor)
- ✅ Can fail crawl if critical violations found (optional gate)

**Files Changed:**
- `backend/src/pipeline/crawlBrowser.js` — axe-core injection
- `backend/src/database/migrations/` — `accessibility_violations` table
- `frontend/src/components/crawl/CrawlView.jsx` — violation panel
- `backend/package.json` — add `@axe-core/playwright`

**Dependencies:** None

---

### AUTO-017 — Performance budget testing (Web Vitals) 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** No performance testing. Playwright can capture Web Vitals (LCP, CLS, FID/INP). Teams have no way to set performance budgets.

**Acceptance Criteria:**
- ✅ Capture Web Vitals (LCP, CLS, INP) after each navigation
- ✅ Per-page performance budgets stored in `performance_budgets` table
- ✅ Mark results as `PERFORMANCE_FAIL` when budgets exceeded
- ✅ Performance metrics dashboard showing trends
- ✅ Can fail run if performance budget breached

**Files Changed:**
- `backend/src/runner/executeTest.js` — Web Vitals capture
- `backend/src/database/migrations/` — `performance_budgets` table
- `frontend/src/pages/Dashboard.jsx` — performance metrics tab
- `frontend/src/pages/ProjectDetail.jsx` — budget configuration

**Dependencies:** None

---

### AUTO-018 — Plugin and extension system 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** XL | **Source:** Competitive Gap Analysis

**Problem:** No way to extend Sentri without forking. Autonomous platform needs hooks for custom assertions, healing strategies, report formats.

**Acceptance Criteria:**
- ✅ Plugin interface with lifecycle hooks: `beforeRun`, `afterStep`, `onFailure`, `onHealAttempt`, `onRunComplete`
- ✅ Plugins loaded from configurable `PLUGINS_DIR`
- ✅ Three first-party reference plugins included
- ✅ Plugin dependency graph and validation
- ✅ Detailed plugin development guide in docs

**Files Changed:**
- `backend/src/plugins/pluginLoader.js` — plugin discovery
- `backend/src/testRunner.js` — emit lifecycle hooks
- `backend/src/selfHealing.js` — expose `onHealAttempt` hook
- `backend/.env.example` — `PLUGINS_DIR` documentation

**Dependencies:** All Phase 3 items (APIs must be stable)

---

### AUTO-019 — Run diffing: per-test comparison across runs 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** Cannot compare two runs: "Run 42 had 3 new failures vs Run 41." Only shows trends, not per-test deltas.

**Acceptance Criteria:**
- ✅ `GET /api/runs/diff?runA=<id>&runB=<id>` returns per-test delta
- ✅ Deltas: `newFailures`, `newPasses`, `unchanged`, `unstable`
- ✅ "Compare runs" button on Runs page
- ✅ Diff view shows timeline and metrics
- ✅ Can compare against baseline run

**Files Changed:**
- `backend/src/routes/runs.js` — diff endpoint
- `frontend/src/pages/Runs.jsx` — run selection and comparison
- `frontend/src/pages/RunDiff.jsx` — diff view

**Dependencies:** None

---

### AUTO-020 — Deployment platform integrations (Vercel, Netlify) 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** Trigger endpoint is generic but no native integrations. Should auto-trigger on Vercel/Netlify deploys.

**Acceptance Criteria:**
- ✅ Webhook handlers for Vercel (`X-Vercel-Signature`) and Netlify (`X-Netlify-Token`)
- ✅ Signature verification on all incoming webhooks
- ✅ Extract preview URL from payload; use as run baseUrl
- ✅ Can restrict deployments to specific branches
- ✅ Documented setup in frontend integration cards

**Files Changed:**
- `backend/src/routes/trigger.js` — Vercel and Netlify handlers
- `frontend/src/components/automation/IntegrationCards.jsx` — integration cards
- `backend/.env.example` — webhook secret documentation

**Dependencies:** DIF-009 or INF-003

---

## Archive — Completed Items

The items below are complete and archived. Full details available upon request.

| ID | Title | Status | Effort |
|----|-------|--------|--------|
| SEC-001 | Email verification on registration | ✅ | M |
| SEC-002 | Nonce-based Content Security Policy | ✅ | M |
| SEC-003 | GDPR / CCPA account data export and deletion | ✅ | M |
| INF-001 | PostgreSQL support with SQLite fallback | ✅ | XL |
| INF-002 | Redis for rate limiting and token revocation | ✅ | L |
| INF-003 | BullMQ job queue for run execution | ✅ | L |
| INF-004 | OpenAPI specification and Swagger UI | ✅ | M |
| INF-005 | API versioning (`/api/v1/`) | ✅ | S |
| ACL-001 | Multi-tenancy: workspace ownership | ✅ | L |
| ACL-002 | Role-based access control | ✅ | M |
| FEA-001 | Teams / email / webhook notifications | ✅ | M |
| FEA-003 | AI provider fallback chain | ✅ | M |
| DIF-003 | Mobile viewport / device emulation | ✅ | S |
| DIF-004 | Flaky test detection and reporting | ✅ | M |
| DIF-011 | Coverage heatmap on site graph | ✅ | S |
| DIF-014 | Cursor overlay on live browser view | ✅ | S |
| DIF-016 | Step-level timing and per-step screenshots | ✅ | M |
| AUTO-007 | Geolocation / locale / timezone testing | ✅ | S |
| AUTO-013 | Stale test detection and cleanup | ✅ | S |

---

## Resource & Risk Matrix

| Phase | Team Size | Sprint Velocity | Estimated Sprints | Risk Level | Mitigation |
|-------|-----------|-----------------|-------------------|------------|-----------|
| Phase 2 (Remaining) | 2 FTE | 2–3 items/sprint | 3–4 | **MEDIUM** | Blockers already complete; FEA-002 can slip if needed |
| Phase 3 | 3–4 FTE | 3–4 items/sprint | 10–12 | **HIGH** | DIF features complex; start DIF-001 early for learning |
| Phase 4 | 3–4 FTE | 2–3 items/sprint | 14–18 | **VERY HIGH** | AUTO features require ML/clustering expertise; hire or train early |

---

## Deprecation Schedule

| Feature | Deprecation Date | Removal Date | Migration Path |
|---------|------------------|--------------|-----------------|
| SQLite in production | Jun 2026 | Sep 2026 | [PostgreSQL Migration Guide](MIGRATION_GUIDE.md) |
| `/api/*` (non-versioned routes) | Jun 2026 | Sep 2026 | Use `/api/v1/*`; 308 redirects active until removal |
| `POST /api/auth/register` email param | Jun 2026 | Sep 2026 | Email verification now required; no unverified accounts |

---

## Contributing & Process

- **Issue tracker:** [GitHub Issues](https://github.com/RameshBabuPrudhvi/sentri/issues)
- **Contribution guide:** [CONTRIBUTING.md](CONTRIBUTING.md)
- **PR template:** Use the provided [PR template](.github/PULL_REQUEST_TEMPLATE.md)
- **Acceptance criteria checklist:** Each roadmap item includes acceptance criteria; PRs must check all boxes

---

## Feedback & Changes

This roadmap is living. To propose changes:
1. Open a [GitHub Discussion](https://github.com/RameshBabuPrudhvi/sentri/discussions)
2. Tag with `[ROADMAP]` prefix
3. Include: impact (why), effort (how long), risk (what could go wrong), priority (when)

Major changes require consensus from maintainers (@RameshBabuPrudhvi, @contributors).
