# NEXT.md — Current Sprint Target

> **For agents:** Read this file only. Do not read ROADMAP.md unless you need context on items
> beyond the current PR. Everything you need to start work is here.
>
> **For humans:** Update this file when a PR ships. Move the completed item to ROADMAP.md ✅ table,
> promote the next item from the queue below, and rewrite the "Current PR" block.

---

## 🚨 10-Day Production Readiness Plan

> **Production target:** ship in 10 days. `INF-006` ✅ shipped in PR #1, clearing the last 🔴 Blocker; `AUTO-012` ✅ (full backend + UI) shipped in PR #2, including per-project `qualityGates` config, run-time evaluation, gate badges, and trigger-response plumbing. Every 🟡 High item in Phase 2 is also already ✅. The plan below is sequenced so the first few days clear Golden E2E and DIF-015b Gap 2, leaving slack for review-thread cleanup and a stabilisation window before tag.

| Day | Focus | Owner |
|---|---|---|
| 1–3 | **DIF-015b Gap 2** — recorder data-testid scoring (Effort: S, contained) | Backend |
| 2–3 | Resolve **all open PR review threads** (start with `permissions.json` line numbers off by 5) | All |
| 3–5 | Run **Golden E2E Happy Path** (`QA.md:240-340`, 51 steps) on Chrome + at least one other browser | QA |
| 5–6 | **Fix any Blocker / Critical bugs** found during the QA pass | All |
| 6–7 | (optional) **AUTO-017** — Web Vitals performance budgets (Effort: M) | Backend |
| 7–8 | (optional) **DIF-005** — Embedded Playwright trace viewer (Effort: M) | Backend |
| 8–10 | Stabilisation window: CI green ≥ 2 days on `main`; cut release tag | All |

**Explicitly deferred (do not ship in this window):** SEC-004 (MFA), SEC-005 (SSO), DIF-005 / DIF-008 / DIF-009 / DIF-010 / DIF-012, all Phase 4 items except the optional AUTO-017. Track post-launch on customer demand.

---

## ▶ Current PR — DIF-015b Gap 2

**Title:** Recorder selectorGenerator: data-testid quality scoring
**Branch:** `feat/DIF-015b-gap2-testid-scoring`
**Effort:** S | **Priority:** 🔵 Medium
**All dependencies:** None

### Why this is the next priority

`AUTO-012` ✅ shipped in PR #2 — full backend (CRUD endpoints, evaluator, repo persistence, migration `014_quality_gates.sql`, trigger-response plumbing, tests), UI (`QualityGatesPanel` under ProjectDetail → Settings, `GateBadge` on Runs list, ProjectDetail → Runs tab, RunDetail header, plus an inline violation panel on RunDetail), **and** the CI-consumer GitHub Actions / GitLab CI snippets in `docs/guide/ci-cd-triggers.md` that read `gateResult.passed` and exit non-zero on violation. No outstanding carry-over. DIF-015b Gap 2 is the highest-value remaining sprint item: small, contained — unblocks DIF-015b flipping to ✅ Complete in ROADMAP.md once Gap 3 also ships.

### What to build

- Detect noise `data-testid` values via heuristic: short prefix (`el_`, `comp-`, `t-`) + hex/numeric tail, all-numeric, or length > 30 with no separators.
- Demote noise testids below role+name in the priority chain inside `selectorGenerator()`; keep them above the bare CSS fallback so they're still preferred over a `.btn-primary` chain.
- Pure DOM logic — no Playwright internals to import.

### Files to change

| File | Change |
|------|--------|
| `backend/src/runner/recorder.js` | Extend `selectorGenerator()` priority chain with testid quality scoring |
| `backend/tests/recorder.test.js` | Fixtures for noise vs. semantic testids |

### Acceptance criteria

- Element with noise `data-testid="el_abc123"` + semantic `aria-label="Save"` + role=button → selector prefers role+name over testid.
- Element with semantic `data-testid="submit-button"` → still prefers testid over role+name (unchanged behaviour).
- Element with only a noise testid + a class chain fallback → still prefers the noise testid over the class chain.
- All existing `recorder.test.js` fixtures pass unchanged.

### PR checklist

- [ ] Update `DIF-015b` status in `ROADMAP.md` once both Gap 2 + Gap 3 ship
- [ ] Update this file: move DIF-015b Gap 2 to "Recently completed", promote AUTO-012b or AUTO-017 to Current PR
- [ ] Add entry to `docs/changelog.md` under `## [Unreleased]`
- [ ] Extend `backend/tests/recorder.test.js` with noise-testid fixtures

