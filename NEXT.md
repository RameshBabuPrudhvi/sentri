# NEXT.md — Current Sprint Target

> **For agents:** Read this file only. Do not read ROADMAP.md unless you need context on items
> beyond the current PR. Everything you need to start work is here.
>
> **For humans:** Update this file when a PR ships. Move the completed item to ROADMAP.md ✅ table,
> promote the next item from the queue below, and rewrite the "Current PR" block.

---

## 🚨 10-Day Production Readiness Plan

> **Production target:** ship in 10 days. `INF-006` ✅ shipped in PR #1, clearing the last 🔴 Blocker; every 🟡 High item in Phase 2 is also already ✅. The plan below is sequenced so the first few days clear Golden E2E and AUTO-012, leaving slack for review-thread cleanup and a stabilisation window before tag.

| Day | Focus | Owner |
|---|---|---|
| 1–3 | **AUTO-012** — SLA / quality gate enforcement (Effort: M) | Backend |
| 2–3 | Resolve **all open PR review threads** (start with `permissions.json` line numbers off by 5) | All |
| 3–5 | Run **Golden E2E Happy Path** (`QA.md:240-340`, 51 steps) on Chrome + at least one other browser | QA |
| 5–6 | **Fix any Blocker / Critical bugs** found during the QA pass | All |
| 6–7 | (optional) **DIF-015b Gap 2** — recorder data-testid scoring (Effort: S, contained) | Backend |
| 7–8 | (optional) **AUTO-017** — Web Vitals performance budgets (Effort: M) | Backend |
| 8–10 | Stabilisation window: CI green ≥ 2 days on `main`; cut release tag | All |

**Explicitly deferred (do not ship in this window):** SEC-004 (MFA), SEC-005 (SSO), DIF-005 / DIF-008 / DIF-009 / DIF-010 / DIF-012, all Phase 4 items except the optional AUTO-017. Track post-launch on customer demand.

---

## ▶ Current PR — AUTO-012

**Title:** SLA / quality gate enforcement
**Branch:** `feat/AUTO-012-quality-gates`
**Effort:** M | **Priority:** 🟡 High
**All dependencies:** None

### Why this is the next priority

`INF-006` ✅ shipped in PR #1, clearing the last 🔴 Blocker before production. AUTO-012 is the highest-priority 🟡 High item with no dependencies and visible CI/CD value: teams can't enforce "this project must maintain >95% pass rate" today, so a regression on `main` is invisible until a human reads the dashboard. The trigger endpoint already returns pass/fail counts; quality gates turn those counts into a deploy-blocking signal.

### What to build

- Per-project `qualityGates` config: `{ minPassRate, maxFlakyPct, maxFailures }`. CRUD endpoints under `/api/v1/projects/:id/quality-gates`, gated by `requireRole("qa_lead")`.
- On run completion (`testRunner.js`), evaluate gates against the run summary and persist `{ passed: bool, violations: [{ rule, threshold, actual }] }` on the run record.
- Include the gate result in the trigger response (`backend/src/routes/trigger.js`) so the GitHub Action exit code reflects gate status — non-zero on violation.
- Project Detail UI gets a Quality Gates panel for configuration and a per-run gate badge on the Runs list.

### Files to change

| File | Change |
|------|--------|
| `backend/src/database/migrations/` | New `qualityGates` JSON column on `projects`; `gateResult` JSON column on `runs` |
| `backend/src/routes/projects.js` | CRUD endpoints for quality-gate config |
| `backend/src/middleware/permissions.json` | Register new endpoints |
| `backend/src/testRunner.js` | Evaluate gates on run completion |
| `backend/src/routes/trigger.js` | Include `gateResult` in trigger response |
| `frontend/src/pages/ProjectDetail.jsx` | Quality Gates configuration panel |
| `frontend/src/pages/Runs.jsx` · `frontend/src/pages/RunDetail.jsx` | Gate-pass/fail badge |
| `backend/tests/quality-gates.test.js` (new) | Endpoint + evaluator coverage |

### Acceptance criteria

- Configuring `{ minPassRate: 95 }` and finishing a run with 90% pass rate sets `gateResult.passed = false` with a violation entry.
- Trigger response includes `gateResult` and the GitHub Action workflow fails when a gate is violated.
- Viewer role gets `403` on PATCH; QA Lead and Admin succeed.
- Pre-existing runs without a configured gate persist `gateResult: null` (no false failures on legacy data).

### PR checklist

