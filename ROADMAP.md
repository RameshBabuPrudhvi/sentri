# Sentri — Engineering Roadmap

> **Last revised:** April 2026 · `sentri_v1_4`
> **Stack:** Node.js 20 (ESM) · Express 4 · SQLite → PostgreSQL · Playwright · React 18 · Vite 6
>
> This document is the single source of truth for all planned and in-progress engineering work.
> It is a full rewrite based on a comprehensive codebase audit, resolving numbering gaps, orphaned items,
> duplicate entries, and stale statuses present in prior versions.

---

## ⚡ Agent fast path

> **Working on the next PR? Read [`NEXT.md`](./NEXT.md) instead — it has the current item spec, files to change, and acceptance criteria. You do not need to read further in this file.**
>
> Come back here only to: look up a specific item by ID (Ctrl+F the ID e.g. `DIF-008`), check completed work history, or review phase/competitive context.
>
> **Current sprint:** `DIF-006` — Standalone Playwright export · **Blockers:** `INF-006` (hosted-deploy DB persistence — see below) · **Remaining:** 42 items

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

## Completed Work Summary

The following items have been verified complete against the codebase and are **not** repeated below.

> **Naming note:** Items numbered `MAINT-*` are legacy from prior roadmap versions. The current convention is `MNT-*`. Old IDs are preserved in PR descriptions and git history — do not rename them. Use `MNT-*` for all new maintenance items.

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
| FEA-002 | TanStack React Query data layer | PR #107 |
| MNT-011 | Persist crawl/generate dialsConfig on run record | Verified in PR #107 (fix landed in an earlier untracked commit) |
| ACL-001 | Multi-tenancy: workspace ownership on all entities | PR #87 |
| ACL-002 | Role-based access control (Admin / QA Lead / Viewer) | PR #87 |
| INF-004 | OpenAPI specification and Swagger UI | PR #94 |
| DIF-001 | Visual regression testing with baseline diffing | PR #94 |
| DIF-002 | Cross-browser testing (Firefox, WebKit / Safari) | PR #94 |
| DIF-002b | Cross-browser polish: browser-aware baselines, UI badges, CI coverage | PR #107, PR #110 |
| DIF-015 | Interactive browser recorder for test creation | PR #94 |
| AUTO-007 | Geolocation / locale / timezone testing | PR #94 |

---

## Phase Summary

| Phase | Scope | Status | Est. Duration |
|-------|-------|--------|---------------|
| Phase 1 — Production Hardening | Security, reliability, data integrity | ✅ Complete | — |
| Phase 2 — Team & Enterprise Foundation | Auth hardening, multi-tenancy, RBAC, queues | 🔄 In progress — `INF-006` (hosted-deploy persistence) is a new 🔴 Blocker; `ENH-036` (project credential edit) is 🟡 High; `SEC-004` deferred | 8–10 weeks |
| Phase 3 — AI-Native Differentiation | Visual regression, cross-browser, competitive features | 🔲 Planned | 10–12 weeks |
| Phase 4 — Autonomous Intelligence | Risk-based testing, change detection, quality gates | 🔲 Planned | 14–18 weeks |
| Ongoing — Maintenance & Platform Health | Healing AI, DX, exports, accessibility | 🔄 Continuous | — |

---

## Phase 2 — Team & Enterprise Foundation

*Goal: Multi-user, secure, and durable enough for team deployment (5–50 users). Blockers must be resolved before inviting external users or handling real customer data.*

---

### SEC-001 — Email verification on registration 🔴 Blocker

**Status:** ✅ Complete | **Effort:** M | **Source:** Quality Review (GAP-01)

**Problem:** `POST /api/auth/register` creates accounts immediately with no email verification. Any actor can claim any email address, enabling account spoofing. The forgot-password flow explicitly acknowledges this gap (`auth.js:426`). This is a SOC 2 compliance failure.

**Fix:** Add a `verification_tokens(token, userId, email, expiresAt)` table. On registration, create the user with `emailVerified = false` and send a signed token link via email. Block login for unverified users. Add `GET /api/auth/verify?token=` and a resend endpoint.

**Files to change:**
- `backend/src/database/migrations/` — add `verification_tokens` table; add `emailVerified` column to `users`
- `backend/src/routes/auth.js` — verification endpoint; block login for unverified accounts
- New `backend/src/utils/emailSender.js` — email transport (Resend / SendGrid / SMTP)
- `frontend/src/pages/Login.jsx` — show "verify your email" state with resend link
- `backend/.env.example` — document `SMTP_HOST`, `SMTP_PORT`, `RESEND_API_KEY`

**Dependencies:** None

---

### SEC-002 — Nonce-based Content Security Policy 🟡 High

**Status:** ✅ Complete | **Effort:** M | **Source:** Quality Review (GAP-03)

**Problem:** `appSetup.js:55` uses `'unsafe-inline'` for both `scriptSrc` and `styleSrc`. An inline comment acknowledges "replace with nonces in prod." Without nonces, any XSS injection can execute inline scripts — CSP provides no real protection.

**Fix:** Generate a per-request nonce via `crypto.randomBytes(16).toString('base64')`. Pass it to Helmet's CSP directives as `'nonce-<value>'`. Inject it into Vite's HTML template via a custom `transformIndexHtml` plugin. Remove `'unsafe-inline'` from `scriptSrc`.

**Files to change:**
- `backend/src/middleware/appSetup.js` — nonce generation middleware; update Helmet CSP directives
- `frontend/vite.config.js` — custom plugin to inject `nonce` attribute on `<script>` tags
- `frontend/index.html` — add nonce placeholder

**Dependencies:** None

---

### SEC-003 — GDPR / CCPA account data export and deletion 🟡 High

**Status:** ✅ Complete | **Effort:** M | **Source:** Quality Review (GAP-04)

**Problem:** There is no way for a user to export their data or delete their account. GDPR Article 17 (right to erasure) and Article 20 (data portability) are legal requirements for EU deployments. CCPA creates equivalent expectations for US users.

**Fix:** Add `DELETE /api/auth/account` — hard-deletes the user and all owned data (projects, tests, runs, activities, tokens, schedules). Add `GET /api/auth/export` — returns a JSON archive of all user data. Both endpoints require password confirmation. Add UI in Settings → Account.

**Files to change:**
- `backend/src/routes/auth.js` — `DELETE /account`, `GET /export` endpoints
- All repository files — cascade delete by `userId`
- `frontend/src/pages/Settings.jsx` — Account tab with delete/export buttons

**Dependencies:** None

---

### INF-001 — PostgreSQL support with SQLite fallback 🔴 Blocker

**Status:** ✅ Complete | **Effort:** XL | **Source:** Audit

**Problem:** SQLite is a single-writer database. There is no horizontal scaling, no read replicas, and data loss is permanent if a container is recreated without a persistent volume. WAL mode helps concurrent reads but does not solve write contention at scale.

**Fix:** Introduce a `db-adapter` interface (`query`, `run`, `get`, `all`). Implement `sqlite-adapter.js` (current behaviour) and `postgres-adapter.js` (using `pg` with connection pooling). Select the adapter based on `DATABASE_URL` — if it starts with `postgres://`, use PostgreSQL; otherwise fall back to SQLite. Update `migrationRunner.js` for both SQL dialects.

**Files to change:**
- New `backend/src/database/adapters/sqlite-adapter.js`
- New `backend/src/database/adapters/postgres-adapter.js`
- `backend/src/database/sqlite.js` — refactor to adapter pattern
- `backend/src/database/migrationRunner.js` — dialect-aware migration runner
- `docker-compose.yml` — add optional PostgreSQL service
- `backend/.env.example` — document `DATABASE_URL`

**Dependencies:** None

---

### INF-002 — Redis for rate limiting, token revocation, and SSE pub/sub 🔴 Blocker

**Status:** ✅ Complete | **Effort:** L | **Source:** Audit

**Problem:** Three critical components are process-local and broken in any multi-instance deployment: (1) `revokedTokens` Map — logged-out users can reuse tokens after restart; (2) `express-rate-limit` memory store — rate limits reset on restart and are not shared across instances; (3) `runListeners` Map — SSE events emitted on instance A are never received by clients on instance B.

**Fix:** Add `ioredis` as an infrastructure dependency. Replace the `revokedTokens` Map with Redis `SET jti EX <token_ttl>`. Replace the rate-limit memory store with `rate-limit-redis`. Replace direct SSE writes with a Redis pub/sub channel — the SSE route subscribes to `sentri:run:<runId>` and the event emitter publishes to it.

**Files to change:**
- New `backend/src/utils/redisClient.js` — shared `ioredis` client
- `backend/src/routes/auth.js` — token revocation via Redis
- `backend/src/middleware/appSetup.js` — Redis-backed rate-limit store
- `backend/src/routes/sse.js` — Redis pub/sub subscriber
- `backend/src/utils/runLogger.js` — publish events to Redis channel
- `backend/.env.example` — document `REDIS_URL`

**Dependencies:** INF-001 recommended; Redis can be introduced independently, but coordinate with the PostgreSQL sprint to avoid double-touching infrastructure in the same window.

---

### ACL-001 — Multi-tenancy: workspace ownership on all entities 🔴 Blocker

**Status:** ✅ Complete | **Effort:** L | **Source:** Audit

**Problem:** Every authenticated user sees every project, test, and run in the database. There is no workspace, organisation, or team concept. `GET /api/tests` returns all tests to any authenticated user. This is a hard blocker for any commercial deployment — companies must not see each other's test data.

**Fix:** Add a `workspaces` table. Add `workspaceId TEXT NOT NULL` as a foreign key to `projects`, `tests`, `runs`, and `activities`. Include `workspaceId` in the JWT payload. Update `requireAuth` middleware to inject `req.workspaceId`. Add `WHERE workspaceId = ?` to all queries. Add workspace creation to the onboarding flow.

**Files to change:**
- `backend/src/database/migrations/` — create `workspaces` table; add `workspaceId` FKs to all entity tables
- New `backend/src/database/repositories/workspaceRepo.js`
- `backend/src/routes/auth.js` — include `workspaceId` in JWT
- `backend/src/middleware/appSetup.js` — inject `req.workspaceId` via `requireAuth`
- All route and repository files — scope all queries to `workspaceId`
- `frontend/src/context/AuthContext.jsx` — expose `workspace` to the application

**Dependencies:** INF-001 (PostgreSQL strongly recommended before this lands in production)

---

### ACL-002 — Role-based access control (Admin / QA Lead / Viewer) 🔴 Blocker

**Status:** ✅ Complete | **Effort:** M | **Source:** Audit

**Problem:** All authenticated users have identical permissions. Admin-only operations (settings, data deletion, user management) are only visually guarded on the frontend — the API accepts them from any authenticated user. Role separation is a hard requirement for any team deployment.

**Fix:** Add `role TEXT DEFAULT 'viewer'` to the `workspace_members` table: `admin`, `qa_lead`, `viewer`. Extend `requireAuth` to expose `req.userRole`. Add `requireRole('admin')` and `requireRole('qa_lead')` middleware. Gate destructive operations and settings behind role checks. Update frontend `ProtectedRoute` and action buttons to check role from `AuthContext`.

**Files to change:**
- `backend/src/database/migrations/` — add `role` column to workspace/user tables
- `backend/src/middleware/appSetup.js` — add `requireRole()` middleware
- All route files for mutation operations — add role guards
- `frontend/src/context/AuthContext.jsx` — expose `role`
- `frontend/src/components/layout/ProtectedRoute.jsx` — role-based route guarding
- `frontend/src/pages/Settings.jsx` — Members / Role management tab

**Dependencies:** ACL-001 (workspaces must exist first)

---

### INF-003 — BullMQ job queue for run execution 🟡 High

**Status:** ✅ Complete | **Effort:** L | **Source:** Audit

**Problem:** Run execution is started as a detached `async` operation directly on the HTTP request handler thread (`runWithAbort`). If the process crashes mid-run, work is lost and runs remain stuck in `status: 'running'`. There is no global concurrency limit across projects, no priority queue, and no visibility into the job backlog.

**Fix:** Replace `runWithAbort` fire-and-forget with a BullMQ `Queue.add()` call. Implement a `Worker` in `runWorker.js` that calls `crawlAndGenerateTests` or `runTests`. The worker runs as a separate process from the HTTP server. Configure a global concurrency limit via `MAX_WORKERS`. Expose queue depth and active job count on the dashboard.

