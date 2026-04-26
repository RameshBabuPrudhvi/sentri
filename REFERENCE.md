# Sentri — Reference Tables

> **Ctrl+F lookup only. Never read top-to-bottom.**
> Find what you need and stop. For how-to guidance → STANDARDS.md.

---

## Backend Shared Utilities (`backend/src/utils/`)

Do not reimplement any of these. If you need a variant, extend the existing module.

| Module | What it provides | When to use |
|---|---|---|
| `abortHelper.js` | `throwIfAborted(signal)`, `isRunAborted()`, `finalizeRunIfNotAborted()` | Every pipeline/runner stage with I/O |
| `runLogger.js` | `log()`, `logWarn()`, `logError()`, `logSuccess()`, `emitRunEvent()` | All run-level logging and SSE |
| `errorClassifier.js` | `classifyError(err, context)`, `ERROR_CATEGORY` | Converting raw errors to user-friendly messages |
| `idGenerator.js` | `generateProjectId()`, `generateTestId()`, `generateRunId()`, `generateWebhookTokenId()`, `generateScheduleId()`, `generateNotificationSettingId()` | Creating new domain objects |
| `validate.js` | `sanitise()`, `validateUrl()`, `validateProjectPayload()`, `validateTestPayload()`, etc. | All route input validation |
| `credentialEncryption.js` | `encryptCredentials()`, `decryptCredentials()` | Storing/reading project login credentials |
| `logFormatter.js` | `formatTimestamp()`, `formatLogLine()`, `shouldLog()` | Log formatting (used by runLogger) |
| `actor.js` | `actor(req)` → `{ userId, userName }` | Extracting user identity for audit trail logging |
| `emailSender.js` | `sendEmail()`, `sendVerificationEmail()`, `getTransportName()` | Transactional email (Resend / SMTP / console fallback) |
| `ssrfGuard.js` | `validateUrl()`, `safeFetch()`, `isPrivateIp()` | SSRF protection for outbound HTTP to user-configured URLs |
| `notifications.js` | `fireNotifications(run, project)` | Failure notification dispatcher (Teams, email, webhook) |
| `projectSanitiser.js` | `sanitiseProjectForClient(project)` | Stripping encrypted credentials before sending to client |
| `../middleware/demoQuota.js` | `demoQuota(op)`, `isDemoEnabled`, `getDemoQuotaStatus(userId)` | Per-user daily quota enforcement for demo mode |
| `pagination.js` | `parsePagination(page, pageSize)`, `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE` | Parsing and clamping pagination query params |
| `authWorkspace.js` | `buildJwtPayload(user, hint?)`, `buildUserResponse(user, hint?)` | Workspace-aware JWT payload and user response builders |
| `staleDetector.js` | `detectStaleTests(projectIds?)` | Flag approved tests not run in `STALE_TEST_DAYS` as stale |
| `flakyDetector.js` | `computeAndPersistFlakyScores(projectId)`, `getTopFlakyTests(projectIds, limit?)` | Compute flaky scores (0–100) from run history |

---

## Frontend Shared CSS (`frontend/src/styles/`)

The CSS follows ITCSS cascade order, imported via `frontend/src/index.css`:

```
1. tokens.css       — design tokens (colours, fonts, spacing, shadows)
2. reset.css        — browser resets, element defaults
3. components.css   — reusable UI primitives (see table below)
4. features/*.css   — feature-scoped styles (onboarding, chat, …)
5. pages/*.css      — page-specific overrides
6. utilities.css    — single-purpose helpers (flex, text, spacing, animations)
```

**Check this table before creating a new CSS class:**

