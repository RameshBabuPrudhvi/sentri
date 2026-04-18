# Sentri — Agent Guide

> This file is the authoritative reference for any AI coding agent (Claude, Copilot, Cursor, etc.) working on this repository.
> Read it fully before writing, editing, or reviewing any code.

---

## Project Overview

Sentri is a full-lifecycle AI QA platform that crawls a web application, generates Playwright test suites with an LLM, routes every generated test through a human-approval queue, executes approved tests against a live browser, and self-heals broken selectors across runs.

### Architecture at a Glance

```
frontend/          React 18 SPA (Vite, no framework beyond React Router)
backend/           Node.js 20+ ESM server (Express 4, Playwright, LLM SDKs)
  src/
    index.js               Entry point — DB init, route mounting, process guards
    db.js                  DEPRECATED — emptied stub; all consumers migrated to repository modules
    database/
      sqlite.js            SQLite singleton (WAL mode, auto-schema)
      schema.sql           Table definitions, indexes, counter seeds
      migrate.js           One-time JSON → SQLite migration
      repositories/        Data access layer (counterRepo, userRepo, projectRepo, testRepo, runRepo, runLogRepo, activityRepo, healingRepo, passwordResetTokenRepo, webhookTokenRepo, scheduleRepo, workspaceRepo)
    aiProvider.js          Multi-provider LLM abstraction (Anthropic/OpenAI/Google/Ollama)
    selfHealing.js         Adaptive selector waterfall + healing history
    crawler.js             Link-crawl orchestrator
    testRunner.js          Parallel test execution orchestrator
    middleware/            Express middleware (appSetup, authenticate, workspaceScope, requireRole, CORS, Helmet)
    routes/                REST endpoints (auth, projects, tests, runs, sse, settings, dashboard, system, chat, recycleBin, trigger, workspaces)
    pipeline/              8-stage AI generation pipeline
    runner/                Per-test execution (code parsing, executor, screencast, page capture)
    utils/                 ID generator, logging, abort helpers, encryption, validation
docker-compose.yml         Full-stack local / production deployment
docs/                      VitePress site + REST API reference
```

---

## Repository Conventions

### Language & Runtime

- **Backend**: Node.js 20+, ES Modules (`"type": "module"` in `package.json`). Every file uses `import`/`export` — never `require()`.
- **Frontend**: React 18, JSX, ES Modules, Vite 6. No TypeScript. Plain CSS via custom properties (design tokens in `src/styles/tokens.css`).
- **Node version**: `>=20` is required. Use `node --watch-path=src` for dev (no nodemon dependency).

### Module System (Backend)

All imports use the `.js` extension explicitly, even when the file is TypeScript-free:

```js
// ✅ Correct
import * as testRepo from "../database/repositories/testRepo.js";
import { log } from "../utils/runLogger.js";

// ❌ Wrong — missing .js extension
import * as testRepo from "../database/repositories/testRepo";
```

Named exports are preferred over default exports in backend modules. Default exports are only used in Express route files where `router` is the sole export.

### File & Directory Naming

| Layer | Convention | Example |
|---|---|---|
| Backend modules | `camelCase.js` | `aiProvider.js`, `runLogger.js` |
| Backend routes | `noun.js` (plural resource) | `projects.js`, `runs.js` |
| Frontend pages | `PascalCase.jsx` | `Dashboard.jsx`, `RunDetail.jsx` |
| Frontend components | `PascalCase.jsx` | `StatusBadge.jsx`, `TestRunView.jsx` |
| Frontend hooks | `useNoun.js` | `useProjectData.js`, `useRunSSE.js` |
| CSS files | `kebab-case.css` | `project-detail.css`, `tokens.css` |

### JSDoc (Backend)

Every exported function and module **must** have a JSDoc comment:

```js
/**
 * @module myModule
 * @description One-line summary.
 */

/**
 * Short imperative summary.
 *
 * @param {string}   name   - What it is.
 * @param {Object}   [opts] - Optional config.
 * @returns {Promise<string>} What it returns.
 * @throws {Error} When and why it throws.
 */
export async function doThing(name, opts) { … }
```

- Use `@module` at the top of every backend source file.
- Document `@typedef` for all non-trivial object shapes.
- Internal helpers that are not exported do not need JSDoc but benefit from a brief inline comment.

#### JSDoc type syntax rules

**This project uses JSDoc (not TypeScript).** The CI pipeline runs `jsdoc` to generate documentation, and it will **fail** on TypeScript-only syntax. The most common mistake is using TypeScript-style optional properties (`prop?: type`) in record types — JSDoc does not support `?:`.

| Need | ✅ JSDoc syntax | ❌ TypeScript syntax (breaks CI) |
|---|---|---|
| Optional param | `@param {string} [name]` | `@param {string?} name` |
| Optional property in record | Use `@typedef` with `@property {string} [prop]` | `{ prop?: string }` inline |
| Nullable type | `{string\|null}` or `{?string}` | `{string?}` |
| Union type | `{string\|number}` | `{string \| number}` (works but prefer `\|`) |
| Complex return shape | Define a `@typedef` and reference it in `@returns` | Inline `{{ prop?: type }}` record |

**When a return type has optional properties, always use `@typedef`:**

```js
// ✅ Correct — @typedef with optional properties using [brackets]
/**
 * @typedef {Object} UserResponse
 * @property {string}      id
 * @property {string}      [workspaceId]   - Present when user has workspaces.
 * @property {string|null} avatar
 */

/** @returns {UserResponse} */
export function buildUserResponse(user) { … }

// ❌ Wrong — TypeScript optional syntax breaks jsdoc parser
/** @returns {{ id: string, workspaceId?: string, avatar: string | null }} */
export function buildUserResponse(user) { … }
```

Simple record types without optional properties are fine inline: `@returns {{ id: string, name: string }}`.

### DRY — No Duplication

Before writing new code, check whether a shared utility, component, or CSS class already exists. Duplicating logic that belongs in a shared module is a common agent mistake.

#### Backend shared utilities (`backend/src/utils/`)

| Module | What it provides | When to use |
|---|---|---|
| `abortHelper.js` | `throwIfAborted(signal)`, `isRunAborted()`, `finalizeRunIfNotAborted()` | Every pipeline/runner stage with I/O |
| `runLogger.js` | `log()`, `logWarn()`, `logError()`, `logSuccess()`, `emitRunEvent()` | All run-level logging and SSE |
| `errorClassifier.js` | `classifyError(err, context)`, `ERROR_CATEGORY` | Converting raw errors to user-friendly messages (runs, chat, activity logs) |
| `idGenerator.js` | `generateProjectId()`, `generateTestId()`, `generateRunId()`, `generateWebhookTokenId()`, `generateScheduleId()` | Creating new domain objects |
| `validate.js` | `sanitise()`, `validateUrl()`, `validateProjectPayload()`, `validateTestPayload()`, etc. | All route input validation |
| `credentialEncryption.js` | `encryptCredentials()`, `decryptCredentials()` | Storing/reading project login credentials |
| `logFormatter.js` | `formatTimestamp()`, `formatLogLine()`, `shouldLog()` | Log formatting (used by runLogger) |
| `actor.js` | `actor(req)` → `{ userId, userName }` | Extracting user identity from `req.authUser` for audit trail logging |
| `emailSender.js` | `sendEmail()`, `sendVerificationEmail()`, `getTransportName()` | Transactional email (Resend / SMTP / console fallback) |
| `projectSanitiser.js` | `sanitiseProjectForClient(project)` | Stripping encrypted credentials before sending project to client (used by project routes and recycle bin) |
| `pagination.js` | `parsePagination(page, pageSize)`, `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE` | Parsing and clamping pagination query params; shared by testRepo and runRepo |
| `authWorkspace.js` | `buildJwtPayload(user, hint?)`, `buildUserResponse(user, hint?)` | Workspace-aware JWT payload and user response builders (ACL-001); used by auth routes and workspace switch |

Do not reimplement any of these. If you need a variant, extend the existing module.

#### Frontend shared CSS (`frontend/src/styles/`)

The CSS follows ITCSS cascade order, imported via `frontend/src/index.css`:

```
1. tokens.css       — design tokens (colours, fonts, spacing, shadows)
2. reset.css        — browser resets, element defaults
3. components.css   — reusable UI primitives (see table below)
4. features/*.css   — feature-scoped styles (onboarding, chat, …)
5. pages/*.css      — page-specific overrides
6. utilities.css    — single-purpose helpers (flex, text, spacing, animations)
```

**Before creating a new CSS class**, check `components.css` and `utilities.css` for an existing one:

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
| Automation card | `.auto-card__header .auto-card__icon .auto-card__body .auto-card__section .auto-card__section--bordered .auto-card__section-title` | `features/automation.css` — project automation card layout |
| Schedule blocks | `.auto-sched-empty .auto-sched-summary .auto-sched-editor .auto-sched-hint .auto-sched-label` | `features/automation.css` — schedule manager states |
| Preset dropdown | `.auto-preset-menu .auto-preset-item` | `features/automation.css` — cron preset picker |
| Integration grid | `.auto-integ-grid .auto-integ-card .auto-integ-icon` | `features/automation.css` — CI/CD integration card grid |
| Token states | `.auto-token-reveal .auto-token-empty .auto-snippet` | `features/automation.css` — token reveal banner, empty state, CI snippets |