**Files to change:**
- `backend/src/routes/runs.js` — replace `runWithAbort` with `queue.add()`
- New `backend/src/workers/runWorker.js` — BullMQ Worker implementation
- New `backend/src/queue.js` — shared Queue definition
- `backend/package.json` — add `bullmq`
- `backend/.env.example` — document `MAX_WORKERS`

**Dependencies:** INF-002 (BullMQ requires Redis)

---

### FEA-001 — Teams / email / webhook failure notifications 🟡 High

**Status:** ✅ Complete | **Effort:** M | **Source:** Competitive (S2-03)

**Problem:** When a test run completes with failures, there is no outbound notification. Teams must poll the dashboard. With scheduling already live (ENH-006 ✅), this is the other half of autonomous operation — teams need to know immediately when something breaks.

**Fix:** Add a per-project `notification_settings` table (Microsoft Teams incoming webhook URL, email recipients via Resend/SendGrid, generic webhook URL). On run completion, if `run.failed > 0`, dispatch all configured channels. Teams Adaptive Card payload includes pass/fail counts, failing test names, run duration, and a deep link to the run detail page.

**Files to change:**
- New `backend/src/utils/notifications.js` — Teams / email / generic webhook dispatcher
- `backend/src/testRunner.js` — call `fireNotifications(run, project)` on completion
- `backend/src/routes/projects.js` — notification config CRUD endpoints
- `frontend/src/pages/Settings.jsx` — per-project notification config UI
- `backend/.env.example` — document `RESEND_API_KEY`, `SENDGRID_API_KEY`

**Dependencies:** None (scheduling already complete)

---

### FEA-002 — TanStack React Query data layer 🔵 Medium

**Status:** ✅ Complete | **Effort:** L | **Source:** Audit

**Problem:** All data fetching uses manual `useEffect` + `useState` patterns with no cache, no background refresh, no optimistic updates, and no retry. `useProjectData` exports `invalidateProjectDataCache` which callers must manually invoke — multiple components fail to do so, producing stale UI after mutations.

> **Note:** This item was previously orphaned inside the ENH-017 section in the prior roadmap with no assigned ID, causing it to appear as a sub-item of the notifications feature. It is a distinct data-layer concern and is assigned **FEA-002** here.

**Fix:** Install `@tanstack/react-query`. Define query keys per entity. Wrap all `api.get()` calls in `useQuery`. Mutations use `useMutation` with `queryClient.invalidateQueries`. This eliminates manual cache invalidation, provides automatic background refetch, and gives free retry logic.

**Files to change:**
- `frontend/package.json` — add `@tanstack/react-query`
- `frontend/src/main.jsx` — add `QueryClientProvider`
- All `frontend/src/pages/*.jsx` — migrate `useEffect` fetches to `useQuery`
- All `frontend/src/hooks/use*.js` — refactor to TanStack Query patterns

**Dependencies:** None

---

### INF-004 — OpenAPI specification and Swagger UI 🔵 Medium

**Status:** ✅ Complete | **Effort:** M | **Source:** Audit

**Problem:** There is no machine-readable API contract. This blocks CI/CD integration auto-generation, external tooling (Postman collections), and third-party plugins. It also makes engineer onboarding harder — the only documentation is inline JSDoc comments.

**Fix:** Generate an OpenAPI 3.1 spec from existing JSDoc annotations using `swagger-jsdoc`. Serve it at `GET /api/openapi.json`. Mount `swagger-ui-express` at `/api/docs` for interactive exploration.

**Files to change:**
- New `backend/src/openapi.js` — spec assembly
- `backend/src/index.js` — mount Swagger UI
- `backend/package.json` — add `swagger-jsdoc`, `swagger-ui-express`

**Dependencies:** INF-005 (implement API versioning first so the spec reflects stable routes)

---

### INF-005 — API versioning (`/api/v1/`) 🔵 Medium

**Status:** ✅ Complete | **Effort:** S | **Source:** Audit

> **Historical note:** Originally scoped as Medium priority but pulled forward in PR #94 to unblock INF-004 (OpenAPI spec needs stable versioned routes). In hindsight this should have been 🟡 High — keep priority labels in mind for similar foundational dependencies.

**Problem:** All routes are mounted at `/api/*` with no version prefix. Any breaking API change will immediately break all consumers — CI/CD integrations, GitHub Actions, external webhooks — with no safe migration path.

**Fix:** Mount all routers under `/api/v1/`. Update `API_BASE` in the frontend. Add 308 redirects from `/api/*` to `/api/v1/*` for backward compatibility during the transition window (308 preserves HTTP method on redirect).

**Files to change:**
- `backend/src/index.js` — update route mount paths
- `frontend/src/utils/apiBase.js` — update `API_BASE` constant
- `backend/src/middleware/appSetup.js` — backward-compatibility redirects

**Dependencies:** None

---

### INF-006 — Persistent storage on hosted deployments (Render disk + Postgres add-on) 🔴 Blocker

