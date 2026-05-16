# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **SEC-007** — Compliance audit log surface. New admin-only `GET /api/v1/workspaces/:workspaceId/audit-log` endpoint with cursor pagination (`?cursor=…&limit=…`), CSV / NDJSON export (`?format=csv|ndjson` with `Content-Disposition: attachment`), and per-(workspace × admin) export rate limiter (10 / 15 min, configurable via `AUDIT_EXPORT_RATE_LIMIT`, JSON browsing exempt) to guard against bulk exfiltration. New `GET /api/v1/audit/verify` admin endpoint walks the optional SHA-256 prevHash chain (enabled with `AUDIT_HASH_CHAIN=true`) and reports `firstBrokenRowId` on tamper. New `GET /api/v1/workspaces/:workspaceId/audit-log/dlq` and `POST .../dlq/:dlqId/replay` admin endpoints for SIEM dead-letter inspection and replay (returns `503 SIEM_NOT_CONFIGURED` until the forwarder lands in a follow-up PR). Daily retention sweep deletes activity rows older than `AUDIT_RETENTION_DAYS` (default 365, SOC 2 CC7.2 baseline); `0` disables, `< 90` is rejected at boot. Migration `031_activities_compliance.sql` adds `ipAddress` / `userAgent` / `prevHash` columns (null-tolerant for historical rows) and the `audit_dlq` table. Frontend `AuditLog.jsx` page mounted at `/audit-log` (admin-only via `ProtectedRoute requiredRole="admin"`).
- **SEC-007** — Eight new password-path auth activity types — `auth.login`, `auth.login.failed`, `auth.logout`, `auth.password.reset`, `auth.role.change`, `auth.api_key.create`, `auth.api_key.revoke`, `auth.session.revoke` — emit from `routes/auth.js`, `routes/workspaces.js`, `routes/settings.js`, and the shared `_internalRevokeCurrentSession` helper. Every emission captures `req.ip` and `req.get('user-agent')` for SOC 2 / ISO 27001 session-reconstruction evidence.
- **SEC-007** — Meta-audit: every read of the audit log itself emits `audit.read` (JSON) or `audit.export` (CSV/NDJSON), satisfying PCI-DSS 10.2.6 and SOC 2 CC7.2. The activity's `meta` captures the full filter shape and row count so reviewers can answer "who pulled which window of the log, when?".
- **SEC-007** — Industry-standard event dedup. Consecutive identical read-shaped events (`audit.read`, `audit.export`, `auth.login.failed`) within a configurable window (`AUDIT_DEDUP_WINDOW_SEC`, default 60s) collapse into a single row with `count++` and `lastAt = now` — matching Splunk / AWS CloudTrail / Auth0 Logs / Datadog convention. PCI-DSS 10.5.3 permits this provided attribution is preserved (every event is still counted). Migration `034_activities_dedup.sql` adds `count INTEGER DEFAULT 1` + `lastAt TEXT NULL` columns. Automatically disabled when `AUDIT_HASH_CHAIN=true` (mutating a persisted row's `count`/`lastAt` would invalidate the chain). User-initiated events (`audit.purge`, `auth.role.change`, `test.*`) are never deduped — each must stay attributable as its own row. Frontend `AuditLog.jsx` renders the dedup count as a `×N` pill next to the event label and shows first-seen / last-seen in the timestamp tooltip. UTC second-precision timestamps everywhere (PCI-DSS 10.3.3) via `fmtAuditTimestamp` formatter.
- **SEC-007 Part C** — SIEM audit-log forwarder. New `dispatchSiemEvent(workspaceId, row)` in `backend/src/utils/notifications.js` pushes every persisted audit row to the workspace's configured SIEM target as one NDJSON line with HMAC-SHA256 signature header (`X-Sentri-Audit-Signature: sha256=<hex>`). Retries 3× on 5xx / 408 / 429 with backoff (immediate, then 1s, then 2s); 4xx responses short-circuit straight to the existing `audit_dlq` table for admin replay (no wasted retries on config-issue rejections). Fire-and-forget from `logActivity` via `setImmediate` so a SIEM outage NEVER blocks the originating request. New admin routes `GET / PUT / DELETE /api/v1/workspaces/:workspaceId/siem-config` for per-workspace configuration with target URL (SSRF-guarded), HMAC secret (AES-256-GCM encrypted at rest, masked on GET with last 4 chars visible), optional custom headers (JSON, 4096-char cap), and enabled toggle. New migration `032_workspace_siem_config.sql`. Frontend `AuditLog.jsx` gains a **SIEM** header button + config panel with form validation, target URL + secret rotation + headers + enabled toggle + delete action. Standards: SOC 2 CC7.2 / ISO 27001 A.8.16 (log forwarding to monitoring infrastructure).
- Added SEC-006 PII firewall sanitization in the generation pipeline to redact emails, phones, SSNs, payment cards (Luhn-checked), JWTs, bearer/basic tokens, and auth query params before prompt construction; includes deterministic placeholders and `pipeline.pii_redacted` audit logs.
- **SEC-004 — Multi-factor authentication.** Adds TOTP-based enrollment (QR code from Settings, otpauth URL, base32 secret, encrypted at rest via existing `credentialEncryption.js`), login-time verification with single-use 8-character recovery codes (SHA-256 hashed in storage, downloadable + copyable on issue, regeneratable with password confirmation), and WebAuthn / passkey support for hardware security keys and platform authenticators (Touch ID / Windows Hello / YubiKey, etc.). Adds per-workspace MFA enforcement (`mfaRequired` admin toggle with configurable 0–90 day grace period), workspace MFA-compliance preview endpoint for admins (counts members with **either** TOTP **or** a registered passkey as enrolled, matching the enforcement engine; per-factor `totp` / `webauthn` flags returned alongside the aggregate `mfaEnabled`), JWT `amr` claim distinguishing password-only (`["pwd"]`), MFA-asserted (`["pwd","mfa"]`), and OAuth (`["oauth"]`) sessions per RFC 8176, frontend factor picker (Passkey / Authenticator / Recovery code) on login, dedicated `MFA_ENROLLMENT_REQUIRED` panel for past-grace users, and a workspace MFA grace-period banner persisted via `sessionStorage`. WebAuthn signature-counter clone detection rejects assertions with rolled-back counters; self-lockout guard prevents removing the last factor when workspace enforcement is active. Pre-auth verify endpoints (`/auth/mfa/verify`, `/auth/webauthn/authenticate/*`) are CSRF-exempt + per-IP rate-limited (5/15min for verify, 3/15min for enroll). All `auth.mfa.*` state changes audit-logged. `@simplewebauthn/server` is an optional backend dependency — passkey routes return 503 when omitted so self-hosters can disable WebAuthn without breaking the rest of MFA.
- Scalable worker pool with dashboard metrics (queue depth, active/idle workers, job counts) when Redis/BullMQ is available; falls back to single-process mode automatically. (#9)
- Recorder stealth mode: `stealth: true` option on recording sessions patches common headless-browser detection signals so sites that block automation render normally. No new dependencies. (#DIF-015c)
- Recorder device profiles: select a device (iPhone 14, Pixel 7, iPad Pro, etc.) at session launch or mid-session; captured steps are preserved across device switches. (#DIF-015c)
- Recorder element picker: click any element in the live canvas to auto-populate the selector and label in the verification form — no manual selector pasting required. (#DIF-015c)
- Recorder assertion types: `assertCount` and `assertHasClass` assertion kinds in the verification form. (#DIF-015c)
- Recorder pause, resume, and undo: operators can pause recording, resume it, and remove the last captured step without ending the session. (#DIF-015c)

### Changed
- Worker concurrency respects `WORKER_CONCURRENCY` env var (with `MAX_WORKERS` as fallback) for per-container parallelism. (#9)
- `POST /api/v1/auth/login` response shape extended: when MFA is enabled or a passkey is registered, returns `{ mfaRequired: true, pendingToken, methods: { totp, webauthn } }` instead of the user object and an auth cookie. The cookie is only issued after a successful `/auth/mfa/verify` or `/auth/webauthn/authenticate/verify` exchange. Existing password-only logins still return `{ user }` plus the cookie unchanged. (SEC-004)
- `PATCH /api/v1/workspaces/current` accepts new `mfaRequired` (boolean or 0/1) and `mfaGracePeriodDays` (0–90) fields for admin-controlled MFA enforcement. The `mfaPolicyUpdatedAt` timestamp anchors the grace clock and is stamped only on `mfaRequired` transitions, not on unrelated edits. (SEC-004)

### Fixed
- `render.yaml` Dockerfile path corrected so Render deployments no longer fail at build time. (#INF-006)

### Security
- Added per-project controls (`strictPiiFirewall`, `piiAllowlist`) to keep prompt-time PII redaction enabled by default while allowing explicit demo/training allowlist exceptions. (SEC-006)
- **SEC-004** — TOTP secrets stored AES-256-GCM encrypted at rest via the existing `credentialEncryption` helper. Recovery codes hashed with SHA-256 (never persisted raw) and compared in constant time via `crypto.timingSafeEqual` to avoid leaking which slot matched. TOTP verification iterates every clock-skew window and uses `timingSafeEqual` so total runtime does not leak which window matched (or whether any did). Pending-MFA login tokens are 24-byte base64url, single-use, 5-minute TTL, with a periodic purge sweep. WebAuthn credentials are user-scoped on delete (cross-user delete returns 404). Per-IP rate limits on `/auth/mfa/enroll`, `/auth/mfa/verify`, and `/auth/webauthn/authenticate/verify` cap brute-force on the 6-digit TOTP / recovery code spaces.
- **SEC-007** — Recorder credential redaction: password fields, OTP codes, payment card numbers, and `data-sentri-secret` fields are now redacted before storage. Sensitive values never reach the database, AI pipeline, or generated test code. Generated tests reference `process.env.SENTRI_SECRET_N` so credentials can be stored in a secret vault and injected at run time.

---

## [1.7.2] — 2026-05-15

### Added
- **AUTO-010** — Root cause clustering: Run Detail now groups failed tests by shared error fingerprint, URL, and selector in a collapsible "Root Cause Summary" panel to reduce triage overhead.
- **CAP-002** — Distributed test sharding: test runs can be split across multiple parallel workers with `shards: N`. Results, quality gates, Web Vitals evaluation, GitHub Check Runs, and CI callbacks are finalized exactly once when all shards complete.
- **DIF-012** — Multi-environment support: projects now support named environments (e.g. staging, production) each with their own base URL and optional credentials. Any run or CI trigger can target a specific environment without modifying the project.
- **CAP-001** — Data-driven test fixtures: upload CSV or JSON fixture files per test to execute one iteration per row. Each iteration result records its fixture row for precise failure attribution.

---

## [1.7.1] — 2026-05-13

### Added
- **AUTO-004** — Impact analysis: CI trigger runs can accept `changedFiles[]` (or auto-fetch changed files from a GitHub PR) to scope execution to only the affected tests; unaffected tests are recorded as `skipped_no_impact`.
- **INT-002b** — GitHub App integration: admins can launch the install flow from Settings; uninstall and repository-removal webhooks automatically disable stale PR check configurations.
- **INT-002** — GitHub Check Runs: projects can opt in to native GitHub PR Check Runs reporting test results, quality gates, and Web Vitals directly on pull requests.
- **AUTO-001** — Risk-based test ordering: tests are ordered by risk score (pass-rate history, recency, self-heal frequency, changed pages) before each run. An optional `budgetMinutes` cap truncates low-risk tests; smoke tests always run first.
- **AI-001** — OpenAI-compatible provider slots: any provider speaking the OpenAI API wire format (DeepSeek, Groq, Mistral, xAI, local LiteLLM, etc.) can be configured as a custom AI provider in Settings.
- AI provider config caching reduces database reads on high-volume pipeline runs; Redis pub/sub invalidates stale entries across instances.

### Security
- **INT-002b** — GitHub App installation IDs are now AES-256-GCM encrypted at rest for SOC 2 / ISO 27001 / HIPAA compliance.

---

## [1.7.0] — 2026-05-08

### Added
- **AUTO-002 / AUTO-015** — Diff-aware crawling: crawl runs compare against a stored baseline and scope test generation to changed pages only; no-change crawls complete without regenerating tests. Vercel and Netlify deployment webhooks trigger preview crawls automatically, with a "Last deployment run" badge in the project header.
- **AUTO-003b** — Confidence-based auto-approval: projects can set an `autoApproveThreshold` (0–1) so high-confidence AI-generated tests are approved without manual review. An `DISABLE_AUTO_APPROVAL` env var overrides all thresholds at runtime without a redeploy.
- **AUTO-017.3** — Web Vitals trend charts: Project Quality card now shows LCP, CLS, INP, and TTFB trend charts per run with threshold lines from project budgets.
- **CAP-004** — Healing Dashboard: new `/healing` page shows self-healing telemetry — per-strategy success rates, top healed selectors, and a savings trend chart.
- **MET-001** — Metric samples time-series: backend records and exposes time-series data for trend chart rendering.
- **PR-7** — Review Queue: new `/review-queue` page for approving and rejecting AI-generated tests across all projects. Two-pane layout with sort, search, category filter, multi-select, bulk actions, keyboard shortcuts (`a` approve, `r` reject, `j`/`k` navigate), and deep-linkable URL state.
- Review Queue accessibility: tab bar, checkboxes, list rows, and quality bar now meet WAI-ARIA authoring-practice requirements.
- Review Queue mobile layout: narrow viewports use a single-pane back-to-list pattern.
- Quality score factor breakdown: quality score chip and bar are now expandable to show the individual scoring factors (e.g. `+20 URL assertion`, `−30 No assertions`).
- Run comparison: `GET /api/v1/runs/:runId/compare/:otherRunId` and a Run Detail **Compare** action show a side-by-side diff of flipped, added, removed, and unchanged test outcomes across two runs. (#AUTO-019)
- Embedded Playwright trace viewer: Run Detail now has an **Open Trace** action that loads the Playwright trace viewer directly in the browser; ZIP download remains available as fallback. (#DIF-005)
- **AUTO-017** — Web Vitals budgets: per-project LCP / CLS / INP / TTFB budget configuration with evaluation on every run completion; gate results are included in CI trigger responses and callbacks.
- OpenRouter provider support: set `OPENROUTER_API_KEY` to route generation through OpenRouter's 200+ model gateway. Streaming, retries, circuit breaker, and rate-limit fallback all apply.
- Automation page restructured into four tabs — Triggers & Schedules, Quality Gates, Integrations, Snippets — with live status chips per project.
- **CAP-003** — AI-generated test code is now scanned for accidentally leaked secrets (AWS keys, JWTs, Bearer tokens) before persistence; flagged tests are rejected and the run is marked `secretScanBlocked`.
- XSS fix: AI-supplied attribute values in the DOM-tree renderer are now HTML-escaped before rendering.
- No-orphan-routes CI guard: PRs that add a backend route without a frontend consumer fail the build.

### Fixed
- `activityRepo.getFiltered` now correctly honours `limit: 0` instead of returning 200 rows.
- Review Queue search input debounced to 300ms — was firing a server request on every keystroke.
- Reject and delete actions in the Review Queue now require confirmation before executing.
- Rejected tests now restore to Draft (not directly to Approved) to re-enter the review queue.
- Journey category filter now filters server-side — pagination totals and tab counts previously reflected the unfiltered dataset.
- Sidebar draft-count badge now invalidates on approve/reject mutations — previously stayed stale for up to 60 seconds.
- Per-test video artifacts are now matched by path instead of directory index — prevents wrong-video attachments on filesystems that return files in non-creation order.

### Removed
- Sprint promotion scripts (`scripts/promote-sprint-item.mjs`) — the manual checklist in `REVIEW.md` is now the canonical hand-off process. (#PROC-002, #PROC-003)
- Dead code left over from the Review Queue migration removed from `Tests.jsx` and `ProjectDetail.jsx`.

---

## [1.6.10] — 2026-05-01

### Added
- **AUTO-016** — Accessibility scanning: every crawled page is scanned with axe-core and violations are persisted per run; CrawlView shows a per-page violation panel and the Dashboard includes a "Top Accessibility Offenders" rollup.
- **DIF-007** — "Edit with AI" panel on Test Detail: describe a change in plain language and receive a diff of the updated Playwright test code with one-click apply.
- **MNT-006** — Object storage abstraction: screenshots, videos, and traces can now be stored in any S3-compatible backend (AWS S3, Cloudflare R2, MinIO) by setting `STORAGE_BACKEND=s3`.
- **AUTO-006** — Network condition simulation: test runs accept `networkCondition: "fast" | "slow3g" | "offline"` to reproduce real-world network scenarios.
- **AUTO-005** — Automatic per-test retry with flake isolation: failed tests are retried up to `MAX_TEST_RETRIES` times (default 2) before recording a true failure. `retryCount` and `failedAfterRetry` are persisted per run for analytics.
- Standalone Playwright export: `GET /api/v1/projects/:id/export/playwright` returns a runnable Playwright project ZIP of all approved tests. (#DIF-006)
- **AUTO-012** — Quality gates: per-project pass-rate, flakiness, and failure-count thresholds; violations are included in run results and CI trigger responses.
- **ENH-036b** — Auto-detect login form fields during crawl: users supply only username and password — CSS selector configuration is no longer required.
- **INF-006** — Root `render.yaml` Blueprint for one-click Render deployment with persistent disk.
- Collapsible sidebar: toggle between full-width and icon-rail mode; state persists across reloads.
- **ENH-036** — Edit existing projects: `PATCH /api/v1/projects/:id` lets admins update name, URL, and credentials without re-entering saved secrets.
- DIF-013 — Anonymous opt-out telemetry via PostHog; disable with `SENTRI_TELEMETRY=0` or `DO_NOT_TRACK=1`.

### Fixed
- Playwright export no longer double-wraps spec files that already contain a complete `import` + `test()` structure. (#DIF-006)

### Security
- **CAP-003** — Secret scanner gate on AI-generated test code. (#12)
- XSS: attribute values in the DOM-tree renderer are now HTML-escaped. (#2)

---

## [1.6.9] — 2026-04-30

### Added
- Anonymous opt-out PostHog telemetry covering install, crawl, generate, run, review, and healing events; no PII collected. Disable with `SENTRI_TELEMETRY=0`. (#DIF-013)
- Per-run network condition simulation (`fast` / `slow3g` / `offline`) with selector in the Run Regression modal. (#AUTO-006)
- Automatic per-test retry and flake isolation; configurable via `MAX_TEST_RETRIES`. (#AUTO-005)
- Playwright project ZIP export for all approved tests. (#DIF-006)
- Conversational test editor — "Edit with AI" panel on Test Detail. (#DIF-007)
- S3-compatible object storage for screenshots, videos, and traces. (#MNT-006)
- Accessibility scanning on every crawled page with axe-core; violations visible in CrawlView and the Dashboard. (#AUTO-016)

---

## [1.6.8] — 2026-04-29

### Fixed
- Recorder canvas is now interactive — pointer, keyboard, and scroll events are forwarded to the headless browser; recording no longer returns "no actions captured". (#DIF-015)
- Recorder SSE screencast frames now paint reliably on the canvas. (#DIF-015)
- Re-recording a project after a crashed session no longer fails with a UNIQUE constraint error. (#DIF-015)
- Timed-out recorder sessions now close their stub run row, unblocking future runs on the project. (#DIF-015)
- Generated Playwright code and the human-readable Step list are now in sync after recording. (#DIF-015)
- Typing in the recorder canvas no longer produces doubled characters. (#DIF-015)
- Right- and middle-button mouse drags now forward the correct button to CDP. (#DIF-015)
- Scrolling inside the recorder canvas no longer scrolls the host page underneath. (#DIF-015)
- Step labels now use plain English (e.g. "User clicks the 'Sign in' button") instead of raw selectors. (#DIF-015)
- Adjacent navigations that differ only by query string are now collapsed into a single step. (#DIF-015)
- Recording sessions now support inline assertion steps (visible / text / value / URL), double-click, right-click, hover, and file-upload actions. (#DIF-015)

---

## [1.6.7] — 2026-04-26

### Changed
- Visual baselines are now browser-aware: baseline storage keys include the Playwright engine (chromium / firefox / webkit) so cross-browser runs no longer diff against Chromium goldens. (#DIF-002b)

---

## [1.6.x] — 2026-04-17 – 2026-04-25

### Added
- Recorder selector engine upgraded to delegate to Playwright's own `InjectedScript`-based generator for ancestor scoring, shadow-DOM traversal, and iframe locator chains. (#DIF-015b)
- `selectorGenerator` now appends `>> nth=N` when a CSS selector matches multiple elements. (#DIF-015b)
- UI login→dashboard and project-create E2E specs. (#QA)

### Fixed
- BullMQ worker no longer writes terminal state (failed status, activity log, SSE event) on non-final retry attempts. (#INF-003)
- Aborting a BullMQ-backed run now correctly signals the worker instead of only updating the database. (#INF-003)
- GDPR account export now includes run logs stored in the `run_logs` table. (#SEC-003)
- SPA CSP nonce injection now works in multi-container deployments via a shared Docker volume. (#SEC-002)
- State-explorer crawl fingerprinting now includes UI component inventory and SPA framework detection for better state discrimination. (#96)
- Per-URL state cap scales with structural diversity, allowing multi-step wizards to be fully explored. (#96)
- Link-crawl journey graph correctly resolves pages with significant query parameters. (#96)
- `notificationSettingsRepo` now returns boolean `enabled` instead of integer `0/1`. (#FEA-001)

### Security
- Content Security Policy: `'unsafe-inline'` replaced with per-request cryptographic nonce. (#SEC-002)
- Notification webhook URLs validated with full SSRF protection at write time and fetch time. (#FEA-001)
- Account export strips `passwordHash` from the payload. (#SEC-003)

---

## [1.5.0] — 2026-04-17

### Added
- **SEC-001** — Email verification on registration: new users must verify their address before signing in; verification emails sent via Resend, SMTP, or console fallback.
- **INF-001** — PostgreSQL support: set `DATABASE_URL=postgres://…` to use PostgreSQL instead of SQLite; all repositories work unchanged via a shared adapter interface.
- **INF-002** — Redis support for rate limiting, token revocation, and SSE pub/sub; falls back to in-memory stores when `REDIS_URL` is unset.
- Docker Compose profiles for optional PostgreSQL (`--profile postgres`) and Redis (`--profile redis`) services.

### Fixed
- OAuth login with a previously-registered unverified email now auto-verifies the account. (#SEC-001)
- Redis rate-limit store initialises after the connection event fires — fixes a startup race condition. (#INF-002)
- PostgreSQL adapter correctly handles string literals containing `@`, `?`, or `LIKE`/`like` — prevents false parameter substitution. (#INF-001)
- PostgreSQL adapter splits multi-statement DDL into individual statements. (#INF-001)
- PostgreSQL adapter uses `AsyncLocalStorage` for concurrency-safe transaction routing. (#INF-001)
- PostgreSQL adapter auto-reconnects on connection loss. (#INF-001)

### Security
- Login blocked for unverified email accounts — returns `403 EMAIL_NOT_VERIFIED`. (#SEC-001)

---

## [1.4.0] — 2026-04-16

### Added
- **ENH-008** — Dedicated `run_logs` table: log lines are single-row INSERTs with a monotonic sequence counter, replacing the previous O(n²) JSON read-modify-write on `runs.logs`.
- **ENH-011** — CI/CD webhook trigger: `POST /api/projects/:id/trigger` (Bearer token authenticated) returns `202 Accepted` with a `statusUrl` for polling and optional `callbackUrl` for push notification on completion.
- Per-project trigger token management: create (plaintext shown once), list, and revoke tokens via the API.
- Dedicated Automation page (`/automation`) with per-project CI/CD tokens, scheduled runs, integration snippets, and deep-link support.
- **ENH-006** — Cron-based test scheduling: configure automated regression runs per project with a 5-field cron expression and IANA timezone; schedules survive restarts and are hot-reloaded on save.
- **ENH-030** — Gitleaks secrets scanning CI job gates all PRs and pushes to `main` before any build proceeds.
- Client-side error reporting: `ErrorBoundary` reports crashes to `POST /api/system/client-error` for server-side logging.

### Changed
- Run log lines persisted to `run_logs` table instead of the `runs.logs` JSON column; `runRepo.getById()` hydrates `run.logs` automatically — no API change for callers.

### Fixed
- `callbackUrl` webhook now fires on any terminal state (completed, failed, aborted) — previously only fired on success, leaving CI pipelines unnotified on failure.
- Scheduler timezone conversion uses `Intl.DateTimeFormat.formatToParts()` — fixes DST transition edge cases.
- Scheduled runs now respect the `PARALLEL_WORKERS` env var.
- `waitFor` added to the valid page-action whitelist — prevents false rejection of tests using `locator.waitFor()`.
- `DeleteProjectModal` warns about permanently destroyed CI/CD tokens and schedules before confirming deletion.

### Security
- Artifact URLs (screenshots, videos, traces) are now HMAC-signed with a configurable TTL; requires `ARTIFACT_SECRET` in production. (#ENH-007)
- Secrets scanning gates the entire CI pipeline. (#ENH-030)

---

## [1.3.0] — 2026-04-14

### Added
- **ENH-020** — Soft delete & Recycle Bin: deleting tests, projects, or runs moves them to a recoverable Recycle Bin; items can be restored or permanently purged from Settings.
- **ENH-010** — Server-side pagination on `GET /api/projects/:id/tests`, `GET /api/tests`, and `GET /api/projects/:id/runs` via `?page=N&pageSize=N`.
- Lightweight `GET /api/projects/:id/tests/counts` endpoint returning per-status counts without fetching row data. (#ENH-010)
- **ENH-024** — Vendor bundle splitting (React, recharts, lucide-react, jspdf emitted as separate cacheable chunks) and animated page skeleton loader for lazily-loaded routes.
- Full-page AI Chat at `/chat` with persistent sessions — create, rename, delete, search, and export as Markdown or JSON. (#83)

### Changed
- `DELETE /api/projects/:id`, `DELETE /api/projects/:id/tests/:testId`, and bulk delete now soft-delete to the Recycle Bin instead of permanently destroying data. (#ENH-020)
- Chat session storage scoped by user ID to prevent cross-account data leakage. (#83)

### Fixed
- Admin "Clear all run history" permanently removes runs — does not soft-delete to the Recycle Bin. (#ENH-020)
- Project cascade-restore only recovers items deleted at the same time as the project; individually-deleted items remain in the Recycle Bin. (#ENH-020)
- Cascade soft-delete is now transactional so all child entities share the same `deletedAt` timestamp. (#ENH-020)
- Project Detail filter pills, tab badges, and Run button state now reflect server-side totals instead of the current page only. (#ENH-010)
- "Tests generated" count in the paginated runs listing no longer shows "—". (#ENH-010)

---

## [1.2.0] — 2026-04-13

### Added
- AI provider API keys are persisted to the database (AES-256-GCM encrypted at rest) and restored on startup — no longer lost on restart or redeployment. (#ENH-004)

### Security
- Artifact serving moved from public static files to HMAC-signed expiring URLs; requires `ARTIFACT_SECRET` env var in production. (#ENH-007)
- Gitleaks secrets scanning gates the entire CI pipeline. (#ENH-030)

---

## [1.1.0] — 2026-04-12

### Added
- Three-tier global rate limiting: general (300 req / 15 min), expensive operations (20 / hr), and AI generation (30 / hr). (#78)
- Password reset via `POST /api/auth/forgot-password` and `POST /api/auth/reset-password` with database-backed tokens that survive server restarts. (#78)
- Per-user audit trail: every activity log entry now records the acting user's identity. (#78)
- **S1-02** — Cookie-based auth: JWT moved from `localStorage` to HttpOnly, Secure, SameSite=Strict cookies; CSRF double-submit cookie on all mutating endpoints.
- Session refresh: `POST /api/auth/refresh` endpoint; frontend refreshes proactively 5 minutes before expiry.
- Responsive layout: sidebar collapses at 768px; off-screen drawer at 480px.
- Command Palette (`Cmd/Ctrl+K`): fuzzy-search commands (Mode 1) with AI chat fallback (Mode 2); prefix `>` for commands, `?` for AI.
- Confirm password field and frontend email validation on the registration form.
- OAuth CSRF protection via state parameter validation.
- VitePress documentation site and GitHub Pages SPA routing.

### Fixed
- Password reset tokens now persisted in the database — survive server restarts and multi-instance deployments. (#78)
- Atomic token claim prevents concurrent replay of the same password reset token. (#78)
- Single-test-run endpoint now uses the expensive-operations rate limiter instead of the AI-generation limiter. (#78)

### Removed
- `CodeEditorModal.jsx` — deprecated component with no consumers.

### Security
- Password reset tokens use a one-time atomic claim — concurrent requests cannot both succeed. (#78)
- Only the latest password reset token per user is valid; requesting a new one invalidates all prior unused tokens. (#78)
- JWT stored in HttpOnly cookies — never exposed to JavaScript, eliminating XSS-based token theft. (#S1-02)
- CSRF double-submit cookie (`_csrf`) on all POST / PATCH / PUT / DELETE endpoints. (#S1-02)
- OAuth state parameter validated before code exchange.
- JWT fallback secret replaced with random per-process generation.
- `verifyJwt` hardened with explicit buffer length check.
