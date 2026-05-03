# NEXT.md — Current Sprint Target

> **For agents:** Read this file only. Do not read ROADMAP.md unless you need context on items
> beyond the current PR. Everything you need to start work is here.
>
> **For humans:** Update this file when a PR ships. Move the completed item to ROADMAP.md ✅ table,
> promote the next item from the queue below, and rewrite the "Current PR" block.

---

## ▶ Current PR — CAP-004 + MET-001 + PROC-002 (bundled)

**Title:** Self-healing telemetry dashboard + shared time-series metrics + sprint-tracker hand-off automation
**Branch:** `feat/cap-004-healing-met-001-proc-002`
**Effort:** M (bundled) | **Priority:** 🔵 Medium
**All dependencies:** none (promoted per rotation rule after PR #12 shipped CAP-003)

> CAP-003 (secret scanner gate) ✅ shipped in PR #12. **Three queue items are bundled into this PR** so the agent has meaningful surface area and we avoid re-doing the trend chart twice (CAP-004's savings chart is the first consumer of MET-001's `<TrendChart>`). PROC-002 piggy-backs because it eliminates the exact NEXT.md / ROADMAP.md / changelog hand-off churn that PR #12 hit, and it pays for itself on the very next PR after this one.

**Do not split this PR.** Codex agents tend to ship the minimum viable slice; this prompt is the explicit instruction to ship all three together.

### Scope 1 — CAP-004: Self-healing telemetry dashboard

Sentri claims self-healing as a differentiator but surfaces no win-rate metrics. Data already lives in `healingRepo` (per-test strategy histogram from PR #100's `test.healing` telemetry pipeline). Add a `/healing` page rendering: per-strategy success rate, top-healed selectors, and a "tests-that-would-have-failed" savings estimate trended over time via the new `<TrendChart>` from MET-001.

**Files:** new `frontend/src/pages/HealingDashboard.jsx` · new `backend/src/routes/healing.js` (`GET /api/v1/healing/summary` aggregating from `healingRepo`) · `frontend/src/api.js` (`getHealingSummary()` helper) · sidebar nav entry · `backend/src/middleware/permissions.json` entry for the new route · `backend/tests/healing-summary.test.js`

### Scope 2 — MET-001: Shared time-series metrics table + `<TrendChart>` component

Web Vitals (AUTO-017), flaky-rate (DIF-004), accessibility violations (AUTO-016), pass-rate, MTTR — every "value over time per project" surface today would otherwise build its own aggregation. Build it once: a generic `metric_samples (projectId, metricKey, ts, value, tags JSON)` table, a `recordMetric()` helper, and a reusable `<TrendChart metricKey=...>` React component with band overlays + threshold lines. **Wire CAP-004's savings chart through `<TrendChart>` to validate end-to-end** — that's the integration test for MET-001 and removes the need for a throwaway sample wiring.

**Files:** new migration `016_metric_samples.sql` · new `backend/src/database/repositories/metricSamplesRepo.js` · new `backend/src/utils/recordMetric.js` (call-site helper) · new `frontend/src/components/shared/TrendChart.jsx` · `backend/tests/metric-samples.test.js`

### Scope 3 — PROC-002: Sprint-tracker hand-off automation

The NEXT.md / ROADMAP.md / `docs/changelog.md` update dance after every shipped PR is currently manual and reviewer-flagged (REVIEW.md § Sprint Tracker Hand-off). Add a `scripts/promote-sprint-item.mjs` Node script that, given a shipped PR number and the new slot-2 item id, performs the full hand-off: rewrites the Current PR block in `NEXT.md`, shifts the queue, prepends the shipped row to the Recently completed table (capped at 3 entries), updates the fast-path `Current sprint` line in `ROADMAP.md`, decrements the remaining-items count, and appends a Completed Work Summary row. **Use the script (not hand-edits) to perform this PR's own hand-off** — that's the integration test for PROC-002.

**Files:** new `scripts/promote-sprint-item.mjs` · new `scripts/__fixtures__/promote-sprint-item/` (golden NEXT.md / ROADMAP.md before/after) · new `scripts/promote-sprint-item.test.mjs` · register in `backend/tests/run-tests.js`

### PR checklist

- [ ] **All three scopes shipped in one PR — do not split**
- [ ] CAP-004: `/healing` page renders per-strategy success rate, top-healed selectors, and savings estimate
- [ ] CAP-004: Sidebar nav entry routes to `/healing` and is gated on the same role as the existing telemetry surfaces
- [ ] CAP-004: `backend/tests/healing-summary.test.js` covers empty-data and populated-histogram cases
- [ ] MET-001: `<TrendChart>` is consumed by CAP-004's savings chart (no throwaway sample wiring)
- [ ] MET-001: `recordMetric()` is called from at least one existing telemetry callsite (e.g. healing event ingestion) so the table has real data
- [ ] PROC-002: this PR's own NEXT.md / ROADMAP.md / changelog hand-off is performed by `scripts/promote-sprint-item.mjs`, not by hand
- [ ] Add entry to `docs/changelog.md` under `## [Unreleased]` (one entry per scope, grouped under appropriate Keep-a-Changelog sections)
- [ ] `backend/src/middleware/permissions.json` updated for any new role-gated routes (per REVIEW.md)

---

## ⏭ Queue (next 3 PRs after current)

### 2 · AUTO-017.3 + PROC-001 (bundled)
**Effort:** S (S + XS) | **Priority:** 🔵 Medium | **Dependencies:** AUTO-017.3 needs MET-001 (shipped in Current PR — `<TrendChart>` available); PROC-001 has none | **Source:** ROADMAP.md Phase 4 + `docs/roadmap-gaps-pr8.md` § PROC-001

> Both items are tiny and unrelated in scope, so bundling them into a single PR is cheaper than two separate hand-offs. They touch disjoint files (frontend chart wiring vs. CI workflow + docs) so the diff stays reviewable.

#### Scope 1 — AUTO-017.3: Web Vitals trend chart

**UI landing surface (post-PR #6 layout — UI-REFACTOR-001):** Quality Gates / Web Vitals Budgets config no longer lives in `ProjectDetail → Settings` — it was moved exclusively to the Automation page (`/automation`) under the **Quality Gates** top-level tab → per-project accordion → `ProjectQualityCard` → **Web Vitals** inner tab. `QualityGatesPanel` and `WebVitalsBudgetsPanel` both share the new `ConfigurablePanel` abstraction. The trend chart belongs next to the Web Vitals budget-config form inside `ProjectQualityCard`'s Web Vitals tab — do **not** add it to `ProjectDetail.jsx` (no budget config there anymore) or to RunDetail (that's per-run, not per-project trend).

With MET-001 landed, add a `<TrendChart metricKey="webVitals.lcp" />` (and one each for CLS / INP / TTFB) inside the Web Vitals tab of `ProjectQualityCard`, backfilled from existing per-run `webVitalsResult`. Threshold lines come from the project's `webVitalsBudgets` so users see violations in context. Pure consumer of MET-001 — no new backend schema beyond a `recordMetric()` callsite in `backend/src/testRunner.js` after `evaluateWebVitalsBudgets()`. Also update the **status chip** logic in `frontend/src/utils/automationStatus.js` (shipped with PR #6) if chip copy needs to reflect trend-chart availability.

**Files:** `backend/src/testRunner.js` (call `recordMetric()` for each Web Vital after the existing `evaluateWebVitalsBudgets()`) · `frontend/src/components/automation/ProjectQualityCard.jsx` (embed `<TrendChart>` inside the Web Vitals inner tab) · `frontend/src/utils/automationStatus.js` + `frontend/tests/automation-status.test.js` (if chip contract changes) · `backend/tests/web-vitals-trend.test.js` (metric-sample ingestion + retrieval)

**Verify before starting:** the component paths above reflect PR #6's changelog. Run `grep -r "WebVitalsBudgetsPanel\|ProjectQualityCard" frontend/src` against the PR's HEAD to confirm the files exist exactly as named before wiring — PR #6 landed `ConfigurablePanel` but the exact file names should be double-checked.

#### Scope 2 — PROC-001: Require backend PRs to ship UI in the same PR

Docs-only convention change: every new backend route must have its frontend consumer in the same PR (no API-orphan PRs). Update `REVIEW.md`, `AGENT.md`, and the PR template checklist; add a CI check that fails when a PR adds a route to `backend/src/routes/*.js` without touching `frontend/src/api.js` or any `frontend/src/pages/*.jsx`.

**Files:** `REVIEW.md` (new checklist row) · `AGENT.md` (convention section) · `.github/PULL_REQUEST_TEMPLATE.md` (checkbox) · new `.github/workflows/no-orphan-routes.yml` (or extend an existing workflow) · short doc note in `CONTRIBUTING.md`

### 3 · AUTO-003 — Confidence scoring and auto-approval of low-risk tests
**Effort:** M | **Priority:** 🟢 Differentiator | **Dependencies:** none | **Source:** `ROADMAP.md` Phase 4 (AUTO-003)

Every generated test currently requires manual approval (`reviewStatus: 'draft'`). For truly autonomous operation, the system should auto-approve tests above a confidence threshold. A quality score already exists in `backend/src/pipeline/deduplicator.js:226-272` but is never used for approval decisions — expose it as `tests.confidenceScore`, add a per-project `autoApproveThreshold` setting (default: disabled / off), and on generation auto-approve tests above the threshold. Log auto-approvals in the activity trail (`userName: "auto-approver"` so the audit history is honest about how the test got approved). Add a "review auto-approved tests" filter in the Tests page so reviewers can spot-check a sample.

**Files:** `backend/src/pipeline/deduplicator.js` (expose quality score as `confidenceScore` on the test record) · `backend/src/pipeline/testPersistence.js` (auto-approve logic gated on per-project threshold) · `backend/src/database/migrations/` (new `confidenceScore` column on `tests`; new `autoApproveThreshold` column on `projects`) · `backend/src/routes/projects.js` (PATCH `autoApproveThreshold`, registered in `permissions.json`) · `frontend/src/pages/Tests.jsx` (auto-approved filter pill + badge on the test card) · `backend/tests/auto-approval.test.js` (threshold off / threshold on / score-below / score-above / activity-log entry)

**Acceptance criteria:**
- With `autoApproveThreshold: null` (default) every test is still created as a draft — zero behaviour change for existing projects.
- With a threshold set, tests above the score are persisted as `approved` and an activity-log entry is written attributing the approval to the auto-approver pseudo-user.
- The Tests page exposes a "Auto-approved" filter so reviewers can audit the bypass path without trawling activities.

### 4 · AUTO-002 — Change detection / diff-aware crawling
**Effort:** L | **Priority:** 🟢 Differentiator | **Dependencies:** none | **Source:** `ROADMAP.md` Phase 4 (AUTO-002)

Sentri re-crawls the entire site on every run. An autonomous system should detect what changed since the last crawl (new pages, modified DOM, removed elements) and only regenerate tests for affected pages. `backend/src/pipeline/crawlBrowser.js` has no concept of a previous crawl baseline today — this is the difference between "run everything nightly" and "test only what changed," and it's a hard prerequisite for AUTO-004 (test impact analysis from git diff) and the smarter slice of AUTO-001 (risk-based ordering).

After each crawl, store a `crawl_baseline` snapshot per project (page URL → DOM fingerprint hash). On the next crawl, diff against the baseline to identify changed pages. Only run the generation pipeline for changed pages. Emit a `pages_changed` SSE event so the Test Lab live view can show "3 pages changed since last crawl → regenerating only those" instead of a generic progress bar.

**Files:** new `backend/src/pipeline/crawlDiff.js` (DOM fingerprint diff engine — reuse the existing `stateFingerprint.js` hashing, don't invent a new scheme) · `backend/src/pipeline/crawlBrowser.js` (baseline comparison + early-skip for unchanged pages) · `backend/src/database/migrations/` (new `crawl_baselines` table keyed on `(projectId, pageUrl)`) · new `backend/src/database/repositories/crawlBaselineRepo.js` (no raw SQL in the pipeline module per AGENT.md) · `backend/src/routes/runs.js` (expose `changedPages[]` on the run response + SSE event) · `backend/tests/crawl-diff.test.js` (first-crawl baseline creation, unchanged-page skip, changed-page regen, added/removed-page handling, empty-baseline fallback)

**Acceptance criteria:**
- First crawl of a new project behaves identically to today (no baseline to diff against → full crawl + generate).
- Second crawl with no changes emits zero generation calls and completes as `completed_empty` with a `changedPages: []` annotation — no regressed tests, no wasted LLM quota.
- Second crawl with a modified page regenerates tests only for that URL; untouched pages' approved tests survive unchanged.
- Pages removed from the site are surfaced in the run response so reviewers can decide whether to soft-delete their tests.

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| CAP-003 | Secret scanner gate on AI-generated Playwright tests. New `backend/src/pipeline/secretScanner.js` runs a `gitleaks`-style scan inside the validate stage (`backend/src/pipeline/testValidator.js`); built-in detectors (AWS access key IDs, JWTs, `Bearer` tokens) plus best-effort `.github/.gitleaks.toml` reuse. Matched tests are rejected, annotated with a redacted finding list (first/last 4 chars only — never plaintext), and the run is flagged via `run.secretScanBlocked = true` in `pipelineOrchestrator.js` so CI consumers can fail the build on regression. Positive + negative fixtures (AWS keys / JWTs / `Bearer` tokens / clean code) in `backend/tests/secret-scanner.test.js`, registered in `backend/tests/run-tests.js`. | #12 |
| UI-REFACTOR-001 | Extract `ConfigurablePanel` abstraction from `QualityGatesPanel` (AUTO-012) + `WebVitalsBudgetsPanel` (AUTO-017) — ~95% structural overlap eliminated. Shipped alongside an Automation page redesign: four top-level WAI-ARIA tabs (**Triggers & Schedules**, **Quality Gates**, **Integrations**, **Snippets**), per-project accordions inside each tab with live status chips (`N tokens` / `Scheduled`, `Gates configured` / `Budgets set`), and a new `frontend/src/utils/automationStatus.js` parser + cache + invalidation bus pinning the backend response shapes (`data.schedule.enabled`, `data.qualityGates`, `data.webVitalsBudgets`) with regression coverage in `frontend/tests/automation-status.test.js`. The legacy ProjectDetail → Settings tab is removed; Quality Gates / Web Vitals Budgets now live exclusively at `/automation`. Frontend-only — no backend, schema, route, or `permissions.json` changes. | #6 |
| UI-REFACTOR-002 | Dedicated **Test Lab** page (`/test-lab`, `/projects/:id/test-lab`) for AI test generation. Three-pane layout (project sidebar | configuration | launch panel) with three tabs: **Crawl & Generate**, **Generate from Requirement**, and **Queue** (cross-project active + recent runs). SSE-driven 8-stage live pipeline with `sessionStorage`-backed persistence so navigating away and back resumes the live view. Tests page "Crawl" / "Generate" quick-action cards now navigate to Test Lab; the legacy `CrawlProjectModal` / `GenerateTestModal` / `TestDials` / `ExploreModePicker` / `CrawlDialsPanel` components are deleted. Sidebar gets a new **Test Lab** entry (`Atom` icon); `Tests` icon swapped to `SquareCheckBig` across sidebar, Dashboard, Projects, Reports, Runs (`TypeBadge`), and the command palette so the test-suite concept reads consistently. `Runs.jsx` `TypeBadge` + type-filter strip now also handle `type: "record"` (recorder sessions previously rendered as plain text via the fallback). New `frontend/src/components/test/TestConfig.jsx` consolidates the dials surface into a sub-tabbed component (Coverage / Discovery / Quality / Advanced) with profile-switch resets that match the legacy `TestDials.applyProfile` semantics. Scoped stylesheet `frontend/src/styles/pages/test-lab.css`. Pure frontend migration — no backend, schema, route, or `permissions.json` changes. | #5 |

*Full completed list → ROADMAP.md § Completed Work*
