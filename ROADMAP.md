# Sentri — Engineering Roadmap

> **Based on:** Full System Audit — April 2026 · `sentri_v2_2`
> **Stack:** Node.js (ESM) · Express · SQLite → PostgreSQL · Playwright · React 18 · Vite
>
> This document translates the platform audit into a trackable sprint plan. All known security risks, reliability gaps, feature gaps, and competitive improvements are captured here with enough detail to start work immediately.

---

## How to use this document

- Items are grouped into **Phases** by priority and dependency order.
- The **Effort** field is sized for a 2-engineer team: `XS` < 1 day, `S` 1–2 days, `M` 3–5 days, `L` 1–2 weeks, `XL` 2–4 weeks.
- The **Source** field cites where the finding came from: `Audit` (internal codebase review), `Competitive` (gap vs. Mabl/Testim/SmartBear/Playwright ecosystem).
- Items marked `🔴 Blocker` must be resolved before any production or team deployment.
- Items marked `🟡 High` should ship within the next two sprints.
- Items marked `🔵 Medium` improve quality and coverage.
- Items marked `🟢 Differentiator` build competitive moat and can be scheduled freely.

---

## Phase Summary

| Phase | Scope | Key Deliverable | Est. Duration |
|-------|-------|-----------------|---------------|
| ~~Phase 0 — Sprint 3 items~~ | Shadow DOM, DOM stability wait, Disposable email | Test quality & coverage | ✅ Complete |
| Phase 1 — Production Hardening | Security, reliability, data integrity | Safe for real team use | 4–5 weeks |
| Phase 2 — Team & Enterprise Foundation | Multi-tenancy, RBAC, CI/CD, queues | Sellable to companies | 8–10 weeks |
| Phase 3 — AI-Native Differentiation | Visual regression, cross-browser, ML healing | Competitive with Mabl/Testim | 10–12 weeks |

---

## Phase 1 — Production Hardening (Weeks 1–6)

*Goal: Make Sentri safe, stable, and scalable enough for real team use (5–20 users, 3–10 projects). These items address active security risks and known failure modes — none are optional.*

---

### ~~ENH-005 — Global API rate limiting~~ ✅ Complete

**Problem:** Only auth routes (`/login`, `/forgot-password`, `/reset-password`) have rate limiting. Every other route — crawl trigger, run execution, AI test generation, bulk actions — is completely unprotected. An authenticated user with a valid session can trigger 100 simultaneous crawls (exhausting AI quota and all available memory) or spam test generation to produce thousands of AI calls at cost.

**Fix:** Apply `express-rate-limit` globally to all `/api/*` routes with separate tighter buckets for expensive operations:
- Global: 300 req / 15 min per IP
- `POST /api/projects/:id/crawl` → 5 per user per hour
- `POST /api/projects/:id/run` → 20 per user per hour
- `POST /api/*/tests/generate` → 30 per user per hour

Use a Redis store (`rate-limit-redis`) for distributed enforcement once Redis is added (ENH-002). Fall back to memory store until then.

**Files to change:**
- `backend/src/middleware/appSetup.js` — add global and per-route limiters

**Effort:** S | **Source:** Audit

---

### ~~ENH-007 — Authenticate artifact serving with signed URL tokens~~ ✅ Complete

**Problem:** Screenshots, videos, and Playwright traces are served from `/artifacts/` as public static files with no auth check. The comment in `appSetup.js` acknowledges this explicitly. Any person who guesses or obtains an artifact URL can view screenshots and videos of your users' applications — only URL obscurity protects them.

**Fix:** Generate short-lived HMAC-signed tokens for all artifact URLs. Validate the token on the static file middleware before serving. `<img>` and `<video>` tags cannot send `Authorization` headers, so query-param token signing is the correct pattern here.

Token format: `?token=<hmac-sha256(artifactPath+exp, ARTIFACT_SECRET)>&exp=<unix-ms>`

**Implemented in:** PR #79
- `backend/src/middleware/appSetup.js` — `signArtifactUrl()`, `isValidArtifactToken()`, token-validation middleware before `express.static`, `Cache-Control: private, no-store`
- `backend/src/runner/executeTest.js`, `backend/src/runner/pageCapture.js`, `backend/src/testRunner.js` — all artifact paths wrapped with `signArtifactUrl()`
- `backend/.env.example` — documents `ARTIFACT_SECRET` and `ARTIFACT_TOKEN_TTL_MS`

**Effort:** M | **Source:** Audit

---

### ~~ENH-013 — Persist password reset tokens in the database~~ ✅ Complete

**Problem:** `passwordResetTokens` in `auth.js` is stored in a process-local `Map`. Tokens are lost on every server restart. In any multi-instance deployment, a reset link generated on instance A will fail verification on instance B. This is a silent, hard-to-diagnose bug.

**Fix:** Move to a `password_reset_tokens(token, userId, expiresAt, usedAt)` table. Replace all Map operations with SQL INSERT / SELECT / UPDATE. Add a cleanup job (or `WHERE expiresAt < NOW()` filter) to prune expired tokens.

**Files to change:**
- `backend/src/database/migrations/` — add `003_password_reset_tokens.sql`
- `backend/src/routes/auth.js` — replace Map operations with DB calls
- New `backend/src/database/repositories/passwordResetRepo.js`

**Effort:** S | **Source:** Audit

---

### ~~ENH-027 — Add global React Error Boundary~~ ✅ Complete

**Problem:** There is no `ErrorBoundary` component wrapping routes. A single React rendering error anywhere in the component tree will crash the entire application and show a blank white screen with no recovery path.

**Fix:** Implement a standard React class component with `componentDidCatch` and `getDerivedStateFromError`. Wrap the router in `App.jsx`. Show a friendly error message with "Try again", "Reload page", and "Go to Dashboard" buttons. Report crashes to `/api/system/client-error`.

**Implemented in:** PR #79
- New `frontend/src/components/layout/ErrorBoundary.jsx` — extracted from inline class in `App.jsx`; adds `componentDidCatch` with server-side crash reporting and soft-reset "Try again" button
- `frontend/src/App.jsx` — imports `ErrorBoundary` from the new component

**Effort:** XS | **Source:** Audit

---

### ~~ENH-030 — Secrets scanning in CI pipeline~~ ✅ Complete

**Problem:** The CI workflow (`ci.yml`) does not run secrets scanning. AI API keys, JWT secrets, or OAuth credentials accidentally committed to the repository will not be detected. Given that the codebase stores `CREDENTIAL_SECRET`, `JWT_SECRET`, and `LLM_API_KEY` values, this is an active risk.

**Fix:** Add `gitleaks/gitleaks-action@v2` as a CI step. Run on every PR and push to `main`. Configure `gitleaks.toml` with allowed patterns for test fixtures and generated `.env.example` values.

**Implemented in:** PR #79
- `.github/workflows/ci.yml` — new `secrets` job running `gitleaks/gitleaks-action@v2`; `lint` and `build` jobs now `needs: [secrets]`, gating the entire pipeline
- New `.github/.gitleaks.toml` — extends default ruleset with allowlists for CI placeholder keys (`sk-ant-placeholder-for-ci`) and `.env.example` files

