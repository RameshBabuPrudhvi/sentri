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
    db.js                  SQLite compatibility shim (getDb → snapshot, saveDb → no-op)
    database/
      sqlite.js            SQLite singleton (WAL mode, auto-schema)
      schema.sql           Table definitions, indexes, counter seeds
      migrate.js           One-time JSON → SQLite migration
      repositories/        Data access layer (counterRepo, userRepo, projectRepo, testRepo, runRepo, activityRepo, healingRepo)
    aiProvider.js          Multi-provider LLM abstraction (Anthropic/OpenAI/Google/Ollama)
    selfHealing.js         Adaptive selector waterfall + healing history
    crawler.js             Link-crawl orchestrator
    testRunner.js          Parallel test execution orchestrator
    middleware/            Express middleware (appSetup, CORS, Helmet)
    routes/                REST endpoints (auth, projects, tests, runs, sse, settings, dashboard, system, chat)
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

### DRY — No Duplication

Before writing new code, check whether a shared utility, component, or CSS class already exists. Duplicating logic that belongs in a shared module is a common agent mistake.

#### Backend shared utilities (`backend/src/utils/`)

| Module | What it provides | When to use |
|---|---|---|
| `abortHelper.js` | `throwIfAborted(signal)`, `isRunAborted()`, `finalizeRunIfNotAborted()` | Every pipeline/runner stage with I/O |
| `runLogger.js` | `log()`, `logWarn()`, `logError()`, `logSuccess()`, `emitRunEvent()` | All run-level logging and SSE |
| `errorClassifier.js` | `classifyError(err, context)`, `ERROR_CATEGORY` | Converting raw errors to user-friendly messages (runs, chat, activity logs) |
| `idGenerator.js` | `generateProjectId()`, `generateTestId()`, `generateRunId()` | Creating new domain objects |
| `validate.js` | `sanitise()`, `validateUrl()`, `validateProjectPayload()`, `validateTestPayload()`, etc. | All route input validation |
| `credentialEncryption.js` | `encryptCredentials()`, `decryptCredentials()` | Storing/reading project login credentials |
| `logFormatter.js` | `formatTimestamp()`, `formatLogLine()`, `shouldLog()` | Log formatting (used by runLogger) |

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

**When to create a new CSS file**:
- **Feature-scoped styles** → `frontend/src/styles/features/<feature>.css` — for self-contained features (e.g. chat, onboarding). Scope all classes under a namespace prefix (`.chat-*`, `.onboard-*`).
- **Page-specific styles** → `frontend/src/styles/pages/<page>.css` — for styles used only on one page.
- **New reusable component** → Add to `components.css` if it will be used across 2+ pages/features.
- **Always import** new CSS files from `frontend/src/index.css` in the correct ITCSS layer position.

#### Frontend shared JS

| Module | What it provides | When to use |
|---|---|---|
| `src/api.js` | All `api.*` methods, `getToken()`, `handleUnauthorized()` | Every backend call |
| `src/utils/api.js` | `API_BASE`, `parseJsonResponse()` | Base URL resolution, safe JSON parsing |
| `src/context/AuthContext.jsx` | `useAuth()` hook, login/logout/register | Auth state in any component |
| `src/hooks/useProjectData.js` | `useProjectData(projectId)` | Fetching project + tests + runs |
| `src/hooks/useRunSSE.js` | `useRunSSE(runId)` | Real-time run streaming |

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
- **Commit messages**: Imperative mood, concise summary. Prefix with area when helpful: `backend: add chat SSE endpoint`, `frontend: fix dark mode token`.
- **PR size**: Keep PRs focused — one feature or fix per PR. If a change touches >500 lines, consider splitting.
- **Merge strategy**: Squash-merge to `main`. Keep the PR title as the squash commit message.
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
- All routes except `/api/auth/*` and `/health` require `requireAuth` middleware.

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

### Database

Sentri uses **SQLite** (via `better-sqlite3`) with WAL mode. Data lives in `data/sentri.db`.

