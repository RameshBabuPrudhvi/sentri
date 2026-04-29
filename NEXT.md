# NEXT.md — Current Sprint Target

> **For agents:** Read this file only. Do not read ROADMAP.md unless you need context on items
> beyond the current PR. Everything you need to start work is here.
>
> **For humans:** Update this file when a PR ships. Move the completed item to ROADMAP.md ✅ table,
> promote the next item from the queue below, and rewrite the "Current PR" block.

---

## ▶ Current PR — AUTO-005

**Title:** Automatic test retry with flake isolation
**Branch:** `feat/AUTO-005-test-retry`
**Effort:** M | **Priority:** 🟡 High
**All dependencies:** ✅ none

### What to build

Wrap per-test execution in a retry loop (default: 2 retries) before marking a test failed. Record `retryCount` and `failedAfterRetry` on the result. Only fire notifications and increment failure counts after all retries are exhausted.

### Files to change

| File | Change |
|------|--------|
| `backend/src/testRunner.js` | Wrap per-test execution in a retry loop (env: `MAX_TEST_RETRIES`, default 2) |
| `backend/src/database/migrations/` | Add `retryCount`, `failedAfterRetry` columns to run results |
| `backend/.env.example` | Document `MAX_TEST_RETRIES` |

### Lanes (for AGENT.md § Branch co-ownership protocol)

- **agent-scope:** `backend/src/testRunner.js`, `backend/src/runner/**`, `backend/src/database/migrations/**`, `backend/.env.example`, `backend/tests/**` — claimable by any single agent
- **human-scope:** any frontend surfacing of retry counts on the run detail page
- **shared (coordinate via PR comment before editing):** `docs/changelog.md`, `ROADMAP.md`, this file

### Acceptance criteria

- [ ] A test that fails on attempt 1 but passes on attempt 2 is reported as `passed` with `retryCount: 1`
- [ ] A test that fails all attempts has `failedAfterRetry: true` on its result
- [ ] Notifications and failure counters only fire after the final retry is exhausted
- [ ] `MAX_TEST_RETRIES` env var controls the retry budget; default is 2

### PR checklist

- [ ] Update `AUTO-005` status in `ROADMAP.md` to ✅ Complete with PR number
- [ ] Update this file: move AUTO-005 to "Recently completed", promote AUTO-016 to "Current PR"
- [ ] Add entry to `docs/changelog.md` under `## [Unreleased]`

---

## ⏭ Queue (next 3 PRs after current)

### 2 · AUTO-016 — Accessibility testing (axe-core)
**Effort:** M | **Priority:** 🟡 High | **Dependencies:** none

During crawl, inject `@axe-core/playwright` and run `checkA11y()` on each page. Store violations in a new `accessibility_violations` table. Surface per-page report in crawl results and dashboard.

**Files:** `backend/src/pipeline/crawlBrowser.js` · `backend/src/database/migrations/` · `frontend/src/components/crawl/CrawlView.jsx` · `backend/package.json` (add `@axe-core/playwright`)

---

### 3 · MNT-006 — Object storage for artifacts (S3 / R2)
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
| DIF-015 | Recorder canvas input forwarding + step format alignment + Playwright-recorder action parity | #118 |
| DIF-006 | Standalone Playwright export (zero vendor lock-in) | #1 |

*Full completed list → ROADMAP.md § Completed Work*