- [ ] Update `AUTO-012` status in `ROADMAP.md` to ✅ Complete with PR number
- [ ] Update this file: move AUTO-012 to "Recently completed", promote DIF-015b Gap 2 to Current PR, pick a new item 4 from ROADMAP.md
- [ ] Add entry to `docs/changelog.md` under `## [Unreleased]`
- [ ] Add `backend/tests/quality-gates.test.js` and register in `backend/tests/run-tests.js`
- [ ] Update `QA.md` with a "Quality Gates" verification step

---

## ⏭ Queue (next 3 PRs after current)

### 2 · DIF-015b Gap 2 — Recorder selectorGenerator: data-testid quality scoring
**Effort:** S | **Priority:** 🔵 Medium | **Dependencies:** none

Score data-testid candidates in the recorder's `selectorGenerator()` priority chain so generic / auto-generated ids (e.g. `data-testid="btn-1"`, hash-suffixed values) are demoted in favour of stable semantic ids. Highest-value next step toward flipping DIF-015b to ✅ Complete in `ROADMAP.md` once Gap 3 also ships. Heuristics + acceptance criteria documented in `ROADMAP.md § DIF-015b`. Small, contained — fits a stabilisation-window slot.

**Files:** `backend/src/runner/recorder.js` (only)

### 3 · AUTO-017 — Performance budget testing (Web Vitals)
**Effort:** M | **Priority:** 🔵 Medium | **Dependencies:** none

Capture Web Vitals (LCP, CLS, INP, TTFB) per page during runs and compare against per-project budgets. Surface budget violations as a new run-result section and gate runs when budgets are exceeded. First post-launch differentiator candidate.

**Files:** `backend/src/runner/pageCapture.js` · `backend/src/testRunner.js` · `frontend/src/components/run/StepResultsView.jsx`

### 4 · DIF-005 — Embedded Playwright trace viewer
**Effort:** M | **Priority:** 🟢 Differentiator | **Dependencies:** none

Copy the Playwright trace viewer build (`@playwright/test/lib/trace/viewer/`) into `public/trace-viewer/` and serve it at `/trace-viewer/`. The Run Detail page links to `/trace-viewer/?trace=<artifact-signed-url>` to open the trace inline in an iframe — eliminating the local-Playwright-install friction users hit today when debugging a failure. Highest-value remaining DIF item with no dependencies.

**Files:** `backend/src/middleware/appSetup.js` · `frontend/src/pages/RunDetail.jsx` · build tooling (copy trace assets on `npm install`)

---

## 🔀 Parallel opportunities (small items, no queue conflicts)

These can be picked up by a second engineer alongside the current PR without file conflicts:

| ID | Title | Effort | Shared files? |
|----|-------|--------|---------------|
| **DIF-015b Gap 2** | **Recorder selectorGenerator: data-testid quality scoring** | **S** | **`backend/src/runner/recorder.js` only — no overlap with AUTO-012 (current PR) / AUTO-017 / DIF-005** |
| DIF-015b Gap 3 | Recorder selectorGenerator: iframe + shadow-DOM traversal | M | `backend/src/runner/recorder.js` only |
| AUTO-019 | Run diffing: per-test comparison across runs | M | None |

> **DIF-015b follow-up priority:** Gap 2 (data-testid scoring) is the highest-value next step — it's a small, contained edit to the priority chain in `selectorGenerator()` and unblocks DIF-015b flipping to ✅ Complete in ROADMAP.md once Gap 3 also ships. Both gaps are documented in `ROADMAP.md` § DIF-015b with concrete heuristics, files-to-change, and acceptance criteria. Pick Gap 2 next; defer Gap 3 to a separate PR (different effort tier).
>
> Why these aren't promoted to "Current PR": AUTO-012 (quality gates) is the sprint target. The recorder gaps are tracked here so they don't get lost — pick them up alongside AUTO-012 if a second agent has bandwidth (zero file overlap; AUTO-012 only touches `projects.js` / `testRunner.js` / `trigger.js` / ProjectDetail UI).

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| INF-006 | Persistent storage on hosted deployments (Render disk blueprint + ephemeral-storage warning) | #1 |
| ENH-036 + ENH-036b | Project credential editing (`PATCH /projects/:id`) + auto-detect login form fields (semantic-first locator waterfall) | #1 |
| AUTO-016b | Frontend CrawlView a11y panel + dashboard offenders rollup | #1 |

*Full completed list → ROADMAP.md § Completed Work*