- **Repository pattern**: All DB access goes through repository modules in `backend/src/database/repositories/`. Never write raw SQL in route handlers.
- **`getDb()`** (in `db.js`) returns a read-only snapshot from SQLite. It exists as a backward-compatibility shim for pipeline code that still receives `db` as a parameter. **Do not use `getDb()` for writes** — use repository modules directly.
- **`saveDb()`** is a no-op. SQLite writes are synchronous and immediately durable.
- **Repositories**: `projectRepo`, `testRepo`, `runRepo`, `activityRepo`, `healingRepo`, `userRepo`, `counterRepo` — each in `backend/src/database/repositories/`.
- **JSON columns**: `steps`, `tags`, `logs`, `results`, `testQueue`, `credentials`, etc. are stored as JSON strings and auto-serialized/deserialized by the repository layer.
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

- Functional components only. Class components exist only in `App.jsx` (`ErrorBoundary`) for React's mandatory class API.
- Pages live in `src/pages/`, reusable UI in `src/components/`.
- Domain-specific sub-components live in subdirectories, e.g. `src/components/project/`, `src/components/test/`.
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

The `api.js` `req()` wrapper handles 401 responses globally — it clears the stored token and redirects to `/login`. Any new `api.*` method that bypasses `req()` (e.g. for streaming) **must** replicate the 401 handling by calling `handleUnauthorized()`.

### Error Handling (Frontend)

- The global `ErrorBoundary` in `App.jsx` catches render-time exceptions. Do not add additional top-level error boundaries unless isolating a specific widget.
- API errors should be caught in the calling component and displayed inline (e.g. a red banner or toast). Do not let errors propagate silently.
- No external error tracking service (Sentry, etc.) is configured yet. All frontend errors are visible only in the browser console.

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

> **Status**: No CI pipeline is configured yet. There are no GitHub Actions workflows in `.github/workflows/`.

Until CI is set up, **manually verify before every PR**:

```bash
# Backend — tests must all pass
cd backend && npm test

# Frontend — build must succeed with zero errors
cd frontend && npm run build

# Frontend — tests must pass
cd frontend && npm test
```

When CI is added, the pipeline should include at minimum:
1. **Lint** — ESLint / Prettier check (once configured).
2. **Backend tests** — `npm --prefix backend test`.
3. **Frontend build** — `npm --prefix frontend run build` (catches import errors, type issues).
4. **Frontend tests** — `npm --prefix frontend test`.
5. **Docker build** — Verify both Dockerfiles build successfully.

---

## Testing

### Backend

Tests live in `backend/tests/` and use Node's built-in `assert/strict` — no test framework. Run with:

```bash
node tests/pipeline.test.js
node tests/self-healing.test.js
node tests/code-parsing.test.js
node tests/api-flow.test.js
```

Or run all at once: `npm test` from `backend/`.

- Each test file must include a final summary line showing pass/fail counts and exit with `process.exit(1)` on any failure.
- Tests are synchronous where possible. Async tests must `await` all assertions before the test function returns.
- Integration tests use a shared SQLite database file. Reset state between tests by calling `getDatabase().exec("DELETE FROM ...")` on each table and resetting counters. Seed test data using repository modules (`projectRepo.create(...)`, `testRepo.create(...)`, etc.) — never use `getDb()` for writes in tests.

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
Stage 5  deduplicator.js        Hash+score dedup within batch and across existing tests
Stage 6  assertionEnhancer.js   Strengthen weak/missing assertions using page context
Stage 7  testValidator.js       Reject malformed, placeholder, or navigation-only tests
Stage 8  testPersistence.js     Write validated tests to DB as "draft" status
```

Stages 5–7 are shared between `generateSingleTest` and `crawlAndGenerateTests` via `pipelineOrchestrator.js`. Any change to these stages must go through that module — do not duplicate the logic.

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
| **Tier 1 — Workspace summary** | Projects, test counts, recent runs, failing tests, pass rate | `buildWorkspaceContext()` reads `getDb()` on every request | ~200-400 tokens |
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
| `frontend/src/components/AIChat.jsx` | Chat panel UI, markdown renderer, streaming display |
| `frontend/src/api.js` → `api.chat()` | SSE stream parser with 401 handling |
| `frontend/src/styles/features/chat.css` | All chat UI styles (`.chat-*` namespace) |

### When modifying the chat system

- **Adding new context**: Add to `buildWorkspaceContext()` or `buildEntityContext()` in `backend/src/routes/chat.js`. Keep output compact — every token costs money.
- **Adding new entity types**: Add a regex pattern + DB lookup in `buildEntityContext()`. Follow the existing pattern: match IDs, cap results, truncate long fields.
- **Changing the system prompt**: Edit `BASE_SYSTEM_PROMPT` in `backend/src/routes/chat.js`. The workspace/entity context is appended automatically — don't hardcode data in the base prompt.
- **Frontend changes**: All chat styles go in `frontend/src/styles/features/chat.css`. The markdown renderer in `AIChat.jsx` escapes all non-code text before applying transforms — maintain this pattern to prevent XSS.

---

## Dependency Management

- **No Dependabot or Renovate** is configured. Dependency updates are manual.
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

### Local Development (without Docker)

```bash
# Terminal 1 — backend (auto-restarts on file changes)
cd backend && npm install && npm run dev

