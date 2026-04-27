# Sentri — Agent Guide

> Read this file fully before writing, editing, or reviewing any code. Every agent, every task, no exceptions.

---

## What to read for this task

| Situation | Read this |
|---|---|
| Every task, always | **This file** (AGENT.md) |
| Starting the next PR | [NEXT.md](./NEXT.md) — current sprint spec, files, acceptance criteria. **Do not read ROADMAP.md** unless you need context on items beyond the current PR. |
| Writing or modifying code | [STANDARDS.md](./STANDARDS.md) |
| Looking up a utility, CSS class, hook, repo, env var, or auth strategy | [REFERENCE.md](./REFERENCE.md) — Ctrl+F only, never top-to-bottom |
| Before opening a PR | [REVIEW.md](./REVIEW.md) |
| Validating a user-visible change manually | [QA.md](./QA.md) — Golden E2E happy path + per-feature checks |
| Looking up the role required for an endpoint | [`backend/src/middleware/permissions.json`](./backend/src/middleware/permissions.json) — machine-readable, lives next to `requireRole.js` |

---

## Before writing any code — 30-second pre-flight

Every task. No exceptions. Do this before touching a file:

1. **Does a utility already exist?**
   `grep_search` or Ctrl+F in REFERENCE.md for the concept (e.g. "escape", "format", "classify", "validate") before writing a new helper. Check:
   - `backend/src/utils/` for backend helpers
   - `frontend/src/utils/` for frontend helpers
   - `frontend/src/styles/components.css` + `utilities.css` for CSS
   - `frontend/src/hooks/queries/` for cached GET hooks

2. **Does a similar pattern already exist in a sibling file?**
   Read one existing file in the same directory (e.g. another repo, route, page, hook). Match its structure, naming, imports, and error-handling style. Consistency > cleverness.

3. **Is this change minimal?**
   Only modify files listed in NEXT.md § "Files to change" unless you have a hard reason. If you find yourself editing a 4th or 5th file, stop and reconsider — you may be solving the wrong problem.

4. **Will this be re-used?**
   If a helper is used by ≥2 call sites (or will be), put it in `utils/`. If it's one-off, inline it. Never define a helper mid-component file.

5. **Am I introducing a new concept?**
   New env var, new DB column, new CSS token, new auth strategy, new pipeline stage — each has a documented "Adding a new X" section in STANDARDS.md. Follow that section; do not improvise.

If any of these pre-flight checks fails or is unclear, stop and ask the human before writing code. Writing code first and asking later is worse than asking first.

---

## Branch co-ownership protocol — applies to every agent and human on the PR

This protocol is **agent-agnostic**. It applies equally to Devin, Claude Code, Codex, Cursor, Copilot Workspace, any future agent, and any human teammate sharing the branch. Wherever this document says "agent", substitute your own identity (`devin`, `claude`, `codex`, `cursor`, `copilot`, `human:<github-handle>`, etc.). This is what lets short prompts like *"Implement the current PR per NEXT.md"* be safe by default.

**Your agent id** = the first token you put in every claim / heartbeat / hand-off comment. Pick one and stick with it for the whole session:
- `devin` — Devin cloud agent
- `claude` — Claude Code / Anthropic CLI
- `codex` — OpenAI Codex CLI / ChatGPT code
- `cursor` — Cursor background agent
- `copilot` — GitHub Copilot Workspace
- `human:<handle>` — a person editing directly

### Rules

1. **Lane = `agent-scope` field in `NEXT.md`.** You may only edit files listed under the current item's `agent-scope`. Files under `human-scope` are off-limits even if you "need" to touch them — comment on the PR instead. If the item lists multiple agent lanes (e.g. `agent-scope-backend`, `agent-scope-frontend`), pick one and name it in your claim.
2. **Claim before first edit.** Push an empty commit `chore(claim): <agent-id> working on <files>` and post a PR comment `🟢 <agent-id>-active <UTC timestamp> — files: <list>`. If **any** `🟢 <other>-active` comment exists newer than yours and overlaps your files, stop and wait or pick a non-overlapping subset.
3. **Re-sync before every commit.** `git fetch && git rebase origin/<branch>`. If the rebase touches a file outside your lane, abort, comment `⚠️ <agent-id> scope conflict on <file>`, and stop.
4. **Commit-before-pause (mandatory).** Before any sleep, context switch, or long-running task: `git add -A && git commit -m "wip(<scope>): <what>, next: <what>" && git push`. Then post a PR comment with: agent-id, last-done, next-step, files-touched, files-not-yet-touched. **Never end a session with uncommitted local changes.**
5. **Heartbeat.** Push a wip commit roughly every 15 min of active work. If you cannot make progress in 10 min, stop and comment instead of guessing.
6. **Hand-off.** When your scope is done, post `✅ <agent-id>-done <files>` and stop. Do not start the next `NEXT.md` item without re-prompting.
7. **Conflict de-escalation.** If a commit from another agent or a human lands on files in your lane while you were paused, treat the newer version as canonical, rebase onto it, re-run tests, continue. Do not revert. If unsure, stop and ask in a PR comment.

If `NEXT.md` for the current item has no `agent-scope` field, treat the "Files to change" table as your scope and ask the human to confirm in a PR comment before your first edit.

---

## Project Overview

Sentri is a full-lifecycle AI QA platform that crawls a web application, generates Playwright test suites with an LLM, routes every generated test through a human-approval queue, executes approved tests against a live browser, and self-heals broken selectors across runs.

### Architecture at a Glance

