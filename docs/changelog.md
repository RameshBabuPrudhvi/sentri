# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Chat**: Full-page AI Chat History at `/chat` with session management — create, rename, delete, and search conversations persisted in localStorage (capped at 50 sessions per user) (#83)
- **Chat**: Export chat sessions as Markdown or JSON from the topbar menu (#83)
- **Chat**: "Open full chat page" button in the AI Chat modal navigates to `/chat` (#83)
- **Nav**: "AI Chat" entry added to the sidebar navigation (#83)

### Changed
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
