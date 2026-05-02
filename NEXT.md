# NEXT.md — Current Sprint Target

> **For agents:** Read this file only. Do not read ROADMAP.md unless you need context on items
> beyond the current PR. Everything you need to start work is here.
>
> **For humans:** Update this file when a PR ships. Move the completed item to ROADMAP.md ✅ table,
> promote the next item from the queue below, and rewrite the "Current PR" block.

---

## 🚨 10-Day Production Readiness Plan

> **Production target:** ship in 10 days. `INF-006` ✅ shipped in PR #1, clearing the last 🔴 Blocker; `AUTO-012` ✅ (full backend + UI) shipped in PR #2; `DIF-015b Gap 2` ✅ shipped in PR #4 (Playwright `InjectedScript` delegation with hand-rolled fallback); **`AUTO-017` ✅ shipped in PR #8** (Web Vitals budgets); **`DIF-005` ✅ shipped in PR #9** (embedded trace viewer); **`AUTO-019` ✅ shipped in PR #10** (per-test run diffing). Every 🟡 High item in Phase 2 is also already ✅. Remaining window is Golden E2E + stabilisation; the combined recorder PR (DIF-015b Gap 3 + DIF-015c Gap 1) is now the current sprint target per `## ▶ Current PR` above.

| Day | Focus | Owner |
|---|---|---|
| 1–3 | ~~DIF-015b Gap 2 — recorder data-testid scoring~~ ✅ shipped (PR #4) | Backend |
| 2–3 | Resolve **all open PR review threads** (start with `permissions.json` line numbers off by 5) | All |
| 3–5 | Run **Golden E2E Happy Path** (`QA.md:240-340`, 51 steps) on Chrome + at least one other browser | QA |
| 5–6 | **Fix any Blocker / Critical bugs** found during the QA pass | All |
| 6–8 | ~~AUTO-017 — Web Vitals performance budgets~~ ✅ shipped (PR #8) | Backend |
| 7–9 | ~~DIF-005 — Embedded Playwright trace viewer~~ ✅ shipped (PR #9) | Backend |
| 8–10 | Stabilisation window: CI green ≥ 2 days on `main`; cut release tag | All |

**Explicitly deferred (do not ship in this window):** SEC-004 (MFA), SEC-005 (SSO), DIF-008 / DIF-009 / DIF-010 / DIF-012, all Phase 4 items except AUTO-019 (now in-flight as the current sprint target). Track post-launch on customer demand.

---

## ▶ Current PR — DIF-015b Gap 3 + DIF-015c Gap 1

**Title:** Recorder: iframe/shadow-DOM traversal + paste + opt-in keyboard shortcuts
**Branch:** `feat/recorder-iframe-shadow-paste-shortcuts`
**Effort:** M | **Priority:** 🟡 High
**All dependencies:** PR #4 merged (shared `backend/src/runner/recorder.js`)

> AUTO-019 (per-test run diffing) ✅ shipped in PR #10 — see Recently completed below. Promoting the combined recorder PR from the queue per `NEXT.md` rotation rule.

Bundled into a single PR because both items touch `backend/src/runner/recorder.js` and `backend/tests/recorder.test.js`, and both improve replay fidelity of recorded actions — shipping together avoids a second review cycle on the same file and a merge-conflict window between two back-to-back recorder PRs. See queue entry below (now also at position 1 for historical traceability) for the full A/B/C breakdown.

**Files:** `backend/src/runner/recorder.js` · `frontend/src/components/run/RecorderModal.jsx` · `backend/tests/recorder.test.js`

### PR checklist

- [ ] Update the recorder item status in `ROADMAP.md` (DIF-015b Gap 3 + DIF-015c Gap 1 rows) to ✅ once shipped
- [ ] Update this file: move the recorder PR to "Recently completed", promote `UI-REFACTOR-001` (or the next highest-priority item from `docs/roadmap-gaps-pr8.md`) to Current PR, shift queue items up and add a new item 4
- [ ] Add entry to `docs/changelog.md` under `## [Unreleased]`
- [ ] Fixture coverage: iframe → `frameLocator(...)`, shadow root → `>> shadowRoot >>` chain (or `InjectedScript` already handles), paste → single `fill`, shortcut toggle on → `Ctrl+A` captured; register any new test files in `backend/tests/run-tests.js`

---

## ⏭ Queue (next 3 PRs after current)

### 2 · UI-REFACTOR-001 — Extract `ConfigurablePanel` abstraction
**Effort:** S | **Priority:** 🔵 Medium | **Dependencies:** none (promoted from slot 3 after AUTO-019 shipped)

DRY up `QualityGatesPanel` (AUTO-012) + `WebVitalsBudgetsPanel` (AUTO-017) into a shared `ConfigurablePanel` component so the next SLO-style config UIs (SEC-005 SSO config, DIF-008 Jira integration, future SLO panels) can ship as one-file PRs instead of copy-pasting the whole form scaffold. Full spec lives in `docs/roadmap-gaps-pr8.md`.

**Files:** `frontend/src/components/project/ConfigurablePanel.jsx` (new) · `frontend/src/components/project/QualityGatesPanel.jsx` · `frontend/src/components/project/WebVitalsBudgetsPanel.jsx`

### 3 · TBD — Promote from `docs/roadmap-gaps-pr8.md`
**Effort:** — | **Priority:** — | **Dependencies:** —

Slot freed by AUTO-019 shipping and UI-REFACTOR-001 being promoted to slot 2. Next agent: pick the highest-priority unshipped item from `docs/roadmap-gaps-pr8.md` (AUTO-017.3 trend chart, MET-001 shared time-series infra, PROC-001/002 process automation, CAP-003 secret scanner, etc.) or the next ROADMAP.md item with `Dependencies: none` and no file overlap with slots 1–2.

### 4 · TBD — Promote from `docs/roadmap-gaps-pr8.md`

<!-- Original recorder-combined spec preserved below for historical traceability during this rotation. Remove on the next rotation. -->

### Reference: combined recorder PR spec (now promoted to Current PR)
**Effort:** M | **Priority:** 🟡 High | **Dependencies:** PR #4 merged (shared `backend/src/runner/recorder.js`)

Bundled into a single PR because both items touch `backend/src/runner/recorder.js` and `backend/tests/recorder.test.js`, and both improve replay fidelity of recorded actions — shipping together avoids a second review cycle on the same file and a merge-conflict window between two back-to-back recorder PRs.

**A. Selector traversal across frame/shadow boundaries (was DIF-015b Gap 3)** — Recorded clicks inside an `<iframe>` produce a selector scoped to the main document, which fails at replay because the element doesn't exist in the top-level DOM. Same for shadow roots. Wire `actionsToPlaywrightCode` to materialise a `frameLocator(frameUrl).locator(sel)` chain when `frameUrl !== mainFrame`, and walk shadow boundaries via `getRootNode()` to build a `host >> shadowRoot >> el` chain. Most of this may already be handled by Playwright's `InjectedScript` on the primary path shipped in PR #4 — **confirm via fixture tests first** and only re-implement in the hand-rolled fallback if the primary path misses it.

**B. Paste action (was DIF-015c Gap 1, part 1)** — A pasted token / address / JSON block is currently captured as a sequence of individual keystrokes (fragile, slow at replay). Add a `paste` event listener that records a single `safeFill(sel, '<text>')` action (500-char truncated to match the existing `fill` action).

**C. Opt-in keyboard shortcuts (was DIF-015c Gap 1, part 2)** — Shortcuts like `Ctrl+A` / `Cmd+Enter` are suppressed by the printable-key filter at `backend/src/runner/recorder.js:370-372`. Add a "record this shortcut" toggle in `RecorderModal` that flips the printable-key suppression off for the next N keystrokes, so users can opt-in to capturing a shortcut without permanently polluting the recording with modifier-key noise.

**Files:** `backend/src/runner/recorder.js` · `frontend/src/components/run/RecorderModal.jsx` · `backend/tests/recorder.test.js`

**Fixture coverage required:**
- Click inside iframe → recorded code uses `frameLocator(...)`
- Click inside shadow root → recorded code uses `>> shadowRoot >>` chain (or confirms `InjectedScript` already handles it)
- Paste event → single `fill` action, not keystroke stream
- Shortcut toggle on → `Ctrl+A` captured; toggle off → printable-key filter still suppresses modifiers

### 3 · UI-REFACTOR-001 — Extract `ConfigurablePanel` abstraction
**Effort:** S | **Priority:** 🔵 Medium | **Dependencies:** none (promoted from Parallel opportunities after DIF-005 shipped freed the queue slot)

DRY up `QualityGatesPanel` (AUTO-012) + `WebVitalsBudgetsPanel` (AUTO-017) into a shared `ConfigurablePanel` component so the next SLO-style config UIs (SEC-005 SSO config, DIF-008 Jira integration, future SLO panels) can ship as one-file PRs instead of copy-pasting the whole form scaffold. Full spec lives in `docs/roadmap-gaps-pr8.md`.

**Files:** `frontend/src/components/project/ConfigurablePanel.jsx` (new) · `frontend/src/components/project/QualityGatesPanel.jsx` · `frontend/src/components/project/WebVitalsBudgetsPanel.jsx`

### 4 · TBD — Promote from `docs/roadmap-gaps-pr8.md`
**Effort:** — | **Priority:** — | **Dependencies:** —

Slot freed by combining the two recorder items above into a single PR. Next agent: pick the highest-priority unshipped item from `docs/roadmap-gaps-pr8.md` (AUTO-017.3 trend chart, MET-001 shared time-series infra, PROC-001/002 process automation, CAP-003 secret scanner, etc.) or the next ROADMAP.md item with `Dependencies: none` and no file overlap with slots 2–3.

<!-- Original DIF-005 spec preserved below for historical traceability. Remove on the next rotation. -->

---

## 📦 Previous PR (shipped) — DIF-005

### Why this was the sprint priority

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

## 🔀 Parallel opportunities (small items, no queue conflicts)

These can be picked up by a second engineer alongside AUTO-019 without file conflicts:

| ID | Title | Effort | Shared files? |
|----|-------|--------|---------------|
| DIF-015b Gap 3 + DIF-015c Gap 1 (combined) | Recorder: iframe/shadow-DOM traversal + paste + opt-in keyboard shortcuts | M | None — `recorder.js` + `RecorderModal.jsx`; zero overlap with AUTO-019's `routes/runs.js` + `RunDetail.jsx` + new `RunCompareView.jsx` |

> Why this isn't promoted to "Current PR": AUTO-019 is the sprint target. The combined recorder PR is safe to pick up in parallel because it doesn't touch any file AUTO-019 changes. UI-REFACTOR-001 was promoted into queue slot 3 after DIF-005 shipped and the two recorder gaps were merged into a single queued PR.
>
> **Other follow-up items identified during PR #8 review** (AUTO-017.3 trend chart, MET-001 shared time-series infra, PROC-001/002 process automation, CAP-003 secret scanner, etc.) are tracked in `docs/roadmap-gaps-pr8.md`. Promote any of them here when the current sprint clears.

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| AUTO-019 | Run diffing: per-test comparison across runs — new `GET /api/v1/runs/:runId/compare/:otherRunId` (`backend/src/routes/runs.js`) computes per-test diffs (`flipped`/`added`/`removed`/`unchanged`) under workspace ACL; Run Detail adds a **Compare** action with a prior-run picker that loads `RunCompareView` (`frontend/src/components/run/RunCompareView.jsx`) showing summary chips + per-test status badges. Integration test at `backend/tests/run-compare.test.js` covers happy path, 404, 401 unauth, and cross-workspace ACL. | #10 |
| DIF-005 | Embedded Playwright trace viewer — install-time `postinstall` copier in `backend/scripts/copy-trace-viewer.js` resolves Playwright's prebuilt viewer (`playwright-core/lib/vite/traceViewer/` or `@playwright/test/lib/trace/viewer/`) and copies it to `backend/public/trace-viewer/`; `backend/src/middleware/appSetup.js` mounts it at `/trace-viewer/` with `Service-Worker-Allowed` for `sw.bundle.js` and a 5-minute cache. Run Detail adds a "🔍 Open Trace" action that opens `/trace-viewer/?trace=<signed-url>` in a new tab; the existing Trace ZIP download is preserved as fallback. Smoke test in `backend/tests/trace-viewer-static.test.js` asserts 200 when the bundle is present and 404 when removed. | #9 |
| AUTO-017 | Web Vitals performance budgets — per-project `webVitalsBudgets` config (`{ lcp, cls, inp, ttfb }`), CRUD endpoints under `/api/v1/projects/:id/web-vitals-budgets` (`qa_lead`+ on mutations, registered in `permissions.json`), `captureWebVitals(page)` injects the locally-bundled `web-vitals@4` IIFE (no CDN dependency) and records per-page LCP/CLS/INP/TTFB — runs on the success path independent of the `skipVisualArtifacts` gate so assertion-ending tests still contribute metrics. `evaluateWebVitalsBudgets()` in `testRunner.js` persists `webVitalsResult: { passed, violations }` on the run, surfaced in trigger response + callback payload and as a per-test-filtered violations card on RunDetail. Migration `015_web_vitals_budgets.sql` adds `projects.webVitalsBudgets` + `runs.webVitalsResult`. CI consumer docs in `docs/guide/ci-cd-triggers.md` include updated GH Actions + GitLab snippets and a new "Web Vitals Budgets" section. | #8 |

*Full completed list → ROADMAP.md § Completed Work*