```
frontend/          React 18 SPA (Vite, no framework beyond React Router)
backend/           Node.js 20+ ESM server (Express 4, Playwright, LLM SDKs)
  src/
    index.js               Entry point — DB init, route mounting, process guards
    database/
      sqlite.js            SQLite singleton (WAL mode, auto-schema)
      schema.sql           Table definitions, indexes, counter seeds
      migrate.js           One-time JSON → SQLite migration
      repositories/        Data access layer (counterRepo, userRepo, projectRepo, testRepo, runRepo, runLogRepo, activityRepo, healingRepo, passwordResetTokenRepo, verificationTokenRepo, webhookTokenRepo, scheduleRepo, workspaceRepo, notificationSettingsRepo, accountRepo, apiKeyRepo, baselineRepo)
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
- **Do not write raw SQL in route handlers** — always go through repository modules in `database/repositories/`.
- **Do not skip `throwIfAborted(signal)`** in pipeline or runner stages — it breaks the abort/cancel feature.
- **Do not use `dangerouslySetInnerHTML`** without escaping all dynamic content first. AI/user-generated text must be sanitised before DOM insertion to prevent XSS.
- **Do not leak internal error details** to clients. Catch SDK/provider errors and return generic messages via `classifyError()`. Log the real error server-side with `formatLogLine()`.
- **Do not use bare `console.error` / `console.log`** for application logging. Always use `formatLogLine()` from `utils/logFormatter.js` (or `logError(run, …)` / `logWarn(run, …)` when a run object is available) so all output has consistent timestamps, levels, and respects `LOG_JSON` mode.
- **Do not omit `X-Accel-Buffering: no`** on SSE endpoints — nginx will buffer the stream and break real-time delivery.
- **Do not add large dependencies** without justification. Check bundle size impact for frontend packages and document the rationale in the PR.
- **Do not duplicate shared utilities.** Check `backend/src/utils/` and `frontend/src/utils/` before writing helpers like `escapeHtml`, `formatDuration`, `debounce`, etc. If a helper exists, import it. If it doesn't, create it in the shared `utils/` directory — not inline in a component.
- **Do not hardcode `SameSite=Strict` on cookies.** Always use `cookieSameSite()` from `middleware/appSetup.js` — the production deployment is cross-origin (GitHub Pages + Render) and requires `SameSite=None; Secure`.
- **Do not hardcode `/api/v1/` in frontend code.** Use `API_PATH` from `utils/apiBase.js` for all API URL construction. The backend uses `API_PREFIX` in `index.js`. Changing `API_VERSION` in one place bumps the entire stack.
- **Do not reinvent CSS classes.** Check `components.css` and `utilities.css` before adding new styles. Use `.btn`, `.card`, `.badge`, `.modal-*`, `.input`, `.flex-*`, `.text-*` etc. instead of writing equivalent inline styles or new classes.
- **Do not add CSS to `index.css` directly.** New styles go into the appropriate ITCSS partial (`components.css`, `features/*.css`, `pages/*.css`, or `utilities.css`) and are imported from `index.css`.
- **Do not skip the changelog.** Every PR with user-visible features, fixes, or security changes must add entries to the `## [Unreleased]` section of `docs/changelog.md`. See REVIEW.md for format rules.
- **Do not submit PRs without tests.** Every new repository, utility, endpoint, bug fix, and security fix requires corresponding unit and/or integration tests. Register new test files in `backend/tests/run-tests.js`. See REVIEW.md for the full requirements table.
- **Do not duplicate test helpers.** Integration test utilities live in `backend/tests/helpers/test-base.js`. Import from there — do not copy these functions into new test files.
- **Do not use TypeScript syntax in JSDoc comments.** This project uses plain JSDoc, not TypeScript. The CI pipeline runs `jsdoc` and will **fail** on TS-only syntax. Never use `prop?: type` — use `@typedef` with `@property {type} [prop]` instead. Never use `type?` for nullable — use `{type|null}` or `{?type}`. See STANDARDS.md §JSDoc for the full reference.
- **Do not create a new utility/component/CSS class without a lookup pass first.** Run `grep_search` against `backend/src/utils/`, `frontend/src/utils/`, `components.css`, and `utilities.css`. If 80% of what you need exists, extend the existing module — do not fork it.
- **Do not edit files outside NEXT.md § "Files to change" without explicit reason.** If scope creeps beyond the listed files, stop and justify in the PR description. Unbounded scope is the #1 cause of PR-review friction.
- **Do not match stylistic conventions from memory — match the sibling file.** Before writing a new repo, route, page, or hook, open one existing sibling file and mirror its structure. "What the codebase does" beats "what I think is idiomatic."
- **Do not import directly from `@playwright/test` in E2E specs.** Use `tests/e2e/utils/playwright.mjs` so the import surface stays single-source. If you need a new export, add it there.
- **Do not write custom auth or CSRF logic in E2E specs.** Use `loginWithRetry()` and `SessionClient` from `tests/e2e/utils/`. New auth-related helpers belong in `auth.mjs` or `session.mjs`, not inline in a spec.

---

## PR Checklist

Copy this block into your PR description and tick each item before requesting review. Full details in [REVIEW.md](./REVIEW.md).

```markdown
- [ ] PR title is a Conventional Commit (`feat:`, `fix:`, `perf:`, `feat!:`, `docs:`, etc.)
- [ ] `docs/changelog.md` updated under `## [Unreleased]` (if user-visible)
- [ ] New backend logic has tests; new test files registered in `backend/tests/run-tests.js`
- [ ] `cd backend && npm test` passes locally
- [ ] `cd frontend && npm run build && npm test` passes locally
- [ ] Security checklist reviewed (if PR touches auth, routes, or data handling)
- [ ] No `require()`, no direct LLM SDK imports, no raw `fetch()` in components, no JWTs in response bodies, no raw SQL in routes
- [ ] User-visible changes walked through the relevant section(s) of [QA.md](./QA.md)
```
