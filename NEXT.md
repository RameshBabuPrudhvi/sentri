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

## ▶ Current PR — DIF-005

**Title:** Embedded Playwright trace viewer
**Branch:** `feat/DIF-005-embedded-trace-viewer`
**Effort:** M | **Priority:** 🟢 Differentiator
**All dependencies:** None

> AUTO-017 (Web Vitals performance budgets) ✅ shipped in PR #8 — see Recently completed below. Promoting DIF-005 from the queue per `NEXT.md` rotation rule.

### Why this is the next priority

`AUTO-017` ✅ shipped in PR #8 — Web Vitals budgets with CRUD endpoints, evaluator, trigger-payload exposure, and per-test-filtered RunDetail panel. DIF-005 is the next item per the 10-day plan: it's the last high-value remaining DIF item, has zero dependencies, and directly removes the single biggest debugging-friction point users hit today (downloading a `.zip` and needing a local Playwright install to open a trace). Playwright already ships a fully self-contained trace viewer build — this PR wires it into Sentri so traces open inline.

### What to build

- Copy Playwright's pre-built trace viewer bundle (`@playwright/test/lib/trace/viewer/` or `playwright-core/lib/vite/traceViewer/`) into `public/trace-viewer/` on `npm install` so the assets ship with the deployed app — no CDN dependency at runtime, same pattern AUTO-017 just established for `web-vitals`.
- Serve the copied viewer as a static directory at `/trace-viewer/` from `backend/src/middleware/appSetup.js`, reusing the existing `express.static` mount scaffolding.
- Add a "🔍 Open Trace" button on `frontend/src/pages/RunDetail.jsx` next to the existing trace-download link. On click, navigate to `/trace-viewer/?trace=<artifact-signed-url>` in a new tab (or embedded `<iframe>` modal — pick whichever matches the sibling "Open Video" affordance).
- The trace-viewer HTML loads `trace=<url>` from its query string and fetches the zip over HTTPS; because `signArtifactUrl()` already emits HMAC-signed short-TTL URLs for `/artifacts/*`, the viewer works without any new auth surface.
- Update CSP `frame-src` / `connect-src` / `worker-src` in `appSetup.js` to allow the self-origin trace viewer to load the trace zip and spawn its worker (check Playwright's trace-viewer docs for the exact directives — it uses a Service Worker to decode the zip).

### Files to change

| File | Change |
|------|--------|
| `backend/src/middleware/appSetup.js` | Serve `public/trace-viewer/` at `/trace-viewer/`; extend CSP to allow the viewer's Service Worker + trace-zip fetch |
| `frontend/src/pages/RunDetail.jsx` | "🔍 Open Trace" button next to existing trace-download link |
| `backend/package.json` or a new `scripts/copy-trace-viewer.js` | `postinstall` hook that copies the Playwright trace viewer bundle into `backend/public/trace-viewer/` so the assets are present in production images |
| `docs/changelog.md` | `### Added` entry under `## [Unreleased]` |

### Acceptance criteria

- Clicking "Open Trace" on any run with a captured trace opens Playwright's trace viewer inline, pre-loaded with that run's trace — no `.zip` download, no local Playwright install.
- The trace viewer works on hosted deployments (Render + GitHub Pages) without requiring an external CDN — all assets served from Sentri's own origin.
- If the Playwright trace viewer bundle can't be resolved at install time (e.g. `playwright-core` bumped to a layout-incompatible version), the `postinstall` step logs a warning and the backend serves a 404 at `/trace-viewer/` — the "Open Trace" button falls back to the existing download link, never crashes the page.
- Signed artifact URLs work as the trace source (no new auth surface).
- CSP remains strict — only the additional directives required by the viewer's Service Worker are opened, scoped to `/trace-viewer/`.

### Watch-outs

- Playwright marks `lib/vite/traceViewer/` as internal (same risk class as DIF-015b Gap 2's `InjectedScript` import). A Playwright bump can move the path. Mitigate with a best-effort resolver in the `postinstall` script and a runtime 404 fallback — same pattern `backend/src/runner/playwrightSelectorGenerator.js` already uses.
- The trace viewer spawns a Service Worker. Make sure `Service-Worker-Allowed` or scope setup is correct, and that the CSP `worker-src` directive includes `'self'` (not `'none'`).
- Trace files can be large (tens of MB). The viewer fetches them; Sentri's signed-URL TTL (`ARTIFACT_TOKEN_TTL_MS`, default 1h) must be long enough for the whole load.
- Test on a deployed environment, not just local — trace viewer behaviour differs under HTTPS + cross-origin artifact URLs (S3 mode) vs local disk.

### PR checklist

- [ ] Update `DIF-005` status in `ROADMAP.md` to ✅ once shipped; decrement the `Remaining:` count in the fast-path section
- [ ] Update this file: move DIF-005 to "Recently completed", promote the next queue item (AUTO-019) to Current PR, shift queue items up
- [ ] Add entry to `docs/changelog.md` under `## [Unreleased]`
- [ ] Extend `backend/tests/` with a smoke test that `/trace-viewer/index.html` serves a non-empty response when the bundle is present and 404s when it's missing; register any new test files in `backend/tests/run-tests.js`
- [ ] Verify on a real deployment (Render or equivalent) that the trace viewer loads a signed-URL trace end-to-end — Service-Worker scope + CSP are easy to get wrong on a dev machine but fail in prod

---

## ⏭ Queue (next 3 PRs after current)

### 2 · AUTO-019 — Run diffing: per-test comparison across runs
**Effort:** M | **Priority:** 🔵 Medium | **Dependencies:** none

Compare two runs' per-test results side-by-side and highlight tests that flipped status (passed → failed, failed → passed, newly added, removed). Surface as a "Compare" action on the Run Detail page that opens a diff view against the previous run by default, with a picker to choose any prior run.

**Files:** `backend/src/routes/runs.js` (new `GET /runs/:runId/compare/:otherRunId`) · `frontend/src/pages/RunDetail.jsx` · new `frontend/src/components/run/RunCompareView.jsx`

### 3 · DIF-015b Gap 3 — Recorder selectorGenerator: iframe + shadow-DOM traversal
**Effort:** M | **Priority:** 🔵 Medium | **Dependencies:** PR #4 must be merged first (shares `backend/src/runner/recorder.js`)

Recorded clicks inside an `<iframe>` produce a selector scoped to the main document, which fails at replay because the element doesn't exist in the top-level DOM. Same for shadow roots. Wire `actionsToPlaywrightCode` to materialise a `frameLocator(frameUrl).locator(sel)` chain when `frameUrl !== mainFrame`, and walk shadow boundaries via `getRootNode()` to build a `host >> shadowRoot >> el` selector chain. Note: most of this may already be handled by Playwright's `InjectedScript` on the primary path shipped in PR #4 — confirm via fixture tests before re-implementing in the fallback.

**Files:** `backend/src/runner/recorder.js` · `backend/tests/recorder.test.js`

### 4 · DIF-015c Gap 1 — Recorder: paste action + opt-in keyboard shortcuts
**Effort:** S | **Priority:** 🟡 High | **Dependencies:** none (scope is additive within `recorder.js`; no overlap with DIF-005 / AUTO-019 file lists)

The recorder's PR #118 expansion added `dblclick`, `contextmenu`, `hover` (600ms dwell), `upload`, and `drag` — but **paste** and **opt-in keyboard shortcuts** are still missing. A pasted token / address / JSON block is captured as a sequence of individual keystrokes (fragile, slow at replay). Keyboard shortcuts like Ctrl+A / Cmd+Enter are suppressed by the printable-key filter at `backend/src/runner/recorder.js:370-372`. Add a `paste` listener → `safeFill(sel, '<text>')` (500-char truncated to match `fill`), and a "record this shortcut" toggle in `RecorderModal` that flips the printable-key suppression off for the next N keystrokes.

**Files:** `backend/src/runner/recorder.js` · `frontend/src/components/run/RecorderModal.jsx` · `backend/tests/recorder.test.js`

---

## 🔀 Parallel opportunities (small items, no queue conflicts)

These can be picked up by a second engineer alongside the current PR without file conflicts:

| ID | Title | Effort | Shared files? |
|----|-------|--------|---------------|
| DIF-015c Gap 1 | Recorder: paste + opt-in keyboard shortcuts | S | None — touches `recorder.js` + `RecorderModal.jsx`; zero overlap with DIF-005's `appSetup.js` + `RunDetail.jsx` |
| DIF-015b Gap 3 | Recorder selectorGenerator: iframe + shadow-DOM traversal | M | None — `recorder.js` only; zero overlap with DIF-005 |
| UI-REFACTOR-001 | Extract `ConfigurablePanel` abstraction (DRY `QualityGatesPanel` + `WebVitalsBudgetsPanel`; unblocks SEC-005 / DIF-008 / SLO config UIs as one-file PRs) | S | None — only `frontend/src/components/project/*Panel.jsx`; zero overlap with DIF-005. Spec in `docs/roadmap-gaps-pr8.md`. |

> Why these aren't promoted to "Current PR": DIF-005 is the sprint target. All three items are safe to pick up in parallel because they don't touch any file DIF-005 changes (`appSetup.js`, `RunDetail.jsx`, `public/trace-viewer/`). AUTO-019 is **not** listed here because it also edits `frontend/src/pages/RunDetail.jsx` — running it in parallel with DIF-005 would cause merge conflicts.
>
> **Other follow-up items identified during PR #8 review** (AUTO-017.3 trend chart, MET-001 shared time-series infra, PROC-001/002 process automation, CAP-003 secret scanner, etc.) are tracked in `docs/roadmap-gaps-pr8.md`. Promote any of them here when the current sprint clears.

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| AUTO-017 | Web Vitals performance budgets — per-project `webVitalsBudgets` config (`{ lcp, cls, inp, ttfb }`), CRUD endpoints under `/api/v1/projects/:id/web-vitals-budgets` (`qa_lead`+ on mutations, registered in `permissions.json`), `captureWebVitals(page)` injects the locally-bundled `web-vitals@4` IIFE (no CDN dependency) and records per-page LCP/CLS/INP/TTFB — runs on the success path independent of the `skipVisualArtifacts` gate so assertion-ending tests still contribute metrics. `evaluateWebVitalsBudgets()` in `testRunner.js` persists `webVitalsResult: { passed, violations }` on the run, surfaced in trigger response + callback payload and as a per-test-filtered violations card on RunDetail. Migration `015_web_vitals_budgets.sql` adds `projects.webVitalsBudgets` + `runs.webVitalsResult`. CI consumer docs in `docs/guide/ci-cd-triggers.md` include updated GH Actions + GitLab snippets and a new "Web Vitals Budgets" section. | #8 |
| DIF-015b Gap 2 | Recorder `selectorGenerator()` delegates to Playwright's own `InjectedScript`-based selector generator (same algorithm `codegen` uses) for ancestor scoring + machine-generated-testid demotion + shadow-DOM traversal + iframe locator chains. Loads `playwright-core/lib/server/injected/injectedScriptSource.js` best-effort at server start; falls back to a hand-rolled `data-testid → role+name → label → placeholder → CSS` chain (with the originally-scoped `el_`/`comp-`/`t-`+hex / all-numeric / long-unseparated noise-testid heuristic) when the bundle can't be resolved or its API surface drifts. New `backend/src/runner/playwrightSelectorGenerator.js` houses the loader + in-page bootstrap. | #4 |
| AUTO-012 | SLA / quality gate enforcement — per-project `qualityGates` config, run-time evaluator, `gateResult` on runs + trigger responses, `QualityGatesPanel` under ProjectDetail → Settings, `<GateBadge>` on Runs list / ProjectDetail Runs tab / RunDetail header, inline violation panel on RunDetail, GH Actions + GitLab CI examples in `docs/guide/ci-cd-triggers.md` that exit non-zero on `gateResult.passed === false` | #2 |

*Full completed list → ROADMAP.md § Completed Work*