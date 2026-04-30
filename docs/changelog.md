# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Telemetry**: Anonymous opt-out PostHog telemetry (DIF-013) — new `backend/src/utils/telemetry.js` emits coarse-grained lifecycle events to PostHog when `POSTHOG_API_KEY` is configured. Events now cover the full pipeline: `install.first_run` (lifetime-once, fired from `backend/src/index.js` after `app.listen`), `crawl.start` / `crawl.complete` (from `backend/src/crawler.js` with `mode`, `pages`, `testsGenerated`, `apiEndpoints`, `rateLimitHit`), `generate.start` / `generate.complete` (description-based AI generation, with `provider`, `testCount`, `rejected`), `run.started` (from `backend/src/routes/runs.js` when regression runs enqueue) and `run.complete` (from `backend/src/testRunner.js` with `passed`/`failed`/`retryCount`/`failedAfterRetry` — AUTO-005 flake telemetry visible in PostHog), `test.review` (approve / reject, single + bulk, from `backend/src/routes/tests.js`), and `test.healing` (one aggregated event per test execution from `backend/src/runner/healingPersistence.js`, with succeeded/failed counts and a `strategyHistogram` of which selector-fallback index actually won — useful for measuring self-healing efficacy without flooding PostHog with per-element events). The distinct ID is a SHA-256 of `hostname|cwd` (no PII), URL props are reduced to `domain` only, and lifetime-once events (`install.first_run`) are deduped via `data/telemetry-cache.json`. Disabled fully when `SENTRI_TELEMETRY=0` or `DO_NOT_TRACK=1`. Telemetry is fire-and-forget and never blocks or throws on the request hot path. New env vars (`POSTHOG_API_KEY`, `POSTHOG_HOST`, `SENTRI_TELEMETRY`, `DO_NOT_TRACK`) documented in `backend/.env.example` and `docs/guide/env-vars.md` (#3, #120).
- **Runner**: Per-run network condition simulation (AUTO-006) — `POST /api/v1/projects/:id/run` accepts `networkCondition: "fast" | "slow3g" | "offline"`. `offline` calls `context.setOffline(true)`; `slow3g` adds a 400ms `page.route` delay on every request. UI selector added to the Run Regression modal. Plumbed through `runs.js`, `testRunner.js`, `runner/executeTest.js`, and the BullMQ worker (`workers/runWorker.js`) so the option is honoured under both in-process and Redis-backed execution paths. Migration `012_run_network_condition.sql` adds a nullable `networkCondition` column on the `runs` table and `runRepo.INSERT_COLS` + `LEAN_COLS` are extended so the value is persisted on create and exposed on lean list reads — historical analytics queries can now answer "did slow-3G runs flake more than fast?" without inferring from logs (#3, #120).
- **Recorder**: `bestSelector` renamed to `selectorGenerator` in the recorder's injected script (DIF-015b) to align naming with Playwright's selector-generator approach. No behaviour change to the existing 5-strategy fallback chain (data-testid → role+name → label → placeholder → CSS) (#3).
- **Runner**: Automatic per-test retry with flake isolation (AUTO-005) — `executeWithRetries()` (`backend/src/runner/retry.js`) wraps each test execution in `testRunner.js` and re-runs failed attempts up to `MAX_TEST_RETRIES` (default 2, clamped 0..10) before recording a true failure. A test that fails on attempt 1 but passes on attempt 2 is reported as `passed` with `retryCount: 1`; a test that exhausts all retries has `failedAfterRetry: true` on its result. Migration `011_run_retry_metadata.sql` adds aggregated `retryCount` / `failedAfterRetry` columns on the `runs` table for downstream analytics. `MAX_TEST_RETRIES` env var documented in `backend/.env.example`. `fireNotifications` callsites in `backend/src/routes/runs.js` are now gated on `failedAfterRetry`-aware run state so notifications and failure counters only fire after retries are exhausted (#2).
- **API**: Standalone Playwright export — `GET /api/v1/projects/:id/export/playwright` returns a runnable Playwright project ZIP containing `package.json`, `playwright.config.ts` (with `baseURL` from project), `README.md`, and one `tests/<slug>.spec.ts` per **approved** test. Lets users eject from Sentri and run their suite locally with `npm install && npx playwright test`. Draft and rejected tests are excluded; filenames are de-duplicated when two tests normalize to the same slug. Implementation shells out to the system `zip` binary (no new npm runtime dep) — installations without `zip`/`unzip` will return 500 (DIF-006) (#1).
- **Frontend**: "Playwright project ZIP (approved)" entry added to the Project Detail → Export dropdown, plus a new `api.downloadPlaywrightExport(projectId)` client helper. Surfaces the DIF-006 endpoint in the UI so users can eject without hitting the API directly; the entry sits in the "Approved only" section because the endpoint always filters to approved tests server-side (DIF-006) (#120).

## [1.6.8] — 2026-04-29

### Fixed
- **Recorder**: The browser-in-browser canvas in the Recorder modal is now interactive. Previously the canvas was a read-only screencast — pointer clicks, scrolls, and keystrokes never reached the headless browser, so "Stop & Save" always returned "no actions were captured" with `BROWSER_HEADLESS=true` (the default). Pointer + keyboard + wheel events are now scaled from CSS pixels to the server viewport coordinates and forwarded to the headless Chromium via a new `POST /api/v1/projects/:id/record/:sessionId/input` route that translates DOM events into CDP `Input.dispatch*` commands (DIF-015) (#118).
- **Recorder**: SSE screencast frames were being silently dropped because `RecorderModal` listened for a named `frame` event, but the backend emits unnamed `data:` lines. Routed SSE consumption through a new `useSseStream` hook that uses `onmessage` and parses the `type` from the JSON payload, so the canvas paints reliably as soon as the recorder launches (#118).
- **Recorder**: Re-recording the same project no longer fails with a UNIQUE constraint error when a previous recorder session crashed mid-launch. `POST /record` now sweeps any orphaned `record` rows for the project before inserting the new stub. The orphan sweep is intentionally scoped to `["record"]` only — it must not silently kill an in-progress crawl or regression run that happens to be active on the project (#118).
- **Recorder**: The `MAX_RECORDING_MS` safety-net teardown now closes the stub `runs` row it created at session start. Previously the row stayed `running` forever, blocking every future crawl/test_run/generate on the project until the next recorder launch's orphan sweep cleaned it up (#118).
- **Recorder**: Generated Playwright code and the human-readable Step list now stay aligned — the stop-handler's goto deduplication seeds `lastGotoUrl` with `startUrl` to match `actionsToPlaywrightCode`, so the persisted test no longer shows an extra "Step 1: goto → startUrl" entry that has no corresponding code line (#118).
- **Recorder**: Typing in the recorder canvas no longer produces double characters. The frontend was sending both a CDP `keyDown` (with `text`) and a separate `char` event for every printable key, causing each character to be inserted twice (typing "hi" produced "hhii"). CDP's `keyDown` with non-empty `text` already synthesises text input — the duplicate `char` was removed (#118).
- **Recorder**: Right- and middle-button drags now forward the correct CDP button. `MouseEvent.button` is always 0 during `mousemove` per the DOM spec; the held button is now derived from the `MouseEvent.buttons` bitmask (1=left, 2=right, 4=middle) so non-primary drags aren't mis-reported as left-button drags (#118).
- **Recorder**: Scrolling inside the recorder canvas no longer scrolls the surrounding page underneath. React 18 registers `onWheel` as passive by default, so `e.preventDefault()` on the synthetic event was silently ignored. The wheel listener is now attached imperatively via `addEventListener('wheel', …, { passive: false })` (#118).
- **Recorder**: Persisted `steps[]` are now short English sentences referencing elements by their friendly label (`User clicks the "Sign in" button`, `User fills the "Email" field with …`) instead of raw `role=button[name="…"]` selectors or CSS chains. The recorder now captures an `aria-label` / inner-text / placeholder-derived label alongside the selector, the human-readable step uses that label (with a fallback to extract the name from a Playwright role selector for older recordings), and `goto` URLs render the origin + pathname only so noisy querystring-heavy URLs (e.g. Amazon search) don't dominate the Steps panel. Recorded tests previously stored engineer-shaped CDP-event strings like `"Step 1: click → role=button[name=\"Sign in\"]"` that stuck out on the Test Detail page next to AI-generated and manually-created tests (#118).
- **Recorder**: Adjacent `goto` actions whose URLs differ only by query string are now collapsed when persisting steps. Browsers frequently re-emit `framenavigated` for the same page after re-ordering / appending tracking params, which previously produced two visually-identical "User navigates to …" steps in the persisted test (#118).
- **Recorder**: Recorder sessions now support manual assertion steps (visible/text/value/URL) while recording, and generated Playwright output emits matching `expect(...)` assertions. The captured action set was also expanded for closer Playwright-recorder parity to include double-click, right-click, hover, and file-upload intent steps (#118).

## [1.6.7] — 2026-04-26

### Changed
- **Runner**: Visual baselines are now browser-aware (DIF-002b gap 1). Baseline storage keys and artifact paths include the Playwright engine (`chromium` / `firefox` / `webkit`) so cross-browser runs no longer diff against Chromium goldens. Added migration `010_baseline_browser.sql` to re-key existing rows and backfill legacy baselines as `chromium`; pre-upgrade on-disk baselines remain effective via a chromium legacy-path fallback in `ensureBaseline()` until the next accept rewrites them under the new layout (#110).

### Fixed
- **API**: Visual baseline endpoints now accept browser scoping (`?browser=` or run/browser fallback) for accept/delete/list flows, and baseline accept activity logs include the targeted browser engine to improve audit clarity (#110).

### Added
- **CI**: New `cross-browser-smoke` matrix workflow (`.github/workflows/cross-browser.yml`, DIF-002b gap 2) live-launches Firefox and WebKit via Playwright and asserts `launchBrowser({ browser })` opens the requested engine and renders a page. Path-filtered to PRs touching `backend/src/runner/**` and runs on a nightly cron against `main`, so the matrix doesn't double CI time on unrelated PRs while still catching Playwright API regressions (#110).

## [1.6.6] — 2026-04-25

### Fixed
- **Pipeline**: Advanced Playwright flows are now handled more safely end-to-end. `validateActions()` accepts `request.dispose()` to prevent false-positive API test rejection, `runGeneratedCode()` now exposes a scoped `request.newContext()` fixture for hybrid UI+API tests (with guaranteed context disposal), and `testFix` no longer pre-applies healing transforms (transforms are applied once at execution time) (#109).
- **Self-healing**: Transform coverage now includes text-based `locator.dragTo(...)` patterns and additional upload variants (`getByRole(...).setInputFiles(...)`), and `safeClick` guards `waitForLoadState` calls for non-Page roots (#109).
- **Feedback loop**: Added advanced failure categories (`NETWORK_MOCK_FAIL`, `FRAME_FAIL`, `API_ASSERTION_FAIL`) with targeted regeneration instructions and high-priority handling instead of falling back to `UNKNOWN` (#109).
- **Runner**: Browser sandbox `request` fixture now supports both context-factory and request-style methods (`newContext`, `get/post/put/patch/delete/fetch/head`, `dispose`) for hybrid tests, matching validator guidance (#109).

### Changed
- **Maintenance**: Selector classification logic is now centralized in `backend/src/utils/selectorHeuristics.js` and reused by both validator and self-healing transform paths to prevent heuristic drift (#109).

### Added
- **Tests**: Added/extended regressions for advanced capability handling:
  - `backend/tests/test-validator-allowlist.test.js` now covers `request.dispose`.
  - `backend/tests/healing-transforms.test.js` covers `getByRole(...).setInputFiles(...)` and `locator.dragTo(...)` transforms.
  - `backend/tests/feedback-loop.test.js` covers new advanced failure categories (#109).

## [1.6.5] — 2026-04-25

### Changed
- **Frontend**: `useProjectData` migrated to TanStack Query — projects, runs, and tests are now fetched via `useQuery` with a shared `QueryClient` (30s `staleTime`/`gcTime`), replacing the hand-rolled module-level cache. `invalidateProjectDataCache()` and `refresh()` retain their public API and now delegate to `queryClient.invalidateQueries()`. The runs and tests query keys include the current project ID set so dependent queries automatically refetch when the project list changes (FEA-002) (#107)
- **Frontend**: `Dashboard` page migrated from ad-hoc `useEffect` + `useState` fetch to TanStack Query (`useQuery` with the new `dashboardQueryKeys` and 30s cache). The Retry button now refetches via the query client instead of full-page reload, preserving navigation state. New `invalidateDashboardCache()` helper is exposed from `queryClient.js` for callers that mutate dashboard-relevant data (FEA-002) (#107)
- **Frontend**: `RunDetail` page migrated to TanStack Query — the run object is now read from `useQuery({ queryKey: runQueryKeys.detail(runId) })`. SSE events (snapshot/result/log/done) apply optimistic patches via `queryClient.setQueryData()` so the cache is always the source of truth, and the "Refresh" button invalidates the query instead of triggering a manual fetch (FEA-002) (#107)
- **Frontend**: `Settings` page top-level fetch (settings + config + system info bundle), `MembersTab`, `RecycleBinTab`, and `OllamaStatusPanel` migrated to TanStack Query under the new `settingsQueryKeys`. Each section has its own cached query (15–30s `staleTime`/`gcTime`) and "Check / reload" controls invalidate the relevant key instead of running an imperative re-fetch. The Ollama model-sync side-effect (matching `mistral:7b` against the available `:latest`-tagged tag) was preserved by moving it into a `useEffect` watching the query result (FEA-002) (#107)
- **Frontend**: TanStack Query consumption simplified — global `staleTime`/`gcTime` defaults (30s) moved into the shared `QueryClient`, so individual `useQuery` call sites no longer repeat them. Per-resource query hooks added under `frontend/src/hooks/queries/` (`useDashboardQuery`, `useRunDetailQuery`, `useSettingsBundleQuery`, `useMembersQuery`, `useRecycleBinQuery`, `useOllamaStatusQuery`) so pages no longer import `useQuery` or query-key objects directly. New `invalidateRunCache(runId)` and `invalidateSettingsCache()` helpers join the existing `invalidateProjectDataCache()` / `invalidateDashboardCache()` family for one-call cache busting (FEA-002) (#107)
- **Frontend**: Remaining FEA-002 page/hook migrations completed — `Tests`, `ProjectDetail`, `TestDetail`, `Automation`, and `Systems` now consume TanStack Query hooks (composite `useProjectDetailQuery`, `useTestDetailQuery`, plus `useProjectData` / `useSettingsBundleQuery` reuse). The `Tests` page bulk approve/reject/delete actions now apply optimistic patches to the shared cache via `queryClient.setQueriesData` and roll back on partial failure. `ProjectDetail` paging/filter refetch is now driven by query-key changes (`keepPreviousData` keeps the table mounted across keystrokes), removing the previous ref-based `useEffect` chain. Every `frontend/src/pages/*.jsx` GET fetch now flows through the shared `QueryClient` (FEA-002) (#107)

### Added
- **Frontend**: Per-run browser engine badge — Run Detail header and Runs list now show whether a test run executed under Chromium, Firefox, or WebKit (DIF-002b gap 3). New `<BrowserBadge>` component (`frontend/src/components/shared/BrowserBadge.jsx`) renders an emoji + label with engine-tinted styling; the Runs table uses a compact icon-only variant and hides the badge for the chromium default to avoid visual noise. Crawl and generate runs (which are pinned to chromium) do not render the badge. Gap 1 (browser-aware visual baselines) and gap 2 (firefox/webkit CI smoke job) of DIF-002b remain outstanding (#107)

### Fixed
- **Frontend**: Query failures are now logged once per durable error via a centralized `QueryCache.onError` handler in `queryClient.js` instead of per-page render-body `console.error` calls. The previous Dashboard implementation re-fired the log on every re-render and doubled under React 18 Strict Mode; the new handler runs exactly once per failed query (after retries exhaust) and emits a stable `[query] <key>:failed` signature so similar failures collapse in log aggregators (#107)

## [1.6.4] — 2026-04-24

### Added
- **Runner**: Cross-browser test execution with Firefox and WebKit (DIF-002) — `POST /api/v1/projects/:id/run` accepts an optional `browser` field (`"chromium"` default, `"firefox"`, `"webkit"`). A new browser-engine selector in the Run Regression modal surfaces the choice. Each run record persists the browser name (migration 009) so the Run Detail page can display a per-run badge. Crawl, recorder, and live browser view remain Chromium-only by design (they depend on CDP). Docker images install all three engines by default; set `BUILD_SKIP_FIREFOX_WEBKIT=1` for a chromium-only build (~400MB smaller).
- **Dev**: `ALLOW_PRIVATE_URLS=true` env flag lets `POST /api/v1/test-connection` probe `http://localhost:<port>` and other private/internal hostnames — unblocks the "Test" button in the New Project form during local development without loosening production SSRF defaults. Off by default; never set in production (#103).
- **Runner**: Visual regression testing with baseline diffing (DIF-001) — captured screenshots are diffed against a persisted baseline via `pixelmatch` / `pngjs`. First run for a `(testId, stepNumber)` pair lazily creates a baseline under `artifacts/baselines/`; subsequent runs produce a diff PNG under `artifacts/diffs/` and flag the step as a regression when the pixel difference exceeds `VISUAL_DIFF_THRESHOLD` (default 2 %). New `GET /tests/:testId/baselines`, `POST /tests/:testId/baselines/:stepNumber/accept`, and `DELETE /tests/:testId/baselines/:stepNumber` endpoints back a new `🖼️ Visual` tab on the run-detail page with Baseline / Current / Diff toggles and an "Accept visual changes" action (#103).
- **Frontend**: Interactive browser recorder for test creation (DIF-015) — "Record a test" quick action on the Tests page launches a Playwright browser, streams it live via the existing CDP screencast, captures click / fill / press / select / navigation events in the page, and on stop persists a Draft test whose Playwright code uses `safeClick` / `safeFill` so the existing self-healing transform takes over at execution time (#103).

### Fixed
- **Crawler**: Crawls of unreachable targets (DNS failures, `ERR_NAME_NOT_RESOLVED`, `ERR_CONNECTION_REFUSED`, TLS errors, connection timeouts) are now classified as `failed` with a DNS/network-specific reason instead of silently finishing as `Completed (empty)` with the generic "no tests generated" banner. The `errorClassifier.js` DNS branch provides a user-facing hint ("check typos / verify hostname / verify VPN") (#103).
- **Pipeline**: The test validator now rejects raw-CSS visibility/text assertions — `expect(page.locator('<cssSelector>')).toBeVisible()`, `.toContainText(...)`, and `.toHaveText(...)` — forcing the AI to use `safeExpect` or semantic locators (`getByText`, `getByRole`, `getByLabel`, `getByTestId`). Count / state / attribute assertions on `page.locator()` (`toHaveCount`, `toBeHidden`, `toHaveAttribute`, `toHaveClass`, `toHaveCSS`) are still allowed per the generation prompt convention. This closes a gap where TC-7-style brittle assertions slipped through to the runner (#103).
- **Self-healing**: `safeCheck` / `safeUncheck` now include 7 list/row-scoped fallback strategies that find a container by `hasText` then pick the checkbox within. Covers `<li>` (TodoMVC pattern), `<tr>` (bug-tracker tables), `[role="listitem"]`, `[role="row"]`, and common class names (`.item / .row / .todo / .task`). Fixes TC-5 / TC-8 regressions where the checkbox is a sibling of (not labelled by) the readable text (#103).
- **Config**: `VISUAL_DIFF_THRESHOLD` and `VISUAL_DIFF_PIXEL_TOLERANCE` can now be set to `0` — previous `parseFloat(env) || default` treated `0` as falsy and silently fell back to the default, making zero-tolerance visual regression detection impossible (#103).
- **Recorder**: URLs interpolated into generated Playwright code are now single-quote escaped, matching the existing selector/value escaping. Captured URLs containing `'` no longer produce syntactically broken test scripts (#103).
- **Recorder**: `startRecording` no longer leaks a Chromium process when mid-setup calls (`exposeBinding`, `addInitScript`, `page.goto`, `startScreencast`) throw. The session is only published to the active-sessions map after all async setup succeeds, and any partially-initialised browser / context / page is closed on failure (#103).
- **Recorder**: Generated code now routes recorded `select` / `check` / `uncheck` actions through `safeSelect` / `safeCheck` / `safeUncheck` instead of raw `page.selectOption` / `page.check` / `page.uncheck`. The recorder's `bestSelector()` always produces CSS-looking strings (e.g. `#id`, `[data-testid="…"]`) which the `applyHealingTransforms` regex guard refuses to rewrite, so recorded form-control actions previously bypassed the self-healing waterfall entirely. Recorded checkboxes now also benefit from the list/row-scoped fallbacks added to `safeCheck` / `safeUncheck` in this PR (#103).
- **Recorder**: `actionsToPlaywrightCode` no longer emits a duplicate `page.goto(startUrl)` at the top of generated scripts. The initial `goto` that `startRecording` records as `actions[0]` (plus any `framenavigated` echoes) is collapsed against the hard-coded header goto (#103).
- **Recorder UI**: Clicking *Discard* in the recorder modal no longer persists a junk "discarded" Draft test. The frontend now calls a dedicated `recordDiscard` endpoint (`POST /projects/:id/record/:sessionId/stop` with `{ discard: true }`) that tears down the browser server-side without writing to the test table (#103).
- **Routes**: `POST /tests/:testId/baselines/:stepNumber/accept`, `POST /projects/:id/record`, and `POST /projects/:id/record/:sessionId/stop` now return `{ error: "Internal server error" }` on 500s and log the real error server-side via `formatLogLine`, matching the repo-wide AGENT.md error-handling convention (#103).
- **Config**: `VISUAL_DIFF_THRESHOLD` / `VISUAL_DIFF_PIXEL_TOLERANCE` now fall back to their defaults when the env var is set to a non-numeric string. Previously `parseFloat("abc")` produced `NaN`, which silently disabled regression detection because `diffRatio > NaN` is always `false` (#103).
- **Visual diff**: Baseline / diff artifact paths no longer round-trip through `encodeURIComponent(testId)`. Express URL-decodes the path before the static-file lookup + HMAC verification in `appSetup.js`, so any `%XX` bytes in the filename would 404 or fail signature validation. Test IDs are already path-safe (#103).
- **Recorder UI**: The unmount cleanup effect in `RecorderModal` now tears down the server-side recording session via `recordDiscard` (using `sessionIdRef` / `projectIdRef` to dodge the empty-deps stale-closure bug). Navigating away from the Tests page mid-recording no longer leaves a Chromium process running on the backend (#103).
- **Recorder**: `startRecording` now registers a `MAX_RECORDING_MS` (default 30 min, configurable) safety-net timeout that force-tears-down abandoned sessions even when the client never reconnects, bounding server memory usage (#103).
- **Recorder**: Discard and save paths are both resilient to the TOCTOU window between `getRecording()` and `stopRecording()`. When the `MAX_RECORDING_MS` safety-net timeout fires, the generated Playwright code + actions are stashed in a short-lived in-memory cache (default 2 min, configurable via `RECORDER_COMPLETED_TTL_MS`). The stop endpoint falls back to that cache so a user who clicks "Stop & Save" moments after the auto-teardown no longer loses their captured actions — the response includes `recoveredFromAutoTimeout: true` to signal the recovery path. Discard-after-timeout returns `alreadyStopped: true` instead of a 500 (#103).
- **Run detail visual tab**: When switching to a step whose capture has no visual diff, the active tab no longer gets stuck on the now-hidden "Visual" button and blank out the content panel. `StepResultsView` resets `activeTab` to `video`/`screenshot` whenever the visual tab becomes unavailable (#103).

## [1.6.3] — 2026-04-23

### Added
- **AI**: Tiered prompt system for local models (Ollama) — splits `SELF_HEALING_PROMPT_RULES` into compact `CORE_RULES` (~200 tokens) for local 7B models and full `EXTENDED_RULES` for cloud providers; all 4 prompt consumers (`outputSchema.js`, `testFix.js`, `feedbackLoop.js`) use tier-aware `getPromptRules(getTier())`; local system prompt total under 2000 characters (MNT-009) (#100)
- **Frontend**: Re-run button on Run Detail page for crawl and generate runs — when a crawl or generate run is in a terminal state (completed, completed_empty, failed, interrupted, aborted), a "Re-run" button appears in the header that re-triggers the same operation and navigates to the new run (MNT-010) (#100)

### Changed
- **Pipeline**: Journey count capped for small crawls — ≤5 pages generates max 2 journeys (was unlimited), ≤15 pages max 4; reduces LLM calls from ~8 to ~3-4 for typical Ollama crawls (#100)
- **Pipeline**: Low-priority pages (NAVIGATION, CONTENT) with fewer than 3 interactive elements are now skipped in test generation — these produced low-quality tests that were almost always rejected by validation (#100)
- **Pipeline**: API test generation skipped for trivial traffic — sites with fewer than 4 GET-only endpoints (e.g. google.com telemetry) no longer waste an LLM call on low-value API contract tests (#100)
- **AI**: Ollama exempted from circuit breaker — local models don't have rate limits; Ollama HTTP 500 / context overflow errors were falsely triggering the rate-limit circuit breaker (threshold=1), disabling all remaining LLM calls for 5 minutes (#100)

### Fixed
- **Runner**: Test execution no longer crashes when ffmpeg is missing — `executeTest.js` now catches the Playwright "Executable doesn't exist" error on `browser.newContext()` and retries without `recordVideo`, so tests run (without video) instead of failing immediately with a confusing ffmpeg error (#100)
- **Docker**: Both `Dockerfile` and `backend/Dockerfile` now install `ffmpeg` via apt — required by Playwright for video recording (#100)
- **Docs**: All setup guides (README, getting-started, github-pages-render) updated to `npx playwright install chromium ffmpeg` — previously only chromium was installed, causing test runs to crash on Render deployments (#100)
- **Validator**: `page.goto` check relaxed — tests that navigate via `safeClick` (which triggers `page.waitForLoadState` internally) are no longer rejected as "missing page.goto navigation"; this was the #1 false-positive rejection reason across all AI providers (#100)
- **Crawl**: Site map was always empty — `run.pages` was set in-memory during crawl but never persisted to DB; added `pages` TEXT column (migration 007), added to `runRepo.js` JSON_FIELDS/INSERT_COLS, and both `crawlBrowser.js` and `stateExplorer.js` now persist pages and emit SSE snapshots as pages are discovered (#100)
- **SSE**: `useRunSSE` retryTimer race — if the backoff timer fired between cleanup and re-setup on navigation, a stale `connect()` for the old runId would fire; added `mountedRef` guard (#100)
- **Frontend**: `useLogBuffer` showed stale logs from previous run when navigating to a re-run with fewer log entries — changed `>` to `!==` comparison so the buffer resets on any length change (#100)
- **Frontend**: SiteGraph D3 simulation leaked on early return when `pages.length === 0` — now always returns a cleanup function that calls `sim.stop()`, preventing ghost animations (#100)
- **AI Chat**: Ollama chat requests during an active crawl/generate run caused Ollama to hang (single-threaded model) — chat endpoint now returns 503 "AI is busy" when Ollama is the provider and an in-process run is active (#100)
- **AI Chat**: Ollama busy guard now filters by the provider each active run is using — previously a cloud-provider (Anthropic/OpenAI/Google) run would incorrectly block chat when the user switched to Ollama mid-run. Each run's provider is captured at start time on both `runAbortControllers` (in-process) and `workerAbortControllers` (BullMQ) registries so the chat endpoint can accurately distinguish Ollama-using runs from cloud runs (#100)
- **AI**: Provider outages (Gemini 503 "high demand", 502/504 transient errors) are now retried with exponential backoff and fallback to other configured providers — previously they were treated as non-retriable programmer errors, so a single Gemini outage caused every crawl/generate pipeline call to fail immediately. New `isTransientServerError()` classifier in `aiProvider.js` distinguishes provider outages (5xx) from rate limits (429/quota); both are retried and fall back, but outages don't trip the 5-minute circuit breaker. All retry + fallback logic stays contained in `generateText()` — downstream callers (`journeyGenerator`, `crawler`, feedback loop) don't need any changes (#100)
- **Crawl**: `completed_empty` warning now mentions AI provider overload (503) as the first possible cause, pointing users at multi-provider fallback config instead of misleading them toward API key checks (#100)

## [1.6.2] — 2026-04-23

### Added
- **Tests**: Stale test detection and cleanup — approved tests not run in 90 days (configurable via `STALE_TEST_DAYS`) are automatically flagged as stale by a weekly background job; `isStale` badge shown in test lists; filter by stale tests in the Tests page; manual trigger via stale detector utility (AUTO-013) (#99)
- **Tests**: Flaky test detection and reporting — after each test run, a flaky score (0–100) is computed from the pass/fail balance ratio across the last 20 runs and persisted to `tests.flakyScore`; dashboard includes a top-10 flaky tests panel; tests with `flakyScore > 0` receive a flaky badge (DIF-004) (#99)
- **API**: `isStale` filter support on `GET /api/v1/projects/:id/tests?stale=true` — returns only stale tests for cleanup review (AUTO-013) (#99)
- **API**: `topFlakyTests` array in `GET /api/v1/dashboard` response — top 10 flakiest approved tests with `testId`, `name`, `flakyScore`, `projectId` (DIF-004) (#99)
- **DB**: Migration 006 — adds `isStale` boolean column and `flakyScore` REAL column to `tests` table with indexes (AUTO-013, DIF-004) (#99)

### Fixed
- **Auth**: CSRF token now works in cross-origin deployments (GitHub Pages + Render) — the `_csrf` cookie set by the backend domain was invisible to `document.cookie` on the frontend origin; backend now echoes the token in `X-CSRF-Token` response header with `Access-Control-Expose-Headers`, and the frontend caches it in memory via `setCsrfToken()` (#99)
- **Auth**: CSRF `Set-Cookie` changed from `res.setHeader` to `res.append()` (Express 4.x) — prevents the `_csrf` cookie from being overwritten by later cookie-setting code in the same response (#99)
- **Runner**: CDP screencast was skipped on virtually every run because the SSE listener check fired before any client connected; removed the premature guard so live browser view works reliably (#99)
- **AI**: Feedback loop now skips AI calls when the provider is degraded (rate-limited or circuit-broken) — previously the feedback loop would burn minutes retrying the rate-limited provider, blocking run completion (#99)

### Changed
- **Accessibility**: `role="alert"` / `role="status"` added to `OutcomeBanner`, `role="alert"` to test error display in `TestRunView`, and `aria-live` region for test result announcements (MNT-007) (#99)
- **AI**: Circuit breaker threshold reduced from 3 to 1 consecutive rate-limit failures — `withRetry()` already retries internally, so the error that reaches `generateText()` represents a confirmed durable rate limit (FEA-003) (#99)
- **AI**: When a rate-limit fallback succeeds, the fallback provider is pinned as a sticky override for 10 minutes so subsequent calls in the same pipeline skip the rate-limited primary (FEA-003) (#99)
- **Runner**: AI feedback loop wrapped in a 180-second timeout (`FEEDBACK_TIMEOUT_MS`, default 180s) so it can never block run completion indefinitely (#99)

## [1.6.1] — 2026-04-22

### Changed
- **Frontend**: `ForgotPassword.jsx` and `Login.jsx` now use `api.js` methods (`api.forgotPassword`, `api.resetPassword`, `api.verifyEmail`, `api.oauthCallback`, `api.login`, `api.register`) instead of raw `fetch()` — enforces AGENT.md convention that all backend calls go through `api.js` for CSRF injection, 401 handling, and timeout logic (#97)
- **Frontend**: `api.js` — added `login`, `register`, `forgotPassword`, `resetPassword`, `verifyEmail`, and `oauthCallback` methods; added explanatory comment on `exportAccountData` documenting why it intentionally bypasses `req()` (#97)
- **DB**: Documented migration numbering anomaly — `004_notification_settings.sql` and `004_workspaces_rbac.sql` share the `004_` prefix; added note explaining alphabetical sort ensures safe execution order (#97)
- **Backend**: `STRATEGY_VERSION` in `selfHealing.js` is now exported so tests can validate it is bumped when strategies change (#97)
- **Backend**: Abort endpoint now writes `status: "aborted"` to DB before signaling the BullMQ worker — closes race window where the worker's completion write could overwrite the abort (#97)

### Added
- **Backend**: Batch-size warning logs in `deduplicator.js` — warns when `deduplicateTests` receives >200 tests or `deduplicateAcrossRuns` cross-product exceeds 40,000 comparisons (O(n²) observability) (#97)
- **Tests**: `STRATEGY_VERSION` consistency test in `self-healing.test.js` — fails if the version is changed without updating the expected value, catching unbumped strategy changes (#97)
- **Docs**: `TODO(AUTO-005)` guard comments on `fireNotifications` callsites in `runs.js` — documents that notifications must be gated behind retry exhaustion when test-level retry (AUTO-005) is implemented (#97)
- **Docs**: `AGENT.md` repository list updated — added missing `apiKeyRepo` and `verificationTokenRepo` to both the directory tree and Repositories list (#97)
- **API**: OpenAPI 3.1 specification served at `GET /api/v1/openapi.json`; interactive Swagger UI at `/api/docs` using CDN-hosted swagger-ui-dist (INF-004) (#97)
- **Runner**: Geolocation, locale, and timezone testing — pass optional `locale` (BCP 47), `timezoneId` (IANA), and `geolocation` (`{latitude, longitude}`) in run config; applied to the Playwright browser context so tests execute under the specified international settings; locale/timezone dropdowns added to the Run Regression modal (AUTO-007) (#97)

## [1.6.0] — 2026-04-19

### Added
- **API**: All routes versioned under `/api/v1/` — legacy `/api/*` paths 308-redirect to `/api/v1/*` for backward compatibility during migration window; 308 preserves HTTP method so POST/PATCH/DELETE requests are not downgraded to GET (INF-005) (#94)
- **AI**: Provider fallback chain on rate limits — when the primary AI provider returns a rate-limit error, `generateText()` automatically retries with the next configured provider in detection order before giving up; per-provider circuit breaker disables a provider for 5 minutes after 3 consecutive rate-limit failures (FEA-003) (#94)
- **Runner**: Mobile viewport / device emulation — pass a `device` parameter (e.g. `"iPhone 14"`, `"Pixel 7"`) in run config to apply Playwright's built-in device profiles (viewport, user agent, touch); curated preset list exposed for UI dropdowns (DIF-003) (#94)
- **Dashboard**: `testsByUrl` field in dashboard API response — counts approved tests per source URL for coverage heatmap visualisation (DIF-011) (#94)
- **Frontend**: Coverage heatmap on SiteGraph — when `testsByUrl` is provided, nodes are coloured by test density: red (0 tests) → amber (1–2) → green (3+); legend updates to show heatmap tiers (DIF-011) (#94)
- **Runner**: Cursor overlay on live browser view — injects animated cursor dot, click ripple, and keystroke toast via `page.evaluate()` so CDP screencast viewers can follow what the test is doing; re-injected after each navigation (DIF-014) (#94)
- **Platform**: Demo mode — set `DEMO_GOOGLE_API_KEY` on hosted deployments to let new users try Sentri without bringing their own AI key; per-user daily quotas (2 crawls, 3 runs, 5 generations) enforced via `demoQuota` middleware; users who add their own key (BYOK) bypass all quotas; counters use Redis when available, in-memory otherwise; `GET /config` returns `demoMode` flag and per-user quota status (#94)
- **Runner**: Per-step screenshots and timing — injects `__captureStep(N)` calls after each `// Step N:` comment in generated code; captures a screenshot and records `{ step, durationMs }` after each logical step; `StepResultsView` now shows the per-step screenshot when a step is clicked instead of always showing the final screenshot; real per-step timing replaces the approximate linear interpolation (DIF-016) (#94)
- **API**: Multi-tenancy workspaces — all entities (projects, tests, runs, activities) are scoped to workspaces; workspace management endpoints at `/api/workspaces/*` (ACL-001) (#88)
- **API**: Role-based access control — `admin`/`qa_lead`/`viewer` roles enforced via `requireRole` middleware; role hierarchy admin > qa_lead > viewer (ACL-002) (#88)
- **DB**: Migration 004 — `workspaces` and `workspace_members` tables; `workspaceId` foreign key on projects, tests, runs, activities (ACL-001) (#88)
- **Auth**: JWT now includes `workspaceId` hint; workspace role resolved from DB on every request for immediate permission changes (ACL-001, ACL-002) (#88)
- **Frontend**: `ProtectedRoute` supports `requiredRole` prop for role-gated pages; `AuthContext` exposes `workspaceId`, `workspaceName`, `workspaceRole` (ACL-002) (#88)
- **Infra**: BullMQ job queue for durable run execution — when Redis is available, crawl and test runs are enqueued via BullMQ instead of fire-and-forget in-process execution; provides crash recovery, global concurrency control via `MAX_WORKERS`, and queue depth visibility; falls back to in-process execution without Redis (INF-003) (#92)
- **Backend**: `queue.js` — shared BullMQ Queue definition with lazy-load and graceful fallback (INF-003) (#92)
- **Backend**: `workers/runWorker.js` — BullMQ Worker that processes crawl and test_run jobs with abort support, structured logging, and automatic retry (INF-003) (#92)
- **API**: Per-project failure notification settings — `GET/PATCH/DELETE /api/projects/:id/notifications` for configuring Microsoft Teams webhook, email recipients, and generic webhook URL per project (FEA-001) (#92)
- **Backend**: `notifications.js` — failure notification dispatcher supporting Teams Adaptive Cards, HTML email via existing emailSender transport, and generic webhook POST; all dispatches are best-effort (FEA-001) (#92)
- **DB**: Migration 004 — `notification_settings` table with per-project Teams webhook URL, email recipients, generic webhook URL, and enabled flag (FEA-001) (#92)
- **Backend**: Failure notifications fire automatically on run completion (with failures) for all run types: manual, scheduled, CI/CD triggered, and BullMQ worker-processed (FEA-001) (#92)
- **Frontend**: `api.getNotifications()`, `api.upsertNotifications()`, `api.deleteNotifications()` — notification settings API methods (FEA-001) (#92)
- **API**: `GET /api/auth/export` — export all user-owned account data as JSON (workspaces, projects, tests, runs, activities, schedules, notification settings) for GDPR/CCPA data portability; requires password confirmation via `X-Account-Password` header (SEC-003) (#93)
- **API**: `DELETE /api/auth/account` — hard-delete user account and all owned workspace data in a single transaction for GDPR right to erasure; requires password confirmation in request body (SEC-003) (#93)
- **Backend**: `accountRepo.js` — repository module encapsulating account export and cascade deletion queries (SEC-003) (#93)
- **Frontend**: Account tab in Settings with password-confirmed "Export account data" (JSON download) and "Delete account" (two-click confirm with 5s auto-disarm) actions (SEC-003) (#93)
- **Frontend**: `api.exportAccountData(password)` and `api.deleteAccount(password)` client methods (SEC-003) (#93)

- **Crawler**: robots.txt compliance — fetches and parses `robots.txt` before crawling; `Disallow` paths are skipped in both link-crawl (`crawlBrowser.js`) and state exploration (`stateExplorer.js`); `Sentri`-specific user-agent group takes priority over wildcard; longest-prefix matching with Allow/Disallow precedence per RFC 9309 (#53) (#96)
- **Crawler**: sitemap.xml discovery — loads sitemap URLs from `robots.txt` `Sitemap:` directives or conventional `/sitemap.xml`; follows one level of `<sitemapindex>` indirection; seeds discovered URLs into the crawl/exploration queue so important pages are not missed when they lack inbound `<a>` links (#53) (#96)

### Fixed
- **Crawler**: State fingerprint now includes significant query parameters (`category`, `sort`, `view`, `tab`, `page`, `filter`, `q`, etc.) — previously all query params were stripped, causing `/products?category=electronics` and `/products?category=books` to be treated as the same state (#52) (#96)
- **Crawler**: Numeric path segments normalised to `:id` pattern in state fingerprint — `/users/123` and `/users/456` now produce the same route fingerprint while remaining distinct from `/posts/456` (#52) (#96)
- **Crawler**: Dynamic text (order numbers, item counts, prices, timestamps) normalised in visible content hash — prevents trivially different button text like "Order #12345" vs "Order #12346" from creating duplicate states (#52) (#96)
- **Crawler**: UI component inventory (sidebar, dropdown, toast, accordion, spinner, error/empty states) now included in state fingerprint — pages with the same headings but different component layouts (e.g. sidebar visible vs collapsed) are correctly distinguished (#52) (#96)
- **Crawler**: SPA framework detection (React, Vue, Angular, Svelte) and loading/error/empty state markers included in state fingerprint for better SPA state discrimination (#52) (#96)
- **Crawler**: Per-URL state cap replaced with diversity-aware scaling — base cap of 3 states per URL scales up to 8 when existing states are structurally diverse, allowing multi-step wizards (e.g. `/checkout` with 5+ steps) to be fully explored (#52) (#96)
- **Crawler**: Link crawling in `stateExplorer.js` now preserves significant query params instead of stripping all of them — noise params (UTM, session, token) are still removed (#52) (#96)
- **Crawler**: `buildUserJourneys()` link-graph adjacency now correctly resolves outbound links when crawled page URLs include significant query params — previously the param-stripped `outboundLinks` from `pageSnapshot.js` failed to match against param-bearing `classifiedByUrl` keys, breaking cross-page journey discovery (#52) (#96)
- **Backend**: `notificationSettingsRepo.getByProjectId()` now converts SQLite INTEGER `enabled` (0/1) to JS boolean — previously the API returned `enabled: 1` instead of `enabled: true`, inconsistent with the `scheduleRepo` pattern and the API contract (FEA-001) (#92)
- **Backend**: BullMQ worker retry logic no longer persists terminal state (failed status, activity log, SSE event) on non-final attempts — previously a failed first attempt wrote `status: "failed"` to the DB before BullMQ retried, causing duplicate activity logs, duplicate SSE events, and status overwrites (INF-003) (#92)
- **Backend**: Abort endpoint now checks `workerAbortControllers` for BullMQ-processed runs — previously only the in-process `runAbortControllers` registry was consulted, so aborting a BullMQ run updated the DB but the worker continued executing and overwrote the status (INF-003) (#92)
- **Backend**: BullMQ worker success path now checks `signal.aborted` before persisting — prevents the worker from overwriting `status: "aborted"` and "skipped" entries written by the abort endpoint when the abort fires between pipeline completion and `runRepo.save()` (INF-003) (#92)
- **Backend**: Abort endpoint re-reads run from DB after signalling BullMQ abort — previously used a stale snapshot for skipped-test calculation, potentially missing results flushed by `testRunner` between the initial read and the abort signal (INF-003) (#92)
- **Backend**: GDPR account export now includes `runLogs` from the `run_logs` table — post-ENH-008 runs store log lines in `run_logs` instead of the `runs.logs` JSON column; the export was missing all log data for post-migration runs (SEC-003) (#92)
- **Docker**: SPA fallback for CSP nonce injection now works in multi-container deployments — frontend dist is shared with the backend via a Docker named volume (`frontend_dist`) and `SPA_INDEX_PATH` env var; previously `serveIndexWithNonce()` returned 404 because the backend container had no access to the built `index.html` (SEC-002) (#92)

### Security
- **CSP**: Replaced `'unsafe-inline'` in `script-src` with per-request cryptographic nonce — generates `crypto.randomBytes(16)` nonce per request, passes it to Helmet CSP directive, and injects `nonce="__CSP_NONCE__"` placeholder on all `<script>` tags via Vite plugin; `serveIndexWithNonce()` replaces the placeholder at serve-time (SEC-002) (#93)
- **SSRF**: Notification webhook URLs are now validated with full SSRF protection at write time (`PATCH /notifications`) and at fetch time (`safeFetch`) — rejects private IPs, localhost, `.internal`/`.local` hostnames, non-http protocols, and DNS-rebinding attacks; SSRF logic extracted from `trigger.js` into shared `utils/ssrfGuard.js` (FEA-001) (#92)
- **Account**: Account export strips `passwordHash` from the user profile before including it in the JSON payload — prevents offline brute-force attacks if the export file is shared (SEC-003) (#93)
- **Account**: Password confirmation failures on export/delete return 403 (not 401) to prevent the frontend from misinterpreting them as session expiry and triggering an unexpected logout redirect (SEC-003) (#93)

## [1.5.0] — 2026-04-17

### Added
- **Auth**: Email verification on registration — new users must verify their email address before signing in; verification link sent via Resend, SMTP, or console fallback (SEC-001) (#87)
- **API**: `GET /api/auth/verify?token=` — verify email address using a signed token from the verification email (SEC-001) (#87)
- **API**: `POST /api/auth/resend-verification` — resend the verification email for unverified accounts; rate-limited and enumeration-safe (SEC-001) (#87)
- **DB**: Migration 003 — `verification_tokens` table and `emailVerified` column on `users`; existing users grandfathered as verified (SEC-001) (#87)
- **Frontend**: Login page shows "verify your email" state with resend button when registration requires verification or login is blocked for unverified accounts (SEC-001) (#87)
- **Backend**: `emailSender.js` utility — transactional email abstraction supporting Resend API, SMTP (via nodemailer), and console fallback for development (SEC-001) (#87)
- **DB**: PostgreSQL support with SQLite fallback — set `DATABASE_URL=postgres://…` to use PostgreSQL instead of SQLite; both backends expose the same adapter interface so all repository modules work unchanged (INF-001) (#87)
- **DB**: `sqlite-adapter.js` and `postgres-adapter.js` — database adapter modules implementing the unified `prepare`/`exec`/`transaction`/`pragma`/`close` interface (INF-001) (#87)
- **DB**: Dialect-aware migration runner — automatically translates SQLite-specific SQL (AUTOINCREMENT, datetime, INSERT OR IGNORE/REPLACE, LIKE) to PostgreSQL when running against a PostgreSQL backend (INF-001) (#87)
- **Docker**: Optional PostgreSQL service in `docker-compose.yml` — activate with `docker compose --profile postgres up` (INF-001) (#87)
- **Infra**: Redis support for rate limiting, token revocation, and SSE pub/sub — set `REDIS_URL` to enable; falls back to in-memory stores when Redis is not configured (INF-002) (#87)
- **Auth**: Token revocation now writes to both Redis (with TTL) and the local Map, so revocations survive server restarts and are visible across instances (INF-002) (#87)
- **API**: Rate limiters (`express-rate-limit`) use `rate-limit-redis` store when Redis is available, sharing counters across all instances (INF-002) (#87)
- **SSE**: Run events are published to Redis pub/sub channels; SSE endpoints subscribe per-run so events from any instance reach all connected browsers (INF-002) (#87)
- **Docker**: Optional Redis service in `docker-compose.yml` — activate with `docker compose --profile redis up` (INF-002) (#87)

### Fixed
- **DB**: PostgreSQL adapter `namedToPositional` now masks string literals before `@` replacement — prevents `'user@example.com'` from being treated as a parameter placeholder (INF-001) (#87)
- **DB**: PostgreSQL adapter `questionToNumbered` now masks string literals before `?` replacement — prevents `'What?'` from being treated as a parameter placeholder (INF-001) (#87)
- **DB**: PostgreSQL adapter `LIKE→ILIKE` translation is now case-insensitive — both `LIKE` and `like` are correctly translated (INF-001) (#87)
- **DB**: PostgreSQL adapter `exec()` now splits multi-statement SQL and executes each statement individually — prevents DDL failures when combining `CREATE TABLE` + `CREATE INDEX` (INF-001) (#87)
- **DB**: PostgreSQL adapter deasync transaction path now uses `AsyncLocalStorage` for concurrency-safe query routing — prevents concurrent requests from routing queries through the wrong transaction client (INF-001) (#87)
- **DB**: PostgreSQL adapter pg-native path now auto-reconnects on connection loss (e.g. PostgreSQL restart, TCP timeout) — retries the query once after a fresh `connectSync()` (INF-001) (#87)
- **Auth**: OAuth login with a previously-registered unverified email now auto-verifies the account — prevents permanent password login blockage when OAuth links to an unverified user (SEC-001) (#87)
- **Frontend**: `Login.jsx` resend verification now uses `api.resendVerification()` instead of raw `fetch()` — fixes missing CSRF token and follows AGENT.md conventions (SEC-001) (#87)
- **Infra**: Redis rate-limit store now initialises based on client existence (`redis !== null`) instead of `isRedisAvailable()` — fixes race condition where the async `connect` event hadn't fired yet at module evaluation time (INF-002) (#87)
- **Infra**: Graceful shutdown now wrapped in try/catch with fallback `process.exit(1)` — prevents the process from hanging if an error occurs during shutdown (MAINT-013) (#87)
- **CI**: Added PostgreSQL + Redis integration smoke test job — validates the full auth flow (register → login → CRUD → logout → token revocation) against real PostgreSQL and Redis services (INF-001, INF-002) (#87)
- **Tests**: Added `postgres-adapter.test.js` — 16 unit tests covering all SQL translation functions (LIKE→ILIKE, datetime, AUTOINCREMENT, INSERT OR IGNORE/REPLACE, multi-statement, string literal safety) (INF-001) (#87)

### Security
- **Auth**: Login blocked for unverified email accounts — returns `403` with `EMAIL_NOT_VERIFIED` code; prevents account spoofing via unclaimed email addresses (SEC-001) (#87)

## [1.4.0] — 2026-04-16

### Added
- **API**: Dedicated `run_logs` table replaces O(n²) JSON read-modify-write on `runs.logs` — each log line is now a single INSERT row; readers get stable ordering via monotonic `seq` counter (ENH-008) (#85)
- **API**: CI/CD webhook trigger endpoint `POST /api/projects/:id/trigger` — token-authenticated (Bearer), returns `202 Accepted` with `{ runId, statusUrl }` for polling; supports optional `callbackUrl` for completion notification (ENH-011) (#85)
- **API**: Per-project trigger token management — `POST /api/projects/:id/trigger-tokens` (create, returns plaintext once), `GET /api/projects/:id/trigger-tokens` (list, no hashes), `DELETE /api/projects/:id/trigger-tokens/:tid` (revoke) (ENH-011) (#85)
- **Security**: Trigger tokens are stored as SHA-256 hashes — plaintext is shown exactly once at creation and never persisted (ENH-011) (#85)
- **Frontend**: Dedicated Automation page (`/automation`) — cross-project hub for CI/CD trigger tokens and scheduled runs, with per-project expandable accordion cards, shared integration snippets with project selector, and deep-link support via `?project=PRJ-X` (ENH-011) (#85)
- **Frontend**: "⚡ Automation" quick-link in ProjectHeader navigates to the Automation page with the current project pre-expanded (#85)
- **Nav**: "Automation" entry added to the sidebar navigation with ⚡ icon (#85)
- **Automation**: Cron-based test scheduling engine — configure automated regression runs per project via a 5-field cron expression and IANA timezone; schedules survive server restarts and are hot-reloaded on save without a process restart (ENH-006) (#85)
- **Automation**: `ScheduleManager` component — inline cron editor with preset picker (hourly, daily, weekly, etc.), timezone selector, enable/disable toggle, and next-run time display; lives inside the per-project Automation card (ENH-006) (#85)
- **API**: `GET /api/projects/:id/schedule` — returns the current schedule or null (ENH-006) (#85)
- **API**: `PATCH /api/projects/:id/schedule` — creates or updates a project's cron schedule; validates the 5-field expression server-side (ENH-006) (#85)
- **API**: `DELETE /api/projects/:id/schedule` — removes the cron schedule and cancels the running task (ENH-006) (#85)
- **DB**: `schedules` table migration (002) — stores `cronExpr`, `timezone`, `enabled`, `lastRunAt`, `nextRunAt` per project; seeded with a `schedule` counter for `SCH-N` IDs (ENH-006) (#85)
- **ProjectHeader**: Next scheduled run time badge — shows "in Xm/Xh/Xd" when an active schedule exists, linking awareness into the project detail page (ENH-006) (#85)

### Fixed
- **API**: `callbackUrl` webhook now fires on **any** terminal state (completed, failed, aborted) — previously it only fired on success, leaving CI pipelines unnotified on failure; payload now includes `error` field (#85)
- **API**: `callbackUrl` input now capped at 2048 characters to prevent abuse via extremely long URLs (#85)
- **API**: `DELETE /api/projects/:id` response now includes `destroyedTokens` and `destroyedSchedule` counts so the frontend can warn about permanently lost automation config (#85)
- **Scheduler**: Timezone conversion in `getNextRunAt()` replaced fragile `toLocaleString` round-trip with `Intl.DateTimeFormat.formatToParts()` — spec-guaranteed approach that correctly handles DST transitions (spring-forward gaps, fall-back overlaps) (#85)
- **Scheduler**: Scheduled runs now respect `PARALLEL_WORKERS` env var instead of hardcoding `parallelWorkers: 1` (#85)
- **API**: `/api/system` endpoint now includes `activeSchedules` count from the cron task registry (#85)
- **Pipeline**: `waitFor` added to `VALID_PAGE_ACTIONS` whitelist in test validator — prevents false rejection of tests using `locator.waitFor()` (#85)
- **Frontend**: `DeleteProjectModal` now warns users about permanently destroyed CI/CD tokens and schedules before confirming project deletion (#85)
- **Frontend**: Automation preset dropdown now supports keyboard navigation (Arrow keys, Escape, focus management) for accessibility (#85)
- **Frontend**: Client-side cron validator relaxed to accept range+step (`0-30/5`) and list+range (`1-5,10`) expressions — defers full validation to server (#85)
- **Frontend**: `confirm()` calls standardised to `window.confirm()` across all automation components (#85)

### Security
- **API**: SSRF protection for `callbackUrl` hardened with DNS resolution — domains pointing to private/reserved IPs (e.g. `evil.com → 169.254.169.254`) are now blocked at validation time via `dns.promises.lookup()`; fetch uses `redirect: "error"` to prevent open-redirect bypasses; DNS is re-resolved at fetch time to mitigate rebinding attacks (#85)

### Changed
- **Data**: Run log lines are now persisted in the `run_logs` table instead of the `runs.logs` JSON column — `runRepo.getById()` hydrates `run.logs` from `run_logs` automatically so callers see no API change (ENH-008) (#85)
- **Frontend**: Duplicated `CopyButton` component extracted to `components/shared/CopyButton.jsx` — used by TokenManager and IntegrationSnippets (#85)
- **Frontend**: Duplicated date/time formatters (`fmtDate`, `fmtNextRun`) consolidated into `utils/formatters.js` as `fmtDateTimeMedium()` and `fmtFutureRelative()` (#85)
- **Frontend**: Automation component inline styles replaced with CSS classes in `features/automation.css` — 15 new `.auto-*` classes for cards, schedules, presets, and integration grid (#85)
- **Backend**: Duplicated Bearer token auth logic in trigger routes extracted to `requireTriggerToken` middleware (#85)
- **Tests**: Added `ssrf-protection.test.js` with 35 unit tests covering all IPv4/IPv6 private range detection, cloud metadata IPs, and hostname false-positive guards (#85)
- **Tests**: Added 4 timezone correctness tests for `getNextRunAt()` covering Asia/Tokyo, Europe/London, Australia/Sydney, and cross-timezone offset verification (#85)

## [1.3.0] — 2026-04-14

### Added
- **Data**: Soft-delete for tests, projects, and runs — DELETE operations now move entities to a Recycle Bin instead of permanently destroying data. Accidentally deleted tests, projects, and run history can be recovered (ENH-020)
- **Data**: Recycle Bin page in Settings — lists all soft-deleted projects, tests, and runs grouped by type, with Restore and Purge actions per item (ENH-020)
- **API**: `GET /api/recycle-bin` — returns all soft-deleted entities grouped by type, capped at 200 items per type (ENH-020)
- **API**: `POST /api/restore/:type/:id` — restores a soft-deleted entity; project restores cascade to tests and runs that were deleted at the same time (individually-deleted items are preserved in the recycle bin) (ENH-020)
- **API**: `DELETE /api/purge/:type/:id` — permanently and irreversibly deletes a soft-deleted entity (ENH-020)
- **API**: Pagination on `GET /api/projects/:id/tests`, `GET /api/tests`, and `GET /api/projects/:id/runs` — pass `?page=N&pageSize=N` to receive `{ data, meta: { total, page, pageSize, hasMore } }` instead of an unbounded list. Default page size is 10, configurable via `DEFAULT_PAGE_SIZE` in `backend/src/utils/pagination.js` (ENH-010)
- **API**: `GET /api/projects/:id/tests/counts` — lightweight endpoint returning per-status test counts (`{ draft, approved, rejected, passed, failed, api, ui, total }`) without fetching row data; used by the Project Detail page for accurate filter pills, tab badges, and Run button state across all pages (ENH-010)
- **Frontend**: Project Detail page now uses server-side pagination for both tests and runs tabs — only the current page is fetched from the backend instead of the entire dataset (ENH-010)
- **Frontend**: Vendor bundle splitting in Vite config — react/react-dom/react-router, recharts, lucide-react, and jspdf are emitted as separate cacheable chunks, reducing initial app bundle size (ENH-024)
- **Frontend**: `PageSkeleton` shimmer component used as the `<Suspense>` fallback for all lazily-loaded routes — replaces the plain Loading… text with an animated skeleton that matches the page layout (ENH-024)
- **Chat**: Full-page AI Chat History at `/chat` with session management — create, rename, delete, and search conversations persisted in localStorage (capped at 50 sessions per user) (#83)
- **Chat**: Export chat sessions as Markdown or JSON from the topbar menu (#83)
- **Chat**: "Open full chat page" button in the AI Chat modal navigates to `/chat` (#83)
- **Nav**: "AI Chat" entry added to the sidebar navigation (#83)

### Fixed
- **Data**: `DELETE /api/data/runs` (admin "Clear all run history") now permanently removes runs instead of soft-deleting them into the recycle bin — the admin data management action is intended for permanent cleanup, not recoverable deletion (ENH-020)
- **Data**: Project cascade-restore (`POST /api/restore/project/:id`) now only restores tests and runs that were deleted at the same time as the project — items individually deleted before the project are left in the recycle bin (ENH-020)
- **Data**: Cascade soft-delete (`DELETE /api/projects/:id`) is now wrapped in a SQLite transaction so all entities get the same `deletedAt` timestamp — prevents cascade-restore from missing children due to second-boundary crossing (ENH-020)
- **Frontend**: Recycle Bin error state is now cleared on reload and before restore/purge actions — previously errors were sticky and never dismissed (ENH-020)
- **Frontend**: Project Detail filter pills, tab badges, Run button count, and header stats now use server-side totals from `GET /api/projects/:id/tests/counts` — previously these were computed from only the current page of tests, showing incorrect counts with server-side pagination (ENH-010)
- **Frontend**: Paginated runs listing now includes `pipelineStats` in the lean column set — the "tests generated" count for generate-type runs was showing "—" because `pipelineStats` was excluded from the paginated query (ENH-010)
- **Frontend**: Clipboard copy in AI Chat modal restored `.catch()` handler — prevents unhandled promise rejection on non-HTTPS or when clipboard permission is denied

### Changed
- **Data**: `DELETE /api/projects/:id` now performs a soft-delete cascade — tests and runs are moved to the Recycle Bin rather than permanently erased; restore the project to recover everything (ENH-020)
- **Data**: `DELETE /api/projects/:id/tests/:testId` and bulk delete now move tests to the Recycle Bin (ENH-020)
- **Chat**: Markdown renderer (`escapeHtml`, `renderMarkdown`) extracted from `AIChat.jsx` into shared `frontend/src/utils/markdown.js` — both the modal chat and full-page chat now use the same renderer (#83)
- **Chat**: Chat session storage is scoped by authenticated user ID to prevent cross-account data leakage (#83)

## [1.2.0] — 2026-04-13

### Added
- **Settings**: AI provider API keys are now persisted to the database (AES-256-GCM encrypted at rest) and automatically restored on server startup — keys no longer need to be re-entered after every deployment or container restart (ENH-004)
- **Security**: HMAC-SHA256 signed URLs for all artifact serving (screenshots, videos, Playwright traces) — short-lived `?token=&exp=` query-param tokens replace the previous public static file serving; requires `ARTIFACT_SECRET` env var in production (ENH-007)
- **CI**: Gitleaks secrets scanning job added to CI workflow — runs on every PR and push to `main` before any build jobs proceed; configured with allowlist for CI placeholder keys and `.env.example` (ENH-030)
- **API**: `POST /api/system/client-error` endpoint — receives frontend crash reports from the `ErrorBoundary` and logs them server-side via `formatLogLine`; always returns `{ ok: true }` to avoid throwing back to an already-crashed UI (#79)

### Changed
- **Frontend**: `ErrorBoundary` extracted from `App.jsx` into its own `components/ErrorBoundary.jsx` file; adds `componentDidCatch` for server-side crash reporting to `/api/system/client-error` and a "Try again" reset button alongside Reload and Dashboard (ENH-027)

### Security
- **Artifacts**: Screenshots, videos, and trace files are no longer served as public static files — all artifact URLs are now authenticated via HMAC-signed expiring tokens (1 hour TTL, configurable via `ARTIFACT_TOKEN_TTL_MS`) (ENH-007)
- **CI**: Secrets scanning now gates the entire CI pipeline — any accidentally committed API key, JWT secret, or OAuth credential will block all builds and Docker image pushes (ENH-030)

## [1.1.0] — 2026-04-12

### Added
- **API**: Three-tier global rate limiting via `express-rate-limit` — general (300 req/15 min for all `/api/*`), expensive operations (20/hr for crawl/run), AI generation (30/hr for test generation) (#78)
- **Auth**: Password reset endpoints (`POST /api/auth/forgot-password`, `POST /api/auth/reset-password`) with DB-backed tokens that survive server restarts (#78)
- **Audit**: Per-user audit trail — every activity log entry now records `userId` and `userName` identifying who performed the action (#78)
- **Audit**: Bulk approve/reject/restore actions log individual per-test activity entries with the acting user's identity (#78)
- **Auth**: JWT `name` claim — all issued tokens now include the user's display name for audit trail attribution (#78)
- **Cookie-based auth (S1-02)** — JWT moved from `localStorage` to HttpOnly; Secure; SameSite=Strict cookies (`access_token`). Eliminates XSS-based token theft. Companion `token_exp` cookie for frontend expiry UX. CSRF double-submit cookie (`_csrf`) protection on all mutating endpoints
- **Session refresh** — `POST /api/auth/refresh` endpoint; frontend proactively refreshes 5 minutes before expiry
- **Responsive layout** — sidebar collapses to icon-rail at 768px, off-screen drawer with hamburger at 480px. Dashboard, Tests, and stat grids adapt to mobile viewports
- **Command Palette** — `Cmd/Ctrl+K` now opens a two-mode command palette instead of jumping straight to AI chat. Mode 1 (default): fuzzy-search over navigation and actions with zero LLM cost. Mode 2 (fallback): type a natural-language question to open the AI chat panel. Prefix `>` to force command mode, `?` to force AI mode
- Confirm password field on registration form
- Email validation on frontend before submission
- OAuth CSRF protection (state parameter validation)
- `parseJsonResponse` helper for user-friendly error when backend is unreachable
- GitHub Pages SPA routing (`404.html` + restore script)
- VitePress documentation site

### Fixed
- **Auth**: Password reset tokens now persisted in SQLite (`password_reset_tokens` table, migration 003) instead of in-memory Map — tokens survive server restarts and work in multi-instance deployments (#78)
- **Auth**: Atomic token claim (`UPDATE … WHERE usedAt IS NULL`) eliminates the TOCTOU race condition that allowed concurrent replay of password reset tokens (#78)
- **API**: Single-test-run endpoint (`POST /tests/:testId/run`) now correctly uses the expensive-operations rate limiter instead of the AI-generation limiter (#78)
- Docker build context in `cd.yml` — was `./backend`, now `context: .` with explicit `file:`
- JWT secret no longer hardcoded — random per-process in dev, throws in production
- `verifyJwt` crash on malformed tokens (buffer length mismatch)
- OAuth provider param whitelisted to prevent path traversal
- Consistent "Sign in" / "Sign out" terminology (was mixing "login" / "sign in")
- Password fields cleared when switching between sign-in and registration modes

### Security
- **Auth**: Password reset tokens use one-time atomic claim — two concurrent requests with the same token cannot both succeed (#78)
- **Auth**: Only the latest password reset token per user is valid — requesting a new token invalidates all prior unused tokens (#78)
- **API**: Global API rate limiting prevents abuse across all endpoints, with tighter limits on resource-intensive operations (#78)
- **JWT in HttpOnly cookies** — token never exposed to JavaScript, immune to XSS exfiltration
- **CSRF double-submit cookie** — `_csrf` cookie + `X-CSRF-Token` header validation on all POST/PATCH/PUT/DELETE
- OAuth state parameter validated before code exchange
- JWT fallback secret replaced with random per-process generation
- `verifyJwt` wrapped in try/catch with explicit buffer length check
- Backend auth docstring corrected (scrypt, not bcrypt)

### Removed
- `CodeEditorModal.jsx` — deprecated component with no imports, deleted