**Effort:** XS | **Source:** Audit

---

### ~~ENH-021 — Add `userId` to activities for full audit trail~~ ✅ Complete

**Problem:** The `activities` table has no `userId` column. It is impossible to know who performed which action — who deleted a test, who approved a run, who triggered a crawl. This is a compliance requirement for any enterprise customer and a basic operational need for team accountability.

**Fix:** Migration adds `userId TEXT` and `userName TEXT` columns to `activities`. Update `logActivity()` to accept and store `userId` and `userName`. Pass `req.user.id` and `req.user.email` from all route handlers that call `logActivity`.

**Files to change:**
- `backend/src/database/migrations/` — alter `activities` table
- `backend/src/utils/activityLogger.js` — add `userId`, `userName` params
- All route files that call `logActivity` — pass `req.user`

**Effort:** S | **Source:** Audit

---

### ~~ENH-020 — Soft-delete for tests, projects, and runs~~ ✅ Complete

**Problem:** `DELETE /api/data/runs` and all entity deletion endpoints permanently and irreversibly destroy data. There is no `deletedAt` timestamp, no recycle bin, and no recovery path. In a professional QA context, accidental deletion of a test suite or run history is a major UX and trust risk. The `DELETE /api/data/runs` endpoint in particular wipes ALL run history with no confirmation.

**Fix:** Add `deletedAt TEXT` to all entity tables via migration. All `SELECT` queries gain `WHERE deletedAt IS NULL`. DELETE handlers set `deletedAt = datetime('now')` instead of removing the row. Add `GET /api/recycle-bin` and `POST /api/restore/:type/:id` routes. Add a Recycle Bin page in Settings.

**Files to change:**
- `backend/src/database/migrations/` — add `deletedAt` to `tests`, `projects`, `runs`
- All repo files — update queries with soft-delete filter
- All route DELETE handlers — convert to soft-delete
- `frontend/src/pages/Settings.jsx` — add Recycle Bin tab

**Effort:** M | **Source:** Audit

---

### ~~ENH-010 — Pagination on all list API endpoints~~ ✅ Complete

**Problem:** `GET /api/tests`, `GET /api/runs`, `GET /api/projects`, and `GET /api/activities` return every record in the database with no `LIMIT`. A project with 1,000 tests will produce a response exceeding 5 MB, cause multi-second parse times in the browser, and will crash slower clients. All frontend filtering is done client-side using `useMemo` on the full dataset — this is a known failure mode, not a hypothetical.

**Fix:** Add `?page=<n>&pageSize=<n>` query params to all list endpoints. Return `{ data: [], meta: { total, page, pageSize, hasMore } }`. Update frontend list components to handle paginated responses with a "Load more" or page control.

**Files to change:**
- All route GET handlers for list endpoints
- All repo files — add `LIMIT`/`OFFSET` SQL params
- `frontend/src/pages/Tests.jsx`, `frontend/src/pages/Runs.jsx`, `frontend/src/pages/Dashboard.jsx` — update to handle paginated responses

**Effort:** M | **Source:** Audit

---

### ~~ENH-008 — Move `runs.logs` to a separate `run_logs` table~~ ✅ Complete

**Problem:** Every call to `log(run, message)` in `runLogger.js` deserialises the entire `logs` JSON column, appends one entry, and re-serialises it. A crawl generating 200 log lines performs 200 read-modify-write cycles on a column that grows from 0 to ~20 KB. This is O(n²) in log volume. The `results`, `testQueue`, and `videoSegments` columns share the same pattern.

**Fix:** Create a `run_logs(id, runId, seq, level, message, createdAt)` table. Update `log()`, `logWarn()`, `logSuccess()` to `INSERT` individual rows. SSE streaming reads from `run_logs` ordered by `seq`. The `runs` table retains only summary columns.

**Implemented in:** PR #86
- `backend/src/database/migrations/002_run_logs_table.sql` — new `run_logs` table with indexes on `runId` and `(runId, seq)`
- `backend/src/database/repositories/runLogRepo.js` — append-only data-access layer with in-process seq counter cache
- `backend/src/utils/runLogger.js` — each `log()`/`logWarn()`/`logError()` now does a single INSERT via `runLogRepo.appendLog()`
- `backend/src/database/repositories/runRepo.js` — `logs` removed from JSON_FIELDS; `getById()` hydrates from `run_logs`; purge paths cascade into `run_logs`
- `backend/src/routes/sse.js` — SSE snapshot hydrates logs from `run_logs`

**Effort:** M | **Source:** Audit

---

### ~~ENH-004 — Persist AI provider keys encrypted in the database~~ ✅ Complete

**Problem:** AI API keys set via the Settings page are stored only in a process-level `runtimeKeys` object in `aiProvider.js`. They are lost on every server restart. Users must re-enter their API keys after every deployment — this is not acceptable for a production tool.

**Fix:** Create an `api_keys(provider, encryptedKey, updatedAt)` table. On `POST /api/settings`, write the encrypted key using the existing `encryptCredentials` utility. On `getKey()`, check the runtime cache first, then fall back to the DB. The runtime cache becomes a performance optimisation, not the source of truth.

**Implemented in:** PR #80
- `backend/src/database/migrations/` — create `api_keys` table
- `backend/src/aiProvider.js` — add DB fallback in `getKey()`
- `backend/src/routes/settings.js` — persist to DB on key update
- New `backend/src/database/repositories/apiKeyRepo.js`

**Effort:** M | **Source:** Audit

---

### ~~ENH-024 — Frontend code splitting~~ ✅ Complete

**Problem:** All page-level components are bundled into a single JavaScript file and shipped to the client on first load. There is no `React.lazy` / `Suspense` route splitting. As the app grows (57 KB `TestDetail.jsx`, 51 KB `Tests.jsx`), initial load time will degrade measurably on slower connections.

**Fix:** Replace static page imports with `React.lazy(() => import('./pages/Page'))`. Add `<Suspense fallback={<PageSkeleton />}>` in the router. Split vendor bundles (recharts, lucide-react) into separate chunks via Vite `build.rollupOptions.output.manualChunks`.

**Files to change:**
- `frontend/src/main.jsx` or `frontend/src/App.jsx` — lazy-load all route components
- `vite.config.js` — configure manual chunk splitting
- New `frontend/src/components/PageSkeleton.jsx` — loading state for lazy routes

**Effort:** S | **Source:** Audit

---

## Phase 2 — Team & Enterprise Foundation (Weeks 7–16)

*Goal: Multi-user, multi-workspace, with integrations and durable job execution. Deployable as a team SaaS tool and sellable to companies.*

---

### ENH-001 — PostgreSQL support with SQLite fallback 🔴 Blocker

