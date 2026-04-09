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
    db.js                  In-memory JSON store with atomic disk persistence
    aiProvider.js          Multi-provider LLM abstraction (Anthropic/OpenAI/Google/Ollama)
    selfHealing.js         Adaptive selector waterfall + healing history
    crawler.js             Link-crawl orchestrator
    testRunner.js          Parallel test execution orchestrator
    middleware/            Express middleware (appSetup, CORS, Helmet)
    routes/                REST endpoints (auth, projects, tests, runs, sse, settings, dashboard, system)
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
import { getDb } from "./db.js";
import { log } from "../utils/runLogger.js";

// ❌ Wrong
import { getDb } from "./db";
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

---

## Backend Standards

### Error Handling

- **Never swallow errors silently.** Either rethrow, log with context, or convert to a user-facing HTTP error.
- Use the `throwIfAborted(signal)` helper from `utils/abortHelper.js` before every expensive I/O step in a pipeline or runner.
- Rate-limit retries use exponential back-off via `withRetry()` in `aiProvider.js`. Do not add ad-hoc `setTimeout` retry loops elsewhere.
- `process.on("uncaughtException")` and `process.on("unhandledRejection")` are registered once in `index.js`. Do not register additional global handlers.

```js
// ✅ Propagate with context
catch (err) {
  throw new Error(`[myModule] Failed to do X for run ${runId}: ${err.message}`);
}

// ❌ Silent swallow
catch (_) {}
```

### HTTP Routes

- All responses follow `{ ok: boolean, … }` or standard REST shape.
- 4xx errors return `{ error: string }` with a descriptive message.
- 5xx errors return `{ error: "Internal server error" }` — never leak stack traces to the client.
- Validate all user-supplied input at the route boundary using `utils/validate.js` before touching the DB.
- All routes except `/api/auth/*` and `/health` require `requireAuth` middleware.

```js
// ✅ Route pattern
router.post("/projects/:id/thing", async (req, res) => {
  const { id } = req.params;
  const db = getDb();
  const project = db.projects[id];
  if (!project) return res.status(404).json({ error: "Project not found" });
  // … logic …
  res.json({ ok: true, result });
});
```

### Database

- **`getDb()`** returns the singleton in-memory store. It is safe to call multiple times — always returns the same object.
- **`saveDb()`** flushes to disk. Call it after any write that must survive a crash (e.g. creating a user, starting a run).
- Never read or write `data/sentri-db.json` directly; always go through `db.js`.
- The in-memory store is the source of truth. Treat `sentri-db.json` as a durability backup, not the primary store.
- Collections: `db.users`, `db.oauthIds`, `db.projects`, `db.tests`, `db.runs`, `db.activities`, `db.healingHistory`.

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
- Mock the DB by passing a plain object `{ tests: {}, projects: {}, healingHistory: {} }` — never call `getDb()` in tests.

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

On every test run, the winning strategy index is recorded in `db.healingHistory` keyed by `"<testId>::<action>::<label>"`. The next run loads that hint and tries the winning strategy first via `getHealingHint()`.

When adding new selector strategies:
- Add them to the `strategies` array in the helper code returned by `getSelfHealingHelperCode()`.
- Keep strategies ordered from most-semantic (ARIA) to least-semantic (CSS), so the adaptive hint system consistently learns the best approach.
- Do not change the index of existing strategies without running a DB migration that resets all `healingHistory` entries.

---

## Docker & Deployment

- `docker-compose.yml` — local development and production (pulls from GHCR).
- `docker-compose.prod.yml` — production overrides (stricter resource limits).
- The frontend Dockerfile builds the Vite SPA and serves it with nginx. The nginx config proxies `/api/*` to the backend container.
- **Never bake secrets into images.** Pass all keys via environment variables. The `.dockerignore` already excludes `.env` files.
- `backend/data/` is a Docker volume — it persists `sentri-db.json` across container restarts.
- The backend Dockerfile installs Playwright's system dependencies and uses the system Chromium (`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`).

---

## Security Checklist

Before submitting any PR that touches auth, routes, or data handling, verify:

- [ ] Passwords are hashed with `hashPassword()` (scrypt, random salt) — never stored plaintext.
- [ ] JWTs are validated with `requireAuth` on every non-public endpoint.
- [ ] User-supplied strings are validated with `utils/validate.js` before DB writes.
- [ ] No sensitive data (API keys, passwords, full JWTs) is returned in API responses. Use `maskKey()` for display.
- [ ] Rate limiting buckets are in place on any endpoint that triggers a network call or DB write from an unauthenticated source.
- [ ] Credential values stored in the DB use `credentialEncryption.js`.
- [ ] `Content-Security-Policy` is configured (via Helmet) before deploying to production.

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
| `NODE_ENV` | No | `development` | Enables dev-only seed endpoint when not `production` |

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

---

## What Not to Do

- **Do not use `require()` anywhere.** The entire repo is ES Modules.
- **Do not import LLM SDKs directly** outside of `aiProvider.js`.
- **Do not call `fetch()` directly** in frontend components; use `api.js`.
- **Do not store secrets in code or commit `.env` files.**
- **Do not change the `healingHistory` key schema** without a migration strategy — existing DB records will silently stop matching.
- **Do not add polling** to the frontend for run status — use the existing SSE infrastructure (`useRunSSE`).
- **Do not add a new test framework** to either package. Backend tests use `node:assert/strict`; keep it that way.
- **Do not write to `sentri-db.json` directly** — always go through `db.js`.
- **Do not skip `throwIfAborted(signal)`** in pipeline or runner stages — it breaks the abort/cancel feature.
