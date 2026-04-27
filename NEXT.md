# NEXT.md — Current Sprint Target

> **For agents:** Read this file only. Do not read ROADMAP.md unless you need context on items
> beyond the current PR. Everything you need to start work is here.
>
> **For humans:** Update this file when a PR ships. Move the completed item to ROADMAP.md ✅ table,
> promote the next item from the queue below, and rewrite the "Current PR" block.

---

## ▶ Current PR — DIF-006

**Title:** Standalone Playwright export (zero vendor lock-in)
**Branch:** `feat/DIF-006-playwright-export`
**Effort:** M (3–5 days) | **Priority:** 🟢 Differentiator
**All dependencies:** ✅ none

### What to build

Add a download endpoint that zips all approved tests for a project as a runnable Playwright project — so users can eject from Sentri at any time.

The zip must contain:
- `playwright.config.ts` — pre-configured for the project's base URL
- `tests/<test-name>.spec.ts` per approved test — existing Playwright code wrapped in a proper `test('name', async ({ page }) => { … })` block
- `README.md` — instructions to `npm install && npx playwright test`

### Files to change

| File | Change |
|------|--------|
| `backend/src/utils/exportFormats.js` | Add `buildPlaywrightZip(project, tests)` — assemble the zip using `archiver` or `jszip` |
| `backend/src/routes/tests.js` | Add `GET /api/v1/projects/:id/export/playwright` — fetch approved tests, call builder, stream zip |
| `frontend/src/pages/Tests.jsx` | Add "Export as Playwright project" button that triggers a file download |

### Lanes (for AGENT.md § Branch co-ownership protocol)

- **agent-scope:** `backend/src/utils/exportFormats.js`, `backend/src/routes/tests.js`, `backend/tests/**` (new tests for the endpoint + builder) — claimable by any single agent (devin / claude / codex / cursor / copilot)
- **human-scope:** `frontend/src/pages/Tests.jsx` and any other `frontend/**` change
- **shared (coordinate via PR comment before editing):** `docs/changelog.md`, `ROADMAP.md`, this file

### Acceptance criteria

- [ ] `GET /api/v1/projects/:id/export/playwright` returns `Content-Type: application/zip`
- [ ] Unzipping the download and running `npx playwright test` executes all approved tests without modification
- [ ] Button appears only when the project has ≥1 approved test
- [ ] Endpoint returns 404 if project not found, 403 if not workspace member

### Watch out for

- `exportFormats.js` is a shared file — **MNT-005** (Gherkin export) will also modify it. If MNT-005 is being worked in parallel, coordinate on this file before branching.
- Wrap each test's raw Playwright code in `test.describe` only if it spans multiple steps — single-action tests should be flat `test()` blocks.

### PR checklist

- [ ] Update `DIF-006` status in `ROADMAP.md` to ✅ Complete with PR number
- [ ] Update this file: move DIF-006 to "Recently completed", promote AUTO-005 to "Current PR"
- [ ] Add entry to `docs/changelog.md` under `## [Unreleased]`

---

## ⏭ Queue (next 3 PRs after current)

### 2 · AUTO-005 — Automatic test retry with flake isolation
**Effort:** M | **Priority:** 🟡 High | **Dependencies:** none

Wrap per-test execution in a retry loop (default: 2 retries) before marking a test failed. Record `retryCount` and `failedAfterRetry` on the result. Only fire notifications and increment failure counts after all retries are exhausted.

**Files:** `backend/src/testRunner.js` · `backend/src/database/migrations/` (add `retryCount`, `failedAfterRetry` to run results) · `backend/.env.example` (document `MAX_TEST_RETRIES`)

---

### 3 · AUTO-016 — Accessibility testing (axe-core)
**Effort:** M | **Priority:** 🟡 High | **Dependencies:** none

During crawl, inject `@axe-core/playwright` and run `checkA11y()` on each page. Store violations in a new `accessibility_violations` table. Surface per-page report in crawl results and dashboard.

**Files:** `backend/src/pipeline/crawlBrowser.js` · `backend/src/database/migrations/` · `frontend/src/components/crawl/CrawlView.jsx` · `backend/package.json` (add `@axe-core/playwright`)

---

### 4 · MNT-006 — Object storage for artifacts (S3 / R2)
**Effort:** M | **Priority:** 🟡 High | **Dependencies:** none

Add `objectStorage` abstraction with local-disk adapter (current behaviour) and S3/R2 adapter. Switch via `STORAGE_BACKEND=s3`. Update artifact read/write paths and `signArtifactUrl()` to produce pre-signed S3 URLs.

**Files:** `backend/src/runner/pageCapture.js` · `backend/src/runner/screencast.js` · `backend/src/utils/objectStorage.js` (new) · `backend/.env.example`

---

## 🔀 Parallel opportunities (small items, no queue conflicts)

These can be picked up by a second engineer alongside the current PR without file conflicts:

| ID | Title | Effort | Shared files? |
|----|-------|--------|---------------|
| DIF-013 | Anonymous usage telemetry (PostHog + opt-out) | S | None |
| DIF-015b | Recorder selector quality: adopt Playwright's selectorGenerator | S | `recorder.js` only |
| AUTO-012 | SLA / quality gate enforcement | M | None |

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| FEA-002 | TanStack React Query data layer | #107 |
| MNT-011 | Persist crawl/generate dialsConfig on run record | #107 |
| DIF-002b | Cross-browser polish: browser-aware baselines + badges | #110 |

*Full completed list → ROADMAP.md § Completed Work*