---

## ⏭ Queue (next 3 PRs after current)

### 2 · AUTO-017 — Performance budget testing (Web Vitals)
**Effort:** M | **Priority:** 🔵 Medium | **Dependencies:** none

Capture Web Vitals (LCP, CLS, INP, TTFB) per page during runs and compare against per-project budgets. Surface budget violations as a new run-result section and gate runs when budgets are exceeded. First post-launch differentiator candidate.

**Files:** `backend/src/runner/pageCapture.js` · `backend/src/testRunner.js` · `frontend/src/components/run/StepResultsView.jsx`

### 3 · DIF-005 — Embedded Playwright trace viewer
**Effort:** M | **Priority:** 🟢 Differentiator | **Dependencies:** none

Copy the Playwright trace viewer build (`@playwright/test/lib/trace/viewer/`) into `public/trace-viewer/` and serve it at `/trace-viewer/`. The Run Detail page links to `/trace-viewer/?trace=<artifact-signed-url>` to open the trace inline in an iframe — eliminating the local-Playwright-install friction users hit today when debugging a failure. Highest-value remaining DIF item with no dependencies.

**Files:** `backend/src/middleware/appSetup.js` · `frontend/src/pages/RunDetail.jsx` · build tooling (copy trace assets on `npm install`)

### 4 · AUTO-019 — Run diffing: per-test comparison across runs
**Effort:** M | **Priority:** 🔵 Medium | **Dependencies:** none

Compare two runs' per-test results side-by-side and highlight tests that flipped status (passed → failed, failed → passed, newly added, removed). Surface as a "Compare" action on the Run Detail page that opens a diff view against the previous run by default, with a picker to choose any prior run.

**Files:** `backend/src/routes/runs.js` (new `GET /runs/:runId/compare/:otherRunId`) · `frontend/src/pages/RunDetail.jsx` · new `frontend/src/components/run/RunCompareView.jsx`

### 4 · DIF-005 — Embedded Playwright trace viewer
**Effort:** M | **Priority:** 🟢 Differentiator | **Dependencies:** none

Copy the Playwright trace viewer build (`@playwright/test/lib/trace/viewer/`) into `public/trace-viewer/` and serve it at `/trace-viewer/`. The Run Detail page links to `/trace-viewer/?trace=<artifact-signed-url>` to open the trace inline in an iframe — eliminating the local-Playwright-install friction users hit today when debugging a failure. Highest-value remaining DIF item with no dependencies.

**Files:** `backend/src/middleware/appSetup.js` · `frontend/src/pages/RunDetail.jsx` · build tooling (copy trace assets on `npm install`)

---

## 🔀 Parallel opportunities (small items, no queue conflicts)

These can be picked up by a second engineer alongside the current PR without file conflicts:

| ID | Title | Effort | Shared files? |
|----|-------|--------|---------------|
| DIF-015b Gap 3 | Recorder selectorGenerator: iframe + shadow-DOM traversal | M | `backend/src/runner/recorder.js` — conflicts with current PR, pick up after |
| AUTO-019 | Run diffing: per-test comparison across runs | M | None |

> Why these aren't promoted to "Current PR": DIF-015b Gap 2 is the sprint target. AUTO-019 is tracked here so it doesn't get lost — pick it up alongside Gap 2 if a second agent has bandwidth (zero file overlap; Gap 2 only touches `backend/src/runner/recorder.js` + `backend/tests/recorder.test.js`).

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| AUTO-012 | SLA / quality gate enforcement — per-project `qualityGates` config, run-time evaluator, `gateResult` on runs + trigger responses, `QualityGatesPanel` under ProjectDetail → Settings, `<GateBadge>` on Runs list / ProjectDetail Runs tab / RunDetail header, inline violation panel on RunDetail, GH Actions + GitLab CI examples in `docs/guide/ci-cd-triggers.md` that exit non-zero on `gateResult.passed === false` | #2 |
| INF-006 | Persistent storage on hosted deployments (Render disk blueprint + ephemeral-storage warning) | #1 |
| ENH-036 + ENH-036b | Project credential editing (`PATCH /projects/:id`) + auto-detect login form fields (semantic-first locator waterfall) | #1 |

*Full completed list → ROADMAP.md § Completed Work*