# Terminal 2 — frontend (Vite dev server with HMR)
cd frontend && npm install && npm run dev
```

The Vite dev server proxies `/api/*` to `http://localhost:3001` automatically.

---

## Monitoring & Observability

> **Status**: No external monitoring or observability tools are configured.

Current observability is limited to:

- **Health endpoint**: `GET /health` — use for uptime monitoring (e.g. UptimeRobot, Pingdom).
- **System info**: `GET /api/system` (authenticated) — returns uptime, Node/Playwright versions, memory usage, and DB record counts.
- **Server logs**: `console.error` / `console.log` output. In Docker, access via `docker logs sentri-backend`.
- **SSE events**: Real-time run progress is streamed to the frontend. No server-side log aggregation.

When adding observability, consider:
- Structured JSON logging (e.g. `pino`) to replace bare `console.*` calls.
- APM integration (Datadog, New Relic) for request tracing.
- Error tracking (Sentry) for both backend and frontend.

---

## Security Checklist

Before submitting any PR that touches auth, routes, or data handling, verify:

- [ ] Passwords are hashed with `hashPassword()` (scrypt, random salt) — never stored plaintext.
- [ ] JWTs are validated with `requireAuth` on every non-public endpoint.
- [ ] User-supplied strings are validated with `utils/validate.js` before DB writes.
- [ ] No sensitive data (API keys, passwords, full JWTs) is returned in API responses. Use `maskKey()` for display.
- [ ] Credential values stored in the DB use `credentialEncryption.js`.
- [ ] Any HTML rendered via `dangerouslySetInnerHTML` is sanitised — escape all user/AI-generated content before insertion. Use `escapeHtml()` on raw text before applying markdown/formatting transforms.
- [ ] Error responses to clients never leak internal details (stack traces, SDK error messages, API key validation failures). Return generic messages for 5xx errors.

### Resolved Security Items

The following have been implemented and are no longer open:

- **Rate limiting** ✅: Per-endpoint rate limiters are configured in `routes/auth.js` — separate buckets for login (10/IP/15 min), forgot-password (5), and reset-password (5). Uses `trust proxy` for correct IP detection behind nginx.
- **Content-Security-Policy** ✅: Helmet CSP is fully enabled in `middleware/appSetup.js` with explicit directives (`default-src 'self'`, `script-src 'self' 'unsafe-inline'`, `connect-src 'self'`, `frame-ancestors 'none'`, etc.). Tighten `'unsafe-inline'` to nonce-based in production.
- **Reset token exposure** ✅: The forgot-password endpoint only returns the reset token in the response when `ENABLE_DEV_RESET_TOKENS=true` is explicitly set. Absence of a production flag is no longer sufficient to leak tokens.

### Known Security Gaps (TODO)

The following are **not yet implemented** but should be addressed before production:

- **Artifact authentication**: The `/artifacts` static route is **not behind `requireAuth`**. Screenshots, videos, and traces are served publicly. Artifact filenames contain random run IDs which provide obscurity but not security. To add auth, implement `?token=` query param validation (same pattern as SSE/export endpoints) and update all frontend artifact URLs.
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

---

## Common Tasks

### Adding a New API Endpoint

1. Add the handler to the appropriate file in `backend/src/routes/`.
2. Mount it in `index.js` behind `requireAuth` unless it is explicitly public.
3. Add a JSDoc block documenting method, path, auth requirement, request body, and response shape.
4. Add a corresponding function in `frontend/src/api.js`.
5. Write a test in `backend/tests/api-flow.test.js`.

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
3. Add a `<NavLink>` to `frontend/src/components/Layout.jsx` if it appears in the sidebar.
4. Create a corresponding CSS file in `frontend/src/styles/pages/my-page.css` and import it from the component.

### Page Responsibilities (UX Architecture)

The frontend follows a clear separation of concerns between pages:

| Page | Role | Key actions |
|---|---|---|
| **Dashboard** | Read-only analytics hub | Pass rate, trends, defects, recent activity |
| **Tests** (`Tests.jsx`) | **Central command centre** for all test creation | Crawl a project, Generate from story, Run regression, Review drafts |
| **ProjectDetail** | Project-scoped execution & review | Run regression, review/approve/reject this project's tests, export, traceability |
| **Projects** | Project list & creation | Create/delete projects |
| **Runs** / **RunDetail** | Run history & live execution view | View logs, results, abort |
| **Settings** | AI provider & system config | API keys, Ollama, system info |

**Important**: Crawl and test generation are **only** triggered from the Tests page (via `CrawlProjectModal` and `GenerateTestModal`). The ProjectDetail page links back to Tests via a "Generate more tests →" button — it does not have its own crawl controls. This avoids duplicating creation flows across pages.

---

## Versioning & Releases

> **Status**: No formal release process exists yet.

- Both packages are at `1.0.0`. Version bumps are manual.
- No changelog is maintained. Use descriptive PR titles — they become the squash-merge commit messages.
- Docker images are tagged `latest` on GHCR. When a tagging strategy is adopted, update `docker-compose.yml` to reference specific tags.

---

## What Not to Do

- **Do not use `require()` anywhere.** The entire repo is ES Modules.
- **Do not import LLM SDKs directly** outside of `aiProvider.js`.
- **Do not call `fetch()` directly** in frontend components; use `api.js`. Streaming endpoints that bypass `req()` must still handle 401 via `handleUnauthorized()`.
- **Do not store secrets in code or commit `.env` files.**
- **Do not change the `healingHistory` key schema** (`<testId>@v<version>::<action>::<label>`) without a migration strategy — existing DB records will silently stop matching. The repository layer reads both versioned and legacy keys, but new writes always use the versioned format.
- **Do not add polling** to the frontend for run status — use the existing SSE infrastructure (`useRunSSE`).
- **Do not add a new test framework** to either package. Backend tests use `node:assert/strict`; keep it that way.
- **Do not write raw SQL in route handlers** — always go through repository modules in `database/repositories/`. Do not use `getDb()` for writes — it returns a read-only snapshot.
- **Do not skip `throwIfAborted(signal)`** in pipeline or runner stages — it breaks the abort/cancel feature.
- **Do not use `dangerouslySetInnerHTML`** without escaping all dynamic content first. AI/user-generated text must be sanitised before DOM insertion to prevent XSS.
- **Do not leak internal error details** to clients. Catch SDK/provider errors and return generic messages via `classifyError()`. Log the real error server-side with `formatLogLine()`.
- **Do not use bare `console.error` / `console.log`** for application logging. Always use `formatLogLine()` from `utils/logFormatter.js` (or `logError(run, …)` / `logWarn(run, …)` when a run object is available) so all output has consistent timestamps, levels, and respects `LOG_JSON` mode.
- **Do not omit `X-Accel-Buffering: no`** on SSE endpoints — nginx will buffer the stream and break real-time delivery.
- **Do not add large dependencies** without justification. Check bundle size impact for frontend packages and document the rationale in the PR.
- **Do not duplicate shared utilities.** Check `backend/src/utils/` and `frontend/src/utils/` before writing helpers like `escapeHtml`, `formatDuration`, `debounce`, etc. If a helper exists, import it. If it doesn't, create it in the shared `utils/` directory — not inline in a component.
- **Do not reinvent CSS classes.** Check `components.css` and `utilities.css` before adding new styles. Use `.btn`, `.card`, `.badge`, `.modal-*`, `.input`, `.flex-*`, `.text-*` etc. instead of writing equivalent inline styles or new classes.
- **Do not add CSS to `index.css` directly.** New styles go into the appropriate ITCSS partial (`components.css`, `features/*.css`, `pages/*.css`, or `utilities.css`) and are imported from `index.css`.
