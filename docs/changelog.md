# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Auth**: Email verification on registration — new users must verify their email address before signing in; verification link sent via Resend, SMTP, or console fallback (SEC-001) (#87)
- **API**: `GET /api/auth/verify?token=` — verify email address using a signed token from the verification email (SEC-001) (#87)
- **API**: `POST /api/auth/resend-verification` — resend the verification email for unverified accounts; rate-limited and enumeration-safe (SEC-001) (#87)
- **DB**: Migration 003 — `verification_tokens` table and `emailVerified` column on `users`; existing users grandfathered as verified (SEC-001) (#87)
- **Frontend**: Login page shows "verify your email" state with resend button when registration requires verification or login is blocked for unverified accounts (SEC-001) (#87)
- **Backend**: `emailSender.js` utility — transactional email abstraction supporting Resend API, SMTP (via nodemailer), and console fallback for development (SEC-001) (#87)
- **DB**: PostgreSQL support with SQLite fallback — set `DATABASE_URL=postgres://…` to use PostgreSQL instead of SQLite; both backends expose the same adapter interface so all repository modules work unchanged (INF-001) (#87)
- **DB**: `sqlite-adapter.js` and `postgres-adapter.js` — database adapter modules implementing the unified `prepare`/`exec`/`transaction`/`pragma`/`close` interface (INF-001) (#87)
- **DB**: Dialect-aware migration runner — automatically translates SQLite-specific SQL (AUTOINCREMENT, datetime, INSERT OR IGNORE/REPLACE, LIKE) to PostgreSQL when running against a PostgreSQL backend (INF-001) (#87)
- **Docker**: Optional PostgreSQL service in `docker-compose.yml` — activate with `docker compose --profile postgres up` (INF-001) (#87)
- **Infra**: Redis support for rate limiting, token revocation, and SSE pub/sub — set `REDIS_URL` to enable; falls back to in-memory stores when Redis is not configured (INF-002) (#87)
- **Auth**: Token revocation now writes to both Redis (with TTL) and the local Map, so revocations survive server restarts and are visible across instances (INF-002) (#87)
- **API**: Rate limiters (`express-rate-limit`) use `rate-limit-redis` store when Redis is available, sharing counters across all instances (INF-002) (#87)
- **SSE**: Run events are published to Redis pub/sub channels; SSE endpoints subscribe per-run so events from any instance reach all connected browsers (INF-002) (#87)
- **Docker**: Optional Redis service in `docker-compose.yml` — activate with `docker compose --profile redis up` (INF-002) (#87)

### Fixed
- **DB**: PostgreSQL adapter `namedToPositional` now masks string literals before `@` replacement — prevents `'user@example.com'` from being treated as a parameter placeholder (INF-001) (#87)
- **DB**: PostgreSQL adapter `questionToNumbered` now masks string literals before `?` replacement — prevents `'What?'` from being treated as a parameter placeholder (INF-001) (#87)
- **DB**: PostgreSQL adapter `LIKE→ILIKE` translation is now case-insensitive — both `LIKE` and `like` are correctly translated (INF-001) (#87)
- **DB**: PostgreSQL adapter `exec()` now splits multi-statement SQL and executes each statement individually — prevents DDL failures when combining `CREATE TABLE` + `CREATE INDEX` (INF-001) (#87)
- **DB**: PostgreSQL adapter deasync transaction path now uses `AsyncLocalStorage` for concurrency-safe query routing — prevents concurrent requests from routing queries through the wrong transaction client (INF-001) (#87)
- **DB**: PostgreSQL adapter pg-native path now auto-reconnects on connection loss (e.g. PostgreSQL restart, TCP timeout) — retries the query once after a fresh `connectSync()` (INF-001) (#87)
- **Auth**: OAuth login with a previously-registered unverified email now auto-verifies the account — prevents permanent password login blockage when OAuth links to an unverified user (SEC-001) (#87)
- **Frontend**: `Login.jsx` resend verification now uses `api.resendVerification()` instead of raw `fetch()` — fixes missing CSRF token and follows AGENT.md conventions (SEC-001) (#87)
- **Infra**: Redis rate-limit store now initialises based on client existence (`redis !== null`) instead of `isRedisAvailable()` — fixes race condition where the async `connect` event hadn't fired yet at module evaluation time (INF-002) (#87)
- **Infra**: Graceful shutdown now wrapped in try/catch with fallback `process.exit(1)` — prevents the process from hanging if an error occurs during shutdown (MAINT-013) (#87)
- **CI**: Added PostgreSQL + Redis integration smoke test job — validates the full auth flow (register → login → CRUD → logout → token revocation) against real PostgreSQL and Redis services (INF-001, INF-002) (#87)
- **Tests**: Added `postgres-adapter.test.js` — 16 unit tests covering all SQL translation functions (LIKE→ILIKE, datetime, AUTOINCREMENT, INSERT OR IGNORE/REPLACE, multi-statement, string literal safety) (INF-001) (#87)

### Security
- **Auth**: Login blocked for unverified email accounts — returns `403` with `EMAIL_NOT_VERIFIED` code; prevents account spoofing via unclaimed email addresses (SEC-001) (#87)

## [1.4.0] — 2026-04-16

### Added
- **API**: Dedicated `run_logs` table replaces O(n²) JSON read-modify-write on `runs.logs` — each log line is now a single INSERT row; readers get stable ordering via monotonic `seq` counter (ENH-008) (#85)
- **API**: CI/CD webhook trigger endpoint `POST /api/projects/:id/trigger` — token-authenticated (Bearer), returns `202 Accepted` with `{ runId, statusUrl }` for polling; supports optional `callbackUrl` for completion notification (ENH-011) (#85)
- **API**: Per-project trigger token management — `POST /api/projects/:id/trigger-tokens` (create, returns plaintext once), `GET /api/projects/:id/trigger-tokens` (list, no hashes), `DELETE /api/projects/:id/trigger-tokens/:tid` (revoke) (ENH-011) (#85)
- **Security**: Trigger tokens are stored as SHA-256 hashes — plaintext is shown exactly once at creation and never persisted (ENH-011) (#85)
- **Frontend**: Dedicated Automation page (`/automation`) — cross-project hub for CI/CD trigger tokens and scheduled runs, with per-project expandable accordion cards, shared integration snippets with project selector, and deep-link support via `?project=PRJ-X` (ENH-011) (#85)
- **Frontend**: "⚡ Automation" quick-link in ProjectHeader navigates to the Automation page with the current project pre-expanded (#85)
- **Nav**: "Automation" entry added to the sidebar navigation with ⚡ icon (#85)
- **Automation**: Cron-based test scheduling engine — configure automated regression runs per project via a 5-field cron expression and IANA timezone; schedules survive server restarts and are hot-reloaded on save without a process restart (ENH-006) (#85)
- **Automation**: `ScheduleManager` component — inline cron editor with preset picker (hourly, daily, weekly, etc.), timezone selector, enable/disable toggle, and next-run time display; lives inside the per-project Automation card (ENH-006) (#85)
- **API**: `GET /api/projects/:id/schedule` — returns the current schedule or null (ENH-006) (#85)
- **API**: `PATCH /api/projects/:id/schedule` — creates or updates a project's cron schedule; validates the 5-field expression server-side (ENH-006) (#85)
- **API**: `DELETE /api/projects/:id/schedule` — removes the cron schedule and cancels the running task (ENH-006) (#85)
- **DB**: `schedules` table migration (002) — stores `cronExpr`, `timezone`, `enabled`, `lastRunAt`, `nextRunAt` per project; seeded with a `schedule` counter for `SCH-N` IDs (ENH-006) (#85)
- **ProjectHeader**: Next scheduled run time badge — shows "in Xm/Xh/Xd" when an active schedule exists, linking awareness into the project detail page (ENH-006) (#85)

### Fixed
- **API**: `callbackUrl` webhook now fires on **any** terminal state (completed, failed, aborted) — previously it only fired on success, leaving CI pipelines unnotified on failure; payload now includes `error` field (#85)
- **API**: `callbackUrl` input now capped at 2048 characters to prevent abuse via extremely long URLs (#85)
- **API**: `DELETE /api/projects/:id` response now includes `destroyedTokens` and `destroyedSchedule` counts so the frontend can warn about permanently lost automation config (#85)
- **Scheduler**: Timezone conversion in `getNextRunAt()` replaced fragile `toLocaleString` round-trip with `Intl.DateTimeFormat.formatToParts()` — spec-guaranteed approach that correctly handles DST transitions (spring-forward gaps, fall-back overlaps) (#85)
- **Scheduler**: Scheduled runs now respect `PARALLEL_WORKERS` env var instead of hardcoding `parallelWorkers: 1` (#85)
- **API**: `/api/system` endpoint now includes `activeSchedules` count from the cron task registry (#85)
- **Pipeline**: `waitFor` added to `VALID_PAGE_ACTIONS` whitelist in test validator — prevents false rejection of tests using `locator.waitFor()` (#85)
- **Frontend**: `DeleteProjectModal` now warns users about permanently destroyed CI/CD tokens and schedules before confirming project deletion (#85)
- **Frontend**: Automation preset dropdown now supports keyboard navigation (Arrow keys, Escape, focus management) for accessibility (#85)
- **Frontend**: Client-side cron validator relaxed to accept range+step (`0-30/5`) and list+range (`1-5,10`) expressions — defers full validation to server (#85)
- **Frontend**: `confirm()` calls standardised to `window.confirm()` across all automation components (#85)

### Security
- **API**: SSRF protection for `callbackUrl` hardened with DNS resolution — domains pointing to private/reserved IPs (e.g. `evil.com → 169.254.169.254`) are now blocked at validation time via `dns.promises.lookup()`; fetch uses `redirect: "error"` to prevent open-redirect bypasses; DNS is re-resolved at fetch time to mitigate rebinding attacks (#85)

### Changed
- **Data**: Run log lines are now persisted in the `run_logs` table instead of the `runs.logs` JSON column — `runRepo.getById()` hydrates `run.logs` from `run_logs` automatically so callers see no API change (ENH-008) (#85)
- **Frontend**: Duplicated `CopyButton` component extracted to `components/shared/CopyButton.jsx` — used by TokenManager and IntegrationSnippets (#85)
- **Frontend**: Duplicated date/time formatters (`fmtDate`, `fmtNextRun`) consolidated into `utils/formatters.js` as `fmtDateTimeMedium()` and `fmtFutureRelative()` (#85)
- **Frontend**: Automation component inline styles replaced with CSS classes in `features/automation.css` — 15 new `.auto-*` classes for cards, schedules, presets, and integration grid (#85)
- **Backend**: Duplicated Bearer token auth logic in trigger routes extracted to `requireTriggerToken` middleware (#85)
- **Tests**: Added `ssrf-protection.test.js` with 35 unit tests covering all IPv4/IPv6 private range detection, cloud metadata IPs, and hostname false-positive guards (#85)
- **Tests**: Added 4 timezone correctness tests for `getNextRunAt()` covering Asia/Tokyo, Europe/London, Australia/Sydney, and cross-timezone offset verification (#85)

## [1.3.0] — 2026-04-14

### Added
- **Data**: Soft-delete for tests, projects, and runs — DELETE operations now move entities to a Recycle Bin instead of permanently destroying data. Accidentally deleted tests, projects, and run history can be recovered (ENH-020)
- **Data**: Recycle Bin page in Settings — lists all soft-deleted projects, tests, and runs grouped by type, with Restore and Purge actions per item (ENH-020)
- **API**: `GET /api/recycle-bin` — returns all soft-deleted entities grouped by type, capped at 200 items per type (ENH-020)
- **API**: `POST /api/restore/:type/:id` — restores a soft-deleted entity; project restores cascade to tests and runs that were deleted at the same time (individually-deleted items are preserved in the recycle bin) (ENH-020)
- **API**: `DELETE /api/purge/:type/:id` — permanently and irreversibly deletes a soft-deleted entity (ENH-020)
- **API**: Pagination on `GET /api/projects/:id/tests`, `GET /api/tests`, and `GET /api/projects/:id/runs` — pass `?page=N&pageSize=N` to receive `{ data, meta: { total, page, pageSize, hasMore } }` instead of an unbounded list. Default page size is 10, configurable via `DEFAULT_PAGE_SIZE` in `backend/src/utils/pagination.js` (ENH-010)
- **API**: `GET /api/projects/:id/tests/counts` — lightweight endpoint returning per-status test counts (`{ draft, approved, rejected, passed, failed, api, ui, total }`) without fetching row data; used by the Project Detail page for accurate filter pills, tab badges, and Run button state across all pages (ENH-010)
- **Frontend**: Project Detail page now uses server-side pagination for both tests and runs tabs — only the current page is fetched from the backend instead of the entire dataset (ENH-010)
- **Frontend**: Vendor bundle splitting in Vite config — react/react-dom/react-router, recharts, lucide-react, and jspdf are emitted as separate cacheable chunks, reducing initial app bundle size (ENH-024)
- **Frontend**: `PageSkeleton` shimmer component used as the `<Suspense>` fallback for all lazily-loaded routes — replaces the plain Loading… text with an animated skeleton that matches the page layout (ENH-024)
- **Chat**: Full-page AI Chat History at `/chat` with session management — create, rename, delete, and search conversations persisted in localStorage (capped at 50 sessions per user) (#83)
- **Chat**: Export chat sessions as Markdown or JSON from the topbar menu (#83)
- **Chat**: "Open full chat page" button in the AI Chat modal navigates to `/chat` (#83)
- **Nav**: "AI Chat" entry added to the sidebar navigation (#83)

### Fixed
- **Data**: `DELETE /api/data/runs` (admin "Clear all run history") now permanently removes runs instead of soft-deleting them into the recycle bin — the admin data management action is intended for permanent cleanup, not recoverable deletion (ENH-020)
- **Data**: Project cascade-restore (`POST /api/restore/project/:id`) now only restores tests and runs that were deleted at the same time as the project — items individually deleted before the project are left in the recycle bin (ENH-020)
- **Data**: Cascade soft-delete (`DELETE /api/projects/:id`) is now wrapped in a SQLite transaction so all entities get the same `deletedAt` timestamp — prevents cascade-restore from missing children due to second-boundary crossing (ENH-020)
- **Frontend**: Recycle Bin error state is now cleared on reload and before restore/purge actions — previously errors were sticky and never dismissed (ENH-020)
- **Frontend**: Project Detail filter pills, tab badges, Run button count, and header stats now use server-side totals from `GET /api/projects/:id/tests/counts` — previously these were computed from only the current page of tests, showing incorrect counts with server-side pagination (ENH-010)
- **Frontend**: Paginated runs listing now includes `pipelineStats` in the lean column set — the "tests generated" count for generate-type runs was showing "—" because `pipelineStats` was excluded from the paginated query (ENH-010)
- **Frontend**: Clipboard copy in AI Chat modal restored `.catch()` handler — prevents unhandled promise rejection on non-HTTPS or when clipboard permission is denied

### Changed
- **Data**: `DELETE /api/projects/:id` now performs a soft-delete cascade — tests and runs are moved to the Recycle Bin rather than permanently erased; restore the project to recover everything (ENH-020)
- **Data**: `DELETE /api/projects/:id/tests/:testId` and bulk delete now move tests to the Recycle Bin (ENH-020)
- **Chat**: Markdown renderer (`escapeHtml`, `renderMarkdown`) extracted from `AIChat.jsx` into shared `frontend/src/utils/markdown.js` — both the modal chat and full-page chat now use the same renderer (#83)
- **Chat**: Chat session storage is scoped by authenticated user ID to prevent cross-account data leakage (#83)

## [1.2.0] — 2026-04-13

### Added
- **Settings**: AI provider API keys are now persisted to the database (AES-256-GCM encrypted at rest) and automatically restored on server startup — keys no longer need to be re-entered after every deployment or container restart (ENH-004)
- **Security**: HMAC-SHA256 signed URLs for all artifact serving (screenshots, videos, Playwright traces) — short-lived `?token=&exp=` query-param tokens replace the previous public static file serving; requires `ARTIFACT_SECRET` env var in production (ENH-007)
- **CI**: Gitleaks secrets scanning job added to CI workflow — runs on every PR and push to `main` before any build jobs proceed; configured with allowlist for CI placeholder keys and `.env.example` (ENH-030)
- **API**: `POST /api/system/client-error` endpoint — receives frontend crash reports from the `ErrorBoundary` and logs them server-side via `formatLogLine`; always returns `{ ok: true }` to avoid throwing back to an already-crashed UI (#79)

### Changed
- **Frontend**: `ErrorBoundary` extracted from `App.jsx` into its own `components/ErrorBoundary.jsx` file; adds `componentDidCatch` for server-side crash reporting to `/api/system/client-error` and a "Try again" reset button alongside Reload and Dashboard (ENH-027)

### Security
- **Artifacts**: Screenshots, videos, and trace files are no longer served as public static files — all artifact URLs are now authenticated via HMAC-signed expiring tokens (1 hour TTL, configurable via `ARTIFACT_TOKEN_TTL_MS`) (ENH-007)
- **CI**: Secrets scanning now gates the entire CI pipeline — any accidentally committed API key, JWT secret, or OAuth credential will block all builds and Docker image pushes (ENH-030)

## [1.1.0] — 2026-04-12

### Added
- **API**: Three-tier global rate limiting via `express-rate-limit` — general (300 req/15 min for all `/api/*`), expensive operations (20/hr for crawl/run), AI generation (30/hr for test generation) (#78)
- **Auth**: Password reset endpoints (`POST /api/auth/forgot-password`, `POST /api/auth/reset-password`) with DB-backed tokens that survive server restarts (#78)
- **Audit**: Per-user audit trail — every activity log entry now records `userId` and `userName` identifying who performed the action (#78)
- **Audit**: Bulk approve/reject/restore actions log individual per-test activity entries with the acting user's identity (#78)
- **Auth**: JWT `name` claim — all issued tokens now include the user's display name for audit trail attribution (#78)
- **Cookie-based auth (S1-02)** — JWT moved from `localStorage` to HttpOnly; Secure; SameSite=Strict cookies (`access_token`). Eliminates XSS-based token theft. Companion `token_exp` cookie for frontend expiry UX. CSRF double-submit cookie (`_csrf`) protection on all mutating endpoints
- **Session refresh** — `POST /api/auth/refresh` endpoint; frontend proactively refreshes 5 minutes before expiry
- **Responsive layout** — sidebar collapses to icon-rail at 768px, off-screen drawer with hamburger at 480px. Dashboard, Tests, and stat grids adapt to mobile viewports
- **Command Palette** — `Cmd/Ctrl+K` now opens a two-mode command palette instead of jumping straight to AI chat. Mode 1 (default): fuzzy-search over navigation and actions with zero LLM cost. Mode 2 (fallback): type a natural-language question to open the AI chat panel. Prefix `>` to force command mode, `?` to force AI mode
- Confirm password field on registration form
- Email validation on frontend before submission
- OAuth CSRF protection (state parameter validation)
- `parseJsonResponse` helper for user-friendly error when backend is unreachable
- GitHub Pages SPA routing (`404.html` + restore script)
- VitePress documentation site

### Fixed
- **Auth**: Password reset tokens now persisted in SQLite (`password_reset_tokens` table, migration 003) instead of in-memory Map — tokens survive server restarts and work in multi-instance deployments (#78)
- **Auth**: Atomic token claim (`UPDATE … WHERE usedAt IS NULL`) eliminates the TOCTOU race condition that allowed concurrent replay of password reset tokens (#78)
- **API**: Single-test-run endpoint (`POST /tests/:testId/run`) now correctly uses the expensive-operations rate limiter instead of the AI-generation limiter (#78)
- Docker build context in `cd.yml` — was `./backend`, now `context: .` with explicit `file:`
- JWT secret no longer hardcoded — random per-process in dev, throws in production
- `verifyJwt` crash on malformed tokens (buffer length mismatch)
- OAuth provider param whitelisted to prevent path traversal
- Consistent "Sign in" / "Sign out" terminology (was mixing "login" / "sign in")
- Password fields cleared when switching between sign-in and registration modes

### Security
- **Auth**: Password reset tokens use one-time atomic claim — two concurrent requests with the same token cannot both succeed (#78)
- **Auth**: Only the latest password reset token per user is valid — requesting a new token invalidates all prior unused tokens (#78)
- **API**: Global API rate limiting prevents abuse across all endpoints, with tighter limits on resource-intensive operations (#78)
- **JWT in HttpOnly cookies** — token never exposed to JavaScript, immune to XSS exfiltration
- **CSRF double-submit cookie** — `_csrf` cookie + `X-CSRF-Token` header validation on all POST/PATCH/PUT/DELETE
- OAuth state parameter validated before code exchange
- JWT fallback secret replaced with random per-process generation
- `verifyJwt` wrapped in try/catch with explicit buffer length check
- Backend auth docstring corrected (scrypt, not bcrypt)

### Removed
- `CodeEditorModal.jsx` — deprecated component with no imports, deleted