**Problem:** SQLite is a single-file, single-writer database. It means no horizontal scaling, no read replicas, and permanent data loss if a Docker container is recreated without a persistent volume. WAL mode mitigates concurrent reads but does not solve write contention at scale. This is the most significant architectural constraint for any production deployment with multiple users.

**Fix:** Introduce a `db-adapter` interface (`query`, `run`, `get`, `all`). Implement `sqlite-adapter.js` (current behaviour) and `postgres-adapter.js` (using `pg` + connection pooling). Select the adapter based on `DATABASE_URL` env var — if set and starts with `postgres://`, use PostgreSQL; otherwise fall back to SQLite. Update `migrationRunner.js` to support both SQL dialects.

**Files to change:**
- New `backend/src/database/adapters/sqlite-adapter.js`
- New `backend/src/database/adapters/postgres-adapter.js`
- `backend/src/database/sqlite.js` — refactor to adapter pattern
- `backend/src/database/migrationRunner.js` — dialect-aware migration runner
- `docker-compose.yml` — add PostgreSQL service
- `backend/.env.example` — document `DATABASE_URL`

**Effort:** XL | **Source:** Audit

---

### ENH-002 — Redis for rate limiting, token revocation, and SSE pub/sub 🔴 Blocker

**Problem:** Three critical components are process-local and therefore broken in any multi-instance deployment: (1) `revokedTokens` Map — logged-out users can reuse tokens after a restart, (2) `express-rate-limit` memory store — rate limits reset on restart and are not shared across instances, (3) `runListeners` Map — SSE events emitted on instance A are never received by clients on instance B.

**Fix:** Add `ioredis` as an infrastructure dependency. Replace the `revokedTokens` Map with Redis `SET jti EX <token_ttl>`. Replace the rate-limit memory store with `rate-limit-redis`. Replace direct SSE writes with a Redis pub/sub channel — the SSE route subscribes to `sentri:run:<runId>` and the event emitter publishes to it.

**Files to change:**
- New `backend/src/utils/redisClient.js` — shared ioredis client
- `backend/src/routes/auth.js` — token revocation via Redis
- `backend/src/middleware/appSetup.js` — Redis rate-limit store
- `backend/src/routes/runs.js` (SSE) — Redis pub/sub subscriber
- `backend/src/utils/runLogger.js` — publish events to Redis channel
- `backend/.env.example` — document `REDIS_URL`

**Effort:** L | **Source:** Audit

---

### ENH-003 — Multi-tenancy: workspace ownership on all entities 🔴 Blocker

**Problem:** Every authenticated user sees every project, test, and run. There is no concept of a workspace, organisation, or team. `GET /api/tests` returns all tests in the database to any authenticated user. This is a hard blocker for any commercial use — companies need to isolate QA projects by team or product area, and must not see each other's test data.

**Fix:** Add a `workspaces` table. Add `workspaceId TEXT NOT NULL` as a foreign key to `projects`, `tests`, `runs`, and `activities`. Add `workspaceId` to the JWT payload. Update `requireAuth` middleware to inject `req.workspaceId`. Add `WHERE workspaceId = ?` to all queries. Add workspace creation to the onboarding flow.

**Files to change:**
- `backend/src/database/migrations/` — create `workspaces` table; add `workspaceId` FKs
- New `backend/src/database/repositories/workspaceRepo.js`
- `backend/src/routes/auth.js` — include `workspaceId` in JWT
- `backend/src/middleware/appSetup.js` — inject `req.workspaceId` in `requireAuth`
- All route and repo files — scope all queries to `workspaceId`
- `frontend/src/context/AuthContext.jsx` — expose `workspace` to the app

**Effort:** L | **Source:** Audit

---

### ENH-012 — Role-based access control (Admin / QA Lead / Viewer) 🔴 Blocker

**Problem:** All authenticated users have identical permissions. There is no concept of roles. Admin-only operations (settings management, data deletion, user management) are only protected on the server — the frontend shows the same UI to all users. For any team or enterprise deployment, role separation is a hard requirement.

**Fix:** Add `role TEXT DEFAULT 'viewer'` to the `workspace_members` table: `admin`, `qa_lead`, `viewer`. Extend `requireAuth` to expose `req.userRole`. Add `requireRole('admin')` and `requireRole('qa_lead')` middleware. Gate destructive operations and settings behind role checks. Update frontend `ProtectedRoute` and action buttons to check role from `AuthContext`.

**Files to change:**
- `backend/src/database/migrations/` — add `role` to workspace/user tables
- `backend/src/middleware/appSetup.js` — add `requireRole()` middleware
- All route files for mutation operations — add role guards
- `frontend/src/context/AuthContext.jsx` — expose `role`
- `frontend/src/components/layout/ProtectedRoute.jsx` — role-based route guarding
- `frontend/src/pages/Settings.jsx` — add Members / Role management tab

**Effort:** M | **Source:** Audit

---

### ENH-009 — BullMQ job queue for run execution 🟡 High

**Problem:** Run execution is started as a detached `async` operation (`runWithAbort`) directly on the HTTP request handler thread. If the process crashes mid-run, there is no durable execution state — work is lost permanently. There is no concurrency limit across projects — a user with 10 projects can start 10 simultaneous crawls. There is no retry, priority queue, or visibility into the job backlog.

**Fix:** Replace `runWithAbort` fire-and-forget with a BullMQ `Queue.add()` call. Implement a `Worker` in `runWorker.js` that calls `crawlAndGenerateTests` or `runTests`. The worker process is separate from the HTTP process. Configure a global concurrency limit (e.g., `MAX_WORKERS=3`). Expose queue depth and active job count on the dashboard.

**Files to change:**
- `backend/src/routes/runs.js` — replace `runWithAbort` with `queue.add()`
- New `backend/src/workers/runWorker.js` — BullMQ Worker implementation
- New `backend/src/queue.js` — shared Queue definition
- `backend/package.json` — add `bullmq`
- `backend/.env.example` — document `MAX_WORKERS`

**Effort:** L | **Source:** Audit

---

### ~~ENH-011 — CI/CD webhook receiver + GitHub Actions integration~~ ✅ Complete

**Problem:** There is no programmatic trigger for test runs. Sentri cannot be called from GitHub Actions, GitLab CI, CircleCI, Jenkins, or any other pipeline. The primary adoption trigger for any developer tool is "it fits into my existing workflow" — without CI/CD integration, Sentri will not be adopted by engineering teams.

**Fix:**
1. Add `POST /api/projects/:id/trigger` authenticated by a per-project secret token (stored hashed in the database, displayed once on creation).
2. The endpoint creates a run, starts test execution asynchronously, and returns `{ runId, statusUrl }` immediately.
3. Publish `sentri/run-tests` as a GitHub Action to the GitHub Marketplace. The action polls `/api/runs/:runId` until completion and sets a pass/fail exit code.
4. Add a **Trigger** tab to `ProjectDetail` showing the token, a copy button, and example YAML snippets for GitHub Actions, GitLab CI, and cURL.
5. Support an optional `callbackUrl` param for async result delivery to external systems.

