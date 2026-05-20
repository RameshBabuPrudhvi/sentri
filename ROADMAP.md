# Sentri — Engineering Roadmap

> **Last revised:** April 2026 · `sentri_v1_4`
> **Stack:** Node.js 20 (ESM) · Express 4 · SQLite → PostgreSQL · Playwright · React 18 · Vite 6
>
> This document is the single source of truth for all planned and in-progress engineering work.
> It is a full rewrite based on a comprehensive codebase audit, resolving numbering gaps, orphaned items,
> duplicate entries, and stale statuses present in prior versions.

---

## ⚡ Agent fast path

> **Working on the next PR? Read [`NEXT.md`](./NEXT.md) instead — it has the current item spec, files to change, and acceptance criteria. You do not need to read further in this file.**
>
> Come back here only to: look up a specific item by ID (Ctrl+F the ID e.g. `DIF-008`), check completed work history, or review phase/competitive context.
>
> **Current sprint:** INF-009 (Helm chart + K8s readiness/liveness + DR playbook) — promoted after AUTO-009 (browser code coverage mapping — all 10 sub-items 009b/c/d/e/f/g/h/i/j shipped) landed in PR #19. Queue: AI-002 + AI-003 (AI provider modularization + adapter capability hardening, bundled — `backend/src/aiProvider.js` 1,545-line decomposition into modules + adapters + per-call cost tracking foundation) slot 1, AI-004 (agent role config schema — dormant) slot 2, AI-005 (multi-agent dispatch — `agentRole` parameter + per-role circuit breakers + per-role telemetry) slot 3, AI-006 (per-role eval harness extension) slot 4, AI-007 (AI cost governance + budget enforcement) slot 5, AUTO-022b (eval harness recording — deferred pending LLM API key + 4–8h maintainer session) slot 6, AUTO-014 (test dependency + execution ordering) slot 7, DIF-008 (Jira / Linear issue sync) slot 8.
>
> **Blockers:** none remaining · **Remaining:** ~19 planned items across Phases 2–5 + Maintenance (incl. AI-002 through AI-007 added as the AI platform foundation track — see Summary table at the bottom for the authoritative breakdown).
>
> **Recent ships** (newest first; full details in the Completed Work Summary table — never inline implementation prose here, that's what the table is for): AUTO-009 PR #19 · MNT-001 + AUTO-022 PR #17 · INF-007 PR #14 · SEC-007 PR #12 · SEC-006 PR #11 · SEC-004 PR #10 · AUTO-008 PR #9 · DIF-015c Gaps 2/3/5/6 PR #8 · AUTO-010 PR #6 · DIF-012 PR #2 · CAP-001 PR #1 · CAP-002 PR #3 · AUTO-004 PR #18 · INT-002b PR #17 · AUTO-001 + INT-002 PR #15 · AI-001 PR #14 · CAP-003 + AUTO-002 + AUTO-002b + AUTO-015 + AUTO-015b PR #12 · DIF-015b Gap 3 + DIF-015c Gap 1 PR #11 · AUTO-003 + AUTO-003b + AUTO-019 PR #10 (legacy) · AUTO-017.3 + PROC-001 + DIF-005 PR #9 (legacy) · CAP-004 + MET-001 + AUTO-017 + UI-REFACTOR-001 PR #8 (legacy). PROC-002 + PROC-003 reverted in PR #10 (legacy).

---

## How to Read This Document

| Symbol | Meaning |
|--------|---------|
| 🔴 Blocker | Must ship before any team or production deployment |
| 🟡 High | Ship within the next two sprints |
| 🔵 Medium | Materially improves quality, DX, or coverage |
| 🟢 Differentiator | Builds competitive moat; schedule freely after blockers |
| ✅ Complete | Merged to `main`; included in summary only |
| 🔄 In Progress | Active branch or current sprint |
| 🔲 Planned | Scoped and ready to start |

**Effort sizing** (2-engineer team): `XS` < 1 day · `S` 1–2 days · `M` 3–5 days · `L` 1–2 weeks · `XL` 2–4 weeks

---

## Completed Work Summary

The following items have been verified complete against the codebase and are **not** repeated below.

> **Naming note:** Items numbered `MAINT-*` are legacy from prior roadmap versions. The current convention is `MNT-*`. Old IDs are preserved in PR descriptions and git history — do not rename them. Use `MNT-*` for all new maintenance items.

| ID | Title | PR / Commit                                                     |
|----|-------|-----------------------------------------------------------------|
| S3-02 | Shadow DOM support in crawler | PR #55                                                          |
| S3-04 | DOM stability wait before snapshot | PR #55                                                          |
| S3-08 | Disposable email address filter | PR #55                                                          |
| ENH-004 | Persist AI provider keys encrypted in database | PR #80                                                          |
| ENH-005 | Global API rate limiting (three-tier) | PR #78                                                          |
| ENH-006 | Test scheduling engine (cron + timezone) | PR #86                                                          |
| ENH-007 | Signed URL tokens for artifact serving | PR #79                                                          |
| ENH-008 | Move `runs.logs` to append-only `run_logs` table | PR #86                                                          |
| ENH-010 | Pagination on all list API endpoints | PR #78                                                          |
| ENH-011 | CI/CD webhook receiver + GitHub Actions integration | PR #86                                                          |
| ENH-013 | Persist password reset tokens in the database | PR #78                                                          |
| ENH-020 | Soft-delete with recycle bin for tests, projects, runs | PR #81                                                          |
| ENH-021 | `userId` + `userName` on activities for full audit trail | PR #78                                                          |
| ENH-024 | Frontend code splitting (React.lazy + Suspense) | PR #78                                                          |
| ENH-027 | Global React Error Boundary with crash reporting | PR #79                                                          |
| ENH-029 | Diff view for AI-regenerated test code | PR #81                                                          |
| ENH-030 | Secrets scanning in CI pipeline (Gitleaks) | PR #79                                                          |
| ENH-034 | Empty crawl result `completed_empty` status | PR #86                                                          |
| ENH-035 | No-provider-configured global banner (ProviderBanner) | PR #85                                                          |
| MAINT-010 | Semantic deduplication via TF-IDF + fuzzy matching | PR #55                                                          |
| MAINT-011 | Feature-sliced frontend component architecture | PR #81                                                          |
| MAINT-012 | Deep test validation (locator, action, assertion) | PR #57                                                          |
| MAINT-013 | Graceful shutdown with in-flight run draining | PR #86                                                          |
| MAINT-016 | Renovate for automated dependency updates | Renovate                                                        |
| SEC-001 | Email verification on registration | PR #87                                                          |
| INF-001 | PostgreSQL support with SQLite fallback | PR #87                                                          |
| INF-002 | Redis for rate limiting, token revocation, and SSE pub/sub | PR #87                                                          |
| INF-003 | BullMQ job queue for durable run execution | PR #92                                                          |
| FEA-001 | Teams / email / webhook failure notifications | PR #92                                                          |
| SEC-002 | Nonce-based Content Security Policy | PR #92                                                          |
| SEC-003 | GDPR / CCPA account data export and deletion | PR #92                                                          |
| INF-005 | API versioning (`/api/v1/`) with 308 redirects | PR #94                                                          |
| FEA-003 | AI provider fallback chain + circuit breaker | PR #94                                                          |
| DIF-003 | Mobile viewport / device emulation | PR #94                                                          |
| DIF-011 | Coverage heatmap on site graph | PR #94                                                          |
| DIF-014 | Cursor overlay on live browser view | PR #94                                                          |
| DIF-016 | Step-level timing and per-step screenshots | PR #94                                                          |
| AUTO-013 | Stale test detection and cleanup | PR #99                                                          |
| MNT-007 | ARIA live regions for real-time updates | PR #99                                                          |
| DIF-004 | Flaky test detection and reporting | PR #99                                                          |
| MNT-009 | Tiered prompt system for local models (Ollama) | PR #100                                                         |
| MNT-010 | Re-run button on Run Detail page for crawl/generate runs | PR #100                                                         |
| FEA-002 | TanStack React Query data layer | PR #107                                                         |
| MNT-011 | Persist crawl/generate dialsConfig on run record | Verified in PR #107 (fix landed in an earlier untracked commit) |
| ACL-001 | Multi-tenancy: workspace ownership on all entities | PR #87                                                          |
| ACL-002 | Role-based access control (Admin / QA Lead / Viewer) | PR #87                                                          |
| INF-004 | OpenAPI specification and Swagger UI | PR #94                                                          |
| DIF-001 | Visual regression testing with baseline diffing | PR #94                                                          |
| DIF-002 | Cross-browser testing (Firefox, WebKit / Safari) | PR #94                                                          |
| DIF-002b | Cross-browser polish: browser-aware baselines, UI badges, CI coverage | PR #107, PR #110                                                |
| DIF-015 | Interactive browser recorder for test creation | PR #94                                                          |
| AUTO-007 | Geolocation / locale / timezone testing | PR #94                                                          |
| DIF-006 | Standalone Playwright export (zero vendor lock-in) | PR #1                                                           |
| AUTO-005 | Automatic test retry with flake isolation | PR #2                                                           |
| DIF-013 | Anonymous usage telemetry (PostHog + opt-out) | PR #3                                                           |
| AUTO-006 | Network condition simulation (slow 3G / offline) | PR #3                                                           |
| DIF-015b | Recorder selector quality: naming alignment, nth=N disambiguation, Playwright `InjectedScript` delegation with hand-rolled fallback, iframe `frameLocator` emission, shadow-DOM via InjectedScript delegation | PR #3, PR #120 (Gaps 1), PR #4 (Gap 2), PR #11 (Gap 3 — `frameLocator('iframe[src*=…]').first()` in `actionsToPlaywrightCode`; shadow-DOM covered by Playwright's InjectedScript on the primary path) |
| DIF-015c (Gap 1) | Recorder: paste action as single `fill` + opt-in keyboard shortcut capture — `paste` listener emits one `safeFill` (500-char truncated), `shortcutCaptureBudget` + `__sentriRecorderSetShortcutBudget` expose an N-keystroke arming window, frontend "Record keyboard shortcut" button in `RecorderModal`, backend accepts `shortcutCapture` in `/record/:sessionId/input` | PR #11 |
| DIF-015c (Gaps 2 + 3 + 5 + 6) | Recorder gaps completion bundle. **Gap 2** — both halves: new `assertCount` / `assertHasClass` action kinds wired through typedef + `actionsToPlaywrightCode` (`toHaveCount(N)` / `toHaveClass(new RegExp('(^\|\\s)<class>(\\s\|$)'))` with word-boundary regex for partial-class matches) + `recordedActionToStepText` + `isEmittableAction` + `addAssertionAction` allowlist with non-negative-integer validation for `assertCount`; **point-and-click hover-pick UX** via new `POST /record/:sessionId/probe` route + `probeAtPoint(sessionId, {x, y})` helper that runs `page.evaluate` against a new `window.__sentriProbeAtPoint` installed by `RECORDER_SCRIPT` (reuses the same `selectorGenerator` + `bestLabel` heuristics the click/fill listeners use so picks match what a real click would record); `LiveBrowserView.assertMode` prop suppresses ALL input forwarding (mouse, wheel, key) and swaps to crosshair cursor with blue highlight overlay scaled against canvas-CSS space + "ASSERT MODE — CLICK TO PICK" badge; `RecorderModal` ships a **🎯 Pick element by clicking** toggle that pre-fills `assertSelector` + `assertLabel` from the latest debounced probe (120ms). **Gap 3** — pause / resume / pop-last: three new `qa_lead`-gated routes flip `session.paused`; pause guarded at **four** call sites (`forwardInput` short-circuits CDP dispatch, `__sentriRecord` exposeBinding callback drops DOM-captured actions, popup `framenavigated` + debounced main-page `framenavigated` skip synthesised `goto` actions); pop-last idempotent on empty `actions[]`. **Gap 5** — device profile at launch AND mid-session: new `device` param on `POST /record` validated against the curated `DEVICE_PRESETS` allowlist exported from `config.js` (same list `RunRegressionModal` mirrors); new `qa_lead`-gated `POST /record/:sessionId/device` route calls a new `switchDevice(sessionId, device)` that tears down the current page+context, rebuilds them under the new descriptor against the **same** browser process, restarts the CDP screencast at the new viewport, navigates to the operator's pre-switch URL — preserving captured `session.actions[]` while resetting page state; `LiveBrowserView` already rescales pointer coordinates against the viewport prop so the post-switch canvas resizes correctly; `screencast.js` now accepts a `viewport` option (defaults to 1280×720 — pre-Gap-5 behaviour bit-for-bit identical) so mobile device profiles stream JPEG frames at native resolution (390×844 for iPhone 14); confirmation modal explains the page-state-reset trade-off before the rebuild fires. **Gap 6** — opt-in stealth profile via a hand-rolled `STEALTH_SCRIPT` constant in `recorder.js` patching the five known fingerprint surfaces (`navigator.webdriver`, `navigator.plugins`, `navigator.languages`, `window.chrome`, `Permissions.prototype.query` for notifications) — **no new top-level dependencies**, no `playwright-extra` / `puppeteer-extra-plugin-stealth` in the dep tree; only the literal JSON `true` opts in (route layer coerces strictly); install order is `stealth → bootstrap → recorder` so SUT bootstrap scripts see the patched `navigator.webdriver` from the very first byte; mid-session device switches re-apply `STEALTH_SCRIPT` after the context rebuild in `_finishOpenRecorderPage`; `RecorderModal` ships a Stealth checkbox in the idle launch form + a green **🥷 Stealth mode active** indicator on the recording sidebar. All 5 new routes (`pause/resume/pop-last/device/probe`) are workspace-scoped via `projectRepo.getByIdInWorkspace` + `sess.projectId !== project.id`, registered in `permissions.json` at `qa_lead`. Frontend ships `api.recordPause/Resume/PopLast/SwitchDevice/Probe` helpers consumed by `RecorderModal.jsx`. Coverage: new `backend/tests/recorder-pause.test.js` (registered in `run-tests.js`) covers all 5 new helpers — guards (unknown session, status `stopping`), idempotency (pop-last on empty actions, switchDevice on active device, resume on never-paused), workspace ACL, `forwardInput` short-circuit while paused, source-level contracts (4 × `session.paused` guards present, `__sentriProbeAtPoint` installed, `STEALTH_SCRIPT` gated by `stealth === true` and registers before `RECORDER_SCRIPT`, `switchDevice` never reassigns `session.actions`). `backend/tests/recorder.test.js` extended with `assertCount` + `assertHasClass` coverage across emission, predicate, step text, and addAssertionAction validation including the canonical-form check that rejects `"1.5"` / `" 1"` / negative / NaN. Tier-3 UI spec in `tests/e2e/specs/recorder-gaps-ui.spec.mjs` covers the device dropdown, pause/undo buttons, pick-by-click toggle, mid-session device confirmation modal, and assertCount/assertHasClass dropdown options via `page.route()` mocks. CSS extracted to `frontend/src/styles/features/recorder.css` (8 new BEM-shaped classes for the assert overlay, action row, device picker, pick toggle, stealth toggle, stealth badge) — only the runtime-computed highlight-rect position stays inline per AGENT.md `:127` data-driven carve-out. `docs/api/tests.md` documents all 5 new routes + the `device` / `stealth` params on `POST /record`; `QA.md § Recorder` adds a 31-step DIF-015c manual test plan covering all four gaps + permissions + cross-workspace ACL + stealth fingerprint-bypass verification. | PR #8 |
| AUTO-016 (backend) | Accessibility testing — axe-core crawl scan + persistence (frontend `CrawlView` panel tracked as AUTO-016b) | PR #121                                                         |
| MNT-006 | Object storage abstraction — local-disk default + S3/R2 pre-signed URLs for screenshots, visual-diff baselines, and diffs (dual-write to local disk in s3 mode) | PR #122                                                         |
| DIF-007 | Conversational test editor connected to /chat (in-app "Edit with AI" panel on TestDetail with diff preview + one-click apply) | PR #123                                                         |
| AUTO-016b | Frontend CrawlView accessibility panel + dashboard "Top Accessibility Offenders" rollup | PR #1                                                           |
| ENH-036 | Project credential editing after creation (`PATCH /api/v1/projects/:id`) | PR #127                                                         |
| ENH-036b | Auto-detect login form fields — semantic-first locator waterfall removes need for hand-authored CSS selectors | PR #127                                                         |
| INF-006 | Persistent storage on hosted deployments (Render disk blueprint + ephemeral-storage warning) | PR #1                                                           |
| AUTO-012 | SLA / quality gate enforcement — per-project `qualityGates` config, run-time evaluator, `gateResult` on runs + trigger responses, `QualityGatesPanel` under ProjectDetail → Settings, per-run `<GateBadge>` on Runs list / RunDetail header, inline violation panel on RunDetail, GH Actions + GitLab CI consumer examples in `docs/guide/ci-cd-triggers.md` that exit non-zero on `gateResult.passed === false` | PR #2                                                           |
| AUTO-017 | Web Vitals performance budgets — per-project `webVitalsBudgets` config (`{ lcp, cls, inp, ttfb }`), CRUD endpoints under `/api/v1/projects/:id/web-vitals-budgets` (`qa_lead`+ on mutations, registered in `permissions.json`), `captureWebVitals(page)` injects the locally-bundled `web-vitals@4` IIFE (no CDN dependency) and records per-page LCP/CLS/INP/TTFB — runs on the success path independent of the `skipVisualArtifacts` gate so assertion-ending tests still contribute metrics. `evaluateWebVitalsBudgets()` in `testRunner.js` persists `webVitalsResult: { passed, violations }` on the run, surfaced in trigger response + callback payload and as a per-test-filtered violations card on RunDetail. Migration `015_web_vitals_budgets.sql` adds `projects.webVitalsBudgets` + `runs.webVitalsResult`. CI consumer docs in `docs/guide/ci-cd-triggers.md` include updated GH Actions + GitLab snippets and a new "Web Vitals Budgets" section. | PR #8                                                           |
| DIF-005 | Embedded Playwright trace viewer — install-time `postinstall` copier in `backend/scripts/copy-trace-viewer.js` resolves Playwright's prebuilt viewer (`playwright-core/lib/vite/traceViewer/` or `@playwright/test/lib/trace/viewer/`) and copies it to `backend/public/trace-viewer/`; `backend/src/middleware/appSetup.js` mounts it at `/trace-viewer/` with a viewer-scoped CSP (`script-src 'unsafe-inline' 'wasm-unsafe-eval'`, `worker-src 'self' blob:`, `connect-src 'self' <s3>`), `Service-Worker-Allowed: /trace-viewer/` on the Playwright service worker (matched by `TRACE_VIEWER_SW_PATTERN` to survive filename renames), and `no-cache` for the SW + 5-minute cache for the rest. Run Detail adds a "🔍 Open Trace" action that opens `/trace-viewer/?trace=<signed-url>` in a new tab; the Trace ZIP download is preserved as fallback. Smoke test in `backend/tests/trace-viewer-static.test.js` asserts 200 when the bundle is present and 404 when removed. `backend/Dockerfile` copies `scripts/` before `npm install` so the postinstall hook resolves. | PR #9                                                           |
| AUTO-019 | Run diffing: per-test comparison across runs — new `GET /api/v1/runs/:runId/compare/:otherRunId` (`backend/src/routes/runs.js`) validates both runs under workspace ACL and returns a summary `{ total, flipped, added, removed, unchanged }` plus per-test diff rows keyed by `testId`. Frontend `api.getRunCompare(runId, otherRunId)` + new `RunCompareView` (`frontend/src/components/run/RunCompareView.jsx`) wired into `RunDetail` via a **Compare** action that loads a prior-run picker over the project's test-run history. Integration test `backend/tests/run-compare.test.js` covers happy path (all four change types), 404 unknown run, 401 unauth, and cross-workspace ACL; registered in `backend/tests/run-tests.js`. | PR #10                                                          |
| UI-REFACTOR-001 | `ConfigurablePanel` abstraction extracted from `QualityGatesPanel` (AUTO-012) + `WebVitalsBudgetsPanel` (AUTO-017) — ~95% structural overlap eliminated; future SLO-style config UIs (SEC-005 SSO config, DIF-008 Jira integration) ship as one-file PRs. Shipped alongside an Automation page redesign: four top-level WAI-ARIA tabs (**Triggers & Schedules** · **Quality Gates** · **Integrations** · **Snippets**) with arrow-key + Home/End navigation, per-project accordions inside each tab with live status chips (`N tokens` / `Scheduled`, `Gates configured` / `Budgets set`), and a new `frontend/src/utils/automationStatus.js` parser + module-level promise cache + pub/sub invalidation bus pinning the backend response shapes (`data.schedule.enabled`, `data.qualityGates`, `data.webVitalsBudgets`) with regression coverage in `frontend/tests/automation-status.test.js`. The legacy ProjectDetail → Settings tab is removed; Quality Gates / Web Vitals Budgets now live exclusively at `/automation`. Frontend-only — no backend, schema, route, or `permissions.json` changes. | PR #6                                                           |
| AUTO-017.3 | Web Vitals trend charts on `ProjectQualityCard` (LCP / CLS / INP / TTFB) backed by per-run averages from `recordMetric()` in `testRunner.js` via new `GET /projects/:id/metrics` route + `useProjectMetricQuery` hook; threshold lines sourced from `project.webVitalsBudgets`. | PR #9 |
| PROC-001 | No-orphan-routes CI guard (`.github/workflows/no-orphan-routes.yml`) — fails PRs adding `router.<method>(…)` in `backend/src/routes/*.js` without touching `frontend/src/api.js` / pages / components; `[no-ui]` PR-title opt-out. Convention documented in REVIEW.md, AGENT.md, CONTRIBUTING.md, and the PR template. | PR #9 |
| ~~PROC-002~~ + ~~PROC-003~~ | **Reverted in PR #10.** Sprint-promotion automation script (`scripts/promote-sprint-item.mjs` + smoke test) and its PROC-003 auto-prune extension. The regex-based transforms had too many edge cases (bundled-id `(bundled)` suffix leakage, queue-slot vs ROADMAP.md scope-text split, drifting title formats) to be reliably automated; the canonical hand-off is now the expanded manual checklist in `REVIEW.md § Sprint Tracker Hand-off`. | PR #8 (added) / PR #10 (reverted) |
| CAP-003 | Secret scanner gate on AI-generated Playwright tests. New `backend/src/pipeline/secretScanner.js` runs a `gitleaks`-style scan inside the validate stage (`backend/src/pipeline/testValidator.js`); built-in detectors (AWS access key IDs, JWTs, `Bearer` tokens) plus best-effort `.github/.gitleaks.toml` reuse. Matched tests are rejected, annotated with a redacted finding list (first/last 4 chars only — never plaintext), and the run is flagged via `run.secretScanBlocked = true` in `pipelineOrchestrator.js` so CI consumers can fail the build on regression. Positive + negative fixtures in `backend/tests/secret-scanner.test.js`, registered in `backend/tests/run-tests.js`. | PR #12                                                          |
| AUTO-003 | Confidence scoring & auto-approval of low-risk tests | PR #10 |
| AUTO-003b | Auto-approval provenance & audit trail (two-tone badges, revoke endpoint, calibration line, sidebar `🤖 N today`, ApprovalsTimeline page) | PR #10 |
| AUTO-002 + AUTO-002b | Change detection / diff-aware crawling. New `crawl_baselines (projectId, pageUrl, fingerprint, capturedAt)` table (migration 019) keyed on `(projectId, pageUrl)`; `crawlBaselineRepo` exposes both `replaceProjectBaselines` (full DELETE + re-INSERT) and `mergeProjectBaselines` (upsert + targeted-delete for partial-crawl safety). New `backend/src/pipeline/crawlDiff.js` reuses `stateFingerprint.js` hashing (no new scheme). Shared `runDiffAwareBaseline(project, run, snapshots, mode)` helper handles **both** link-crawl and state-explorer modes — link-crawl filters `snapshots[]` to changed URLs only, state-explorer (AUTO-002b) uses composite keys (`url#fp=<fingerprint>`) so distinct states at the same URL track as separate rows but generation runs over the full state set (journeys need unchanged-state context). Canonical-URL origin check prevents AUTO-015 preview crawls from corrupting production baselines; zero-snapshot defence + no-change short-circuit both return the run as `completed_empty` with `run.noChangesDetected`. `pages_changed` SSE event wired into Test Lab live view via `useProjectRunMonitor` → `ActiveRunBanner`. Migration `020_run_changed_pages.sql` adds `runs.changedPages` + `runs.removedPages` (JSON TEXT) registered in `runRepo.JSON_FIELDS` + `INSERT_COLS` so both fields surface on `GET /runs/:runId` automatically. Dedicated unit tests: `backend/tests/crawl-diff.test.js` (8 scenarios: added/changed/unchanged/removed/first-crawl/no-change/empty-current/state-mode-composite) + `backend/tests/crawl-baseline-repo.test.js` (both repo write strategies including partial-crawl preservation). | PR #12 |
| INT-002b | GitHub integration polish — installation UX + App-level webhooks. New `backend/src/routes/integrations/github.js` exposes admin-gated `GET /install/start/:projectId` (mints a 10-minute one-shot `state` JWT, returns GitHub App installation URL with `state` + optional `setup_url` override for multi-tenant / preview-env deployments), `GET /install/callback` (verifies state, claims the one-shot nonce, fetches `GET /installation/repositories` via `getInstallationRepos()`, upserts `github_check_settings` with `enabled=1` + `installationId` + first selected `owner/repo`, emits `integration.github.install` activity), and HMAC-only `POST /app-webhook` (reuses `verifyWebhookSignature("github", req.rawBody, sig)` exported from `routes/trigger.js`). `backend/src/integrations/githubChecks.js` extended with `signInstallState(projectId)` / `verifyInstallState(token)` — Redis-backed one-shot nonces with `EX 600` when available, in-memory `Map` fallback that emits a one-shot warn via `formatLogLine` so operators notice multi-replica risk; `getInstallationRepos(installationId)` paginates `GET /installation/repositories?per_page=100` reusing the TTL-cached installation-token + bounded-retry path. `backend/src/database/repositories/githubCheckSettingsRepo.js` gained `getByInstallationId`, `disableByInstallationId` (returns affected `projectIds[]` for activity emission), and `disableByRepo` (narrows to one repo within an installation). App-webhook dispatch: `installation.deleted` flips every matching project's `enabled=0` and emits `integration.github.disabled` activity per project, `installation_repositories.removed` walks `repositories_removed[]` and disables only the matching `(installationId, repo)` tuples, `installation.created` / `suspend` / `unsuspend` log `integration.github.<action>` per affected project and otherwise no-op (admins re-enable explicitly via Settings UI — never silently re-flipped on `unsuspend`). `appSetup.js` `_RAW_BODY_PATH_PATTERN` extended to cover `/integrations/github/app-webhook` so HMAC verification gets the raw bytes. `routes/trigger.js` GitHub path gained an early-ignore guard that ack-200s `{ ignored: true, reason: "github checks disabled" }` when `github_check_settings.enabled=0` — closes the silent-stale-401 loop documented in PR #15's TODO marker. `frontend/src/pages/Settings.jsx` IntegrationsTab gained per-project "Install App" button calling `api.getGithubInstallStartUrl(projectId)` and redirecting to GitHub's App-install URL; post-install callback redirects to `/settings?tab=integrations&github=installed&projectId=…`. The Settings root component now honours the `?tab=<key>` query param via a lazy `useState` initializer that validates the key against `visibleTabs` before falling back to the first visible tab, so the redirect deterministically lands on the Integrations tab where the IntegrationsTab `useEffect` detects `github=installed`, shows the success banner, reloads the row, and strips the query string. Manual `installationId` / `repo` fields preserved as escape hatches for GHES customers, disaster recovery re-binds, and multi-tenant operations (industry pattern from Vercel/Datadog/Linear integrations); the Install App button is the primary path, manual is the override. Both `TODO(INT-002b):` markers removed (verified by grep on head). `backend/src/middleware/permissions.json` registers `GET /api/v1/integrations/github/install/start/:projectId` (admin), `GET /install/callback` (admin), `POST /app-webhook` (`public (GitHub HMAC)` with `noUi: "machine-only App webhook [no-ui]"` opt-out). New `backend/tests/github-install-callback.test.js` (registered in `backend/tests/run-tests.js`) covers state JWT validation (happy path, tamper, expiry, replay — same token rejected on second use), install callback upsert of `github_check_settings` from a stubbed GitHub API, App-webhook `installation.deleted` disabling every matching row + emitting `integration.github.disabled` activity per affected project, `installation_repositories.removed` narrowing correctly without disabling sibling projects on the same installation, and invalid HMAC signature returning 401. `docs/api/projects.md` documents the new install/callback/app-webhook surface, the handled vs log-only event matrix, and a new "Install-state replay protection" subsection explaining the Redis vs in-memory tradeoff for multi-replica deployments. `docs/changelog.md` updated under `## [Unreleased]`. Compliance pre-emption override (landed in this PR, not PR #17): `installationId` is now AES-256-GCM encrypted at rest via new `encryptString` / `decryptString` helpers in `credentialEncryption.js` with a version-prefixed format (`enc:v1:…`) so legacy plaintext rows decrypt transparently — no backfill migration required. The threat-model analysis (encryption is checkbox hardening, not load-bearing security) is preserved verbatim in ROADMAP.md § INT-002b's "Reversal of prior WONTFIX" subsection. Installation-keyed lookups (`getByInstallationId`, `disableByInstallationId`, `disableByRepo`) accept an O(n) load-and-filter cost over project count because AES-GCM ciphertext is non-deterministic; deterministic-HMAC escape hatch documented in the repo module doc if row counts grow past ~10k. The original compliance tripwire (re-open as `INT-002c` if SOC 2 / ISO 27001 / HIPAA lands an encryption acceptance criterion) is now resolved — no INT-002c needed. | #17 |
| INT-002 | GitHub PR check comments. New `backend/src/integrations/githubChecks.js` GitHub App Check Run client minting RS256 JWTs via `crypto.sign("RSA-SHA256")` (no external JWT library) and caching installation tokens with TTL refresh — 60-second skew before expiry means concurrent check-run calls reuse the same token. Bounded retry on 429 / 5xx (3 attempts, exponential backoff capped at 2s, honours `Retry-After` header). Native `queued → in_progress → success / failure / neutral` lifecycle wired into `backend/src/routes/trigger.js`: `prepareGithubCheck()` creates the pending check on enqueue and `concludeGithubCheck()` fires from the `onComplete` hook AFTER `runRepo.save()` (never inside a DB transaction — INT-002 anti-pattern guard). HMAC-SHA256 verified `POST /api/v1/projects/:id/trigger/github` endpoint with event-type + action filtering (`pull_request.{opened,synchronize,reopened,ready_for_review}` + `check_suite.{requested,rerequested}`) — all other events including `ping` ack `200 { ignored: true }` so GitHub stops retrying. Idempotency keyed on `X-GitHub-Delivery` UUID (not commit SHA — distinct deliveries for the same SHA, e.g. `check_suite.rerequested` after a "Re-run" click, deserve a fresh Check Run; same UUID retries reuse the existing `checkRunId`) via cross-dialect `LIKE`-based `runRepo.findByGithubDeliveryId()` lookup with SQL-LIKE wildcard escaping — works on both SQLite and Postgres without the breakage that would have come from `json_extract` (Postgres adapter has no translation rule for it). Summary markdown rendered by new `backend/src/utils/runResultFormatters.js`: regressed-tests only (failing now AND green on base SHA's last run within the 25-run `BASE_LOOKBACK_RUNS` window), explicit "no green base run found" fallback to all-failing when no qualifying green ancestor exists, separate `### Web Vitals budget violations` markdown section so vitals failures don't get lost in the test-failure list. Per-project Settings → Integrations tab (`frontend/src/pages/Settings.jsx` IntegrationsTab) gated on `qa_lead` read / `admin` write via `permissions.json`; new `github_check_settings` table (migration `021_run_github_check.sql`) holds per-project `enabled` + `installationId` + `repo`. New `githubCheck` JSON column on `runs` (same migration) registered in `runRepo.JSON_FIELDS` + `INSERT_COLS`. Lean `runRepo.getRecentTestRunsForGithubBase(projectId, 25)` accessor selects only `id/type/status/failed/githubCheck/results` for the base-run lookup so a project with hundreds of runs doesn't trigger heavy JSON deserialisation on every check completion. GitHub 5xx swallowed + logged (never fails the underlying Sentri run) per the INT-002 anti-pattern guard. `req.rawBody` capture pattern extended to the `/trigger/github` path. New `backend/tests/github-checks.test.js` (9 tests, registered in `run-tests.js`) covers payload shape + installation-token caching, regressed-diff with `baseRun`, fallback to all-failing when no green base, `findGreenBaseRun` bounded lookup + repo+SHA match, Web Vitals violation rendering + `conclusionForRun` = `"failure"`, 5xx exhaustion surfaces to caller (so the integration hook can swallow), transient 5xx recovery on retry, `findByGithubDeliveryId` idempotency (DB integration), `Retry-After` 429 honouring. `docs/api/projects.md` + `docs/changelog.md` + `backend/.env.example` + `docs/guide/env-vars.md` updated. | PR #15 |
| AUTO-001 | Risk-based test selection / ordering. Pure-function scorer `backend/src/pipeline/riskScorer.js` weighting per-test pass rate from `runs.results[]`, `tests.updatedAt` recency boost, self-heal frequency, and AUTO-002's `changedPages[]` (strongest signal — change-affected tests surface to the top). `normalizeBudgetMinutes()` server-side clamp at `MAX_BUDGET_MINUTES=240` so a malformed `budgetMinutes` body param can't exhaust the worker pool. Smoke-test pin via tags `["smoke"]` or `smoke` substring in name — pinned regardless of budget truncation, enforced as a runner-layer invariant in `testRunner.js` and at the BullMQ worker boundary. Dispatch reorder happens at the routes layer (`runs.js` + `trigger.js`) and in `runWorker.js`; **persisted** `testQueue` preserves the original approved-test order with per-row `riskScore`, so the saved run reflects what the reviewer queued (audit fidelity), not how the runner scheduled it. Budget-skipped tests are pre-seeded into `results` as `{ status: "skipped", skipReason: "over_budget" }` markers so every approved test has an observable resolution (AGENT.md issue-handling rule). Trigger-token path (`routes/trigger.js`) byte-aligned with JWT path (`routes/runs.js`): shared `buildTestRun()` shape, activity-log + `trackTelemetry` report dispatched (not approved) counts. `RunDetail.jsx` surfaces a `riskScore` chip per test row + "skipped (over budget)" status badge + "budget: Nm" label on the run header. New `backend/tests/risk-scorer.test.js` (registered in `run-tests.js`) covers flaky-test ranking, recently-edited boost, smoke-test pin, budget truncation with skipped-resolution surfacing, malformed/oversized budget clamp, runner-level smoke-pin invariant, BullMQ worker order-preservation invariant, and `changedPages` weighting. New `docs/AUDIT_IMPL.md` lands as the implementation companion to `AUDIT.md` (informational; no runtime effect). | PR #15 |
| AUTO-004 | Test impact analysis from git diff / deployment webhook. New `backend/src/pipeline/impactAnalysis.js` exports `computeImpactedTests({ tests, changedFiles, changedPages, routeMap })` and `routePrefixesForChangedFiles()` — pure helpers that derive URL route prefixes from file paths via a heuristic (`src/app/pages/routes` anchor + kebab-case tokenisation + dynamic-segment `[id]` / route-group `(auth)` filtering + non-route-folder exclusion for `docs`, `migrations`, `config`, `tests`, `components`, etc.) and an optional `routeMap` override for monorepos and shared component folders. `backend/src/integrations/githubChecks.js` gains `getChangedFilesForPr({ repo, prNumber, installationId })` paginating the PR files API (`GET /repos/{owner}/{name}/pulls/{n}/files?per_page=100`, max 10 pages) reusing the existing TTL-cached installation-token + bounded-retry path. `backend/src/routes/trigger.js` resolves `changedFiles` via a new `resolveChangedFiles()` helper (body override first, then GitHub fetch when the project has a GitHub App `installationId` configured), runs `computeImpactedTests(...)`, filters the dispatched queue to impacted tests only (`impactScopedTests = tests.filter(t => impactedIdSet.has(t.id))`), and pre-seeds non-impacted approved tests into `results` as `{ status: "skipped", skipReason: "skipped_no_impact" }` markers so every approved test still has an observable resolution on the run (AGENT.md issue-handling rule — never silently dropped). `backend/src/pipeline/riskScorer.js` accepts `changedFiles[]` + `routeMap` and adds a `+10` file-affinity boost that composes with AUTO-002's `+15` `changedPages[]` boost (file-affected AND DOM-changed tests get the strongest combined signal at the top of the risk-ordered queue). **Spec extension (deliberate):** migration `022_run_changed_files.sql` adds **two** columns rather than the single `changedFiles` listed in `NEXT.md` — `runs.impactAnalysis` (JSON TEXT) persists the resolved `{ impactedTestIds, fallbackReason, routePrefixes }` summary alongside `runs.changedFiles`, which is what `frontend/src/pages/RunDetail.jsx`'s new Impact scope panel renders: impacted-vs-approved badge, fallback reason chip (`no_changed_files` / `no_impact` / `github_fetch_failed` / `crawl_run`), up to 12 changed-file `<code>` pills + "+N more" overflow. Pass-rate denominator in RunDetail now excludes `skipped_no_impact` (same treatment as `over_budget` — `passRateDenominator = total - skippedOverBudget - skippedNoImpact`). **Adjacent change landed in this PR:** `scoreTestRisk()`'s history filter at `backend/src/pipeline/riskScorer.js:57-59` was broadened from excluding only `r.skipReason === "over_budget"` skips to excluding **all** `r.status === "skipped"` rows, so the new `skipped_no_impact` skip kind receives the same "not an execution outcome" treatment as budget skips — a previously skipped test no longer gets a near-maximum risk score on the next run regardless of skip reason. GitHub PR-files fetch failures swallow + log via `formatLogLine("warn", runId, ...)` and fall back to the full suite (`fallbackReason: "github_fetch_failed"`), mirroring the INT-002 swallow-and-log contract — never blocks the run. New unit test `backend/tests/impact-analysis.test.js` (registered in `backend/tests/run-tests.js`) covers seven scenarios: file→URL routing, empty-diff full-suite fallback, unknown-paths → `skipped_no_impact`, merge with `changedPages[]`, route-map override, GitHub fetch-failure → full-suite fallback, and file-affinity risk-boost composition with `changedPages[]`. `docs/api/projects.md` documents the new request shape (`changedFiles`, `routeMap`) plus auto-fetch behaviour when GitHub App `installationId` is configured; `docs/changelog.md` updated under `## [Unreleased]`. | PR #18 |
| CAP-001 | Data-driven test fixtures. New `test_fixtures(testId, version, format, rows, createdAt)` table keyed on `(testId, version)` (migration `023_test_fixtures.sql`); `format` constrained to `'csv' \| 'json'` via single-quoted CHECK literal so the migration parses on both SQLite and Postgres (INF-008-friendly). Per-project iteration cap added as `projects.iterationCap INTEGER` in the same migration (default 10, hard server ceiling 100 — `clampIterationCap` enforces `[1, 100]` regardless of source so a malformed write can't exhaust the worker pool). New `backend/src/database/repositories/testFixtureRepo.js` exposes `upsertFixture` / `getFixture` / `listFixtures` (round-trips JSON `rows`). New routes `POST /api/v1/tests/:testId/fixtures` (qa_lead+, format allowlist matched to the migration CHECK) + `GET …/fixtures` (anyAuthenticatedMember, newest version first) registered in `backend/src/middleware/permissions.json`. Single-field PATCH bypass on `/api/v1/projects/:id` for `iterationCap` mirrors the existing `autoApproveThreshold` shape (body must contain exactly `iterationCap` to skip name/url validation, range-validated server-side). Runner integration: `executeTestIterations` in `backend/src/runner/executeTest.js` runs `runSingle(iterTest)` once per row substituting `{{column}}` placeholders in `playwrightCode` (zero-regression for fixture-less tests — falls through to single iteration when `fixtureRows` is empty/missing); `testRunner.js` resolves fixtures keyed to the test's current `codeVersion` (so an AI fix that bumps `codeVersion` invalidates stale fixtures cleanly) and surfaces every iteration to the run aggregator **exactly once after retries resolve** — fixing a double-count bug where calling `processResult` inside the retry callback would corrupt `run.passed`/`run.failed`, push `run.results.length` past `run.total`, and break quality-gate evaluation. Data-driven tests intentionally don't retry (would re-execute every row on every retry, multiplying browser work) — a visible `logWarn` `↻ Skipping retry for <test>` line keeps the suppression explicit in the run timeline. CSV parser is RFC 4180-aware (quoted fields with embedded commas, CRLF line endings, `""`-escaped quotes; trailing blanks dropped). Frontend ships `api.uploadTestFixture` + `api.getTestFixtures`; new `frontend/src/components/test/TestFixturePanel.jsx` mounted on `TestDetail.jsx` (CSV / JSON textarea, optional iteration-cap override, history table with active-version badge, `window.confirm` prompt before overwriting an existing fixture at the same `codeVersion` since `upsertFixture` is a replace). `IterationCapPanel` lives under the new **Iterations** inner tab on `ProjectQualityCard` (Automation → Quality Gates). `StepResultsView.jsx` renders an `iteration #N` badge with the substituted row JSON as the tooltip — failures attributable to a specific row without digging into raw result JSON. Tests: `backend/tests/fixture-iteration.test.js` (registered in `run-tests.js`) covers the 5-row → 5-results acceptance criterion, fixture-less zero-regression path, failed-iteration row attribution (no short-circuit), cap clamp boundary cases (0 / negative / fractional / 10k), and CSV-parser quoting edge cases; `backend/tests/test-fixtures-routes.test.js` provides HTTP integration coverage (format allowlist 400, empty-rows 400, cap override + truncation reporting, version mirroring of `test.codeVersion`, 404 on unknown testId, cross-workspace ACL); `tests/e2e/specs/test-fixtures-ui.spec.mjs` covers the UI (CSV upload round-trip + active-version badge, RunDetail iteration badges via `page.route()` Tier-3 mock, Iterations panel save round-trip). Docs: `docs/api/projects.md` documents the fixture endpoints; `docs/changelog.md` updated under `## [Unreleased]`; `QA.md` gained a new "Data-driven test fixtures (CAP-001)" section + intent-map / section-index entries; `tests/e2e/COVERAGE.md` flipped the CAP-001 row to ✅. | PR #1 |
| CAP-002 | Distributed test sharding across runners. End-to-end cross-process sharding for `POST /api/v1/projects/:id/run` and `POST /api/v1/projects/:id/trigger`. `shards: N > 1` fans the run out across N BullMQ shard workers (one BullMQ job per shard, sharing a parent `runId` via the `${runId}:s${shardIndex}` jobId convention); each shard executes a contiguous slice of the dispatched test queue using the Playwright `--shard=N/M` algorithm. The boundary-crossing shard (whose `incrementShardsCompleted` UPDATE crosses the `shardCount` cap — atomic, row-locked, exactly-once by SQL predicate) is the single finalizer per run. **Phase 1**: migrations 025 + 026, `partitionTestsIntoShards` + `partitionTestIdsForShards`, `Shards M/N` badge, per-shard trace dropdown. **Phase 2 storage primitives**: 6 new atomic repo helpers in `runRepo.js` — `appendRunResults` (cross-dialect JSON splice via `substr` + `\|\|`), `incrementShardsCompleted` (capped UPDATE with predicate), `incrementRunStats`, `setShardTracePath` (transaction-wrapped with dialect-conditional `FOR UPDATE`), `purgeShardResults` (atomic retry purge replacing the lost-write `save(run)` pattern), `markRunFailedFirstWriterWins` + `markRunCompletedFirstWriterWins` (first-writer-wins predicate `WHERE status = 'running'` for crash + late-abort race safety). **Phase 2 worker**: new `test_run_shard` branch in `runWorker.js`, parent/shard registry helpers (`workerAbortKey`, `forEachShardEntry`, `abortAllShardsForRun`), inline `finalizeShardedRun` runs feedback loop + status transition + done SSE + activity log + telemetry + notifications + GitHub Check completion + CI/CD `callbackUrl` exactly once. **Phase 2 abort propagation**: new `backend/src/utils/runAbortChannel.js` module encapsulates `sentri:run-abort` Redis pub/sub with per-process `RUN_ABORT_ORIGIN` self-echo suppression and a `_messageHandlerRegistered` flag preventing duplicate listeners on SUBSCRIBE retry. **Zero-regression**: single-shard runs + no-Redis fallback keep using `runRepo.save(run)` + `runWithAbort` bit-for-bit. **Coverage**: 7 dedicated backend test files (registered in `run-tests.js`) — `run-sharding` (partition algorithm + route clamp + BUG-0001 decoupling + slice contract), `run-storage-concurrency` (8× concurrent `appendRunResults` no-lost-writes), `run-shard-finalizer` (exactly-one-finalizer race + 10-way interleave), `run-shard-crash` (first-writer-wins + late-abort race), `run-shard-registry` (parent/shard registry + sibling-run isolation), `run-worker-shard-retry` (shard-scoped retry + legacy wipe-all bit-for-bit), `run-abort-pubsub` (cross-replica delivery + self-echo + malformed payload safety, gated on `REDIS_URL`). UI coverage in `tests/e2e/specs/run-sharding-ui.spec.mjs`. **Deferred to CAP-002b**: 10 SaaS-readiness follow-ups (wall-clock Tier-1 E2E harness, BullMQ-kill chaos test, route-mock coordinator test, auto-scaling, DLQ + replay UI, per-tenant fair scheduling, duration-aware balancing, cross-region, container isolation, Redis HA enforcement). `docs/api/projects.md` § Run sharding documents request shape + per-shard trace layout + abort behaviour + finalization handoff + CI/CD callback semantics; `docs/changelog.md` updated under `## [Unreleased]`; `QA.md` § Distributed Sharding (CAP-002) added with 24-step manual test plan. | PR #3 |
| DIF-012 | Multi-environment support (staging vs. production). New `environments` table per project (migration `024_environments.sql`) keyed on `(projectId, name)` with `baseUrl` + AES-encrypted `credentials` JSON; `runs.environmentId` audit column added (additive migration, no FK on the run column so historical runs survive env deletion). New `backend/src/database/repositories/environmentRepo.js` with `create / listByProject / listByProjectIds / getById / update / remove` — `credentials` JSON-round-tripped through `JSON.stringify` / `JSON.parse` mirroring `projectRepo` so better-sqlite3 doesn't reject the bound object; `listByProjectIds` added for the dashboard's batched aggregation (mirrors the pattern in `githubCheckSettingsRepo.listByProjectIds`). Project-scoped CRUD endpoints `GET / POST / PATCH / DELETE /api/v1/projects/:id/environments[/:environmentId]` registered in `backend/src/middleware/permissions.json` (`admin` on mutations, `qa_lead` on read); `baseUrl` SSRF-validated on both POST and PATCH via the existing `utils/ssrfGuard.js` two-layer guard (string checks + DNS resolution + private-IP rejection — same guard used for `previewUrl` on the webhook path and notification webhooks). **Every** project-scoped execution path — `POST /run` (regression), `POST /crawl` (link + state-explorer crawl + AI generation), `POST /tests/generate` (AI generation from description), `POST /record` (interactive recorder session), the CI/webhook `POST /trigger` path, the Vercel/Netlify deployment-webhook crawl path (`launchPreviewCrawl`), and the BullMQ worker (`runWorker.processJob`) — accepts an optional `environmentId` that overrides BOTH `project.url` AND `project.credentials` **for that run only**. The project row is never mutated. The override flows through a **single shared helper** `backend/src/utils/envScope.js` `envScopedProject(project, environment, { previewUrl })` — replaces four copy-pasted local helpers (`envScopedProject` in `routes/runs.js` / `routes/tests.js` / `workers/runWorker.js`, plus `buildEnvScopedProject` with `previewUrl` in `routes/trigger.js`) that drifted during DIF-012 development. Helper contract: (1) `environment === null` && `previewUrl === null` returns `project` unchanged (zero-regression); (2) `previewUrl` wins over `environment.baseUrl` so deploy-preview webhooks behave the same as before DIF-012; (3) `environment.credentials` lands at the helper already AES-encrypted (the env repo only `JSON.parse`s on read, no decryption — see `rowToEnv`) so it's assigned verbatim — re-encrypting would double-encrypt and silently break login, and the downstream `decryptCredentials()` calls in `crawlBrowser.js:103` and `stateExplorer.js:325` peel exactly one layer; (4) envs without their own credentials transparently inherit the project's auth; (5) `canonicalUrl` is stamped so the AUTO-015 baseline guard in `crawler.js` treats env-scoped crawls as preview-style and doesn't overwrite production fingerprints. Run-scope validation: cross-project / unknown `environmentId` → `400 invalid environmentId`, gated **BEFORE** the no-approved-tests check on `/run` so a bogus envId fails fast with the correct error message (matches the ordering used on `/crawl`, `/generate`, `/record`, and the trigger path; QA.md § Environments documents this contract). BullMQ worker reads `run.environmentId` from the persisted run record at pickup time and applies the same scoped-project override before passing to `crawlAndGenerateTests` / `runTests`, so queued runs honour the env override identically to in-process runs; a row deleted between enqueue and pickup yields `environment === undefined` which the helper treats as "no override" (run falls back to `project.url`, matching pre-DIF-012 behaviour). API responses strip plaintext passwords via new `sanitiseEnvCredentialsForClient` in `backend/src/utils/projectSanitiser.js` — even POST/PATCH responses echo only `{ username, _hasAuth: true }`, never the password (REVIEW.md "no plaintext passwords in API responses" — any echo is a logging / proxy / replay leak surface). PATCH credentials handling has three cases: (a) key absent → don't touch stored value, (b) `credentials: null` → explicit clear, (c) object payload → blank-password merge falls back to existing stored value so editing name/baseUrl alone never wipes the secret (required because the frontend no longer echoes the password — without the merge, a rename would re-encrypt empty and corrupt the row). Frontend ships `api.getProjectEnvironments` / `createProjectEnvironment` / `updateProjectEnvironment` / `deleteProjectEnvironment`, a new `EnvironmentsTab` panel on `ProjectDetail.jsx` (CRUD form + table, role-gated via `canEdit={userHasRole(authUser, "admin")}` — qa_lead viewers see the table without mutation buttons; `startEdit` pre-fills username but leaves password blank by design, scoped `.pd-env-*` styles in `frontend/src/styles/pages/project-detail.css`), environment dropdowns on `RunRegressionModal.jsx` / `RecorderModal.jsx` / `TestLab.jsx` (only render when project has ≥1 env; selection resets cleanly on project change so a stale envId never leaks into the next run payload; viewer-role 403s on env-list are swallowed so the modal still works for users below qa_lead; recorder auto-fills Starting URL with `environment.baseUrl` when selected; TestLab forwards page-level env selection to RecorderModal via `defaultEnvironmentId` prop), and a new "Environments" panel on `Dashboard.jsx` showing per-environment pass rate, run counts, color-coded thresholds (green ≥80%, amber 50-79%, red <50%), and clickable last-green-run links (scoped `.dash-env-*` styles in `frontend/src/styles/pages/dashboard.css`; only renders when workspace has ≥1 env so env-less workspaces see no payload change). Dashboard backend gains an `environmentPassRates` aggregation in `backend/src/routes/dashboard.js` that buckets completed test runs by `(projectId, environmentId)` over a **90-day window** (`ENV_AGGREGATION_WINDOW_DAYS` constant, surfaced as `windowDays` on each row so the UI can label the time range; a time window matches user intuition better than a run-count window for sparse per-env buckets), with a synthetic `default` bucket per project carrying the project's own URL so the UI can still render env-less projects alongside multi-env ones. Batched via `environmentRepo.listByProjectIds()` in a single SQL round-trip (replaces the prior per-project N+1 `listByProject` loop). Payload is `null` when no envs exist. Runs targeting now-deleted envs are silently skipped from the aggregation (no orphan rows). RunRegressionModal `style={{...}}` inline-style cleanup landed alongside this PR — extracted to shared `.modal-form-*` CSS classes in `components.css` so future modal forms reuse the primitives. Inline-style refactor on `StepResultsView.jsx` mentioned in the PR but tracked separately. Backend integration coverage in `backend/tests/environments.test.js` (registered in `backend/tests/run-tests.js`) covers CRUD round-trip, AES round-trip of `credentials` (parses JSON-stringified column before `decryptCredentials`), PATCH-without-credentials preserves stored secret, blank-password merge with stored value, explicit `credentials: null` clears it, cross-workspace ACL on read and PATCH (returns 404 not 403 to avoid leaking existence), cross-project envId rejection on `/run` / `/generate` / `/record`, invalid envId rejection asserted with strict `invalid environmentId` regex (validation ordering fixed to run BEFORE no-tests check on `/run`), zero-regression no-envId path, project.url invariant across every mutation. Test fixtures use IANA-reserved demo domains (`example.com` / `www.example.com` / `example.org`) that resolve in public DNS so the new SSRF guard on `baseUrl` doesn't reject the test scaffolding. E2E coverage in `tests/e2e/specs/environments-ui.spec.mjs` (Tier-2, `RUN_UI_E2E=true`) covers the Environments tab CRUD round-trip + reload persistence and the RunRegressionModal dropdown via `page.route()` mock injection of a synthetic environments list. Satisfies the PROC-001 no-orphan-routes invariant: every new backend route has a real frontend consumer in this PR (`EnvironmentsTab`, `RunRegressionModal`, `RecorderModal`, `TestLab`). `docs/api/projects.md` § Environment management documents the endpoint surface, run-payload shape, run-scoped credential override, and when to use environments vs. separate projects; `QA.md` § Environments (DIF-012) added with full manual test plan covering EnvironmentsTab CRUD, TestLab + RecorderModal dropdowns, RunRegressionModal selector with stale-envId reset, Dashboard "Environments" panel, API happy-path, and negative/edge cases (viewer 403, admin-only mutations, cross-project envId rejection, baseUrl SSRF rejection on RFC1918/localhost). `docs/changelog.md` updated under `### Added`. **Intentional design choices documented in PR description:** dashboard aggregation is windowed (90 days) not all-time; env credentials are NOT auto-applied inside the interactive recorder (operator-driven; auto-login is for crawl/generate/run paths only); recorder `startUrl` fallback chain is `req.body.startUrl → environment.baseUrl → project.url`. | PR #2 |
| AUTO-015 + AUTO-015b | Continuous test discovery on deployment events. `POST /api/v1/projects/:id/trigger` accepts `triggerCrawl: true` + optional `previewUrl` (SSRF-guarded). Vercel webhook verifies `X-Vercel-Signature` (HMAC-SHA1, `VERCEL_WEBHOOK_SECRET`); Netlify webhook verifies `X-Netlify-Token` (HMAC-SHA256, `NETLIFY_WEBHOOK_SECRET`) — both via dual-auth (`requireTrigger` Bearer token + HMAC signature, so a leaked global webhook secret alone can't trigger arbitrary projects). Shared `launchPreviewCrawl()` helper dispatches the run through the same `runWithAbort` / `crawlAndGenerateTests` path as POST /trigger, preserving `canonicalUrl` for baseline integrity and honouring `dialsConfig` (testCount / exploreMode / explorerTuning) derived from the same `resolveDialsConfig` validator `routes/runs.js` uses. Tampered signatures return 401 before any crawl work. AUTO-015b: `crawl.start.deployment` activity marker logged alongside standard `crawl.start` with `meta: { provider, previewUrl, runId }`; new `GET /api/v1/projects/:id/last-deployment-run` (24h window, `anyAuthenticatedMember`) powers the "Last deployment run" chip on `ProjectHeader.jsx`. `req.rawBody` capture scoped to webhook routes only via `express.json({ verify })` predicate (avoids global Buffer copy). Integration Snippets UI ships Vercel + Netlify payload templates; `.env.example` documents the two secrets. End-to-end happy-path test in `backend/tests/deployment-triggers.test.js` seeds a project + token, POSTs a signed payload, asserts 202 + run row + activity marker + correct preview URL; tamper rejection tests cover both providers (missing signature, invalid signature, missing Bearer, bogus Bearer). AGENT.md gained a new "Issue-handling rule" section codifying "every finding produces an outcome (fix or ROADMAP entry), never a silent gap." | PR #12 |
| AUTO-008 | Distributed runner across multiple machines. New `backend/src/worker.js` standalone entrypoint that boots DB + AI keys + workspace backfill but binds no HTTP port — same image as `backend`, command-overridden to `node src/worker.js` so `docker compose --profile redis --profile postgres up --scale worker=N` spawns N pure queue consumers without port-3001 contention. `docker-compose.yml` `worker` service gated under the `redis` profile (zero regression — plain `docker compose up` stays Redis-free); `DATABASE_URL` defaults to the bundled `postgres` service so SQLite-isolation across replicas is impossible by default (workers MUST share the backend's DB). New `WORKER_CONCURRENCY` env var (with backwards-compatible `MAX_WORKERS` fallback) controls per-container concurrency in `runWorker.js`. Dashboard `GET /api/v1/dashboard` payload extended with `workerPool` block: `mode` (`distributed` / `single-process`), `queue` (`waiting` / `active` / `completed` / `delayed` / `failed` via `getQueueStats()` — added `getCompletedCount()` to the `Promise.all` for completion visibility), and per-replica `activeWorkers` / `idleWorkers` / `totalWorkers` derived from `runQueue.getWorkers()` capped by `queue.active` so transient `active > workers` (worker disconnects mid-job) can't surface negative idle counters. Frontend `Dashboard.jsx` renders four new `StatCard`s (Runner Mode, Queue Depth, Active Workers, Completed Jobs) wired with `??` fallbacks so payload absence never crashes the UI. Best-effort try/catch around the queue introspection block — never lets BullMQ failures fail the dashboard, gracefully degrades to the zeroed `single-process` stub. Worker process installs the same `uncaughtException` / `unhandledRejection` guards as `index.js` so Playwright internals can't crash a worker mid-shard, and a SIGTERM/SIGINT graceful-shutdown sequence drains BullMQ → closes queue → closes Redis → closes DB. New `backend/tests/worker-pool-dashboard.test.js` (registered in `run-tests.js`) covers five scenarios: queue unavailable → `single-process` stub, distributed happy path, `activeWorkers` capped at `totalWorkers`, queue-introspection error → fallback to `single-process`, zero workers connected → mode still `distributed` with zeroed counters. `docs/guide/getting-started.md` documents the multi-machine deployment pattern (with explicit "must set `REDIS_URL` on backend too" warning to prevent silent in-process execution); `docs/guide/env-vars.md` documents `WORKER_CONCURRENCY` alongside the legacy `MAX_WORKERS`; `QA.md § Distributed Runner` adds a 5-step manual test plan covering scaled startup, sharded run drainage, mid-run worker kill, dashboard rendering in both modes; `docs/changelog.md` updated under `### Added` and `### Changed`. | PR #9 |
| SEC-004 | Multi-factor authentication — TOTP enrollment + 8 single-use SHA-256-hashed recovery codes + WebAuthn passkeys via `@simplewebauthn/server` (optional dep — 503 when omitted) + per-workspace `mfaRequired` enforcement with configurable 0–90 day grace period + JWT `amr` claim distinguishing `["pwd"]` / `["pwd","mfa"]` / `["oauth"]` sessions (RFC 8176) + login factor picker UI (Passkey / Authenticator / Recovery code) + post-login grace banner via `sessionStorage` + dedicated `MFA_ENROLLMENT_REQUIRED` panel for past-grace users. Backend: 3 migrations (015 mfa columns, 028 workspace enforcement, 029 webauthn credentials); `evaluateMfaEnforcement(user)` strictest-wins across multi-workspace users anchored at MAX(policy-flipped, joined-at, account-created); pending-MFA login tokens 24-byte single-use 5min TTL with periodic purge; per-IP rate limits (5/15min on verify, 3/15min on enroll); constant-time TOTP + recovery-code compare via `crypto.timingSafeEqual`; TOTP secret AES-encrypted at rest via existing `credentialEncryption.js`; WebAuthn signature-counter clone detection (rolled-back counter → 401 `WEBAUTHN_CLONE_DETECTED`); user-scoped `webauthnRepo.deleteById` so cross-user delete returns 404; self-lockout guard returns 400 `MFA_LAST_FACTOR_PROTECTED` when removing the last factor under workspace enforcement; CSRF exempt for the 3 pre-auth verify endpoints; `/mfa/enroll` 409 when already enabled (no silent overwrite); OAuth callbacks enforce the same policy as password login. Audit: all `auth.mfa.*` and `workspace.mfa_policy_changed` events emitted via `activityRepo`. Frontend: `Settings.jsx` Security tab (QR enrollment via `api.qrserver.com` — zero new dep; recovery-codes one-time display with download + copy + "I've saved them" gate; passkey add/list/remove via `@simplewebauthn/browser` lazy dynamic-import with v10/v11 forward-compat; admin workspace enforcement panel with live `GET /workspaces/current/mfa-compliance` preview); `Login.jsx` factor picker with ARIA `role="tablist"`; `MfaGraceBanner` auto-clears on next focus when user enrolls; `api.login()` returns `{data, headers}` via opt-in `returnRaw` so other ~50 callers' shape stays stable. Coverage: 47 integration test cases across `auth-mfa-totp.test.js` (18) / `auth-mfa-enforcement.test.js` (14) / `auth-webauthn.test.js` (15); `generateTotpCode(secret)` helper in `tests/helpers/test-base.js`; `webauthnRepo` CRUD incl. FK CASCADE + cross-user isolation; `evaluateMfaEnforcement` decision logic incl. multi-workspace strictest-wins; all `auth.mfa.*` activity emissions asserted. Permissions: 15 new endpoint entries; SEC-004 removed from `outOfScope.items`. Docs: `docs/changelog.md` Added + Changed + Security entries; `QA.md` § Multi-factor authentication with 28-step manual test plan + 9 negative/edge cases. | PR #10 |
| SEC-006 | PII firewall — new `backend/src/pipeline/domSanitizer.js` exports `sanitizeDomSnapshot(input, { allowlist, runId })` that walks crawler-output structures (snapshots + classified pages) and redacts emails, phones, SSNs, Luhn-checked credit-card numbers, JWT triple-segment tokens, `Bearer`/`Basic` auth headers, and `?token=` / `?code=` / `?access_token=` query-string params with deterministic per-run placeholders (`<EMAIL_N>`, `<PHONE_N>`, `<SSN_N>`, `<CARD_N>`, `<TOKEN_N>`) so the AI prompt can still correlate references across snapshots. Wired in `backend/src/crawler.js` between crawl output and `generateAllTests` / `runPostGenerationPipeline` so the sanitised snapshots feed both AI generation and the post-generation pipeline. Migration `030_projects_pii_firewall.sql` adds `projects.strictPiiFirewall INTEGER NOT NULL DEFAULT 1` (on by default) + `projects.piiAllowlist TEXT` (JSON array). `projectRepo` round-trips both fields; `routes/projects.js` adds `strictPiiFirewall` / `piiAllowlist` to `SINGLE_FIELD_BYPASS` so single-field PATCH from the per-project quality card skips name/url validation. Frontend `ProjectQualityCard.jsx` ships a new "PII Firewall" inner tab with the strict-mode toggle + allowlist editor. `pipeline.pii_redacted` structured log line records per-category counts per run for audit. Tests: `backend/tests/pii-sanitizer.test.js` covers pattern coverage, Luhn validation (valid card / invalid card / 13- and 19-digit boundaries), allowlist opt-out, deterministic placeholder generation across nested objects and arrays, and null / undefined / non-string edge cases. `QA.md` § PII Firewall added with manual test plan. `docs/changelog.md` updated under § Added + § Security. | PR #11 |
| INF-007 | OpenTelemetry + Sentry observability baseline. Preloaded OTel SDK via `node --import ./src/otel-preload.mjs` (wired into `backend/package.json` scripts + `backend/Dockerfile` `CMD` + the `worker` `docker-compose.yml` command) so `@opentelemetry/auto-instrumentations-node` patches `express` / `pg` / `ioredis` / outbound HTTP BEFORE any application module loads — in-graph init was too late and would have silently dropped framework-level spans. New `backend/src/utils/observability.js` owns the `AsyncLocalStorage`-based `requestContext`, the `crypto.randomUUID()`-minted `createRequestId`, and the dynamic-import `initOpenTelemetry()` that's a no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset. New `backend/src/utils/metrics.js` owns a single `prom-client` `Registry` and 14 brand-neutral `app_*` counters / histograms / gauges (HTTP RED, run lifecycle, per-test, crawler, pipeline stage, AI provider latency / tokens / errors, BullMQ queue depth) with three histogram-bucket presets tuned per metric type and a `classifyAiError` helper that constrains AI error labels to a fixed 6-value enum (`rate_limit` / `timeout` / `auth` / `server_error` / `network` / `unknown`) to prevent cardinality bombs from raw vendor error messages. `backend/src/middleware/appSetup.js` mounts three middleware layers — per-request `X-Request-Id` minting / inbound-echo with `requestContext.run()` wrapping every downstream handler so `getRequestId()` works anywhere; HTTP RED metrics recorded on `res.finish` using the matched Express ROUTE TEMPLATE (`${req.baseUrl}${req.route.path}`) never the raw URL, with `__not_found__` and `__other__` constant-cardinality fallbacks; and the `GET /metrics` Prometheus scrape endpoint with timing-safe Bearer-token auth via `crypto.timingSafeEqual` over SHA-256 digests (matches the established pattern at `appSetup.js:574` and `trigger.js:854-857`) + live `app_queue_depth` gauge refresh from BullMQ `getQueueStats()` on every scrape. AI provider instrumentation wraps the legacy `callProvider` as an instrumentation shell around a renamed `_callProviderUnsafe` — records `app_ai_provider_latency_seconds{provider, outcome}` (where `outcome ∈ {success, rate_limited, error}` so the p99-by-outcome panel detects slow timeouts inflating the error tail), `app_ai_provider_errors_total{provider, reason}` via `classifyAiError`, and per-SDK-shape `app_ai_provider_tokens_total{provider, kind=input|output}` token recording (Anthropic `msg.usage`, OpenAI/Compat/OpenRouter `res.usage`, Gemini `result.response.usageMetadata`). `providerMetricLabel()` folds `compat:<slot-id>` → literal `compat` so per-slot cardinality stays bounded. Run-lifecycle counters bump from `runRepo.create()` (per-row `app_runs_total{type}`); `testRunner.processResult` and `finalize` emit per-test `app_tests_executed_total` + `app_test_duration_seconds` and run-level `app_run_outcome_total` + `app_run_duration_seconds`; `crawler.js` emits `app_crawl_pages_total{mode}` (link-crawl vs state-explorer) and the same run-outcome / run-duration pair for both crawl and generate run types. Every metric increment is wrapped in `try/catch` so observability is best-effort and never fails a real request or run. Structured logging extracted from `logFormatter.js` into a dedicated `backend/src/utils/structuredLog.js` (per NEXT.md INF-007 "Files to change") with `formatLogLine` + `structuredLog` both auto-injecting `requestId` (from `AsyncLocalStorage`) and OTel `traceId` / `spanId` (from `getSpanContext`) on every output line — the 3-way Sentry → Loki → Jaeger correlation pivot for production debugging. `JSON.stringify` drops undefined keys natively (clean output when OTel is off); text mode runs `.filter(([, v]) => v !== undefined && v !== null)` so the OTel-disabled path emits no `traceId=undefined spanId=undefined` noise. Backend Sentry init lives in the preload (`Sentry.init({ beforeSend(event) { delete event.request?.headers; ... }})` strips Authorization / Cookie / X-CSRF-Token before any event leaves the host); `middleware/workspaceScope.js` `attachSentryContext(req)` populates `Sentry.setUser({ id })` + `workspace_id` + `user_role` tags at both auth code paths (JWT-validated and API-key-validated) so multi-tenant Sentry inboxes are searchable per workspace without leaking email / username (GDPR / SOC 2 minimum); `index.js` registers `Sentry.setupExpressErrorHandler(app)` after all routes (no-op when `SENTRY_DSN` is unset). Frontend `@sentry/react` init in `frontend/src/main.jsx` runs only when `VITE_SENTRY_DSN` is set, with `browserTracingIntegration()` for automatic pageload + History API navigation breadcrumbs (the operator pivot for "what page was the user on?"), `sendDefaultPii: false`, a `stripUrlSecrets` helper that trims query strings + hashes from URL-carrying breadcrumbs (OAuth `code`, magic-link `token`, password-reset `t`, audit-log `cursor`), explicit deletion of auto-collected `event.user.email` / `username` / `ip_address` in `beforeSend`, and only the anonymous `user.id` + `workspaceId` forwarded from the persisted `app_auth_user` localStorage row (matching the backend's `setUser({ id })`-only pattern). `frontend/src/components/layout/ErrorBoundary.jsx` calls `Sentry.captureException(error)` when `VITE_SENTRY_DSN` is set. New `monitoring/prometheus/alerts.yml` ships 11 alert rules grouped by concern (availability / runs / queue / AI providers / runtime / observability liveness) with every rule carrying a `runbook_url` anchor; the `BackendScrapeDown` meta-alert fires after 3 min of `up == 0` so a broken scrape pipeline doesn't silently dark every other alert. New `docs/guide/observability.md` is the canonical operator hand-off — metric reference table, trace ↔ log ↔ Sentry correlation workflow, Prometheus scrape config example, full on-call runbook for every alert rule, and a 5-step deployment verification checklist. `docs/guide/env-vars.md` documents `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_SERVICE_NAME` / `METRICS_SCRAPE_KEY` / `SENTRY_DSN` / `SENTRY_TRACES_SAMPLE_RATE` / `VITE_SENTRY_DSN` / `VITE_SENTRY_TRACES_SAMPLE_RATE` with the init-order note about `--import`; `backend/.env.example` adds a delimited Observability block with the `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` generator command for `METRICS_SCRAPE_KEY`. `permissions.json` registers `GET /metrics` at the admin role. Every layer is a no-op when its env var is unset so the default deployment ships with zero external telemetry traffic. New `backend/tests/observability.test.js` (registered in `run-tests.js`) covers nine scenarios — `formatLogLine` requestId propagation through `AsyncLocalStorage`, no-context omission of the `req:` tag, OTel `initOpenTelemetry()` no-op when endpoint is unset, X-Request-Id minting on responses without an inbound header, X-Request-Id verbatim echo when an inbound header is supplied, `/metrics` 401 without Bearer token, `/metrics` 401 with wrong token, `/metrics` 200 + `text/plain` Prometheus exposition + presence of `nodejs_*` + `app_runs_total` + `app_tests_executed_total` + `app_crawl_pages_total`, and `METRICS_SCRAPE_KEY` runtime-unset → 401 even with a previously-valid token. Brand-neutral `app_*` prefix per `docs/guide/rebranding.md` so Prometheus dashboards and alert rules don't require migration during a future product rebrand. | PR #14 |
| AUTO-010 | Root-cause failure clustering. New pure helper `backend/src/pipeline/failureClusterer.js` exports `clusterFailures({ results })` returning `[{ fingerprint, affectedTestIds[], sharedUrl, sharedSelector, errorPattern, size }]` — no DB access, no LLM calls, deterministic fingerprint hashing only (AI-generated explanations remain AUTO-021's scope). Matching heuristic merges two failed results when normalised `errorPattern` strings are byte-equal AND (same URL origin prefix OR selector Levenshtein edit-distance ≤ 4 OR both sides URL-less + selector-less). `size` counts all failed result rows (including data-driven iterations); `affectedTestIds` is the deduplicated set of distinct test IDs surfaced in the UI's "N affected test(s)" copy. Migration `027_run_root_causes.sql` adds a nullable JSON `runs.rootCauses` column registered in `runRepo.JSON_FIELDS` + `INSERT_COLS`; `ARRAY_DEFAULT_FIELDS` Set in `rowToRun` defaults pre-migration rows to `[]` so external consumers reading `run.rootCauses.length` never throw. `backend/src/testRunner.js` calls the clusterer on single-process run completion; `backend/src/workers/runWorker.js` `finalizeShardedRun` mirrors the same call against the full DB results set (parity with the single-shard tail — without this every multi-shard run would persist `rootCauses: null` and the panel would never render for CAP-002 sharded runs). `frontend/src/pages/RunDetail.jsx` renders a collapsible "Root Cause Summary" panel above the test list when `run.rootCauses.length >= 1`, defaults collapsed for a single cluster, auto-expands when ≥2 clusters surface via a `hasSetInitialExpand` ref so SSE snapshots don't clobber user toggles. Coverage: `backend/tests/failure-clusterer.test.js` (registered in `run-tests.js`) covers same-message → single cluster of 10, distinct messages → N singleton clusters, URL-prefix grouping (`/auth/login` vs `/auth/callback` merge), selector-similarity threshold, passed-results filtered out, data-driven iteration dedup, URL-less + selector-less fallback, URL-less with different selectors stay separate (regression for `null === null` shortcut), JSON round-trip (no leaked `Set` / `_seenTestIds` scratchpad), and <500ms perf budget on a 100-row fixture. E2E mock spec at `tests/e2e/specs/run-detail-root-cause-ui.spec.mjs` asserts the panel renders with a synthetic `rootCauses` payload via `page.route()`. `docs/api/projects.md` documents the new `run.rootCauses[]` shape on `GET /api/v1/runs/:runId`. | PR #6 |
| MNT-001 | Vision-based locator healing — host-side stages 7 (pixelmatch CV) + 8 (LLM vision) fire only after every DOM strategy in the runtime healing waterfall has failed. New `tryVisionHeal(ctx, deps)` orchestrator in `backend/src/selfHealing.js` with dependency-injected `pixelmatchHeal` / `llmVisionHeal` / `isBudgetExhausted` so unit tests stay deterministic (no real CV, no real network in CI). Real adapters in `backend/src/runner/visionHealAdapters.js` ship the sliding-window pixelmatch matcher (real `pixelmatch@^7` + `pngjs@^7` with stride adaptation under a `VISION_HEAL_MAX_WINDOWS` budget) and an LLM-vision proxy to `aiProvider.callVisionModel`. New `callVisionModel()` covers the Anthropic / OpenAI / Google / OpenRouter / OpenAI-compat multimodal message-shape differences behind one provider-agnostic call; ties usage into INF-007's token telemetry under a new `operation="vision_heal"` label (existing AI counters gained the third `operation` label, defaulting existing callers to `"generation"`) plus a new `app_ai_cost_usd_total{provider, operation}` counter for SaaS unit-economics dashboards. `STRATEGY_VERSION` bumped 3 → 4 (existing healing hints invalidate automatically — the next run retraverses the waterfall to relearn); indices 7 / 8 reserved for host-side vision via new `STRATEGY_INDEX_PIXELMATCH` / `STRATEGY_INDEX_LLM_VISION` exports. Migration `035_projects_vision_healing.sql` adds per-project `visionHealing` / `visionHealMaxCallsPerDay` / `visionHealMaxCostUsdPerMonth` columns. Migration `036_element_baselines.sql` adds the `element_baselines` table that stores per-element baseline PNG crops (BLOB) captured on green runs via the new `captureElementCrop()` helper in `pageCapture.js`, keyed `(projectId, healingKey)` where `healingKey` mirrors the versioned `<testId>@v<N>::<action>::<label>` shape from `healing_history` so code-edits invalidate stale baselines automatically. Migration `037_vision_budget_counter.sql` adds the `vision_budget_counters` table with per-project per-window counters (day + month) that auto-roll at UTC boundary and back the budget circuit-breaker; `record(projectId, costUsd)` bumps both windows in a single transaction, `isBudgetExhausted(projectId)` reads against project caps. Stage-8 skips emit a new `healing.vision_budget_exhausted` audit row + `app_vision_heal_budget_exhausted_total{projectId, reason}` Prometheus counter for the `VisionHealBudgetExhausted` alert in `monitoring/prometheus/alerts.yml`. `executeTest.js` wires real deps into `tryVisionHeal`, persists green-run baselines after passing tests, loads them on failure for stage 7, records cost after stage-8 success, and emits coordinate re-action via `performVisionHealReaction(page, action, box, label, key)` so the heal completes the originally-failed click / press / tap / dblclick / hover / rightclick. New **Vision Healing** tab in the Quality card (per-project mode picker `off` / `pixelmatch_only` / `pixelmatch_and_llm`, daily call cap, monthly cost cap; `pixelmatch_and_llm` server-gated by `aiProvider.hasVisionProvider()`). New `VisionHealPanel` on the Healing dashboard with zero-state explainer, stats grid (total heals / LLM spend / strategy split with `>= 50%` LLM-share warning), and audit-log deep-link. SEC-007-compatible audit trail: `persistHealingEvents` emits `healing.vision_pixelmatch` / `healing.vision_llm` rows via `logActivity` with full `meta` (confidence, strategyIndex, box, model, costUsd) — hash-chain verifiable. Coverage: 19 unit tests in `self-healing-vision.test.js`, end-to-end pixelmatch tests in `vision-heal-pixelmatch.test.js`, coordinate re-action tests in `vision-heal-reaction.test.js`, repo round-trip + retention + cascade-delete in `element-baseline-repo.test.js` and `vision-budget-repo.test.js`, metric-shape regression assertions in `observability.test.js`. Operator guide `docs/guide/vision-healing.md`; QA.md release-verification checklist. | PR #17 |
| AUTO-009 | Browser code coverage mapping (MVP + AUTO-009b/c/d/f/g/h/i/j follow-ups landed in the same PR). Opt-in per-project (`projects.coverageEnabled`) Playwright V8 JS coverage capture in `executeTest.js` bracketing each test with `page.coverage.startJSCoverage` / `stopJSCoverage`. New `backend/src/pipeline/coverageAggregator.js` summarises per-test coverage into `runs.coverageSummary` (line / statement / branch / function pct via AUTO-009c `v8ToIstanbul.js` converter, `topUncoveredFiles[]` capped at 20, `sourceMapStatus` `"resolved"`/`"partial"`/`"fallback"`). AUTO-009b source-map resolution via `backend/src/pipeline/sourceMapResolver.js` (`source-map@^0.7` behind an LRU cache — 10MB cap, 1h TTL, alias-counted entries, SSRF-guarded via `utils/ssrfGuard.js`); optional `projects.sourcemapBaseUrl` override. AUTO-009d PR-scoped coverage diff (the Codecov play) via `backend/src/integrations/githubChecks.js#getChangedFilesWithRangesForPr` (combined files+ranges helper, single pagination pass) + `backend/src/pipeline/coveragePrDiff.js` (`computePrCoverage` intersects covered lines with the PR's changed line ranges, `renderPrCoverageMd` appends a "Coverage of changed lines" section to the GitHub Check summary). Four new quality gates wired into `evaluateQualityGates`: `minCoveragePct`, `minBranchPct`, `minPrCoveragePct`, `maxCoverageRegressionPct` — all 0–100 percentages. AUTO-009f / AUTO-009k sharded-run parity + two-stage merge: each shard pre-aggregates its slice via `pipeline/finalizeCoverage.js#aggregateShardCoverage` (compact Istanbul-shaped per-bundle id-set arrays + per-source line arrays + server diffs + per-test deltas) and persists via `runRepo.setShardCoverageSummary` into the sparse `runs.shardCoverageSummaries[]` JSON column (migration 042). The boundary-crossing finalizer (`workers/runWorker.js#finalizeShardedRun`) reads the array and calls `pipeline/finalizeCoverage.js#mergeShardSummaries` to take set union across shards — matching the industry pattern (c8 / nyc / Istanbul `libCoverage.createCoverageMap().merge()` / Codecov upload-then-merge). Naive count-summing would be wrong (proven counter-example: shard 0 covers lines [1,2,3], shard 1 covers lines [3,4,5] → naive 3+3=6 vs true union 5; pinned by `coverage-shard-merge.test.js`). Fallback path (AUTO-009f) re-aggregates from raw `jsCoverage` blobs in `runs.results` when `shardCoverageSummaries` is partial (partial-deploy race protection) — functionally correct because id-set union over per-test results is mathematically equivalent to per-shard merge (set union associative), bounded by `COVERAGE_MEMORY_CEILING_MB`. Pre-aggregation also strips raw V8 ranges from `runs.results` (10s of MB savings per row on large-bundle SUTs). AUTO-009g memory ceiling (`COVERAGE_MEMORY_CEILING_MB`, default 500) drops raw `jsCoverage` payloads past the threshold and stamps `summary.truncated = true`. AUTO-009h server-side Istanbul/NYC coverage for API tests via `backend/src/pipeline/serverCoverageProxy.js` — supports HTTP `GET /__coverage__` (SSRF-guarded) and `file://` shared-FS modes; aggregator merges server diffs into `topUncoveredFiles[]` with `layer: "browser" \| "server"` discriminator. AUTO-009i coverage regression alerting via `backend/src/pipeline/coverageRegressionDetector.js` — per-project `coverageRegressionThresholdPct` fires Teams adaptive card / email / webhook through the FEA-001 channels + `coverage.regression` audit row. AUTO-009j daily retention sweep in `scheduler.js` at 04:00 UTC nulls `coverageSummary` + `prCoverageDiff` on runs older than `COVERAGE_RETENTION_DAYS` (default 90). 8 DB migrations (038–045) add `projects.coverageEnabled` / `sourcemapBaseUrl` / `serverCoverageEndpoint` / `coverageRegressionThresholdPct` and `runs.coverageSummary` / `shardCoverageSummaries` / `changedFileRanges` / `prCoverageDiff`. New `runRepo` helpers: lean `getRunsWithCoverage(projectIds)` for the dashboard trend (avoids bloating LEAN_COLS), atomic `setShardCoverageSummary` (transaction-wrapped, dialect-conditional `FOR UPDATE`), and `purgeCoverageSummaryOlderThan(days)`. Dashboard `routes/dashboard.js` ships `coverageTrend` (30-day per-project series with line/branch/function pct) + `latestCoverageByProject`; new `frontend/src/pages/Dashboard.jsx` `CoveragePanel` component renders Browser/Server/Combined layer toggle + Lines/Branches/Functions metric toggle + sparkline + top-uncovered files with `sourceMapStatus` badge. `frontend/src/components/automation/ProjectQualityCard.jsx` adds a new "Coverage" inner tab (enable toggle, sourcemap base URL, regression alert threshold). `QualityGatesPanel.jsx` adds the four coverage gate fields. `TestRunView.jsx` renders per-test `+47L · +12B · +3F` blue badges from `coverageSummary.perTest`. `RunDetail.jsx` appends `%` suffix to pct rule violations and surfaces `priorCoveragePct` context on regression violations. 8 new tests registered in `run-tests.js`: `coverage-aggregator`, `run-coverage-integration` (full shape + S/B/F + source-map modes), `run-shard-coverage` (sharded-run parity regression), `coverage-memory-ceiling` (AUTO-009g), `coverage-pr-diff` (AUTO-009d), `source-map-resolver`, `server-coverage-proxy` (AUTO-009h). E2E `tests/e2e/specs/coverage-ui.spec.mjs` covers Dashboard panel + RunDetail badge + ProjectQualityCard toggle via `page.route()` mocks. `docs/guide/coverage-mapping.md` + `docs/guide/coverage-server-side.md` guide operators through enable/interpret/security; `QA.md` adds AUTO-009 manual test checklist; `docs/changelog.md` updated under `## [Unreleased]`. New deps: `source-map@^0.7.4`, `v8-to-istanbul@^9.3.0`. | PR #19 |
| AUTO-022 | AI eval harness with golden-set regression — plumbing complete, gate dormant until AUTO-022b records real LLM cache. New `backend/src/eval/pipelineEval.js` deterministic scorer parses generated Playwright code into selector / action / assertion tuples and scores each dimension via length-normalised Levenshtein distance (40 / 30 / 30 weighted). New `backend/src/eval/pipelineAdapter.js` provides record / replay adapters keyed on `sha256(promptVersion + EVAL_MODEL + snapshot + url)` so CI runs offline and deterministic. New `backend/scripts/run-eval.mjs` CLI (`--write-baseline`, `--report=`, `--persist`, `EVAL_RECORD=1`) compares aggregate score to `eval-baseline.json` and exits non-zero on >5% aggregate or >10% per-dimension regression, naming each per-case aggregate drop > 20%. Cold-start guard short-circuits to exit 0 when `.cache/` is empty so the merge isn't blocked by missing recordings. New `--persist` flag writes per-case scores into `metric_samples` (4 rows per case: `eval.aggregate` / `eval.selectors` / `eval.actions` / `eval.assertions`, scoped to `__eval_harness__` sentinel projectId, tagged with a per-run uuid for Dashboard grouping; `actual` Playwright code persisted on the aggregate row capped at 4 KB). `metricSamplesRepo` gains `insertSamples` (batched txn), `getSeries` `order` param, and `getSeriesByRunId` (cross-dialect LIKE pre-filter + JS verification — works on SQLite + Postgres without `json_extract`). New Dashboard **AI Eval Quality** panel renders a 30-day per-dimension trend with drill-down — backed by an `evalTrend` block on `GET /api/v1/dashboard` and a new `GET /api/v1/dashboard/eval/:runId` route that joins persisted scores with `expected` lifted from the on-disk golden JSON. New path-filtered `.github/workflows/eval.yml` runs `node backend/scripts/run-eval.mjs` in replay mode and uploads `eval-report.json` artifact. Five canonical golden templates (one per category — form-fill, list-click, modal, multi-page-nav, assertion-heavy) under `backend/tests/fixtures/eval-goldens/`; remaining 45 cases are skeletons tracked as AUTO-022b. Operator guide at `docs/guide/eval-harness.md`; maintainer brief at `docs/guide/eval-harness-record-goldens.md`. 32 unit + integration tests cover scorer exports (`eval-pipeline.test.js`), regression-detection diagnostics (`eval-regression.test.js`), `metric_samples` persistence (`eval-persistence.test.js`), CLI E2E subprocess exit codes (`eval-cli-e2e.test.js`), and frontend score-format helpers (`eval-score-format.test.js`). | PR #17 |

---

## Phase Summary

| Phase | Scope | Status                                                                                                                                                                                | Est. Duration |
|-------|-------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------|
| Phase 1 — Production Hardening | Security, reliability, data integrity | ✅ Complete                                                                                                                                                                            | — |
| Phase 2 — Team & Enterprise Foundation | Auth hardening, multi-tenancy, RBAC, queues | ✅ Mostly complete — SEC-001/002/003/004, INF-001/002/003/004/005/006, ACL-001/002, FEA-001/002/003, ENH-036 + ENH-036b all ✅ (SEC-004 MFA shipped in PR #10 with TOTP + WebAuthn + per-workspace enforcement); SEC-005 (SSO) tracked as 🟢 Strategic under Phase 5 per AUDIT.md severity reconciliation | 8–10 weeks |
| Phase 3 — AI-Native Differentiation | Visual regression, cross-browser, competitive features | 🔄 In progress — most differentiators shipped (DIF-001/002/002b/003/004/005/006/007/011/012/013/014/015/016 ✅ — DIF-005 embedded trace viewer shipped in PR #9; **INT-002** GitHub PR check comments shipped in PR #15; **DIF-012** multi-environment support shipped in PR #2); remaining: DIF-008–010, DIF-015b/c sub-items | 10–12 weeks |
| Phase 4 — Autonomous Intelligence | Risk-based testing, change detection, quality gates | 🔄 In progress — AUTO-001/002/002b/003/003b/004/005/006/007/008/009/010/012/013/015/015b/016/016b/017/017.3/019 ✅ (AUTO-009 shipped in PR #19, AUTO-008 in PR #9, AUTO-010 in PR #6, AUTO-004 in PR #18, AUTO-001 in PR #15); remaining: AUTO-011, AUTO-014, AUTO-018, AUTO-021 (AUTO-020 superseded by AUTO-015) · Capabilities row: CAP-001 (data-driven) ✅ PR #1, CAP-002 (sharding) ✅ PR #3; CAP-002b (SaaS-readiness follow-ups) tracked separately in Summary | 14–18 weeks |
| Phase 5 — Industry Hardening (AUDIT.md) | OTel, Postgres-default, MFA, SSO, PII firewall, eval harness, Helm/DR, SDK, DAG runner, critic agent, **AI platform foundation (AI-002–007)** | 🔄 In progress — SEC-004 MFA ✅ (PR #10), SEC-006 PII firewall ✅ (PR #11), SEC-007 compliance audit log ✅ (PR #12), INF-007 OTel/Sentry observability ✅ (PR #14), AUTO-022 eval harness plumbing ✅ (PR #17 — gate dormant until AUTO-022b records real LLM cache, deferred); AI-002..AI-007 (provider modularization → adapter cost tracking → agent config → multi-agent dispatch → per-role eval → cost governance) queued. Target: industry-readiness score 6.0/10 → 9.0/10. | 12–16 weeks |
| Ongoing — Maintenance & Platform Health | Healing AI, DX, exports, accessibility | 🔄 Continuous                                                                                                                                                                         | — |

---

## Phase 2 — Team & Enterprise Foundation

*Goal: Multi-user, secure, and durable enough for team deployment (5–50 users). Phase 2 is largely complete — only the two deferred enterprise-auth items remain.*

---

### SEC-004 — MFA (TOTP + WebAuthn passkeys + per-workspace enforcement)

**Status:** ✅ Complete (PR #10) — see Completed Work Summary above for the full implementation details. Shipped scope went beyond NEXT.md's original "TOTP first, passkey later" framing and now includes WebAuthn passkey support, per-workspace `mfaRequired` enforcement with configurable grace period, and the JWT `amr` claim per RFC 8176 — all in one PR.

---

### SEC-005 — SAML / OIDC SSO federation 🟢 Strategic

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive (BearQ, enterprise) · AUDIT.md S2 (severity reclassified from 🔵 Medium to 🟢 Strategic — enterprise procurement requirement, schedule per pipeline demand rather than as a deferred medium)

**Problem:** Sentri supports email/password + GitHub/Google OAuth, and SEC-004 covers TOTP MFA, but there is no SAML 2.0 or OIDC federation support. Enterprise procurement teams require SSO integration with their identity provider (Okta, Azure AD, OneLogin, Ping). BearQ inherits SmartBear's enterprise SSO. This is a distinct requirement from MFA — SSO replaces the login flow entirely rather than adding a second factor.

**Fix:** Integrate `openid-client` for OIDC and `@node-saml/passport-saml` for SAML 2.0. Add a per-workspace SSO configuration (metadata URL, client ID, certificate). When SSO is enabled, redirect login to the IdP. Map IdP attributes to Sentri user fields. Auto-provision users on first SSO login. Add SSO configuration UI in Settings → Authentication.

**Files to change:**
- `backend/src/middleware/authenticate.js` — add `saml` and `oidc` auth strategies
- `backend/src/routes/auth.js` — SSO callback endpoints, IdP-initiated login
- `backend/src/database/migrations/` — `sso_configurations` table per workspace
- `frontend/src/pages/Settings.jsx` — SSO configuration panel
- `backend/package.json` — add `openid-client`, `@node-saml/passport-saml`

**Dependencies:** ACL-001 (workspaces must exist for per-workspace SSO configuration)

---

## Phase 3 — AI-Native Differentiation

*Goal: Pull ahead of Mabl, Testim, and SmartBear (including BearQ) with AI-powered capabilities and advanced testing features. These items build the competitive moat.*

---

### DIF-002c — Cross-browser crawl and recorder support 🔲 Backlog

**Status:** 🔲 Planned | **Effort:** XL | **Source:** Follow-on from DIF-002

**Problem:** Crawler (`pipeline/crawlBrowser.js`, `pipeline/stateExplorer.js`), interactive recorder (`runner/recorder.js`), and the live CDP screencast (`runner/screencast.js`) are pinned to Chromium in DIF-002. They use Playwright's CDP APIs directly — `page.context().newCDPSession()`, `Page.startScreencast`, shadow-DOM tree walkers via CDP `DOM.getFlattenedDocument` — which Firefox has no equivalent for and WebKit implements only partially via WebDriver BiDi. Users who want to crawl/record a Safari-only issue or test a WebKit rendering quirk during authoring have no path.

**Fix (high-level; deliberately deferred until there is customer demand):**
- Replace CDP screencast with Playwright's cross-browser `page.screenshot()` polling at ~8-12 fps. Lower quality but engine-agnostic. Keep CDP path for chromium as a fast fallback.
- Replace the CDP-based shadow-DOM tree walker in `crawlBrowser.js` with Playwright's `page.locator()` + `{ strict: false }` serialisation. Slower but engine-agnostic.
- Add a browser param to `POST /projects/:id/record` and `POST /projects/:id/crawl` routes; pass through to the relevant pipeline modules.
- Accept that crawl quality will degrade for firefox/webkit relative to chromium until Playwright's BiDi API stabilises.

**Files to change:**
- `backend/src/pipeline/crawlBrowser.js`, `stateExplorer.js` — accept `browser` param, swap CDP calls for cross-engine equivalents
- `backend/src/runner/recorder.js` — accept `browser`, swap screencast impl
- `backend/src/runner/screencast.js` — dual-path (CDP for chromium, screenshot poll fallback)
- `frontend/src/components/run/RecorderModal.jsx`, `frontend/src/pages/TestLab.jsx` — browser selector (the legacy `CrawlProjectModal` was migrated into the Test Lab page)

**Dependencies:** DIF-002 ✅, DIF-002b (baselines must be browser-aware before crawler variability amplifies diff noise)

---

### DIF-015c — Recorder gaps backlog (action vocabulary, assertions, pause/undo, auth, mobile) 🔵 Medium

**Status:** ✅ Mostly complete (Gaps 1/2/3/5/6 shipped in PR #11 + PR #8; Gap 4 remains 🔲 Planned, blocked on DIF-010) | **Effort:** L (split into sub-items below) | **Source:** PR #115 dogfooding + competitive review (BearQ / Mabl / Testim)

**Problem:** PR #115 made the canvas interactive and aligned recorded steps with the AI-generated / manual format, but the recorder still has six distinct gaps that surface during real use against e-commerce, kanban, and admin-dashboard targets. Gaps 1/2/3/5/6 have been shipped — see the Completed Work Summary table for full implementation details. Only Gap 4 (auth / storageState integration) remains, blocked on DIF-010 (multi-auth profile support).

#### Gaps 1/2/3/5/6 — ✅ Shipped

See the Completed Work Summary table entries for `DIF-015c (Gap 1)` (PR #11) and `DIF-015c (Gaps 2 + 3 + 5 + 6)` (PR #8) for full implementation details. The detailed gap descriptions that were here previously have been pruned per ROADMAP.md convention — shipped items live in the summary table, not inline.

#### Gap 4 — Authentication / pre-logged-in state handling

The recorder starts at `startUrl` with a fresh browser context — no cookies, no localStorage, no logged-in state. Three flows have no good answer today:

1. **Recording a test against an authenticated app** — user must record the login flow as part of every test, even though the resulting test will execute under a different fixture in CI. Workaround is to record the full login each time.
2. **Recording behind SSO / OAuth** — login redirects through a third-party IdP (Google / Okta / Azure AD); the recorder captures the IdP form fields but those selectors are useless at replay (the IdP UI changes; tests cannot be rerun against a different env).
3. **MFA-protected logins** — every recording requires re-doing MFA, which is not deterministic.

Possible fix: integrate with project credential profiles (DIF-010) so the recorder browser context is seeded with `storageState` from a captured login, skipping login entirely. Pair with environment-aware credential profiles per `MNT-004` / `DIF-012`.

**Sub-item status:**

| Sub-item | Effort | Priority | Status |
|---|---|---|---|
| Gap 1 — Expanded action vocabulary | M | 🟡 High | ✅ Complete (PR #118 + PR #11 — paste + opt-in keyboard shortcuts) |
| Gap 2 — Inline assertion authoring | S | 🟢 Differentiator (parity with BearQ) | ✅ Complete (PR #118 backend + PR #8 — point-and-click hover-pick UX + `assertCount` / `assertHasClass` shipped) |
| Gap 3 — Pause / resume + undo | S | 🔵 Medium | ✅ Complete (PR #8) |
| Gap 4 — Auth / storageState integration | M | 🔵 Medium (depends on DIF-010) | 🔲 Planned |
| Gap 5 — Device profile during recording | S | 🔵 Medium | ✅ Complete (PR #8 — launch + mid-session switch with context rebuild) |
| Gap 6 — Stealth launch profile | S | 🔵 Medium | ✅ Complete (PR #8 — hand-rolled, no `playwright-extra` dep) |

**Remaining files to change** (Gap 4 only):
- `backend/src/runner/recorder.js` — seed `storageState` on context from selected credential profile
- `backend/src/routes/tests.js` — accept `authProfileId` on `POST /record`
- `frontend/src/components/run/RecorderModal.jsx` — auth profile picker in the idle form

**Dependencies:** DIF-010 (multi-auth profiles) is a hard prerequisite for Gap 4 — the credential-profile infrastructure must exist before the recorder can seed `storageState` from it.

---


### DIF-008 — Jira / Linear issue sync 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive

**Problem:** The traceability data model already stores `linkedIssueKey` and `tags` per test, but there is no outbound sync. When a test fails, no ticket is automatically created. Engineers must manually correlate test failures to issues.

**Fix:** Add `POST /api/integrations/jira` and `POST /api/integrations/linear` settings endpoints to store OAuth tokens. On test run failure, auto-create a bug ticket (with screenshot, error message, and Playwright trace attached). Sync pass/fail status back to the linked issue's status field. Add an Integrations tab to Settings.

**Files to change:**
- New `backend/src/utils/integrations.js` — Jira and Linear API clients
- `backend/src/testRunner.js` — call `syncFailureToIssue(test, run)` on completion
- `backend/src/routes/settings.js` — integration config endpoints
- `frontend/src/pages/Settings.jsx` — Integrations tab

**Dependencies:** FEA-001 (notification infrastructure shares the dispatch pattern)

---

### INT-002 / INT-002b — GitHub PR checks + integration polish

**Status:** ✅ Complete (PR #15 / PR #17) — see Completed Work Summary above for the full implementation details.

---

### DIF-009 — Autonomous monitoring mode (always-on QA agent) 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive

**Problem:** Sentri is currently a triggered tool — it runs when instructed. The brand promise of "autonomous QA" implies it should also watch production continuously. No competitor outside enterprise tiers offers this for self-hosted deployments.

**Fix:** Add a monitoring mode per project: run a configurable set of smoke tests on a schedule against the production URL. On failure, auto-trigger a re-run to distinguish a regression from a transient flake (2 consecutive failures = confirmed). Fire notifications on confirmed failures. Show a "Monitor" badge on the dashboard for active monitoring projects.

> **Overlap resolution:** This feature builds on scheduling (ENH-006 ✅) and depends on notifications (FEA-001) for alerting. The 2-consecutive-failure confirmation logic is distinct from both and is not duplicated in either dependency — it is implemented here as monitoring-specific re-run orchestration in `scheduler.js`.

**Files to change:**
- `backend/src/scheduler.js` — add monitoring job type alongside scheduled runs
- `backend/src/routes/projects.js` — `PATCH /projects/:id/monitor`
- `frontend/src/pages/Dashboard.jsx` — monitoring status indicators
- `frontend/src/pages/ProjectDetail.jsx` — monitoring config panel

**Dependencies:** INF-003 (BullMQ — retry logic needs durable job execution), FEA-001 (failure notifications)

---

### DIF-010 — Multi-auth profile support per project 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive (unique to Sentri)

**Problem:** Sentri stores credentials per-project but supports only a single auth profile. Testing role-based access control — "admin sees this, viewer does not" — requires running the same test suite under different identities. The Test Dials already expose a `multi_role` perspective option that is not yet wired to actual credential profiles.

**Fix:** Add named credential profiles (e.g., "admin", "viewer", "guest") per project, each with a separate username/password or cookie payload. Wire the `multi_role` Test Dial to the profile selector. Surface per-profile result columns in the run detail view.

**Files to change:**
- `backend/src/utils/credentialEncryption.js` — extend to support multiple named profiles
- `backend/src/routes/projects.js` — profile CRUD endpoints
- `backend/src/pipeline/stateExplorer.js` — accept `profileId` param
- `frontend/src/pages/ProjectDetail.jsx` — credential profiles panel
- `frontend/src/components/test/TestConfig.jsx` — connect `multi_role` dial to profile selector (the legacy `TestDials.jsx` was migrated into the unified `TestConfig` surface used by the Test Lab page)

**Dependencies:** None

---

### DIF-012 — Multi-environment support (staging vs. production)

**Status:** ✅ Complete (PR #2) — see Completed Work Summary above for the full implementation details.

---

## Phase 4 — Autonomous Intelligence

*Goal: Advance Sentri beyond triggered QA into a genuinely autonomous system that makes intelligent decisions about what to test, when to test, and what failures mean. Items in this phase are post-Phase 3 and can be prioritised individually based on customer demand.*

> **Note:** Several Phase 4 items have already shipped opportunistically alongside other work and appear in the Completed Work Summary above — `AUTO-001` (risk-based test selection / ordering, PR #15), `AUTO-002` + `AUTO-002b` (diff-aware crawling for link-crawl and state-explorer modes, PR #12), `AUTO-003` + `AUTO-003b` (confidence-based auto-approval + provenance / audit trail, PR #10), `AUTO-004` (test impact analysis from git diff / GitHub PR files, PR #18 — `computeImpactedTests` + `getChangedFilesForPr` + `+10` file-affinity boost in `riskScorer` composing with AUTO-002's `changedPages[]` boost; `runs.changedFiles` + `runs.impactAnalysis` persisted; non-impacted approved tests pre-seeded as `skipped_no_impact` so every approved test has a resolution), `AUTO-005` (test retry, PR #2), `AUTO-006` (network conditions, PR #3), `AUTO-007` (geolocation/locale/timezone, PR #94), `AUTO-010` (root-cause failure clustering — deterministic `clusterFailures` helper grouping failed results by error fingerprint + URL origin prefix + selector edit-distance; `runs.rootCauses` persisted via migration 027; RunDetail "Root Cause Summary" panel; called from both the single-process tail in `testRunner.js` AND `finalizeShardedRun` in `runWorker.js` for CAP-002 parity, PR #6), `AUTO-012` (SLA / quality gate enforcement — full backend + UI + CI consumer docs, PR #2), `AUTO-013` (stale test detection, PR #99), `AUTO-015` + `AUTO-015b` (continuous test discovery on Vercel/Netlify deployment events + "Last deployment run" badge, PR #12), `AUTO-016` backend slice (axe-core scan + persistence, PR #121), `AUTO-016b` (frontend `CrawlView` accessibility panel + dashboard "Top Accessibility Offenders" rollup, PR #1), `AUTO-017` (Web Vitals performance budgets, PR #8), `AUTO-017.3` (Web Vitals trend charts, PR #9), `AUTO-019` (per-test run diffing, PR #10), and `CAP-001` (data-driven test fixtures — `test_fixtures` table + per-row iteration via `executeTestIterations` substituting `{{column}}` placeholders + per-project `iterationCap` with `[1, 100]` runtime clamp + `TestFixturePanel` on `TestDetail` + `iteration #N` badge in `StepResultsView`, PR #1). The remaining items are scoped here and ready to start; the immediate next sprint target is `DIF-015c` Gaps 2/3/5/6 (recorder gaps completion) tracked in `NEXT.md`, with `AUTO-008` (distributed runner across machines) holding queue slot 1.

---

### CAP-002 — Distributed test sharding across runners

**Status:** ✅ Complete (PR #3) — see Completed Work Summary above for the full implementation details. Per-shard wall-clock E2E + chaos integration tracked separately as `CAP-002b` below.

---


### CAP-002b — Sharding production hardening (chaos / load / SaaS-readiness) 🔵 Medium

**Status:** 🔲 Planned | **Effort:** L (split into sub-items below) | **Source:** PR #3 industry-standard audit — items NOT shipped in CAP-002's main scope but explicitly called out in the audit reply, recorded here per AGENT.md "every finding produces an outcome (fix or ROADMAP entry), never a silent gap".

**Context:** CAP-002 (PR #3) shipped the cross-process sharding primitives end-to-end and is industry-standard for **self-hosted** deployments (7/10 against the self-hosted bar per the post-merge audit). This follow-up tracks the gaps that move us toward the **managed multi-tenant SaaS** bar (Cypress Cloud / BrowserStack / Sauce Labs / LambdaTest tier — currently scored 4/10). None of these are regressions from PR #3; they're scoped here so future reviewers don't re-discover them.

#### Gap 1 — End-to-end wall-clock proof (Tier-1 E2E)

The headline acceptance criterion ("`shards: 4` on a 40-test suite completes in ~1/4 the wall-clock time of `shards: 1`") needs a Tier-1 E2E spec running against a real BullMQ + Playwright harness. PR #3 ships the spec scaffolded at `tests/e2e/specs/run-sharding-wallclock.spec.mjs` gated behind `RUN_E2E_REAL_PLAYWRIGHT=true` so it skips by default; the harness itself (Redis + 4× worker containers + a deterministic test target) is the real work. Without this, we cannot point to a CI green build that proves the speedup empirically.

#### Gap 2 — BullMQ-kill chaos integration test

PR #3 verifies the storage-layer first-writer-wins primitive in isolation (`backend/tests/run-shard-crash.test.js`) but not the end-to-end "kill a BullMQ shard job mid-execution and observe sibling-shard drain" path. A real chaos harness would: enqueue 4 shard jobs, let them start, kill one worker process, assert (a) parent run reaches `failed`, (b) `shardsCompleted < shardCount` is preserved, (c) sibling shards drain within 2s of the `sentri:run-abort` publish, (d) no orphan `active` BullMQ jobs remain for the dead runId. Same harness reusable for: workers killed during finalization, Redis flap mid-run, network partition between coordinator and worker.

#### Gap 3 — BullMQ fan-out unit test (`run-sharding-coordinator.test.js`)

PR #3 ships `backend/tests/run-sharding.test.js` extended with `partitionTestIdsForShards` coverage (5 cases including the 40-IDs-÷-4-shards acceptance shape). What's missing is a route-level test that mocks `runQueue.add` and asserts the actual fan-out call shape: `POST /run` with `shards: 4` produces exactly 4 `runQueue.add("test_run_shard", ...)` invocations with `jobId: ${runId}:s0..s3`, each carrying a contiguous `testIds` slice. Equivalent shape coverage exists today via the helper unit tests but not as a route-integration test.

#### Gap 4 — Auto-scaling shard workers

`MAX_WORKERS` is a static env var. Industry SaaS platforms (Cypress Cloud, BrowserStack) auto-scale runner pools based on queue depth + per-customer quota. Sentri would need: a queue-depth metric exposed via OTel (depends on INF-007), a worker-pool autoscaler (Kubernetes HPA targeting the metric, or a homegrown controller for non-K8s deployments), and per-tenant fair scheduling so one customer's burst doesn't starve another (see Gap 6).

#### Gap 5 — Deadletter queue + replay UI

BullMQ's `attempts: 2` exhaustion drops the job. Industry standard is a deadletter queue with a manual replay UI for operators. A failed shard with all retries exhausted should land in a DLQ with the full job payload + error chain; the run row stays `failed` (don't retroactively flip terminal state) but operators can "replay this shard" from the UI to re-execute against a fresh worker.

#### Gap 6 — Per-tenant fair scheduling + finalization SLA

Today the queue is global FIFO. Two customers running 1000-test suites simultaneously share the worker pool with no fairness; whoever enqueued first finishes first. Per-tenant fairness needs: a per-`workspaceId` queue prefix (`sentri:runs:WS-<id>`), a round-robin or weighted-fair-queue dispatcher across workspace queues, and a documented SLA on finalization latency ("p99 within 60s of last shard completing"). This pairs with `FEA-004` (per-tenant resource quotas + token-cost dashboard) which is already in ROADMAP.md.

#### Gap 7 — Smart shard balancing (duration-aware)

Sentri uses Playwright's `--shard=N/M` even-partition algorithm. Cypress Cloud balances by historical test duration so each shard finishes at roughly the same wall-clock time — critical when test durations vary by 100×. Implementation: persist median per-test duration as a column on `tests` (or a sidecar `test_durations` table), and replace `partitionTestIdsForShards`'s even-split with a greedy bin-packing algorithm. Falls back to even-split when historical durations aren't yet available.

#### Gap 8 — Cross-region shard distribution

Single-region only. Industry SaaS platforms run shards in geographically distributed runner pools (Sauce Labs has runners in 5+ regions; BrowserStack in 30+). Out of scope for self-hosted but a real differentiator gap vs. SaaS competitors.

#### Gap 9 — Container-per-shard isolation

All shards on a replica share the same Node process pool. Industry isolation patterns spawn each shard in its own container/VM so a shard that mis-uses memory or holds a Playwright browser leaked-handle can't affect siblings. Out of scope for the typical self-hosted Render/Fly deployment but a SaaS-tier requirement.

#### Gap 10 — Redis HA enforcement

CAP-002's Redis dependency is a single point of failure. Production SaaS deployments require Redis Sentinel or Redis Cluster. Currently documented in `docs/api/projects.md` § Run sharding ("Redis running for the cross-process fan-out path") but NOT enforced — operators can deploy a single-node Redis and silently lose all sharded runs on a Redis flap. Hardening: detect non-HA Redis at boot and emit a one-shot WARN, document the requirement in `docs/guide/getting-started.md`, add a `/health/redis` endpoint that exposes the topology so monitoring can alert.

**Suggested split into PRs:**

| Sub-item | Effort | Priority | Dependency |
|---|---|---|---|
| Gap 1 — Wall-clock E2E harness | M | 🟡 High | Spec scaffolded in PR #3; harness wiring is the work |
| Gap 2 — BullMQ-kill chaos test | M | 🟡 High | Same harness as Gap 1 |
| Gap 3 — Coordinator route-mock test | S | 🔵 Medium | None — pure unit test |
| Gap 4 — Auto-scaling shard workers | XL | 🟢 Strategic | INF-007 (OTel metrics) |
| Gap 5 — Deadletter queue + replay UI | L | 🔵 Medium | None — pure BullMQ feature |
| Gap 6 — Per-tenant fair scheduling | XL | 🟢 Strategic | FEA-004 (per-tenant quotas) |
| Gap 7 — Duration-aware shard balancing | M | 🔵 Medium | None — historical data already on results rows |
| Gap 8 — Cross-region distribution | XL | 🟢 Strategic | INF-007 (multi-region observability) |
| Gap 9 — Container-per-shard isolation | XL | 🟢 Strategic | Helm/K8s deployment story (Phase 5) |
| Gap 10 — Redis HA enforcement | S | 🔵 Medium | None — boot-time check + docs |

**Dependencies:** CAP-002 ✅ (PR #3) — all sub-items build on the shipped sharding architecture. Gaps 4 + 6 + 8 also depend on Phase 5 items (INF-007 OTel, FEA-004 quotas, Helm/K8s deployment).

**Acceptance criteria (when each sub-item ships):**
- Gap 1: CI matrix includes a `wallclock` lane that passes against `RUN_E2E_REAL_PLAYWRIGHT=true` with the `shards: 4 ≤ 50% of shards: 1` assertion green.
- Gap 2: CI matrix includes a `chaos-shard-kill` lane that kills a BullMQ shard mid-execution and asserts (a)–(d) above.
- Gap 3: `backend/tests/run-sharding-coordinator.test.js` registered in `run-tests.js`; mocks `runQueue.add` and locks down the fan-out call shape.
- Gap 5: New `/runs/:runId/replay-shard/:shardIndex` endpoint (admin-only) re-enqueues a single shard against the same parent run; UI surfaces the replay button on the RunDetail header for failed runs with `shardsCompleted < shardCount`.
- Gap 7: `partitionTestIdsForShards` accepts an optional duration map; new `partitionTestIdsByDuration(testIds, durations, shardCount)` helper performs bin-packing; fallback to even-split when durations are missing.
- Gap 10: Boot-time `/health/redis` returns `{ topology: "single-node" | "sentinel" | "cluster" }`; one-shot WARN at boot when topology is `single-node`.

**Anti-patterns to reject in review:** retroactively flipping a `failed` run to `running` on DLQ replay (terminal state must stay terminal — replay creates a fresh shard that contributes to the same run row but doesn't transition the parent status); auto-retry sharded runs on Redis flap (would compound load on a degraded cluster); cross-tenant data exposure in fair scheduling (a per-workspace queue prefix is a security boundary, not just a perf knob); skipping the boot-time WARN on single-node Redis (operators rely on this signal).

---

### AUTO-008 — Distributed runner across multiple machines

**Status:** ✅ Complete (PR #9) — see Completed Work Summary above for the full implementation details.

---

### AUTO-009 — Browser code coverage mapping 🟢 Differentiator

**Status:** ✅ Complete (PR #19) | **Effort:** L | **Source:** Competitive Gap Analysis

> **Implementation note — AUTO-009b/c (shipped in PR #19):** Source-map resolution against `project.sourcemapBaseUrl` and statement / branch / function granularity ship together. `backend/src/pipeline/sourceMapResolver.js` uses `source-map@^0.7` behind an LRU cache (10MB / 1h TTL) with the SSRF guard from `utils/ssrfGuard.js`; `backend/src/pipeline/v8ToIstanbul.js` lifts V8 ranges into Istanbul `FileCoverage` so the aggregator reports `statementPct`, `branchPct`, `functionPct` independently of `coveragePct`. `sourceMapStatus` is computed dynamically (`resolved` ≥80%, `partial` >0%, `fallback` 0%); the Dashboard CoveragePanel renders the active metric via a tab toggle and badges `fallback mode` / `partial maps` when source-map resolution is incomplete. RunDetail per-test badges read `+47L · +12B · +3F`. Granularity keys are omitted from the persisted shape when the converter never produces data (byte-identical to pre-009c rows). Pre-existing executeTest.js / dashboard LEAN_COLS / source-map cache-miss bugs flagged by the lifeguard review are fixed in the same PR.

**Problem:** There is no way to know what percentage of application code is exercised by the test suite. Playwright supports V8 code coverage via `page.coverage.startJSCoverage()`. This would answer "what percentage of my app is actually tested?"

**Fix:** Optionally enable JS coverage collection per run via `page.coverage.startJSCoverage()` / `stopJSCoverage()`. Aggregate per-URL coverage into a project-level report. Surface on the dashboard as a "Code Coverage" metric alongside pass rate.

**Files to change:**
- `backend/src/runner/executeTest.js` — start/stop coverage collection
- New `backend/src/utils/coverageAggregator.js` — merge per-test coverage data
- `frontend/src/pages/Dashboard.jsx` — code coverage metric card

**Dependencies:** None

---

### AUTO-011 — Historical trend analysis and anomaly detection 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** The dashboard shows a pass/fail trend but never detects anomalies. An autonomous system should alert: "Pass rate dropped 20% in the last 3 runs — likely regression introduced." The only statistical logic is a simple `trendDelta` at `Dashboard.jsx:122-126`.

**Fix:** Implement a lightweight anomaly detector (rolling mean + standard deviation). Alert when pass rate drops more than a configurable threshold (default 15%) versus the prior 5-run baseline. Surface as a warning banner on the dashboard and include in run completion notifications.

**Files to change:**
- New `backend/src/utils/anomalyDetector.js` — rolling baseline analysis
- `backend/src/routes/dashboard.js` — add `anomalyAlert` to dashboard response
- `frontend/src/pages/Dashboard.jsx` — anomaly alert banner

**Dependencies:** FEA-001 (notifications — to fire alerts on detected anomalies)


### AUTO-014 — Test dependency and execution ordering 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** Some tests depend on others (login must pass before checkout can run). Sentri has no concept of test dependencies — tests run in arbitrary order within the parallel pool. A failed login test produces cascading failures with no indication that the root cause is an upstream dependency.

**Fix:** Add an optional `dependsOn: [testId]` field to tests. Before execution, topologically sort the test queue to respect dependencies. If a dependency fails, mark dependent tests as `skipped` rather than running them.

**Files to change:**
- `backend/src/database/migrations/` — add `dependsOn` array to `tests`
- `backend/src/testRunner.js` — topological sort and dependency-aware skip logic
- `frontend/src/pages/TestDetail.jsx` — dependency management UI

**Dependencies:** None

---

### AUTO-018 — Plugin and extension system 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** XL | **Source:** Competitive Gap Analysis

**Problem:** There is no way to extend Sentri without forking the repository. An autonomous platform should expose hooks for custom assertions, custom healing strategies, custom report formats, and custom notification channels. All integration points are currently hardcoded.

**Fix:** Define a plugin interface: `beforeRun`, `afterStep`, `onFailure`, `onHealAttempt`, `onRunComplete`. Load plugins from a configurable `PLUGINS_DIR`. Ship three first-party plugins as reference implementations: custom Teams notification formatter, custom assertion library, custom HTML report.

**Files to change:**
- New `backend/src/plugins/pluginLoader.js` — discover and register plugins
- `backend/src/testRunner.js` — emit plugin lifecycle hooks
- `backend/src/selfHealing.js` — expose `onHealAttempt` hook
- `backend/.env.example` — document `PLUGINS_DIR`

**Dependencies:** All Phase 3 items (plugin system should wrap stable APIs, not moving targets)

---

### AUTO-021 — AI-generated test suite health insights 🔵 Medium

**Status:** 🔲 Planned | **Effort:** S | **Source:** Competitive (BearQ)

**Problem:** The dashboard shows pass rate, MTTR, and defect breakdown, but never explains *why* metrics changed. BearQ positions AI-driven analytics as a differentiator. AUTO-011 (anomaly detection) detects statistical drops but doesn't provide actionable explanations. The existing `feedbackLoop.js:buildQualityAnalytics()` produces rule-based `insights[]` strings (e.g., "N tests failed on URL assertions"), but these are static templates — not AI-generated contextual analysis.

**Fix:** After each run, feed the quality analytics summary (failure categories, flaky tests, healing events, pass rate delta) to the LLM and generate a 3–5 sentence natural-language insight: "Pass rate dropped 12% — 8 of 10 failures share the same login timeout. The auth endpoint may be degraded. Consider checking `/api/auth/login` response times." Surface as an "AI Insights" card on the dashboard and include in run completion notifications.

**Files to change:**
- `backend/src/routes/dashboard.js` — generate and cache AI insight on run completion
- `frontend/src/pages/Dashboard.jsx` — AI Insights card
- `backend/src/testRunner.js` — trigger insight generation after `applyFeedbackLoop()`

**Dependencies:** FEA-001 (notifications — to include insights in failure alerts)

---

## Phase 5 — Industry Hardening (from AUDIT.md May 2026)

*Goal: Bring Sentri to enterprise readiness (industry score 6.0/10 → 9.0/10). Items in this phase originate from `AUDIT.md` and were previously tracked in the retired `docs/AUDIT_IMPL.md`. Reconciled into ROADMAP.md ID conventions; old audit IDs preserved as cross-references.*

> **Severity reconciliation rule:** For items in this phase, AUDIT.md severity takes precedence over historical ROADMAP severity — these are compliance, security, and observability gaps that block paid-tier / enterprise adoption regardless of competitive narrative.

> **AUDIT.md findings cross-validated:** All 17 Critical/High findings in AUDIT.md were verified against the live codebase (no false positives). Findings include: SQLite default with second-class PostgreSQL adapter (A3), no OpenTelemetry / Prometheus / Sentry (B2, F7, O1), migration prefix collisions (B4), no Zod validation (B5), no TypeScript (F1), no Helm/K8s (D1), prompt-injection unmitigated (S11/S12), no AI eval harness (AI2), duplicate `activityTypes.js` (A4).

---

### AI-002 — AI provider modularization + adapter contract 🔵 Medium
**Status:** 🔲 Planned | **Effort:** M | **Source:** Maintainability + multi-agent readiness (preparatory for future `AI-004` agent config + `AI-005` multi-agent dispatch)
**Problem:** `backend/src/aiProvider.js` is a 1,545-line monolith spanning runtime key store, SSRF guard, provider detection, circuit breakers, sticky-fallback, per-call timeout composition, retry with backoff, 5 provider SDK integrations (Anthropic / OpenAI / Google Gemini / OpenRouter / OpenAI-compat / Ollama NDJSON), token telemetry (INF-007), vision-model multimodal shapes (MNT-001), and demo-key fallback. Every new provider, agent role, or call-shape change requires touching the same file — agents writing code (and human reviewers) cannot hold the whole module in working memory. The shape also blocks future multi-agent work: there is no adapter contract to extend, no place to add per-role circuit breakers, and no capability metadata (vision / JSON mode / context window / cost-per-1k) that the planner agent will need to pick a model for a given pipeline stage.
**Fix:** Decompose into 5 modules + 4 adapters under `backend/src/aiProvider/`, behind a thin `index.js` that re-exports the existing public API verbatim (byte-identical behavior — no behavior change, no new providers, no `agentRole` parameter):
```
backend/src/aiProvider/
├── index.js              — Re-exports generateText / streamText / parseJSON / etc.
├── registry.js           — Mutable state: runtime keys, sticky fallback, active provider, circuit breakers + detectProvider / resolveProvider boundary
├── retry.js              — withRetry, isRateLimitError, isTransientServerError, composeSignal
├── modelCatalog.js       — Provider metadata + model defaults + capability flags (supportsVision, supportsJsonMode, contextWindow)
└── adapters/
    ├── anthropic.js      — Messages API + streaming + token usage shape
    ├── openai.js         — OpenAI + OpenRouter + compat:<slot> (shared SDK, SSRF-guarded fetch for compat) + streaming
    ├── google.js         — Gemini generateContent + systemInstruction + usageMetadata
    └── ollama.js         — /api/generate + NDJSON fallback + ECONNREFUSED retry
```
**Adapter contract** (single shape for all four, locked in this PR so future providers + future `agentRole` work are one-file changes):
```js
// adapters/*.js each export:
async generate({ messages, maxTokens, signal, useJson, model, apiKey, baseUrl })
  → { text, usage: { input, output } }
async stream({ ... }, onToken)
  → { text, usage } | null   // null = caller falls back to generate
```
**Zero-regression guarantees:**
- Every existing export remains importable from `backend/src/aiProvider.js` (legacy file becomes a thin re-export of `./aiProvider/index.js`).
- Detection priority preserved: sticky-fallback → quick-switch override → `AI_PROVIDER` env → cloud auto-detect → compat slots → Ollama.
- SSRF guard on compat providers preserved (`createSsrfGuardedFetch` unchanged), including `ALLOW_PRIVATE_URLS` escape hatch.
- Demo key fallback (`DEMO_GOOGLE_API_KEY`) preserved.
- Circuit breaker semantics preserved (1-failure threshold, 5-min cooldown, same-tier fallback only).
- Vision support (MNT-001's `callVisionModel`) folded into adapters as a parallel `generateVision()` export.
- INF-007 token telemetry preserved bit-for-bit (per-adapter `recordAiTokens` calls, `providerMetricLabel` folding compat slots to the literal `"compat"` label).
- `loadKeysFromDatabase` / `checkOllamaConnection` / `parseJSON` / `normaliseMessages` / `composeSignal` all preserved with identical signatures.
**Files to change:**
- `backend/src/aiProvider.js` — replaced by 1-line re-export from `./aiProvider/index.js`
- `backend/src/aiProvider/{index,registry,retry,modelCatalog}.js` — new
- `backend/src/aiProvider/adapters/{anthropic,openai,google,ollama}.js` — new
- All existing callers — no changes required (public API stable)
- `backend/tests/` — existing `ai-provider*.test.js` files should pass unchanged; add `aiProvider-adapter-contract.test.js` pinning the `{ text, usage }` return shape per adapter
- `docs/changelog.md` — under `### Changed`, note the module restructure with the "no behavior change" callout
**Acceptance criteria:**
- All existing backend tests pass unchanged (no test file modifications beyond the new contract test).
- `backend/src/aiProvider.js` is ≤20 lines (pure re-export shim).
- Each new file is ≤450 lines (agent-friendly working set).
- `git log --follow` on the legacy file resolves cleanly through the restructure.
- No new dependencies. No new env vars. No new DB migrations. No new routes.
- `npm test` passes for both SQLite and Postgres (INF-008 dual-matrix).
**Dependencies:** none (FEA-003 ✅ circuit breakers, AI-001 ✅ compat providers, INF-007 ✅ telemetry, MNT-001 ✅ vision support all already in `aiProvider.js` and preserved).
**Follow-on items (deliberately deferred — separate PRs):**
- `AI-003` — Adapter capability hardening: per-call cost tracking, `modelCatalog` schema with `costPer1kInput` / `costPer1kOutput`, structured `usage` extension.
- `AI-004` — Agent role config schema (DB table, settings UI, dormant in pipeline).
- `AI-005` — Multi-agent dispatch (depends on AUTO-023 DAG runner): `options.agentRole` parameter, per-role circuit breakers via `breakerKey(provider, role)`, per-role token telemetry label, per-workspace × per-role key resolution matrix.
- `AI-006` — Per-role eval harness extension (depends on AUTO-022b).
- `AI-007` — AI cost governance: per-role / per-workspace ceilings, alerts, kill switches.
---
### AI-003 — Adapter capability hardening + cost tracking 🔵 Medium
**Status:** 🔲 Planned | **Effort:** S | **Source:** Follow-on from AI-002 · Prerequisite for AI-005 / AI-007 · Industry pattern (LangChain `BaseChatModel.cost`, LlamaIndex `LLMMetadata`)
**Problem:** After AI-002 lands, every adapter returns `{ text, usage: { input, output } }` — but `modelCatalog.js` carries only display name + default model id. The planner agent (AI-005) cannot pick a model for a stage without knowing whether it supports vision / JSON mode, what its context window is, or what it costs. The MNT-001 cost counter (`app_ai_cost_usd_total`) currently hardcodes pricing in the vision-heal adapter — every other call records token counts but no dollar cost. Without per-call cost tracking, AI-007 (cost governance) has no signal to gate on.
**Fix:** Extend `modelCatalog.js` with structured capability + pricing metadata per (provider, model) pair, and have every adapter consult the catalog to emit a normalised cost number alongside the existing `usage` block. No new external dependencies — pricing data lives in-repo as a maintainer-owned JSON table.
```js
// modelCatalog.js — extended schema (per model entry)
{
  id: "claude-sonnet-4-20250514",
  displayName: "Claude Sonnet",
  provider: "anthropic",
  capabilities: {
    supportsVision: true,
    supportsJsonMode: true,
    supportsStreaming: true,
    contextWindow: 200000,
    maxOutputTokens: 8192,
  },
  pricing: {
    inputPer1k: 0.003,    // USD
    outputPer1k: 0.015,
    asOf: "2026-04-01",   // date metadata last verified
  },
}
```
```js
// adapters/*.js — extended return shape
async generate({ ... })
  → { text, usage: { input, output, costUsd } }
async stream({ ... }, onToken)
  → { text, usage: { input, output, costUsd } } | null
```
**Zero-regression guarantees:**
- `costUsd` is additive — existing callers reading `usage.input` / `usage.output` are unaffected.
- Models missing pricing entries emit `costUsd: null` (no fake zeros) so dashboards can distinguish "no data" from "free call".
- Capability flags default to conservative values (`supportsVision: false`, `supportsJsonMode: false`) when a model isn't in the catalog — degrades gracefully for self-hosted or new compat providers.
- INF-007 `app_ai_provider_tokens_total` counter unchanged.
- MNT-001 `app_ai_cost_usd_total` counter generalised — now bumped from every adapter call (not just vision-heal), with `operation` label defaulting to `"generation"`.
**Files to change:**
- `backend/src/aiProvider/modelCatalog.js` — extend schema, add pricing JSON for the 5 cloud providers + canonical Ollama models (mistral:7b, llama3:8b, etc. → `costUsd: 0`)
- `backend/src/aiProvider/adapters/*.js` — compute `costUsd` from catalog lookup × usage tokens, attach to return shape
- `backend/src/utils/metrics.js` — generalise `app_ai_cost_usd_total` so any adapter call records cost (not just `operation: "vision_heal"`)
- `backend/tests/ai-provider-cost-tracking.test.js` (new) — pins per-provider cost computation, catalog miss → `costUsd: null`, MNT-001 vision-heal cost preserved
- `docs/guide/ai-cost-tracking.md` (new) — operator guide: catalog source-of-truth, how to update pricing, what "asOf" means
- `docs/changelog.md` — under `### Added`, note per-call cost tracking surface
**Acceptance criteria:**
- Every adapter populates `costUsd` for models in the catalog.
- `app_ai_cost_usd_total` counter increments on every generation / stream call (not just vision).
- Operators can update pricing by editing one JSON file — no code changes needed.
- Pricing-update PR template documented (when vendor publishes new prices, update entry + bump `asOf`).
- All existing tests pass unchanged.
**Dependencies:** AI-002 (adapter contract must be uniform before extending it).
**Out of scope (defer to AI-007):** cost ceilings, budget enforcement, kill switches. AI-003 only emits the signal; AI-007 acts on it.
---
### AI-004 — Agent role config schema (dormant) 🔵 Medium
**Status:** 🔲 Planned | **Effort:** M | **Source:** Multi-agent foundation · Prerequisite for AI-005 · Industry pattern (CrewAI `Agent` config, LangGraph `Node` definition, AutoGen `AgentConfig`)
**Problem:** Multi-agent dispatch (AI-005) needs a place to read "which provider, model, system prompt, and temperature should the planner agent use?" from. The pipeline today (`backend/src/pipeline/*`) hardcodes prompt templates and reads provider config from the workspace default. Without a config layer, the multi-agent dispatch PR will need to ship: DB schema + repo + settings UI + dispatch wiring all at once — too large for safe review. AI-004 ships the config plumbing in isolation, with the pipeline still calling the workspace default. The config is read but ignored — dormant until AI-005 lights it up.
**Fix:** New `agent_configs` table per workspace storing one row per role (`planner` / `codegen` / `critic` / `selfheal` / `crawl_classify` / `scenario_plan` / etc.). Settings UI under **Settings → AI → Agent Roles** lets admins define each role's `(provider, model, systemPromptOverride, temperature, maxTokens, fallbackRole)`. Backend exposes `agentConfigRepo.getByRole(workspaceId, role)` but no pipeline code reads it yet — that's AI-005's job.
```sql
-- migration NNN_agent_configs.sql
CREATE TABLE agent_configs (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  role TEXT NOT NULL,                  -- "planner" | "codegen" | "critic" | ...
  provider TEXT,                       -- null → use workspace default
  model TEXT,                          -- null → use provider default
  systemPromptOverride TEXT,           -- null → use pipeline default
  temperature REAL DEFAULT 0.2,
  maxTokens INTEGER,
  fallbackRole TEXT,                   -- name of role to delegate to on failure
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(workspaceId, role)
);
```
**Zero-regression guarantees:**
- No pipeline code reads `agentConfigRepo` in AI-004. The config is dormant.
- Existing `generateText` / `streamText` calls behave identically — `options.agentRole` parameter is **not** added in this PR.
- Workspace default provider remains the source of truth.
- Settings UI is a new admin-only tab; viewers don't see it.
**Files to change:**
- `backend/src/database/migrations/NNN_agent_configs.sql` — new table
- `backend/src/database/repositories/agentConfigRepo.js` — `getByRole`, `listByWorkspace`, `upsert`, `remove`
- `backend/src/routes/settings.js` — `GET/POST/PATCH/DELETE /api/v1/settings/agent-roles[/:role]` (admin-only, registered in `permissions.json`)
- `backend/src/middleware/permissions.json` — register the new routes
- `frontend/src/pages/Settings.jsx` — new **AI → Agent Roles** tab (table + CRUD form, role-name dropdown sourced from a hardcoded `AGENT_ROLES` constant in `frontend/src/config.js`)
- `frontend/src/api.js` — `getAgentRoles`, `createAgentRole`, `updateAgentRole`, `deleteAgentRole`
- `backend/tests/agent-config-routes.test.js` (new) — CRUD round-trip, cross-workspace ACL, role-name allowlist, fallback-role cycle detection
- `docs/api/settings.md` — document the new endpoints
- `docs/guide/agent-roles.md` (new) — operator guide explaining the 8 canonical roles (even though only the workspace default is used today)
- `docs/changelog.md` — under `### Added`, note the dormant config layer
**Acceptance criteria:**
- Admins can create / edit / delete agent role configs via UI and API.
- Cross-workspace ACL enforced (workspace A admin cannot read workspace B's agent configs).
- Role-name allowlist enforced server-side (no free-form role names — must match the canonical 8 stage names).
- `fallbackRole` references validated server-side, cycle detection prevents `planner → critic → planner`.
- Pipeline behavior unchanged — verified by the existing eval harness golden set (AUTO-022) producing identical scores.
**Dependencies:** AI-002 (registry must expose `resolveProvider({ providerId })` so AI-005 can later override workspace default).
**Out of scope:** Pipeline integration. AI-004 ships config storage + UI; AI-005 ships the dispatch wiring.
---
### AI-005 — Multi-agent dispatch (agentRole-aware generation) 🟢 Differentiator
**Status:** 🔲 Planned | **Effort:** L | **Source:** Strategic differentiator (Mabl / Testim / SmartBear ship single-LLM pipelines) · Industry pattern (CrewAI agent handoff, LangGraph stateful node dispatch, AutoGen `GroupChat`)
**Problem:** Single-agent mode uses one provider + model for all 8 pipeline stages (crawl classification → scenario planning → code generation → critic review → self-healing). This is the lowest-cost path but suboptimal: a customer might want Claude Sonnet for codegen (best at structured output), GPT-4o-mini for crawl classification (cheap + fast on simple JSON), Gemini Flash for the critic (different model gives independent second opinion), and Ollama for self-healing (low-stakes, on-prem). The agent-config table from AI-004 stores these preferences but is dormant — AI-005 lights it up.
**Fix:** Add `options.agentRole` parameter to `generateText` / `streamText` / `generateVision`. When provided, `registry.resolveProvider({ agentRole, workspaceId })` reads the agent config from `agentConfigRepo` and returns the resolved provider/model/systemPrompt/temperature, falling back to the workspace default when the role is unconfigured. Per-role circuit breakers via `breakerKey(providerId, agentRole)` so a rate-limited Claude planner does not trip Claude for the critic. Per-role token + cost telemetry via a new `agent_role` Prometheus label (bounded cardinality: 8 fixed role names).
```js
// New call signature
await generateText(prompt, {
  agentRole: "planner",           // ← NEW — looks up agent_configs row
  workspaceId: req.workspaceId,   // ← NEW — required when agentRole set
  maxTokens: 4000,
  signal: abortSignal,
});
```
**Detection priority extended:**
```
1. Sticky fallback (rate-limit recovery) — same as today
2. agentRole resolution (NEW) — if set, read agent_configs[role]
3. Quick-switch override (header dropdown) — same as today
4. AI_PROVIDER env — same as today
5. Auto-detect cloud → compat → Ollama — same as today
```
Sticky-fallback stays at the top so a rate-limited primary doesn't keep failing under an agent override. `agentRole` slots between sticky-fallback and quick-switch — agents win over operator UI selection when configured, but never bypass an active rate-limit recovery.
**Per-role circuit breakers:**
```js
// registry.js — extended breaker keying
function breakerKey(provider, agentRole) {
  return agentRole ? `${provider}::${agentRole}` : provider;
}
```
A rate-limited `anthropic::planner` does NOT trip `anthropic::critic` — each role gets its own breaker. Same-provider fallback inside a role still uses the agentRole-scoped breaker chain; cross-role fallback (planner → planner_cheap via `fallbackRole`) is a separate code path.
**Per-role telemetry:**
```
app_ai_provider_latency_seconds{provider, agent_role, outcome}
app_ai_provider_tokens_total{provider, agent_role, kind}
app_ai_provider_errors_total{provider, agent_role, reason}
app_ai_cost_usd_total{provider, agent_role, operation}
```
Cardinality bounded: 8 canonical roles × 5 provider labels × 3 outcomes = 120 series per metric (well under Prometheus's recommended 10k/metric limit).
**Pipeline integration:**
Every pipeline stage threads `agentRole` + `workspaceId` through to its `generateText` call:
| Pipeline stage | Module | agentRole |
|---|---|---|
| Crawl classification | `crawler.js` → `classifyPage` | `crawl_classify` |
| Scenario planning | `pipeline/scenarioPlanner.js` | `scenario_plan` |
| Code generation | `pipeline/testGenerator.js` | `codegen` |
| Code refinement | `pipeline/testRefiner.js` | `codegen` (same role) |
| Critic review | `pipeline/testCritic.js` | `critic` |
| Self-healing | `selfHealing.js` (DOM strategies) | `selfheal` |
| Vision healing | `selfHealing.js` stages 7+8 | `vision_heal` (MNT-001 — already labeled) |
| Conversational editor | `routes/chat.js` | `chat` |
**Zero-regression guarantees:**
- `options.agentRole` is optional. Existing call sites that don't pass it behave identically to today (workspace default).
- Agent configs left empty by the admin → pipeline falls back to workspace default → byte-identical to single-agent mode.
- The eval harness (AUTO-022) golden set runs against the workspace default and continues to produce identical scores in single-agent mode.
- Sticky-fallback still wins over agentRole resolution — a rate-limited provider doesn't keep failing under an agent override.
- Per-role circuit breakers default to provider-only keying when `agentRole` is absent (zero new state for non-multi-agent workspaces).
**Files to change:**
- `backend/src/aiProvider/registry.js` — extend `resolveProvider` to read `agentConfigRepo`, extend `breakerKey` with agentRole, plumb new label through `recordAiTokens` / `recordAiCost`
- `backend/src/aiProvider/index.js` — thread `agentRole` + `workspaceId` through `generateText` / `streamText` / `generateVision`
- `backend/src/utils/metrics.js` — add `agent_role` label to the 4 AI counters (default `"default"` when unset to keep label cardinality stable)
- `backend/src/crawler.js`, `backend/src/pipeline/{scenarioPlanner,testGenerator,testRefiner,testCritic}.js`, `backend/src/selfHealing.js`, `backend/src/routes/chat.js` — pass `agentRole` + `workspaceId` to every `generateText` call
- `frontend/src/pages/Settings.jsx` — light up the dormant AI-004 settings tab with a "Test agent" button per role that runs a sample prompt against the configured agent and shows the response (validates the config end-to-end)
- `backend/tests/agent-dispatch.test.js` (new) — pins agentRole → provider resolution, fallback to workspace default when role unconfigured, per-role circuit breaker isolation (Claude planner rate-limited, Claude critic still works), per-role telemetry labels, `fallbackRole` cycle protection, sticky-fallback still wins over agentRole
- `backend/tests/agent-dispatch-pipeline.test.js` (new) — end-to-end: configure planner=claude + codegen=openai, run a generation, assert both providers were called for their respective stages
- `docs/guide/multi-agent-pipeline.md` (new) — operator guide: when to use single vs multi-agent mode, recommended role-provider matchups, cost implications
- `docs/changelog.md` — under `### Added`, note multi-agent dispatch with the "off by default, fully backwards compatible" callout
**Acceptance criteria:**
- Configuring an agent role redirects only that stage's LLM call — verified by `agent-dispatch-pipeline.test.js`.
- Unconfigured roles fall back to workspace default — eval harness scores unchanged.
- Per-role circuit breakers isolated — rate-limiting Claude planner does not affect Claude critic.
- Per-role telemetry labels visible in `/metrics` output and queryable in Grafana.
- `fallbackRole` cycle (planner → critic → planner) rejected at config-save time with a 400 error.
- Sticky-fallback still wins — a rate-limited provider under an agent override falls back to the same-tier alternate, not back to the agent's preferred provider.
- Eval harness (AUTO-022) re-run in multi-agent mode produces ≥ baseline scores (no regression from role specialisation).
**Dependencies:** AI-002 (adapter contract), AI-003 (cost tracking — telemetry layer), AI-004 (agent config storage), AUTO-023 (DAG runner — not a hard dep, but DAG context is where the "agent handshake" payload lives long-term).
**Out of scope:**
- Per-workspace × per-agent key resolution matrix — deferred to a follow-up `AI-005b` if multi-tenant SaaS customers want their own keys per agent role (today, agent_configs.provider points to a workspace-level key).
- Agent-to-agent handoff envelope (the structured `{ fromRole, toRole, artifact, traceId }` payload) — that belongs in AUTO-023 DAG runner, not the AI provider layer.
- Streaming partial results between agents — AI-005 keeps the current "agent completes its stage, full result passes to next stage" model.
---
### AI-006 — Per-role eval harness extension 🔵 Medium
**Status:** 🔲 Planned | **Effort:** M | **Source:** Quality gate for AI-005 · Extends AUTO-022 eval harness · Industry pattern (Anthropic's eval-per-task, OpenAI Evals registry per skill)
**Problem:** AUTO-022's eval harness scores the end-to-end pipeline as one number (aggregate Levenshtein × 0.4 selectors + 0.3 actions + 0.3 assertions). When multi-agent mode lights up in AI-005, a regression in the planner won't be distinguishable from a regression in codegen — the aggregate score moves and the operator has no signal pointing at which agent role caused the drop. Without per-role goldens, swapping `codegen` from Claude Sonnet to GPT-4o-mini is unmeasurable: did codegen quality drop 5%? 15%? Unchanged? Today's harness can't say.
**Fix:** Extend the golden-set schema with per-role expected outputs and per-role scoring. A single golden case carries expected outputs for each agent role that participates in the pipeline; the harness runs the full pipeline AND records each agent's intermediate output, then scores each intermediate against its role's golden.
```json
// backend/tests/fixtures/eval-goldens/form-fill-001.json
{
  "id": "form-fill-001",
  "category": "form-fill",
  "input": {
    "url": "https://example.com/signup",
    "snapshot": { ... },
    "userIntent": "Sign up a new user"
  },
  "perRoleExpected": {
    "crawl_classify": { "type": "form", "purpose": "registration" },
    "scenario_plan": { "steps": ["fill email", "fill password", "click submit", "assert dashboard"] },
    "codegen": "test('signup flow', async ({ page }) => { ... })",
    "critic": { "issues": [], "approved": true }
  }
}
```
```bash
# CLI invocation extended
$ node backend/scripts/run-eval.mjs --per-role
# Output: per-role scores + aggregate
# planner:  0.92 (vs baseline 0.94, ΔP-0.02 — within tolerance)
# codegen:  0.87 (vs baseline 0.91, ΔP-0.04 — within tolerance)
# critic:   0.88 (vs baseline 0.90, ΔP-0.02 — within tolerance)
# aggregate: 0.89 (vs baseline 0.92, ΔP-0.03 — within tolerance)
```
**Per-role regression thresholds** (configurable in `eval-baseline.json`):
- Per-role drop > 8% → fail per role (tighter than aggregate's 10%)
- Aggregate drop > 5% → fail (unchanged from AUTO-022)
- Operators get a per-role diff that points at the regressing agent
**Zero-regression guarantees:**
- Single-agent mode (no agent_configs rows) runs the aggregate-only path — byte-identical to AUTO-022.
- Goldens missing `perRoleExpected` fall back to aggregate-only scoring (so the 5 canonical AUTO-022 goldens still work).
- The `--per-role` flag is opt-in; default CLI behavior matches AUTO-022.
**Files to change:**
- `backend/src/eval/pipelineEval.js` — extend scorer to optionally take `perRoleExpected` and return per-role scores alongside aggregate
- `backend/src/eval/pipelineAdapter.js` — capture per-stage intermediate outputs (planner output, codegen output, critic output) for scoring
- `backend/scripts/run-eval.mjs` — `--per-role` flag, per-role regression detection, per-role diff in the report
- `backend/tests/fixtures/eval-goldens/*.json` — extend the 5 canonical templates with `perRoleExpected` blocks; document the schema in `docs/guide/eval-harness-record-goldens.md`
- `backend/src/database/repositories/metricSamplesRepo.js` — accept per-role sample rows (`eval.role.planner`, `eval.role.codegen`, etc.) — schema unchanged, new sentinel metric names
- `frontend/src/pages/Dashboard.jsx` — extend the AI Eval Quality panel with a per-role breakdown tab (one sparkline per role)
- `backend/tests/eval-per-role.test.js` (new) — per-role score parity, missing perRoleExpected → aggregate-only fallback, per-role threshold enforcement, frontend panel data shape
- `docs/guide/eval-harness.md` — document the per-role surface
- `docs/changelog.md` — under `### Added`, note per-role eval scoring
**Acceptance criteria:**
- Running `node backend/scripts/run-eval.mjs --per-role` produces per-role scores in the report.
- A regression isolated to one role (e.g. swapping codegen from Claude → GPT-4o-mini) shows the drop on that role's
- - A regression isolated to one role (e.g. swapping codegen from Claude → GPT-4o-mini) shows the drop on that role's sparkline without polluting other roles' scores.
- Per-role thresholds fire independently of aggregate threshold — a 9% codegen drop with stable other roles fails the gate even when aggregate is within 5%.
- Goldens without `perRoleExpected` continue to work via aggregate-only scoring (zero churn on AUTO-022's canonical 5 templates).
- Dashboard AI Eval Quality panel renders per-role sparklines when per-role samples exist; falls back to the aggregate-only view otherwise.
- All existing AUTO-022 tests pass unchanged.
**Dependencies:** AUTO-022 (eval harness scorer + persistence), AI-005 (multi-agent dispatch — so the harness has distinct per-role outputs to score). AI-006 can ship before AI-005 with goldens covering only single-agent's aggregate, but the per-role panel stays dormant until AI-005 lights up real per-role calls.
**Out of scope:**
- Per-role baselines per provider/model pair (`claude-sonnet-codegen-baseline.json` vs `gpt-4o-mini-codegen-baseline.json`). A single baseline per role keeps the matrix manageable; operators wanting to A/B test models do that via the AI-005 settings UI and read the dashboard diff, not via parallel baseline files.
- Cross-role regression correlation (e.g. "planner drift caused codegen drift") — interesting but speculative without production data; revisit after multi-agent has been in production for a sprint.
---
### AI-007 — AI cost governance + budget enforcement 🟡 High
**Status:** 🔲 Planned | **Effort:** M | **Source:** Production hardening · SaaS unit-economics requirement · Industry pattern (OpenAI usage limits, Anthropic admin caps, Vercel AI Gateway budgets)
**Problem:** AI-003 emits per-call `costUsd`, AI-005 emits per-role costs, and the Dashboard renders a 30-day trend — but nothing stops a runaway agent loop. A misconfigured `fallbackRole` cycle, a self-healing storm against a SUT that keeps changing selectors, or a critic that keeps requesting refinements can burn through hundreds of dollars before an operator notices. Production AI platforms (Cursor, Vercel AI Gateway, OpenRouter) all ship per-workspace and per-key budgets with hard kill switches. Sentri ships nothing — the only protection today is the per-project `visionHealMaxCostUsdPerMonth` from MNT-001, which only covers vision healing.
**Fix:** Generalise MNT-001's budget counter pattern to cover every AI call. Three governance layers, each opt-in but stacked:
1. **Per-workspace daily + monthly ceilings** (`workspaces.aiCostDailyCapUsd`, `workspaces.aiCostMonthlyCapUsd`) — admin-configurable, defaults null (disabled).
2. **Per-role ceilings** (`agent_configs.costMonthlyCapUsd` extending AI-004's schema) — finer-grained, defaults null.
3. **Per-run kill switch** (`projects.aiCostPerRunCapUsd`) — caps a single run's AI spend; defaults null.
Counters live in a new `ai_cost_counters` table mirroring `vision_budget_counters`:
```sql
CREATE TABLE ai_cost_counters (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  scope TEXT NOT NULL,              -- "workspace" | "role" | "run"
  scopeKey TEXT NOT NULL,           -- role name | runId | "*" for workspace
  windowKind TEXT NOT NULL,         -- "day" | "month" | "run"
  windowStart TEXT NOT NULL,        -- UTC day boundary | UTC month boundary | run startedAt
  costUsd REAL NOT NULL DEFAULT 0,
  UNIQUE(workspaceId, scope, scopeKey, windowKind, windowStart)
);
```
Every adapter call passes through `aiBudget.record(workspaceId, role, runId, costUsd)` which atomically bumps all three scope counters in one transaction. Before each call, `aiBudget.checkAllowed(...)` reads the same counters and rejects with a structured error when any cap is hit. Self-echo across replicas (a worker on replica A racing one on replica B both incrementing the same counter) handled by the existing AES-GCM ordering pattern + row-level locks — same primitive as `vision_budget_counters` from MNT-001.
**Alert + UI surface:**
- New `app_ai_budget_exhausted_total{scope, scope_key, reason}` Prometheus counter, with corresponding `AIBudgetExhausted` alert in `monitoring/prometheus/alerts.yml`.
- New `ai.budget.exceeded` activity row (SEC-007 hash-chain compatible) — captures `{ scope, scopeKey, capUsd, actualUsd, blockedRunId }`.
- Settings → AI → **Budgets** tab (admin-only) lets operators set caps and shows current spend vs cap per scope with a colour-coded progress bar (green <50%, amber 50–80%, red >80%).
- Dashboard AI Eval Quality panel gains a "Cost vs Budget" row showing today's spend / today's cap and this month's spend / this month's cap.
- FEA-001 notification channel fires at 80% threshold (warning, once per window) and at 100% (hard block, once per window) — Teams adaptive card + email + webhook, same pattern as MNT-001's vision-budget-exhausted alert.
**Behaviour when a cap is hit:**
- **Workspace daily cap hit:** All AI calls in the workspace return a structured `AI_BUDGET_EXHAUSTED` error. Runs in flight finish their current AI call but pre-flight rejection blocks the next call. New runs can be enqueued but stall at the first AI call until the next UTC day boundary.
- **Per-role cap hit:** Only that role's calls are blocked. The pipeline either uses the role's `fallbackRole` (AI-004) if it has spare budget, or fails the stage with a clear error. Tests already generated don't retry against the rate-limited role.
- **Per-run cap hit:** That specific run's AI calls fail. The run is marked `completed_with_budget_exhausted` (new status, similar to `completed_empty`), persisted with `run.aiBudgetExhausted: { capUsd, actualUsd, blockingStage }` for forensics.
Crucially, **budget enforcement happens before the LLM call**, not after — a single 50¢ call that pushes us $0.49 over a $0.01-from-cap budget gets blocked rather than processed-and-then-flagged. This matches OpenRouter's pre-flight reject pattern; the alternative ("oh, we overspent by $0.49 but it's already done") is what makes Vercel AI Gateway's post-hoc model untenable for cost-conscious customers.
**Zero-regression guarantees:**
- All caps default to `null` (disabled). Existing deployments see no change.
- Workspaces without any caps configured don't touch `ai_cost_counters` (early return on the budget-check path).
- MNT-001's vision-healing budget remains in place and operates independently — vision is a separate counter scope (`scope: "vision_heal"`) so adding the new generic counters doesn't double-count vision spend.
- Eval harness (AUTO-022, AI-006) bypasses budgets — it runs against the `__eval_harness__` sentinel projectId which AI-007 explicitly excludes from counter increments. Otherwise running the eval harness would burn workspace budgets and skew unit-economics dashboards.
**Files to change:**
- `backend/src/database/migrations/NNN_ai_cost_governance.sql` — new `ai_cost_counters` table, `workspaces.aiCostDailyCapUsd` + `workspaces.aiCostMonthlyCapUsd`, `projects.aiCostPerRunCapUsd`, `agent_configs.costMonthlyCapUsd` (extends AI-004 schema)
- `backend/src/database/repositories/aiCostCounterRepo.js` (new) — atomic `record()` + `checkAllowed()` + `getCurrentSpend()` mirroring `visionBudgetRepo`
- `backend/src/aiProvider/registry.js` — call `aiCostCounterRepo.checkAllowed()` pre-flight, `aiCostCounterRepo.record()` post-flight (best-effort try/catch on record so a counter write failure doesn't fail the AI call, but checkAllowed failures DO fail the call)
- `backend/src/utils/metrics.js` — `app_ai_budget_exhausted_total{scope, scope_key, reason}` counter
- `monitoring/prometheus/alerts.yml` — `AIBudgetExhausted` alert at 80% threshold (warning) and 100% (page)
- `backend/src/utils/activityLogger.js` — register `ai.budget.exceeded` event type for SEC-007 hash chain
- `backend/src/pipeline/notifications.js` — fire FEA-001 webhook on 80% + 100% (once per window per scope, deduplicated via a `notified_at` column on `ai_cost_counters`)
- `backend/src/routes/settings.js` — `GET/POST /api/v1/settings/ai-budgets` (admin-only)
- `backend/src/routes/projects.js` — `aiCostPerRunCapUsd` in `SINGLE_FIELD_BYPASS` so PATCH from the project quality card skips name/url validation
- `frontend/src/pages/Settings.jsx` — new **AI → Budgets** tab with per-scope cap inputs + live spend-vs-cap progress bars
- `frontend/src/pages/Dashboard.jsx` — extend AI Eval Quality panel with "Cost vs Budget" rows
- `frontend/src/pages/RunDetail.jsx` — render `run.aiBudgetExhausted` panel when the run was budget-killed
- `backend/tests/ai-budget-governance.test.js` (new) — atomic counter bumps, pre-flight rejection on cap hit, fallback-role takes over when per-role cap exhausted, run kill-switch persists `aiBudgetExhausted` shape, eval harness bypass, vision-healing budget remains independent, notification dedup across multi-replica writes
- `backend/tests/ai-budget-routes.test.js` (new) — HTTP integration: cap CRUD, cross-workspace ACL, malformed cap rejection, GET spend-vs-cap shape
- `docs/guide/ai-cost-governance.md` (new) — operator guide: setting caps, reading spend dashboards, what happens at 80%/100%, distinguishing cap-blocked runs from rate-limit-blocked runs
- `docs/guide/env-vars.md` — document any new env vars (none expected; everything DB-driven)
- `docs/changelog.md` — under `### Added`, note budget enforcement with the "off by default" callout
- `QA.md` — § AI Cost Governance manual test plan: cap configuration, spend tracking, 80% notification, 100% block, fallback-role takeover, per-run kill switch
- `permissions.json` — register the new settings endpoints at `admin`
**Acceptance criteria:**
- Setting `aiCostDailyCapUsd: 1.00` on a workspace and running enough AI calls to exceed $1.00 in a UTC day blocks subsequent calls with a structured `AI_BUDGET_EXHAUSTED` error until UTC day boundary.
- Setting `agent_configs.costMonthlyCapUs
- - Setting `agent_configs.costMonthlyCapUsd: 5.00` on the `codegen` role blocks codegen calls past $5/month while other roles continue working.
- Setting `projects.aiCostPerRunCapUsd: 0.50` and triggering a run that would exceed $0.50 of AI spend marks the run `completed_with_budget_exhausted` and persists the forensics shape on `run.aiBudgetExhausted`.
- Pre-flight rejection — a single call that would push us over the cap is blocked, not processed-and-then-flagged.
- Reaching 80% of any cap fires a Teams/email/webhook notification once per window (verified by the dedup column).
- Reaching 100% fires a second notification + the `AIBudgetExhausted` Prometheus alert.
- `ai.budget.exceeded` activity row hash-chains correctly under SEC-007.
- Eval harness (AUTO-022, AI-006) does NOT increment workspace counters — verified by running the full eval suite against a workspace with `aiCostDailyCapUsd: 0.01` and confirming no exhaustion.
- Vision-healing budget (MNT-001) operates independently — exhausting the generic AI budget does not affect vision-heal spend, and vice versa.
- Multi-replica counter writes are atomic — `agent-budget-governance.test.js` simulates 8× concurrent `record()` calls and asserts no lost increments.
- Settings UI shows current spend vs cap per scope with colour-coded progress; admin can edit caps and see the change reflected on next AI call.
**Dependencies:** AI-003 (per-call cost tracking — without `costUsd` in the adapter return shape, AI-007 has nothing to count), AI-004 (per-role caps need `agent_configs` schema), AI-005 (per-role enforcement requires the `agentRole` parameter to actually flow to AI calls). MNT-001 vision-budget pattern is the implementation template.
**Out of scope:**
- Predictive budget exhaustion ("at current rate you'll hit cap in 4 hours") — interesting but speculative; revisit after operators have a sprint of real spend data to calibrate against.
- Per-user (not per-workspace) caps — multi-tenant SaaS will want this eventually but it's a workspace-billing-model decision, not an AI infrastructure decision; defer until a customer asks.
- Cost prediction before the call (estimate token count from prompt + multiply by pricing) — the existing post-call counter is accurate; pre-call estimation adds complexity for marginal benefit. Pre-flight rejection works fine off the running counter (call is blocked when *cumulative* spend would exceed cap, regardless of the next call's exact cost).
- Auto-scaling caps based on historical usage — operator-driven only.
- Refund of partially-consumed run cost when budget hits mid-run — the run is marked `completed_with_budget_exhausted`, the spent cost stays counted. Refunding would require transaction-rollback semantics on Anthropic / OpenAI which they don't expose.
---

### INF-008 — Promote PostgreSQL to default; add dual-DB CI matrix 🔴 Blocker

**Status:** 🔲 Planned | **Effort:** M | **Source:** AUDIT.md A3, P1, B4 (formerly `ARCH-001` in AUDIT_IMPL.md)

**Problem:** SQLite is the `.env.example` default in 2026. The PostgreSQL adapter exists (INF-001 ✅) but is second-class — AUDIT.md confirmed `_COL_MAP` drift bugs broke 5+ features in PR #11. Single-writer SQLite cannot support horizontal scale. Migration prefix collisions (`007_*` × 2, `015_*` × 2) compound the risk.

**Fix:** Rename conflicting migration files (`007_run_pages.sql` → `007b_*`, `015_web_vitals_budgets.sql` → `015b_*`); update `migrationRunner.js` to sort numerically then alpha. Change `.env.example` and `docker-compose.yml` default to `DATABASE_URL=postgresql://...` with a bundled Postgres service. Add CI matrix job `db: [sqlite, postgres]` in `ci.yml` running the full `npm test` suite under both. Add a migration linter (`backend/scripts/lint-migrations.mjs`) that fails on duplicate numeric prefixes (overlaps with MNT-014 — coordinate). Add a nightly `pg_dump` CI job as DR baseline.

**Files to change:**
- Rename two migration files; `backend/src/database/migrationRunner.js` sort fix
- New `backend/scripts/lint-migrations.mjs`
- `backend/.env.example`, `docker-compose.yml`, `.github/workflows/ci.yml`
- New `.github/workflows/nightly-backup.yml`

**Acceptance criteria:**
- `npm test` passes with both `DATABASE_URL=postgres://...` and `DATABASE_URL=file:./...` in CI.
- Migration linter fails the build on a prefix collision.
- `docker compose up` works out-of-the-box with Postgres with zero extra steps.
- No existing migration files removed or reordered — only the two colliding files renamed.

**Dependencies:** None. **Recommended to land in same sprint as INF-007.** **Bundles naturally with:** MNT-014 (migration linter scope overlap).

---

### SEC-006 — Prompt-injection / PII firewall between crawler and LLM

**Status:** ✅ Complete (PR #11) — see Completed Work Summary above for the full implementation details. Shipped scope: PII-only redaction (emails, phones, SSNs, Luhn-checked cards, JWTs, Bearer/Basic headers, auth query-string params) wired in `backend/src/crawler.js` between crawl output and AI generation, with per-project `strictPiiFirewall` + `piiAllowlist` controls (default-on via migration `030_projects_pii_firewall.sql`) and a `pipeline.pii_redacted` structured audit log. The prompt-injection half of the original AUDIT.md S11 finding (hidden-text instruction stripping, `<script>` / `<style>` removal, prompt-preamble regex filtering) was **deferred** as a follow-up — captured separately as `SEC-006b` in the queue when scheduling permits.

---

### AUTO-022 — AI evaluation harness with golden-set regression

**Status:** ✅ Plumbing complete (PR #17) — see Completed Work Summary below for the full implementation details. The scorer (`backend/src/eval/pipelineEval.js`), record/replay adapters (`pipelineAdapter.js`), `metric_samples` persistence (`evalPersistence.js`), Dashboard `EvalPanel` + drill-down route, path-filtered `eval.yml` CI workflow, 5 canonical golden templates, and 32 unit + integration tests all shipped. The regression gate itself is **dormant** until a maintainer runs `EVAL_RECORD=1 ... --write-baseline` against the live LLM and commits the resulting `.cache/*.txt` recordings + first real `eval-baseline.json` — tracked separately as `AUTO-022b` below per the AGENT.md issue-handling rule.

---

### AUTO-022b — Eval harness: record real LLM cache + first real baseline 🔴 Blocker

**Status:** 🔄 Current sprint | **Effort:** M (4–8 hours of focused maintainer work with an LLM API key) | **Dependencies:** AUTO-022 ✅ (PR #17 plumbing) | **Source:** PR #17 follow-up — `docs/guide/eval-harness-record-goldens.md`

**Problem:** AUTO-022 (PR #17) shipped the eval harness wiring end-to-end — scorer, adapters, CI workflow, Dashboard panel, persistence layer — but the regression gate it's supposed to enforce is currently inert. Two gaps keep it dormant:

1. The 50 golden cases under `backend/tests/fixtures/eval-goldens/case-*.json` are synthetic 3-element HTML fragments, not real DOM captures from `tests/e2e/specs/`. The production pipeline (`generateAllTests`) is tuned for real-app DOM with hundreds of elements / ARIA / state machines; synthetic snippets produce either trivial output that scores high by accident or empty output that scores zero — neither measures real pipeline quality.
2. There are no `.cache/*.txt` recordings committed. The `.gitignore` is set up to allow `*.txt` entries in `backend/tests/fixtures/eval-goldens/.cache/`, but the directory is currently empty. The cold-start guard in `backend/scripts/run-eval.mjs:71-91` short-circuits CI to exit 0 in this state so the merge wasn't blocked — but until real recordings exist, every regression that would have been caught silently ships.
3. `eval-baseline.json` is a placeholder (every score is `1.0`). A real baseline gets generated by `--write-baseline` against the live LLM after real recordings exist.

**Fix:** A dedicated maintainer session with an LLM API key (Anthropic / OpenAI / Google / Ollama) walks the documented procedure in `docs/guide/eval-harness-record-goldens.md`:

1. Capture real DOM snapshots from the running Sentri app (or any candidate target) via a one-off Playwright `page.content()` script. Replace the synthetic `snapshot` field in each `case-NNN.json`; reference snapshots > 5 KB via `@file:snapshots/<id>.html`. Update each case's `description` from "Skeleton golden — Replace ..." to a real flow name.
2. Run `EVAL_RECORD=1 node backend/scripts/run-eval.mjs` to populate `.cache/<id>.<hash>.txt` against the live pipeline.
3. Iterate per-case until each case's score ≥ 0.7 (or consciously delete cases that can't reach 0.4 — 40 good cases beats 50 mediocre ones). Adjust `expected` to mirror the pipeline's actual phrasing, NOT idealised target code — the harness measures regression, not aspiration.
4. Run `EVAL_RECORD=1 node backend/scripts/run-eval.mjs --write-baseline` to regenerate `eval-baseline.json` with real `aggregate` / `byDimension` / `byCategory` / `perCase` keys.
5. Force-add the cache files: `git add -f backend/tests/fixtures/eval-goldens/.cache/*.txt`. Commit + push.
6. Verify CI: the `Eval — Golden-set regression check` job runs in replay mode, scores against the new baseline, exits 0 on the recording commit (aggregate equals baseline) and exits non-zero on any subsequent prompt / model / pipeline change that crosses the 5% aggregate or 10% per-dimension threshold.

**Files to change:**
- `backend/tests/fixtures/eval-goldens/case-*.json` — replace synthetic `snapshot` + `description` fields with real captures
- `backend/tests/fixtures/eval-goldens/snapshots/` (new directory) — large DOM captures referenced via `@file:` URIs
- `backend/tests/fixtures/eval-goldens/.cache/*.txt` — force-add recorded LLM responses (one per case, named `<id>.<32-char-hash>.txt`)
- `eval-baseline.json` — regenerate via `--write-baseline` after recordings exist; gains real `perCase` + `byDimension` + `byCategory` keys
- `docs/guide/eval-harness.md` — add a "What constitutes a real golden vs a skeleton" section per the maintainer brief (case must have non-skeleton `description`, snapshot from `page.content()`, matching cache entry, baseline `perCase` score ≥ 0.4)

**Acceptance criteria:**
- `node backend/scripts/run-eval.mjs` exits 0 on the current tree with a non-zero `aggregate` line (replay against committed `.cache/` rather than cold-start bypass).
- Modifying a prompt template file to deliberately lower selector quality on ≥ 3 cases re-records the cache for those cases, and the eval-workflow CI job exits non-zero with the named affected cases listed in stderr.
- Dashboard `EvalPanel` renders a non-placeholder sparkline after `--persist` writes the first 200 `metric_samples` rows under the `__eval_harness__` sentinel projectId.
- `eval-baseline.json` has a `perCase` block with one entry per committed case, each with a numeric score in `[0, 1]` (not all `1.0`).
- The cold-start guard at `backend/scripts/run-eval.mjs:71-91` is no longer triggered (cache directory non-empty).

**PR checklist (AUTO-022b):**
- [ ] PR title `chore(eval): AUTO-022b — record real LLM cache + first real baseline`
- [ ] 50 case JSON files updated with real DOM captures (or consciously trimmed to N < 50 with the rest deleted, not skeleton'd)
- [ ] `.cache/*.txt` recordings force-committed (`git add -f`), one per remaining case
- [ ] `eval-baseline.json` regenerated with real `perCase` + `byDimension` + `byCategory` + numeric `aggregate` ≠ 1.0
- [ ] CI `Eval — Golden-set regression check` exits 0 on the recording commit (verify the artifact `eval-report.json` has `bootstrap: false` and a non-null `aggregate`)
- [ ] `docs/guide/eval-harness.md` gains the "What constitutes a real golden" section
- [ ] `docs/changelog.md` updated under `## [Unreleased]` § Added (mark AUTO-022 fully active, not just plumbing)
- [ ] ROADMAP.md `### AUTO-022b` section flipped to `**Status:** ✅ Complete (PR #N)` and Completed Work Summary row added
- [ ] NEXT.md current-sprint slot rotated to the next queue item

**Why this is a separate PR:** Recording requires an LLM API key and 4–8 hours of focused per-case iteration. Bundling it into PR #17 (the plumbing PR) would have meant the plumbing couldn't ship until a maintainer with API access had time to do the recording — and recording itself can't happen until the plumbing is in `develop`. The cold-start guard exists exactly to break this chicken-and-egg deadlock: ship the harness inert, light it up later.

**Original AUDIT.md source:** AUDIT.md AI2, AI3, AI6 (formerly `AI-EVAL-001` in AUDIT_IMPL.md; supersedes the looser `MNT-003` prompt A/B testing item).

**Problem:** Prompt changes ship on intuition. There is no golden-set regression test, no LangSmith/Phoenix integration, and no automatic quality rollback. Silent regressions in AI-generated test quality are undetectable. Rated Critical for the "Autonomous QA" brand promise.

**Fix:** 50-case golden-set fixture (`backend/tests/fixtures/eval-golden-set.json`) with `{ url, pageSnapshot, expectedActions[], expectedAssertions[], minQualityScore }`. New `backend/src/eval/pipelineEval.js` runs the full 8-stage pipeline against each case, scores selectors/actions/assertions via Levenshtein similarity, emits pass/fail per case. CI job `eval.yml` runs on every PR touching `pipeline/`, `aiProvider.js`, or any prompt file — fails the build if >5% of cases regress. Persist eval results as `metric_samples` rows (`ai.eval.score`, labels `caseId`, `promptVersion`) so trend charts surface. Adds `promptVersion` to every pipeline run log so production regressions correlate to prompt changes.

**Files to change:**
- New `backend/src/eval/pipelineEval.js`, `backend/src/eval/scorers.js`
- New `backend/tests/fixtures/eval-golden-set.json` (50 cases)
- New `.github/workflows/eval.yml` (path-filtered)
- `backend/src/pipeline/pipelineOrchestrator.js` — emit `promptVersion` + `metric_samples`
- `backend/src/database/repositories/metricSampleRepo.js` — `bulkInsert()`
- `backend/.env.example` — `EVAL_PROVIDER` (defaults to cheapest configured model)

**Acceptance criteria:**
- `npm run eval` exits 0 with ≥95% of golden cases passing on the current codebase.
- CI `eval.yml` is green on main.
- Introducing a deliberately broken prompt into `pipeline/testGenerator.js` causes >5% regression and fails the build.
- Eval results appear in `metric_samples` and are queryable via `GET /projects/:id/metrics`.

**Dependencies:** INF-007 (`metric_samples` infrastructure / OTel context). Golden set can be authored in parallel with INF-007. **Supersedes:** `MNT-003` (prompt A/B testing) — see MNT-003 note.

---

### INF-009 — Helm chart + Kubernetes readiness/liveness + DR playbook 🟡 High

**Status:** 🔲 Planned | **Effort:** L | **Source:** AUDIT.md D1, D2, D3 (formerly `INFRA-001` in AUDIT_IMPL.md). **Supersedes the K8s/worker-split portion of `AUTO-008`** (distributed runner) — once shipped, AUTO-008 narrows to "horizontal scaling beyond a single worker" only.

**Problem:** No Helm chart, no K8s manifests, no blue-green deploy story, no DR/backup playbook. A single-disk failure means total customer data loss. docker-compose-only deployment is an enterprise blocker. AUDIT.md A1 (monolithic backend with in-process workers) also addressed here via the separate worker Deployment.

**Fix:** Create `helm/sentri/` chart with separate `backend` Deployment, `worker` Deployment (resolves A1), `postgresql` StatefulSet, `redis` Deployment, ingress, configmap, secret. Add `readinessProbe` + `livenessProbe` to backend Deployment using the existing `GET /api/v1/health` endpoint. Worker runs `node backend/src/workers/runWorker.js` as a standalone entrypoint. DR playbook: nightly `pg_dump` to S3 → verify → restore procedure with step-by-step RTO/RPO targets.

**Files to change:**
- New `helm/sentri/` (Chart.yaml, values.yaml, templates for api / worker / postgres / redis / ingress / configmap / secret)
- New `backend/src/workers/worker-entrypoint.js` — standalone bootstrap (no Express)
- `backend/Dockerfile` — `CMD_MODE` env var (`api` default, `worker`)
- New `docs/operations/dr-playbook.md`
- `.github/workflows/nightly-backup.yml` — extends INF-008's nightly job with S3 upload + row-count verify (gated on `PG_BACKUP_S3_BUCKET`)

**Acceptance criteria:**
- `helm install sentri ./helm/sentri` deploys a working stack on a local kind cluster.
- Readiness probe fails (pod not ready) when `DATABASE_URL` is unreachable.
- Worker runs as a separate pod; killing the worker pod does not kill the API pod.
- DR playbook doc covers backup schedule, restore steps, expected RTO (<4h), RPO (<24h).

**Dependencies:** INF-008 (Postgres must be default before K8s deployment makes sense). **Narrows scope of:** AUTO-008.

---

### FEA-004 — Per-tenant resource quotas + token-cost dashboard 🟢 Strategic

**Status:** 🔲 Planned | **Effort:** M | **Source:** AUDIT.md AI8, B8 (formerly `ENT-003` in AUDIT_IMPL.md)

**Problem:** No per-project AI token budget caps. No cost dashboard. A single runaway project can exhaust the platform's entire LLM budget. Enterprise customers expect per-tenant quota enforcement and ROI dashboards.

**Fix:** Add `tokenBudgetMonthly` and `tokenBudgetUsed` (reset monthly via cron) to the `workspaces` table. Before enqueuing an AI call in `aiProvider.js`, check remaining budget. Reject with 429 if exceeded; emit `ai.budget.exceeded` activity event. Add `GET /api/v1/workspaces/:id/usage` endpoint returning token spend by project / provider / model over a date range — backed by `metric_samples` from INF-007. New Usage dashboard page (`UsageDashboard.jsx`) with total token spend, per-provider cost estimate (configurable price table), spend-by-project chart, budget utilisation gauge.

**Files to change:**
- New migration — `tokenBudgetMonthly`, `tokenBudgetUsed` on `workspaces`
- `backend/src/aiProvider.js` — pre-call budget check; post-call `metric_samples` insert
- `backend/src/routes/workspaces.js` — `GET /usage` + `PATCH /budget`
- New `frontend/src/pages/UsageDashboard.jsx`
- `frontend/src/api.js` — `getWorkspaceUsage()`, `updateWorkspaceBudget()`

**Acceptance criteria:**
- A workspace with `tokenBudgetMonthly: 10000` rejects AI calls after 10,000 tokens consumed in the calendar month with a clear user-facing error.
- Usage dashboard shows token spend trend for the last 30 days broken down by project.
- Budget utilisation gauge turns amber at 80%, red at 95%.

**Dependencies:** INF-007 (`metric_samples` infrastructure).

---

### INF-010 — TypeScript/JavaScript public SDK + CLI 🟢 Strategic

**Status:** 🔲 Planned | **Effort:** M | **Source:** AUDIT.md A6 (formerly `ENT-004` in AUDIT_IMPL.md)

**Problem:** Every CI consumer hand-rolls HTTP against the Sentri API. Competitors (Cypress Cloud, BrowserStack) ship official SDKs. INF-004 ✅ (OpenAPI spec) is already shipped — the SDK is a near-free derivation.

**Fix:** Add `packages/sdk-js/` to npm workspaces. Use `openapi-typescript-codegen` to generate a typed client from `backend/src/openapi.js` at build time. Publish as `@sentri/sdk` on npm. Ship `sentri-cli` binary (`packages/cli/`) wrapping the SDK: `sentri run <projectId>`, `sentri status <runId>`, `sentri export <testId>`. Update `docs/guide/ci-cd-triggers.md` with SDK-first examples.

**Files to change:**
- New `packages/sdk-js/` — generated + hand-authored overrides
- New `packages/cli/` — commander-based binary
- `package.json` (root) — add both packages to `workspaces`
- `.github/workflows/release.yml` — SDK + CLI publish steps

**Acceptance criteria:**
- `npm install @sentri/sdk` then `new SentriClient({ baseUrl, apiKey }).runs.trigger(projectId)` works against a local instance.
- All 50 public API endpoints have typed request/response interfaces.
- `sentri run <projectId>` exits 0 on success, 1 on quality gate failure, 2 on run error.

**Dependencies:** INF-004 ✅ (OpenAPI spec), MNT-012 (shared Zod schemas become SDK validation types).

---

### AUTO-023 — LangGraph-style DAG pipeline runner 🟢 Strategic

**Status:** 🔲 Planned | **Effort:** XL | **Source:** AUDIT.md AI1, A7 (formerly `AGENT-001` in AUDIT_IMPL.md)

**Problem:** `pipelineOrchestrator.js` directly imports each stage in a hardcoded sequence. No DAG runner, no retryable stage boundaries, no per-stage idempotency keys, no checkpoint/resume. Rated Critical for the "Autonomous QA" brand promise.

**Fix:** Introduce `backend/src/pipeline/dagRunner.js`: a lightweight DAG executor that takes a typed node graph, runs nodes in dependency order, handles per-node retry with exponential backoff, persists node state to Redis (checkpoint), and supports human-in-the-loop pause nodes. Refactor `pipelineOrchestrator.js` to define the pipeline as a declarative DAG spec. Each node has `run(input, context)`, `retry: { attempts, backoff }`, `idempotencyKey(input)`. The `approve` node is a pause node: emits an SSE event, suspends, waits for `POST /tests/:id/review`, resumes.

**Files to change:**
- New `backend/src/pipeline/dagRunner.js`, `backend/src/pipeline/pipelineDag.js`
- `backend/src/pipeline/pipelineOrchestrator.js` — refactor to delegate to `dagRunner`
- `backend/src/utils/redisClient.js` — `setCheckpoint`/`getCheckpoint`
- New `backend/tests/dag-runner.test.js`

**Acceptance criteria:**
- A simulated single-stage failure triggers retry up to configured `attempts` with exponential backoff.
- Killing the process mid-pipeline and restarting resumes from the last completed node.
- A pause node (approval step) suspends + resumes correctly.
- Existing E2E pipeline tests pass unchanged (drop-in replacement).

**Dependencies:** INF-007 (OTel spans per DAG node), MNT-015 (browser pool used by executor node).

---

### AUTO-024 — Critic agent: validate generator output against crawl graph 🟢 Strategic

**Status:** 🔲 Planned | **Effort:** L | **Source:** AUDIT.md AI4, AI7 (formerly `AGENT-002` in AUDIT_IMPL.md)

**Problem:** The generator produces selectors and URLs that may not exist in the crawl graph. No validation occurs between generation and human review. Users waste time reviewing syntactically valid but semantically broken tests.

**Fix:** Add a `critic` DAG node (after `generate`, before `approve`) that checks every `page.goto(url)` URL against the crawl graph, every `locator(selector)` against the last crawl snapshot DOM, scores each test with a `criticScore` (0–100) separate from `qualityScore`, and flags tests with `criticScore < 60` as `needs_review`.

**Files to change:**
- New `backend/src/pipeline/criticAgent.js`
- `backend/src/pipeline/pipelineDag.js` — add `critic` node
- New migration — `criticScore`, `criticIssues` on `tests`
- `frontend/src/pages/TestDetail.jsx` — render `criticIssues` warning panel

**Acceptance criteria:**
- A test containing `page.goto('https://example.com/nonexistent')` receives `criticScore < 60`.
- A test with all URLs/selectors validated against the crawl graph receives `criticScore ≥ 80`.
- Auto-approval is blocked when `criticScore < 60` regardless of `qualityScore`.

**Dependencies:** AUTO-023 (Critic runs as a DAG node), AUTO-002 ✅ (crawl graph available).

---

### AUTO-025 — Healing telemetry feedback loop to generator 🟢 Strategic

**Status:** 🔲 Planned | **Effort:** M | **Source:** AUDIT.md AI5 (formerly `AGENT-003` in AUDIT_IMPL.md). **Complements MNT-002** — MNT-002 reorders the healing waterfall; AUTO-025 feeds healed-selector patterns back into generation prompts.

**Problem:** Self-healing history is a goldmine of "what selectors break on this project" but is never fed back to the generator. Each new generation starts from zero context, producing the same fragile selectors that will heal again.

**Fix:** Before the `generate` DAG node runs, query the top-10 most-healed selectors for the project. Inject as negative-example block in the generator prompt. Track `promptEnrichmentApplied: true` on the run log. New `GET /api/v1/projects/:id/healing-insights` returning top-N healed patterns.

**Files to change:**
- `backend/src/pipeline/testGenerator.js` — `healingContext` injection
- New `backend/src/utils/healingInsights.js`
- `backend/src/database/repositories/healingRepo.js` — `getTopHealedSelectors`
- `backend/src/routes/projects.js` — `GET /:id/healing-insights`
- `frontend/src/pages/ProjectDetail.jsx` — Healing Insights panel

**Acceptance criteria:**
- After 5+ healing events on a project, the next generation prompt contains a negative-example block with the healed selectors.
- `GET /projects/:id/healing-insights` returns a ranked list of top-10 healed patterns with counts.

**Dependencies:** AUTO-023 (generator is a DAG node with access to context bag).

---

### FEA-005 — Collaboration: comments, mentions, assignments on tests and runs 🟢 Strategic

**Status:** 🔲 Planned | **Effort:** L | **Source:** AUDIT.md Product Strategy §12 (formerly `UX-003` in AUDIT_IMPL.md)

**Problem:** Zero collaboration features. Users cannot comment on a test, mention a teammate, or assign a failing test to a developer. Linear/GitHub-grade collaboration is table stakes for team adoption.

**Fix:** Add `comments` table (`id`, `workspaceId`, `entityType` `test`|`run`, `entityId`, `authorId`, `body` Markdown, `mentions[]` userIds, `createdAt`). `GET`/`POST`/`DELETE /api/v1/:entityType/:entityId/comments`. `@mention` autocomplete in composer. Emit notifications (reuse FEA-001) on mention. Render threads on TestDetail and RunDetail.

**Files to change:**
- New migration — `comments` table
- New `backend/src/database/repositories/commentRepo.js`, `backend/src/routes/comments.js`
- `backend/src/middleware/permissions.json` — comment endpoints (all authenticated members)
- New `frontend/src/components/shared/CommentThread.jsx`
- `frontend/src/pages/TestDetail.jsx` + `RunDetail.jsx` — embed `<CommentThread />`
- `frontend/src/api.js` — `getComments`, `postComment`, `deleteComment`

**Acceptance criteria:**
- A user can post, edit, and delete comments on a test and a run.
- `@username` in a comment body triggers a notification to the mentioned user.
- Comment thread renders in real-time via SSE.

**Dependencies:** FEA-001 ✅ (notifications), ACL-001 ✅ (workspace members for mention autocomplete).

---

### FEA-006 — Template gallery + sample project first-run experience 🟢 Strategic

**Status:** 🔲 Planned | **Effort:** M | **Source:** AUDIT.md U2, Product Strategy §12 (formerly `UX-004` in AUDIT_IMPL.md)

**Problem:** No onboarding, no template gallery, high first-run friction. A new user arriving at an empty project has no path to "wow" without configuring a live URL.

**Fix:** Ship 5 sample project templates (e-commerce checkout, login flow, dashboard CRUD, form validation, API mock) as seed data. "Start from template" button on the empty project state. Guided first-run tour (3 steps: Configure provider → Crawl → Review first test) via `Shepherd.js`. Public `GET /api/v1/templates` endpoint.

**Files to change:**
- New `backend/src/database/seed/templates.json`
- New `backend/src/routes/templates.js` — `GET /templates`, `POST /projects/from-template`
- `frontend/src/pages/ProjectsPage.jsx` — "Start from template" CTA on empty state
- New `frontend/src/components/onboarding/FirstRunTour.jsx`
- `frontend/package.json` — add `shepherd.js`

**Acceptance criteria:**
- A new user can create a project from the "e-commerce checkout" template and have 5 sample tests ready within 30 seconds (no crawl required).
- The first-run tour fires once per account, is dismissible, persists across sessions.
- `GET /api/v1/templates` returns the 5 templates with metadata (name, description, testCount, previewUrl).

**Dependencies:** FEA-004 (template instantiation respects workspace token budget).

---

## Ongoing Maintenance & Platform Health

*These items are not phase-bounded. Address them incrementally alongside feature work, prioritising MNT-006 (object storage) before any cloud deployment.*

---

### MNT-001 — Vision-based locator healing 🟢 Differentiator

**Status:** ✅ Complete (PR #17) — see Completed Work Summary above for the full implementation details. Shipped end-to-end: host-side stages 7 (pixelmatch CV) + 8 (LLM vision) with per-project budget circuit-breaker, SEC-007-compatible audit trail, `STRATEGY_VERSION` 3→4, baseline crop capture on green runs, coordinate re-action on heal, new Vision Healing tab on Quality card + Vision-based healing panel on Healing dashboard.

<!-- Legacy section preserved below for archival reference. -->

**Legacy Status:** 🔲 Planned | **Effort:** XL | **Source:** Competitive

**Problem:** The self-healing waterfall uses DOM selectors exclusively (ARIA roles, text content, CSS fallbacks). When the DOM structure changes drastically — a major redesign or component library migration — all strategies can fail simultaneously. Mabl uses screenshot diff + CV-based element finding to heal across structural changes.

**Fix:** Add a vision-based healing strategy as the final fallback in the waterfall. Capture a screenshot of the failing step's expected element area from the baseline, use image similarity (`pixelmatch`) to locate the nearest visual match in the current DOM, and derive a fresh selector from the matched element.

**Files to change:**
- `backend/src/selfHealing.js` — add vision strategy as waterfall stage 7
- `backend/src/runner/executeTest.js` — pass baseline screenshot to healing context

**See also:** MNT-002 — both items extend `selfHealing.js`. MNT-001 handles visual/structural DOM changes (new strategy); MNT-002 handles statistical strategy ordering (ML classifier). They are complementary but fully independent implementations. Coordinate branch timing to avoid merge conflicts.

---

### MNT-002 — Self-healing ML classifier 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** XL | **Source:** Audit

**Problem:** The healing waterfall is deterministic and rule-based. `STRATEGY_VERSION` invalidates all cached hints when strategies change. Healing history data in `healing_history` is collected but never fed back to improve the system. A lightweight classifier trained on healing events would predict the best strategy per element type, reducing waterfall traversal depth.

**Fix:** Train an offline classifier on `healing_history` events using feature vectors (element type, page URL pattern, last successful strategy, DOM depth). Export the model as a JSON lookup table. Load it at startup. Use it to reorder the waterfall per element rather than always starting at strategy 1.

**Files to change:**
- `backend/src/selfHealing.js` — accept strategy ordering hint from classifier
- New `backend/src/ml/healingClassifier.js` — model loader and inference
- New `scripts/train-healing-model.js` — offline training script from `healing_history` data

**See also:** MNT-001 — both items extend `selfHealing.js`. MNT-002 handles statistical strategy selection; MNT-001 handles visual DOM changes. They are complementary and can be developed independently on separate branches.

---

### MNT-004 — Test data management (fixtures and factories) 🔵 Medium

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive

**Problem:** Tests that require specific data states (a logged-in user with specific records, a product at a specific price) have no supported setup/teardown mechanism. This limits the depth of user journeys Sentri can test autonomously.

**Fix:** Add a `fixtures` block to test config: a list of API calls or SQL statements to execute before the test and teardown statements to run after. Expose `beforeTest` / `afterTest` hooks in `executeTest.js`.

**Files to change:**
- New `backend/src/utils/testDataFactory.js` — fixture execution engine
- `backend/src/runner/executeTest.js` — call `beforeTest`/`afterTest` hooks
- `backend/src/pipeline/stateExplorer.js` — declare required state for generated tests

---

### MNT-005 — BDD / Gherkin export format 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive

**Problem:** Enterprise teams using behaviour-driven development (Cucumber, SpecFlow) cannot use Sentri's output directly. SmartBear's BDD format is widely adopted in enterprise QA. Adding a Gherkin export alongside the existing Zephyr/TestRail CSV exports would broaden enterprise appeal.

**Fix:** Add `buildGherkinFeature(test)` to `exportFormats.js`. Map test steps to `Given` / `When` / `Then` blocks using the step intent classifier data already produced by the pipeline. Add a "Export as Gherkin" option to the Tests page export menu.

**Files to change:**
- `backend/src/utils/exportFormats.js` — add Gherkin builder
- `backend/src/routes/tests.js` — `GET /projects/:id/export/gherkin`
- `frontend/src/pages/Tests.jsx` — Gherkin export option

**See also:** DIF-006 (Playwright export) — both extend `exportFormats.js`. Develop in the same or consecutive sprints to share export ZIP packaging scaffolding.

---

### MNT-012 — `packages/shared/` workspace: TS bootstrap + Zod schemas 🟡 High

**Status:** 🔲 Planned | **Effort:** M | **Source:** AUDIT.md A4, F1, B5 (formerly `DEBT-001` in AUDIT_IMPL.md)

**Problem:** `activityTypes.js` lives in both `backend/src/constants/` and `frontend/src/constants/` — drift is inevitable. Root `package.json` declares npm workspaces but has no `packages/shared/` member. The entire codebase is plain JavaScript. The `isThresholdOnly` PATCH bypass at `routes/projects.js:153` is a real validator hole.

**Fix:** Create `packages/shared/` as a third npm workspace member. Migrate `activityTypes.js` into `packages/shared/src/activityTypes.ts` (first TS file in the repo). Migrate error-code constants. Add Zod schemas for the five highest-risk request payloads (`createProject`, `updateProject`, `createRun`, `triggerRun`, `updateReviewStatus`). Replace `isThresholdOnly` bypass with `updateProjectSchema.parse(req.body)`.

**Files to change:**
- New `packages/shared/` tree (package.json, tsconfig.json, src/activityTypes.ts, errorCodes.ts, schemas/index.ts)
- `package.json` (root) — add `packages/shared` to `workspaces`
- `backend/src/constants/activityTypes.js`, `frontend/src/constants/activityTypes.js` — re-export shims
- `backend/src/routes/{projects,runs,trigger,tests}.js` — replace ad-hoc validators with Zod schemas
- `backend/package.json` — add `zod`

**Acceptance criteria:**
- `packages/shared` builds with zero TS errors (`tsc --noEmit`).
- `activityTypes.js` exists in only one canonical location.
- The five Zod schemas reject invalid payloads with structured 400 errors.
- `isThresholdOnly` bypass removed; integration test confirms `PATCH /projects/:id` with unexpected keys returns 400.

**Dependencies:** INF-008. **Unblocks:** INF-010, MNT-017.

---

### MNT-013 — Request-ID propagation + structured log correlation 🟡 High

**Status:** 🔲 Planned | **Effort:** S | **Source:** AUDIT.md B1 (formerly `DEBT-002` in AUDIT_IMPL.md)

**Problem:** `formatLogLine()` produces structured logs with no `requestId`. A 10-minute debug session on a multi-tenant failure requires manually grep-ing `runId` across interleaved log lines from concurrent requests.

**Fix:** Generate a `requestId` (UUID v4) per request and store in `AsyncLocalStorage`. Update `formatLogLine()`, `logError()`, `logWarn()` to read `requestId` from the store automatically — no call-site changes needed. Expose in `X-Request-Id` response header. For BullMQ jobs, seed `requestId` from the job's `jobId`.

**Files to change:**
- New `backend/src/utils/requestContext.js` — `AsyncLocalStorage` singleton
- `backend/src/middleware/appSetup.js` — middleware before routes
- `backend/src/utils/logFormatter.js` — read `requestId` from context
- `backend/src/workers/runWorker.js` — seed context with `job.id`

**Acceptance criteria:**
- Every log line during a request carries `requestId` matching `X-Request-Id`.
- Two concurrent run logs are separable by their distinct `requestId` values.

**Dependencies:** INF-007 (OTel bootstrap shares the same `AsyncLocalStorage` store). **Bundle naturally with INF-007.**

---

### MNT-014 — Migration linter + down-migration stubs 🔵 Medium

**Status:** 🔲 Planned | **Effort:** XS | **Source:** AUDIT.md B4 (formerly `DEBT-003` in AUDIT_IMPL.md)

**Problem:** Duplicate numeric prefixes (`007_*` × 2, `015_*` × 2) confirmed. No migration linter prevents recurrence. No down migrations exist so rollbacks require manual SQL.

**Fix:** Ship `backend/scripts/lint-migrations.mjs` (overlaps with INF-008 — coordinate). Add `MIGRATION_TEMPLATE.sql` with required `-- ROLLBACK: <SQL or "manual">` header. Lint for header presence. Add minimal rollback stubs to the 5 most recent migrations.

**Files to change:**
- `backend/scripts/lint-migrations.mjs` — created in INF-008; this item adds rollback-header check
- New `backend/src/database/MIGRATION_TEMPLATE.sql`
- `backend/src/database/migrations/016_metric_samples.sql` through `020_run_changed_pages.sql` — rollback comment

**Acceptance criteria:**
- `npm run lint:migrations` passes on main.
- A migration without a rollback comment header fails the linter.
- A file with a duplicate numeric prefix fails the linter.

**Dependencies:** INF-008. **Recommended bundle:** ship together with INF-008.

---

### MNT-008 — ESLint + Prettier enforcement in CI 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Quality Review (PRD-04)

**Problem:** The codebase has no linting or formatting enforcement. Code style varies across files. New contributors receive no automated style feedback, increasing review friction and producing noisy diffs.

**Fix:** Add ESLint (flat config) with `@eslint/js` recommended + `eslint-plugin-react`. Add Prettier with a `.prettierrc` matching the existing dominant code style. Add `npm run lint` to the CI pipeline. Apply auto-fix formatting as a single dedicated commit.

**Files to change:**
- `backend/eslint.config.js`, `frontend/eslint.config.js` — ESLint configurations
- `.prettierrc` — Prettier config
- `.github/workflows/ci.yml` — add lint step
- `backend/package.json`, `frontend/package.json` — add dev dependencies

---

### MNT-015 — Browser pool reuse + per-tenant rate limiting 🟡 High

**Status:** 🔲 Planned | **Effort:** M | **Source:** AUDIT.md P4, B8 (formerly `PERF-001` in AUDIT_IMPL.md)

**Problem:** Every test run cold-starts a new Chromium instance. For a 50-test suite this is 50 browser launches. A browser pool reduces wall-clock run time by 40–60%. AI endpoints (expensive) share rate-limit buckets with cheap GETs (ENH-005 is global-tier only).

**Fix:** Extract a `BrowserPool` class (`backend/src/runner/browserPool.js`) maintaining N warm contexts (`MAX_WORKERS` default). Each test execution checks out a context and returns it without closing the browser. Add per-workspace AI rate limiting with cost weighting (AI call = 10 units, regular call = 1 unit), stored in Redis under `workspaceId:ai` keys.

**Files to change:**
- New `backend/src/runner/browserPool.js`
- `backend/src/testRunner.js` — use `BrowserPool` instead of `playwright.launch()` per test
- `backend/src/middleware/appSetup.js` — per-workspace AI rate limiter middleware
- `backend/src/utils/redisClient.js` — `incrWithExpiry(key, cost, windowSec)`
- `backend/.env.example` — `BROWSER_POOL_SIZE`

**Acceptance criteria:**
- A 10-test suite run starts in ≤3 browser launch events.
- A workspace exceeding its AI rate limit receives 429 with `Retry-After` without affecting other workspaces.
- Draining the pool on graceful shutdown closes all browser contexts cleanly.

**Dependencies:** INF-007 (metrics to measure pool hit/miss rate).

---

### MNT-016 — Storybook + design tokens + accessibility CI gate 🟡 High

**Status:** 🔲 Planned | **Effort:** L | **Source:** AUDIT.md F2, F5, U3 (formerly `UX-001` in AUDIT_IMPL.md)

**Problem:** `components.css` + `utilities.css` are ad-hoc with no token system. Empty/Loading/Error states are inconsistent across 20+ pages. Sentri's own UI has no a11y CI gate (ironic for a QA tool). No Storybook means UI regressions are invisible.

**Fix:** Set up Storybook 8 with a `tokens.css` file. Stories for 10 core components (`Button`, `Input`, `Modal`, `Card`, `Badge`, `ChartCard`, `EmptyState`, `LoadingState`, `ErrorState`, `ConfirmDialog`). Add `@axe-core/storybook` addon (fails stories with WCAG AA violations). Add a Pa11y CI job running against the Sentri UI on 5 critical routes (Login, Projects, TestDetail, RunDetail, Settings). Require ≥1 story per new component in REVIEW.md checklist.

**Files to change:**
- New `frontend/.storybook/main.ts`, `preview.ts`
- New `frontend/src/styles/tokens.css`
- `frontend/src/styles/components.css` — replace magic values with token references
- New `frontend/src/stories/` — 10 component story files
- `frontend/package.json` — add `@storybook/react-vite`, `@axe-core/storybook`, `pa11y-ci`
- New `.github/workflows/axe.yml`
- `REVIEW.md` — add ≥1 Storybook story requirement

**Acceptance criteria:**
- `npm run storybook` starts; all 10 component stories render.
- Zero WCAG AA violations on the 10 core component stories.
- Pa11y CI is green on main for all 5 routes.

**Dependencies:** MNT-012 (TS in shared makes token types available to Storybook config).

---

### MNT-017 — TypeScript migration: frontend (incremental) 🟢 Strategic

**Status:** 🔲 Planned | **Effort:** XL | **Source:** AUDIT.md F1 (formerly `UX-002` in AUDIT_IMPL.md)

**Problem:** Zero TypeScript in the frontend. A 2026 SaaS product of this complexity without TS is a maintainability tax. AUDIT.md notes this is the #1 refactor risk driver.

**Fix:** Enable `allowJs: true` in `tsconfig.json` so `.js` and `.ts` coexist. Migrate in priority order: (1) `frontend/src/api.js` → `api.ts` (highest call density), (2) `frontend/src/utils/*.js` → `.ts`, (3) `frontend/src/hooks/**/*.js` → `.ts`, (4) page components (one per sprint, highest-complexity first: TestDetail, RunDetail, TestLab). Target: 30% TS coverage within this item; 100% within 18 months.

**Files to change (first sprint):**
- New `frontend/tsconfig.json` — `allowJs: true`, `strict: true`, `noEmit: true`
- `frontend/src/api.js` → `api.ts` — return types from `@sentri/shared` Zod schemas
- `frontend/src/utils/*.js` → `.ts` (all 8 utility files)
- `frontend/package.json` — add `typescript`; add `tsc --noEmit` to `npm test`
- `.github/workflows/ci.yml` — `tsc --noEmit` step for frontend

**Acceptance criteria:**
- `tsc --noEmit` passes with zero errors on the migrated files.
- Zero runtime regressions.
- `api.ts` export types are consumed by ≥3 component files via `import type`.

**Dependencies:** MNT-012 (shared types from `@sentri/shared` feed into `api.ts`).

---

### MNT-003 — Prompt A/B testing framework 🔵 Medium ⚠️ Superseded scope

**Status:** 🔲 Planned (narrowed) | **Effort:** L → S | **Source:** Audit. **Most of this item's scope is now covered by AUTO-022** (golden-set eval harness). What remains here is the experiment-tagging + per-variant promotion UI; the metric-computation half is folded into AUTO-022's `metric_samples` rows.

**Original problem (still valid for the residual scope):** `promptVersion` is stored on tests but there is no system to *promote* a winning variant — AUTO-022 measures regression but doesn't run experiments per variant.

**Reduced fix:** Add a `promptExperiments` table. Tag each generation with the active experiment + variant. Reuse AUTO-022's quality metrics per variant (validation pass rate, healing rate, approval rate). Add an Experiments view in Settings to review results and promote a winning variant.

**Dependencies:** AUTO-022 (eval harness produces the per-variant metrics this surfaces).

---

## Competitive Gap Analysis

> **Note:** The SmartBear column reflects both their legacy portfolio (TestComplete, ReadyAPI)
> and the new **BearQ** AI-native platform (early access — https://smartbear.com/product/bearq/early-access/).
> BearQ significantly changes SmartBear's competitive position; capabilities marked with † are BearQ-specific.

| Capability | Sentri | Mabl | Testim | SmartBear / BearQ | Playwright OSS |
|---|---|---|---|---|---|
| AI test generation | ✅ 8-stage pipeline | ✅ Auto-heal only | ✅ AI recorder | ✅ BearQ AI generation † | ❌ Manual |
| Interactive recorder | ✅ DIF-015 | ✅ | ✅ | ✅ BearQ recorder † | Via codegen |
| Self-healing selectors | ✅ Multi-strategy waterfall | ✅ ML-based | ✅ Smart locators | ✅ BearQ AI healing † | ❌ |
| AI auto-repair on failure | ✅ Feedback loop | ✅ | ✅ | ✅ BearQ † | ❌ |
| Human review queue | ✅ Draft → Approve flow | ❌ | ❌ | ❌ | ❌ |
| NL test editing | ✅ AI chat + fix | ❌ | ❌ | ✅ BearQ NL input † | ❌ |
| API test generation | ✅ HAR-based auto-gen | ✅ | ❌ | ✅ ReadyAPI | ✅ Manual |
| Scheduled runs | ✅ Cron + timezone | ✅ | ✅ | ✅ | Via CI cron |
| CI/CD integration | ✅ Webhook + token auth | ✅ Native | ✅ Native | ✅ Native | ✅ CLI |
| Self-hosted / private | ✅ Docker | ❌ SaaS only | ❌ SaaS only | Partial | ✅ |
| Multi-provider LLM | ✅ Anthropic/OpenAI/Google/OpenRouter/Ollama | ❌ | ❌ | ❌ | ❌ |
| Parallel execution | ✅ 1–10 workers | ✅ Cloud | ✅ Cloud | ✅ Cloud | ✅ CLI sharding |
| Visual regression | ✅ DIF-001 | ✅ Native | ✅ Native | ✅ VisualTest | Via plugins |
| Cross-browser | ✅ DIF-002 | ✅ Chrome+Firefox | ✅ Chrome+Firefox | ✅ All | ✅ All 3 |
| Mobile / device emulation | ✅ DIF-003 | ✅ | ✅ | ✅ | ✅ Native |
| Failure notifications | ✅ Teams/email/webhook | ✅ Slack/email | ✅ Slack/email | ✅ | N/A |
| Multi-tenancy / RBAC | ✅ ACL-001/ACL-002 | ✅ | ✅ | ✅ | N/A |
| Standalone export | ✅ DIF-006 | ❌ Lock-in | ❌ Lock-in | ❌ Lock-in | N/A |
| Flaky test detection | ✅ DIF-004 | ✅ | ✅ | ✅ | ❌ |
| Risk-based test selection | ✅ AUTO-001 (PR #15) — consumes AUTO-002's `changedPages` signal | ✅ | Partial | ✅ BearQ smart selection † | ❌ |
| Accessibility testing | ✅ (backend) / 🔄 AUTO-016b (UI) | ✅ | ❌ | Partial | Via plugins |
| Performance budgets | ❌ → AUTO-017 | ❌ | ❌ | Via Lighthouse | ❌ |
| Quality gate enforcement | ✅ AUTO-012 (PR #2) | ✅ | ✅ | ✅ | Via Playwright |

**Sentri's unique strengths:** Self-hosted + AI generation + human review queue + multi-provider LLM + standalone Playwright export (✅ DIF-006). No competitor offers all five together. BearQ narrows the AI generation gap but remains SaaS-only with no self-hosted option or LLM provider choice.

**Critical gaps to close next:** SEC-007 Phase 1 (compliance audit log immutability + auth events, current sprint) · INF-007 (OTel/Sentry) · INF-008 (Postgres-default) · AUTO-022 (AI eval harness). Prior critical gaps closed: SEC-006 ✅ PR #11 (PII firewall), SEC-004 ✅ PR #10 (MFA: TOTP + WebAuthn + per-workspace enforcement), AI-001 ✅ PR #14 (generic OpenAI-compatible provider adapter), AUTO-001 ✅ PR #15 (risk-based test selection), AUTO-004 ✅ PR #18 (test impact analysis from git diff / GitHub PR files), INT-002 ✅ PR #15 (GitHub PR check comments), CAP-001 ✅ PR #1 (data-driven test fixtures), DIF-012 ✅ PR #2 (multi-environment support), CAP-002 ✅ PR #3 (distributed test sharding), AUTO-010 ✅ PR #6 (root-cause failure clustering).

> **Previous priorities ✅ shipped:** DIF-001 · DIF-002/002b · DIF-003 · DIF-004 · DIF-005 · DIF-006 · DIF-007 · DIF-011 · DIF-013 · DIF-014 · DIF-015 · DIF-015b · DIF-016 · INT-002 (PR #15) · AUTO-001 (PR #15) · AUTO-002/002b/005/006/007/012/013/015/015b/016/016b/017/019 · AI-001 (PR #14) · CAP-003 · CAP-004 · MET-001 · UI-REFACTOR-001.

---

## Summary

| Category | Total | ✅ Done | 🔄 In Progress | 🔲 Pending | Remaining |
|----------|------:|--------:|---------------:|----------:|-----------|
| Security & Compliance | 7 | 6 | 0 | 1 | SEC-005 (SSO) planned |
| Infrastructure | 10 | 7 | 0 | 3 | INF-008 🔴 (Postgres default), INF-009 (Helm/DR), INF-010 (SDK + CLI) |
| Access Control | 2 | 2 | 0 | 0 | — |
| Platform Features | 7 | 4 | 0 | 3 | FEA-004 (per-tenant quotas), FEA-005 (collaboration/comments), FEA-006 (template gallery) |
| Differentiators | 22 | 16 | 0 | 6 | DIF-002c, 008, 009, 010, 012, 015c (sub-gaps 2–6) |
| Autonomous Intelligence | 29 | 21 | 0 | 8 | AUTO-011/014/018/021/022 🔴 (eval harness)/023 (DAG runner)/024 (critic)/025 (healing loop) (AUTO-020 superseded by AUTO-015; AUTO-009 ✅ shipped in PR #19 incl. all follow-ups 009b/c/d/e/f/g/h/i/j/k) |
| Capabilities | 4 | 4 | 0 | 0 | — |
| Process automation | 1 | 1 | 0 | 0 | — |
| Maintenance | 17 | 5 | 0 | 12 | MNT-001/002/003 (narrowed)/004/005/008/012/013/014/015/016/017 |
| **Totals** | **99** | **65** | **0** | **33** | |


**Total tracked items:** 99 across 9 categories — **65 complete** (66%), **0 in current PR** (INF-008), **33 remaining**

**Blockers (must ship before paid tier / enterprise demo):**
- ✅ All Phase 1–4 blockers resolved.
- 🔴 **NEW from AUDIT.md Phase 5 — 3 items unresolved:** INF-008 (Postgres default + dual-DB CI matrix), AUTO-022 (AI eval harness). (SEC-004 MFA shipped in PR #10; SEC-006 PII firewall shipped in PR #11; SEC-005 SSO reclassified from Blocker to 🟢 Strategic per AUDIT.md S2.)

**Recommended PR order (next 8 sprints, interleaving Phase 4 feature delivery with Phase 5 audit hardening):**
1. `INF-008` (Postgres-default + dual-DB CI matrix — 🔴 Blocker per AUDIT.md; SQLite kept as dev fallback, Postgres becomes the canonical schema for production deployments)
2. `AUTO-022` (AI eval harness — 🔴 Blocker per AUDIT.md AI series; regression-safety net for prompt / model changes, gates AI-001 fallback-chain rollouts; depends on INF-007's `metric_samples` infra)
3. `SEC-007 Phase 2` (admin compliance surface + CSV/NDJSON export + retention sweep — completes the SOC 2 / ISO 27001 story started in Phase 1)

This rotation alternates between audit-driven hardening and feature delivery so neither narrative starves.

**Lowest effort / highest immediate value (excluding current PR):** `SEC-004` (MFA) — L effort, unblocks regulated-industry sales pipeline and resolves the longest-standing 🔴 Blocker on the board. Pair with `INF-007` (OTel/Sentry) for the next sprint pair: combined they move industry-readiness from 6.0/10 → ~7.5/10 per AUDIT.md targets.

---

## Contributing

Before starting any item:

1. Open a GitHub Issue referencing the item ID (e.g., `SEC-001`, `DIF-006`)
2. Assign yourself and add to the current sprint milestone
3. Create a branch named `feat/SEC-001-email-verification` or `fix/INF-002-redis-sse`
4. Reference the issue in your PR description
5. Update the item's **Status** in this file (`🔲 Planned` → `🔄 In Progress` → `✅ Complete`) in the same PR
6. Add an entry to `docs/changelog.md` under `## [Unreleased]` following the Keep a Changelog format

For items with explicit **See also** cross-references (MNT-001/MNT-002, DIF-006/MNT-005), coordinate branch timing in sprint planning to avoid merge conflicts on shared files (`selfHealing.js`, `exportFormats.js`).
