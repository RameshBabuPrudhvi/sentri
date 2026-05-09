# NEXT.md — Current Sprint Target

> **For agents:** Read this file only. Do not read ROADMAP.md unless you need context on items
> beyond the current PR. Everything you need to start work is here.
>
> **For humans:** Update this file when a PR ships. Move the completed item to ROADMAP.md ✅ table,
> promote the next item from the queue below, and rewrite the "Current PR" block.

> **Bundling guidance — for agents writing code:** When working on the Current PR, if you
> spot adjacent items in the Queue (or in `ROADMAP.md`) that share files, infrastructure,
> or a natural review boundary with the in-flight scope, **flag them as bundling candidates
> in your PR description** rather than expanding the PR mid-flight. Good bundling signals:
> (1) the items touch the same module / shared abstraction, so reviewing them together
> reduces churn (e.g. CAP-004 + MET-001 share `<TrendChart>`); (2) one item validates
> another end-to-end (e.g. a CI guard validates the convention it documents);
> (3) both are S/XS effort and skipping a hand-off cycle saves more than it costs in
> review surface (e.g. AUTO-017.3 + PROC-001 in slot 2). **Bad** bundling signals: items
> in different phases, items that grow the PR past M effort, items that change the
> reviewer's mental model (UX rewrite + backend rewrite), or items the agent identifies
> *after* CI is already green on the original scope. When in doubt, surface the candidate
> bundle as a comment on the PR and let the human decide — never silently expand scope
> beyond the Current PR's `### PR checklist`. Recording the rejected candidates is also
> useful: it builds the dataset for future planning.

---

## ▶ Current PR — AUTO-001 — Risk-based test selection / ordering
**Effort:** M | **Priority:** 🟢 Differentiator | **Dependencies:** DIF-004 ✅, AUTO-002 ✅ (PR #12) | **Source:** `ROADMAP.md` Phase 4 (AUTO-001)
> AI-001 ✅ shipped in PR #14 (generic OpenAI-compatible provider slots keyed `compat:<id>`, SSRF-guarded per-call fetch with DNS-rebinding mitigation, TTL cache with Redis pub/sub invalidation, per-slot circuit breakers, Settings UI with deterministic palette colors, full FEA-003 fallback integration). Promoting AUTO-001 as previously queued — AUTO-002's `changedPages[]` signal is now available to feed the risk scorer.
Sentri runs every approved test on every trigger. An autonomous system should *order* tests by risk so the most likely-to-fail tests run first (fail-fast feedback) and budget-bounded runs cover the highest-signal slice. Risk inputs already present in the database: per-test historical pass rate (`runs.results[]`), recency of last edit (`tests.updatedAt`), self-heal frequency (CAP-004 telemetry), and — from AUTO-002 — whether the test's page changed since the last crawl. Compute a `riskScore` per test at run-planning time, sort the run queue by descending risk, and expose a `--budget=<minutes>` flag that truncates the queue when wall-clock exceeds budget (always-run smoke tests are pinned to the front regardless of score).
**Implementation sketch:**
- New pure-function scorer `backend/src/pipeline/riskScorer.js`: `(test, history, changedPages) → number`. Inputs: per-test pass rate from `runs.results[]`, `tests.updatedAt` recency boost, self-heal frequency from `healing_history`, and AUTO-002's `changedPages[]` (strong signal — 1.0 if test's `sourceUrl` changed this run).
- `backend/src/testRunner.js`: sort `runQueue` by `riskScore` DESC before dispatch; honour new `budgetMinutes` param by truncating when cumulative expected wall-clock exceeds budget. Always-run smoke tests (new `test.isSmoke` boolean) pinned to the front regardless.
- `backend/src/routes/trigger.js` + `backend/src/routes/runs.js`: accept `budgetMinutes` param, pass through to runner.
- `frontend/src/pages/RunDetail.jsx`: per-test `riskScore` chip in the run-detail table; budget-truncated tests marked with a "skipped (over budget)" status.
  **Files:** new `backend/src/pipeline/riskScorer.js` · `backend/src/testRunner.js` · `backend/src/routes/trigger.js` + `backend/src/routes/runs.js` · `frontend/src/pages/RunDetail.jsx` · new `backend/tests/risk-scorer.test.js` · `docs/changelog.md` (`### Added` entry)
  **Acceptance criteria:**
