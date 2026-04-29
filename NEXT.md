# NEXT.md — Current Sprint Target

> **For agents:** Read this file only. Do not read ROADMAP.md unless you need context on items
> beyond the current PR. Everything you need to start work is here.
>
> **For humans:** Update this file when a PR ships. Move the completed item to ROADMAP.md ✅ table,
> promote the next item from the queue below, and rewrite the "Current PR" block.

---

## ▶ Current PR — AUTO-016

**Title:** Accessibility testing (axe-core integration)
**Branch:** `feat/AUTO-016-axe-core`
**Effort:** M | **Priority:** 🟡 High
**All dependencies:** ✅ none

### What to build

During crawl, inject `@axe-core/playwright` and run `checkA11y()` on each page. Store violations in a new `accessibility_violations` table. Surface per-page report in crawl results and dashboard.

### Files to change

| File | Change |
|------|--------|
| `backend/src/pipeline/crawlBrowser.js` | Inject `@axe-core/playwright` and call `checkA11y()` after page settles |
| `backend/src/database/migrations/` | Add `accessibility_violations` table |
| `frontend/src/components/crawl/CrawlView.jsx` | Per-page accessibility violation panel |
| `backend/package.json` | Add `@axe-core/playwright` |

### Lanes (for AGENT.md § Branch co-ownership protocol)

- **agent-scope:** `backend/src/pipeline/**`, `backend/src/database/migrations/**`, `backend/package.json`, `backend/tests/**` — claimable by any single agent
- **human-scope:** `frontend/src/components/crawl/CrawlView.jsx` — UI surfacing of violations
- **shared (coordinate via PR comment before editing):** `docs/changelog.md`, `ROADMAP.md`, this file

### Acceptance criteria

- [ ] Each crawled page produces an `accessibility_violations` row per detected WCAG 2.1 violation
- [ ] CrawlView surfaces per-page accessibility report with severity + WCAG criterion
- [ ] axe-core injection is best-effort — a failure does not abort the crawl
- [ ] No violations produced on a clean fixture page (sanity test)

### PR checklist

- [ ] Update `AUTO-016` status in `ROADMAP.md` to ✅ Complete with PR number
- [ ] Update this file: move AUTO-016 to "Recently completed", promote MNT-006 to "Current PR"
- [ ] Add entry to `docs/changelog.md` under `## [Unreleased]`

---

## ⏭ Queue (next 3 PRs after current)

### 2 · MNT-006 — Object storage for artifacts (S3 / R2)
**Effort:** M | **Priority:** 🟡 High | **Dependencies:** none

Add `objectStorage` abstraction with local-disk adapter (current behaviour) and S3/R2 adapter. Switch via `STORAGE_BACKEND=s3`. Update artifact read/write paths and `signArtifactUrl()` to produce pre-signed S3 URLs.

**Files:** `backend/src/runner/pageCapture.js` · `backend/src/runner/screencast.js` · `backend/src/utils/objectStorage.js` (new) · `backend/.env.example`

---

### 3 · AUTO-012 — SLA / quality gate enforcement
**Effort:** M | **Priority:** 🟡 High | **Dependencies:** none

Per-project `qualityGates` config (min pass rate, max flaky %, max failures). On run completion, evaluate gates and include `{ passed, violations[] }` in both the trigger response and run result. GitHub Action exit code reflects gate status.

**Files:** `backend/src/routes/projects.js` · `backend/src/testRunner.js` · `backend/src/routes/trigger.js` · `frontend/src/pages/ProjectDetail.jsx`

---

## 🔀 Parallel opportunities (small items, no queue conflicts)

These can be picked up by a second engineer alongside the current PR without file conflicts:

| ID | Title | Effort | Shared files? |
|----|-------|--------|---------------|
| AUTO-017 | Performance budget testing (Web Vitals) | M | None |
| AUTO-019 | Run diffing: per-test comparison across runs | M | None |
| DIF-007 | Conversational test editor connected to /chat | M | None |

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| DIF-013 | Anonymous usage telemetry (PostHog + opt-out) | #3 |
| AUTO-006 | Network condition simulation (slow 3G / offline) | #3 |
| DIF-015b | Recorder selectorGenerator naming alignment | #3 |

*Full completed list → ROADMAP.md § Completed Work*