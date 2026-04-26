# Sentri — Coding Standards

> Read this when writing or modifying any code, after reading AGENT.md.
> For lookup tables (utils, CSS classes, auth strategies, env vars) → use REFERENCE.md.

---

## Language & Runtime

- **Backend**: Node.js 20+, ES Modules (`"type": "module"` in `package.json`). Every file uses `import`/`export` — never `require()`.
- **Frontend**: React 18, JSX, ES Modules, Vite 6. No TypeScript. Plain CSS via custom properties (design tokens in `src/styles/tokens.css`).
- **Node version**: `>=20` is required. Use `node --watch-path=src` for dev (no nodemon dependency).

---

## Module System (Backend)

All imports use the `.js` extension explicitly, even when the file is TypeScript-free:

```js
// ✅ Correct
import * as testRepo from "../database/repositories/testRepo.js";
import { log } from "../utils/runLogger.js";

// ❌ Wrong — missing .js extension
import * as testRepo from "../database/repositories/testRepo";
```

Named exports are preferred over default exports in backend modules. Default exports are only used in Express route files where `router` is the sole export.

---

## File & Directory Naming

| Layer | Convention | Example |
|---|---|---|
| Backend modules | `camelCase.js` | `aiProvider.js`, `runLogger.js` |
| Backend routes | `noun.js` (plural resource) | `projects.js`, `runs.js` |
| Frontend pages | `PascalCase.jsx` | `Dashboard.jsx`, `RunDetail.jsx` |
| Frontend components | `PascalCase.jsx` | `StatusBadge.jsx`, `TestRunView.jsx` |
| Frontend hooks | `useNoun.js` | `useProjectData.js`, `useRunSSE.js` |
| CSS files | `kebab-case.css` | `project-detail.css`, `tokens.css` |

---

## JSDoc (Backend)

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

### JSDoc type syntax rules

**This project uses JSDoc (not TypeScript).** The CI pipeline runs `jsdoc` to generate documentation, and it will **fail** on TypeScript-only syntax.

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

---

## DRY — No Duplication

Before writing new code, check whether a shared utility, component, or CSS class already exists. Duplicating logic that belongs in a shared module is a common agent mistake.

See **REFERENCE.md** for the full lookup tables of:
- Backend shared utilities (`backend/src/utils/`)
- Frontend shared CSS classes (`frontend/src/styles/`)
- Frontend shared JS modules and hooks
- Test shared utilities (`backend/tests/helpers/`)

**If you need a shared helper** (e.g. `escapeHtml`, `formatDuration`, `debounce`), create it in `frontend/src/utils/<n>.js` and import it. Do not define utility functions locally inside a component file — they will inevitably be needed elsewhere and duplicated.

```js
// ✅ Shared utility
// frontend/src/utils/escapeHtml.js
export function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ❌ Local helper buried inside a component
function escapeHtml(s) { … } // in AIChat.jsx — not reusable
```

Do not reimplement any existing utility. If you need a variant, extend the existing module.

---

## Code Formatting

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

---

## Git & Branching Conventions