- Tests with a recent failure rank higher than tests that have been green for weeks.
- `budgetMinutes=10` truncates the queue at the 10-minute mark; pinned smoke tests still run even when truncated.
- Tests whose `sourceUrl` appears in AUTO-002's `changedPages[]` get a strong risk boost, so change-affected tests run first.
- Default behaviour with no budget is identical to today (full queue, just reordered) — zero regression for existing schedules.
  **Anti-patterns to reject in review:** hard-coding risk weights (expose via config so operators can tune) · silently dropping budget-truncated tests without a status marker (violates observability — every test must have a resolution) · ignoring AUTO-002's `changedPages[]` (the strongest available signal; not wiring it defeats the sprint rationale for promoting AUTO-001 after AUTO-002) · mutating `runQueue` in place before persistence (reorder for dispatch only — the saved run must preserve the original approved-test order for auditability).
### PR checklist (AUTO-001)
- [ ] New `backend/src/pipeline/riskScorer.js` as pure function (input: test + history + changedPages; output: number) — no DB access inside the scorer itself
- [ ] `testRunner.js` sorts the dispatch queue by `riskScore` DESC; saved run still reflects the original approved-test ordering
- [ ] `budgetMinutes` param flows through `trigger.js` / `runs.js` with a per-project max so a malformed value can't exhaust the worker pool
- [ ] Always-run smoke tests (`test.isSmoke`) are pinned to the front regardless of budget truncation
- [ ] Change-affected tests (test's `sourceUrl` ∈ AUTO-002 `changedPages[]`) receive a strong risk boost
- [ ] `backend/tests/risk-scorer.test.js` covers flaky-test ranking, recently-edited boost, smoke-test pin, budget truncation, and changedPages weighting — registered in `backend/tests/run-tests.js`
- [ ] `RunDetail.jsx` surfaces `riskScore` chip + "skipped (over budget)" status
- [ ] `docs/changelog.md` updated under `## [Unreleased]`
- [ ] Frontend consumer ships for any new backend route (PROC-001)

---

## ⏭ Queue (next 3 PRs after current)
### 1 · INT-002 — GitHub PR check comments
**Effort:** M | **Priority:** 🟢 Differentiator | **Dependencies:** none (uses existing GitHub App connection from CAP-003 / FEA secrets path) | **Source:** `ROADMAP.md` Phase 3 (INT-002)
When a Sentri run triggered by a GitHub webhook completes, post a check-run comment on the PR summarising pass/fail counts, regressed tests (with diff vs the previous run on `main`), and Web Vitals budget violations. Today the run results live only in the Sentri UI — operators have to context-switch to see them. A native PR check makes Sentri feel like a first-class CI gate and unlocks the "block merge until tests pass" workflow that matters for AUTO-003 trust.
**Files:** new `backend/src/integrations/githubChecks.js` (Checks API client — create / update / conclude) · `backend/src/routes/webhooks.js` (subscribe `pull_request` + `push` events; map to a Sentri run) · `backend/src/testRunner.js` (post check-run on completion, including regressed-test diff vs the base SHA's last green run) · `backend/src/middleware/permissions.json` · `frontend/src/pages/Settings.jsx` (per-project "Post PR checks" toggle) · `backend/tests/github-checks.test.js` (mock Octokit; assert payload shape, regression-diff logic, failure-mode posting)
**Acceptance criteria:**
- Opening / pushing to a PR on a Sentri-connected repo creates a `pending` check-run, then transitions to `success` / `failure` / `neutral` on completion.
- Failure summary includes regressed tests (failing now, green on the base SHA's last run) — not the full failing list, which would be noisy on red branches.
- Web Vitals budget violations appear as a separate bullet so they don't get lost in the test-failure list.
- The integration is opt-in per project; existing projects see no behaviour change until the toggle is flipped.
### 2 · AUTO-004 — Test impact analysis from git diff
**Effort:** M | **Priority:** 🟢 Differentiator | **Dependencies:** AUTO-002 (shipped in PR #12) — consumes the `changedPages[]` signal and extends it to file-level mapping | **Source:** `ROADMAP.md` Phase 4 (AUTO-004)
Today Sentri runs every approved test on every CI trigger. With AUTO-002's baseline mechanism in place and AUTO-001's risk scorer consuming `changedPages[]`, the next step is mapping file-level git-diffs to affected tests: when a PR touches `src/checkout/CartPage.tsx`, only the tests whose crawl snapshots include elements from that component should run. This is the "smart subset" that makes Sentri viable on large suites where running the full regression on every push is prohibitive. The mapping is built by cross-referencing each test's `sourceUrl` + captured elements against the file paths extracted from the git diff (via GitHub's PR files API, already available on the webhook path), then unioning the file→URL mapping with AUTO-002's `changedPages[]` signal.
**Files:** new `backend/src/pipeline/impactAnalysis.js` (git-diff → affected-test mapper, pure function: `{ changedFiles: string[], testsWithSnapshots: Test[] } → Test[]`) · `backend/src/routes/trigger.js` (accept `changedFiles[]` in the webhook payload, pass through to impact analysis, scope the run queue) · `backend/src/testRunner.js` (honour the scoped queue) · `frontend/src/pages/RunDetail.jsx` (new "Impact scope" panel showing which files drove the test selection) · `backend/tests/impact-analysis.test.js` (file→URL mapping correctness, empty-diff fallback, unknown-file graceful degradation)
**Acceptance criteria:**
- `changedFiles: ["src/checkout/CartPage.tsx"]` in the webhook payload scopes the run to tests whose snapshots touched `/checkout/*` URLs.
- Empty `changedFiles` (or absent) falls back to current behaviour (full suite) — zero regression.
- Unknown file paths (schema migrations, docs, config) produce an empty subset → run is marked `skipped_no_impact` rather than running the full suite.
- The mapping merges with AUTO-002's `changedPages[]` — a page that's both DOM-changed AND file-affected is the strongest signal.
### 3 · CAP-001 — Data-driven testing (parameterized iterations)
**Effort:** M | **Priority:** 🟢 Differentiator | **Dependencies:** none | **Source:** `ROADMAP.md` Phase 4 (CAP-001)
Generated tests are single-shot — one assertion path, one input set. Industry-standard practice (Cypress, Playwright `test.describe.serial` + fixtures, Mabl iterations) is to run the same test against N data rows from a CSV / JSON fixture, with one Run row per iteration so failures are attributable to a specific row. Sentri has no fixture concept today, so testing edge-case data combinations means hand-authoring N near-identical tests. Add per-test fixture upload (CSV / JSON) stored as a `test_fixtures` table row; extend the runner to iterate over fixture rows when present, substituting placeholders in `playwrightCode` (e.g. `{{email}}` → row value).
**Files:** new migration — `test_fixtures` table keyed on `(testId, version)` with `format` (`"csv"` | `"json"`), `rows` (TEXT JSON), `createdAt` · new `backend/src/database/repositories/testFixtureRepo.js` · `backend/src/runner/executeTest.js` (iterate over fixture rows, emit per-iteration result rows with `iterationIndex`) · `backend/src/routes/tests.js` (`POST /api/v1/tests/:testId/fixtures` upload, `GET …/fixtures` list) · `backend/src/middleware/permissions.json` (qa_lead+ on mutations) · `frontend/src/pages/TestDetail.jsx` (fixture upload + preview) · `frontend/src/components/run/StepResultsView.jsx` (per-iteration sub-table) · `backend/tests/fixture-iteration.test.js`
**Acceptance criteria:**
- Uploading a 5-row CSV fixture to a test produces 5 iteration results on the next run, each with an `iterationIndex` field.
- Per-project iteration cap (default 10, max 100) so a 10k-row CSV can't exhaust the worker pool.
- Tests without fixtures behave identically to today (single iteration, no sub-table) — zero regression.
- Failed iterations are attributable to a specific row (`iterationIndex` + row snapshot in the result payload).
---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| AI-001 | Generic OpenAI-compatible provider slots (BYO endpoint). New `compat:<id>` provider type (`backend/src/aiProvider.js` + `backend/src/database/repositories/apiKeyRepo.js` `listCompatSlots` / `getCompatSlot` / `setCompatSlot` / `deleteCompatSlot`) persisting `{ baseUrl, model, apiKey, displayName }` as AES-encrypted JSON. Per-call SSRF-guarded fetch wrapper (`createSsrfGuardedFetch()`) re-validates the baseURL on every OpenAI SDK call (DNS-rebinding mitigation) and sets `redirect: "error"` to block 3xx escapes to private / link-local / cloud-metadata addresses. New TTL cache `backend/src/utils/compatConfigCache.js` (default 60s, `COMPAT_CONFIG_CACHE_TTL_MS` override) with write-through invalidation on `setCompatSlot` / `deleteCompatSlot` and Redis pub/sub coherence across instances (`sentri:compat-config:invalidate`, self-echo suppressed via origin id). Compat slots participate in auto-detection, FEA-003 fallback chain, per-slot circuit breakers, and both `callProvider` / `streamText` paths. Backend-enforced slot-id validation (`^[a-z0-9_-]+$`), required-field checks, and async `validateUrl()` SSRF on compat saves. `ALLOW_PRIVATE_URLS=true` escape hatch **scoped exclusively** to compat saves + the guarded fetch — trigger callbacks, preview URLs, and notification webhooks remain SSRF-protected. Settings UI with `<datalist>` hints for common vendors (DeepSeek / Groq / Mistral / xAI) + Edit/Delete per slot; `ProviderBadge` renders deterministic palette colors (`COMPAT_PALETTE` hashed by slot id). New tests `backend/tests/openai-compat-provider.test.js` + `backend/tests/compat-config-cache.test.js` (registered in `run-tests.js`) cover error classification, SSRF rejection, `ALLOW_PRIVATE_URLS` scoping, mock-SDK baseURL routing + per-slot circuit-breaker independence, per-call DNS-rebinding mitigation, read-through cache, TTL expiry, write-through invalidation, cross-process coherence, self-echo suppression. Gitleaks allowlist updated. | #14 |
| AUTO-002 + AUTO-015 (bundled) | Change detection / diff-aware crawling (`crawl_baselines` table + `crawlBaselineRepo` with `mergeProjectBaselines` partial-crawl-safe upserts + `crawlDiff` primitive reusing `stateFingerprint.js`) + continuous test discovery on deployment events (Vercel `X-Vercel-Signature` HMAC-SHA1 + Netlify `X-Netlify-Token` HMAC-SHA256 webhooks, dual-auth via `requireTrigger` + signature, SSRF-guarded preview URL, `triggerCrawl: true` on POST /trigger). Shared `runDiffAwareBaseline(project, run, snapshots, mode)` helper handles **both** link-crawl and state-explorer modes — state mode uses composite keys (`url#fp=<fingerprint>`) so distinct states at the same URL (AUTO-002b) track as separate baseline rows. `pages_changed` SSE event wired into Test Lab live view via `useProjectRunMonitor` → `ActiveRunBanner` ("N pages changed → regenerating only those" replaces generic progress bar). Migration `019_crawl_baselines.sql` + migration `020_run_changed_pages.sql` (`runs.changedPages` + `runs.removedPages` JSON columns registered in `runRepo.JSON_FIELDS` + `INSERT_COLS`). `canonicalUrl` preservation on preview crawls prevents production-baseline corruption (`project.url` is overridden to `previewUrl` in `trigger.js` but `project.canonicalUrl` is set to the original, used by `sameOrigin` guard). `crawl.start.deployment` activity marker (AUTO-015b) + new `GET /api/v1/projects/:id/last-deployment-run` route powers the "Last deployment run" chip on `ProjectHeader.jsx` (24h window, navigates to run on click). `dialsConfig` honoured on `triggerCrawl` path + webhook-launched preview crawls. `req.rawBody` capture scoped to webhook routes only (avoids global Buffer copy). End-to-end happy-path test in `deployment-triggers.test.js` asserts webhook → run dispatch + activity marker; `crawl-diff.test.js` covers all 8 scenarios (added/changed/unchanged/removed, first-crawl fallback, null/undefined baseline, no-change, empty current crawl, state-mode composite keys, fingerprint stability); dedicated `crawl-baseline-repo.test.js` per REVIEW.md. AGENT.md gained new "Issue-handling rule" section codifying the "every finding produces an outcome (fix or ROADMAP entry), never a silent gap" norm. | #12 |
| AUTO-003 + AUTO-003b (bundled) | Confidence scoring & auto-approval of low-risk tests + provenance / audit trail | #10 |
| AUTO-017.3 + PROC-001 | Web Vitals trend charts on `ProjectQualityCard` (LCP / CLS / INP / TTFB) backed by per-run averages from `recordMetric()` in `backend/src/testRunner.js` via new `GET /api/v1/projects/:id/metrics` route + `useProjectMetricQuery` hook (fail-soft — transient API errors render an empty trend, not a banner); threshold lines sourced from `project.webVitalsBudgets`. **PROC-001:** new `.github/workflows/no-orphan-routes.yml` fails PRs that add a `router.<method>(…)` in `backend/src/routes/*.js` without touching `frontend/src/api.js` / pages / components; `[no-ui]` PR-title opt-out for genuinely UI-less endpoints. Convention documented in `REVIEW.md`, `AGENT.md`, `CONTRIBUTING.md`, and the PR template. New `backend/tests/web-vitals-trend.test.js` locks down that the recorded sample is the per-run average (not the budget); `backend/tests/quality-gates.test.js` extended with HTTP-level coverage for the new metrics route (400 / 404 / 200 + `limit` clamp). PROC-003 (sprint-promotion auto-prune) was reverted in PR #10 — the regex transforms had too many edge cases and the canonical hand-off is the manual checklist in `REVIEW.md § Sprint Tracker Hand-off`. | #9 |

*Full completed list → ROADMAP.md § Completed Work*