| Need | Use existing class | Don't reinvent |
|---|---|---|
| Button | `.btn .btn-primary .btn-ghost .btn-danger .btn-sm .btn-xs` | Custom button styles |
| Card container | `.card .card-padded .card-padded-sm` | `background: var(--surface); border: …` |
| Badge/pill | `.badge .badge-green .badge-red .badge-amber …` | Inline coloured spans |
| Input field | `.input` | Custom input styling |
| Table | `.table` | Custom table markup |
| Modal overlay | `.modal-backdrop .modal-panel .modal-close` | Custom fixed-position overlays |
| Banner/alert | `.banner .banner-info .banner-error .banner-warning .banner-success` | Inline error boxes |
| Empty state | `.empty-state .empty-state-icon .empty-state-title .empty-state-desc` | Custom empty placeholders |
| Progress bar | `.progress-bar .progress-bar-fill` | Custom progress indicators |
| Flex layout | `.flex-between .flex-center .flex-col .flex-wrap .flex-1 .shrink-0` | Inline `display: flex` |
| Spacing | `.mb-sm .mb-md .mb-lg .mb-xl .gap-sm .gap-md .gap-lg` | Inline margins |
| Text helpers | `.text-sm .text-xs .text-muted .text-sub .text-mono .font-bold .font-semi` | Inline font overrides |
| Divider line | `.divider` | `style={{ height: 1, background: "var(--border)" }}` |
| Animations | `.spin .pulse .fade-in .skeleton` | Custom `@keyframes` for common effects |
| Automation card | `.auto-card__header .auto-card__icon .auto-card__body .auto-card__section .auto-card__section--bordered .auto-card__section-title` | `features/automation.css` |
| Schedule blocks | `.auto-sched-empty .auto-sched-summary .auto-sched-editor .auto-sched-hint .auto-sched-label` | `features/automation.css` |
| Preset dropdown | `.auto-preset-menu .auto-preset-item` | `features/automation.css` |
| Integration grid | `.auto-integ-grid .auto-integ-card .auto-integ-icon` | `features/automation.css` |
| Token states | `.auto-token-reveal .auto-token-empty .auto-snippet` | `features/automation.css` |

---

## Frontend Shared JS Modules & Hooks

| Module | What it provides | When to use |
|---|---|---|
| `src/api.js` | All `api.*` methods, `handleUnauthorized()` | Every backend call |
| `src/utils/apiBase.js` | `API_BASE`, `API_VERSION`, `API_PATH`, `parseJsonResponse()` | Base URL resolution, versioned API path |
| `src/utils/csrf.js` | `getCsrfToken()`, `setCsrfToken()` | CSRF token for mutating API requests |
| `src/utils/markdown.js` | `escapeHtml()`, `renderMarkdown()` | Rendering AI/chat markdown safely |
| `src/utils/formatters.js` | `fmtMs()`, `fmtDate()`, `fmtDateTime()`, `fmtRelativeDate()`, `fmtDateTimeMedium()`, `fmtFutureRelative()`, `fmtDuration()`, `passRateColor()` | All date, time, duration, and colour formatting |
| `src/components/shared/CopyButton.jsx` | `<CopyButton text={…} />` | Copy-to-clipboard button |
| `src/context/AuthContext.jsx` | `useAuth()` hook, login/logout, `authFetch()` | Auth state in any component |
| `src/queryClient.js` | Shared TanStack Query `queryClient`, `*QueryKeys` constants, `invalidateDashboardCache()`, `invalidateRunCache(runId)`, `invalidateSettingsCache()` | Bust cached queries after mutations |
| `src/hooks/queries/` | `useDashboardQuery`, `useRunDetailQuery(runId)`, `useSettingsBundleQuery`, `useMembersQuery`, `useRecycleBinQuery`, `useOllamaStatusQuery` | Cached GET endpoints |
| `src/hooks/useProjectData.js` | `useProjectData({ fetchTests, fetchRuns })` | Canonical access to project/tests/runs cache. Call `invalidateProjectDataCache()` after mutations. |
| `src/hooks/useRunSSE.js` | `useRunSSE(runId)` | Real-time run streaming |

---

## Test Shared Utilities (`backend/tests/helpers/`)

| Module | What it provides | When to use |
|---|---|---|
| `test-base.js` | `createTestContext()` → `{ app, req, workspaceScope, resetDb, setupEnv, registerAndLogin, extractCookie, parseCookies, buildCookieHeader, decodeJwtPayload, createTestRunner, getDatabase }` | Every integration test that needs HTTP requests, auth, or DB access |

---

## Authentication Strategy Table

All authentication is centralised in `backend/src/middleware/authenticate.js`.

| Strategy name | Token source | Verifier | Sets on `req` |
|---|---|---|---|
| `jwt-cookie` | `access_token` HttpOnly cookie | HS256 JWT verify + revocation check | `req.authUser` |
| `jwt-bearer` | `Authorization: Bearer` header | Same | `req.authUser` |
| `jwt-query` | `?token=` query param (SSE) | Same | `req.authUser` |
| `trigger-token` | `Authorization: Bearer` header | SHA-256 hash lookup in `webhook_tokens` | `req.triggerToken`, `req.triggerProject` |

### Convenience aliases

| Alias | Strategies tried (in order) | Used by |
|---|---|---|
| `requireUser` | `jwt-cookie` → `jwt-bearer` → `jwt-query` | All user-facing routes (via `requireAuth`) |
| `requireTrigger` | `trigger-token` | CI/CD trigger endpoints in `trigger.js` |
| `requireAuth` | Re-export of `requireUser` from `routes/auth.js` | Backward compat — all existing imports |

### Auth key files