- **Branch naming**: `feature/<short-description>`, `fix/<short-description>`, `codex/<task-description>`.
- **Commit messages**: Follow [Conventional Commits](https://www.conventionalcommits.org/) — the release workflow parses these to determine version bumps automatically.

  | Prefix | Version bump | Example |
  |---|---|---|
  | `feat:` | Minor (`0.x.0`) | `feat: add global API rate limiting` |
  | `fix:` | Patch (`0.0.x`) | `fix: atomic token claim prevents TOCTOU race` |
  | `perf:` | Patch | `perf: cache DB queries in dashboard endpoint` |
  | `feat!:` or `BREAKING CHANGE:` in body | Major (`x.0.0`) | `feat!: replace JWT localStorage with HttpOnly cookies` |
  | `docs:`, `test:`, `chore:`, `ci:`, `refactor:`, `style:` | No bump | `docs: update API reference for rate limiting` |

  The **squash-merge commit message** (PR title) determines the version bump, so write PR titles as Conventional Commits.

- **PR size**: Keep PRs focused — one feature or fix per PR. If a change touches >500 lines, consider splitting.
- **Merge strategy**: Squash-merge to `main`. The PR title becomes the squash commit message.
- **No force-pushes** to `main`. Feature branches may be rebased before merge.

---

## Backend Standards

### Error Handling

- **Never swallow errors silently.** Either rethrow, log with context, or convert to a user-facing HTTP error.
- **Classify errors for the frontend.** Use `classifyError(err, context)` from `utils/errorClassifier.js` whenever storing `run.error` or sending error messages to the client. Never store `err.message` directly on `run.error`.
- Use the `throwIfAborted(signal)` helper from `utils/abortHelper.js` before every expensive I/O step in a pipeline or runner.
- Rate-limit retries use exponential back-off via `withRetry()` in `aiProvider.js`. Do not add ad-hoc `setTimeout` retry loops elsewhere.
- `process.on("uncaughtException")` and `process.on("unhandledRejection")` are registered once in `index.js`. Do not register additional global handlers.

```js
// ✅ Classify and log (run context)
catch (err) {
  const { message, category } = classifyError(err, "run");
  run.error = message;
  run.errorCategory = category;
  logError(run, message);
}

// ✅ No run context
catch (err) {
  console.error(formatLogLine("error", null, `[chat] ${err.message}`));
}

// ✅ Propagate with context
catch (err) {
  throw new Error(`[myModule] Failed to do X for run ${runId}: ${err.message}`);
}

// ❌ Silent swallow
catch (_) {}

// ❌ Raw error to client
run.error = err.message;  // leaks SDK internals
```

### Logging

- **Run-level logging**: Use `log(run, message)` / `logWarn(run, message)` / `logError(run, message)` from `utils/runLogger.js`.
- **Application-level logging** (no run context): Use `formatLogLine(level, null, message)` from `utils/logFormatter.js` wrapped in `console.error` / `console.log`.
- **Never use bare `console.error` / `console.log`** for application logging.
- **Never log sensitive data**: API keys, passwords, JWT tokens, or user credentials must never appear in logs. Use `maskKey()` if you need to log a key reference.
- **Structured context**: Always include the relevant ID (runId, projectId, testId) in error messages.

```js
// ✅ Run context
logError(run, `Browser launch failed`);
logWarn(run, `API test generation failed: ${classified.message}`);

// ✅ No run context
console.error(formatLogLine("error", null, `[chat] streamText failed: ${err.message}`));
if (shouldLog("debug")) {
  console.log(formatLogLine("debug", null, `[chat] prompt=${charCount} chars`));
}

// ❌ Bare console
console.error(`[chat] failed: ${err.message}`);

// ❌ Leaks secrets
console.error(`API key: ${apiKey}`);
```

### HTTP Routes

- All responses follow `{ ok: boolean, … }` or standard REST shape.
- 4xx errors return `{ error: string }` with a descriptive message.
- 5xx errors return `{ error: "Internal server error" }` — never leak stack traces to the client.
- Validate all user-supplied input at the route boundary using `utils/validate.js` before touching the DB.
- All routes except `/api/v1/auth/*`, `/health`, and trigger endpoints require `requireAuth` middleware.
- After `requireAuth`, the `workspaceScope` middleware resolves `req.workspaceId` and `req.userRole` from the database. All entity queries must be scoped to `req.workspaceId`.
- Mutating routes are further guarded by `requireRole(minimumRole)`. Role hierarchy: `admin` > `qa_lead` > `viewer`.

```js
// ✅ Route pattern
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

All authentication is centralised in **`backend/src/middleware/authenticate.js`** using a strategy pattern. Route files never implement their own auth logic. See REFERENCE.md for the strategy table and convenience aliases.

#### Adding a new auth strategy

1. Add a new entry to `AUTH_TYPE` in `middleware/authenticate.js`.
2. Add a strategy object to the `STRATEGIES` array (extract → verify).
3. If the strategy uses cookies, add its name to `COOKIE_STRATEGIES`.
4. Create a convenience alias (e.g. `export const requireApiKey = authenticate(AUTH_TYPE.API_KEY)`).
5. Mount it on the relevant routes. No changes needed to `appSetup.js`, `index.js`, or other route files.

Non-cookie auth strategies are automatically CSRF-exempt — no manual carve-outs needed.

### Database

Sentri supports **SQLite** (default) and **PostgreSQL** (via `DATABASE_URL` env var). Both adapters expose the same interface so all repository modules work unchanged. See REFERENCE.md for the full adapter and repository listing.

- **Repository pattern**: All DB access goes through repository modules in `backend/src/database/repositories/`. Never write raw SQL in route handlers.
- **JSON columns**: `steps`, `tags`, `results`, `testQueue`, `credentials`, etc. are stored as JSON strings and auto-serialized/deserialized by the repository layer.
- **Boolean columns**: `isJourneyTest`, `assertionEnhanced`, `isApiTest` are stored as `0`/`1` integers and converted to `true`/`false` by `testRepo`.
- **ID generation**: Use `idGenerator.js` for domain objects (projects, tests, runs). Use `uuid` only for internal sub-records.

### Data Migration & Schema Changes

Schema is defined in `backend/src/database/schema.sql` (all `CREATE TABLE IF NOT EXISTS`).

- **Adding a new column**: Add it to `schema.sql` with a `DEFAULT` value, add to the repository's `INSERT_COLS` and row conversion functions. Use `ALTER TABLE ADD COLUMN` in a migration block at the top of `schema.sql`.
- **Adding a new table**: Add `CREATE TABLE IF NOT EXISTS` + indexes to `schema.sql`. Create a new repository module in `database/repositories/`.
- **Changing column types**: SQLite has limited `ALTER TABLE` support. For complex changes, create a new table, copy data, drop old, rename new — wrapped in a transaction.

### AI Provider

All LLM calls go through `aiProvider.js`. Do not import Anthropic, OpenAI, or Google SDKs directly anywhere else.

```js
// ✅
import { generateText, streamText, parseJSON } from "../aiProvider.js";

// ❌
import Anthropic from "@anthropic-ai/sdk";
```

- Prefer `{ system, user }` structured messages over a single combined string.
- Always pass `signal` from the run's `AbortController` so the LLM call is cancellable.

### SSE / Real-Time Events

- Use `emitRunEvent(runId, eventType, payload)` from `utils/runLogger.js`.
- Use `log(run, message)` / `logWarn(run, message)` for structured run log entries — these emit SSE automatically.
- Never write to `process.stdout` for run-level progress.
- Every SSE endpoint **must** set `X-Accel-Buffering: no`:

```js
// ✅ Required headers for any SSE endpoint
res.setHeader("Content-Type", "text/event-stream");
res.setHeader("Cache-Control", "no-cache");
res.setHeader("Connection", "keep-alive");
res.setHeader("X-Accel-Buffering", "no");   // ← critical for nginx proxy
res.flushHeaders();
```

### Abort / Cancellation

`AbortSignal` is threaded through the entire pipeline. Every stage that does I/O must accept and honour a `signal` parameter. Use `throwIfAborted(signal)` at the start of each stage and after each expensive operation.

---

## Frontend Standards

### Component Patterns

- Functional components only. Class components exist only in `components/ErrorBoundary.jsx`.
- Pages live in `src/pages/`, reusable UI in `src/components/`.
- Domain-specific sub-components live in subdirectories, e.g. `src/components/project/`, `src/components/test/`.
- Lazy-load all page-level components via `React.lazy()` + `Suspense` as shown in `App.jsx`.

### State & Data Fetching

- All cached GETs go through **TanStack Query** via the shared `queryClient` in `src/queryClient.js`. Global defaults (`staleTime`/`gcTime` 30s, `retry: 1`, `refetchOnWindowFocus: false`) are set there — do not repeat them at the call site.
- **Use the per-resource hooks in `src/hooks/queries/`** instead of calling `useQuery` directly in pages.
- **Adding a new cached endpoint:** (1) add a key namespace to `src/queryClient.js`, (2) add a `useXxxQuery()` hook in `src/hooks/queries/`, (3) consume it from the page.
- **Mutations:** after a successful POST/PATCH/DELETE that affects cached data, call the matching `invalidate*Cache()` helper from `src/queryClient.js`.
- Use `useRunSSE(runId)` for real-time run streaming; do not write raw `EventSource` logic in components.

### Styling

- Use CSS custom properties (defined in `src/styles/tokens.css`) for all colours, spacing, and radius values. Never hardcode hex values or pixel sizes.
- Component-level styles use the BEM-adjacent class naming already established (e.g. `.stat-card`, `.status-badge--pass`).
- Dark mode is handled automatically via `prefers-color-scheme` in `tokens.css`. Do not write `@media (prefers-color-scheme: dark)` in component files.
- Inline styles are acceptable for one-off layout overrides but must use CSS variable references: `style={{ color: "var(--text2)" }}`.

**When to create a new CSS file:**
- **Feature-scoped styles** → `frontend/src/styles/features/<feature>.css`. Scope all classes under a namespace prefix (`.chat-*`, `.onboard-*`).
- **Page-specific styles** → `frontend/src/styles/pages/<page>.css`.
- **New reusable component** → Add to `components.css` if used across 2+ pages/features.
- **Always import** new CSS files from `frontend/src/index.css` in the correct ITCSS layer position.

### API Calls

All backend communication goes through `src/api.js`. Do not use `fetch` directly in components or hooks.

```js
// ✅
import { api } from "../api.js";
const project = await api.getProject(id);

// ❌
const res = await fetch(`/api/projects/${id}`);
```

The `api.js` `req()` wrapper sends `credentials: "include"` and `X-CSRF-Token` on every request automatically. Any new `api.*` method that bypasses `req()` (e.g. for streaming) **must** replicate the 401 handling, include `credentials: "include"` + the CSRF header, and capture the `X-CSRF-Token` response header via `setCsrfToken()`.

### Error Handling (Frontend)

- The global `ErrorBoundary` catches render-time exceptions and reports them to `/api/system/client-error`. Do not add additional top-level error boundaries unless isolating a specific widget.
- API errors should be caught in the calling component and displayed inline (e.g. a red banner or toast).

### Accessibility (a11y)

- All interactive elements must be keyboard-accessible. Test with Tab/Enter/Escape.
- Modals and overlays must trap focus while open and restore focus on close. Use `autoFocus` on the primary input and listen for Escape to dismiss.
- Use semantic HTML elements (`<nav>`, `<main>`, `<section>`, `<dialog>`) over generic `<div>` where applicable.
- Icon-only buttons must have `title` or `aria-label` attributes.
- Colour alone must not convey meaning — pair status colours with text labels or icons.

### Performance

- **Lazy loading**: All page-level components use `React.lazy()` + `Suspense`. Heavy third-party libraries should also be dynamically imported.
- **Images/assets**: Use optimised formats (WebP, SVG). Do not commit large binary files to the repo.
- **Backend response times**: API endpoints should respond within 500ms for reads. Long-running operations use SSE streaming.

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

### Stage 5 — Deduplicator

`deduplicator.js` runs four layers in order; a test is eliminated the moment any layer matches:

| Layer | Mechanism | Threshold |
|-------|-----------|-----------|
| 1 | Structural hash (SHA-256 of Playwright actions + description) | exact |
| 2 | Normalised name + same `sourceUrl` | exact, length ≥ 15 chars |
| 3 | Fuzzy name — Levenshtein similarity | ≥ 0.80 |
| 4 | Semantic TF-IDF cosine — name + description + steps | ≥ 0.65 |

`FUZZY_NAME_THRESHOLD` and `SEMANTIC_SIMILARITY_THRESHOLD` are exported constants — override in tests without editing production code.

### Stage 7 — Validator

`testValidator.js` runs four passes. All collected issues are returned; any test with at least one issue is rejected.

| Pass | What it catches |
|------|-----------------|
| Structural | Missing name/steps, placeholder URLs, missing `async`, missing `page.goto` |
| Locator | Unbalanced CSS brackets, unknown pseudo-classes, overly-deep selectors, malformed XPath |
| Action | Method calls not in the Playwright API whitelist (e.g. `.clicks()`, `.fillIn()`) |
| Assertion | Matcher typos in `expect()` chains, logically-redundant `.not.toBeHidden()` |

Deep validation (passes 2–4) only runs after Acorn confirms syntactic validity.

**Extending the whitelists:** add entries to `VALID_PAGE_ACTIONS` or `VALID_MATCHERS` in `testValidator.js` when Playwright releases new APIs.

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

All interactions in generated tests are routed through safe wrappers (`safeClick`, `safeFill`, `safeSelect`, etc.). `applyHealingTransforms()` rewrites raw Playwright calls into safe helpers.

### Healing history & versioned scoping

On every test run, the winning strategy index is recorded in `db.healingHistory`. Keys are **versioned** by test code revision: `"<testId>@v<codeVersion>::<action>::<label>"`. This ensures stale hints from old code versions don't pollute current runs. The repository layer (`healingRepo.getByTestId`) reads both versioned and legacy (unversioned) keys for backward compatibility.

### Fail-count cap

Hints that have failed `≥ HEALING_HINT_MAX_FAILS` (default 3, env-configurable) consecutive times are skipped by both `getHealingHint()` and `getHealingHistoryForTest()`. This prevents the runtime from retrying strategies that are known-broken.

### Visibility wait cap

The `firstVisible()` helper caps its `waitFor` timeout at `HEALING_VISIBLE_WAIT_CAP` (default 1200ms, env-configurable) to avoid slow waterfalls when a strategy doesn't match. The full retry loop still provides multiple attempts.

### Adding new selector strategies

- Add them to the `strategies` array in `getSelfHealingHelperCode()`.
- Keep strategies ordered from most-semantic (ARIA) to least-semantic (CSS).
- Bump `STRATEGY_VERSION` in `selfHealing.js` when reordering or removing strategies — hints from older versions are automatically ignored.
- Do not change the healing key schema (`<testId>@v<version>::<action>::<label>`) without a migration strategy — existing DB records will silently stop matching. The repository layer reads both versioned and legacy keys, but new writes always use the versioned format.

---

## AI Chat System

The AI chat assistant streams responses via `POST /api/chat` (SSE). The system prompt is enriched with live workspace data on every request.

### Context tiers

| Tier | What | Token cost |
|---|---|---|
| **Tier 1 — Workspace summary** | Projects, test counts, recent runs, pass rate | ~200-400 tokens |
| **Tier 2 — Entity deep-dive** | Full test steps, Playwright code, run errors | ~100-800 tokens per entity |

Both tiers are **read-only** — no DB writes, no mutations, no actions.

### Safety limits

- Max **5 tests**, **3 runs**, **3 projects** per message.
- Playwright code capped at **1500 chars**, errors at **500 chars**, descriptions at **300 chars**.
- No credentials, API keys, or user passwords are ever included.

### Key files

| File | Role |
|---|---|
| `backend/src/routes/chat.js` | SSE endpoint, system prompt, `buildWorkspaceContext()`, `buildEntityContext()` |
| `frontend/src/components/ai/AIChat.jsx` | Chat modal panel UI |
| `frontend/src/pages/ChatHistory.jsx` | Full-page chat — session CRUD, export |
| `frontend/src/utils/markdown.js` | Shared `escapeHtml()` + `renderMarkdown()` |

### When modifying the chat system

- **Adding new context**: Add to `buildWorkspaceContext()` or `buildEntityContext()` in `chat.js`. Keep output compact.
- **Adding new entity types**: Add a regex pattern + DB lookup in `buildEntityContext()`. Cap results, truncate long fields.
- **Changing the system prompt**: Edit `BASE_SYSTEM_PROMPT` in `chat.js`.
- **Frontend changes**: Modal chat styles → `features/chat.css` (`.chat-*`); full-page → `pages/chat-history.css` (`.ch-*`). Always use the shared `renderMarkdown` from `utils/markdown.js` to prevent XSS.

---

## Dependency Management

- **Adding a new dependency**: Prefer lightweight, well-maintained packages. Check bundle size on [bundlephobia.com](https://bundlephobia.com). Justify the addition in the PR.
- **`dependencies` vs `devDependencies`**: Runtime packages go in `dependencies`. Build tools and test utilities go in `devDependencies`. Playwright is in `dependencies` (backend) because it runs in production.
- **Lock files**: `package-lock.json` should be committed for both `backend/` and `frontend/`. Use `npm ci` in Docker builds and CI.

---

## Common Tasks

### Adding a New API Endpoint

1. Add the handler to the appropriate file in `backend/src/routes/`.
2. Mount it in `index.js` behind `requireAuth` unless explicitly public.
3. If using a new auth strategy, add it to `middleware/authenticate.js`. Public mutation paths must be added to `CSRF_EXEMPT_PATHS` in `appSetup.js`.
4. Add a JSDoc block documenting method, path, auth requirement, request body, and response shape.
5. Add a corresponding function in `frontend/src/api.js`.
6. Write a test in `backend/tests/api-flow.test.js` or a dedicated file. Register it in `backend/tests/run-tests.js`.

### Adding a New Pipeline Stage

1. Create `backend/src/pipeline/myStage.js` with named exports and full JSDoc.
2. Insert the stage call in `pipelineOrchestrator.js` or the relevant orchestrator.
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
| **ProjectDetail** | Project-scoped execution & review | Run regression, review/approve/reject, export |
| **Automation** (`/automation`) | Cross-project automation hub | CI/CD trigger tokens, scheduled runs, integration snippets |
| **Projects** | Project list & creation | Create/delete projects |
| **Runs** / **RunDetail** | Run history & live execution view | View logs, results, abort |
| **ChatHistory** (`/chat`) | Full-page AI chat with session history | New/rename/delete sessions, search, export |
| **Settings** | AI provider & system config | API keys, Ollama, system info, Recycle Bin |

**Important**: Crawl and test generation are **only** triggered from the Tests page. The ProjectDetail page links back to Tests via a "Generate more tests →" button — it does not have its own crawl controls.
