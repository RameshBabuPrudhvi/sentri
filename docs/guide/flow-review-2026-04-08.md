# Functional Flow Review (UI + API) — April 8, 2026

This review is focused on **application flows and code quality** (not production scaling concerns).

## Scope & Method

Reviewed source flow across:
- UI routing and guarded navigation
- Project lifecycle (create → crawl/generate → review → run → inspect)
- API orchestration routes for tests/runs/SSE
- Core pipeline quality checks already in repo tests

Also executed existing pipeline tests to validate the current functional quality baseline.

---

## Current Flow Health (Quick Verdict)

- **UI flow completeness:** Good (core user journeys exist and are connected).
- **API flow completeness:** Good (full CRUD + run lifecycle + SSE + review workflow endpoints exist).
- **Code quality against industry standards:** **Partially meets**.
  - Strong modularization in backend pipeline/runner.
  - Gaps in automated flow coverage and some classifier correctness.

---

## What I Tested

### Automated checks executed

1. `node backend/tests/pipeline.test.js`
   - Result: **43 passed, 1 failed**.
   - Failing case: failure classifier returns `URL_MISMATCH` where test expects `ASSERTION_FAIL`.

2. `git diff --check`
   - Result: passed (no diff formatting issues).

---

## Functional Gaps (UI + API)

## 1) Failure classification mismatch in feedback loop

**Evidence**
- Existing automated test suite fails one case in Layer 5 (feedback loop), specifically assertion-failure classification.

**Impact on flow**
- Post-run analytics and auto-improvement prompts can apply the wrong remediation strategy.
- This weakens self-healing/feedback quality for failed tests.

**Improvement**
- Make classifier precedence explicit:
  - Route `toHaveURL` mismatches to `URL_MISMATCH`
  - Route non-URL matcher failures to `ASSERTION_FAIL`
- Add unit tests for ambiguous errors (URL assertion text vs generic matcher text).

## 2) Missing API-level contract/integration tests for user flows

**Evidence**
- Current tests focus pipeline utility layers; there is no route-level integration suite validating full API behavior for:
  - project creation
  - crawl/run start
  - approval gating
  - abort lifecycle

**Impact on flow**
- Regressions in end-to-end API behavior can ship unnoticed despite unit tests passing.

**Improvement**
- Add supertest-based integration tests covering the main API flow:
  - `POST /projects`
  - `POST /projects/:id/crawl`
  - `PATCH /projects/:id/tests/:testId/approve`
  - `POST /projects/:id/run`
  - `POST /runs/:runId/abort`
  - `GET /runs/:runId`

## 3) UI run-state updates mix polling and SSE patterns

**Evidence**
- Project detail page polls every 2s for active run updates.
- Run detail view uses SSE for live events.

**Impact on flow**
- Inconsistent real-time behavior across pages.
- Polling increases request noise and can feel less responsive.

**Improvement**
- Standardize run-status updates via shared SSE hook in both pages.
- Keep polling only as fallback when SSE fails.

## 4) Duplicate action risk in run/crawl initiation UX

**Evidence**
- UI shows action loading states, but there is still potential for repeated start actions across refresh/navigation timing.
- Backend allows multiple runs for same project without explicit run-policy guard.

**Impact on flow**
- Users can unintentionally trigger overlapping runs/crawls and get confusing outcomes.

**Improvement**
- Add a simple functional guard now:
  - If a project has a running crawl/run, return 409 for new run start.
- Surface clear UI message: “A run is already in progress.”

## 5) ProjectDetail page is a high-complexity component

**Evidence**
- `ProjectDetail.jsx` currently handles many concerns at once: fetching, polling, filters, review actions, export, traceability, and toast management.

**Impact on flow**
- Higher regression risk for UI flow changes.
- Harder to test, review, and maintain to industry-quality standards.

**Improvement**
- Split by concern:
  - `useProjectRuns` hook
  - `ReviewTab` component
  - `OverviewTab` component
  - `ExportActions` component
- Add component-level tests for review actions + status filters.

---

## Industry-Standard Alignment Snapshot

### Meets standard
- Clear draft→approve→run workflow gate.
- Abort signaling and run lifecycle states are explicit.
- Structured backend modules with good separation in execution pipeline.

### Below standard (current)
- No route-level integration test suite for critical API flows.
- One known failure in existing quality classifier tests.
- High UI component complexity in core workflow screen.

---

## Recommended Next Steps (Functional-first)

1. **Fix classifier mismatch + add ambiguity tests** (fast win).
2. **Add API integration tests for core lifecycle flow** (highest confidence gain).
3. **Unify UI live run updates to SSE with polling fallback**.
4. **Refactor ProjectDetail into smaller testable modules**.
5. **Add duplicate-run functional guard (409 + UX messaging)**.

---

## Files Reviewed

- `frontend/src/App.jsx`
- `frontend/src/components/ProtectedRoute.jsx`
- `frontend/src/pages/ProjectDetail.jsx`
- `frontend/src/api.js`
- `backend/src/routes/tests.js`
- `backend/src/routes/runs.js`
- `backend/src/routes/sse.js`
- `backend/src/pipeline/feedbackLoop.js`
- `backend/tests/pipeline.test.js`
