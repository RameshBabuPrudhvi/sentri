# NEXT.md — Current Sprint Target

> **For agents:** Read this file only. Do not read ROADMAP.md unless you need context on items
> beyond the current PR. Everything you need to start work is here.
>
> **For humans:** Update this file when a PR ships. Move the completed item to ROADMAP.md ✅ table,
> promote the next item from the queue below, and rewrite the "Current PR" block.

---

## ▶ Current PR — AUTO-016b

**Title:** Frontend CrawlView accessibility violation panel
**Branch:** `feat/AUTO-016b-a11y-panel`
**Effort:** S | **Priority:** 🟡 High
**All dependencies:** ✅ AUTO-016 (PR #121)

### What to build

Backend half of AUTO-016 shipped in PR #121 (axe-core scan + persistence + per-page summary on `run.pages[].accessibilityViolations`). This item adds the human-scope UI: a per-page accessibility panel in `frontend/src/components/crawl/CrawlView.jsx` showing severity + WCAG criterion + collapsed node-list, plus a "Top accessibility offenders" rollup on the dashboard.

### Files to change

| File | Change |
|------|--------|
| `frontend/src/components/crawl/CrawlView.jsx` | Per-page a11y panel (severity, WCAG criterion, node list) |
| `frontend/src/pages/Dashboard.jsx` | "Top accessibility offenders" rollup card |
| `backend/src/routes/dashboard.js` | A11y rollup field on dashboard summary |
| optional: new `GET /api/v1/runs/:id/accessibility` | Backed by `accessibilityViolationRepo.getByRunId()` |

### PR checklist

- [ ] Update `AUTO-016b` status in `ROADMAP.md` to ✅ Complete with PR number
- [ ] Update this file: move AUTO-016b to "Recently completed", promote next item from Queue
- [ ] Add entry to `docs/changelog.md` under `## [Unreleased]`

---

## ⏭ Queue (next 3 PRs after current)

### 2 · AUTO-012 — SLA / quality gate enforcement
**Effort:** M | **Priority:** 🟡 High | **Dependencies:** none

Per-project `qualityGates` config (min pass rate, max flaky %, max failures). On run completion, evaluate gates and include `{ passed, violations[] }` in both the trigger response and run result. GitHub Action exit code reflects gate status.

**Files:** `backend/src/routes/projects.js` · `backend/src/testRunner.js` · `backend/src/routes/trigger.js` · `frontend/src/pages/ProjectDetail.jsx`

---

## 🔀 Parallel opportunities (small items, no queue conflicts)

These can be picked up by a second engineer alongside the current PR without file conflicts:

| ID | Title | Effort | Shared files? |
|----|-------|--------|---------------|
| **DIF-015b Gap 2** | **Recorder selectorGenerator: data-testid quality scoring** | **S** | **`backend/src/runner/recorder.js` only — no overlap with AUTO-016 / MNT-006 / AUTO-012** |
| DIF-015b Gap 3 | Recorder selectorGenerator: iframe + shadow-DOM traversal | M | `backend/src/runner/recorder.js` only |
| AUTO-017 | Performance budget testing (Web Vitals) | M | None |
| AUTO-019 | Run diffing: per-test comparison across runs | M | None |
| DIF-007 | Conversational test editor connected to /chat | M | None |

> **DIF-015b follow-up priority:** Gap 2 (data-testid scoring) is the highest-value next step — it's a small, contained edit to the priority chain in `selectorGenerator()` and unblocks DIF-015b flipping to ✅ Complete in ROADMAP.md once Gap 3 also ships. Both gaps are documented in `ROADMAP.md` § DIF-015b with concrete heuristics, files-to-change, and acceptance criteria. Pick Gap 2 next; defer Gap 3 to a separate PR (different effort tier).
>
> Why these aren't promoted to "Current PR" yet: AUTO-016 (axe-core) is the queued sprint item with a higher priority label (🟡 High) than DIF-015b sub-items (🔵 Medium). The recorder gaps are tracked here so they don't get lost — pick them up alongside AUTO-016 if a second agent has bandwidth.

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| MNT-006 | Object storage abstraction — local-disk default + S3/R2 pre-signed URLs for screenshots, visual-diff baselines, and diffs (dual-write to local disk in s3 mode) | #122 |
| AUTO-016 (backend) | Accessibility testing — axe-core crawl scan + persistence (frontend `CrawlView` panel tracked as AUTO-016b) | #121 |
| DIF-013 | Anonymous usage telemetry (PostHog + opt-out, full event set) | #3, #120 |
| AUTO-006 | Network condition simulation (slow 3G / offline) + run persistence | #3, #120 |

*Full completed list → ROADMAP.md § Completed Work*