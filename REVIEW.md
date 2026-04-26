# Sentri — PR Review Checklist

> **Reviewing agents (Devin, Copilot, Cursor): also read [AGENT.md](./AGENT.md) before
> this file** — it contains the project's always-on rules (DO NOTs, architecture,
> auth model). For coding conventions see [STANDARDS.md](./STANDARDS.md). For
> table lookups (utils, env vars, auth strategies) see [REFERENCE.md](./REFERENCE.md).
> For manual end-to-end validation (Golden E2E + per-feature checks) see [QA.md](./QA.md).
>
> Read this file before submitting any pull request.

---

## PR Checklist

- [ ] PR title is a Conventional Commit (`feat:`, `fix:`, `perf:`, `feat!:`, etc.)
- [ ] `docs/changelog.md` updated under `## [Unreleased]` (see Changelog section below)
- [ ] All new backend logic has tests; new test files are registered in `backend/tests/run-tests.js`
- [ ] CI passes locally (`cd backend && npm test` and `cd frontend && npm run build && npm test`)
- [ ] Security checklist reviewed if the PR touches auth, routes, or data handling (see below)
- [ ] Sprint tracker updated (see [Sprint Tracker Hand-off](#sprint-tracker) below)
- [ ] Code review self-pass: no duplicated helpers, no duplicated CSS classes, no files edited outside NEXT.md scope, new utilities placed in shared `utils/` not inline, sibling-file conventions followed.
- [ ] For user-visible changes: walked the affected section(s) of [QA.md](./QA.md). For changes that touch any flow in the Golden E2E Happy Path (auth → project → crawl → generate → approve → run → AI fix → visual → reports → automation → notifications → GDPR → permissions), rerun the full Golden E2E on Chrome plus one other browser.
- [ ] `QA.md` updated when the PR adds, removes, or materially changes a user-facing flow (new page/modal/endpoint, new role gate, changed happy-path steps, shipped/unshipped feature moving in or out of the "Out of scope" list).
- [ ] [`backend/src/middleware/permissions.json`](./backend/src/middleware/permissions.json) updated when the PR adds / removes / changes a `requireRole(...)` gate or adds a new role-gated endpoint. The JSON is the canonical machine-readable RBAC source for agents and reviewers.

---

<a id="sprint-tracker"></a>
## Sprint Tracker Hand-off (NEXT.md + ROADMAP.md)

Every PR that closes a roadmap item **must** update the sprint trackers. This keeps the next agent unblocked — if `NEXT.md` still points at the item you just shipped, the next agent will waste a cycle re-implementing it.

### When your PR implements a roadmap item (e.g. DIF-006, AUTO-005, MNT-006)

- [ ] **`ROADMAP.md`** — Move the item from its phase table to the ✅ **Completed Work Summary** table. Include the PR number (e.g. `| DIF-006 | Standalone Playwright export | PR #112 |`).
- [ ] **`ROADMAP.md`** — Update the "Remaining" count in the fast-path section at the top (currently says `Remaining: 39 items`).
- [ ] **`NEXT.md` → `## ▶ Current PR`** — Replace this block entirely with the **next** item. Promote item 2 from the queue to be the new Current PR. Copy over its title, branch, effort, dependencies, files to change, acceptance criteria, and watch-outs.
- [ ] **`NEXT.md` → `## ⏭ Queue`** — Remove the promoted item. Shift items 3 and 4 up. Pick a new item 4 from `ROADMAP.md` (highest priority with `Dependencies: none`).
- [ ] **`NEXT.md` → `## ✅ Recently completed`** — Add your shipped item as the new top row with its PR number. Keep the table to the 3 most recent entries; drop the oldest.
- [ ] **`NEXT.md` → `## 🔀 Parallel opportunities`** — If your PR modified any file listed in the "Shared files?" column, remove or flag the affected parallel items.

### When your PR is infrastructure/docs/refactor (no roadmap ID)

- [ ] No `NEXT.md` update needed.
- [ ] No `ROADMAP.md` update needed.
- [ ] Still update `docs/changelog.md` if user-visible.

### Sanity checks before merging

- [ ] The `Current PR` block in `NEXT.md` **does not** still reference the item this PR shipped.
- [ ] The `Remaining: N items` count in `ROADMAP.md` decreased by exactly the number of items this PR closed.
- [ ] The item appears in `ROADMAP.md` ✅ Completed table **and** `NEXT.md` Recently completed — not only one.
- [ ] The next agent can run `cat NEXT.md` and immediately know what to build, without opening `ROADMAP.md`.

---

## CI Pipeline

CI runs on every push to `main`/`develop` and on PRs to `main` via `.github/workflows/ci.yml`.

1. **Secrets** — Gitleaks scan (full git history) gates all subsequent jobs. Blocks on accidentally committed API keys, JWT secrets, or credentials.
2. **Backend** — `npm install` → syntax check (`node --check`) → `npm test` → JSDoc generation → live smoke test (starts server, registers user, verifies cookie-based auth + CSRF on authenticated endpoints).
3. **Frontend** — `npm install` → `npm test` → `npm run build` (catches JSX errors, bad imports).
4. **Docs** — VitePress build + JSDoc assembly (runs after backend passes).
5. **Docker** — Builds both images, runs a container smoke test with cookie-based auth.

All five CI jobs must pass before merge. If CI fails, check the smoke test section first — it exercises the full auth flow (register → login → cookie extraction → CSRF-protected POST).

**To run locally before pushing:**

```bash
# Backend — tests must all pass
cd backend && npm test

# Frontend — build must succeed with zero errors
cd frontend && npm run build

# Frontend — tests must pass
cd frontend && npm test
```

---

## Mandatory Test Requirements

**Every PR that adds or modifies backend logic MUST include tests.** PRs without adequate test coverage will not be merged.

| Change type | Required tests | Where |
|---|---|---|
| New repository module | Unit tests for every exported function | Dedicated `tests/<module>.test.js` file |
| New shared utility (`utils/`) | Unit tests for all branches and edge cases | Dedicated file or added to `tests/utils.test.js` |
| New API endpoint or changed endpoint behaviour | Integration test exercising the HTTP flow (status codes, response shape, auth, error cases) | `tests/api-flow.test.js` or a dedicated file |
| Bug fix | Regression test that fails without the fix and passes with it | Closest existing test file or dedicated file |
| New middleware (rate limiter, CSRF, etc.) | Integration test verifying the middleware is wired correctly | Dedicated file or `tests/auth-cookies.test.js` |
| Security fix | Unit test for the fix mechanism AND integration test proving the vulnerability is closed | Dedicated file (e.g. `tests/security-hardening.test.js`) |
| Pipeline stage change | Unit tests | `tests/pipeline.test.js` or `tests/pipeline-orchestrator.test.js` |
| New user-facing flow (auth, project CRUD, run lifecycle, export, etc.) | E2E spec exercising the full HTTP/UI flow **and** a corresponding section / Golden E2E step in [QA.md](./QA.md) | `tests/e2e/specs/<area>.spec.mjs` (see STANDARDS.md § E2E Tests); update `QA.md` at repo root |

**Register every new test file** in `backend/tests/run-tests.js` so `npm test` runs it.

### Backend Test Conventions

Tests live in `backend/tests/` and use Node's built-in `assert/strict` — no test framework.

```bash
node tests/pipeline.test.js
node tests/self-healing.test.js
node tests/code-parsing.test.js
node tests/api-flow.test.js
node tests/auth-cookies.test.js
node tests/password-reset-token.test.js
node tests/security-hardening.test.js
node tests/artifact-signing.test.js
# Or all at once:
npm test
```

- Each test file must include a final summary line showing pass/fail counts and exit with `process.exit(1)` on any failure.
- Tests are synchronous where possible. Async tests must `await` all assertions before the test function returns.
- Integration tests reset state between tests using `getDatabase().exec("DELETE FROM ...")` and seed using repository modules.
- **Unit tests** (repositories, utilities): use the synchronous `test(name, fn)` pattern — no HTTP server needed.
- **Integration tests** (route handlers, auth flows): spin up the Express app on a random port via `app.listen(0)`, make real HTTP requests, and shut down in a `finally` block.
- **Shared test helpers** live in `backend/tests/helpers/test-base.js`. Use `createTestContext()`. Do not duplicate these patterns.

```js
// ✅ Unit test — one function, one behaviour, clear assertion
test("claim() returns null for an already-used token", () => {
  resetTokenRepo.create("tok-1", "U-1", futureExpiry);
  resetTokenRepo.claim("tok-1");
  assert.equal(resetTokenRepo.claim("tok-1"), null);
});

// ✅ Integration test — exercises the full HTTP path
out = await req(base, "/api/auth/reset-password", {
  method: "POST",
  body: { token: usedToken, newPassword: "New123!" },
});
assert.equal(out.res.status, 400, "Replaying a used token should fail");

// ❌ No assertion — test always passes
test("creates a token", () => {
  resetTokenRepo.create("tok-1", "U-1", futureExpiry);
});
```

### Frontend Tests

Tests live in `frontend/tests/` and also use plain Node `assert`. Run with `npm test` from `frontend/`.

### E2E Tests

Playwright suite at `tests/e2e/`. Run with `npm run e2e:test` from the repo root. UI specs are gated by `RUN_UI_E2E=true`; API specs run unconditionally. See **STANDARDS.md § E2E Tests** for full conventions and **REFERENCE.md § E2E Test Utilities** for the helper module table. Do not import directly from `@playwright/test` — go through `tests/e2e/utils/playwright.mjs`. Do not write custom auth or CSRF logic — use `loginWithRetry()` and `SessionClient` from `tests/e2e/utils/`.

### Testing DIF-001 (Visual Regression) and DIF-015 (Recorder)

**Recorder needs a headed Playwright window — `BROWSER_HEADLESS=true` silently breaks it.** With the default (`true`), the `RecorderModal`'s live CDP screencast still renders a frame, so the UI *looks* wired up — but no click in that pane reaches the headless recorded page. `Stop & Save` then returns HTTP 400 `no actions were captured`. Always start the backend with `BROWSER_HEADLESS=false` before using the Record-a-test button, and interact with the external Playwright window that opens on the desktop.

**Deterministic target page.** Pixel diffs are only meaningful against a page that won't drift between runs. Serve a static HTML with stable `data-testid` attributes via `python3 -m http.server 8080`. For a controlled >2% diff, change multiple CSS values at once:

```bash
sed -i 's/background: #fff/background: #d62828/; s/color: #111/color: #fff/; s/color: #1f7ae0/color: #ffd166/' /home/ubuntu/target/index.html
```

**`visualDiff` shape** in `runs.results[*].stepCaptures[*].visualDiff`: `{ status, diffPixels, totalPixels, diffRatio, threshold, baselinePath, diffPath }`. `status` is one of `baseline_created | match | regression | error`.

**Accept must rewrite the PNG, not just the DB row.** A silent no-op failure mode is updating only `baseline_screenshots` without touching disk. Always check `stat`/`md5sum` on baseline files before and after Accept.

---

## Versioning & Releases

Sentri uses **automatic semantic versioning** driven by [Conventional Commits](https://www.conventionalcommits.org/).

1. Write the PR title as a Conventional Commit (e.g. `feat: add rate limiting`).
2. PR is squash-merged to `main` — the PR title becomes the commit message.
3. `.github/workflows/release.yml` runs: scans commits for `feat:`, `fix:`, `perf:`, `BREAKING CHANGE:`, determines the bump, updates `version` in all three `package.json` files, promotes `## [Unreleased]` in `docs/changelog.md`, commits `chore(release): vX.Y.Z`, creates a git tag and GitHub Release.
4. `.github/workflows/cd.yml` triggers on the new `v*` tag: tags Docker images with `X.Y.Z`, `X.Y`, `sha-<commit>`, and `latest`. Deploys updated docs to GitHub Pages.

**What you need to do in every PR:**
1. Write the PR title as a Conventional Commit.
2. Update `docs/changelog.md` under `## [Unreleased]`.
That's it — versioning, tagging, and releases are fully automated.

---

## Changelog Format

Sentri follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The changelog lives at `docs/changelog.md`.

**Every PR that adds user-visible features, fixes, security changes, or breaking changes MUST update `docs/changelog.md`.**

### Format rules

- Entries go under `## [Unreleased]` at the top.
- Group entries under these headings (omit empty groups):

| Heading | When to use |
|---|---|
| `### Added` | New features, new endpoints, new UI pages |
| `### Changed` | Behaviour changes to existing features (non-breaking) |
| `### Deprecated` | Features that will be removed in a future version |
| `### Removed` | Features or APIs that were removed |
| `### Fixed` | Bug fixes |
| `### Security` | Vulnerability patches, auth hardening, rate limiting changes |

- Each entry is a single bullet starting with the area in bold: `- **Auth**: ...`, `- **API**: ...`
- Reference the PR number at the end: `(#78)`.
- Write from the user's perspective — what changed for them, not internal refactoring details.

### Example

```markdown
## [Unreleased]

### Added
- **API**: Three-tier global rate limiting — 300 req/15 min general, 20/hr for crawl/run, 30/hr for AI generation (#78)

### Fixed
- **Auth**: Password reset tokens now survive server restarts (DB-backed via migration 003) (#78)

### Security
- **Auth**: Atomic token claim prevents concurrent replay of password reset tokens (TOCTOU fix) (#78)
```

### What does NOT need a changelog entry

- Internal refactors with no user-visible effect
- Test-only changes
- Documentation-only changes (unless they document a new feature)
- CI/CD pipeline changes

---

## Security Checklist

Before submitting any PR that touches auth, routes, or data handling, verify:

- [ ] Passwords are hashed with `hashPassword()` (scrypt, random salt) — never stored plaintext.
- [ ] JWTs are validated with `requireAuth` (or `requireUser`/`requireTrigger`) on every non-public endpoint.
- [ ] JWTs are stored in HttpOnly cookies only — never returned in response bodies or stored in localStorage.
- [ ] Mutating endpoints (POST/PATCH/PUT/DELETE) are protected by CSRF double-submit cookie validation. Non-cookie auth strategies are auto-exempt. Public mutation paths must be added to `CSRF_EXEMPT_PATHS`.
- [ ] User-supplied strings are validated with `utils/validate.js` before DB writes.
- [ ] No sensitive data (API keys, passwords, full JWTs) is returned in API responses. Use `maskKey()` for display.
- [ ] Credential values stored in the DB use `credentialEncryption.js`.
- [ ] Any HTML rendered via `dangerouslySetInnerHTML` is sanitised — escape all user/AI-generated content.
- [ ] Error responses to clients never leak internal details (stack traces, SDK error messages). Return generic messages for 5xx errors.