**Implemented in:** PR #86
- `backend/src/database/migrations/003_webhook_tokens.sql` — `webhook_tokens` table with SHA-256 hashed tokens, unique index on `tokenHash`
- `backend/src/database/repositories/webhookTokenRepo.js` — CRUD + `hashToken()`, `generateToken()`, `findByHash()`, `touch()`
- `backend/src/routes/trigger.js` — `POST /api/projects/:id/trigger` with Bearer token auth (no JWT), 202 Accepted, optional `callbackUrl`
- `backend/src/routes/runs.js` — token management endpoints: `GET/POST /trigger-tokens`, `DELETE /trigger-tokens/:tid`
- `backend/src/utils/idGenerator.js` — `generateWebhookTokenId()` → `WH-1`, `WH-2`, …
- `backend/src/routes/projects.js`, `backend/src/routes/recycleBin.js` — cascade-delete tokens on project delete/purge
- `frontend/src/components/automation/TokenManager.jsx` — per-project token CRUD, one-time reveal banner (extracted from TriggerTab)
- `frontend/src/components/automation/ProjectAutomationCard.jsx` — expandable per-project card (tokens + schedule placeholder)
- `frontend/src/components/automation/IntegrationSnippets.jsx` — shared CI snippet section with project selector
- `frontend/src/pages/Automation.jsx` — dedicated Automation page replacing the Trigger tab on ProjectDetail
- `frontend/src/components/layout/Sidebar.jsx` — "Automation" nav item added
- `frontend/src/components/project/ProjectHeader.jsx` — "⚡ Automation" quick-link to `/automation?project=PRJ-X`
- `frontend/src/api.js` — `getTriggerTokens()`, `createTriggerToken()`, `deleteTriggerToken()`

**Effort:** M | **Source:** Competitive (S2-01)

---

### ~~ENH-006 — Test scheduling engine (cron)~~ ✅ Complete

**Problem:** There is no way to schedule automated test runs. Teams cannot run nightly regressions without keeping a browser tab open and manually clicking "Run". Testing in production requires automated regression runs on a schedule — without this, Sentri is a manual tool, not an autonomous one.

**Fix:** Add a `schedules(projectId, cronExpr, timezone, enabled, lastRunAt, nextRunAt)` table. Use `node-cron` to fire scheduled runs as background jobs. Display the next scheduled run time in `ProjectHeader`. Add a schedule toggle and CRON editor to the project Settings tab.

**Implemented in:** PR #86
- `backend/src/database/migrations/003_schedules.sql` — `schedules` table with `cronExpr`, `timezone`, `enabled`, `lastRunAt`, `nextRunAt`; UNIQUE constraint on `projectId`; seeded `schedule` counter for `SCH-N` IDs
- `backend/src/database/repositories/scheduleRepo.js` — CRUD: `getByProjectId()`, `getAllEnabled()`, `upsert()`, `setEnabled()`, `updateRunTimes()`, `deleteByProjectId()`
- `backend/src/scheduler.js` — `node-cron` task manager with `initScheduler()`, `reloadSchedule()`, `stopSchedule()`, `getNextRunAt()`; fires scheduled runs identically to `POST /projects/:id/run`
- `backend/src/routes/projects.js` — `GET/PATCH/DELETE /projects/:id/schedule` endpoints with cron validation
- `backend/src/routes/recycleBin.js` — cascade-delete schedules and stop tasks on project purge
- `frontend/src/components/automation/ScheduleManager.jsx` — cron editor, preset picker, timezone selector, enable/disable toggle
- `frontend/src/components/automation/ProjectAutomationCard.jsx` — `ScheduleManager` integrated into per-project card
- `frontend/src/components/project/ProjectHeader.jsx` — next scheduled run time badge
- `backend/src/utils/idGenerator.js` — `generateScheduleId()` → `SCH-1`, `SCH-2`, …
- `backend/package.json` — added `node-cron`

**Effort:** M | **Source:** Competitive

---

### ENH-017 — Slack / email / webhook failure notifications 🟡 High

**Problem:** When a test run completes with failures, there is no outbound notification. Teams must poll the dashboard. Combined with scheduling (ENH-006), this is the other half of "it runs automatically" — when something breaks, the team needs to know immediately without watching a screen.

**Fix:** Add a per-project `notification_settings` table (Slack webhook URL, email recipients via Resend/SendGrid, generic webhook URL). On run completion, if `run.failed > 0`, fire all configured destinations. Slack payload includes pass/fail counts, failing test names, run duration, and a link to the run detail page.

**Files to change:**
- New `backend/src/utils/notifications.js` — Slack/email/webhook dispatch
- `backend/src/testRunner.js` — call `fireNotifications(run, project)` on completion
- `backend/src/routes/projects.js` — add notification config endpoints
- `frontend/src/pages/Settings.jsx` — notification config UI per project
- `backend/.env.example` — document `RESEND_API_KEY` / `SENDGRID_API_KEY`

**Effort:** M | **Source:** Competitive (S2-03) 🔵 Medium

**Problem:** All data fetching uses manual `useEffect` + `useState` patterns with no cache, no background refresh, no optimistic updates, and no retry. `useProjectData` exports `invalidateProjectDataCache` which callers must manually invoke — multiple components fail to do so, producing stale UI after mutations. As the app grows, this pattern produces deeply nested prop chains and increasingly subtle stale-data bugs.

**Fix:** Install `@tanstack/react-query`. Define query keys per entity. Wrap all `api.get()` calls in `useQuery`. Mutations use `useMutation` with `queryClient.invalidateQueries`. This eliminates manual cache invalidation, provides automatic background refetch, and gives free retry logic.

**Files to change:**
- `frontend/package.json` — add `@tanstack/react-query`
- `frontend/src/main.jsx` — add `QueryClientProvider`
- All `frontend/src/pages/*.jsx` — migrate `useEffect` fetches to `useQuery`
- All `frontend/src/hooks/use*.js` — refactor to TanStack Query patterns

**Effort:** L | **Source:** Audit

---

### ENH-023 — OpenAPI specification and Swagger UI 🔵 Medium

**Problem:** There is no machine-readable API contract. This blocks CI/CD integration (cannot auto-generate a GitHub Actions step schema), external tooling (Postman collections), and third-party plugins. It also makes onboarding new engineers harder — the only documentation is JSDoc comments.

**Fix:** Generate an OpenAPI 3.1 spec from existing JSDoc annotations using `swagger-jsdoc`. Serve it at `GET /api/openapi.json`. Mount `swagger-ui-express` at `/api/docs` for interactive exploration. Add Zod schemas for request validation that double as the OpenAPI schema source.

**Files to change:**
- New `backend/src/openapi.js` — spec assembly
- `backend/src/index.js` — mount Swagger UI
- `backend/package.json` — add `swagger-jsdoc`, `swagger-ui-express`

**Effort:** M | **Source:** Audit

---

## Phase 3 — AI-Native Differentiation (Weeks 17–28)

*Goal: Pull ahead of competitors with AI capabilities and advanced testing features. This phase builds the moat.*