**When to create a new CSS file**:
- **Feature-scoped styles** → `frontend/src/styles/features/<feature>.css` — for self-contained features (e.g. chat, onboarding). Scope all classes under a namespace prefix (`.chat-*`, `.onboard-*`).
- **Page-specific styles** → `frontend/src/styles/pages/<page>.css` — for styles used only on one page.
- **New reusable component** → Add to `components.css` if it will be used across 2+ pages/features.
- **Always import** new CSS files from `frontend/src/index.css` in the correct ITCSS layer position.

#### Frontend shared JS

| Module | What it provides | When to use |
|---|---|---|
| `src/api.js` | All `api.*` methods, `handleUnauthorized()` | Every backend call |
| `src/utils/apiBase.js` | `API_BASE`, `parseJsonResponse()` | Base URL resolution, safe JSON parsing |
| `src/utils/csrf.js` | `getCsrfToken()` | CSRF token for mutating API requests |
| `src/utils/markdown.js` | `escapeHtml()`, `renderMarkdown()` | Rendering AI/chat markdown safely (used by `AIChat.jsx` and `ChatHistory.jsx`) |
| `src/utils/formatters.js` | `fmtMs()`, `fmtDate()`, `fmtDateTime()`, `fmtRelativeDate()`, `fmtDateTimeMedium()`, `fmtFutureRelative()`, `fmtDuration()`, `passRateColor()` | All date, time, duration, and colour formatting across pages and components |
| `src/components/shared/CopyButton.jsx` | `<CopyButton text={…} />` | Copy-to-clipboard button with "Copied" feedback (used by TokenManager, IntegrationSnippets) |
| `src/context/AuthContext.jsx` | `useAuth()` hook, login/logout, `authFetch()` | Auth state in any component |
| `src/hooks/useProjectData.js` | `useProjectData(projectId)` | Fetching project + tests + runs |
| `src/hooks/useRunSSE.js` | `useRunSSE(runId)` | Real-time run streaming |

#### Test shared utilities (`backend/tests/helpers/`)

| Module | What it provides | When to use |
|---|---|---|
| `test-base.js` | `createTestContext()` → `{ app, req, workspaceScope, resetDb, setupEnv, registerAndLogin, extractCookie, parseCookies, buildCookieHeader, decodeJwtPayload, createTestRunner, getDatabase }` | Every integration test that needs HTTP requests, auth, or DB access |

**If you need a shared helper** (e.g. `escapeHtml`, `formatDuration`, `debounce`), create it in `frontend/src/utils/<name>.js` and import it. Do not define utility functions locally inside a component file — they will inevitably be needed elsewhere and duplicated.

```js
// ✅ Shared utility
// frontend/src/utils/escapeHtml.js
export function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ❌ Local helper buried inside a component
function escapeHtml(s) { … } // in AIChat.jsx — not reusable
```

### Code Formatting

No linter or formatter (ESLint, Prettier) is configured yet. Match the style of surrounding code exactly:

- **Indentation**: 2 spaces, no tabs.
- **Quotes**: Double quotes in JS/JSX. Single quotes only inside template literals or JSX attribute values where double would conflict.
- **Semicolons**: Always required.
- **Trailing commas**: Use trailing commas in multi-line arrays, objects, and parameter lists.
- **Max line length**: Soft limit of 120 characters. Break long lines at logical boundaries.
- **Braces**: K&R style — opening brace on the same line.
- **CSS**: Use `var(--token)` references, never raw hex/px. Selectors use BEM-adjacent naming (`.block__element--modifier`).

```js
// ✅ Matches project style
const result = await doThing(name, {
  timeout: 30_000,
  retries: 3,
});

// ❌ Wrong style
const result = await doThing(name, {
    timeout: 30000,
    retries: 3
})
```

### Git & Branching Conventions

