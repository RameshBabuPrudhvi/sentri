# Sentri — PR Review Checklist

> Also read [AGENT.md](./AGENT.md) (always-on rules), [STANDARDS.md](./STANDARDS.md) (coding conventions), [REFERENCE.md](./REFERENCE.md) (utils/env/auth tables), and [QA.md](./QA.md) (end-to-end validation) before submitting a PR.

---

## PR Checklist

- [ ] PR title follows Conventional Commits (`feat:`, `fix:`, `perf:`, `feat!:`, etc.)
- [ ] `docs/changelog.md` updated under `## [Unreleased]`
- [ ] All new backend logic has tests; new test files registered in `backend/tests/run-tests.js`
- [ ] CI passes locally (`cd backend && npm test` and `cd frontend && npm run build && npm test`)
- [ ] Security checklist reviewed if the PR touches auth, routes, or data handling
- [ ] Sprint tracker updated (see [Sprint Tracker Hand-off](#sprint-tracker) below)
- [ ] Self-review: no duplicated helpers or CSS classes, no files edited outside scope, new utilities in `utils/` not inline
- [ ] User-visible changes: walked the relevant section of [QA.md](./QA.md). Changes to the Golden E2E flow (auth → project → crawl → generate → approve → run → AI fix → visual → reports → automation → notifications → GDPR → permissions) require a full rerun on Chrome plus one other browser.
- [ ] `QA.md` updated if the PR adds, removes, or materially changes a user-facing flow
- [ ] `backend/src/middleware/permissions.json` updated if the PR adds, removes, or changes a role gate or role-gated endpoint
- [ ] **No orphan routes (PROC-001)** — every new `router.<method>()` in `backend/src/routes/*.js` must ship its frontend consumer in the same PR (helper in `frontend/src/api.js` + callsite in a page or component). Add `[no-ui]` to the PR title for genuinely UI-less endpoints (healthchecks, machine-only triggers); the `no-orphan-routes.yml` workflow enforces this.

---

<a id="sprint-tracker"></a>
## Sprint Tracker Hand-off

Every PR that closes a roadmap item must update the sprint trackers so the next agent knows what to build.

### When your PR implements a roadmap item

- [ ] **`ROADMAP.md` — Completed Work Summary**: add one row per shipped ID (e.g. `| DIF-006 | Standalone Playwright export | PR #112 |`). Never use `(bundled)` in the ID cell.
- [ ] **`ROADMAP.md` — Summary table**: increment `✅ Done`, decrement `🔲 Pending`, and recompute the `**Totals**` row. The narrative `Total tracked items:` line must match Totals exactly.
- [ ] **`ROADMAP.md` — Fast-path header**: update the `Remaining: ~N planned items` count.
- [ ] **`ROADMAP.md` — Prune the shipped item's `### <ID>` section** — the Completed Work Summary row is the canonical record.
- [ ] **`NEXT.md` → `## ▶ Current PR`**: replace the entire block with the next queue item — title, branch slug, effort/priority/dependencies, spec body, and a fresh PR checklist. Do not rewrite only the heading and leave the old scope below it.
  - Bundled PRs: heading is `## ▶ Current PR — <id1> + <id2> (bundled)`; each scope gets its own `### Scope N` sub-block; add a `**Do not split this PR.**` callout. Strip `(bundled)` when reading the heading as an ID.
- [ ] **`NEXT.md` → `## ⏭ Queue`**: remove the promoted item, renumber remaining slots, update the header count, and fill the empty slot with the next highest-priority unblocked item from `ROADMAP.md` (full spec, not just an ID).
- [ ] **`NEXT.md` → `## ✅ Recently completed`**: add the shipped item as the new top row with its PR number. Keep only the 3 most recent entries.
- [ ] **`NEXT.md` → `## 🔀 Parallel opportunities`**: remove or flag any item whose "Shared files?" column overlaps files this PR modified.

### When your PR is infrastructure / docs / refactor (no roadmap ID)

No `NEXT.md` or `ROADMAP.md` update needed. Still update `docs/changelog.md` if user-visible.

### Sanity checks before merging

- [ ] `NEXT.md` Current PR block does not reference the item this PR shipped
- [ ] `ROADMAP.md` Remaining count decreased by the number of items closed
- [ ] The item appears in both `ROADMAP.md` Completed table and `NEXT.md` Recently completed
- [ ] Running `cat NEXT.md` tells the next agent exactly what to build without opening `ROADMAP.md`

---

## CI Pipeline

CI runs on every push to `main`/`develop` and on PRs to `main` via `.github/workflows/ci.yml`.

| Job | Steps |
|---|---|
| **Secrets** | Gitleaks scan (full git history) — gates all subsequent jobs |
| **Backend** | `npm install` → syntax check → `npm test` → JSDoc generation → live smoke test (register → cookie auth → CSRF) |
| **Frontend** | `npm install` → `npm test` → `npm run build` |
| **Docs** | VitePress build + JSDoc assembly |
| **Docker** | Build both images → container smoke test with cookie-based auth |

All five jobs must pass before merge.

**Run locally before pushing:**

```bash
cd backend && npm test
cd frontend && npm run build && npm test
```

---

## Mandatory Test Requirements

Every PR that adds or modifies backend logic must include tests. PRs without adequate coverage will not be merged.

| Change type | Required tests | Location |
|---|---|---|
| New repository module | Unit tests for every exported function | `tests/<module>.test.js` |
| New shared utility (`utils/`) | Unit tests for all branches and edge cases | `tests/utils.test.js` or dedicated file |
| New or changed API endpoint | Integration test: status codes, response shape, auth, error cases | `tests/api-flow.test.js` or dedicated file |
| Bug fix | Regression test that fails before the fix and passes after | Nearest existing file or dedicated file |
| New middleware | Integration test verifying correct wiring | Dedicated file or `tests/auth-cookies.test.js` |
| Security fix | Unit test for the fix + integration test proving the vulnerability is closed | `tests/security-hardening.test.js` or dedicated file |
| Pipeline stage change | Unit tests | `tests/pipeline.test.js` or `tests/pipeline-orchestrator.test.js` |
| New user-facing flow | UI E2E spec (Playwright `page` fixture, DOM assertions, `--project=ui-chromium`) + QA.md section + ✅ row in `tests/e2e/COVERAGE.md` | `tests/e2e/specs/<area>-ui.spec.mjs`; update `QA.md` and `COVERAGE.md` |

Register every new test file in `backend/tests/run-tests.js`.

### Backend Test Conventions

Tests live in `backend/tests/` and use Node's built-in `assert/strict` — no framework.

```bash
node tests/pipeline.test.js   # or any individual file
npm test                       # all at once
```

- Every test file prints a pass/fail summary and exits with `process.exit(1)` on failure.
- Integration tests reset state between cases with `getDatabase().exec("DELETE FROM …")` and seed via repository modules.
- **Unit tests**: use the synchronous `test(name, fn)` pattern — no HTTP server.
- **Integration tests**: spin up Express on a random port via `app.listen(0)`, make real HTTP requests, shut down in `finally`.
- **Shared helpers**: `backend/tests/helpers/test-base.js` — use `createTestContext()`, do not duplicate.

```js
// ✅ Unit test
test("claim() returns null for an already-used token", () => {
  resetTokenRepo.create("tok-1", "U-1", futureExpiry);
  resetTokenRepo.claim("tok-1");
  assert.equal(resetTokenRepo.claim("tok-1"), null);
});

// ✅ Integration test
out = await req(base, "/api/auth/reset-password", {
  method: "POST",
  body: { token: usedToken, newPassword: "New123!" },
});
assert.equal(out.res.status, 400, "Replaying a used token should fail");

// ❌ No assertion — always passes, do not do this
test("creates a token", () => {
  resetTokenRepo.create("tok-1", "U-1", futureExpiry);
});
```

### Frontend Tests

Tests live in `frontend/tests/` and use plain Node `assert`. Run with `npm test` from `frontend/`.

### E2E Tests

Playwright suite at `tests/e2e/`. Run with `npm run e2e:test` from the repo root. UI specs require `RUN_UI_E2E=true`; API specs run unconditionally.

- Do not import directly from `@playwright/test` — use `tests/e2e/utils/playwright.mjs`.
- Do not write custom auth or CSRF logic — use `loginWithRetry()` and `SessionClient` from `tests/e2e/utils/`.
- See **STANDARDS.md § E2E Tests** and **REFERENCE.md § E2E Test Utilities** for full conventions.

### Testing DIF-001 (Visual Regression) and DIF-015 (Recorder)

**Recorder requires a headed browser.** With `BROWSER_HEADLESS=true` (default) the canvas renders frames but clicks never reach the recorded page — `Stop & Save` returns `400 no actions were captured`. Always start the backend with `BROWSER_HEADLESS=false` before using the Record button.

**Visual diff tips:**
- Use a static HTML page with stable `data-testid` attributes as the target (`python3 -m http.server 8080`).
- To force a >2% diff, change multiple CSS values at once: `sed -i 's/background: #fff/background: #d62828/; …' index.html`
- `visualDiff` shape: `{ status, diffPixels, totalPixels, diffRatio, threshold, baselinePath, diffPath }`. `status`: `baseline_created | match | regression | error`.
- Accept must rewrite the PNG on disk, not only the DB row — verify with `stat`/`md5sum` before and after.

---

## Versioning & Releases

Sentri uses automatic semantic versioning driven by [Conventional Commits](https://www.conventionalcommits.org/).

1. Write the PR title as a Conventional Commit (`feat: add rate limiting`, `fix: correct token expiry`, etc.)
2. PR is squash-merged to `main` — the title becomes the commit message.
3. `release.yml` bumps the version, promotes `## [Unreleased]` in the changelog, commits `chore(release): vX.Y.Z`, and creates a GitHub Release + git tag.
4. `cd.yml` triggers on the new `v*` tag: tags Docker images (`X.Y.Z`, `X.Y`, `sha-<commit>`, `latest`) and deploys docs to GitHub Pages.

**Your only responsibilities:** write a valid Conventional Commit title and update `docs/changelog.md` under `## [Unreleased]`.

---

## Changelog Format

Sentri follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). File: `docs/changelog.md`.

Update the changelog in every PR that adds a user-visible feature, bug fix, security change, or breaking change.

### Format rules

- Entries go under `## [Unreleased]`.
- Group under these headings (omit empty ones): `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed`, `### Security`
- One bullet per change: `- **Area**: what changed for the user. (#PR)`
- **Keep each bullet to a single sentence (≤200 chars).** If a multi-bundle / multi-feature PR has more than one user-visible change, write one bullet per change — NOT one mega-bullet that runs paragraphs. Big infrastructure PRs can have 5–10 short bullets under the same heading; that's correct and expected.
- Write from the user's perspective — not internal implementation detail. Operator-visible nouns (`Settings → AI Providers`, `agent_messages` table, env vars, role names) are fine. SDK-level internals (renamed functions, refactored modules, test helpers, migration script flags) are not.
- The bullet should make sense to someone reading the changelog at release time — not to a reviewer reading the diff. If a reviewer needs the detail, it belongs in the PR description or commit body.
- Skip: internal refactors, test-only changes, doc-only changes, CI changes.

### What NOT to do

```markdown
<!-- ❌ Too long, implementation-heavy, mixes 8 different changes into one bullet -->
- **AUTO-023 Bundle 5** — Thread blackboard (migration `063`, `agentThreadStateRepo.get`/`setKey`/`casUpdate`, optimistic CAS via `ERR_AGENT_THREAD_STATE_VERSION_MISMATCH` with HTTP 409 semantics, 64KB cap via `AGENT_THREAD_STATE_MAX_BYTES`); tool registry at `aiProvider/agentTools/index.js` with five tools, per-role visibility intersected with `agent_configs.allowedTools` (migration `064`); server-side dispatch via `executeToolCall` with `withTimeout` 30s helper, `agent_tool_calls_total{tool,outcome}` Prometheus counter, `tool_call`/`tool_result` envelope intents added to `agentEnvelope.INTENTS`; peer Q&A with `MAX_PEER_NESTING=3` guard via `peerNestingByThread` Map, cross-process Redis pub/sub bridge on `sentri:agent-peer-answer` channel via `ensurePeerBridgeSubscribed` + `publishPeerAnswer`; production wire-up in `journeyGenerator.generateFromDescription` (author dedup) + `feedbackLoop.runReviewerAuthorLoop` (reviewer dryRun); UI tool-call timeline with `.ac-tool-chip--{call,success,error}` chips in `AgentConversation.jsx`. (#38)
```

### Example (correct)

```markdown
## [Unreleased]

### Added
- **API**: Three-tier global rate limiting — 300 req/15 min general, 20/hr for crawl/run, 30/hr for AI generation. (#78)
- **Multi-agent**: Thread-scoped shared blackboard with optimistic concurrency and a 64 KB size cap (`AGENT_THREAD_STATE_MAX_BYTES`). (#38)
- **Multi-agent**: Closed-set tool registry with five read-only tools (`db.listExistingTests`, `db.getTest`, `crawl.getPageHtml`, `playwright.dryRun`, `thread.askPeer`); per-role visibility intersected with `agent_configs.allowedTools`. (#38)
- **Multi-agent**: Per-tool rate limiting (sliding window, Redis-backed with in-memory fallback) configurable via `AGENT_TOOL_RATE_LIMIT_PER_MIN`. (#38)
- **UI**: Colour-coded tool-call timeline in the Test Lab conversation feed — chips show tool name, result summary, and call/success/error variant. (#38)

### Fixed
- **Auth**: Password reset tokens now survive server restarts. (#78)

### Security
- **Auth**: Atomic token claim prevents concurrent replay of password reset tokens. (#78)
```

Multi-bundle PRs: emit one bullet per shipped feature, with the bundle id prefixed in the bold area tag (`**AUTO-023 Bundle 5**`) so a reader scanning the changelog sees grouping at a glance without paragraph-blob density.

---

## Security Checklist

Review before submitting any PR that touches auth, routes, or data handling.

- [ ] Passwords hashed with `hashPassword()` (scrypt + random salt) — never stored plaintext
- [ ] Every non-public endpoint protected by `requireAuth` (or `requireUser` / `requireTrigger`)
- [ ] JWTs stored in HttpOnly cookies only — never in response bodies or `localStorage`
- [ ] Mutating endpoints (POST / PATCH / PUT / DELETE) validated with CSRF double-submit cookie; public mutation paths added to `CSRF_EXEMPT_PATHS`
- [ ] User-supplied strings validated with `utils/validate.js` before DB writes
- [ ] No sensitive data (API keys, passwords, full JWTs) in API responses — use `maskKey()` for display
- [ ] Credential values stored via `credentialEncryption.js`
- [ ] Any `dangerouslySetInnerHTML` content escaped — never render raw user or AI-generated strings
- [ ] 5xx error responses return generic messages — no stack traces or internal SDK errors exposed to clients