---

### ENH-016 — Visual regression testing with baseline diffing 🟢 Differentiator

**Problem:** Sentri detects functional failures (wrong text, broken navigation, missing elements) but not visual regressions — layout shifts, colour changes, component repositioning. Mabl and Testim both offer visual diffing natively. Screenshot capture already happens; the diff layer is the missing piece.

**Fix:** On the first approved run for a test, capture a full-page screenshot as the baseline stored at `data/baselines/<testId>/step-<N>.png`. On subsequent runs, diff against the baseline using `pixelmatch`. Flag any region with pixel difference above `VISUAL_DIFF_THRESHOLD` (default 2%) as a `VISUAL_REGRESSION` failure type. Surface the diff overlay in `StepResultsView.jsx` as a toggleable before/after view. "Accept visual changes" updates the baseline.

**Files to change:**
- New `backend/src/runner/visualDiff.js` — `pixelmatch` wrapper
- `backend/src/runner/executeTest.js` — capture and compare baseline
- `backend/src/database/migrations/` — `baseline_screenshots` table
- `backend/src/routes/runs.js` — serve diff images
- `frontend/src/components/run/StepResultsView.jsx` — visual diff overlay component
- `backend/package.json` — add `pixelmatch`, `pngjs`

**Effort:** L | **Source:** Competitive

---

### ENH-014 — Cross-browser testing (Firefox, WebKit/Safari) 🟢 Differentiator

**Problem:** Only Chromium is supported. Playwright natively supports Firefox and WebKit — this is a configuration and UI gap, not a technical limitation. Many enterprise customers require Safari compatibility testing, and it is a standard question in any QA platform evaluation.

**Fix:** `launchBrowser(browserName)` accepts `'chromium'` | `'firefox'` | `'webkit'`. Add browser selector to the Run modal (`RunRegressionModal.jsx`). Test results include a `browser` field. Run detail page shows browser icon and name per result.

**Files to change:**
- `backend/src/runner/config.js` — parameterise `launchBrowser()`
- `backend/src/testRunner.js` — pass `browserName` from run config
- `frontend/src/components/run/RunRegressionModal.jsx` — add browser selector
- `frontend/src/pages/RunDetail.jsx` — show browser per result

**Effort:** M | **Source:** Competitive

---

### ENH-015 — Mobile viewport / device emulation 🟢 Differentiator

**Problem:** There is no device emulation capability. Playwright ships with 50+ device profiles (`playwright.devices`) covering iPhone, Galaxy, iPad, and desktop variants. A single device selector toggle is high-value, low-effort, and a standard question in QA platform evaluations.

**Fix:** Accept a `device` parameter in run config. Map device name to `playwright.devices[name]` to get viewport dimensions and user agent. Apply via `browser.newContext({ ...devices[device] })`.

**Files to change:**
- `backend/src/runner/config.js` — add device map lookup
- `backend/src/runner/executeTest.js` — apply device context
- `frontend/src/components/run/RunRegressionModal.jsx` — add device selector dropdown

**Effort:** S | **Source:** Competitive

---

### ENH-018 — Flaky test detection and reporting 🟢 Differentiator

**Problem:** There is no mechanism to identify tests that alternate between passing and failing across runs. Flaky tests are a major QA pain point — they erode trust in the test suite and consume engineering time investigating non-reproducible failures. The data to detect them already exists in `runs.results` but is never surfaced.

**Fix:** After each run, compute a `flakyScore` (alternation rate over the last N runs) for each test and persist it to `tests.flakyScore`. Add a "Flaky Tests" panel to the dashboard showing the top 10 flakiest tests ranked by score. Tests above a threshold get a flaky badge in the test list.

**Files to change:**
- New `backend/src/utils/flakyDetector.js` — compute flaky score from run history
- `backend/src/testRunner.js` — call detector on run completion
- `backend/src/database/migrations/` — add `flakyScore` to `tests`
- `frontend/src/pages/Dashboard.jsx` — add Flaky Tests panel
- `frontend/src/components/shared/TestBadges.jsx` — add flaky badge

**Effort:** M | **Source:** Competitive

---

### ENH-019 — Embedded Playwright trace viewer 🟢 Differentiator

**Problem:** Playwright traces are linked as `.zip` downloads that require a local Playwright Trace Viewer installation to open. This creates a significant friction point in the debugging workflow — most users will not bother. Mabl has an inline trace-style view; Sentri should too.

**Fix:** Copy the Playwright trace viewer build (`@playwright/test/lib/trace/viewer/`) into `public/trace-viewer/`. Serve it at `/trace-viewer/`. From the run detail page, link to `/trace-viewer/?trace=<artifact-signed-url>` to open the trace inline in an iframe.

**Files to change:**
- `backend/src/middleware/appSetup.js` — serve trace viewer static files
- `frontend/src/pages/RunDetail.jsx` — add "Open Trace" button linking to viewer
- Build tooling to copy trace viewer assets on `npm install`

**Effort:** M | **Source:** Audit

---

### ENH-025 — Step-level timing waterfall 🔵 Medium

**Problem:** Test results show pass/fail per test but not a timeline of how long each step took within a test. Identifying slow steps (navigation wait, element search timeout, network call) requires reading raw logs. This is the most common debugging question: "where is my test slow?"

**Fix:** Inject timing hooks around each step execution in `codeExecutor.js`. Record `{ step, durationMs, startedAt }` for each step and store as `stepTimings` in the test result. Render as a horizontal bar (waterfall) chart in `StepResultsView.jsx`.

**Files to change:**
- `backend/src/runner/executeTest.js` — record step start/end timestamps
- `backend/src/runner/codeExecutor.js` — inject timing instrumentation
- `frontend/src/components/run/StepResultsView.jsx` — add waterfall chart

**Effort:** M | **Source:** Audit

---

### ENH-028 — AI provider fallback chain on rate limits 🔵 Medium

**Problem:** If the primary AI provider returns a rate limit error, the pipeline fails after `LLM_MAX_RETRIES` attempts with no fallback. If Anthropic is temporarily rate-limited, all test generation stops — even if OpenAI or Ollama is available and configured. There is no circuit breaker.

**Fix:** In `generateText()`, catch rate limit errors (`isRateLimitError`) and automatically retry with the next configured provider in `CLOUD_DETECT_ORDER` before giving up. Log provider fallback events. Add a circuit breaker per provider that disables it for 5 minutes after 3 consecutive rate limit failures.

**Files to change:**
- `backend/src/aiProvider.js` — add fallback chain and circuit breaker
- `backend/src/pipeline/journeyGenerator.js` — surface fallback provider in logs

**Effort:** M | **Source:** Audit

---

### ENH-029 — Diff view for AI-regenerated test code 🔵 Medium

**Problem:** When AI re-generates test code after a fix (feedback loop or manual regeneration), there is no diff view showing what changed. `playwrightCodePrev` is stored in the database but never surfaced in the UI. Engineers cannot tell what the AI changed without manually comparing two code blocks.

