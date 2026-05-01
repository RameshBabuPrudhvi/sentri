# NEXT.md — Current Sprint Target

> **For agents:** Read this file only. Do not read ROADMAP.md unless you need context on items
> beyond the current PR. Everything you need to start work is here.
>
> **For humans:** Update this file when a PR ships. Move the completed item to ROADMAP.md ✅ table,
> promote the next item from the queue below, and rewrite the "Current PR" block.

---

## 🚨 10-Day Production Readiness Plan

> **Production target:** ship in 10 days. `INF-006` ✅ shipped in PR #1, clearing the last 🔴 Blocker; `AUTO-012` ✅ (full backend + UI) shipped in PR #2; **`DIF-015b Gap 2` ✅ shipped in PR #4** — recorder now delegates to Playwright's own `InjectedScript`-based selector generator with a hand-rolled fallback (including the originally-scoped noise-testid heuristic). Every 🟡 High item in Phase 2 is also already ✅. The plan below is sequenced so the next few days clear Golden E2E and AUTO-017, leaving slack for review-thread cleanup and a stabilisation window before tag.

| Day | Focus | Owner |
|---|---|---|
| 1–3 | ~~DIF-015b Gap 2 — recorder data-testid scoring~~ ✅ shipped (PR #4) | Backend |
| 2–3 | Resolve **all open PR review threads** (start with `permissions.json` line numbers off by 5) | All |
| 3–5 | Run **Golden E2E Happy Path** (`QA.md:240-340`, 51 steps) on Chrome + at least one other browser | QA |
| 5–6 | **Fix any Blocker / Critical bugs** found during the QA pass | All |
| 6–8 | **AUTO-017** — Web Vitals performance budgets (Effort: M) | Backend |
| 7–9 | (optional) **DIF-005** — Embedded Playwright trace viewer (Effort: M) | Backend |
| 8–10 | Stabilisation window: CI green ≥ 2 days on `main`; cut release tag | All |

**Explicitly deferred (do not ship in this window):** SEC-004 (MFA), SEC-005 (SSO), DIF-008 / DIF-009 / DIF-010 / DIF-012, all Phase 4 items except AUTO-017. Track post-launch on customer demand.

---

## ▶ Current PR — AUTO-017

**Title:** Web Vitals performance budgets
**Branch:** `feat/AUTO-017-web-vitals-budgets`
**Effort:** M | **Priority:** 🔵 Medium
**All dependencies:** None

### Why this is the next priority

`DIF-015b Gap 2` ✅ shipped in PR #4 — recorder `selectorGenerator()` now delegates to Playwright's own `InjectedScript`-based selector generator (the same algorithm `codegen` uses), with a hand-rolled fallback chain that retains the originally-scoped noise-testid heuristic for environments where the Playwright bundle can't be loaded. AUTO-017 is the highest-value remaining sprint item per the 10-day plan: it's the first post-launch performance differentiator and has zero dependencies. Pattern-match the AUTO-012 quality-gate work — CRUD endpoint, run-time evaluator, persisted result on the run, surfaced in the trigger response.

### What to build

- Capture Web Vitals (LCP, CLS, INP, TTFB) per page during runs by injecting the `web-vitals` library at `pageCapture` time and reading values back via `page.evaluate`.
- Persist a `webVitals` array on the run-result row (per-step or per-page granularity, whichever matches the existing `pageCapture` shape).
- Add per-project `webVitalsBudgets` config (mirror the shape of `qualityGates` from AUTO-012 — CRUD endpoints under `/api/v1/projects/:id/web-vitals-budgets`, `requireRole("qa_lead")` on mutations).
- Evaluate budgets on run completion alongside `gateResult` and persist `webVitalsResult: { passed, violations }` on the run.
- Surface violations as a new section in `StepResultsView.jsx` and flow them into the trigger-response payload AUTO-012 added.

### Files to change

| File | Change |
|------|--------|
| `backend/src/runner/pageCapture.js` | Inject `web-vitals` library; capture LCP/CLS/INP/TTFB per page |
| `backend/src/testRunner.js` | Evaluate `webVitalsBudgets` on completion; persist `webVitalsResult` |
| `backend/src/routes/projects.js` | CRUD endpoints for `webVitalsBudgets` |
| `backend/src/database/migrations/` | New migration adding `projects.webVitalsBudgets` + `runs.webVitalsResult` |
| `frontend/src/components/run/StepResultsView.jsx` | Render Web Vitals section + budget-violation badges |
| `backend/tests/` | Coverage for the budget evaluator |

### Acceptance criteria

- Each page captured during a run records `{ lcp, cls, inp, ttfb }` (LCP/INP/TTFB in milliseconds, CLS unitless).
- A project with `webVitalsBudgets: { lcp: 2500, cls: 0.1 }` produces `webVitalsResult.passed === false` when any captured page exceeds either threshold.
- The trigger response payload exposes `webVitalsResult` so CI consumers can fail the build on budget violation.
- Pre-AUTO-017 runs persist `webVitalsResult: null` and render unchanged (parity with how AUTO-012 handles `gateResult: null`).

### PR checklist

- [ ] Update `AUTO-017` status in `ROADMAP.md` once shipped
- [ ] Update this file: move AUTO-017 to "Recently completed", promote DIF-005 to Current PR
- [ ] Add entry to `docs/changelog.md` under `## [Unreleased]`
- [ ] Extend `backend/tests/` with budget-evaluator coverage; register any new test files in `backend/tests/run-tests.js`
- [ ] Extend `docs/guide/ci-cd-triggers.md` with a `webVitalsResult.passed` snippet (mirror the AUTO-012 GitHub Actions / GitLab CI examples)

---

## ⏭ Queue (next 3 PRs after current)

### 2 · DIF-005 — Embedded Playwright trace viewer
**Effort:** M | **Priority:** 🟢 Differentiator | **Dependencies:** none

Copy the Playwright trace viewer build (`@playwright/test/lib/trace/viewer/`) into `public/trace-viewer/` and serve it at `/trace-viewer/`. The Run Detail page links to `/trace-viewer/?trace=<artifact-signed-url>` to open the trace inline in an iframe — eliminating the local-Playwright-install friction users hit today when debugging a failure. Highest-value remaining DIF item with no dependencies.

**Files:** `backend/src/middleware/appSetup.js` · `frontend/src/pages/RunDetail.jsx` · build tooling (copy trace assets on `npm install`)

### 3 · AUTO-019 — Run diffing: per-test comparison across runs
**Effort:** M | **Priority:** 🔵 Medium | **Dependencies:** none

Compare two runs' per-test results side-by-side and highlight tests that flipped status (passed → failed, failed → passed, newly added, removed). Surface as a "Compare" action on the Run Detail page that opens a diff view against the previous run by default, with a picker to choose any prior run.

**Files:** `backend/src/routes/runs.js` (new `GET /runs/:runId/compare/:otherRunId`) · `frontend/src/pages/RunDetail.jsx` · new `frontend/src/components/run/RunCompareView.jsx`

### 4 · DIF-015b Gap 3 — Recorder selectorGenerator: iframe + shadow-DOM traversal
**Effort:** M | **Priority:** 🔵 Medium | **Dependencies:** PR #4 must be merged first (shares `backend/src/runner/recorder.js`)

Recorded clicks inside an `<iframe>` produce a selector scoped to the main document, which fails at replay because the element doesn't exist in the top-level DOM. Same for shadow roots. Wire `actionsToPlaywrightCode` to materialise a `frameLocator(frameUrl).locator(sel)` chain when `frameUrl !== mainFrame`, and walk shadow boundaries via `getRootNode()` to build a `host >> shadowRoot >> el` selector chain. Note: most of this may already be handled by Playwright's `InjectedScript` on the primary path shipped in PR #4 — confirm via fixture tests before re-implementing in the fallback.

**Files:** `backend/src/runner/recorder.js` · `backend/tests/recorder.test.js`

---

## 🔀 Parallel opportunities (small items, no queue conflicts)

These can be picked up by a second engineer alongside the current PR without file conflicts:

| ID | Title | Effort | Shared files? |
|----|-------|--------|---------------|
| AUTO-019 | Run diffing: per-test comparison across runs | M | None |
| DIF-005 | Embedded Playwright trace viewer | M | None (only touches `appSetup.js`, `RunDetail.jsx`, build tooling — zero overlap with AUTO-017's `pageCapture.js` / `testRunner.js`) |

> Why these aren't promoted to "Current PR": AUTO-017 is the sprint target. AUTO-019 + DIF-005 are tracked here so they don't get lost — pick either up alongside AUTO-017 if a second agent has bandwidth.

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| DIF-015b Gap 2 | Recorder `selectorGenerator()` delegates to Playwright's own `InjectedScript`-based selector generator (same algorithm `codegen` uses) for ancestor scoring + machine-generated-testid demotion + shadow-DOM traversal + iframe locator chains. Loads `playwright-core/lib/server/injected/injectedScriptSource.js` best-effort at server start; falls back to a hand-rolled `data-testid → role+name → label → placeholder → CSS` chain (with the originally-scoped `el_`/`comp-`/`t-`+hex / all-numeric / long-unseparated noise-testid heuristic) when the bundle can't be resolved or its API surface drifts. New `backend/src/runner/playwrightSelectorGenerator.js` houses the loader + in-page bootstrap. | #4 |
| AUTO-012 | SLA / quality gate enforcement — per-project `qualityGates` config, run-time evaluator, `gateResult` on runs + trigger responses, `QualityGatesPanel` under ProjectDetail → Settings, `<GateBadge>` on Runs list / ProjectDetail Runs tab / RunDetail header, inline violation panel on RunDetail, GH Actions + GitLab CI examples in `docs/guide/ci-cd-triggers.md` that exit non-zero on `gateResult.passed === false` | #2 |
| INF-006 | Persistent storage on hosted deployments (Render disk blueprint + ephemeral-storage warning) | #1 |

*Full completed list → ROADMAP.md § Completed Work*