- **Branch naming**: `feature/<short-description>`, `fix/<short-description>`, `codex/<task-description>`.
- **Commit messages**: Follow [Conventional Commits](https://www.conventionalcommits.org/) — the release workflow parses these to determine version bumps automatically. Use the format `<type>(<scope>): <description>`:

  | Prefix | Version bump | Example |
  |---|---|---|
  | `feat:` | Minor (`0.x.0`) | `feat: add global API rate limiting` |
  | `fix:` | Patch (`0.0.x`) | `fix: atomic token claim prevents TOCTOU race` |
  | `perf:` | Patch | `perf: cache DB queries in dashboard endpoint` |
  | `feat!:` or `BREAKING CHANGE:` in body | Major (`x.0.0`) | `feat!: replace JWT localStorage with HttpOnly cookies` |
  | `docs:`, `test:`, `chore:`, `ci:`, `refactor:`, `style:` | No bump | `docs: update API reference for rate limiting` |

  The **squash-merge commit message** (PR title) determines the version bump, so write PR titles as Conventional Commits.

- **PR size**: Keep PRs focused — one feature or fix per PR. If a change touches >500 lines, consider splitting.
- **Merge strategy**: Squash-merge to `main`. The PR title becomes the squash commit message — write it as a Conventional Commit (e.g. `feat: add global API rate limiting`).
- **No force-pushes** to `main`. Feature branches may be rebased before merge.

---

## Backend Standards

### Error Handling

- **Never swallow errors silently.** Either rethrow, log with context, or convert to a user-facing HTTP error.
- **Classify errors for the frontend.** Use `classifyError(err, context)` from `utils/errorClassifier.js` whenever storing `run.error` or sending error messages to the client. This converts raw SDK/provider errors into user-friendly messages and assigns a `category` for frontend banner styling. Never store `err.message` directly on `run.error`.
- Use the `throwIfAborted(signal)` helper from `utils/abortHelper.js` before every expensive I/O step in a pipeline or runner.
- Rate-limit retries use exponential back-off via `withRetry()` in `aiProvider.js`. Do not add ad-hoc `setTimeout` retry loops elsewhere.
- `process.on("uncaughtException")` and `process.on("unhandledRejection")` are registered once in `index.js`. Do not register additional global handlers.

```js
// ✅ Classify and log (run context — use logError which formats + emits SSE)
catch (err) {
  const { message, category } = classifyError(err, "run");
  run.error = message;           // user-friendly
  run.errorCategory = category;  // for frontend banner styling
  logError(run, message);        // structured log + SSE broadcast
}

// ✅ Classify and log (no run context — use formatLogLine directly)
catch (err) {
  console.error(formatLogLine("error", null, `[chat] ${err.message}`));
}

// ✅ Propagate with context (when not storing on run)
catch (err) {
  throw new Error(`[myModule] Failed to do X for run ${runId}: ${err.message}`);
}

// ❌ Silent swallow
catch (_) {}

// ❌ Bare console.error without formatLogLine
console.error(`[chat] failed: ${err.message}`);  // inconsistent format

// ❌ Raw error to client
run.error = err.message;  // leaks SDK internals
```

### Logging

- **Run-level logging**: Use `log(run, message)` / `logWarn(run, message)` / `logError(run, message)` from `utils/runLogger.js`. These format via `logFormatter.js` and emit SSE events automatically.
- **Application-level logging** (no run context): Use `formatLogLine(level, null, message)` from `utils/logFormatter.js` wrapped in `console.error` / `console.log`. This ensures all output follows the same structured format (`[timestamp] [LEVEL] message` or JSON when `LOG_JSON=true`). Gate debug-level logs behind `shouldLog("debug")`.
- **Never use bare `console.error` / `console.log`** for application logging. Always route through `formatLogLine` so timestamps, levels, and JSON mode are consistent.
- **Never log sensitive data**: API keys, passwords, JWT tokens, or user credentials must never appear in logs. Use `maskKey()` if you need to log a key reference.
- **Structured context**: Always include the relevant ID (runId, projectId, testId) in error messages so logs are traceable.

```js
// ✅ Run context — use runLogger (formats + emits SSE automatically)
logError(run, `Browser launch failed`);
logWarn(run, `API test generation failed: ${classified.message}`);

// ✅ No run context — use formatLogLine directly
console.error(formatLogLine("error", null, `[chat] streamText failed: ${err.message}`));
if (shouldLog("debug")) {
  console.log(formatLogLine("debug", null, `[chat] prompt=${charCount} chars`));
}

// ❌ Bare console without formatLogLine — inconsistent format
console.error(`[chat] failed: ${err.message}`);
console.log("error");

// ❌ Leaks secrets
console.error(`API key: ${apiKey}`);
```

### HTTP Routes

- All responses follow `{ ok: boolean, … }` or standard REST shape.
- 4xx errors return `{ error: string }` with a descriptive message.
- 5xx errors return `{ error: "Internal server error" }` — never leak stack traces to the client.
- Validate all user-supplied input at the route boundary using `utils/validate.js` before touching the DB.
- All routes except `/api/auth/*`, `/health`, and `/api/projects/:id/trigger*` require `requireAuth` middleware (re-exported from `routes/auth.js`, delegates to `middleware/authenticate.js`). The trigger endpoints (`POST /trigger` and `GET /trigger/runs/:runId`) use `requireTrigger` from `middleware/authenticate.js` for per-project Bearer token authentication (ENH-011). Both middlewares are produced by the same `authenticate()` strategy factory — see "Authentication Architecture" below.
- After `requireAuth`, the `workspaceScope` middleware (`middleware/workspaceScope.js`) resolves `req.workspaceId` and `req.userRole` from the database on every request (ACL-001). All entity queries must be scoped to `req.workspaceId`.
- Mutating routes are further guarded by `requireRole(minimumRole)` from `middleware/requireRole.js` (ACL-002). The role hierarchy is `admin` > `qa_lead` > `viewer`. See the endpoint tables in each route module for per-route minimum roles.

```js
// ✅ Route pattern — use repository modules for DB access
import * as projectRepo from "../database/repositories/projectRepo.js";

router.post("/projects/:id/thing", async (req, res) => {
  const { id } = req.params;
  const project = projectRepo.getById(id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  // … logic …
  res.json({ ok: true, result });
});
```

### Authentication Architecture

All authentication is centralised in **`backend/src/middleware/authenticate.js`** using a strategy pattern. This is the single source of truth for token extraction, verification, and revocation. Route files never implement their own auth logic.

#### Strategy table

| Strategy name    | Token source                   | Verifier                                 | Sets on `req`                              |
|------------------|--------------------------------|------------------------------------------|--------------------------------------------|
| `jwt-cookie`     | `access_token` HttpOnly cookie | HS256 JWT verify + revocation check      | `req.authUser`                             |
| `jwt-bearer`     | `Authorization: Bearer` header | Same                                     | `req.authUser`                             |
| `jwt-query`      | `?token=` query param (SSE)    | Same                                     | `req.authUser`                             |
| `trigger-token`  | `Authorization: Bearer` header | SHA-256 hash lookup in `webhook_tokens`  | `req.triggerToken`, `req.triggerProject`    |

#### Convenience aliases

| Alias            | Strategies tried (in order)                       | Used by                                   |
|------------------|---------------------------------------------------|-------------------------------------------|
| `requireUser`    | `jwt-cookie` → `jwt-bearer` → `jwt-query`        | All user-facing routes (via `requireAuth`) |
| `requireTrigger` | `trigger-token`                                   | CI/CD trigger endpoints in `trigger.js`    |
| `requireAuth`    | Re-export of `requireUser` from `routes/auth.js`  | Backward compat — all existing imports     |

#### CSRF auto-exemption

The CSRF middleware in `appSetup.js` skips validation when no `access_token` cookie is present on the request. This means non-cookie auth strategies (Bearer token, trigger token, query param) are automatically CSRF-exempt — no manual regex carve-outs needed. When adding a new auth strategy, if it does not use cookies, CSRF exemption is automatic.

#### Adding a new auth strategy

1. Add a new entry to `AUTH_TYPE` in `middleware/authenticate.js`.
2. Add a strategy object to the `STRATEGIES` array (extract → verify).
3. If the strategy uses cookies, add its name to `COOKIE_STRATEGIES`.
4. Create a convenience alias (e.g. `export const requireApiKey = authenticate(AUTH_TYPE.API_KEY)`).
5. Mount it on the relevant routes. No changes needed to `appSetup.js`, `index.js`, or other route files.

#### Key files

| File | Role |
|---|---|
| `middleware/authenticate.js` | Strategy definitions, JWT primitives (`signJwt`, `verifyJwt`, `getJwtSecret`), token revocation, `authenticate()` factory |
| `middleware/workspaceScope.js` | Resolves `req.workspaceId` and `req.userRole` from DB on every request (ACL-001). Must run after `requireAuth`. |
| `middleware/requireRole.js` | `requireRole(minimumRole)` — blocks requests below the required role level (ACL-002) |
| `routes/auth.js` | Auth **routes** (login, register, OAuth, logout, refresh, password reset, email verification). Exports `setAuthCookie`, `JWT_TTL_SEC`, `EXP_COOKIE` for reuse. Re-exports `requireAuth` as alias for `requireUser`. |
| `routes/workspaces.js` | Workspace listing, switching, and member management routes (ACL-001, ACL-002) |
| `utils/authWorkspace.js` | `buildJwtPayload()` / `buildUserResponse()` — shared by `auth.js` and `workspaces.js` |
| `middleware/appSetup.js` | CSRF middleware — imports `AUTH_COOKIE` from `authenticate.js` for auto-exemption |
| `routes/trigger.js` | CI/CD trigger routes — uses `requireTrigger` from `authenticate.js` |

### Database

Sentri supports **SQLite** (default, via `better-sqlite3`) and **PostgreSQL** (via `pg` + `pg-native`). The backend is selected by the `DATABASE_URL` environment variable:

| `DATABASE_URL` | Backend | Adapter |
|---|---|---|
| Not set | SQLite (WAL mode, `data/sentri.db`) | `adapters/sqlite-adapter.js` |
| `postgres://…` | PostgreSQL (connection pool) | `adapters/postgres-adapter.js` |

Both adapters expose the same interface (`prepare`, `exec`, `transaction`, `pragma`, `close`, `dialect`) so all repository modules work unchanged. The adapter is selected at startup by `database/sqlite.js` (the module name is kept for backward compatibility).

- **Repository pattern**: All DB access goes through repository modules in `backend/src/database/repositories/`. Never write raw SQL in route handlers.
- **`db.js` is deprecated** — the file has been emptied. All consumers have been migrated to use repository modules directly. Do not import `getDb()` or `saveDb()` in new code.
- **Repositories**: `projectRepo`, `testRepo`, `runRepo`, `runLogRepo`, `activityRepo`, `healingRepo`, `userRepo`, `counterRepo`, `passwordResetTokenRepo`, `verificationTokenRepo`, `webhookTokenRepo`, `scheduleRepo`, `workspaceRepo` — each in `backend/src/database/repositories/`.
- **JSON columns**: `steps`, `tags`, `results`, `testQueue`, `credentials`, etc. are stored as JSON strings and auto-serialized/deserialized by the repository layer. Note: `logs` was moved from a JSON column on `runs` to a dedicated `run_logs` table (ENH-008) — `runRepo.getById()` hydrates `run.logs` from `run_logs` automatically.
- **Boolean columns**: `isJourneyTest`, `assertionEnhanced`, `isApiTest` are stored as `0`/`1` integers and converted to `true`/`false` by `testRepo`.
- **ID generation**: Atomic counters in the `counters` table via `counterRepo.next("test")` → `TC-1`, `TC-2`, etc.
- **Auto-migration**: On first startup, if `data/sentri-db.json` exists and SQLite is empty, `database/migrate.js` imports all data in a single transaction and renames the JSON file to `.migrated`.

### Data Migration & Schema Changes

Schema is defined in `backend/src/database/schema.sql` (all `CREATE TABLE IF NOT EXISTS`). When changing the schema:

- **Adding a new column**: Add it to `schema.sql` with a `DEFAULT` value, add it to the repository's `INSERT_COLS` and row conversion functions. SQLite does not auto-add columns to existing tables — use `ALTER TABLE ADD COLUMN` in a migration block at the top of `schema.sql`.
- **Adding a new table**: Add `CREATE TABLE IF NOT EXISTS` + indexes to `schema.sql`. Create a new repository module in `database/repositories/`.
- **Changing column types or constraints**: SQLite has limited `ALTER TABLE` support. For complex changes, create a new table, copy data, drop old, rename new — wrapped in a transaction.

### IDs

Human-readable IDs (`TC-1`, `RUN-2`, `PRJ-3`) are generated by `utils/idGenerator.js`. Never use `uuid` directly as a primary key for domain objects — use `idGenerator` for projects, tests, and runs, and `uuid` only for internal sub-records (e.g. network log entries, step results).

### AI Provider

All LLM calls go through `aiProvider.js`. Do not import Anthropic, OpenAI, or Google SDKs directly anywhere else.

```js
// ✅
import { generateText, streamText, parseJSON } from "../aiProvider.js";

// ❌
import Anthropic from "@anthropic-ai/sdk";
```

- Prefer `{ system, user }` structured messages over a single combined string. This enables provider-native system message support (Anthropic `system` field, OpenAI `system` role, Gemini `systemInstruction`).
- Always pass `signal` from the run's `AbortController` so the LLM call is cancellable.

### SSE / Real-Time Events

- Use `emitRunEvent(runId, eventType, payload)` from `utils/runLogger.js` (re-exported from `index.js`).
- Use `log(run, message)` / `logWarn(run, message)` for structured run log entries; these emit SSE automatically.
- Never write to `process.stdout` for run-level progress — always use the run logger so the UI sees it.
- **Proxy buffering**: Every SSE endpoint **must** set `X-Accel-Buffering: no` to prevent nginx (in Docker) from buffering the stream. Without this header, tokens/events are batched and delivered only when the buffer fills or the connection closes, breaking real-time UX.

```js
// ✅ Required headers for any SSE endpoint
res.setHeader("Content-Type", "text/event-stream");
res.setHeader("Cache-Control", "no-cache");
res.setHeader("Connection", "keep-alive");
res.setHeader("X-Accel-Buffering", "no");   // ← critical for nginx proxy
res.flushHeaders();
```

### Abort / Cancellation

`AbortSignal` is threaded through the entire pipeline. Every stage that does I/O (AI calls, Playwright ops, fetch) must accept and honour a `signal` parameter. Use `throwIfAborted(signal)` at the start of each stage and after each expensive operation.

---

## Frontend Standards

### Component Patterns

- Functional components only. Class components exist only in `components/ErrorBoundary.jsx` for React's mandatory class API (`getDerivedStateFromError` / `componentDidCatch`).
- Pages live in `src/pages/`, reusable UI in `src/components/`.
- Domain-specific sub-components live in subdirectories, e.g. `src/components/project/`, `src/components/test/`, `src/components/automation/`.
- Lazy-load all page-level components via `React.lazy()` + `Suspense` as shown in `App.jsx`.

### State & Data Fetching

- The `useProjectData(projectId)` hook is the canonical way to fetch and cache project, tests, and runs data. Use it instead of ad-hoc `useEffect` + `fetch`.
- Use the `useRunSSE(runId)` hook for real-time run streaming; do not write raw `EventSource` logic in components.
- Global auth state lives in `context/AuthContext.jsx`. Access it with `useAuth()`.

### Styling

- Use CSS custom properties (defined in `src/styles/tokens.css`) for all colours, spacing, and radius values. Never hardcode hex values or pixel sizes in component styles.
- Component-level styles use the BEM-adjacent class naming already established (e.g. `.stat-card`, `.status-badge--pass`).
- Dark mode is handled automatically via `prefers-color-scheme` in `tokens.css`. Do not write `@media (prefers-color-scheme: dark)` in component files — override tokens at the `:root[data-theme="dark"]` level only.
- Inline styles are acceptable for one-off layout overrides but must use CSS variable references: `style={{ color: "var(--text2)" }}`.

### API Calls

All backend communication goes through `src/api.js`. Do not use `fetch` directly in components or hooks.

```js
// ✅
import { api } from "../api.js";
const project = await api.getProject(id);

// ❌
const res = await fetch(`/api/projects/${id}`);
```

The `api.js` `req()` wrapper sends `credentials: "include"` on every request so the HttpOnly auth cookie is attached automatically. It also injects the `X-CSRF-Token` header (from `utils/csrf.js`) on mutating methods (POST/PATCH/PUT/DELETE). On 401 responses it clears the stored user profile and redirects to `/login`. Any new `api.*` method that bypasses `req()` (e.g. for streaming) **must** replicate the 401 handling by calling `handleUnauthorized()` and include `credentials: "include"` + the CSRF header.

### Error Handling (Frontend)

- The global `ErrorBoundary` (`components/ErrorBoundary.jsx`, imported by `App.jsx`) catches render-time exceptions and reports them to `/api/system/client-error`. It offers "Try again" (soft reset), "Reload page", and "Go to Dashboard" recovery actions. Do not add additional top-level error boundaries unless isolating a specific widget.
- API errors should be caught in the calling component and displayed inline (e.g. a red banner or toast). Do not let errors propagate silently.
- Frontend crash reports are posted to the backend via `componentDidCatch`. No external error tracking service (Sentry, etc.) is configured yet.

### Accessibility (a11y)

- All interactive elements (`<button>`, `<a>`, custom controls) must be keyboard-accessible. Test with Tab/Enter/Escape.
- Modals and overlays must trap focus while open and restore focus on close. Use `autoFocus` on the primary input and listen for Escape to dismiss.
- Use semantic HTML elements (`<nav>`, `<main>`, `<section>`, `<dialog>`) over generic `<div>` where applicable.
- Icon-only buttons must have `title` or `aria-label` attributes for screen readers.
- Colour alone must not convey meaning — pair status colours with text labels or icons (e.g. "Pass ✓" not just a green dot).

### Performance

- **Lazy loading**: All page-level components use `React.lazy()` + `Suspense`. Heavy third-party libraries should also be dynamically imported.
- **No bundle size tool** is configured yet. Be mindful of large dependency additions — prefer lightweight alternatives or tree-shakeable imports.
- **Images/assets**: Use optimised formats (WebP, SVG). Do not commit large binary files to the repo.
- **Backend response times**: No formal SLA, but API endpoints should respond within 500ms for reads. Long-running operations (crawl, test execution, AI generation) use SSE streaming and should not block the HTTP response.

---

## CI / CD

CI runs automatically on every push to `main`/`develop` and on PRs to `main` via `.github/workflows/ci.yml`. The pipeline includes:

1. **Secrets** — Gitleaks scan (full git history) gates all subsequent jobs. Blocks builds on accidentally committed API keys, JWT secrets, or credentials.
2. **Backend** — `npm install` → syntax check (`node --check`) → `npm test` → JSDoc generation → live smoke test (starts server, registers user, verifies cookie-based auth + CSRF on authenticated endpoints).
3. **Frontend** — `npm install` → `npm test` → `npm run build` (catches JSX errors, bad imports).
4. **Docs** — VitePress build + JSDoc assembly (runs after backend passes).
5. **Docker** — Builds both images, runs a container smoke test with cookie-based auth.
6. **Release** (`.github/workflows/release.yml`, `main` only) — Parses Conventional Commit messages, auto-bumps version in all three `package.json` files (backend, frontend, docs), promotes `[Unreleased]` in changelog, creates a git tag + GitHub Release. See Versioning & Releases for details.

All five CI jobs must pass before merge. If CI fails, check the smoke test section first — it exercises the full auth flow (register → login → cookie extraction → CSRF-protected POST).

To run locally before pushing:

```bash
# Backend — tests must all pass
cd backend && npm test

# Frontend — build must succeed with zero errors
cd frontend && npm run build

# Frontend — tests must pass
cd frontend && npm test
```

---

## Testing

### Mandatory test requirements

**Every PR that adds or modifies backend logic MUST include tests.** PRs without adequate test coverage will not be merged. The requirements are:

| Change type | Required tests | Where |
|---|---|---|
| New repository module | Unit tests for every exported function | Dedicated `tests/<module>.test.js` file |
| New shared utility (`utils/`) | Unit tests for all branches and edge cases | Dedicated file or added to `tests/utils.test.js` |
| New API endpoint or changed endpoint behaviour | Integration test exercising the HTTP flow (status codes, response shape, auth, error cases) | `tests/api-flow.test.js` or a dedicated file |
| Bug fix | Regression test that fails without the fix and passes with it | Closest existing test file or dedicated file |
| New middleware (rate limiter, CSRF, etc.) | Integration test verifying the middleware is wired correctly (e.g. 429 on excess, 403 on missing CSRF) | Dedicated file or `tests/auth-cookies.test.js` |
| Security fix | Both a unit test for the fix mechanism AND an integration test proving the vulnerability is closed | Dedicated file (e.g. `tests/security-hardening.test.js`) |
| Pipeline stage change | Unit tests in `tests/pipeline.test.js` or `tests/pipeline-orchestrator.test.js` | Existing pipeline test files |

**Register every new test file** in `backend/tests/run-tests.js` so `npm test` runs it.

### Backend

Tests live in `backend/tests/` and use Node's built-in `assert/strict` — no test framework. Run with:

```bash
node tests/pipeline.test.js
node tests/self-healing.test.js
node tests/code-parsing.test.js
node tests/api-flow.test.js
node tests/auth-cookies.test.js
node tests/password-reset-token.test.js
node tests/security-hardening.test.js
node tests/artifact-signing.test.js
```

Or run all at once: `npm test` from `backend/`.

#### Test file conventions

- Each test file must include a final summary line showing pass/fail counts and exit with `process.exit(1)` on any failure.
- Tests are synchronous where possible. Async tests must `await` all assertions before the test function returns.
- Integration tests use a shared SQLite database file. Reset state between tests by calling `getDatabase().exec("DELETE FROM ...")` on each table and resetting counters. Seed test data using repository modules (`projectRepo.create(...)`, `testRepo.create(...)`, etc.) — never use `getDb()` for writes in tests.
- **Unit tests** (repositories, utilities) use the synchronous `test(name, fn)` pattern — no HTTP server needed.
- **Integration tests** (route handlers, auth flows) spin up the Express app on a random port via `app.listen(0)`, make real HTTP requests, and shut down in a `finally` block.
- **Shared test helpers** live in `backend/tests/helpers/test-base.js`. Use `createTestContext()` to get a pre-wired bundle of utilities: `req()` (CSRF-aware HTTP), `resetDb()`, `setupEnv()`, `registerAndLogin()`, `extractCookie()`, `parseCookies()`, `buildCookieHeader()`, `decodeJwtPayload()`, and `createTestRunner()`. New integration tests should import from `test-base.js` instead of duplicating these patterns.

#### What makes a good test

```js
// ✅ Unit test — tests one function, one behaviour, clear assertion
test("claim() returns null for an already-used token", () => {
  resetTokenRepo.create("tok-1", "U-1", futureExpiry);
  resetTokenRepo.claim("tok-1");                        // first claim succeeds
  assert.equal(resetTokenRepo.claim("tok-1"), null);    // second claim must fail
});

// ✅ Integration test — exercises the full HTTP path including auth
out = await req(base, "/api/auth/reset-password", {
  method: "POST",
  body: { token: usedToken, newPassword: "New123!" },
});
assert.equal(out.res.status, 400, "Replaying a used token should fail");

// ❌ No assertion — test always passes
test("creates a token", () => {
  resetTokenRepo.create("tok-1", "U-1", futureExpiry);
});

// ❌ Tests implementation detail instead of behaviour
test("SQL query contains WHERE usedAt IS NULL", () => { … });
```

### Frontend

Tests live in `frontend/tests/` and also use plain Node `assert`. Run with `npm test` from `frontend/`.

---

## Pipeline Architecture

The 8-stage AI generation pipeline is the core of Sentri. Understand it before touching any pipeline file.

```
Stage 1  pageSnapshot.js        Capture DOM snapshot + classify page intent
Stage 2  elementFilter.js       Filter interactive elements (remove noise, socials, etc.)
Stage 3  intentClassifier.js    Classify element intent; build user journeys
Stage 4  journeyGenerator.js    Generate test plans (PLAN phase, avoids token truncation)
Stage 5  deduplicator.js        4-layer dedup: structural hash → fuzzy name → semantic TF-IDF → description
Stage 6  assertionEnhancer.js   Strengthen weak/missing assertions using page context
Stage 7  testValidator.js       Structural + locator + action method + assertion chain validation
Stage 8  testPersistence.js     Write validated tests to DB as "draft" status
```

Stages 5–7 are shared between `generateSingleTest` and `crawlAndGenerateTests` via `pipelineOrchestrator.js`. Any change to these stages must go through that module — do not duplicate the logic.

### Stage 5 — Deduplicator detail

`deduplicator.js` runs four layers in order; a test is eliminated the moment any layer matches:

| Layer | Mechanism | Threshold | Defect resolved |
|-------|-----------|-----------|-----------------|
| 1 | Structural hash (SHA-256 of Playwright actions + description) | exact | #4 (description now included) |
| 2 | Normalised name + same `sourceUrl` | exact, length ≥ 15 chars | existing |
| 3 | Fuzzy name — Levenshtein similarity | ≥ 0.80 | #3 (paraphrased names) |
| 4 | Semantic TF-IDF cosine — name + description + steps | ≥ 0.65 | #1, #2 (semantic duplicates) |

Exported constants `FUZZY_NAME_THRESHOLD` and `SEMANTIC_SIMILARITY_THRESHOLD` let tests override thresholds without editing production code. The TF-IDF stop-word list is intentionally conservative: it strips common English words and generic QA verbs so domain-specific nouns (feature names, form field names, page routes) carry the signal.

**Performance note:** Layers 3 and 4 are O(n²) over the post-layer-1 set. This is acceptable for typical batch sizes (< 200 tests) but should be revisited if batches routinely exceed 1 000.

---

### Stage 7 — Validator detail

`testValidator.js` runs four validation passes in sequence. All collected issues are returned; the pipeline rejects any test with at least one issue.

| Pass | Function | What it catches | Defect |
|------|----------|-----------------|--------|
| Structural | (inline in `validateTest`) | Missing name/steps, placeholder URLs, missing `async`, missing `page.goto` | existing |
| Locator | `validateLocators(code)` | Unbalanced CSS brackets, unknown pseudo-classes, overly-deep selectors, malformed XPath (`//[@`) | #1 |
| Action | `validateActions(code)` | Method calls on `page`/`locator`/`frame`/`request` not in the Playwright API whitelist (e.g. `.clicks()`, `.fillIn()`) | #2 |
| Assertion | `validateAssertions(code)` | Matcher typos in `expect()` chains (e.g. `toHavURL`), logically-redundant `.not.toBeHidden()` | #3 |

Deep validation (passes 2–4) only runs **after** Acorn confirms the code is syntactically valid, so regex passes never operate on malformed code.

**Extending the whitelists:** add entries to `VALID_PAGE_ACTIONS` or `VALID_MATCHERS` in `testValidator.js` when Playwright releases new APIs. Do not inline these sets into other files.

---

## Self-Healing System

The self-healing system in `selfHealing.js` uses a strategy waterfall:

```
1. getByRole (ARIA role + accessible name)   ← most semantic, tried first
2. getByLabel
3. getByText
4. getAttribute(aria-label)
5. getAttribute(title)
6. locator(CSS selector)                     ← least semantic, last resort
```

### Runtime helpers

All interactions in generated tests are routed through safe wrappers:

| Helper | Purpose |
|---|---|
| `safeClick(page, text)` | Click by accessible name/text |
| `safeDblClick(page, text)` | Double-click |
| `safeHover(page, text)` | Hover (menus, tooltips) |
| `safeFill(page, label, value)` | Fill input fields |
| `safeSelect(page, label, value)` | Select/dropdown (preserves object/array values) |
| `safeCheck(page, label)` | Check checkbox/radio |
| `safeUncheck(page, label)` | Uncheck checkbox/radio |
| `safeExpect(page, expect, text, role?)` | Visibility assertions |

`applyHealingTransforms()` rewrites raw Playwright calls (e.g. `page.click(...)`, `page.locator(...).check()`) into the safe helpers. When adding new transform rules, ensure **every** Playwright call pattern listed in `SELF_HEALING_PROMPT_RULES` has a corresponding regex in `applyHealingTransforms`.

### Healing history & versioned scoping

On every test run, the winning strategy index is recorded in `db.healingHistory`. Keys are **versioned** by test code revision: `"<testId>@v<codeVersion>::<action>::<label>"`. This ensures stale hints from old code versions don't pollute current runs. The repository layer (`healingRepo.getByTestId`) reads both versioned and legacy (unversioned) keys for backward compatibility.

### Fail-count cap

Hints that have failed `≥ HEALING_HINT_MAX_FAILS` (default 3, env-configurable) consecutive times are skipped by both `getHealingHint()` and `getHealingHistoryForTest()`. This prevents the runtime from retrying strategies that are known-broken.

### Visibility wait cap

The `firstVisible()` helper caps its `waitFor` timeout at `HEALING_VISIBLE_WAIT_CAP` (default 1200ms, env-configurable) to avoid slow waterfalls when a strategy doesn't match. The full retry loop still provides multiple attempts.

### Adding new selector strategies

- Add them to the `strategies` array in the helper code returned by `getSelfHealingHelperCode()`.
- Keep strategies ordered from most-semantic (ARIA) to least-semantic (CSS), so the adaptive hint system consistently learns the best approach.
- Bump `STRATEGY_VERSION` in `selfHealing.js` when reordering or removing strategies — hints from older versions are automatically ignored.
- Do not change the healing key schema (`<testId>@v<version>::<action>::<label>`) without a migration strategy — existing DB records will silently stop matching.

---

## AI Chat System

The AI chat assistant (`⌘K` or top bar trigger) streams responses via `POST /api/chat` (SSE). It is **context-aware** — the system prompt is enriched with live workspace data on every request.

### Context Tiers

| Tier | What | How | Token cost |
|---|---|---|---|
| **Tier 1 — Workspace summary** | Projects, test counts, recent runs, failing tests, pass rate | `buildWorkspaceContext()` reads from repository modules on every request | ~200-400 tokens |
| **Tier 2 — Entity deep-dive** | Full test steps, Playwright code, run errors, project details | `buildEntityContext()` scans the user message for `TC-*`, `RUN-*`, `PRJ-*` IDs and fetches details | ~100-800 tokens per entity |

Both tiers are **read-only** — no DB writes, no mutations, no actions. The AI cannot approve tests, trigger runs, or modify data.

### How entity detection works

When the user types "Why is **TC-15** failing in **RUN-42**?", the backend:
1. Regex-matches `TC-15` and `RUN-42` from the message
2. Fetches the test's name, steps, Playwright code, quality score, and last error
3. Fetches the run's status, pass/fail counts, and failed test error messages
4. Appends both as structured text blocks to the system prompt

### Safety limits

- Max **5 tests**, **3 runs**, **3 projects** per message
- Playwright code capped at **1500 chars**, errors at **500 chars**, descriptions at **300 chars**
- No credentials, API keys, or user passwords are ever included
- If no projects exist, the workspace context is omitted entirely

### Key files

| File | Role |
|---|---|
| `backend/src/routes/chat.js` | SSE endpoint, system prompt, `buildWorkspaceContext()`, `buildEntityContext()` |
| `frontend/src/components/ai/AIChat.jsx` | Chat modal panel UI, streaming display |
| `frontend/src/pages/ChatHistory.jsx` | Full-page chat at `/chat` — session CRUD, export, persistent history |
| `frontend/src/utils/markdown.js` | Shared `escapeHtml()` + `renderMarkdown()` used by both chat UIs |
| `frontend/src/api.js` → `api.chat()` | SSE stream parser with 401 handling |
| `frontend/src/styles/features/chat.css` | Modal chat styles (`.chat-*` namespace) |
| `frontend/src/styles/pages/chat-history.css` | Full-page chat styles (`.ch-*` namespace) |

### Sliding context window

Long conversations are automatically trimmed by `trimConversationHistory()` before the prompt is built. It keeps the first message (initial context) and the most recent `MAX_CONVERSATION_TURNS` turn pairs (default 20), cutting at an assistant boundary so user↔assistant pairs are never split. This is pure truncation — zero extra LLM calls.

### When modifying the chat system

- **Adding new context**: Add to `buildWorkspaceContext()` or `buildEntityContext()` in `backend/src/routes/chat.js`. Keep output compact — every token costs money.
- **Adding new entity types**: Add a regex pattern + DB lookup in `buildEntityContext()`. Follow the existing pattern: match IDs, cap results, truncate long fields.
- **Changing the system prompt**: Edit `BASE_SYSTEM_PROMPT` in `backend/src/routes/chat.js`. The workspace/entity context is appended automatically — don't hardcode data in the base prompt.
- **Frontend changes**: Modal chat styles go in `frontend/src/styles/features/chat.css` (`.chat-*`); full-page chat styles go in `frontend/src/styles/pages/chat-history.css` (`.ch-*`). The shared markdown renderer in `frontend/src/utils/markdown.js` escapes all non-code text before applying transforms — maintain this pattern to prevent XSS. Both `AIChat.jsx` and `ChatHistory.jsx` import `renderMarkdown` from this shared module.

---

## Dependency Management

- **Renovate** is configured for automated dependency updates (`.github/renovate.json`). Minor and patch updates are auto-merged via branch strategy.
- **Adding a new dependency**: Prefer lightweight, well-maintained packages. Check bundle size impact for frontend deps (use [bundlephobia.com](https://bundlephobia.com)). Justify the addition in the PR description.
- **`dependencies` vs `devDependencies`**: Runtime packages go in `dependencies`. Build tools, test utilities, and type stubs go in `devDependencies`. Playwright is in `dependencies` (backend) because it runs in production.
- **Lock files**: `package-lock.json` should be committed for both `backend/` and `frontend/`. Run `npm install` (not `npm ci`) only when changing dependencies; use `npm ci` in Docker builds and CI for reproducibility.
- **Node version enforcement**: Both `package.json` files should include `"engines": { "node": ">=20" }`. The runtime requirement is Node 20+ for ESM, `structuredClone`, `AbortSignal.timeout`, and `crypto.subtle`.

---

## Docker & Deployment

- `docker-compose.yml` — local development and production (pulls from GHCR).
- `docker-compose.prod.yml` — production overrides (stricter resource limits).
- The frontend Dockerfile builds the Vite SPA and serves it with nginx. The nginx config proxies `/api/*` to the backend container.
- **Never bake secrets into images.** Pass all keys via environment variables. The `.dockerignore` already excludes `.env` files.
- `backend/data/` is a Docker volume — it persists `sentri.db` (SQLite) across container restarts.
- The backend Dockerfile installs Playwright's system dependencies and uses the system Chromium (`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`).

### Health Checks

The backend exposes `GET /health` (unauthenticated) returning `{ ok: true }`. Docker Compose uses this for container health checks (`docker-compose.yml` — interval 10s, 5 retries, 20s start period). The frontend container depends on `backend: condition: service_healthy` to ensure the API is ready before nginx starts proxying.

### Cross-Origin Deployment (GitHub Pages + Render)

The primary deployment model is **cross-origin**: the frontend SPA is hosted on GitHub Pages (`https://<user>.github.io/sentri/`) and the backend runs on Render (`https://sentri-api.onrender.com`). These are different origins, which has several implications:

**Required environment variables:**

| Variable | Set on | Example |
|---|---|---|
| `CORS_ORIGIN` | Backend (Render) | `https://<user>.github.io` |
| `VITE_API_URL` | Frontend build (GitHub Pages) | `https://sentri-api.onrender.com` |
| `GITHUB_PAGES` | Frontend build | `true` (sets Vite `base: "/sentri/"`) |

**Cookie behavior:**
- `isCrossOrigin` in `middleware/appSetup.js` detects cross-origin mode at startup by comparing `CORS_ORIGIN` against the backend's own origin.
- When cross-origin, all cookies use `SameSite=None; Secure` instead of `SameSite=Strict` — required by browsers for cross-site cookie sending.
- The `token_exp` hint cookie may be unreadable by frontend JS (third-party cookie restrictions). `AuthContext.jsx` handles this by falling back to a 55-minute fixed-interval refresh when `readExpCookie()` returns 0.
- The HttpOnly `access_token` cookie is still sent via `credentials: "include"` on every fetch — browsers allow this even when JS can't read the cookie.

**When adding new features, verify cross-origin compatibility:**
- All `fetch()` calls must include `credentials: "include"` (handled by `api.js`'s `req()` wrapper and `AuthContext`'s `authFetch()`).
- New cookies must use `cookieSameSite()` from `appSetup.js` — never hardcode `SameSite=Strict`.
- New CSP `connect-src` entries may need the backend origin added for cross-origin deployments.
- SSE endpoints (`EventSource`) must be created with `{ withCredentials: true }` to send cookies cross-origin (see `useRunSSE.js`).
- Download URLs that bypass `fetch()` (e.g. `<a href>` for CSV exports) must include the auth token as a query param or use a signed URL pattern (see `signArtifactUrl()`).

### Local Development (without Docker)

```bash
# Terminal 1 — backend (auto-restarts on file changes)
cd backend && npm install && npm run dev

# Terminal 2 — frontend (Vite dev server with HMR)
cd frontend && npm install && npm run dev
```

The Vite dev server proxies `/api/*` to `http://localhost:3001` automatically. In local dev, everything is same-origin — no cross-origin cookie issues.

---

## Monitoring & Observability

> **Status**: No external monitoring or APM tools are configured. Structured logging is in place.

Current observability:

- **Health endpoint**: `GET /health` — use for uptime monitoring (e.g. UptimeRobot, Pingdom).
- **System info**: `GET /api/system` (authenticated) — returns uptime, Node/Playwright versions, memory usage, DB record counts, and `activeSchedules` (number of armed cron tasks).
- **Structured logging**: All backend logs go through `formatLogLine()` from `utils/logFormatter.js`. Set `LOG_JSON=true` for machine-parseable JSON lines (compatible with Datadog, Cloud Logging, etc.). Semantic lifecycle events (`run.start`, `browser.launched`, `run.complete`, etc.) are emitted via `structuredLog()`.
- **SSE events**: Real-time run progress is streamed to the frontend via Server-Sent Events.

When adding external observability, consider:
- APM integration (Datadog, New Relic) for request tracing.
- Error tracking (Sentry) for both backend and frontend.

---

## Security Checklist

Before submitting any PR that touches auth, routes, or data handling, verify:

- [ ] Passwords are hashed with `hashPassword()` (scrypt, random salt) — never stored plaintext.
- [ ] JWTs are validated with `requireAuth` (or `requireUser`/`requireTrigger` from `middleware/authenticate.js`) on every non-public endpoint.
- [ ] JWTs are stored in HttpOnly cookies only — never returned in response bodies or stored in localStorage.
- [ ] Mutating endpoints (POST/PATCH/PUT/DELETE) are protected by CSRF double-submit cookie validation (handled by `csrfMiddleware` in `appSetup.js`). Non-cookie auth strategies are auto-exempt. Public mutation paths must be added to `CSRF_EXEMPT_PATHS`.
- [ ] User-supplied strings are validated with `utils/validate.js` before DB writes.
- [ ] No sensitive data (API keys, passwords, full JWTs) is returned in API responses. Use `maskKey()` for display.
- [ ] Credential values stored in the DB use `credentialEncryption.js`.
- [ ] Any HTML rendered via `dangerouslySetInnerHTML` is sanitised — escape all user/AI-generated content before insertion. Use `escapeHtml()` on raw text before applying markdown/formatting transforms.
- [ ] Error responses to clients never leak internal details (stack traces, SDK error messages, API key validation failures). Return generic messages for 5xx errors.

### Resolved Security Items

The following have been implemented and are no longer open:

- **Cookie-based auth** ✅: JWTs are stored in `access_token` HttpOnly; Secure; SameSite=Strict cookies. A `token_exp` cookie (Non-HttpOnly) exposes only the expiry timestamp for frontend UX. Tokens are never returned in response bodies or stored in localStorage.
- **CSRF protection** ✅: Double-submit cookie pattern via `_csrf` cookie + `X-CSRF-Token` header. All mutating endpoints are validated by `csrfMiddleware` in `appSetup.js`. Auth endpoints are exempt via `CSRF_EXEMPT_PATHS`.
- **Session refresh** ✅: `POST /api/auth/refresh` issues a new token and revokes the old one. Frontend proactively refreshes 5 minutes before expiry.
- **Auth rate limiting** ✅: Per-endpoint rate limiters in `routes/auth.js` — separate buckets for login (10/IP/15 min), forgot-password (5), and reset-password (5). Uses `trust proxy` for correct IP detection behind nginx.
- **Global API rate limiting** ✅: Three-tier `express-rate-limit` in `middleware/appSetup.js` — general (300 req/15 min for all `/api/*`), expensive operations (20/hr for crawl/run), AI generation (30/hr for test generation). In-memory store; swap to Redis for horizontal scaling.
- **Content-Security-Policy** ✅: Helmet CSP is fully enabled in `middleware/appSetup.js` with explicit directives (`default-src 'self'`, `script-src 'self' 'unsafe-inline'`, `connect-src 'self'`, `frame-ancestors 'none'`, etc.). Tighten `'unsafe-inline'` to nonce-based in production.
- **Reset token exposure** ✅: The forgot-password endpoint only returns the reset token in the response when `ENABLE_DEV_RESET_TOKENS=true` is explicitly set. Absence of a production flag is no longer sufficient to leak tokens.
- **DB-backed password reset tokens** ✅: Reset tokens are persisted in the `password_reset_tokens` SQLite table (migration 003) via `passwordResetTokenRepo`. Tokens survive server restarts, support multi-instance deployments, and use atomic `claim()` to prevent TOCTOU double-use. A `usedAt` column provides one-time-use enforcement with an audit trail.
- **Per-user audit trail** ✅: Every activity log entry records `userId` and `userName` (migration 004). The `actor(req)` utility in `utils/actor.js` extracts identity from `req.authUser` (JWT payload includes `name`). Bulk approve/reject/restore actions log per-test entries with the acting user's identity.
- **Artifact authentication** ✅: The `/artifacts` route is protected by HMAC-SHA256 signed `?token=&exp=` query-param tokens (1 hour TTL, configurable via `ARTIFACT_TOKEN_TTL_MS`). `ARTIFACT_SECRET` is required in production; dev uses a random per-process secret. `signArtifactUrl()` in `middleware/appSetup.js` generates signed URLs; all artifact producers (screenshots, videos, traces) use it. `Cache-Control: private, no-store` prevents browsers from caching expiring URLs.
- **Secrets scanning** ✅: Gitleaks runs on every PR and push to `main` via the `secrets` CI job (`.github/workflows/ci.yml`). Both `lint` and `build` jobs depend on it, gating the entire pipeline. Configuration in `.github/.gitleaks.toml` extends the default ruleset with allowlists for CI placeholders and `.env.example` files.
- **Nonce-based CSP** ✅: Per-request nonce generated via `crypto.randomBytes(16)` in `middleware/appSetup.js`, passed to Helmet CSP `scriptSrc` as `'nonce-<value>'`. Vite `transformIndexHtml` plugin injects `nonce="__CSP_NONCE__"` on all `<script>` tags; `serveIndexWithNonce()` replaces the placeholder at serve-time. `'unsafe-inline'` removed from `scriptSrc` (SEC-002).
- **GDPR/CCPA account export & deletion** ✅: `GET /api/auth/export` returns a JSON archive of all user-owned data (workspaces, projects, tests, runs, activities, schedules, notification settings) with `passwordHash` stripped. `DELETE /api/auth/account` hard-deletes the user and all owned data in a single transaction. Both require password confirmation (403 on mismatch). Frontend Account tab in Settings with two-click confirm flow (SEC-003).

### Known Security Gaps (TODO)

The following are **not yet implemented** but should be addressed before production:

- **Error tracking**: No external error tracking (Sentry, etc.) is configured. Errors are only visible in server logs and browser console.

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
| `DATABASE_URL` | No | — | PostgreSQL connection string (`postgres://…`). When set, uses PostgreSQL instead of SQLite. Requires `pg` + `pg-native`. |
| `PG_POOL_SIZE` | No | `10` | Max PostgreSQL connection pool size (ignored for SQLite) |
| `REDIS_URL` | No | — | Redis connection URL (`redis://…`). When set, enables Redis-backed rate limiting, token revocation, and cross-instance SSE pub/sub. Requires `ioredis`. |
| `PORT` | No | `3001` | Backend HTTP port |
| `CORS_ORIGIN` | No | `*` | Allowed frontend origin(s), comma-separated |
| `PARALLEL_WORKERS` | No | `1` | Default test parallelism |
| `LLM_MAX_TOKENS` | No | `16384` | Max tokens per LLM call |
| `LLM_MAX_RETRIES` | No | `3` | Retry count on rate limits |
| `LLM_BASE_DELAY_MS` | No | `2000` | Base back-off delay |
| `LLM_MAX_BACKOFF_MS` | No | `30000` | Max computed backoff delay (server Retry-After capped at 2×) |
| `BROWSER_TEST_TIMEOUT` | No | `120000` | Per-test timeout guard — aborts hung browser tests (ms) |
| `NODE_ENV` | No | `development` | Enables dev-only seed endpoint when not `production` |
| `HEALING_ELEMENT_TIMEOUT` | No | `5000` | Per-strategy element wait timeout (ms) |
| `HEALING_RETRY_COUNT` | No | `3` | Number of retry attempts per self-healing action |
| `HEALING_RETRY_DELAY` | No | `400` | Delay between retries (ms) |
| `HEALING_HINT_MAX_FAILS` | No | `3` | Skip healing hints that have failed this many consecutive times |
| `HEALING_VISIBLE_WAIT_CAP` | No | `1200` | Max `waitFor` timeout per strategy in `firstVisible` (ms) |
| `ENABLE_DEV_RESET_TOKENS` | No | `false` | When `"true"`, forgot-password response includes the reset token (dev/test only) |
| `MAX_CONVERSATION_TURNS` | No | `20` | Max user↔assistant turn pairs in chat context window (sliding window trims older turns) |
| `ARTIFACT_SECRET` | Yes (prod) | random (dev) | HMAC-SHA256 key for signing artifact URLs. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `ARTIFACT_TOKEN_TTL_MS` | No | `3600000` (1 hr) | Lifetime of signed artifact URL tokens (ms) |
| `RESEND_API_KEY` | No | — | Resend API key for transactional email |
| `SMTP_HOST` | No | — | SMTP server host (alternative to Resend) |
| `SMTP_PORT` | No | `587` | SMTP server port |
| `SMTP_SECURE` | No | `false` | Use TLS for SMTP |
| `SMTP_USER` | No | — | SMTP username |
| `SMTP_PASS` | No | — | SMTP password |
| `EMAIL_FROM` | No | `Sentri <noreply@sentri.dev>` | Sender address for transactional emails |
| `SKIP_EMAIL_VERIFICATION` | No | `false` | When `"true"`, registration auto-verifies users (dev/CI only — never set in production) |

---

## Common Tasks

### Adding a New API Endpoint

1. Add the handler to the appropriate file in `backend/src/routes/`.
2. Mount it in `index.js` behind `requireAuth` unless it is explicitly public or uses a different auth strategy (e.g. `requireTrigger` for CI/CD endpoints).
3. If the endpoint uses a new auth strategy, add it to `middleware/authenticate.js` (see "Authentication Architecture"). Non-cookie strategies are CSRF-exempt automatically. Public mutation paths must be added to `CSRF_EXEMPT_PATHS` in `appSetup.js`.
4. Add a JSDoc block documenting method, path, auth requirement, request body, and response shape.
5. Add a corresponding function in `frontend/src/api.js`. The `req()` wrapper auto-injects `credentials: "include"` and `X-CSRF-Token` — no manual auth handling needed.
6. Write a test in `backend/tests/api-flow.test.js` or a dedicated test file. Register it in `backend/tests/run-tests.js`.

### Adding a New Pipeline Stage

1. Create `backend/src/pipeline/myStage.js` with named exports and full JSDoc.
2. Insert the stage call in `pipelineOrchestrator.js` or the relevant orchestrator (`crawler.js`, `testDials.js`).
3. Update the `setStep(run, N)` calls so the step counter stays accurate.
4. Add unit tests in `backend/tests/pipeline.test.js`.

### Adding a New AI Provider

1. Add detection logic to `detectProvider()` in `aiProvider.js`.
2. Add a `callProvider` branch for non-streaming calls.
3. Add a `streamText` branch (or fall back to the blocking-call synthetic-token pattern).
4. Add metadata to `buildProviderMeta()`.
5. Export masked key display support from `getConfiguredKeys()`.
6. Add the provider to the Settings UI in `frontend/src/pages/Settings.jsx`.

### Adding a New React Page

1. Create `frontend/src/pages/MyPage.jsx`.
2. Lazy-import it in `App.jsx` and add a `<Route>` inside the `<Layout>` wrapper.
3. Add a `<NavLink>` to `frontend/src/components/layout/Sidebar.jsx` if it appears in the sidebar.
4. Create a corresponding CSS file in `frontend/src/styles/pages/my-page.css` and import it from the component.

### Page Responsibilities (UX Architecture)

The frontend follows a clear separation of concerns between pages:

| Page | Role | Key actions |
|---|---|---|
| **Dashboard** | Read-only analytics hub | Pass rate, trends, defects, recent activity |
| **Tests** (`Tests.jsx`) | **Central command centre** for all test creation | Crawl a project, Generate from story, Run regression, Review drafts |
| **ProjectDetail** | Project-scoped execution & review | Run regression, review/approve/reject this project's tests, export, traceability |
| **Automation** (`/automation`) | Cross-project automation hub | CI/CD trigger tokens, scheduled runs (ENH-006), integration snippets; deep-link via `?project=PRJ-X` |
| **Projects** | Project list & creation | Create/delete projects |
| **Runs** / **RunDetail** | Run history & live execution view | View logs, results, abort |
| **ChatHistory** (`/chat`) | Full-page AI chat with session history | New/rename/delete sessions, search, export (Markdown/JSON), persistent localStorage per user |
| **Settings** | AI provider & system config | API keys, Ollama, system info, Recycle Bin (restore/purge deleted items) |

**Important**: Crawl and test generation are **only** triggered from the Tests page (via `CrawlProjectModal` and `GenerateTestModal`). The ProjectDetail page links back to Tests via a "Generate more tests →" button — it does not have its own crawl controls. This avoids duplicating creation flows across pages.

---

## Versioning & Releases

Sentri uses **automatic semantic versioning** driven by [Conventional Commits](https://www.conventionalcommits.org/).

### How it works

1. **Developer** writes PR title as a Conventional Commit (e.g. `feat: add rate limiting`).
2. **PR is squash-merged** to `main` — the PR title becomes the commit message.
3. **`.github/workflows/release.yml`** runs on push to `main`:
   - Scans commits since the last `v*` tag for `feat:`, `fix:`, `perf:`, `BREAKING CHANGE:`.
   - Determines the bump level (major / minor / patch). If no bumping prefix is found, the workflow exits — no release.
   - Updates `version` in `backend/package.json`, `frontend/package.json`, and `docs/package.json`.
   - Promotes `## [Unreleased]` in `docs/changelog.md` to `## [X.Y.Z] — YYYY-MM-DD` and adds a fresh `[Unreleased]` section.
   - Commits `chore(release): vX.Y.Z`, creates a `vX.Y.Z` git tag, and pushes.
   - Creates a **GitHub Release** with release notes extracted from the changelog.
4. **`.github/workflows/cd.yml`** triggers on the new `v*` tag:
   - Docker images are tagged with `X.Y.Z`, `X.Y`, `sha-<commit>`, and `latest`.
   - GitHub Pages is deployed with the updated docs.

### What you need to do in every PR

1. Write the PR title as a Conventional Commit (`feat:`, `fix:`, etc.).
2. Update `docs/changelog.md` under `## [Unreleased]` (see Changelog section below).
3. That's it — versioning, tagging, and releases are fully automated.

### Changelog

Sentri follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) standard. The changelog lives at `docs/changelog.md` and is published on the docs site.

**Every PR that adds user-visible features, fixes, security changes, or breaking changes MUST update `docs/changelog.md`.**

#### Format rules

- Entries go under the `## [Unreleased]` section at the top of the file.
- When a version is released, rename `[Unreleased]` to `[X.Y.Z] — YYYY-MM-DD` and add a fresh `[Unreleased]` above it.
- Group entries under these headings (omit empty groups):

  | Heading | When to use |
  |---|---|
  | `### Added` | New features, new endpoints, new UI pages |
  | `### Changed` | Behaviour changes to existing features (non-breaking) |
  | `### Deprecated` | Features that will be removed in a future version |
  | `### Removed` | Features or APIs that were removed |
  | `### Fixed` | Bug fixes |
  | `### Security` | Vulnerability patches, auth hardening, rate limiting changes |

- Each entry is a single bullet point starting with the area in bold: `- **Auth**: ...`, `- **API**: ...`, `- **Tests**: ...`, `- **Dashboard**: ...`, etc.
- Reference the PR number at the end: `(#78)`.
- Write from the user's perspective — what changed for them, not internal refactoring details.

#### Example

```markdown
## [Unreleased]

### Added
- **API**: Three-tier global rate limiting — 300 req/15 min general, 20/hr for crawl/run, 30/hr for AI generation (#78)

### Fixed
- **Auth**: Password reset tokens now survive server restarts (DB-backed via migration 003) (#78)

### Security
- **Auth**: Atomic token claim prevents concurrent replay of password reset tokens (TOCTOU fix) (#78)
```

#### What does NOT need a changelog entry

- Internal refactors with no user-visible effect (e.g. extracting a shared utility)
- Test-only changes
- Documentation-only changes (unless they document a new feature)
- CI/CD pipeline changes

---

## What Not to Do

- **Do not use `require()` anywhere.** The entire repo is ES Modules.
- **Do not import LLM SDKs directly** outside of `aiProvider.js`.
- **Do not call `fetch()` directly** in frontend components; use `api.js`. Streaming endpoints that bypass `req()` must still handle 401 via `handleUnauthorized()`, send `credentials: "include"`, and include `X-CSRF-Token` on mutating requests.
- **Do not return JWTs in response bodies.** Auth cookies are set via `setAuthCookie()` — the token string must never appear in JSON responses.
- **Do not store tokens in localStorage.** The JWT lives exclusively in the HttpOnly `access_token` cookie. Only the safe user profile (`app_auth_user`) is stored in localStorage.
- **Do not store secrets in code or commit `.env` files.**
- **Do not change the `healingHistory` key schema** (`<testId>@v<version>::<action>::<label>`) without a migration strategy — existing DB records will silently stop matching. The repository layer reads both versioned and legacy keys, but new writes always use the versioned format.
- **Do not add polling** to the frontend for run status — use the existing SSE infrastructure (`useRunSSE`).
- **Do not add a new test framework** to either package. Backend tests use `node:assert/strict`; keep it that way.
- **Do not write raw SQL in route handlers** — always go through repository modules in `database/repositories/`. Do not import `getDb()` or `saveDb()` from `db.js` — the file is deprecated and emptied.
- **Do not skip `throwIfAborted(signal)`** in pipeline or runner stages — it breaks the abort/cancel feature.
- **Do not use `dangerouslySetInnerHTML`** without escaping all dynamic content first. AI/user-generated text must be sanitised before DOM insertion to prevent XSS.
- **Do not leak internal error details** to clients. Catch SDK/provider errors and return generic messages via `classifyError()`. Log the real error server-side with `formatLogLine()`.
- **Do not use bare `console.error` / `console.log`** for application logging. Always use `formatLogLine()` from `utils/logFormatter.js` (or `logError(run, …)` / `logWarn(run, …)` when a run object is available) so all output has consistent timestamps, levels, and respects `LOG_JSON` mode.
- **Do not omit `X-Accel-Buffering: no`** on SSE endpoints — nginx will buffer the stream and break real-time delivery.
- **Do not add large dependencies** without justification. Check bundle size impact for frontend packages and document the rationale in the PR.
- **Do not duplicate shared utilities.** Check `backend/src/utils/` and `frontend/src/utils/` before writing helpers like `escapeHtml`, `formatDuration`, `debounce`, etc. If a helper exists, import it. If it doesn't, create it in the shared `utils/` directory — not inline in a component.
- **Do not hardcode `SameSite=Strict` on cookies.** Always use `cookieSameSite()` from `middleware/appSetup.js` — the production deployment is cross-origin (GitHub Pages + Render) and requires `SameSite=None; Secure`.
- **Do not reinvent CSS classes.** Check `components.css` and `utilities.css` before adding new styles. Use `.btn`, `.card`, `.badge`, `.modal-*`, `.input`, `.flex-*`, `.text-*` etc. instead of writing equivalent inline styles or new classes.
- **Do not add CSS to `index.css` directly.** New styles go into the appropriate ITCSS partial (`components.css`, `features/*.css`, `pages/*.css`, or `utilities.css`) and are imported from `index.css`.
- **Do not skip the changelog.** Every PR with user-visible features, fixes, or security changes must add entries to the `## [Unreleased]` section of `docs/changelog.md` following the [Keep a Changelog](https://keepachangelog.com/) format. See the Versioning & Releases section for format rules.
- **Do not submit PRs without tests.** Every new repository, utility, endpoint, bug fix, and security fix requires corresponding unit and/or integration tests. Register new test files in `backend/tests/run-tests.js`. See the Testing section for the full requirements table.
- **Do not duplicate test helpers.** Integration test utilities (`extractCookie`, `resetDb`, `req` with CSRF, `registerAndLogin`, `setupEnv`, `createTestRunner`) live in `backend/tests/helpers/test-base.js`. Import from there — do not copy these functions into new test files.
- **Do not use TypeScript syntax in JSDoc comments.** This project uses plain JSDoc, not TypeScript. The CI pipeline runs `jsdoc` and will **fail** on TS-only syntax. In particular: never use `prop?: type` (optional property) in inline record types — use `@typedef` with `@property {type} [prop]` instead. Never use `type?` for nullable — use `{type|null}` or `{?type}`. See the "JSDoc type syntax rules" section for the full reference.