**Fix:** Use the `diff` npm package to compute a unified diff between `playwrightCodePrev` and `playwrightCode`. Render with line-level green/red syntax highlighting. Add a "Changes" tab alongside the "Code" tab in `TestDetail.jsx`.

**Files to change:**
- `frontend/src/pages/TestDetail.jsx` — add Changes tab
- New `frontend/src/components/ai/DiffViewer.jsx` — diff rendering component
- `frontend/package.json` — add `diff`

**Effort:** S | **Source:** Audit

---

### ENH-026 — API versioning (`/api/v1/`) 🔵 Medium

**Problem:** All routes are mounted at `/api/*` with no version prefix. Any breaking API change will immediately affect all consumers — CI/CD integrations, GitHub Actions, external webhooks. Without versioning, there is no safe migration path.

**Fix:** Mount all routers under `/api/v1/`. Update `API_BASE` in the frontend. Add 301 redirects from `/api/*` to `/api/v1/*` for backward compatibility. Document the versioning policy in `README.md`.

**Files to change:**
- `backend/src/index.js` — change route mount path
- `frontend/src/utils/apiBase.js` — update `API_BASE` constant
- `backend/src/middleware/appSetup.js` — add backward-compatibility redirects

**Effort:** S | **Source:** Audit

---

### S4-03 — Standalone Playwright export (zero vendor lock-in) 🟢 Differentiator

**Problem:** The biggest objection to AI QA tools is vendor lock-in. Teams want to know they can eject if needed. QA Wolf already offers this — Sentri does not have a comparable export story (tests are viewable in the UI but not independently runnable).

**Fix:** Add a `GET /api/projects/:id/export/playwright` endpoint that generates a zip containing:
- `playwright.config.ts` pre-configured with the project URL and test runner settings
- One `.spec.ts` file per approved test, with the generated Playwright code wrapped in a proper `test()` block
- A `README.md` with `npx playwright install && npx playwright test` instructions

**Files to change:**
- `backend/src/utils/exportFormats.js` — add `buildPlaywrightZip(project, tests)` function
- `backend/src/routes/tests.js` — add `GET /projects/:id/export/playwright`
- `frontend/src/pages/Tests.jsx` — add "Export as Playwright project" button

**Effort:** M | **Source:** Competitive

---

### S4-04 — Conversational test editor wired to /chat 🟢 Differentiator

**Problem:** The `/chat` route and `LLMStreamPanel` component exist but are not connected to specific tests. Users who want to modify a test must edit the Playwright code directly. Natural-language test editing — "add an assertion that the cart total updates" — is a significant UX differentiator that no other platform has.

**Fix:** In `TestDetail.jsx`, add an "Edit with AI" panel that opens a chat thread pre-seeded with the test's current Playwright code. The AI response proposes a code change. Show a Myers diff of old vs. new code. One-click "Apply" patches the code and saves.

**Files to change:**
- `frontend/src/pages/TestDetail.jsx` — add AI edit panel with inline diff view
- `backend/src/routes/chat.js` — add test-context mode with code diff response format

**Effort:** M | **Source:** Competitive

---

### S4-05 — Jira / Linear issue sync 🟢 Differentiator

**Problem:** The traceability data model already stores `linkedIssueKey` and `tags` per test, but there is no outbound sync. When a test fails, no ticket is automatically created. Engineers must manually correlate test failures to issues.

**Fix:**
1. Add `POST /api/integrations/jira` and `POST /api/integrations/linear` settings endpoints to store OAuth tokens and workspace config.
2. On test run failure, auto-create a bug ticket (with screenshot, error message, and Playwright trace attached) via the Jira/Linear API.
3. Sync the test pass/fail status back to the linked issue's status field.
4. Add an Integrations tab to Settings.

**Files to change:**
- New `backend/src/utils/integrations.js` — Jira and Linear API clients
- `backend/src/testRunner.js` — call `syncFailureToIssue(test, run)` on completion
- `backend/src/routes/settings.js` — add integration config endpoints
- `frontend/src/pages/Settings.jsx` — add Integrations tab

**Effort:** L | **Source:** Competitive

---

### S4-06 — Autonomous monitoring mode (always-on QA agent) 🟢 Differentiator

**Problem:** Sentri is currently a triggered tool — it runs when instructed. The brand promise of "autonomous QA" implies it should also watch production continuously. No competitor outside enterprise tiers offers this for self-hosted deployments.

**Fix:** Add a monitoring mode per project: run a configurable set of "smoke tests" on a schedule against the production URL. On failure, auto-trigger a re-run to distinguish a real regression from a transient flake (2 consecutive failures = real). Fire notifications (ENH-017) on confirmed failures. Display a "Monitor" badge on the dashboard for projects in monitoring mode.

**Files to change:**
- `backend/src/scheduler.js` — add monitoring job type alongside scheduled runs
- `backend/src/routes/projects.js` — add `PATCH /projects/:id/monitor`
- `frontend/src/pages/Dashboard.jsx` — add monitoring status indicators
- `frontend/src/pages/ProjectDetail.jsx` — add monitoring config panel

**Effort:** M | **Source:** Competitive

---

### S4-07 — Anonymous usage telemetry with opt-out 🔵 Medium

**Problem:** Sentri has zero telemetry — the team has no visibility into feature usage, crawl success rates, model performance comparisons, or error frequency. This makes data-driven prioritisation impossible.

