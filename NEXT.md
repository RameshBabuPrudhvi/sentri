# NEXT.md — Current Sprint Target

> **For agents:** Read this file only. Do not read ROADMAP.md unless you need context on items
> beyond the current PR. Everything you need to start work is here.
>
> **For humans:** Update this file when a PR ships. Move the completed item to ROADMAP.md ✅ table,
> promote the next item from the queue below, and rewrite the "Current PR" block.

---

## ▶ Current PR — CAP-003

**Title:** Secret scanner on generated tests
**Branch:** `feat/cap-003-secret-scanner`
**Effort:** S | **Priority:** 🟡 High (security)
**All dependencies:** none (promoted per rotation rule after PR #6 shipped UI-REFACTOR-001)

> UI-REFACTOR-001 (ConfigurablePanel abstraction + Automation page tabs) ✅ shipped in PR #6 — see Recently completed below. Promoting `CAP-003` from queue slot 2 per `NEXT.md` rotation rule.

LLM-generated test code can embed credentials harvested during crawl (`Authorization` headers, API keys, session cookies copied from the live target into the test body). Add a `gitleaks`-style scanner in the pipeline `validate` stage that runs on every generated `playwrightCode` blob: reject the test, surface the matched rule + redacted snippet to the reviewer, and flag the run so callers can fail CI on a regression. Real risk given Sentri's AI-generation positioning — `gitleaks` already gates the repo's own CI (`docs/changelog.md:27`), reuse the same ruleset.

**Files:** new `backend/src/pipeline/secretScanner.js` (rule loader + scan helper) · `backend/src/pipeline/validate.js` (gate generated code through scanner before persistence) · `backend/tests/secret-scanner.test.js` (positive + negative fixtures incl. AWS keys / JWTs / `Bearer` tokens) · register in `backend/tests/run-tests.js`

### PR checklist

- [ ] Update the `CAP-003` entry in `docs/roadmap-gaps-pr8.md` to ✅ once shipped
- [ ] Update this file: move `CAP-003` to "Recently completed", promote the next queue item (slot 2 → Current PR), shift queue items up
- [ ] Add entry to `docs/changelog.md` under `## [Unreleased]`
- [ ] Positive + negative fixtures cover AWS keys, JWTs, `Bearer` tokens, and clean code
- [ ] Reviewer surface confirms matched rule + redacted snippet (no plaintext leaks back into the UI)

---

## ⏭ Queue (next 3 PRs after current)

### 2 · CAP-004 — Self-healing telemetry dashboard
**Effort:** S | **Priority:** 🔵 Medium | **Dependencies:** none | **Source:** `docs/roadmap-gaps-pr8.md` § 5 (CAP-004)

Sentri claims self-healing as a differentiator but surfaces no win-rate metrics. Data already lives in the existing `healingRepo` (per-test strategy histogram from PR #100's `test.healing` telemetry pipeline). Add a `/healing` page rendering: per-strategy success rate, top-healed selectors, and a "tests-that-would-have-failed" savings estimate. Closes the loop on data we already collect.

**Files:** new `frontend/src/pages/HealingDashboard.jsx` · new `backend/src/routes/healing.js` (`GET /api/v1/healing/summary` aggregating from `healingRepo`) · `frontend/src/api.js` (`getHealingSummary()` helper) · sidebar nav entry · `backend/tests/healing-summary.test.js`

### 3 · MET-001 — Shared time-series metrics table + `<TrendChart>` component
**Effort:** M | **Priority:** 🔵 Medium | **Dependencies:** none | **Source:** `docs/roadmap-gaps-pr8.md` § 3 (MET-001)

Web Vitals (AUTO-017), flaky-rate (DIF-004), accessibility violations (AUTO-016), pass-rate, MTTR — every "value over time per project" surface today would otherwise build its own aggregation. Build it once: a generic `metric_samples (projectId, metricKey, ts, value, tags JSON)` table, a `recordMetric()` helper, and a reusable `<TrendChart metricKey=...>` React component with band overlays + threshold lines. Unblocks AUTO-017.3 (Web Vitals trend chart), the DIF-004 flaky-rate dashboard, and any future analytics surface without re-doing schema + UI per feature.

**Files:** new migration `016_metric_samples.sql` · new `backend/src/database/repositories/metricSamplesRepo.js` · new `backend/src/utils/recordMetric.js` (call-site helper) · new `frontend/src/components/shared/TrendChart.jsx` · sample wiring on Dashboard for one existing metric (e.g. pass-rate) to validate end-to-end · `backend/tests/metric-samples.test.js`

### 4 · PROC-002 — Sprint-tracker hand-off automation
**Effort:** S | **Priority:** 🔵 Medium | **Dependencies:** none | **Source:** `docs/roadmap-gaps-pr8.md` § PROC-002

The NEXT.md / ROADMAP.md / `docs/changelog.md` update dance after every shipped PR is currently manual and reviewer-flagged (REVIEW.md § Sprint Tracker Hand-off). Add a `scripts/promote-sprint-item.mjs` Node script that, given a shipped PR number and the new slot-2 item id, performs the full hand-off: rewrites the Current PR block in `NEXT.md`, shifts the queue, prepends the shipped row to the Recently completed table (capped at 3 entries), updates the fast-path `Current sprint` line in `ROADMAP.md`, decrements the remaining-items count, and appends a Completed Work Summary row. Eliminates the reviewer churn we hit on PR #6.

**Files:** new `scripts/promote-sprint-item.mjs` · new `scripts/__fixtures__/promote-sprint-item/` (golden NEXT.md / ROADMAP.md before/after) · new `scripts/promote-sprint-item.test.mjs` · register in `backend/tests/run-tests.js`

> **Stretch / parallel opportunities** (no queue conflict): `AUTO-017.3` (Web Vitals trend chart — depends on MET-001 in slot 3, so it'll unblock as soon as that ships); `PROC-001` (docs-only — require backend PRs to ship UI in the same PR; XS effort). Pick from `docs/roadmap-gaps-pr8.md` if a second engineer has cycles.

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| UI-REFACTOR-001 | Extract `ConfigurablePanel` abstraction from `QualityGatesPanel` (AUTO-012) + `WebVitalsBudgetsPanel` (AUTO-017) — ~95% structural overlap eliminated. Shipped alongside an Automation page redesign: four top-level WAI-ARIA tabs (**Triggers & Schedules**, **Quality Gates**, **Integrations**, **Snippets**), per-project accordions inside each tab with live status chips (`N tokens` / `Scheduled`, `Gates configured` / `Budgets set`), and a new `frontend/src/utils/automationStatus.js` parser + cache + invalidation bus pinning the backend response shapes (`data.schedule.enabled`, `data.qualityGates`, `data.webVitalsBudgets`) with regression coverage in `frontend/tests/automation-status.test.js`. The legacy ProjectDetail → Settings tab is removed; Quality Gates / Web Vitals Budgets now live exclusively at `/automation`. Frontend-only — no backend, schema, route, or `permissions.json` changes. | #6 |
| UI-REFACTOR-002 | Dedicated **Test Lab** page (`/test-lab`, `/projects/:id/test-lab`) for AI test generation. Three-pane layout (project sidebar | configuration | launch panel) with three tabs: **Crawl & Generate**, **Generate from Requirement**, and **Queue** (cross-project active + recent runs). SSE-driven 8-stage live pipeline with `sessionStorage`-backed persistence so navigating away and back resumes the live view. Tests page "Crawl" / "Generate" quick-action cards now navigate to Test Lab; the legacy `CrawlProjectModal` / `GenerateTestModal` / `TestDials` / `ExploreModePicker` / `CrawlDialsPanel` components are deleted. Sidebar gets a new **Test Lab** entry (`Atom` icon); `Tests` icon swapped to `SquareCheckBig` across sidebar, Dashboard, Projects, Reports, Runs (`TypeBadge`), and the command palette so the test-suite concept reads consistently. `Runs.jsx` `TypeBadge` + type-filter strip now also handle `type: "record"` (recorder sessions previously rendered as plain text via the fallback). New `frontend/src/components/test/TestConfig.jsx` consolidates the dials surface into a sub-tabbed component (Coverage / Discovery / Quality / Advanced) with profile-switch resets that match the legacy `TestDials.applyProfile` semantics. Scoped stylesheet `frontend/src/styles/pages/test-lab.css`. Pure frontend migration — no backend, schema, route, or `permissions.json` changes. | #5 |
| DIF-015b Gap 3 + DIF-015c Gap 1 | Combined recorder PR — iframe/shadow-DOM traversal + paste + opt-in keyboard shortcuts. `actionsToPlaywrightCode` emits `base.frameLocator('iframe[src*=<frameUrl>]').first()` for actions with a captured `frameUrl` (replaces the old `ensureFrame(...)` polling helper). Shadow-DOM traversal is covered by Playwright's InjectedScript on the primary `window.__playwrightSelector` delegation path shipped in PR #4 (same algorithm `codegen` uses — walks shadow boundaries via `>> ` piercing selectors). New `paste` listener on `<input>`/`<textarea>` emits a single `safeFill` with the clipboard text (500-char truncated) and cancels any pending input-debounce timer so the fill isn't double-emitted. Opt-in shortcut capture: a `shortcutCaptureBudget` counter gates printable single-char keydowns on editable fields (normally suppressed to avoid double-typing alongside `safeFill`); a new `window.__sentriRecorderSetShortcutBudget(n)` setter clamps to `Math.max(0, floor(n))` and is armed by the frontend's new "Record keyboard shortcut" button in `RecorderModal` via a `shortcutCapture` event on `/record/:sessionId/input` (backend `forwardInput` routes it through `page.evaluate`, default 3 keys). Regression tests in `backend/tests/recorder.test.js` lock down `frameLocator('iframe[src*="checkout-frame"]').first()` output, single-`safeFill` paste emission, `__playwrightSelector` delegation ordering (shadow-DOM coverage contract), `shortcutCaptureBudget` gate+decrement+setter+clamping, and the `forwardInput` shortcutCapture route branch (via fake page + `_testSeedSession`). | #11 |

*Full completed list → ROADMAP.md § Completed Work*