**Status:** 🔲 Planned | **Effort:** S | **Source:** Operational feedback (PR #115 dogfooding — every Render redeploy wipes the SQLite DB, forcing fresh signup + project recreation)

**Problem:** Sentri runs fine locally because `docker-compose.yml` mounts `backend/data/` as a named volume, but Render's web-service container filesystem is **ephemeral** — every redeploy gets a fresh disk and `backend/data/sentri.db` resets to empty. Operators dogfooding on Render must re-register, recreate every project, and re-run every crawl after every deploy. There is no `render.yaml` in the repo, no documented Render disk path, and no production-hardening callout that SQLite + free-tier Render is incompatible. INF-001 ✅ already shipped PostgreSQL adapter support, so the fix is partly configuration and partly documentation; the missing pieces are the deployment manifest and the operator guidance.

**Fix:**
- Add a `render.yaml` Blueprint at the repo root that declares the web service, mounts a Persistent Disk at `/app/backend/data` (1 GB, free tier), sets `DB_PATH=/app/backend/data/sentri.db`, and **also** declares a free Postgres add-on with `DATABASE_URL` wired in (commented out by default — operators uncomment to switch).
- Update `backend/.env.example` with a `# Hosted deployment` section documenting both paths (disk-mounted SQLite vs Render Postgres) and the trade-off (SQLite + disk is simpler but doesn't scale beyond one instance; Postgres is required for INF-002 / INF-003 multi-instance work).
- Add a "Production deployments" callout in `README.md` and `docs/` warning that running on Render / Fly / Railway free tiers without a persistent disk WILL wipe the database on redeploy, with copy-pasteable fixes for each platform.
- Add a startup probe in `backend/src/index.js` that detects ephemeral storage (DB path inside `/tmp` or no recent writes from prior process) and emits a `formatLogLine("warn", …)` "DB path appears ephemeral — data will be lost on redeploy" so the symptom is visible in logs instead of mysterious data loss.

**Files to change:**
- New `render.yaml` — Render Blueprint with disk + optional Postgres add-on
- `backend/.env.example` — hosted deployment section
- `backend/src/index.js` — ephemeral-storage warning at boot
- `README.md`, `docs/getting-started.md` — production deployment callout
- `docs/changelog.md` — `### Added` entry once shipped

**Acceptance criteria:**
- A fresh Render deployment from `render.yaml` survives redeploys without wiping accounts, projects, tests, or runs.
- Operators get a single visible log line at boot telling them when the DB path is ephemeral.
- The README explicitly names this as a footgun and points to the Blueprint.

**Dependencies:** None (INF-001 ✅ already shipped Postgres support; this item only adds deployment manifests + docs)

---

### ENH-036 — Project credential editing after creation 🟡 High

**Status:** 🔲 Planned | **Effort:** S | **Source:** Operational feedback (PR #115 dogfooding — operators must delete the project + every test to rotate a stale credential)

**Problem:** `POST /api/v1/projects` accepts a `credentials` field (encrypted at `backend/src/routes/projects.js:59` via `encryptCredentials()`), but there is no `PATCH /api/v1/projects/:id` endpoint that allows editing those credentials after the project has been created. The only PATCH routes on `projects.js` are scoped to schedule (`projects.js:162`) and notifications (`projects.js:266`). When a target app's password rotates, an OAuth token expires, or an SSO config changes, operators have to **delete the entire project** — including every recorded/generated test, every run history record, every approved baseline — and recreate it from scratch with the new credentials. This is data loss for what should be a single field update.

**Fix:** Add `PATCH /api/v1/projects/:id` accepting `{ name?, url?, credentials? }`, gated by `requireRole("qa_lead")` (matching the role gate on the existing project mutation routes). When `credentials` is present, run it through `encryptCredentials()` before persisting — never store plaintext. Add an "Edit project" affordance in the Project Detail header that opens the same form used at creation but pre-filled. Mirror the create-route validation (URL shape, credentials schema). Update `permissions.json` with the new entry. Add `api.updateProject(id, data)` to the frontend client. Add integration tests covering: 401 unauth, 403 viewer role, 400 invalid URL, 200 happy path with credential rotation, audit-log entry written.

**Files to change:**
- `backend/src/routes/projects.js` — new `PATCH /:id` route
- `backend/src/middleware/permissions.json` — register new endpoint
- `frontend/src/api.js` — `updateProject(id, data)` helper
- `frontend/src/pages/ProjectDetail.jsx` — "Edit project" button + reuse the create form
- `backend/tests/projects.test.js` (or sibling) — auth/role/validation/happy-path coverage
- `docs/changelog.md` — `### Added` entry once shipped

**Acceptance criteria:**
- Rotating a project's credentials no longer requires deleting the project.
- Tests, runs, baselines, schedules, notification settings on the project survive the credential change.
- Viewer role gets `403`; QA lead and admin succeed.
- New credentials are written through `encryptCredentials()` (verified by reading the column post-update — must not be plaintext).

**Dependencies:** ACL-002 ✅ (role-based access control already exists)

---

### FEA-003 — AI provider fallback chain on rate limits 🔵 Medium

**Status:** ✅ Complete | **Effort:** M | **Source:** Audit

**Problem:** If the primary AI provider returns a rate limit error, the pipeline fails after `LLM_MAX_RETRIES` attempts with no fallback. If Anthropic is temporarily rate-limited, all test generation stops — even if OpenAI or Ollama is configured and available. There is no circuit breaker.

**Fix:** In `generateText()`, catch rate limit errors (`isRateLimitError`) and automatically retry with the next configured provider in `CLOUD_DETECT_ORDER` before giving up. Add a circuit breaker per provider that disables it for 5 minutes after 3 consecutive rate limit failures. Log all fallback events.

**Files to change:**
- `backend/src/aiProvider.js` — fallback chain and circuit breaker logic
- `backend/src/pipeline/journeyGenerator.js` — surface fallback provider in run logs

**Dependencies:** None

---

### SEC-004 — MFA (TOTP / passkey) support 🔵 Medium

**Status:** 🔲 Planned | **Effort:** L | **Source:** Audit

**Problem:** There is no multi-factor authentication. MFA is a compliance requirement (SOC 2, ISO 27001) and a sales blocker for regulated industries.

**Fix:** Add TOTP-based MFA using `otplib`. Store the encrypted TOTP secret in the `users` table. Add MFA setup flow (QR code generation), MFA verification at login, and recovery codes. Passkey (WebAuthn) support can follow in a subsequent sprint.

**Files to change:**
- `backend/src/routes/auth.js` — MFA enroll, verify, and recovery endpoints
- `backend/src/database/migrations/` — add `mfaSecret`, `mfaEnabled`, `mfaRecoveryCodes` to `users`
- `frontend/src/pages/Login.jsx` — MFA verification step
- `frontend/src/pages/Settings.jsx` — MFA setup and management

**Dependencies:** ACL-001 (multi-tenancy first allows for per-workspace MFA policy)

---

### SEC-005 — SAML / OIDC SSO federation 🔵 Medium

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive (BearQ, enterprise)

**Problem:** Sentri supports email/password + GitHub/Google OAuth, and SEC-004 covers TOTP MFA, but there is no SAML 2.0 or OIDC federation support. Enterprise procurement teams require SSO integration with their identity provider (Okta, Azure AD, OneLogin, Ping). BearQ inherits SmartBear's enterprise SSO. This is a distinct requirement from MFA — SSO replaces the login flow entirely rather than adding a second factor.

**Fix:** Integrate `openid-client` for OIDC and `@node-saml/passport-saml` for SAML 2.0. Add a per-workspace SSO configuration (metadata URL, client ID, certificate). When SSO is enabled, redirect login to the IdP. Map IdP attributes to Sentri user fields. Auto-provision users on first SSO login. Add SSO configuration UI in Settings → Authentication.

**Files to change:**
- `backend/src/middleware/authenticate.js` — add `saml` and `oidc` auth strategies
- `backend/src/routes/auth.js` — SSO callback endpoints, IdP-initiated login
- `backend/src/database/migrations/` — `sso_configurations` table per workspace
- `frontend/src/pages/Settings.jsx` — SSO configuration panel
- `backend/package.json` — add `openid-client`, `@node-saml/passport-saml`

**Dependencies:** ACL-001 (workspaces must exist for per-workspace SSO configuration)

---

## Phase 3 — AI-Native Differentiation

*Goal: Pull ahead of Mabl, Testim, and SmartBear (including BearQ) with AI-powered capabilities and advanced testing features. These items build the competitive moat.*

---

### DIF-001 — Visual regression testing with baseline diffing 🟢 Differentiator

**Status:** ✅ Complete | **Effort:** L | **Source:** Competitive

**Problem:** Sentri detects functional failures (wrong text, broken navigation, missing elements) but not visual regressions — layout shifts, colour changes, component repositioning. Mabl and Testim both offer visual diffing natively. Screenshot capture already runs on every test step; the diff layer is the missing piece.

**Fix:** On the first approved run for a test, capture a full-page screenshot as the baseline at `data/baselines/<testId>/step-<N>.png`. On subsequent runs, diff against the baseline using `pixelmatch`. Flag regions with pixel difference above `VISUAL_DIFF_THRESHOLD` (default 2%) as a `VISUAL_REGRESSION` failure type. Surface the diff overlay in `StepResultsView.jsx` as a toggleable before/after view. An "Accept visual changes" action updates the baseline.

**Files to change:**
- New `backend/src/runner/visualDiff.js` — `pixelmatch` wrapper
- `backend/src/runner/executeTest.js` — capture and compare against baseline
- `backend/src/database/migrations/` — `baseline_screenshots` table
- `backend/src/routes/runs.js` — serve diff images
- `frontend/src/components/run/StepResultsView.jsx` — visual diff overlay component
- `backend/package.json` — add `pixelmatch`, `pngjs`

**Dependencies:** None

---

### DIF-002 — Cross-browser testing (Firefox, WebKit / Safari) 🟢 Differentiator

**Status:** ✅ Complete | **Effort:** M | **Source:** Competitive

> **Intentional scope boundaries (documented during #XXX, captured as follow-on IDs DIF-002b and DIF-002c below):**
> - Visual baselines (DIF-001) are keyed by `(testId, stepNumber)` only, not by browser. Running the same test under Firefox and Chromium against a Chromium-recorded baseline will produce spurious pixel diffs from font-rendering differences. → **DIF-002b**
> - Cross-browser CI smoke coverage is not yet wired. Only `resolveBrowser()` is unit-tested; live-launch verification of firefox/webkit still relies on manual testing. → **DIF-002b**
> - Run Detail, Runs list, and Run History UIs do not yet render a per-run browser badge. The data (`run.browser`) is persisted and returned by the API; the frontend just doesn't surface it. → **DIF-002b**
> - Crawler (`crawlBrowser.js`, `stateExplorer.js`), interactive recorder (`recorder.js`), and the live CDP screencast (`screencast.js`) are pinned to Chromium because they rely on CDP / shadow-DOM APIs not available in Firefox or WebKit. Firefox/WebKit crawling is out of scope. → **DIF-002c**

**Problem:** Only Chromium is supported. Playwright natively supports Firefox and WebKit — this is a configuration gap, not a technical limitation. Many enterprise customers require Safari compatibility testing and will ask about it during evaluation.

**Fix:** Parameterise `launchBrowser(browserName)` to accept `'chromium'` | `'firefox'` | `'webkit'`. Add a browser selector to `RunRegressionModal.jsx`. Include `browser` on test results. Show browser icon and name per result in `RunDetail.jsx`.

**Files to change:**
- `backend/src/runner/config.js` — parameterise `launchBrowser()`
- `backend/src/testRunner.js` — pass `browserName` from run config
- `frontend/src/components/run/RunRegressionModal.jsx` — browser selector
- `frontend/src/pages/RunDetail.jsx` — browser icon per result

**Dependencies:** None

---

### DIF-002b — Cross-browser polish: browser-aware baselines, UI badges, CI coverage 🔵 Medium

**Status:** ✅ Complete | **Effort:** M | **Source:** Follow-on from DIF-002

**Progress:**
- **PR #107** — Gap 3 (browser badge) shipped: new `BrowserBadge` component renders the Playwright engine on Run Detail header (test runs only) and Runs list rows (compact, non-chromium only).
- **PR #110** — Gap 1 (browser-aware visual baselines) shipped: `baseline_screenshots` re-keyed to `(testId, stepNumber, browser)` via migration `010_baseline_browser.sql`; `visualDiff.js`, `baselineRepo`, and baseline accept/delete/list routes thread `browser` end-to-end. Pre-upgrade chromium baselines stay effective via a legacy-path fallback in `ensureBaseline()` (the migration cannot move PNG files on disk).
- **PR #110** — Gap 2 (cross-browser CI smoke) shipped: new `cross-browser-smoke` matrix in dedicated workflow `.github/workflows/cross-browser.yml` provisions firefox + webkit via Playwright and asserts `launchBrowser({ browser })` actually opens the requested engine and renders a page. Path-filtered to PRs touching `backend/src/runner/**` and runs nightly on `main` (matches the original DIF-002b spec — "run them only on PRs touching `runner/config.js` or on nightly cron"). `fail-fast: false` keeps both engines independently visible.

**Problem:** DIF-002 landed the core cross-browser dispatch (`resolveBrowser()`, per-run `browser` field, migration 009, Run Regression modal dropdown) but left three visible gaps that prevent firefox/webkit from feeling like first-class citizens:

1. **Visual baselines are browser-agnostic.** `visualDiff.js` keys baselines by `(testId, stepNumber)`. Running the same test under Firefox against a Chromium baseline produces spurious pixel diffs from font-rendering differences — users will hit this the first time they click the new Browser dropdown on a test that has a baseline.
2. **No CI smoke coverage for firefox/webkit.** `backend/tests/cross-browser.test.js` unit-tests `resolveBrowser()` without actually launching firefox or webkit. A Playwright API regression (e.g. an option name change in an engine-specific path) would only surface in production.
3. **Run Detail / Runs list / Run History show no browser badge.** `run.browser` is persisted and returned via the API but no UI component reads it. Users can pick firefox in the modal but can't tell which browser a completed run used without opening its logs.

**Fix:**
- Extend the `baseline_screenshots` PK from `(testId, stepNumber)` to `(testId, stepNumber, browser)`. Change `visualDiff.js` paths to `artifacts/baselines/<testId>/<browser>/step-<N>.png`. Update `backend/src/routes/tests.js` baseline accept/delete endpoints to accept `browser` as a route param or query string. Backfill existing baselines as `browser = "chromium"` in the migration.
- Add a CI job to `.github/workflows/ci.yml` that installs all three Playwright engines and runs a minimal 1-test smoke against each (asserts that `launchBrowser({ browser })` succeeds and the test executes). Gate on test duration — firefox/webkit double the CI time, so run them only on PRs touching `runner/config.js` or on nightly cron.
- Add a browser badge component (`<BrowserBadge browser={run.browser} />`) rendering a lucide icon + text. Consume it in `frontend/src/pages/RunDetail.jsx` header, `Runs.jsx` list rows, and the Run Regression history view. Fall back to "chromium" for pre-migration-009 rows where `run.browser` is null.

**Files to change:**
- `backend/src/database/migrations/010_baseline_browser.sql` — new PK
- `backend/src/database/repositories/baselineRepo.js` — accept `browser` param
- `backend/src/runner/visualDiff.js` — rekey baseline paths
- `backend/src/routes/tests.js` — baseline CRUD accepts `browser`
- `.github/workflows/ci.yml` — cross-browser smoke job
- New `frontend/src/components/shared/BrowserBadge.jsx`
- `frontend/src/pages/RunDetail.jsx`, `frontend/src/pages/Runs.jsx` — render the badge

**Dependencies:** None (DIF-002 already complete)

---

### DIF-002c — Cross-browser crawl and recorder support 🔲 Backlog

**Status:** 🔲 Planned | **Effort:** XL | **Source:** Follow-on from DIF-002

**Problem:** Crawler (`pipeline/crawlBrowser.js`, `pipeline/stateExplorer.js`), interactive recorder (`runner/recorder.js`), and the live CDP screencast (`runner/screencast.js`) are pinned to Chromium in DIF-002. They use Playwright's CDP APIs directly — `page.context().newCDPSession()`, `Page.startScreencast`, shadow-DOM tree walkers via CDP `DOM.getFlattenedDocument` — which Firefox has no equivalent for and WebKit implements only partially via WebDriver BiDi. Users who want to crawl/record a Safari-only issue or test a WebKit rendering quirk during authoring have no path.

**Fix (high-level; deliberately deferred until there is customer demand):**
- Replace CDP screencast with Playwright's cross-browser `page.screenshot()` polling at ~8-12 fps. Lower quality but engine-agnostic. Keep CDP path for chromium as a fast fallback.
- Replace the CDP-based shadow-DOM tree walker in `crawlBrowser.js` with Playwright's `page.locator()` + `{ strict: false }` serialisation. Slower but engine-agnostic.
- Add a browser param to `POST /projects/:id/record` and `POST /projects/:id/crawl` routes; pass through to the relevant pipeline modules.
- Accept that crawl quality will degrade for firefox/webkit relative to chromium until Playwright's BiDi API stabilises.

**Files to change:**
- `backend/src/pipeline/crawlBrowser.js`, `stateExplorer.js` — accept `browser` param, swap CDP calls for cross-engine equivalents
- `backend/src/runner/recorder.js` — accept `browser`, swap screencast impl
- `backend/src/runner/screencast.js` — dual-path (CDP for chromium, screenshot poll fallback)
- `frontend/src/components/run/RecorderModal.jsx`, `frontend/src/components/run/CrawlProjectModal.jsx` — browser selector

**Dependencies:** DIF-002 ✅, DIF-002b (baselines must be browser-aware before crawler variability amplifies diff noise)

---

### DIF-003 — Mobile viewport / device emulation 🟢 Differentiator

**Status:** ✅ Complete | **Effort:** S | **Source:** Competitive

**Problem:** There is no device emulation. Playwright ships with 50+ device profiles (`playwright.devices`) covering iPhone, Galaxy, iPad, and desktop variants. A device selector is high-value, low-effort, and a standard evaluation question for any QA platform.

**Fix:** Accept a `device` parameter in run config. Map device name to `playwright.devices[name]` to get viewport, user agent, and touch settings. Apply via `browser.newContext({ ...devices[device] })`.

**Files to change:**
- `backend/src/runner/config.js` — device map lookup
- `backend/src/runner/executeTest.js` — apply device context
- `frontend/src/components/run/RunRegressionModal.jsx` — device selector dropdown

**Dependencies:** None

---

### DIF-004 — Flaky test detection and reporting 🟢 Differentiator

**Status:** ✅ Complete | **Effort:** M | **Source:** Competitive

**Problem:** There is no mechanism to identify tests that alternate between passing and failing across runs. Flaky tests erode trust in the test suite and consume engineering time investigating non-reproducible failures. The run result data to detect them already exists in the database but is never surfaced.

**Fix:** After each run, compute a `flakyScore` (pass/fail balance ratio over the last N runs) for each test and persist it to `tests.flakyScore`. Add a "Flaky Tests" panel to the dashboard showing the top 10 flakiest tests. Tests above a threshold receive a flaky badge in the test list.

**Files to change:**
- New `backend/src/utils/flakyDetector.js` — compute flaky score from run history
- `backend/src/testRunner.js` — call detector on run completion
- `backend/src/database/migrations/` — add `flakyScore` to `tests`
- `frontend/src/pages/Dashboard.jsx` — Flaky Tests panel
- `frontend/src/components/shared/TestBadges.jsx` — flaky badge

**Dependencies:** None

---

### DIF-005 — Embedded Playwright trace viewer 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** M | **Source:** Audit

**Problem:** Playwright traces are linked as `.zip` downloads requiring a local Playwright Trace Viewer installation to open. This is a significant debugging friction point — most users will not bother. Mabl has an inline trace-style view; Sentri should too.

**Fix:** Copy the Playwright trace viewer build (`@playwright/test/lib/trace/viewer/`) into `public/trace-viewer/`. Serve it at `/trace-viewer/`. From the run detail page, link to `/trace-viewer/?trace=<artifact-signed-url>` to open the trace inline in an iframe.

**Files to change:**
- `backend/src/middleware/appSetup.js` — serve trace viewer static files
- `frontend/src/pages/RunDetail.jsx` — "Open Trace" button linking to inline viewer
- Build tooling to copy trace viewer assets on `npm install`

**Dependencies:** None

---

### DIF-015 — Interactive browser recorder for test creation 🟡 High

**Status:** ✅ Complete | **Effort:** L | **Source:** Competitive (BearQ)

> **Intentional scope boundary (captured as follow-on DIF-015b below):**
> - The injected `bestSelector()` in `backend/src/runner/recorder.js:102-112` is a 5-strategy fallback chain (data-testid → role+name → id → name attr → tag.class). Playwright's own `codegen` uses a significantly more sophisticated selector-generation algorithm with scoring, disambiguation for duplicate matches, and iframe/shadow-DOM handling. We can't reuse `codegen` directly because it opens a desktop Inspector window with no cross-origin SaaS deployment story, but we **can** import Playwright's internal `selectorGenerator` module to get the same quality while keeping our server-side-browser + SSE-screencast architecture. → **DIF-015b**

**Problem:** Sentri requires users to either write a plain-English description or wait for a full-site crawl to create tests. BearQ's primary UX is a visual recorder: click through the app, and the AI records and enhances the test. Users who cannot articulate a test scenario in text have no path to test creation. This is the single biggest UX barrier vs BearQ.

**Fix:** Add a "Record a test" mode that opens the target URL in a Playwright browser served via CDP screencast (the live view infrastructure already exists). Capture user interactions (clicks, fills, navigations) as raw Playwright actions. On stop, run the captured actions through the existing assertion enhancement pipeline (Stage 6) and self-healing transform (`applyHealingTransforms`). Save as a draft test with the recorded code.

**Files to change:**
- New `backend/src/runner/recorder.js` — Playwright `page.on('action')` capture + CDP session management
- `backend/src/routes/runs.js` — `POST /api/projects/:id/record` endpoint to start/stop recording
- `frontend/src/components/run/RecorderModal.jsx` — live browser view with record/stop controls
- `frontend/src/pages/Tests.jsx` — "Record a test" button alongside existing Crawl and Generate

**Dependencies:** None (reuses existing CDP screencast and self-healing transform infrastructure)

---

### DIF-015b — Recorder selector quality: adopt Playwright's selectorGenerator 🔵 Medium

**Status:** 🔲 Planned | **Effort:** S | **Source:** Follow-on from DIF-015

**Problem:** The DIF-015 recorder captures user interactions correctly but the selectors it emits are noticeably lower-quality than what Playwright's own `codegen` tool produces. Three concrete gaps:

1. **No disambiguation for duplicate matches.** Our `bestSelector()` at `backend/src/runner/recorder.js:102-112` produces `button.btn-primary` — fine when there's one on the page, but if the page has three, the recorded `safeClick(page, 'button.btn-primary')` picks the first visible one instead of the exact one the user clicked. Codegen emits `button.btn-primary >> nth=2` or disambiguates via nearest text/role.
2. **Weak scoring when multiple strategies fit.** For a button with both `data-testid="submit"` and accessible name "Save changes", we pick data-testid; codegen's scorer weights semantic roles higher in some cases (e.g. if the testid is auto-generated `data-testid="el_abc123"` it falls back to role+name). Our heuristic has no notion of "good" vs "noise" data-testids.
3. **No iframe / shadow DOM handling.** Clicking inside an iframe or shadow root produces a selector scoped to the main document, which then fails at replay. Codegen emits the full `frameLocator(…) >> locator(…)` chain automatically.

Using Playwright's own `codegen` tool isn't an option — it's a CLI that opens a desktop Inspector window (`chromium.launch({ devtools: true })`) with no way to stream the browser to a web UI. The recorder architecture has to stay server-side with CDP screencast. But the selector-generation algorithm itself lives at `node_modules/playwright-core/lib/server/injected/selectorGenerator.js` and is pure DOM code with no CLI dependencies.

**Fix:** Replace the hand-rolled `bestSelector()` in `RECORDER_SCRIPT` (`backend/src/runner/recorder.js:97-160`) with a call into Playwright's internal `generateSelector()`. The algorithm:
- Prefers role+name with proper ARIA semantics.
- Handles CSS ambiguity by appending `>> nth=N` when the primary selector matches multiple elements.
- Emits the correct `internal:label=` / `internal:role=` tokens that the replay engine understands.
- Knows about `iframe` and shadow-root boundaries and prefixes the selector accordingly.

Because it's marked internal, import risk is real — the path or signature could change in any Playwright minor release. Mitigate with:
- A thin wrapper in `backend/src/runner/selectorGenerator.js` that tries the internal import first and falls back to the existing `bestSelector()` on failure, logged as a warning.
- A unit test (`backend/tests/recorder-selector.test.js`) that asserts the import resolves and produces output for a fixture HTML snippet — catches breakage the moment Renovate bumps Playwright.

**Files to change:**
- New `backend/src/runner/selectorGenerator.js` — import Playwright's `selectorGenerator` with fallback
- `backend/src/runner/recorder.js` — swap `RECORDER_SCRIPT`'s `bestSelector()` for a call into the wrapper (the wrapper runs in Node; the recorder passes target-element metadata to it via the `__sentriRecord` binding instead of generating the selector in page context)
- New `backend/tests/recorder-selector.test.js` — fixture-based assertion that the wrapper produces expected Playwright selectors
- `backend/tests/run-tests.js` — register the new test file
- `docs/changelog.md` — `### Changed` entry documenting the improved selector quality

**Acceptance criteria:**
- Recorded click on a page with three identical `button.btn-primary` elements produces a disambiguated selector that replays correctly.
- Recorded interaction inside an `<iframe>` produces a `frameLocator(…).locator(…)` chain.
- If the internal import fails (Playwright patch release changed the path), the recorder falls back to `bestSelector()` and logs a single warning — does not crash.
- `backend/tests/recorder.test.js` tests still pass unchanged (the action-to-code transformation in `actionsToPlaywrightCode` is independent of selector generation).

**Dependencies:** DIF-015 ✅

---

### DIF-015c — Recorder gaps backlog (action vocabulary, assertions, pause/undo, auth, mobile) 🔵 Medium

**Status:** 🔲 Planned | **Effort:** L (split into sub-items below) | **Source:** PR #115 dogfooding + competitive review (BearQ / Mabl / Testim)

**Problem:** PR #115 made the canvas interactive and aligned recorded steps with the AI-generated / manual format, but the recorder still has six distinct gaps that surface during real use against e-commerce, kanban, and admin-dashboard targets. These are scoped here as a backlog so future PRs can pick them off individually without re-doing this analysis.

#### Gap 1 — Expanded action vocabulary

`RECORDER_SCRIPT` (`backend/src/runner/recorder.js:98-161`) listens for only `click`, `change`, `keydown`. Seven common gestures produce zero captured actions:

| Gesture | Why it matters | Suggested mapping |
|---|---|---|
| **Drag-and-drop** | Trello, Notion, kanban boards, file pickers | `dragstart`+`drop` paired → `page.dragAndDrop(src, dst)` |
| **Double-click** | Inline editors, text selection | `dblclick` → `page.dblclick(sel)` |
| **Right-click** | Context menus | `contextmenu` → `page.click(sel, { button: 'right' })` |
| **File upload** | `<input type="file">` content | filename only (no full path — leaks tmpdir) → `page.setInputFiles(sel, [name])` |
| **Paste** | Pasted tokens / addresses / JSON | `paste` event clipboard text → `safeFill(sel, '<text>')` truncated to 500 chars (matches `fill`) |
| **Hover with intent** | Hover-only menus, tooltips | Out of scope — too noisy without UX work |
| **Keyboard shortcuts** | Ctrl+A / Ctrl+C / Cmd+Enter | Out of scope — needs explicit "record this shortcut" UX |

Each new kind requires a typedef union member, an `actionsToPlaywrightCode` branch, a `recordedActionToStepText` branch, and a regression test. Coordinate with DIF-015b (selectorGenerator) to avoid `RECORDER_SCRIPT` merge conflicts.

#### Gap 2 — Inline assertion authoring during recording

The recorder captures *what the user did* but never *what they expected*. Stage 6 of the AI pipeline infers assertions post-hoc, which produces weak / missing assertions for negative tests, state-dependent flows ("cart count is 3"), cross-page assertions, and count assertions. Competitors (BearQ, Mabl, Testim) all let the user toggle into "assert mode" mid-recording, click an element, and pick an assertion type from a popover (`is visible` / `has text` / `has count` / `URL matches` / `has class`).

Implementation sketch: add an Assert toggle to `RecorderModal` next to Stop & Save; when active, the canvas suppresses `forwardInput` and instead highlights the hovered element + opens an assertion picker. Captured `assert` actions slot into `actionsToPlaywrightCode` as `await expect(...)` calls. The Steps panel reads `Then the "Sign in" button is visible`.

#### Gap 3 — Pause / resume + undo last action

Once recording starts, every action is captured through to Stop. There is no way to:
- **Pause** while authenticating manually (recorder captures the password keystrokes — currently truncated to 40 chars in step prose, but the full value lives in `playwrightCode`).
- **Resume** from a paused state to continue the same recording.
- **Undo** the last captured action when the user mis-clicks (current workaround: discard the entire session and start over).
- **Edit** an action mid-recording (e.g. fix a typo in a fill value before saving).

Server-side change is small (a `pause` / `resume` / `pop-last` route + session-state guards in `forwardInput`); the UX work in `RecorderModal` is the larger lift.

#### Gap 4 — Authentication / pre-logged-in state handling

The recorder starts at `startUrl` with a fresh browser context — no cookies, no localStorage, no logged-in state. Three flows have no good answer today:

1. **Recording a test against an authenticated app** — user must record the login flow as part of every test, even though the resulting test will execute under a different fixture in CI. Workaround is to record the full login each time.
2. **Recording behind SSO / OAuth** — login redirects through a third-party IdP (Google / Okta / Azure AD); the recorder captures the IdP form fields but those selectors are useless at replay (the IdP UI changes; tests cannot be rerun against a different env).
3. **MFA-protected logins** — every recording requires re-doing MFA, which is not deterministic.

Possible fix: integrate with project credential profiles (DIF-010) so the recorder browser context is seeded with `storageState` from a captured login, skipping login entirely. Pair with environment-aware credential profiles per `MNT-004` / `DIF-012`.

#### Gap 5 — Mobile / touch / device profile during recording

The recorder runs at desktop viewport only. There is no device dropdown in `RecorderModal`. Users who want to record a mobile-only flow (touch interactions, hamburger menus, mobile checkout) currently have to record at desktop and replay at mobile, which produces brittle selectors and miss-tagged steps.

Fix is small: thread a `device` param through `POST /projects/:id/record` → `recorder.js`, and set `browser.newContext({ ...devices[device] })` the same way `executeTest.js` already does for runs (DIF-003). UX is a device dropdown in `RecorderModal` mirroring the one in `RunRegressionModal`.

#### Gap 6 — Sites that block embedding / detect headless

Some target apps detect headless Chromium (via `navigator.webdriver`, missing chrome plugins, viewport inconsistencies) and refuse to render or behave differently. Sentri's recorder uses a real Chromium, but with default Playwright launch args that include the webdriver flag.

Workaround today is to set `BROWSER_HEADLESS=false` (per `REVIEW.md:154-156`). Long-term fix is to add a "stealth" launch profile to `launchBrowser()` that hides automation markers — `playwright-extra` + `puppeteer-extra-plugin-stealth` is the conventional choice. Track separately if customer demand surfaces.

**Suggested split into PRs:**

| Sub-item | Effort | Priority |
|---|---|---|
| Gap 1 — Expanded action vocabulary | M | 🟡 High |
| Gap 2 — Inline assertion authoring | M | 🟢 Differentiator (parity with BearQ) |
| Gap 3 — Pause / resume + undo | S | 🔵 Medium |
| Gap 4 — Auth / storageState integration | M | 🔵 Medium (depends on DIF-010) |
| Gap 5 — Device profile during recording | S | 🔵 Medium |
| Gap 6 — Stealth launch profile | S | 🔵 Medium |

**Files to change** (per sub-item — not all-at-once):
- `backend/src/runner/recorder.js` — RECORDER_SCRIPT extensions, action typedef, code/step generators
- `backend/src/routes/tests.js` — POST /record param surface
- `frontend/src/components/run/RecorderModal.jsx` — Assert toggle, pause/resume controls, device dropdown
- `frontend/src/components/run/LiveBrowserView.jsx` — assertMode prop that suppresses forwardInput
- `backend/tests/recorder.test.js` — coverage for each new kind / mode
- `QA.md` recorder section — captured / not-captured lists per gap
- `docs/changelog.md` — `### Added` entries per shipped sub-item

**Dependencies:** DIF-015 ✅. DIF-015b (selectorGenerator) should land before Gap 1 to avoid `RECORDER_SCRIPT` merge conflicts. DIF-010 (multi-auth profiles) is a soft prerequisite for Gap 4. DIF-003 (device emulation) provides the runtime infra Gap 5 reuses.

---

### DIF-016 — Step-level timing and per-step screenshots 🔵 Medium

**Status:** ✅ Complete | **Effort:** M | **Source:** Audit

**Problem:** Test results show pass/fail per test but not a timeline of how long each step took. The most common debugging question — "where is my test slow?" — requires reading raw logs. Step timing data is not currently collected. Additionally, clicking different steps in StepResultsView always shows the same end-of-test screenshot — users cannot see what the page looked like at each step.

**Fix:** Inject `await __captureStep(N)` calls after each `// Step N:` comment in the generated code. Each capture records a screenshot and timing data (`{ step, durationMs, completedAt }`). StepResultsView shows the per-step screenshot when a step is clicked (falls back to the final screenshot for tests without step markers). Real per-step timing replaces the approximate linear interpolation.

**Files to change:**
- `backend/src/runner/executeTest.js` — record step start/end timestamps
- `backend/src/runner/codeExecutor.js` — inject timing instrumentation
- `frontend/src/components/run/StepResultsView.jsx` — waterfall chart

**Dependencies:** None

---

### DIF-006 — Standalone Playwright export (zero vendor lock-in) 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive

**Problem:** The biggest objection to AI QA tools is vendor lock-in. Teams want to know they can eject at any time. QA Wolf offers this; Sentri does not. Tests are viewable in the UI but not independently runnable.

**Fix:** Add a `GET /api/projects/:id/export/playwright` endpoint that generates a zip containing a `playwright.config.ts`, one `.spec.ts` file per approved test (Playwright code wrapped in a proper `test()` block), and a `README.md` with run instructions.

**Files to change:**
- `backend/src/utils/exportFormats.js` — add `buildPlaywrightZip(project, tests)` function
- `backend/src/routes/tests.js` — add `GET /projects/:id/export/playwright`
- `frontend/src/pages/Tests.jsx` — "Export as Playwright project" button

**Dependencies:** None
**See also:** MNT-005 (BDD/Gherkin export) — both extend `exportFormats.js` and should be developed in the same or consecutive sprints to share packaging scaffolding.

---

### DIF-007 — Conversational test editor connected to /chat 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive

**Problem:** The `/chat` route and `LLMStreamPanel` component exist but are not connected to specific tests. Users who want to modify a test must edit Playwright code directly. Natural-language test editing — "add an assertion that the cart total updates" — is a significant UX differentiator (BearQ offers NL input for creation but not inline code editing on existing tests).

**Fix:** In `TestDetail.jsx`, add an "Edit with AI" panel that opens a chat thread pre-seeded with the test's current Playwright code. The AI response proposes a code change. Show a Myers diff of old vs. new code (the `DiffView` component is already complete ✅). One-click "Apply" patches the code and saves.

**Files to change:**
- `frontend/src/pages/TestDetail.jsx` — AI edit panel with inline diff view
- `backend/src/routes/chat.js` — test-context mode with code diff response format

**Dependencies:** None (DiffView component ✅ complete; serves as the foundation for this feature)

---

### DIF-008 — Jira / Linear issue sync 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive

**Problem:** The traceability data model already stores `linkedIssueKey` and `tags` per test, but there is no outbound sync. When a test fails, no ticket is automatically created. Engineers must manually correlate test failures to issues.

**Fix:** Add `POST /api/integrations/jira` and `POST /api/integrations/linear` settings endpoints to store OAuth tokens. On test run failure, auto-create a bug ticket (with screenshot, error message, and Playwright trace attached). Sync pass/fail status back to the linked issue's status field. Add an Integrations tab to Settings.

**Files to change:**
- New `backend/src/utils/integrations.js` — Jira and Linear API clients
- `backend/src/testRunner.js` — call `syncFailureToIssue(test, run)` on completion
- `backend/src/routes/settings.js` — integration config endpoints
- `frontend/src/pages/Settings.jsx` — Integrations tab

**Dependencies:** FEA-001 (notification infrastructure shares the dispatch pattern)

---

### DIF-009 — Autonomous monitoring mode (always-on QA agent) 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive

**Problem:** Sentri is currently a triggered tool — it runs when instructed. The brand promise of "autonomous QA" implies it should also watch production continuously. No competitor outside enterprise tiers offers this for self-hosted deployments.

**Fix:** Add a monitoring mode per project: run a configurable set of smoke tests on a schedule against the production URL. On failure, auto-trigger a re-run to distinguish a regression from a transient flake (2 consecutive failures = confirmed). Fire notifications on confirmed failures. Show a "Monitor" badge on the dashboard for active monitoring projects.

> **Overlap resolution:** This feature builds on scheduling (ENH-006 ✅) and depends on notifications (FEA-001) for alerting. The 2-consecutive-failure confirmation logic is distinct from both and is not duplicated in either dependency — it is implemented here as monitoring-specific re-run orchestration in `scheduler.js`.

**Files to change:**
- `backend/src/scheduler.js` — add monitoring job type alongside scheduled runs
- `backend/src/routes/projects.js` — `PATCH /projects/:id/monitor`
- `frontend/src/pages/Dashboard.jsx` — monitoring status indicators
- `frontend/src/pages/ProjectDetail.jsx` — monitoring config panel

**Dependencies:** INF-003 (BullMQ — retry logic needs durable job execution), FEA-001 (failure notifications)

---

### DIF-010 — Multi-auth profile support per project 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive (unique to Sentri)

**Problem:** Sentri stores credentials per-project but supports only a single auth profile. Testing role-based access control — "admin sees this, viewer does not" — requires running the same test suite under different identities. The Test Dials already expose a `multi_role` perspective option that is not yet wired to actual credential profiles.

**Fix:** Add named credential profiles (e.g., "admin", "viewer", "guest") per project, each with a separate username/password or cookie payload. Wire the `multi_role` Test Dial to the profile selector. Surface per-profile result columns in the run detail view.

**Files to change:**
- `backend/src/utils/credentialEncryption.js` — extend to support multiple named profiles
- `backend/src/routes/projects.js` — profile CRUD endpoints
- `backend/src/pipeline/stateExplorer.js` — accept `profileId` param
- `frontend/src/pages/ProjectDetail.jsx` — credential profiles panel
- `frontend/src/components/shared/TestDials.jsx` — connect `multi_role` dial to profile selector

**Dependencies:** None

---

### DIF-011 — Coverage heatmap on site graph 🟢 Differentiator

**Status:** ✅ Complete | **Effort:** S | **Source:** Competitive

**Problem:** The site graph shows crawled pages but gives no signal about which pages have test coverage. Teams cannot identify gaps visually without reading a table.

**Fix:** For each node in `SiteGraph.jsx`, compute a test density score: 0 approved tests = red, 1–2 = amber, 3+ = green. Overlay the score as a coloured ring on each node with a legend.

**Files to change:**
- `frontend/src/components/crawl/SiteGraph.jsx` — density score computation and colour ring
- `backend/src/routes/dashboard.js` — add `testsByUrl` to dashboard API response

**Dependencies:** None

---

### DIF-012 — Multi-environment support (staging vs. production) 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive

**Problem:** There is no concept of environments per project. Teams need to run the same test suite against `staging.myapp.com` and `myapp.com` separately, with per-environment run history and independent pass/fail status. This is a critical enterprise requirement.

**Fix:** Add an `environments` table per project (`name`, `baseUrl`, `credentials`). Each run is scoped to an environment. Dashboard shows per-environment pass rates. Run modal allows environment selection.

**Files to change:**
- `backend/src/database/migrations/` — new `environments` table
- All run and project routes — scope runs to an environment
- `frontend/src/pages/ProjectDetail.jsx` — environment management panel
- `frontend/src/components/run/RunRegressionModal.jsx` — environment selector

**Dependencies:** ACL-001 (multi-tenancy ensures environments are workspace-scoped)

---

### DIF-013 — Anonymous usage telemetry with opt-out 🔵 Medium

**Status:** 🔲 Planned | **Effort:** S | **Source:** Audit

**Problem:** Sentri has zero telemetry. The team has no visibility into feature usage, crawl success rates, model performance comparisons, or error frequency. Data-driven prioritisation is impossible.

**Fix:** Add a PostHog telemetry module tracking crawl/run events, test generation counts, provider used, approval/rejection rates, and healing events. Respect `DO_NOT_TRACK=1` and `SENTRI_TELEMETRY=0`. Hash all machine IDs. Log domain only — never full URLs. Deduplicate daily events via a local file cache.

**Files to change:**
- New `backend/src/utils/telemetry.js` — PostHog wrapper with opt-out
- `backend/src/crawler.js` — instrument crawl events
- `backend/src/testRunner.js` — instrument run events
- `backend/.env.example` — document `SENTRI_TELEMETRY=0`
- `backend/package.json` — add `posthog-node`

**Dependencies:** None

---

### DIF-014 — Cursor overlay on live browser view 🔵 Medium

**Status:** ✅ Complete | **Effort:** S | **Source:** Audit (M-04)

**Problem:** Sentri's live CDP screencast shows the browser but gives no visual indication of what the test is currently doing. Viewers cannot tell which element is about to be clicked, filled, or asserted — making live runs difficult to follow.

**Fix:** Inject an animated cursor dot, click ripple, and keystroke toast via `page.evaluate()` after each navigation. Port from the `CURSOR_INJECT_SCRIPT` pattern.

**Files to change:**
- `backend/src/runner/executeTest.js` — inject cursor overlay script
- `backend/src/runner/pageCapture.js` — cursor position emission

**Dependencies:** None

---

## Phase 4 — Autonomous Intelligence

*Goal: Advance Sentri beyond triggered QA into a genuinely autonomous system that makes intelligent decisions about what to test, when to test, and what failures mean. Items in this phase are post-Phase 3 and can be prioritised individually based on customer demand.*

> **Note:** Some Phase 4 items have already shipped opportunistically alongside other work and appear in the Completed Work Summary above (e.g. `AUTO-007`, `AUTO-013`). The remaining ~20 items are scoped here and ready to start.

---

### AUTO-001 — Intelligent test selection (risk-based run ordering) 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive Gap Analysis

**Problem:** Sentri runs all approved tests in insertion order on every run. An autonomous system should prioritise: run tests covering recently changed code first, run previously-failing tests first, and skip tests for unchanged pages. No ordering logic exists in `testRunner.js` or `scheduler.js`. Mabl and Testim both offer smart test selection.

**Fix:** Before each run, sort the test queue by a risk score: `riskScore = (daysSinceLastFail × 0.4) + (isAffectedByRecentChange × 0.4) + (flakyScore × 0.2)`. Update `testRunner.js` to accept a sorted queue from the risk scorer.

**Files to change:**
- New `backend/src/utils/riskScorer.js` — compute risk score per test
- `backend/src/testRunner.js` — sort test queue before execution
- `backend/src/database/repositories/testRepo.js` — expose `lastFailedAt`, `flakyScore` for scoring

**Dependencies:** DIF-004 (flaky score), AUTO-002 (change detection enriches the score)

---

### AUTO-002 — Change detection / diff-aware crawling 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive Gap Analysis

**Problem:** Sentri re-crawls the entire site on every run. An autonomous system should detect what changed since the last crawl (new pages, modified DOM, removed elements) and only regenerate tests for affected pages. `crawler.js` has no concept of a previous crawl baseline. This is the difference between "run everything nightly" and "test only what changed."

**Fix:** After each crawl, store a `crawl_baseline` snapshot per project (page URL → DOM fingerprint hash). On the next crawl, diff against the baseline to identify changed pages. Only run the generation pipeline for changed pages. Emit a `pages_changed` event over SSE.

**Files to change:**
- `backend/src/pipeline/crawlBrowser.js` — baseline comparison logic
- New `backend/src/pipeline/crawlDiff.js` — DOM fingerprint diff engine
- `backend/src/database/migrations/` — `crawl_baselines` table
- `backend/src/routes/runs.js` — expose `changedPages` in run response

**Dependencies:** None

---

### AUTO-003 — Confidence scoring and auto-approval of low-risk tests 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** Every generated test requires manual approval (`reviewStatus: 'draft'`). For truly autonomous operation, the system should auto-approve tests above a confidence threshold. A quality score already exists in `deduplicator.js:226-272` but is never used for approval decisions.

**Fix:** Expose the quality score as `tests.confidenceScore`. Add a per-project `autoApproveThreshold` setting (default: disabled). On generation, auto-approve tests above the threshold. Log auto-approvals in the activity trail. Add a "review auto-approved tests" filter in the Tests page.

**Files to change:**
- `backend/src/pipeline/deduplicator.js` — expose quality score as `confidenceScore`
- `backend/src/pipeline/testPersistence.js` — auto-approve logic
- `backend/src/routes/projects.js` — `autoApproveThreshold` project setting
- `frontend/src/pages/Tests.jsx` — auto-approved filter badge

**Dependencies:** None

---

### AUTO-004 — Test impact analysis from git diff / deployment webhook 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive Gap Analysis

**Problem:** Given a git diff or deployment webhook payload, Sentri cannot determine which tests are affected. Mapping `test.sourceUrl` to application routes and correlating with changed files would enable truly intelligent CI/CD — "run only the tests affected by this PR" rather than "run everything on every push."

**Fix:** Accept an optional `changedFiles[]` array on the trigger endpoint. Map changed file paths to application routes using a configurable route-to-file map. Score each test by its `sourceUrl` against affected routes. Return `affectedTests[]` in the trigger response.

**Files to change:**
- `backend/src/routes/trigger.js` — accept `changedFiles` parameter
- New `backend/src/utils/impactAnalyzer.js` — route-to-file mapping and scoring
- `backend/.env.example` — document `ROUTE_MAP_PATH`

**Dependencies:** AUTO-002 (change detection provides the baseline for comparison)

---

### AUTO-005 — Automatic test retry with flake isolation 🟡 High

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** When a test fails, Sentri marks it failed immediately. An autonomous system should auto-retry failed tests (1–3 retries, configurable) before recording a true failure. The `retry()` function in `selfHealing.js` retries individual element lookups, but there is no test-level retry. This item implements test-level retry for all run types.

> **Note:** The 2-consecutive-failure detection referenced in DIF-009 (monitoring mode) uses this same retry infrastructure applied to monitoring jobs specifically. There is no duplication — DIF-009 orchestrates re-runs at the job level; AUTO-005 implements retry within a single test execution.

**Fix:** After a test fails, re-execute it up to `MAX_TEST_RETRIES` (default: 2) times before marking it failed. Record `retryCount` and `failedAfterRetry` on the result. Only notify and increment failure counts after all retries are exhausted.

**Files to change:**
- `backend/src/testRunner.js` — wrap per-test execution in retry loop
- `backend/src/database/migrations/` — add `retryCount`, `failedAfterRetry` to run results
- `backend/.env.example` — document `MAX_TEST_RETRIES`

**Dependencies:** None

---

### AUTO-006 — Network condition simulation (throttling, offline) 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** There is no ability to test under slow 3G, offline, or high-latency conditions. Playwright supports `page.route()` for network throttling and `context.setOffline()`. This is table stakes for mobile-first applications.

**Fix:** Add a `networkCondition` option to run config: `'fast'` (default), `'slow3g'`, `'offline'`. Implement via `page.route()` with configurable latency/throughput and `context.setOffline()`. Add a selector to `RunRegressionModal.jsx`.

**Files to change:**
- `backend/src/runner/executeTest.js` — apply network condition to browser context
- `frontend/src/components/run/RunRegressionModal.jsx` — network condition selector

**Dependencies:** None

---

### AUTO-007 — Geolocation / locale / timezone testing 🔵 Medium

**Status:** ✅ Complete | **Effort:** S | **Source:** Competitive Gap Analysis

**Problem:** `executeTest.js:195` sets `permissions: ["geolocation"]` but never sets an actual geolocation value, locale, or timezone. Playwright supports full geolocation, locale, and timezone context options. For international applications, locale-sensitive UI behaviour is essential to test.

**Fix:** Accept `geolocation`, `locale`, and `timezoneId` as optional run config parameters. Apply them when creating the browser context. Expose optional selectors in the run modal.

**Files to change:**
- `backend/src/runner/executeTest.js` — apply geolocation, locale, timezone to context
- `frontend/src/components/run/RunRegressionModal.jsx` — optional locale/timezone inputs

**Dependencies:** None

---

### AUTO-008 — Distributed runner across multiple machines 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** XL | **Source:** Competitive Gap Analysis

**Problem:** Current parallelism is 1–10 workers within a single Chromium process on one machine (`testRunner.js:48-67`). For large suites (500+ tests), execution must distribute across multiple machines. BullMQ (INF-003) enables the architectural foundation, but the distributed browser pool is a separate concern.

**Fix:** Extract the browser worker into a standalone, stateless container image. Use BullMQ's worker concurrency model across multiple worker containers. The HTTP server enqueues jobs; any available worker container picks them up. Expose worker count and queue depth on the dashboard.

**Files to change:**
- `backend/src/workers/runWorker.js` — make fully stateless and containerisable
- `docker-compose.yml` — add scalable `worker` service
- `frontend/src/pages/Dashboard.jsx` — worker pool status panel

**Dependencies:** INF-003 (BullMQ), INF-002 (Redis pub/sub for result delivery)

---

### AUTO-009 — Browser code coverage mapping 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive Gap Analysis

**Problem:** There is no way to know what percentage of application code is exercised by the test suite. Playwright supports V8 code coverage via `page.coverage.startJSCoverage()`. This would answer "what percentage of my app is actually tested?"

**Fix:** Optionally enable JS coverage collection per run via `page.coverage.startJSCoverage()` / `stopJSCoverage()`. Aggregate per-URL coverage into a project-level report. Surface on the dashboard as a "Code Coverage" metric alongside pass rate.

**Files to change:**
- `backend/src/runner/executeTest.js` — start/stop coverage collection
- New `backend/src/utils/coverageAggregator.js` — merge per-test coverage data
- `frontend/src/pages/Dashboard.jsx` — code coverage metric card

**Dependencies:** None

---

### AUTO-010 — Root cause analysis and failure clustering 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive Gap Analysis

**Problem:** When 15 tests fail, they often share a root cause (e.g., a login endpoint is down). Sentri reports each failure independently. An autonomous system should cluster failures by shared error pattern, common URL, or common failing selector and report "1 root cause → 15 affected tests." The `defectBreakdown` in `Dashboard.jsx:219-224` categorises by error type but does not cluster by shared cause.

**Fix:** After each run, group failures by shared error message fingerprint, shared `sourceUrl`, and shared failing step selector. Report the top-N clusters with a "likely root cause" label in a Root Cause Summary panel on the run detail page.

**Files to change:**
- New `backend/src/utils/failureClusterer.js` — clustering algorithm
- `backend/src/testRunner.js` — call clusterer on run completion
- `frontend/src/pages/RunDetail.jsx` — Root Cause Summary panel

**Dependencies:** None

---

### AUTO-011 — Historical trend analysis and anomaly detection 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** The dashboard shows a pass/fail trend but never detects anomalies. An autonomous system should alert: "Pass rate dropped 20% in the last 3 runs — likely regression introduced." The only statistical logic is a simple `trendDelta` at `Dashboard.jsx:122-126`.

**Fix:** Implement a lightweight anomaly detector (rolling mean + standard deviation). Alert when pass rate drops more than a configurable threshold (default 15%) versus the prior 5-run baseline. Surface as a warning banner on the dashboard and include in run completion notifications.

**Files to change:**
- New `backend/src/utils/anomalyDetector.js` — rolling baseline analysis
- `backend/src/routes/dashboard.js` — add `anomalyAlert` to dashboard response
- `frontend/src/pages/Dashboard.jsx` — anomaly alert banner

**Dependencies:** FEA-001 (notifications — to fire alerts on detected anomalies)

---

### AUTO-012 — SLA / quality gate enforcement 🟡 High

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** There is no ability to define "this project must maintain >95% pass rate" and block deployments when it drops. The CI/CD trigger endpoint returns pass/fail counts but requires the caller to implement gate logic. An autonomous platform should provide configurable quality gates per project with first-class CI/CD integration.

**Fix:** Add per-project `qualityGates` configuration: minimum pass rate, maximum flaky percentage, maximum failure count. On run completion, evaluate gates and include `{ passed: bool, violations: [] }` in both the trigger response and run result. GitHub Action exit code reflects gate status.

**Files to change:**
- `backend/src/routes/projects.js` — quality gate CRUD endpoints
- `backend/src/testRunner.js` — evaluate gates on run completion
- `backend/src/routes/trigger.js` — include gate result in response
- `frontend/src/pages/ProjectDetail.jsx` — quality gate configuration panel

**Dependencies:** None

---

### AUTO-013 — Stale test detection and cleanup 🔵 Medium

**Status:** ✅ Complete | **Effort:** S | **Source:** Competitive Gap Analysis

**Problem:** Tests that haven't been run in 90 days, or that target pages which no longer appear in the site map, accumulate silently. `lastRunAt` exists on tests but is never used for lifecycle management. Stale tests inflate test counts and degrade suite signal quality.

**Fix:** Add a weekly background job that identifies stale tests (not run in N days, or `sourceUrl` absent from the last crawl). Flag them with `isStale: true`. Show a "Stale Tests" filter in the Tests page. Allow bulk archive in a single action.

**Files to change:**
- `backend/src/scheduler.js` — add weekly stale test detection job
- `backend/src/database/migrations/` — add `isStale` to `tests`
- `frontend/src/pages/Tests.jsx` — stale tests filter and bulk archive action

**Dependencies:** None

---

### AUTO-014 — Test dependency and execution ordering 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** Some tests depend on others (login must pass before checkout can run). Sentri has no concept of test dependencies — tests run in arbitrary order within the parallel pool. A failed login test produces cascading failures with no indication that the root cause is an upstream dependency.

**Fix:** Add an optional `dependsOn: [testId]` field to tests. Before execution, topologically sort the test queue to respect dependencies. If a dependency fails, mark dependent tests as `skipped` rather than running them.

**Files to change:**
- `backend/src/database/migrations/` — add `dependsOn` array to `tests`
- `backend/src/testRunner.js` — topological sort and dependency-aware skip logic
- `frontend/src/pages/TestDetail.jsx` — dependency management UI

**Dependencies:** None

---

### AUTO-015 — Continuous test discovery on deployment events 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive Gap Analysis

**Problem:** Crawling is manually triggered. An autonomous system should watch for deployment events (via webhook) and automatically re-crawl changed pages, generate new tests for new features, and flag removed pages — without any human action.

**Fix:** Extend the CI/CD trigger endpoint to accept a `triggerCrawl: true` flag alongside `changedFiles[]`. When set, initiate a diff-aware crawl (AUTO-002) followed by test generation for changed pages only. Support Vercel and Netlify deployment webhook payloads natively.

**Files to change:**
- `backend/src/routes/trigger.js` — add `triggerCrawl` parameter and deployment event handlers
- `backend/src/crawler.js` — accept target URLs from change diff
- `frontend/src/components/automation/IntegrationSnippets.jsx` — add Vercel and Netlify snippets

**Dependencies:** AUTO-002 (diff-aware crawling), INF-003 (BullMQ for durable crawl jobs)

---

### AUTO-016 — Accessibility testing (axe-core integration) 🟡 High

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** No accessibility testing exists. Playwright has first-class support for `@axe-core/playwright`. An autonomous QA platform should run WCAG 2.1 checks on every crawled page and flag violations. This is increasingly a legal requirement (ADA, European Accessibility Act).

**Fix:** During crawl, inject `@axe-core/playwright` and run `checkA11y()` on each page. Store violations in a new `accessibility_violations` table. Surface a per-page accessibility report in the crawl results view and on the dashboard.

**Files to change:**
- `backend/src/pipeline/crawlBrowser.js` — inject axe-core checks
- `backend/src/database/migrations/` — `accessibility_violations` table
- `frontend/src/components/crawl/CrawlView.jsx` — accessibility violation panel
- `backend/package.json` — add `@axe-core/playwright`

**Dependencies:** None

---

### AUTO-017 — Performance budget testing (Web Vitals) 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** There is no performance testing. Playwright can capture Web Vitals (LCP, CLS, FID/INP) via `page.evaluate()`. Teams have no way to set performance budgets per page or know when a deployment degrades load times.

**Fix:** After navigation in test execution, capture Web Vitals. Compare against per-project budgets stored in a `performance_budgets` table. Mark results as `PERFORMANCE_FAIL` when budgets are exceeded. Surface on the dashboard as a "Performance" tab.

**Files to change:**
- `backend/src/runner/executeTest.js` — capture Web Vitals after navigation
- `backend/src/database/migrations/` — `performance_budgets` table
- `frontend/src/pages/Dashboard.jsx` — performance metrics tab

**Dependencies:** None

---

### AUTO-018 — Plugin and extension system 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** XL | **Source:** Competitive Gap Analysis

**Problem:** There is no way to extend Sentri without forking the repository. An autonomous platform should expose hooks for custom assertions, custom healing strategies, custom report formats, and custom notification channels. All integration points are currently hardcoded.

**Fix:** Define a plugin interface: `beforeRun`, `afterStep`, `onFailure`, `onHealAttempt`, `onRunComplete`. Load plugins from a configurable `PLUGINS_DIR`. Ship three first-party plugins as reference implementations: custom Teams notification formatter, custom assertion library, custom HTML report.

**Files to change:**
- New `backend/src/plugins/pluginLoader.js` — discover and register plugins
- `backend/src/testRunner.js` — emit plugin lifecycle hooks
- `backend/src/selfHealing.js` — expose `onHealAttempt` hook
- `backend/.env.example` — document `PLUGINS_DIR`

**Dependencies:** All Phase 3 items (plugin system should wrap stable APIs, not moving targets)

---

### AUTO-019 — Run diffing: per-test comparison across runs 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** There is no ability to compare two runs side-by-side: "Run 42 had 3 new failures vs Run 41." The dashboard shows pass rate trends but not per-test deltas between specific runs. Engineers investigating regressions must manually compare two run detail pages.

**Fix:** Add `GET /api/runs/diff?runA=<id>&runB=<id>` returning per-test status delta: `newFailures`, `newPasses`, `unchanged`. Add a "Compare runs" button to the Runs list page that renders the diff in a two-column view.

**Files to change:**
- `backend/src/routes/runs.js` — `GET /runs/diff` endpoint
- `frontend/src/pages/Runs.jsx` — run selection checkboxes and "Compare" button
- New `frontend/src/pages/RunDiff.jsx` — diff view page

**Dependencies:** None

---

### AUTO-020 — Deployment platform integrations (Vercel, Netlify) 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** The CI/CD trigger endpoint is generic, but there are no native integrations with deployment platforms. An autonomous system should trigger tests automatically when a Vercel or Netlify deployment completes, using the preview URL as the test target.

**Fix:** Add dedicated webhook handlers for Vercel (`X-Vercel-Signature`) and Netlify (`X-Netlify-Token`) deploy events. Extract the preview URL from the payload and use it as the run's base URL override. Show a "Last deployment run" badge on the project header.

**Files to change:**
- `backend/src/routes/trigger.js` — Vercel and Netlify webhook handlers with signature verification
- `frontend/src/components/automation/IntegrationCards.jsx` — Vercel and Netlify integration cards
- `backend/.env.example` — document `VERCEL_WEBHOOK_SECRET`, `NETLIFY_WEBHOOK_SECRET`

**Dependencies:** DIF-009 (monitoring mode) or INF-003 (BullMQ) for durable run enqueuing on deploy

---

### AUTO-021 — AI-generated test suite health insights 🔵 Medium

**Status:** 🔲 Planned | **Effort:** S | **Source:** Competitive (BearQ)

**Problem:** The dashboard shows pass rate, MTTR, and defect breakdown, but never explains *why* metrics changed. BearQ positions AI-driven analytics as a differentiator. AUTO-011 (anomaly detection) detects statistical drops but doesn't provide actionable explanations. The existing `feedbackLoop.js:buildQualityAnalytics()` produces rule-based `insights[]` strings (e.g., "N tests failed on URL assertions"), but these are static templates — not AI-generated contextual analysis.

**Fix:** After each run, feed the quality analytics summary (failure categories, flaky tests, healing events, pass rate delta) to the LLM and generate a 3–5 sentence natural-language insight: "Pass rate dropped 12% — 8 of 10 failures share the same login timeout. The auth endpoint may be degraded. Consider checking `/api/auth/login` response times." Surface as an "AI Insights" card on the dashboard and include in run completion notifications.

**Files to change:**
- `backend/src/routes/dashboard.js` — generate and cache AI insight on run completion
- `frontend/src/pages/Dashboard.jsx` — AI Insights card
- `backend/src/testRunner.js` — trigger insight generation after `applyFeedbackLoop()`

**Dependencies:** FEA-001 (notifications — to include insights in failure alerts)

---

### AUTO-022 — Data-driven test parameterisation 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive (BearQ, Mabl)

**Problem:** There is no way to run the same test with multiple input data sets. Testing login with 10 different user/password combinations, or a search with 20 different queries, requires creating 10 or 20 separate tests. BearQ and Mabl both support data-driven parameterisation natively. MNT-004 (fixtures) covers setup/teardown but not repeated execution with varying inputs.

**Fix:** Add an optional `testData: [{ key: value, … }, …]` array on tests. When present, `testRunner.js` executes the test once per data row, injecting the row's values as variables accessible via `testData.key` in the Playwright code. Report per-row pass/fail in the run results. Add a "Test Data" tab in `TestDetail.jsx` for managing rows.

**Files to change:**
- `backend/src/testRunner.js` — iterate over `testData` rows per test
- `backend/src/runner/codeExecutor.js` — inject `testData` variables into execution context
- `backend/src/database/migrations/` — add `testData` JSON column to `tests`
- `frontend/src/pages/TestDetail.jsx` — Test Data tab with row editor
- `frontend/src/pages/RunDetail.jsx` — per-row result breakdown

**Dependencies:** None
**See also:** MNT-004 (fixtures) — fixtures handle environment setup/teardown; parameterisation handles input variation. They are complementary.

---

## Ongoing Maintenance & Platform Health

*These items are not phase-bounded. Address them incrementally alongside feature work, prioritising MNT-006 (object storage) before any cloud deployment.*

---

### MNT-001 — Vision-based locator healing 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** XL | **Source:** Competitive

**Problem:** The self-healing waterfall uses DOM selectors exclusively (ARIA roles, text content, CSS fallbacks). When the DOM structure changes drastically — a major redesign or component library migration — all strategies can fail simultaneously. Mabl uses screenshot diff + CV-based element finding to heal across structural changes.

**Fix:** Add a vision-based healing strategy as the final fallback in the waterfall. Capture a screenshot of the failing step's expected element area from the baseline, use image similarity (`pixelmatch`) to locate the nearest visual match in the current DOM, and derive a fresh selector from the matched element.

**Files to change:**
- `backend/src/selfHealing.js` — add vision strategy as waterfall stage 7
- `backend/src/runner/executeTest.js` — pass baseline screenshot to healing context

**See also:** MNT-002 — both items extend `selfHealing.js`. MNT-001 handles visual/structural DOM changes (new strategy); MNT-002 handles statistical strategy ordering (ML classifier). They are complementary but fully independent implementations. Coordinate branch timing to avoid merge conflicts.

---

### MNT-002 — Self-healing ML classifier 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** XL | **Source:** Audit

**Problem:** The healing waterfall is deterministic and rule-based. `STRATEGY_VERSION` invalidates all cached hints when strategies change. Healing history data in `healing_history` is collected but never fed back to improve the system. A lightweight classifier trained on healing events would predict the best strategy per element type, reducing waterfall traversal depth.

**Fix:** Train an offline classifier on `healing_history` events using feature vectors (element type, page URL pattern, last successful strategy, DOM depth). Export the model as a JSON lookup table. Load it at startup. Use it to reorder the waterfall per element rather than always starting at strategy 1.

**Files to change:**
- `backend/src/selfHealing.js` — accept strategy ordering hint from classifier
- New `backend/src/ml/healingClassifier.js` — model loader and inference
- New `scripts/train-healing-model.js` — offline training script from `healing_history` data

**See also:** MNT-001 — both items extend `selfHealing.js`. MNT-002 handles statistical strategy selection; MNT-001 handles visual DOM changes. They are complementary and can be developed independently on separate branches.

---

### MNT-003 — Prompt A/B testing framework 🔵 Medium

**Status:** 🔲 Planned | **Effort:** L | **Source:** Audit

**Problem:** `promptVersion` is stored on tests but there is no system to compare prompt versions, run controlled experiments, or automatically promote better prompts. AI quality improvements are made by intuition rather than measurement.

**Fix:** Add a `promptExperiments` table. Tag each generation with the active experiment and variant. Compute quality metrics (validation pass rate, healing rate, approval rate) per variant. Add an Experiments view in Settings to review results and promote a winning variant.

**Files to change:**
- `backend/src/pipeline/journeyGenerator.js` — tag generation with experiment variant
- New `backend/src/pipeline/promptEval.js` — metric computation per variant
- `frontend/src/pages/Settings.jsx` — Experiments tab

---

### MNT-004 — Test data management (fixtures and factories) 🔵 Medium

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive

**Problem:** Tests that require specific data states (a logged-in user with specific records, a product at a specific price) have no supported setup/teardown mechanism. This limits the depth of user journeys Sentri can test autonomously.

**Fix:** Add a `fixtures` block to test config: a list of API calls or SQL statements to execute before the test and teardown statements to run after. Expose `beforeTest` / `afterTest` hooks in `executeTest.js`.

**Files to change:**
- New `backend/src/utils/testDataFactory.js` — fixture execution engine
- `backend/src/runner/executeTest.js` — call `beforeTest`/`afterTest` hooks
- `backend/src/pipeline/stateExplorer.js` — declare required state for generated tests

---

### MNT-005 — BDD / Gherkin export format 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive

**Problem:** Enterprise teams using behaviour-driven development (Cucumber, SpecFlow) cannot use Sentri's output directly. SmartBear's BDD format is widely adopted in enterprise QA. Adding a Gherkin export alongside the existing Zephyr/TestRail CSV exports would broaden enterprise appeal.

**Fix:** Add `buildGherkinFeature(test)` to `exportFormats.js`. Map test steps to `Given` / `When` / `Then` blocks using the step intent classifier data already produced by the pipeline. Add a "Export as Gherkin" option to the Tests page export menu.

**Files to change:**
- `backend/src/utils/exportFormats.js` — add Gherkin builder
- `backend/src/routes/tests.js` — `GET /projects/:id/export/gherkin`
- `frontend/src/pages/Tests.jsx` — Gherkin export option

**See also:** DIF-006 (Playwright export) — both extend `exportFormats.js`. Develop in the same or consecutive sprints to share export ZIP packaging scaffolding.

---

### MNT-006 — Object storage for artifacts (S3 / R2) 🟡 High

**Status:** 🔲 Planned | **Effort:** M | **Source:** Audit (M-03)

**Problem:** Screenshots, videos, and Playwright traces are stored on local disk (`data/screenshots/`, `data/videos/`). In a Docker or multi-instance deployment, these are lost on container restart and cannot be shared across instances. This is acknowledged in the README production checklist.

**Fix:** Add an `objectStorage` abstraction with a local-disk adapter (current behaviour) and an S3/R2 adapter (using `@aws-sdk/client-s3`). Switch based on `STORAGE_BACKEND=s3`. Update all artifact read/write paths. Update `signArtifactUrl()` to produce pre-signed S3 URLs when using the S3 backend.

**Files to change:**
- `backend/src/runner/pageCapture.js` — use storage abstraction
- `backend/src/runner/screencast.js` — use storage abstraction
- New `backend/src/utils/objectStorage.js` — local + S3/R2 adapter
- `backend/.env.example` — document `STORAGE_BACKEND`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY`

---

### MNT-007 — ARIA live regions for real-time updates 🔵 Medium

**Status:** ✅ Complete | **Effort:** S | **Source:** Quality Review (UX-06, UX-07)

**Problem:** SSE-driven log streams, run status changes, and toast notifications update the DOM without announcing changes to screen readers. `ProviderBanner` already implements `role="alert"` and `aria-live="polite"` correctly — this pattern must be extended to the run log panel, run status badge, and modal components which currently lack it.

**Fix:** Add `aria-live="polite"` to the log stream container in `TestRunView.jsx`. Add `role="alert"` to error/success toast banners where missing. Add `aria-live="assertive"` to the abort confirmation. Ensure focus is restored to the trigger element after modal close.

**Files to change:**
- `frontend/src/components/run/TestRunView.jsx` — `aria-live` on log panel
- All modal components — restore focus on close
- Toast banner components — `role="alert"` where missing

---

### MNT-009 — Tiered prompt system for local models (Ollama) 🔴 Blocker

**Status:** ✅ Complete | **Effort:** M | **Source:** PR #99 testing — Ollama generates 0 valid tests

**Problem:** Since deep validation was added (MAINT-012 / PR #57), Ollama-generated tests are rejected at near-100% rate. The `SELF_HEALING_PROMPT_RULES` in `selfHealing.js` is ~170 lines / ~4K tokens. When embedded in the system prompt, the total exceeds 7B model context windows (~4K-8K effective tokens). The model produces hallucinated selectors, wrong function signatures, missing `await`, and syntax errors — all caught by the validator. Cloud models (Gemini, Claude, GPT-4o) handle the full prompt fine; only local models are affected.

**Evidence:** RUN-7 on google.com with Ollama: 11 raw tests → 3 deduped → 8 rejected by validation → 0 saved.

**Fix:** Split `SELF_HEALING_PROMPT_RULES` into `CORE_RULES` (~200 tokens, 6 essential helpers with correct signatures) and `EXTENDED_RULES` (~3800 tokens, exhaustive forbidden list). Create a `promptTiers.js` module with `cloud` and `local` tier configs. `getPromptRules(tier)` returns compact rules for local, full rules for cloud. All 4 prompt consumers (`outputSchema.js`, `testFix.js`, `feedbackLoop.js`, `tests.js`) use the tier-aware getter.

**Files to change:**
- New `backend/src/pipeline/prompts/promptTiers.js` — tier definitions + `getTier()`
- `backend/src/selfHealing.js` — split rules into `CORE_RULES` + `EXTENDED_RULES`, export `getPromptRules(tier)`
- `backend/src/pipeline/prompts/outputSchema.js` — use `getPromptRules(getTier())`
- `backend/src/routes/testFix.js` — use `getPromptRules(getTier())`
- `backend/src/pipeline/feedbackLoop.js` — use `getPromptRules(getTier())`, limit elements to `tier.maxElements`
- `backend/tests/self-healing.test.js` — test both rule tiers

**Acceptance criteria:**
- Ollama (mistral:7b) generates ≥1 valid test from a crawl of google.com
- Cloud providers still get the full exhaustive rules
- Local system prompt total < 2000 tokens
- Existing tests pass

**Dependencies:** None

---

### MNT-010 — Re-run button on Run Detail page for crawl/generate runs 🔵 Medium

**Status:** ✅ Complete | **Effort:** S | **Source:** PR #99 UX review

**Problem:** The Run Detail page has no "Re-run" or "Retry" button for crawl and generate runs. When a crawl fails, is interrupted, or produces 0 tests (e.g. rate limit, Ollama quality), the user must navigate back to the Tests page and re-trigger manually. The re-run button only exists for `test_run` type runs in `TestRunView.jsx:638-661`.

**Fix:** Add a "Re-run" button to `RunDetail.jsx` for crawl and generate runs (alongside the existing "Refresh" and "Stop Task" buttons). For crawl runs, call `api.crawl(projectId)`. For generate runs, call `api.generateTest(projectId, { name, description })` using `run.generateInput`. Show the button when the run is in a terminal state (`completed`, `completed_empty`, `failed`, `interrupted`, `aborted`).

**Files to change:**
- `frontend/src/pages/RunDetail.jsx` — add re-run button with type-aware API call

**Dependencies:** None

---

### MNT-011 — Persist crawl/generate dialsConfig on run record 🔵 Medium

**Status:** ✅ Complete | **Effort:** S | **Source:** PR #100 Devin review

**Resolution:** Verified during PR #107 review that the fix is already in main. MNT-010 (PR #100) shipped only the bare re-run button — the dialsConfig wiring was added later in an untracked commit (no changelog entry, no roadmap update). Current code achieves the same behaviour the original fix proposed without needing the new `dialsConfig` column: the run-create handlers store the validated dials inside the existing `generateInput` JSON column, and `handleRerun` reads them from there.

**Verified at:**
- `backend/src/routes/runs.js:79` — crawl run persists `generateInput: { dialsConfig: validatedDials }`
- `backend/src/routes/tests.js:441` — generate run persists `generateInput: { name, description, dialsConfig: validatedGenDials }`
- `frontend/src/pages/RunDetail.jsx:183` — re-run reads `input.dialsConfig` for crawl
- `frontend/src/pages/RunDetail.jsx:198` — re-run reads `input.dialsConfig` for generate

**Dependencies:** MNT-010 ✅

---

### MNT-008 — ESLint + Prettier enforcement in CI 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Quality Review (PRD-04)

**Problem:** The codebase has no linting or formatting enforcement. Code style varies across files. New contributors receive no automated style feedback, increasing review friction and producing noisy diffs.

**Fix:** Add ESLint (flat config) with `@eslint/js` recommended + `eslint-plugin-react`. Add Prettier with a `.prettierrc` matching the existing dominant code style. Add `npm run lint` to the CI pipeline. Apply auto-fix formatting as a single dedicated commit.

**Files to change:**
- `backend/eslint.config.js`, `frontend/eslint.config.js` — ESLint configurations
- `.prettierrc` — Prettier config
- `.github/workflows/ci.yml` — add lint step
- `backend/package.json`, `frontend/package.json` — add dev dependencies

---

## Competitive Gap Analysis

> **Note:** The SmartBear column reflects both their legacy portfolio (TestComplete, ReadyAPI)
> and the new **BearQ** AI-native platform (early access — https://smartbear.com/product/bearq/early-access/).
> BearQ significantly changes SmartBear's competitive position; capabilities marked with † are BearQ-specific.

| Capability | Sentri | Mabl | Testim | SmartBear / BearQ | Playwright OSS |
|---|---|---|---|---|---|
| AI test generation | ✅ 8-stage pipeline | ✅ Auto-heal only | ✅ AI recorder | ✅ BearQ AI generation † | ❌ Manual |
| Interactive recorder | ❌ → DIF-015 | ✅ | ✅ | ✅ BearQ recorder † | Via codegen |
| Self-healing selectors | ✅ Multi-strategy waterfall | ✅ ML-based | ✅ Smart locators | ✅ BearQ AI healing † | ❌ |
| AI auto-repair on failure | ✅ Feedback loop | ✅ | ✅ | ✅ BearQ † | ❌ |
| Human review queue | ✅ Draft → Approve flow | ❌ | ❌ | ❌ | ❌ |
| NL test editing | ✅ AI chat + fix | ❌ | ❌ | ✅ BearQ NL input † | ❌ |
| API test generation | ✅ HAR-based auto-gen | ✅ | ❌ | ✅ ReadyAPI | ✅ Manual |
| Scheduled runs | ✅ Cron + timezone | ✅ | ✅ | ✅ | Via CI cron |
| CI/CD integration | ✅ Webhook + token auth | ✅ Native | ✅ Native | ✅ Native | ✅ CLI |
| Self-hosted / private | ✅ Docker | ❌ SaaS only | ❌ SaaS only | Partial | ✅ |
| Multi-provider LLM | ✅ Anthropic/OpenAI/Google/Ollama | ❌ | ❌ | ❌ | ❌ |
| Parallel execution | ✅ 1–10 workers | ✅ Cloud | ✅ Cloud | ✅ Cloud | ✅ CLI sharding |
| Visual regression | ❌ → DIF-001 | ✅ Native | ✅ Native | ✅ VisualTest | Via plugins |
| Cross-browser | ✅ DIF-002 | ✅ Chrome+Firefox | ✅ Chrome+Firefox | ✅ All | ✅ All 3 |
| Mobile / device emulation | ✅ DIF-003 | ✅ | ✅ | ✅ | ✅ Native |
| Failure notifications | ✅ Teams/email/webhook | ✅ Slack/email | ✅ Slack/email | ✅ | N/A |
| Multi-tenancy / RBAC | ✅ ACL-001/ACL-002 | ✅ | ✅ | ✅ | N/A |
| Standalone export | ❌ → DIF-006 | ❌ Lock-in | ❌ Lock-in | ❌ Lock-in | N/A |
| Flaky test detection | ✅ DIF-004 | ✅ | ✅ | ✅ | ❌ |
| Risk-based test selection | ❌ → AUTO-001 | ✅ | Partial | ✅ BearQ smart selection † | ❌ |
| Accessibility testing | ❌ → AUTO-016 | ✅ | ❌ | Partial | Via plugins |
| Performance budgets | ❌ → AUTO-017 | ❌ | ❌ | Via Lighthouse | ❌ |
| Quality gate enforcement | ❌ → AUTO-012 | ✅ | ✅ | ✅ | Via Playwright |

**Sentri's unique strengths:** Self-hosted + AI generation + human review queue + multi-provider LLM + standalone export (planned). No competitor offers all five together. BearQ narrows the AI generation gap but remains SaaS-only with no self-hosted option or LLM provider choice.

**Critical gaps to close first:** DIF-001 (visual regression) · DIF-002 (cross-browser) · DIF-015 (recorder)

---

## Summary

| Category | Total | ✅ Done | 🔄 In Progress | 🔲 Pending | Remaining |
|----------|------:|--------:|---------------:|----------:|-----------|
| Security & Compliance | 5 | 3 | 0 | 2 | SEC-004, SEC-005 |
| Infrastructure | 6 | 5 | 0 | 1 | INF-006 |
| Access Control | 2 | 2 | 0 | 0 | — |
| Platform Features | 4 | 3 | 0 | 1 | ENH-036 |
| Differentiators | 20 | 9 | 0 | 11 | DIF-002c, 005, 006, 007, 008, 009, 010, 012, 013, 015b, 015c |
| Autonomous Intelligence | 22 | 2 | 0 | 20 | AUTO-001–006, 008–012, 014–022 |
| Maintenance | 11 | 4 | 0 | 7 | MNT-001–006, 008 |
| **Totals** | **70** | **28** | **0** | **42** | |

**Total tracked items:** 70 across 7 categories — **28 complete** (40%), **0 in progress**, **42 remaining**

**Blockers (must ship before team deployment):**
~~SEC-001 (email verification)~~ ✅ · ~~INF-001 (PostgreSQL)~~ ✅ · ~~INF-002 (Redis)~~ ✅ · ~~ACL-001 (multi-tenancy)~~ ✅ · ~~ACL-002 (RBAC)~~ ✅

**All blockers resolved.** ✅

**Recommended PR order (next):**
`DIF-006` (Playwright export — biggest lock-in objection handler) → `AUTO-005` (test retry with flake isolation — complements DIF-004 flaky detection) → `AUTO-016` (accessibility via axe-core) → `MNT-006` (S3 object storage — production prerequisite)

**Lowest effort / highest immediate value:**
~~MNT-011 (S)~~ ✅ · ~~AUTO-007 (S)~~ ✅ · DIF-006 (M) · AUTO-005 (M) · DIF-013 (S — telemetry)

---

## Contributing

Before starting any item:

1. Open a GitHub Issue referencing the item ID (e.g., `SEC-001`, `DIF-006`)
2. Assign yourself and add to the current sprint milestone
3. Create a branch named `feat/SEC-001-email-verification` or `fix/INF-002-redis-sse`
4. Reference the issue in your PR description
5. Update the item's **Status** in this file (`🔲 Planned` → `🔄 In Progress` → `✅ Complete`) in the same PR
6. Add an entry to `docs/changelog.md` under `## [Unreleased]` following the Keep a Changelog format

For items with explicit **See also** cross-references (MNT-001/MNT-002, DIF-006/MNT-005), coordinate branch timing in sprint planning to avoid merge conflicts on shared files (`selfHealing.js`, `exportFormats.js`).