**Fix:** Add a PostHog telemetry module (adapted from Assrt's `telemetry.ts`). Track: crawl start/complete/fail, run start/complete/fail, test generation counts, provider used, test approval/rejection rate, healing events. Respect `DO_NOT_TRACK=1` and `SENTRI_TELEMETRY=0`. Hash machine IDs. Never log full URLs — domain only. Deduplicates daily events via a local file cache.

**Files to change:**
- New `backend/src/utils/telemetry.js` — PostHog wrapper with opt-out
- `backend/src/crawler.js` — instrument crawl events
- `backend/src/testRunner.js` — instrument run events
- `backend/.env.example` — document `SENTRI_TELEMETRY=0`
- `backend/package.json` — add `posthog-node`

**Effort:** S | **Source:** Assrt

---

### S4-08 — Multi-auth profile support per project 🟢 Differentiator

**Problem:** Sentri stores credentials per-project but only supports a single auth profile. Testing role-based access control — "admin sees this, viewer does not" — requires running the same test suite under different identities. No other self-hosted QA tool supports this.

**Fix:** Add named credential profiles (e.g., "admin", "viewer", "guest") per project, each with a separate username/password or cookie payload. The Test Dials already have a `multi_role` perspective option — wire it to actually run under each profile. Surface per-profile result columns in the run detail view.

**Files to change:**
- `backend/src/utils/credentialEncryption.js` — extend to support multiple named profiles
- `backend/src/routes/projects.js` — add profile CRUD endpoints
- `backend/src/pipeline/stateExplorer.js` — accept `profileId` param
- `frontend/src/pages/ProjectDetail.jsx` — add credential profiles panel
- `frontend/src/components/shared/TestDials.jsx` — connect `multi_role` dial to profile selector

**Effort:** M | **Source:** Competitive (unique to Sentri)

---

### S4-09 — Coverage heatmap on site graph 🟢 Differentiator

**Problem:** The site graph shows crawled pages but gives no signal about which pages have test coverage. Teams cannot easily identify coverage gaps from the visual.

**Fix:** For each node in the site graph (`SiteGraph.jsx`), compute a "test density" score: 0 approved tests = red, 1–2 = amber, 3+ = green. Overlay the score as a coloured ring on each node. Add a legend. This makes gaps immediately visible without reading a table.

**Files to change:**
- `frontend/src/components/crawl/SiteGraph.jsx` — add density score computation and colour ring
- `backend/src/routes/dashboard.js` — add `testsByUrl` to the dashboard API response

**Effort:** S | **Source:** Competitive

---

These items are not phase-bounded — they should be addressed incrementally alongside feature work.

---

### MAINT-001 — Vision-based locator healing

**Problem:** The self-healing waterfall uses DOM selectors exclusively (ARIA roles, text content, CSS fallbacks). When the DOM structure changes drastically — a major redesign, a component library migration — all strategies can fail simultaneously. Mabl uses screenshot diff + CV-based element finding to heal across structural changes.

**Files:** `backend/src/selfHealing.js`, `backend/src/runner/executeTest.js` | **Effort:** XL | **Source:** Competitive

---

### MAINT-002 — Self-healing ML classifier

**Problem:** The current healing waterfall is deterministic and rule-based. `STRATEGY_VERSION` invalidates all hints when strategies change. The healing history data in `healing_history` is collected but never fed back to improve the system. Training even a lightweight classifier (decision tree) on healing events to predict the best strategy would make healing faster and more reliable over time.

**Files:** `backend/src/selfHealing.js`, new `backend/src/ml/healingClassifier.js` | **Effort:** XL | **Source:** Audit

---

### MAINT-003 — Prompt A/B testing framework

**Problem:** `promptVersion` is stored on tests but there is no system to compare prompt versions, run controlled experiments, or automatically promote better prompts. AI quality improvements are made by feel rather than by measurement.

**Files:** `backend/src/pipeline/journeyGenerator.js`, new `backend/src/pipeline/promptEval.js` | **Effort:** L | **Source:** Audit

---

### MAINT-004 — Test data management (fixtures and factories)

**Problem:** Tests that require specific data states (a logged-in user with specific records, a product with a specific price) have no supported setup/teardown mechanism. This limits the depth of flows Sentri can test autonomously.

**Files:** New `backend/src/utils/testDataFactory.js`, `backend/src/pipeline/stateExplorer.js` | **Effort:** L | **Source:** Competitive

---

### MAINT-005 — BDD / Gherkin export format

**Problem:** Enterprise teams using behaviour-driven development (Cucumber, SpecFlow) cannot use Sentri's output directly. SmartBear's BDD format is widely adopted in enterprise QA. Adding a Gherkin export alongside the existing Playwright and Zephyr/TestRail exports would broaden appeal.

**Files:** New `backend/src/utils/exportFormats.js` (gherkin builder), `backend/src/routes/tests.js` | **Effort:** M | **Source:** Competitive

---

### MAINT-006 — Object storage for artifacts (S3/R2)

**Problem:** Screenshots, videos, and traces are stored on local disk (`data/screenshots/`, `data/videos/`). In a Docker or multi-instance deployment, these are lost on container restart and cannot be shared across instances. This is a known issue acknowledged in the README production checklist.

**Files:** `backend/src/runner/pageCapture.js`, `backend/src/runner/screencast.js`, new `backend/src/utils/objectStorage.js` | **Effort:** M | **Source:** Audit (M-03)

---

### MAINT-007 — MFA (TOTP / passkey) support

**Problem:** There is no multi-factor authentication. For any enterprise customer, MFA is a compliance requirement (SOC 2, ISO 27001). This is a sales blocker for regulated industries.

**Files:** `backend/src/routes/auth.js`, `frontend/src/pages/Login.jsx`, new MFA setup flow | **Effort:** L | **Source:** Audit

---

### MAINT-008 — Environments support (staging vs production)

**Problem:** There is no concept of environments per project. Teams need to run the same test suite against `staging.myapp.com` and `myapp.com` separately, with per-environment run history and independent pass/fail status. Mabl's environments feature is a critical enterprise requirement.

**Files:** New `environments` table, all run and project routes, frontend project config | **Effort:** L | **Source:** Competitive

---

### MAINT-009 — Cursor overlay on live browser view (M-04)

**Problem:** Sentri's live CDP screencast shows the browser but gives no visual indication of what the test is currently doing. Viewers cannot tell which element is about to be clicked, filled, or asserted. This makes it hard to follow along during live runs.

**Fix:** Port Assrt's `CURSOR_INJECT_SCRIPT` (animated cursor dot, click ripple, keystroke toast) into Sentri's runner. Inject via `page.evaluate()` after each navigation.

**Files:** `backend/src/runner/executeTest.js`, `backend/src/runner/pageCapture.js` | **Effort:** S | **Source:** Assrt (M-04)

---

### ~~MAINT-010 — Semantic deduplication using embedding similarity (M-05)~~ ✅ Complete

**Problem:** `backend/src/pipeline/deduplicator.js` uses exact string matching on test name + description. Renamed tests or slightly rephrased duplicates are not caught. Large test suites accumulate near-duplicate tests over time, degrading run times and signal quality.

**Implemented in:** PR #55
- Added `levenshteinDistance()` + `fuzzyNameSimilarity()` — catches paraphrased test names (≥ 0.80 similarity threshold)
- Added `buildTfIdfVector()` + `cosineSimilarity()` + `semanticSimilarity()` — catches semantic duplicates across name + description + steps (≥ 0.65 cosine threshold)
- `hashTest()` now includes `description` field in fingerprint — tests with identical code but different descriptions are correctly grouped
- `deduplicateTests()` and `deduplicateAcrossRuns()` both run 4-layer strategy: structural hash → normalized name → fuzzy name → semantic TF-IDF
- Thresholds exported as `FUZZY_NAME_THRESHOLD` and `SEMANTIC_SIMILARITY_THRESHOLD` for testability
- No new dependencies — pure JS + Node built-in `node:crypto`

**Files:** `backend/src/pipeline/deduplicator.js` | **Effort:** M | **Source:** Audit (M-05)

---

### ~~MAINT-011 — Restructure frontend to feature-sliced architecture (M-06)~~ ✅ Complete

**Problem:** `frontend/src/components/` was a flat directory of ~35 files with no domain grouping. Run views, modals, charts, badges, and layout chrome were all siblings. This made the codebase hard to navigate, slowed onboarding, and violated the principle of colocation by domain.

**Implemented in:** PR #81
- Moved 35 components from flat `components/` into 7 feature-based subdirectories: `ai/`, `charts/`, `crawl/`, `generate/`, `layout/`, `run/`, `shared/`
- Added barrel `index.js` per folder for clean imports
- Updated all import paths across pages, components, hooks, and existing subdirectories (`project/`, `test/`)
- Removed deprecated `CompletionCTA.jsx` stub
- No component logic, props, or behavior modified

**Effort:** L | **Source:** Audit (M-06)

---

### ~~MAINT-012 — Deep test validation (locator, action, assertion) (M-07)~~ ✅ Complete

**Problem:** `backend/src/pipeline/testValidator.js` only checked basic structure (URL presence + step count). AI-generated tests containing invalid CSS selectors, typo'd Playwright API calls (`.clicks()`, `.toHavURL()`), or logically-redundant `.not` chains passed validation and failed at runtime.

**Implemented in:** PR #57
- Added `validateLocators(code)` — checks CSS selectors for unbalanced brackets, unknown pseudo-classes, and excessive depth (> 6 combinators); checks XPath for unbalanced brackets, invalid `//[@` syntax, and excessive depth (> 8 steps)
- Added `validateActions(code)` — whitelists all valid Playwright API methods on `page`/`locator`/`frame`/`context`/`request`; flags any call not in the whitelist (e.g. `.clicks()`, `.fillIn()`)
- Added `validateAssertions(code)` — validates every `expect()` chain against the full Playwright matcher set; flags typos (`toHavURL` → `toHaveURL`) and logically-redundant `.not` pairs (`.not.toBeHidden()`, `.not.toBeDisabled()`)
- Deep passes only run after Acorn confirms syntactic validity — no false positives from parsing malformed code
- All three new validators are exported for unit testing with `VALID_PAGE_ACTIONS` and `VALID_MATCHERS` sets exported for whitelist extension

**Files:** `backend/src/pipeline/testValidator.js` | **Effort:** M | **Source:** Issue #57

---

## Competitive Gap Analysis

How Sentri compares to industry-standard QA platforms as of this audit:

| Capability | Sentri | Mabl | Testim | SmartBear | Playwright OSS |
|---|---|---|---|---|---|
| AI test generation | ✅ 8-stage pipeline | ✅ Auto-heal only | ✅ AI recorder | ❌ Manual | ❌ Manual |
| Self-healing selectors | ✅ 6-strategy waterfall | ✅ ML-based | ✅ Smart locators | ❌ | ❌ |
| Human review queue | ✅ Draft→Approve flow | ❌ | ❌ | ❌ | ❌ |
| Visual regression | ❌ **Gap** | ✅ Native | ✅ Native | ✅ Native | Via plugins |
| Cross-browser | ❌ Chromium only | ✅ Chrome+Firefox | ✅ Chrome+Firefox | ✅ All | ✅ All 3 |
| Mobile/device emulation | ❌ **Gap** | ✅ | ✅ | ✅ | ✅ Native |
| CI/CD integration | ✅ Webhook trigger + token auth | ✅ Native | ✅ Native | ✅ Native | ✅ CLI |
| Scheduled runs | ✅ Cron scheduler + timezone | ✅ | ✅ | ✅ | Via CI cron |
| Multi-tenancy / RBAC | ❌ **Gap** | ✅ | ✅ | ✅ | N/A |
| Failure notifications | ❌ **Gap** | ✅ Slack/email | ✅ Slack/email | ✅ | N/A |
| API testing | ✅ HAR-based generation | ✅ | ❌ | ✅ | ✅ Manual |
| Parallel execution | ✅ 1–10 workers | ✅ Cloud | ✅ Cloud | ✅ Cloud | ✅ CLI sharding |
| Standalone export | ❌ **Gap** | ❌ Lock-in | ❌ Lock-in | ❌ Lock-in | N/A (is the format) |
| NL test editing | ✅ AI chat + fix | ❌ | ❌ | ❌ | ❌ |
| Self-hosted / private | ✅ Docker | ❌ SaaS only | ❌ SaaS only | Partial | ✅ |
| Per-user audit trail | ✅ userId on activities | ✅ | ✅ | ✅ | N/A |
| Rate limiting | ✅ Three-tier | ✅ | ✅ | ✅ | N/A |

**Sentri's unique strengths:** Self-hosted + AI generation + human review queue + multi-provider LLM support + standalone Playwright export (planned). No competitor offers all of these together.

**Critical competitive gaps to close (Phase 2–3):** Cross-browser, visual regression, multi-tenancy/RBAC, failure notifications.

---

## Summary

| Phase | Items | Status | Key Deliverable |
|-------|-------|--------|-----------------|
| ~~Phase 0 — Sprint 3~~ | S3-02, S3-04, S3-08 | ✅ Complete | Test quality, Shadow DOM, Disposable email |
| Phase 1 (Weeks 1–6) | ENH-005, 007, 013, 027, 030, 021, 020, 010, 008, 004, 024 | ✅ Complete | Production-safe for real teams |
| Phase 2 (Weeks 7–16) | ENH-001, 002, 003, 012, 009, 011, 006, 017, 022, 023 | 🔄 In progress (ENH-011 ✅, ENH-006 ✅) | Sellable to companies |
| Phase 3 (Weeks 17–28) | ENH-016, 014, 015, 018, 019, 025, 028, 029, 026, S4-03, S4-04, S4-05, S4-06, S4-07, S4-08, S4-09 | 🔲 Not started | Competitive with Mabl / Testim |
| Ongoing | MAINT-001 through MAINT-012 | 🔄 In progress (MAINT-010 ✅, MAINT-011 ✅, MAINT-012 ✅) | Platform moat + infrastructure |

**Total items:** 30 audit enhancements + 17 NEXT_STEPS sprint items + 12 maintenance items = **59 tracked items**
**Completed:** S1-01 → S1-06 (Sprint 1), S3-02, S3-04, S3-08 (Sprint 3), ENH-004, ENH-005, ENH-006, ENH-007, ENH-008, ENH-010, ENH-011, ENH-013, ENH-020, ENH-021, ENH-024, ENH-027, ENH-030, MAINT-010, MAINT-012 = **24 complete**
**Critical blockers remaining:** ENH-001, 002, 003, 012 (Phase 2) = **4 blockers**
**Highest adoption impact:** ENH-003 (multi-tenancy), S4-06 (monitoring mode), ENH-017 (failure notifications)
**Lowest effort / highest immediate value:** ENH-015, S4-09, S4-07
**Next PR priorities (recommended order):** ENH-009 (BullMQ job queue, L) → ENH-001 (PostgreSQL, XL) → ENH-003 (Multi-tenancy, L)

---

## Contributing

Before starting any item:
1. Open a GitHub Issue referencing the item ID (e.g., `ENH-005`)
2. Assign yourself and add to the current sprint milestone
3. Create a branch named `feat/ENH-005-global-rate-limiting` or `fix/ENH-013-db-reset-tokens`
4. Reference the issue in your PR description
5. Update the status in this file (`🔲 Not started` → `🔄 In progress` → `✅ Complete`) in the same PR