| File | Role |
|---|---|
| `middleware/authenticate.js` | Strategy definitions, JWT primitives, token revocation, `authenticate()` factory |
| `middleware/workspaceScope.js` | Resolves `req.workspaceId` and `req.userRole` from DB on every request |
| `middleware/requireRole.js` | `requireRole(minimumRole)` — blocks requests below the required role level |
| `routes/auth.js` | Auth routes (login, register, OAuth, logout, refresh, password reset). Exports `setAuthCookie`, `JWT_TTL_SEC`, `EXP_COOKIE`. |
| `routes/workspaces.js` | Workspace listing, switching, and member management routes |
| `utils/authWorkspace.js` | `buildJwtPayload()` / `buildUserResponse()` |
| `middleware/appSetup.js` | CSRF middleware |
| `routes/trigger.js` | CI/CD trigger routes — uses `requireTrigger` |

---

## Database Adapters

| `DATABASE_URL` | Backend | Adapter |
|---|---|---|
| Not set | SQLite (WAL mode, `data/sentri.db`) | `adapters/sqlite-adapter.js` |
| `postgres://…` | PostgreSQL (connection pool) | `adapters/postgres-adapter.js` |

Both adapters expose the same interface (`prepare`, `exec`, `transaction`, `pragma`, `close`, `dialect`).

### Repositories

All in `backend/src/database/repositories/`:

`projectRepo`, `testRepo`, `runRepo`, `runLogRepo`, `activityRepo`, `healingRepo`, `userRepo`, `counterRepo`, `passwordResetTokenRepo`, `verificationTokenRepo`, `webhookTokenRepo`, `scheduleRepo`, `workspaceRepo`, `notificationSettingsRepo`, `accountRepo`, `apiKeyRepo`, `baselineRepo`

---

## Self-Healing Runtime Helpers

| Helper | Purpose |
|---|---|
| `safeClick(page, text)` | Click by accessible name/text |
| `safeDblClick(page, text)` | Double-click |
| `safeHover(page, text)` | Hover (menus, tooltips) |
| `safeFill(page, label, value)` | Fill input fields |
| `safeSelect(page, label, value)` | Select/dropdown |
| `safeCheck(page, label)` | Check checkbox/radio |
| `safeUncheck(page, label)` | Uncheck checkbox/radio |
| `safeExpect(page, expect, text, role?)` | Visibility assertions |

---

## Docker & Deployment

- `docker-compose.yml` — local development and production.
- `docker-compose.prod.yml` — production overrides (stricter resource limits).
- The frontend Dockerfile builds the Vite SPA and serves it with nginx. nginx proxies `/api/*` to the backend container.
- `backend/data/` is a Docker volume — persists `sentri.db` across restarts.
- `frontend_dist` is a shared named volume — the frontend copies its built dist into it; backend mounts it read-only at `/usr/share/frontend`.
- The backend Dockerfile installs Playwright's system dependencies and uses the system Chromium (`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`).
- **Never bake secrets into images.** Pass all keys via environment variables.

### Cross-Origin Deployment (GitHub Pages + Render)

| Variable | Set on | Example |
|---|---|---|
| `CORS_ORIGIN` | Backend (Render) | `https://<user>.github.io` |
| `VITE_API_URL` | Frontend build (GitHub Pages) | `https://sentri-api.onrender.com` |
| `GITHUB_PAGES` | Frontend build | `true` (sets Vite `base: "/sentri/"`) |

When cross-origin, all cookies use `SameSite=None; Secure`. Always use `cookieSameSite()` from `appSetup.js` — never hardcode `SameSite=Strict`.

### Local Development (without Docker)

```bash
# Terminal 1 — backend
cd backend && npm install && npm run dev

# Terminal 2 — frontend
cd frontend && npm install && npm run dev
```

### Health Check

`GET /health` (unauthenticated) → `{ ok: true }`. Used by Docker Compose health checks (interval 10s, 5 retries, 20s start period).

---

## Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `AI_PROVIDER` | No | auto-detect | Force a provider: `anthropic`, `openai`, `google`, `local` |
| `ANTHROPIC_API_KEY` | One of these | — | Anthropic Claude |
| `OPENAI_API_KEY` | One of these | — | OpenAI GPT |
| `GOOGLE_API_KEY` | One of these | — | Google Gemini |
| `OLLAMA_BASE_URL` | No | `http://localhost:11434` | Ollama server |
| `OLLAMA_MODEL` | No | `mistral:7b` | Ollama model name |
| `JWT_SECRET` | Yes (prod) | — | HS256 signing key |
| `DATABASE_URL` | No | — | PostgreSQL connection string. When set, uses PostgreSQL instead of SQLite. |
| `PG_POOL_SIZE` | No | `10` | Max PostgreSQL connection pool size |
| `REDIS_URL` | No | — | Redis connection URL. Enables Redis-backed rate limiting, token revocation, and cross-instance SSE pub/sub. |
| `PORT` | No | `3001` | Backend HTTP port |
| `CORS_ORIGIN` | No | `*` | Allowed frontend origin(s), comma-separated |
| `PARALLEL_WORKERS` | No | `1` | Default test parallelism |
| `LLM_MAX_TOKENS` | No | `16384` | Max tokens per LLM call |
| `LLM_MAX_RETRIES` | No | `3` | Retry count on rate limits |
| `LLM_BASE_DELAY_MS` | No | `2000` | Base back-off delay |
| `LLM_MAX_BACKOFF_MS` | No | `30000` | Max computed backoff delay |
| `BROWSER_TEST_TIMEOUT` | No | `120000` | Per-test timeout guard (ms) |
| `NODE_ENV` | No | `development` | Enables dev-only seed endpoint when not `production` |
| `HEALING_ELEMENT_TIMEOUT` | No | `5000` | Per-strategy element wait timeout (ms) |
| `HEALING_RETRY_COUNT` | No | `3` | Number of retry attempts per self-healing action |
| `HEALING_RETRY_DELAY` | No | `400` | Delay between retries (ms) |
| `HEALING_HINT_MAX_FAILS` | No | `3` | Skip healing hints that have failed this many consecutive times |
| `HEALING_VISIBLE_WAIT_CAP` | No | `1200` | Max `waitFor` timeout per strategy in `firstVisible` (ms) |
| `ENABLE_DEV_RESET_TOKENS` | No | `false` | When `"true"`, forgot-password response includes the reset token (dev/test only) |
| `MAX_CONVERSATION_TURNS` | No | `20` | Max user↔assistant turn pairs in chat context window |
| `ARTIFACT_SECRET` | Yes (prod) | random (dev) | HMAC-SHA256 key for signing artifact URLs |
| `ARTIFACT_TOKEN_TTL_MS` | No | `3600000` | Lifetime of signed artifact URL tokens (ms) |
| `RESEND_API_KEY` | No | — | Resend API key for transactional email |
| `SMTP_HOST` | No | — | SMTP server host |
| `SMTP_PORT` | No | `587` | SMTP server port |
| `SMTP_SECURE` | No | `false` | Use TLS for SMTP |
| `SMTP_USER` | No | — | SMTP username |
| `SMTP_PASS` | No | — | SMTP password |
| `EMAIL_FROM` | No | `Sentri <noreply@sentri.dev>` | Sender address for transactional emails |
| `SKIP_EMAIL_VERIFICATION` | No | `false` | When `"true"`, registration auto-verifies users (dev/CI only) |
| `ALLOW_PRIVATE_URLS` | No | `false` | When `"true"`, skips SSRF guard for `POST /api/v1/test-connection`. **Never set in production.** |
| `MAX_WORKERS` | No | `2` | Global concurrency limit for BullMQ run execution |
| `APP_URL` | No | `CORS_ORIGIN` fallback | Base URL for deep links in notification emails and webhook payloads |
| `SPA_INDEX_PATH` | No | auto-detect | Path to the Vite-built `index.html` for CSP nonce injection |
| `DEMO_GOOGLE_API_KEY` | No | — | Platform-owned Gemini API key for zero-config trial (demo mode) |
| `DEMO_DAILY_CRAWLS` | No | `2` | Max crawls per user per day in demo mode |
| `DEMO_DAILY_RUNS` | No | `3` | Max test runs per user per day in demo mode |
| `DEMO_DAILY_GENERATIONS` | No | `5` | Max AI test generations per user per day in demo mode |
| `STALE_TEST_DAYS` | No | `90` | Days since last run before an approved test is flagged stale |
| `FEEDBACK_TIMEOUT_MS` | No | `180000` | Maximum time (ms) the AI feedback loop is allowed to run |
| `VISUAL_DIFF_THRESHOLD` | No | `0.02` | Fraction of differing pixels above which a step is flagged as a visual regression |
| `VISUAL_DIFF_PIXEL_TOLERANCE` | No | `0.1` | Per-pixel colour-match tolerance passed to `pixelmatch` (0..1) |
| `MAX_RECORDING_MS` | No | `1800000` | Safety-net timeout for an interactive recorder session (30 min) |
| `RECORDER_COMPLETED_TTL_MS` | No | `120000` | Lifetime of in-memory cache after recorder auto-teardown |
| `BROWSER_DEFAULT` | No | `chromium` | Default browser engine. One of `chromium`, `firefox`, `webkit`. |
