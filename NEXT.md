# NEXT.md — Current Sprint Target

> **For agents:** Read this file only. Do not read ROADMAP.md unless you need context on items
> beyond the current PR. Everything you need to start work is here.
>
> **For humans:** Update this file when a PR ships. Move the completed item to ROADMAP.md ✅ table,
> promote the next item from the queue below, and rewrite the "Current PR" block.

---

## ▶ Current PR — UI-REFACTOR-001

**Title:** Extract `ConfigurablePanel` abstraction from `QualityGatesPanel` + `WebVitalsBudgetsPanel`
**Branch:** `feat/configurable-panel-abstraction`
**Effort:** S | **Priority:** 🔵 Medium
**All dependencies:** none (promoted per rotation rule after PR #11 shipped the combined recorder PR)

> Combined recorder PR (`DIF-015b Gap 3` + `DIF-015c Gap 1`) ✅ shipped in PR #11 — see Recently completed below. Promoting `UI-REFACTOR-001` from queue slot 2 per `NEXT.md` rotation rule.

DRY up `QualityGatesPanel` (AUTO-012) + `WebVitalsBudgetsPanel` (AUTO-017) into a shared `ConfigurablePanel` component so the next SLO-style config UIs (SEC-005 SSO config, DIF-008 Jira integration, future SLO panels) can ship as one-file PRs instead of copy-pasting the whole form scaffold. Full spec lives in `docs/roadmap-gaps-pr8.md`.

**Files:** `frontend/src/components/project/ConfigurablePanel.jsx` (new) · `frontend/src/components/project/QualityGatesPanel.jsx` · `frontend/src/components/project/WebVitalsBudgetsPanel.jsx`

### PR checklist

- [ ] Update the `UI-REFACTOR-001` entry in `docs/roadmap-gaps-pr8.md` to ✅ once shipped
- [ ] Update this file: move `UI-REFACTOR-001` to "Recently completed", promote the next queue item (slot 2 → Current PR), shift queue items up
- [ ] Add entry to `docs/changelog.md` under `## [Unreleased]`
- [ ] Verify both existing panels render identically before/after the refactor (visual regression on the `Settings` tab of any project with gates + vitals configured)

---

## ⏭ Queue (next 3 PRs after current)

### 2 · CAP-003 — Secret scanner on generated tests
**Effort:** S | **Priority:** 🟡 High (security) | **Dependencies:** none | **Source:** `docs/roadmap-gaps-pr8.md` § 5 (CAP-003)

LLM-generated test code can embed credentials harvested during crawl (`Authorization` headers, API keys, session cookies copied from the live target into the test body). Add a `gitleaks`-style scanner in the pipeline `validate` stage that runs on every generated `playwrightCode` blob: reject the test, surface the matched rule + redacted snippet to the reviewer, and flag the run so callers can fail CI on a regression. Real risk given Sentri's AI-generation positioning — `gitleaks` already gates the repo's own CI (`docs/changelog.md:27`), reuse the same ruleset.

**Files:** new `backend/src/pipeline/secretScanner.js` (rule loader + scan helper) · `backend/src/pipeline/validate.js` (gate generated code through scanner before persistence) · `backend/tests/secret-scanner.test.js` (positive + negative fixtures incl. AWS keys / JWTs / `Bearer` tokens) · register in `backend/tests/run-tests.js`

### 3 · CAP-004 — Self-healing telemetry dashboard
**Effort:** S | **Priority:** 🔵 Medium | **Dependencies:** none | **Source:** `docs/roadmap-gaps-pr8.md` § 5 (CAP-004)

Sentri claims self-healing as a differentiator but surfaces no win-rate metrics. Data already lives in the existing `healingRepo` (per-test strategy histogram from PR #100's `test.healing` telemetry pipeline). Add a `/healing` page rendering: per-strategy success rate, top-healed selectors, and a "tests-that-would-have-failed" savings estimate. Closes the loop on data we already collect.

**Files:** new `frontend/src/pages/HealingDashboard.jsx` · new `backend/src/routes/healing.js` (`GET /api/v1/healing/summary` aggregating from `healingRepo`) · `frontend/src/api.js` (`getHealingSummary()` helper) · sidebar nav entry · `backend/tests/healing-summary.test.js`

### 4 · MET-001 — Shared time-series metrics table + `<TrendChart>` component
**Effort:** M | **Priority:** 🔵 Medium | **Dependencies:** none | **Source:** `docs/roadmap-gaps-pr8.md` § 3 (MET-001)

Web Vitals (AUTO-017), flaky-rate (DIF-004), accessibility violations (AUTO-016), pass-rate, MTTR — every "value over time per project" surface today would otherwise build its own aggregation. Build it once: a generic `metric_samples (projectId, metricKey, ts, value, tags JSON)` table, a `recordMetric()` helper, and a reusable `<TrendChart metricKey=...>` React component with band overlays + threshold lines. Unblocks AUTO-017.3 (Web Vitals trend chart), the DIF-004 flaky-rate dashboard, and any future analytics surface without re-doing schema + UI per feature.

**Files:** new migration `016_metric_samples.sql` · new `backend/src/database/repositories/metricSamplesRepo.js` · new `backend/src/utils/recordMetric.js` (call-site helper) · new `frontend/src/components/shared/TrendChart.jsx` · sample wiring on Dashboard for one existing metric (e.g. pass-rate) to validate end-to-end · `backend/tests/metric-samples.test.js`

> **Stretch / parallel opportunities** (no queue conflict): `AUTO-017.3` (Web Vitals trend chart — depends on MET-001 in slot 4); `PROC-001` (docs-only — require backend PRs to ship UI in the same PR; XS effort); `PROC-002` (sprint-tracker hand-off automation script in `scripts/promote-sprint-item.mjs`; S effort). Pick from `docs/roadmap-gaps-pr8.md` if a second engineer has cycles.

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| DIF-015b Gap 3 + DIF-015c Gap 1 | Combined recorder PR — iframe/shadow-DOM traversal + paste + opt-in keyboard shortcuts. `actionsToPlaywrightCode` emits `base.frameLocator('iframe[src*=<frameUrl>]').first()` for actions with a captured `frameUrl` (replaces the old `ensureFrame(...)` polling helper). Shadow-DOM traversal is covered by Playwright's InjectedScript on the primary `window.__playwrightSelector` delegation path shipped in PR #4 (same algorithm `codegen` uses — walks shadow boundaries via `>> ` piercing selectors). New `paste` listener on `<input>`/`<textarea>` emits a single `safeFill` with the clipboard text (500-char truncated) and cancels any pending input-debounce timer so the fill isn't double-emitted. Opt-in shortcut capture: a `shortcutCaptureBudget` counter gates printable single-char keydowns on editable fields (normally suppressed to avoid double-typing alongside `safeFill`); a new `window.__sentriRecorderSetShortcutBudget(n)` setter clamps to `Math.max(0, floor(n))` and is armed by the frontend's new "Record keyboard shortcut" button in `RecorderModal` via a `shortcutCapture` event on `/record/:sessionId/input` (backend `forwardInput` routes it through `page.evaluate`, default 3 keys). Regression tests in `backend/tests/recorder.test.js` lock down `frameLocator('iframe[src*="checkout-frame"]').first()` output, single-`safeFill` paste emission, `__playwrightSelector` delegation ordering (shadow-DOM coverage contract), `shortcutCaptureBudget` gate+decrement+setter+clamping, and the `forwardInput` shortcutCapture route branch (via fake page + `_testSeedSession`). | #11 |
| AUTO-019 | Run diffing: per-test comparison across runs — new `GET /api/v1/runs/:runId/compare/:otherRunId` (`backend/src/routes/runs.js`) computes per-test diffs (`flipped`/`added`/`removed`/`unchanged`) under workspace ACL; Run Detail adds a **Compare** action with a prior-run picker that loads `RunCompareView` (`frontend/src/components/run/RunCompareView.jsx`) showing summary chips + per-test status badges. Integration test at `backend/tests/run-compare.test.js` covers happy path, 404, 401 unauth, and cross-workspace ACL. | #10 |
| DIF-005 | Embedded Playwright trace viewer — install-time `postinstall` copier in `backend/scripts/copy-trace-viewer.js` resolves Playwright's prebuilt viewer (`playwright-core/lib/vite/traceViewer/` or `@playwright/test/lib/trace/viewer/`) and copies it to `backend/public/trace-viewer/`; `backend/src/middleware/appSetup.js` mounts it at `/trace-viewer/` with `Service-Worker-Allowed` for `sw.bundle.js` and a 5-minute cache. Run Detail adds a "🔍 Open Trace" action that opens `/trace-viewer/?trace=<signed-url>` in a new tab; the existing Trace ZIP download is preserved as fallback. Smoke test in `backend/tests/trace-viewer-static.test.js` asserts 200 when the bundle is present and 404 when removed. | #9 |
| AUTO-017 | Web Vitals performance budgets — per-project `webVitalsBudgets` config (`{ lcp, cls, inp, ttfb }`), CRUD endpoints under `/api/v1/projects/:id/web-vitals-budgets` (`qa_lead`+ on mutations, registered in `permissions.json`), `captureWebVitals(page)` injects the locally-bundled `web-vitals@4` IIFE (no CDN dependency) and records per-page LCP/CLS/INP/TTFB — runs on the success path independent of the `skipVisualArtifacts` gate so assertion-ending tests still contribute metrics. `evaluateWebVitalsBudgets()` in `testRunner.js` persists `webVitalsResult: { passed, violations }` on the run, surfaced in trigger response + callback payload and as a per-test-filtered violations card on RunDetail. Migration `015_web_vitals_budgets.sql` adds `projects.webVitalsBudgets` + `runs.webVitalsResult`. CI consumer docs in `docs/guide/ci-cd-triggers.md` include updated GH Actions + GitLab snippets and a new "Web Vitals Budgets" section. | #8 |

*Full completed list → ROADMAP.md § Completed Work*
