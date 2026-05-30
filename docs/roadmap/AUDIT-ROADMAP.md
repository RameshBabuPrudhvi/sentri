# Sentri — Audit Resolution Roadmap (May 2026)

> **Source:** Principal Engineer Deep-Dive Audit, May 2026 — rewritten against the
> `sentri-codex` codebase (PR #38 tip, AUTO-023 fully shipped, MNT-015 ✅).
>
> **How to use:** Paste the Phase 6 section into `ROADMAP.md` after the existing
> Phase 5 block. Every item follows the existing ID / status / effort / dependency
> / files-to-change / acceptance-criteria shape so agents (Devin, Claude Code,
> Codex) can execute them directly from NEXT.md without re-reading this file.
>
> **Bundling:** 27 granular issues collapse into **8 delivery bundles** —
> matching how every major feature in this codebase has shipped (AUTO-023 = 5
> bundles, CAP-002b = 10 sub-items under one entry). Bundle IDs are the
> canonical tracking unit; individual issue IDs inside each bundle are
> sub-items for checklist use.

---

## What changed since the previous audit target

The previous audit was written against `sentri-develop`. This codebase is
materially ahead. Items that were P0 blockers in the previous report are
**already shipped** here:

| Previous P0 / gap | Status in this codebase |
|---|---|
| pixelmatch vision heal (stage 7) stubbed | ✅ `visionHealAdapters.js` — full sliding-window CV shipped (MNT-001b) |
| Single-process architecture, no pool | ✅ `browserPool.js` warm process pool — MNT-015 PR #1 |
| No multi-agent coordination | ✅ AUTO-023 Bundles 1–5 fully shipped (PR #34–#38) |
| No reviewer–author loop | ✅ `agentLoop.js` `runReviewerAuthorLoop` + `ReviewRejection` |
| No SIEM / audit log | ✅ SEC-007 `workspaceSiemConfigRepo.js` + audit DLQ shipped PR #12 |
| No test fixture management | ✅ `testFixtureRepo.js` (CAP-001) shipped PR #1 |
| No coverage tracking | ✅ AUTO-009 V8 coverage + regression alerts shipped PR #19 |
| No K8s / DR | ✅ INF-009 Helm chart + DR playbook shipped PR #30 |
| No per-workspace AI rate limiting | ✅ `aiRateLimit.js` cost-weighted limiter shipped PR #1 |
| No shadow DOM traversal | ✅ Recursive shadow root walk in `crawlBrowser.js` (multi-level) |

**Remaining enterprise readiness score: 5.5 / 10** (up from 3.5 in the
previous audit). The gaps below are the honest delta between where this
codebase sits today and what "industry-standard autonomous QA platform" requires.

---

## How to Read This Document

| Symbol | Meaning |
|---|---|
| 🔴 P0 Blocker | Must ship before any enterprise or production claim |
| 🟡 P1 High | Ship within the next two sprints after the P0 wave |
| 🔵 P2 Medium | Materially improves quality; schedule after P1 wave |
| 🟢 Strategic | Competitive moat; schedule last |
| ✅ Complete | Merged to `main` |
| 🔲 Planned | Scoped and ready |

**Effort sizing** (2-engineer team): `XS` <1 day · `S` 1–2 days ·
`M` 3–5 days · `L` 1–2 weeks · `XL` 2–4 weeks

---

## Phase 6 — Audit Resolution (May 2026 against PR #38 tip)

*Target: enterprise readiness 5.5 / 10 → 8.5 / 10 on completion.*

---

### Bundle 1 (B1) — Run persistence and crash recovery 🔴 P0

**Covers sub-items:** RLY-001 (run checkpointing), RLY-008 (SQLite write
contention), RLY-005 (snapshot memory safety)

**Status:** ✅ Complete (PR #2) | **Effort:** L | **Source:** Audit §A.2 · §J Scenarios 1–4

**Shipped artefacts (PR #2):**

- Migrations `065_run_test_results.sql`, `066_crawl_snapshots.sql`,
  `067_run_checkpoint.sql`. All three carry `ON DELETE CASCADE` on `runId`
  for SOC 2 CC8.1 audit-trail integrity.
- `runTestResultRepo.js` (B1.1) — append-only repo with `INSERT OR IGNORE`
  idempotency, `getCompletedTestIds()` for the resume checkpoint, and the
  duplicate-write counter `app_run_test_result_duplicates_total{reason}`.
- `crawlSnapshotRepo.js` (B1.3) — wired into both `crawlBrowser.js`
  (`page.goto` timing → `loadMs`) and `stateExplorer.js#captureState()`.
- `utils/dbWriteQueue.js` (B1.2) — tiered-durability queue: `"batched"`
  (default, lossy on SIGKILL) and `"durable"` (synchronous BEGIN/COMMIT,
  lose-nothing). Matches Postgres `synchronous_commit` / Kafka `acks` /
  MySQL `sync_binlog` industry pattern. Poison-pill replay skips the
  failing slot so a single bad write never drops siblings.
- `testRunner.js` per-test flush uses `priority: "durable"` — checkpoint
  writes are crash-durable matching GitHub Actions `re-run failed jobs`
  / CircleCI `rerun-from-failed` / AWS Step Functions / Temporal
  checkpoint semantics. The legacy `runRepo.save(run)` /
  `runRepo.appendRunResults()` paths are preserved so pre-B1 consumers
  reading `run.results` keep working.
- `runRepo.markOrphansInterrupted()` returns `{ count, ids }` and stamps
  `failureReason='process_crash'` distinct from user-abort and ordinary-
  failure rows. Graceful-shutdown drain plumbed through `index.js` AND
  the standalone `worker.js` (the primary execution environment for
  BullMQ-dispatched runs) so SIGTERM loses no buffered writes.
- `POST /api/v1/runs/:runId/resume` admin-only endpoint replays env +
  testQueue from the persisted run row, skips tests already in
  `run_test_results`, gates against active sibling runs / wrong status
  / missing env / no-remaining-tests. RunDetail surfaces a `Resume`
  button + an `Interrupted` badge for crash-recovered runs;
  `frontend/src/api.js#resumeRun` helper.
- Four Prometheus metrics: `app_db_write_queue_depth`,
  `app_db_write_batch_duration_seconds`, `app_db_write_batch_size`,
  `app_run_test_result_duplicates_total{reason}`.
- Tests: `backend/tests/run-checkpoint.test.js` (7 cases),
  `backend/tests/db-write-queue.test.js` (8 cases),
  `backend/tests/crawl-snapshot-streaming.test.js` (8 cases) — all
  registered in `backend/tests/run-tests.js`.
- `.env.example`: `DB_WRITE_BATCH_SIZE`, `DB_WRITE_FLUSH_MS`,
  `CHECKPOINT_STALE_MS`.

**Scope deviations from the original spec (intentional):**

- Migration numbers landed as `065/066/067` (not `062/063/064` from the
  original write-up) because `061_agent_messages.sql` shipped on a
  parallel PR before B1 merged.
- B1.3 ships as **persistence-only**, not as the per-page generation
  pipeline-inversion the original spec described. Per-page generation
  would break (a) cross-page journey discovery via `buildUserJourneys`
  in `crawler.js`, (b) diff-aware baseline filtering, and (c) cross-page
  PII sanitisation in `sanitizeRunInputs`. The legacy in-memory
  `snapshots[]` accumulation is kept as the shadow path during the B1
  → B2 transition. Heap stays O(N pages) for the duration of the crawl
  but per-page persistence still gives crash-recovery + B2's `loadMs`
  consumer. A follow-up roadmap item should track the pipeline
  redesign if O(N) heap is later measured to be a real problem on
  customer crawls.

**Problem (three tightly-coupled issues, one migration sprint):**

1. **No checkpointing.** `run.results[]`, `run.logs[]`, and healing events
   accumulate in memory on the `run` object and flush to the DB only at
   run completion inside `testRunner.js`. A process crash, OOM kill, or
   SIGKILL mid-run discards every result collected so far. A 500-test suite
   that crashes at test 490 restarts from zero — no resume mechanism exists.

2. **SQLite write serialisation under parallel workers.** When
   `parallelWorkers > 1`, concurrent `executeTest.js` workers write to
   `healing_history` and `run_logs` simultaneously. SQLite WAL serialises
   writers — at `parallelWorkers = 10` the effective throughput collapses
   to roughly 60% of configured capacity.

3. **Snapshot memory accumulation.** `crawlBrowser.js` and
   `stateExplorer.js` accumulate all page snapshots in `run.snapshots[]`
   before pipeline Stage 4 begins. A 200-page enterprise crawl reaches
   200 MB+ in heap before a single test is generated. A 512 MB container
   OOMs and kills the pipeline with zero results.

**Fix (three coordinated changes, one PR):**

**B1-1 — Per-test result flush (RLY-001):**
After each test completes in `testRunner.js`, immediately append its result
to a new `run_test_results` append-only table rather than accumulating in
`run.results[]`. `runRepo.getById()` reconstructs `results[]` by joining
this table on demand. Persist healing events per-test inside the test's
`finally` block (they are already written to `healingRepo` in
`healingPersistence.js` — the fix is calling that per-test, not in the
run-level `finally`).

On server restart, any run with `status = 'running'` and no result flush in
the last `CHECKPOINT_STALE_MS` (default 60 000 ms) transitions to `failed`
with `failureReason: 'process_crash'`.

Add `POST /api/v1/runs/:id/resume` (admin-only, `permissions.json` entry)
that re-enqueues only tests whose `testId` does NOT appear in
`run_test_results` for this `runId`. The existing BullMQ job dispatcher
picks up from the checkpoint.

**B1-2 — Write-batching queue (RLY-008):**
New `backend/src/utils/dbWriteQueue.js` — a generic queue accepting
`{ fn }` closures. A `setImmediate` flush loop drains the queue in batched
`db.transaction()` calls (up to `DB_WRITE_BATCH_SIZE = 50` operations,
default flush interval `DB_WRITE_FLUSH_MS = 100` ms). Route the three
highest-frequency write paths — `healingRepo.set()`,
`run_test_results append`, and `runLogRepo.append()` — through the queue on
SQLite. For PostgreSQL (`db.dialect === 'postgres'`), skip the queue
entirely and call direct. Drain synchronously in the graceful-shutdown
sequence before `closeDatabase()`. Add `app_db_write_queue_depth` Prometheus
gauge and `app_db_write_batch_duration_seconds` histogram.

**B1-3 — Snapshot streaming (RLY-005):**
Replace end-of-crawl snapshot accumulation with a stream-and-generate
pattern. As each page is crawled, immediately persist its snapshot JSON to
a new `crawl_snapshots` table (keyed `runId + url`) and call
`generateAllTests()` for that page before crawling the next. Peak heap
drops from O(N pages) to O(1 page + 1 generation context). Remove
`run.snapshots[]` from the in-memory run object; `GET /runs/:id` returns
`{ snapshotCount: N }` instead of the full array. Add `CRAWL_MAX_SNAPSHOT_MB`
env (default 50) — a single snapshot exceeding this is truncated at
`elementFilter.js`'s cap with a warning log.

**Migrations:**
```sql
-- NNN_run_test_results.sql
CREATE TABLE run_test_results (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  testId TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  duration INTEGER,
  retryCount INTEGER DEFAULT 0,
  artifacts TEXT,
  healingEvents TEXT,
  createdAt TEXT NOT NULL,
  UNIQUE(runId, testId)
);
CREATE INDEX idx_rtr_runId ON run_test_results(runId);

-- NNN_crawl_snapshots.sql
CREATE TABLE crawl_snapshots (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  snapshotJson TEXT NOT NULL,
  loadMs INTEGER,
  createdAt TEXT NOT NULL,
  UNIQUE(runId, url)
);
CREATE INDEX idx_cs_runId ON crawl_snapshots(runId);

-- NNN_run_checkpoint.sql
ALTER TABLE runs ADD COLUMN failureReason TEXT;
ALTER TABLE runs ADD COLUMN reviewRejectedTests TEXT DEFAULT '[]';
```

**Files to change:**
- `backend/src/database/migrations/NNN_run_test_results.sql` (new)
- `backend/src/database/migrations/NNN_crawl_snapshots.sql` (new)
- `backend/src/database/migrations/NNN_run_checkpoint.sql` (new)
- `backend/src/database/repositories/runTestResultRepo.js` (new) —
  `append(runId, result)`, `getByRunId(runId)`, `getCompletedTestIds(runId)`
- `backend/src/database/repositories/crawlSnapshotRepo.js` (new) —
  `save(runId, url, snapshot, loadMs)`, `getByRunId(runId)`
- `backend/src/utils/dbWriteQueue.js` (new) — batching queue with
  SQLite/PostgreSQL dialect detection
- `backend/src/testRunner.js` — call `runTestResultRepo.append()` after each
  test; build `run.results[]` from repo at run end; call `dbWriteQueue.drain()`
  in shutdown; move `healingPersistence` call inside per-test `finally`
- `backend/src/runner/healingPersistence.js` — expose per-test flush function
  (currently only called post-run)
- `backend/src/pipeline/crawlBrowser.js` — persist each snapshot via
  `crawlSnapshotRepo.save()` immediately; call `generateAllTests()` per page;
  record `loadMs` per page for B2's adaptive timeout
- `backend/src/pipeline/stateExplorer.js` — same per-snapshot persist
- `backend/src/pipeline/pipelineOrchestrator.js` — accept
  `crawlSnapshotRepo` as stream source instead of in-memory map
- `backend/src/database/repositories/runRepo.js` — exclude `snapshots` from
  lean `getById()`; add `snapshotCount` derived field; add `failureReason`
  column; stale-run cleanup on startup
- `backend/src/routes/runs.js` — `POST /runs/:id/resume` (admin-only);
  expose `snapshotCount`, `failureReason` in run response
- `backend/src/middleware/permissions.json` — register `runs.resume` as
  `admin`-only
- `backend/src/utils/metrics.js` — `app_db_write_queue_depth` gauge,
  `app_db_write_batch_duration_seconds` histogram
- `backend/src/index.js` — `dbWriteQueue.drain()` in graceful-shutdown
  sequence (after `browserPool.drainAndClose()`, before `closeDatabase()`)
- `backend/.env.example` — `DB_WRITE_BATCH_SIZE`, `DB_WRITE_FLUSH_MS`,
  `CHECKPOINT_STALE_MS`, `CRAWL_MAX_SNAPSHOT_MB`
- `backend/tests/run-checkpoint.test.js` (new)
- `backend/tests/db-write-queue.test.js` (new)
- `backend/tests/crawl-snapshot-streaming.test.js` (new)
- `backend/tests/run-tests.js` — register all three new test files
- `docs/changelog.md` — `## [Unreleased]` § Fixed + § Performance

**Acceptance criteria:**
- Killing the process mid-run (SIGKILL) and restarting produces a run with
  `status: 'failed'`, `failureReason: 'process_crash'`; results collected
  before the kill are readable via `GET /runs/:id`.
- `POST /runs/:id/resume` re-executes only tests absent from
  `run_test_results`; already-completed tests are not re-run.
- A 200-page crawl on a 512 MB heap (set via `--max-old-space-size=512`)
  completes without OOM; `process.memoryUsage().heapUsed` never exceeds
  400 MB during the crawl phase.
- `parallelWorkers = 10` on a 50-test suite reduces `app_run_duration_seconds`
  p50 by ≥ 20% vs. pre-B1 baseline (document in PR description).
- PostgreSQL dialect: `dbWriteQueue.enqueue()` executes writes immediately;
  no background flush loop starts.

**agent-scope-backend:** all files above
**agent-scope-frontend:** none (run resume is admin-only CLI/API call)

**Dependencies:** MNT-015 ✅ (browser pool — shutdown sequence must call
pool drain before queue drain, already in place)

---

### Bundle 2 (B2) — Browser coverage depth: iframe + adaptive timeouts 🔴 P0

**Covers sub-items:** RLY-006 (iframe enumeration), RLY-009 (SPA hydration +
adaptive timeouts)

**Status:** ✅ Complete (this PR) | **Effort:** L | **Source:** Audit §B.1 · §B.2 · §E.2

**Problem:**

1. **iframe enumeration missing.** `crawlBrowser.js` never iterates
   `page.frames()`. Enterprise apps embedding Stripe Checkout, Intercom,
   Typeform, or any payment iframe are completely invisible to the crawler.
   The shadow DOM recursive traversal (already shipped) does not help here —
   iframes are separate browsing contexts, not shadow roots.

2. **SPA hydration snapshots.** The crawler uses `waitUntil: 'domcontentloaded'`
   for all navigation. React/Vue/Angular/Next.js apps snapshot in skeleton
   state — the real interactive DOM populates 200–2 000 ms later via the
   framework's hydration cycle. Generated tests target skeleton elements that
   don't exist at execution time.

3. **Fixed 5 s element timeout.** `HEALING_ELEMENT_TIMEOUT` is a hard constant.
   Enterprise apps with complex data-loading have API calls taking 8–15 s.
   Fixed 5 s timeouts produce `TIMEOUT` failures on every action; the
   7-strategy healing waterfall exhausts all strategies in 35 s before falling
   through to vision heal — a complete waste. No feedback mechanism connects
   observed page load times to configured timeouts.

**Fix:**

**B2-1 — iframe enumeration:**
In `crawlBrowser.js` and `stateExplorer.js`, after taking the main-page
snapshot, iterate `page.frames()`. For each non-main frame that is
same-origin (or matches `project.iframeAllowlist[]`), call the existing
`takeSnapshot(frame)` — Playwright's `Frame` object satisfies the same
interface as `Page` for snapshot purposes. Tag snapshots with
`{ _fromIframe: true, iframeSrc: frame.url() }`.

Add `project.iframeStrategy: 'same-origin' | 'allowlist' | 'all' | 'none'`
(default `'same-origin'`). Cross-origin iframes produce a `SecurityError`
on DOM access — `'same-origin'` gracefully skips them with a structured log.
Extend `playwrightSelectorGenerator.js` to wrap iframe-tagged element
selectors in `page.frameLocator('iframe[src*="…"]')…`.

Store `iframeStrategy` and `iframeAllowlist` on the project row (migration).

**B2-2 — SPA hydration wait:**
After `waitUntil: 'domcontentloaded'`, detect the SPA framework via
`page.evaluate()`: check `document.querySelector('[id="__NEXT_DATA__"]')`,
`window.__nuxt`, `window.__vue_app__`, `document.querySelector('[ng-version]')`,
`document.getElementById('root')?.hasChildNodes()` (generic React heuristic).

When a framework is detected, apply a hydration wait:
```js
await page.waitForFunction(
  () => !document.querySelector('.loading, [aria-busy="true"], [data-loading], .skeleton'),
  { timeout: HYDRATION_WAIT_MS }
).catch(() => {}); // graceful timeout — not all apps have loading indicators
```

Add `project.hydrationType: 'auto' | 'domcontentloaded' | 'custom'`
(default `'auto'`). `'custom'` accepts a `project.hydrationSelector` —
the crawler waits for this selector to disappear before snapshotting.
Emit `pipeline.hydration_wait` structured log with `{ framework, waitMs }`.

**B2-3 — Adaptive element timeout:**
During the crawl (B1-3's `crawlSnapshotRepo.save()` already records
`loadMs` per page), compute `run.p95LoadMs` from the crawl timing data
after all pages are processed.

In `testRunner.js`, derive:
```js
const adaptiveTimeout = Math.min(
  Math.max(run.p95LoadMs * 2, HEALING_ELEMENT_TIMEOUT),
  MAX_ELEMENT_TIMEOUT  // default 30 000 ms
);
```

Inject `adaptiveTimeout` into the vm sandbox globals inside
`executeTest.js`, replacing the hardcoded `HEALING_ELEMENT_TIMEOUT`
constant in `getSelfHealingHelperCode()`. The function already accepts
injectable globals — add `elementTimeout` to the existing injection map.

Add `project.elementTimeoutOverride INTEGER` (null = use adaptive) to
bypass the adaptive calculation when an operator knows their environment.

**Migrations:**
```sql
-- NNN_project_iframe_settings.sql
ALTER TABLE projects ADD COLUMN iframeStrategy TEXT DEFAULT 'same-origin';
ALTER TABLE projects ADD COLUMN iframeAllowlist TEXT DEFAULT '[]';

-- NNN_project_spa_settings.sql
ALTER TABLE projects ADD COLUMN hydrationType TEXT DEFAULT 'auto';
ALTER TABLE projects ADD COLUMN hydrationSelector TEXT;
ALTER TABLE projects ADD COLUMN elementTimeoutOverride INTEGER;

-- NNN_run_adaptive_timeout.sql
ALTER TABLE runs ADD COLUMN p95LoadMs INTEGER;
```

**Files to change:**
- `backend/src/database/migrations/NNN_project_iframe_settings.sql` (new)
- `backend/src/database/migrations/NNN_project_spa_settings.sql` (new)
- `backend/src/database/migrations/NNN_run_adaptive_timeout.sql` (new)
- `backend/src/pipeline/crawlBrowser.js` — `page.frames()` iteration;
  hydration wait; record `loadMs` per page
- `backend/src/pipeline/stateExplorer.js` — same frame iteration +
  hydration wait post-navigation
- `backend/src/pipeline/pageSnapshot.js` — attach `_frameworkDetected`,
  `_fromIframe`, `iframeSrc` to snapshot metadata
- `backend/src/runner/playwrightSelectorGenerator.js` — generate
  `frameLocator()` wrapper for `_fromIframe`-tagged elements
- `backend/src/testRunner.js` — compute `p95LoadMs` from
  `crawlSnapshotRepo`; derive `adaptiveTimeout`; pass to `executeTest()`
- `backend/src/runner/executeTest.js` — accept `options.adaptiveTimeout`;
  inject into vm sandbox via the existing globals injection path
- `backend/src/selfHealing.js` — `getSelfHealingHelperCode()` accepts
  `elementTimeout` parameter (replaces `HEALING_ELEMENT_TIMEOUT` constant)
- `backend/src/routes/projects.js` — accept `iframeStrategy`,
  `iframeAllowlist`, `hydrationType`, `hydrationSelector`,
  `elementTimeoutOverride` on project PATCH
- `frontend/src/pages/ProjectSettings.jsx` (or equivalent project settings
  surface) — iframe strategy selector + hydration type + element timeout
  override inputs
- `frontend/src/api.js` — project PATCH additions
- `backend/.env.example` — `HYDRATION_WAIT_MS` (default 5 000),
  `MAX_ELEMENT_TIMEOUT` (default 30 000)
- `backend/tests/iframe-crawl.test.js` (new)
- `backend/tests/spa-hydration.test.js` (new)
- `backend/tests/adaptive-timeout.test.js` (new)
- `backend/tests/run-tests.js` — register all three
- `docs/changelog.md` — `## [Unreleased]` § Added

**Acceptance criteria:**
- An app with a same-origin `<iframe src="/widget">` produces snapshot
  elements tagged `_fromIframe: true`; generated test uses
  `page.frameLocator('iframe[src*="widget"]').getByRole(…)` syntax.
- A cross-origin iframe is skipped under `'same-origin'` with a structured
  log `⚠ Skipping cross-origin iframe: …`.
- A Next.js page (detectable via `__NEXT_DATA__`) has `_frameworkDetected:
  'nextjs'` in its snapshot; crawl waits for hydration before snapshotting.
- A crawl where P95 load time is 12 s sets `run.p95LoadMs = 12000` and the
  vm sandbox uses `elementTimeout = 24000` (capped at `MAX_ELEMENT_TIMEOUT`).
- `project.elementTimeoutOverride = 8000` bypasses the adaptive calculation.

**Dependencies:** B1 (crawl_snapshots table with `loadMs` — B2-3 reads
timing data persisted by B1-3; B2 can be parallelised with B1 if the
`loadMs` column is added to the migration stub and left `null` until B1
lands)

---

### Bundle 3 (B3) — Reviewer independence and escalation 🔴 P0

**Covers sub-items:** RLY-003 (reviewer collapse detection), QAL-004
(human escalation on agent failure)

**Status:** 🔲 Planned | **Effort:** M | **Source:** Audit §C.2 · §D.1 · §D.2

**Problem:**

1. **Author self-reviews its own output.** `agentLoop.js` already emits an
   `AI-005c` warning when author and reviewer resolve to the same `routeId`,
   but the warning is advisory — the loop still runs. In the common case
   (single workspace API key, all roles sharing the same provider route),
   the reviewer and author are the same model at the same temperature. The
   `runReviewerAuthorLoop` (AUTO-023 B3, fully shipped ✅) provides no
   quality signal in this configuration — the author's output is approved
   near-unconditionally on round 0.

2. **Silent discard on review failure.** When the reviewer–author loop
   exhausts `maxRounds` or terminates with `ReviewRejection`, the test is
   discarded and no operator notification fires. A run generating 40 tests
   that silently discards 15 looks like it produced 25. The discarded tests
   represent entire feature areas that are now untested with no signal.

**Fix:**

**B3-1 — Reviewer collapse enforcement:**
Upgrade the existing `AI-005c` warning from an advisory log to a **pre-run
hard decision** in `crawler.js` (alongside existing health checks). When
author and reviewer resolve to the same `routeId`:

- Skip all LLM reviewer calls in `runReviewerAuthorLoop`. Instead, call
  `validateTest()` directly (the heuristic path already exists as the
  round-0 reviewer check). Do not emit `agent_messages` envelopes for the
  collapsed path — the audit trail must reflect that no independent review
  occurred.
- Set `run.reviewerCollapsed = true` on the run record.
- Increment `app_agent_reviewer_collapsed_total` counter.
- Render a `"⚠ Reviewer collapsed — heuristic-only review"` chip on the
  RunDetail header when `reviewerCollapsed` is true.
- Add a Settings → Agent Roles warning banner when `reviewer` and `author`
  share a `routeId` (the Agent Roles tab from AI-004/AI-005 already exists).

**B3-2 — Escalation notification on discard:**
In `feedbackLoop.js`, when `ReviewRejection` is caught (already handled in
the post-run feedback path), call `logActivity()` with a new
`ACTIVITY_TYPES.TEST_REVIEW_REJECTED` entry and fire the existing FEA-001
notification dispatch with type `test_review_rejected`. Payload:
`{ testId, testName, failureCategory, roundsCompleted, runId, projectName,
workspaceId }`.

Accumulate discarded test IDs in `run.reviewRejectedTests[]`. Persist as
JSON on the run record (migration). Surface in RunDetail as a `"Tests
discarded by review: N"` section with per-test links to the agent
conversation thread (already persisted in `agent_messages`).

Add `project.reviewRejectionAlertThreshold INTEGER` (default 0 = always
notify; -1 = never). Notifications only fire when
`reviewRejectedTests.length >= threshold`.

**Migrations:**
```sql
-- NNN_run_reviewer_state.sql
ALTER TABLE runs ADD COLUMN reviewerCollapsed INTEGER DEFAULT 0;
ALTER TABLE runs ADD COLUMN reviewRejectedTests TEXT DEFAULT '[]';

-- NNN_project_alert_threshold.sql
ALTER TABLE projects ADD COLUMN reviewRejectionAlertThreshold INTEGER DEFAULT 0;
```

**Files to change:**
- `backend/src/database/migrations/NNN_run_reviewer_state.sql` (new)
- `backend/src/database/migrations/NNN_project_alert_threshold.sql` (new)
- `backend/src/aiProvider/agentLoop.js` — skip LLM reviewer calls when
  routes collapse; set `run.reviewerCollapsed`; emit `agent_messages` note
- `backend/src/crawler.js` — add reviewer === author check pre-run; persist
  `run.reviewRejectedTests[]`; structured log
- `backend/src/pipeline/feedbackLoop.js` — `logActivity(TEST_REVIEW_REJECTED)`
  + FEA-001 dispatch in `ReviewRejection` catch; populate
  `run.reviewRejectedTests`
- `backend/src/utils/metrics.js` — `app_agent_reviewer_collapsed_total`
  counter
- `backend/src/constants/activityTypes.js` — add `TEST_REVIEW_REJECTED`
- `backend/src/database/repositories/runRepo.js` — include
  `reviewerCollapsed`, `reviewRejectedTests` columns
- `backend/src/routes/projects.js` — accept `reviewRejectionAlertThreshold`
  on project PATCH
- `frontend/src/pages/RunDetail.jsx` — `reviewerCollapsed` chip on run
  header; `"Tests discarded by review"` section
- `frontend/src/pages/Settings.jsx` (Agent Roles tab) — reviewer-collapsed
  warning banner; threshold input
- `frontend/src/api.js` — project PATCH additions
- `backend/tests/agent-loop-collapse.test.js` (new)
- `backend/tests/review-rejection-notification.test.js` (new)
- `backend/tests/run-tests.js` — register both
- `docs/changelog.md` — `## [Unreleased]` § Changed + § Added

**Acceptance criteria:**
- Author and reviewer sharing a `routeId` → zero LLM calls for reviewer;
  `run.reviewerCollapsed === true`; `app_agent_reviewer_collapsed_total`
  increments once per run.
- RunDetail renders `"⚠ Reviewer collapsed — heuristic-only review"` chip.
- 3 tests discarded by `ReviewRejection` → `run.reviewRejectedTests` has 3
  IDs; FEA-001 notification fires with the correct payload.
- `project.reviewRejectionAlertThreshold = 5` → no notification for 4
  rejections, fires at 5.
- Author ≠ reviewer (distinct `routeId`s) → LLM reviewer called normally;
  `reviewerCollapsed === false`.

**Dependencies:** AI-005 ✅ (agentRole routing must exist), AUTO-023 ✅
(`runReviewerAuthorLoop` must exist), FEA-001 ✅ (notification dispatch)

---

### Bundle 4 (B4) — Auth session recovery and MFA target-app support 🔴 P0

**Covers sub-items:** RLY-004 (session recovery mid-run), SCL-001 (TOTP on
target app)

**Status:** 🔲 Planned | **Effort:** M | **Source:** Audit §J Scenario 2 · §B.1

> **Note:** SEC-004 ✅ (PR #10) shipped Sentri's *own* MFA (TOTP + WebAuthn).
> This bundle targets MFA on the **application under test** — a completely
> different problem.

**Problem:**

1. **Session expiry during long runs.** When a project has credentials,
   `crawlBrowser.js` and `stateExplorer.js` perform login once at session
   start. On runs exceeding 30 min, session tokens expire. Subsequent tests
   receive a login-page redirect instead of the application. These failures
   are classified as `NAVIGATION_FAIL` or `SELECTOR_ISSUE`, masking the
   root cause and triggering pointless self-healing and regeneration loops.

2. **No TOTP for target apps.** Enterprise applications almost universally
   require MFA. `autoLogin.js` handles username/password but has no OTP
   field detection or TOTP generation. Any app with MFA blocks all
   authenticated crawl pages and generates zero tests for auth-gated flows.

**Fix:**

**B4-1 — Auth session recovery:**
In `executeTest.js`, after every `page.goto()` and after every full
healing-strategy exhaustion, check `page.url()` against
`AUTH_REDIRECT_PATTERNS` (configurable array; defaults: `/login`, `/signin`,
`/auth`, `/session-expired`, `/unauthorized`). On match when the project has
credentials, emit `auth.session_expired` structured log and call
`restoreAuthSession(page, project, run)`.

`restoreAuthSession()` in `autoLogin.js`: (a) navigate to `project.url`,
(b) call `performAutoLogin()`, (c) navigate back to the original URL.
Returns `{ ok: boolean, reason: string }`.

Classify `AUTH_EXPIRED` as a new entry in `feedbackLoop.js`'s
`FAILURE_PATTERNS` — do NOT trigger test regeneration for this category.
Add `AUTH_EXPIRED` to `skipReasons.js`'s `NON_EXECUTED_SKIP_REASONS`
exclusion set so `evaluateQualityGates` excludes these from pass-rate.

Add `project.sessionRefreshIntervalMs INTEGER` (null = disabled) — a
lightweight background ping (navigate to `project.url`, wait for
`domcontentloaded`, no interaction) to proactively keep sessions alive.

**B4-2 — TOTP for target apps:**
Add `project.credentials.totpSecret TEXT` (AES-256-GCM encrypted via the
existing `credentialEncryption.js` pipeline, same as `password`). After
username/password login, detect a post-submit OTP field via:
`[autocomplete="one-time-code"], [aria-label*="code" i], [placeholder*="OTP" i],
[placeholder*="verification" i]`. If found, generate the current TOTP code
using `@otpauth/totp` (add to `backend/package.json`) seeded from
`totpSecret` and fill. Retry once if rejected (code may expire at the
30-second boundary).

Add a `POST /api/v1/projects/:id/credentials/test-totp` (admin-only) that
returns `{ code, expiresInSeconds }` for operator verification — the code
is computed live from the stored encrypted secret and never persisted.
Add a TOTP secret field (masked input + "Test TOTP" button) to the project
credentials settings panel.

**Migrations:**
```sql
-- NNN_project_auth_recovery.sql
ALTER TABLE projects ADD COLUMN sessionRefreshIntervalMs INTEGER;
-- totpSecret is stored inside the existing encrypted credentials JSON blob —
-- no schema change required; credentialEncryption.js handles it transparently.
```

**Files to change:**
- `backend/src/database/migrations/NNN_project_auth_recovery.sql` (new)
- `backend/src/runner/executeTest.js` — post-goto auth-expiry URL check +
  `restoreAuthSession()` call
- `backend/src/pipeline/autoLogin.js` — export `restoreAuthSession()`; TOTP
  OTP-field detection + `@otpauth/totp` generation + retry
- `backend/src/pipeline/feedbackLoop.js` — add `AUTH_EXPIRED` to
  `FAILURE_PATTERNS`; exclude from regeneration path
- `backend/src/utils/skipReasons.js` — add `'auth_expired'` to
  `NON_EXECUTED_SKIP_REASONS`
- `backend/src/utils/credentialEncryption.js` — encrypt/decrypt
  `totpSecret` alongside `password` in the credentials blob
- `backend/src/testRunner.js` — optional `sessionRefreshIntervalMs` ping
  loop using `setInterval` + `page.goto(project.url)`
- `backend/src/routes/projects.js` — accept `credentials.totpSecret` on
  PATCH; `POST /credentials/test-totp` endpoint; `sessionRefreshIntervalMs`
- `frontend/src/pages/ProjectSettings.jsx` — TOTP secret masked input +
  "Test TOTP" button; `sessionRefreshIntervalMs` input
- `frontend/src/api.js` — `testTotpCode(projectId)`,
  `updateProjectCredentials()` additions
- `backend/package.json` — add `@otpauth/totp`
- `backend/.env.example` — `AUTH_REDIRECT_PATTERNS` (JSON array)
- `backend/tests/auth-session-recovery.test.js` (new)
- `backend/tests/auto-login-totp.test.js` (new)
- `backend/tests/run-tests.js` — register both
- `docs/changelog.md` — `## [Unreleased]` § Added + § Fixed

**Acceptance criteria:**
- A test receiving a login-page redirect triggers `restoreAuthSession()`,
  not test regeneration; the test retries from the original URL.
- Unrecoverable auth expiry: `result.status = 'failed'`,
  `error: 'auth_session_expired_unrecoverable'`, classified `AUTH_EXPIRED`,
  excluded from pass-rate denominator.
- `performAutoLogin()` with a valid `totpSecret` fills the TOTP field after
  username/password and retries once on rejection.
- `POST /credentials/test-totp` returns `{ code, expiresInSeconds }`;
  `totpSecret` is never returned in `GET /projects/:id`.
- `sessionRefreshIntervalMs: 900000` causes a background ping every 15 min
  logged as `🔄 Session refresh ping`.

**Dependencies:** B1 (per-test result flush — auth-recovery result must be
persisted immediately)

---

### Bundle 5 (B5) — Test dependency ordering (AUTO-014 — current PR) 🟡 P1

**Status:** ✅ Complete | **Effort:** M |
**Source:** ROADMAP.md Phase 4 (AUTO-014)

> **This is the item already specified in NEXT.md as the current sprint
> target.** It is listed here for completeness so the Phase 6 summary table
> is complete. The full spec lives in NEXT.md. Do not duplicate it — agents
> executing B5 should read NEXT.md directly.

**Summary:** `tests.dependsOn JSON` column; Kahn's topological sort in
`runner/dependencyOrder.js`; smoke-pin-first dispatch preserved; failed
upstream pre-seeds transitive dependents as `skipped { skipReason:
"upstream_failed" }`; `"upstream_failed"` + `"missing_upstream"` added to
`NON_EXECUTED_SKIP_REASONS`; cycle detection at save time (400 + structured
error codes); RunDetail 🔗 badge; TestDetail "Depends on" multi-select.

**Files to change:** as specified verbatim in NEXT.md.

**Dependencies:** MNT-015 ✅

---

### Bundle 6 (B6) — Test quality gates: dry-run + semantic review + data 🟡 P1

**Covers sub-items:** QAL-001 (dry-run gate), QAL-005 (semantic reviewer),
QAL-002 (fixture/state isolation), QAL-010 (unique test data / faker)

**Status:** 🔲 Planned | **Effort:** XL | **Source:** Audit §D.2 · §E.3

**Problem:**

1. **No execution gate before approval.** Generated tests enter the approval
   queue based on `validateTest()` heuristics. A test that passes all
   structural checks (correct locator types, valid methods, no secrets, no
   placeholder URLs) may still fail on first execution because it targets a
   non-existent element, navigates to an unreachable state, or produces
   trivially always-true assertions. Operators approve tests they cannot
   evaluate until after approval.

2. **Reviewer cannot detect semantic weakness.** `validateTest()` checks
   locator quality, method whitelist, syntax, secret scan, placeholder URLs.
   It cannot detect: always-true assertions (`toHaveURL(/http/)` passes on
   any page), tests that make no assertions, tests that never observe a state
   change. A test with `expect(page.getByRole('heading')).toBeVisible()` on
   every step scores 90/100 and passes review.

3. **No cleanup between tests; repeated runs break on uniqueness.** Generated
   tests create resources without teardown. A test creating a user account
   fails on re-run with a unique-constraint violation. Hardcoded test data
   (`testuser1@example.com`) is semantically thin — it never exercises
   Unicode, length limits, or special-character edge cases.

**Fix:**

**B6-1 — Dry-run execution gate:**
New `backend/src/pipeline/dryRunGate.js`. When `project.dryRunGate === true`
(default `false`), execute each validated test once in a lightweight browser
session via `browserPool.acquire()` (already available from MNT-015) before
`testPersistence.js` writes it to the DB.

Tests that pass → `reviewStatus: 'draft'` as normal.
Tests that fail → `dryRunStatus: 'failed'`, `dryRunError` recorded;
enter the approval queue with a `⚠ Dry run failed` badge.
Tests where all assertions complete in < `DRY_RUN_TRIVIAL_THRESHOLD_MS`
(default 200 ms) with zero network requests → `dryRunQuality: 'trivial'`.

`AUTO-003b` auto-approval is only eligible for tests with
`dryRunStatus: 'passed'` — a dry-run failure is never auto-approved.

Store `dryRunStatus`, `dryRunError`, `dryRunDurationMs` on the test row
(migration).

**B6-2 — Semantic reviewer (LLM second pass):**
When `project.semanticReview === true` (default `false`) and the reviewer
and author are NOT collapsed (B3), add a second LLM reviewer pass after
`validateTest()` via `agentRole: 'reviewer'`. New prompt
`backend/src/pipeline/prompts/semanticReviewPrompt.js` asks four questions:
1. Does this test verify a meaningful state change?
2. Are any assertions trivially always-true?
3. Does the test cover the full described scenario?
4. Would this test catch a regression if the feature stopped working?

Returns structured JSON `{ score: 0–100, issues: string[], verdict:
'accept' | 'revise' | 'reject' }`. A `revise` verdict injects issues into
the author loop as additional reviewer feedback. A `reject` produces
`reviewStatus: 'rejected'`.

Store `semanticReviewScore INTEGER` and `semanticReviewIssues TEXT` on
tests (migration).

**B6-3 — Fixture + unique data:**
Extend the journey and intent prompts to emit optional `setup` and `teardown`
code blocks alongside the test body. The LLM instruction: *"If the test
creates any resource, include a `teardown` step that deletes or resets it
using the same UI flow."*

Add `test.setupCode TEXT` and `test.teardownCode TEXT` (migration).
`executeTest.js` runs `setupCode` before the test and `teardownCode`
(best-effort, swallowed errors) in the test `finally` block.

Add `@faker-js/faker` to `backend/package.json`. Extend prompts to
instruct the LLM to use `__FAKE_EMAIL__`, `__FAKE_NAME__`, `__FAKE_PHONE__`
placeholder tokens. `executeTest.js` replaces these before vm compilation
using `faker` seeded from `hash(runId + testId)` — deterministic within a
run, different across runs.

Add `project.testDataLocale TEXT` (default `'en'`); store in project row
(migration).

The existing `testFixtureRepo.js` (CAP-001 ✅) handles CSV/JSON fixture rows
— faker substitution is skipped for columns covered by a fixture.

**Migrations:**
```sql
-- NNN_test_dry_run.sql
ALTER TABLE tests ADD COLUMN dryRunStatus TEXT;
ALTER TABLE tests ADD COLUMN dryRunError TEXT;
ALTER TABLE tests ADD COLUMN dryRunDurationMs INTEGER;

-- NNN_test_semantic_review.sql
ALTER TABLE tests ADD COLUMN semanticReviewScore INTEGER;
ALTER TABLE tests ADD COLUMN semanticReviewIssues TEXT;

-- NNN_test_fixtures_v2.sql
ALTER TABLE tests ADD COLUMN setupCode TEXT;
ALTER TABLE tests ADD COLUMN teardownCode TEXT;

-- NNN_project_test_data.sql
ALTER TABLE projects ADD COLUMN testDataLocale TEXT DEFAULT 'en';
ALTER TABLE projects ADD COLUMN dryRunGate INTEGER DEFAULT 0;
ALTER TABLE projects ADD COLUMN semanticReview INTEGER DEFAULT 0;
```

**Files to change:**
- `backend/src/database/migrations/NNN_test_dry_run.sql` (new)
- `backend/src/database/migrations/NNN_test_semantic_review.sql` (new)
- `backend/src/database/migrations/NNN_test_fixtures_v2.sql` (new)
- `backend/src/database/migrations/NNN_project_test_data.sql` (new)
- `backend/src/pipeline/dryRunGate.js` (new)
- `backend/src/pipeline/prompts/semanticReviewPrompt.js` (new)
- `backend/src/pipeline/testPersistence.js` — call `dryRunGate()` when
  `project.dryRunGate`; persist new columns
- `backend/src/pipeline/feedbackLoop.js` — call semantic reviewer after
  heuristic validation when `project.semanticReview && !run.reviewerCollapsed`
- `backend/src/pipeline/prompts/journeyPrompt.js` — setup/teardown
  instruction; `__FAKE_*__` token instruction
- `backend/src/pipeline/prompts/intentPrompt.js` — same additions
- `backend/src/runner/executeTest.js` — execute `setupCode` pre-test;
  `teardownCode` in `finally`; `__FAKE_*__` + `__TIMESTAMP__` substitution
- `backend/src/utils/fakeDataGenerator.js` (new) — seeded faker wrapper;
  locale support; placeholder map
- `backend/src/database/repositories/testRepo.js` — include all new columns
  in column allowlist + `LEAN_COLS` + JSON parse
- `backend/src/routes/projects.js` — accept new project fields on PATCH
- `backend/package.json` — add `@faker-js/faker`
- `frontend/src/pages/TestDetail.jsx` — dry-run result panel + semantic
  review score; `setupCode` / `teardownCode` panels
- `frontend/src/components/review/ReviewQueueCard.jsx` — `⚠ Dry run
  failed`, `⚠ Trivial assertion`, `⚠ Semantic reject` chips
- `frontend/src/api.js` — project PATCH additions
- `backend/tests/dry-run-gate.test.js` (new)
- `backend/tests/semantic-reviewer.test.js` (new)
- `backend/tests/test-fixture-management.test.js` (new)
- `backend/tests/fake-data-generation.test.js` (new)
- `backend/tests/run-tests.js` — register all four
- `docs/changelog.md` — `## [Unreleased]` § Added

**Acceptance criteria:**
- `project.dryRunGate = true`: every generated test executes once before
  entering the approval queue; `dryRunStatus` on each test row.
- A test referencing a non-existent element gets `dryRunStatus: 'failed'`
  and the `⚠ Dry run failed` chip in the review queue.
- `project.semanticReview = true` with distinct reviewer/author routes:
  semantic LLM call fires after `validateTest()`; `revise` verdict re-enters
  the author loop with semantic issues appended.
- When reviewer is collapsed (B3), `project.semanticReview = true` is
  silently ignored — no extra LLM call.
- `teardownCode` failure does not fail the test; logged as `⚠ Teardown
  error (swallowed)`.
- `__FAKE_EMAIL__` in generated code is replaced with a valid email; same
  `runId + testId` seed always produces the same value.
- `project.dryRunGate = false` (default): pipeline is byte-identical to
  pre-B6.

**Dependencies:** B3 (reviewer collapse detection — semantic reviewer must
check `run.reviewerCollapsed`), MNT-015 ✅ (browser pool — dry-run gate
uses `browserPool.acquire()`), AUTO-003b ✅ (auto-approval gate must check
`dryRunStatus`)

---

### Bundle 7 (B7) — Healing safety + context robustness 🟡 P1

**Covers sub-items:** QAL-006 (heal confidence scoring), QAL-007 (context
window chunking), QAL-008 (bot-detection content guard), QAL-009 (circuit
breaker persistence), QAL-011 (vision-heal inside iframes — surfaced by
B2's iframe enumeration; vision-heal currently only operates against the
parent-page screenshot, so frame-scoped DOM failures fall through with no
pixelmatch / LLM-vision fallback. Effort: M. Add a `frame.screenshot()`
capture step to `tryVisionHeal`'s pre-flight so stages 7-8 receive the
correct screenshot when `evt._fromIframe` is set; baseline crops need to
be keyed by `${parentSnapshotFp}::${iframeSrc}::${evt.key}` so a frame
moving between pages doesn't share baselines with an unrelated parent.)

**Status:** 🔲 Planned | **Effort:** L | **Source:** Audit §F.2 · §B.2 ·
§J Scenario 4

**Problem:**

1. **Healed action on wrong element produces false pass.** When the text
   strategy heals "Submit" → "Confirm" (Levenshtein distance > 3), the test
   passes but the wrong action was taken. The `MNT-001` vision healing
   (pixelmatch + LLM, both shipped ✅) has a confidence score from
   `pixelmatchHeal()`, but that score is not surfaced on the test result or
   used to downgrade passing status. A 40%-confidence heal looks identical
   in the UI to a 95%-confidence heal.

2. **Large SPA prompt overflow.** The journey generation prompt
   (`buildJourneyPrompt()`) includes all page elements in a single LLM call.
   For a 30-page application this reaches 40 000+ tokens. Local Ollama models
   with an 8k context window silently truncate — the model generates tests
   for the elements that fit, with no error or warning. The pipeline reports
   success; the operator sees fewer tests than expected with no explanation.

3. **Bot-detection content gap.** `stateExplorer.js` detects bot-detection
   pages by URL pattern (`BOT_DETECTION_PATTERNS`). A site returning HTTP 200
   with a Cloudflare JS challenge page (no URL change) passes the URL check
   and generates poisoned snapshots containing CAPTCHA HTML. The
   `classifyFailure()` function catches these at execution time, but by then
   the bad snapshot is already stored and used for generation.

4. **Circuit breaker state lost on restart.** `getHealingHint()` checks
   `failCount >= HEALING_HINT_MAX_FAILS`. The `failCount` is persisted to
   `healingRepo`, but the in-memory `healingRepo.get()` cache is populated
   lazily — a fresh process reads the DB correctly. However, the current code
   path's cache warm-up strategy means a hint that hit the circuit breaker
   just before a crash may reset `failCount` to 0 on restart (DB write was
   queued but not flushed — will be worse after B1's write-batching queue).
   Additionally, there is no audit trail when a test passes *via* healing
   — operators cannot distinguish clean passes from healed passes.

**Fix:**

**B7-1 — Healing confidence on test result:**
Add per-strategy confidence scoring in `selfHealing.js`:
- Strategies 0–1 (ARIA role, label): `1.0`
- Strategy 2 (text): `0.80`, downgraded to `0.50` when
  `Levenshtein(originalLabel, foundLabel) > 3` (action steps only)
- Strategies 3–6 (placeholder, alt, title, test ID): `0.70`
- Strategy 7 (pixelmatch): use `confidence` from `pixelmatchHeal()` return
- Strategy 8 (LLM vision): use LLM-returned confidence

Emit confidence in the healing event payload. In `executeTest.js`, when
`healingApplied && confidence < HEALING_CONFIDENCE_WARN_THRESHOLD`
(default 0.75), set `result.status = 'warning'` (not `'passed'`) and add
`healingWarning: 'low_confidence_heal'`.

Add `confidence REAL DEFAULT 1.0` to `healing_history` (migration). Surface
confidence in RunDetail's healing panel (already shown via `MNT-001`'s
Vision Healing tab — extend it with per-strategy confidence).

Emit `ACTIVITY_TYPES.TEST_PASSED_VIA_HEALING` in `activityLogger` when
`result.status` is `'passed'` or `'warning'` AND `healingApplied === true`.
Visible in the Audit Log with a `"Self-Healing"` filter chip.

**B7-2 — Context window chunking:**
Before calling `generateText()` in `journeyGenerator.js`, estimate prompt
token count: `estimatedTokens = Math.ceil(prompt.length / 3.5)`. If
`estimatedTokens > model.contextWindow * CONTEXT_SAFE_FRACTION`
(default 0.80), split the URL batch into smaller chunks and make multiple
generation calls. The `aiProvider/modelCatalog.js` (AI-003 ✅) already has
a `contextWindow` field per model — use it.

For Ollama models, read `contextWindow` from the Ollama `/api/show` API on
first use and cache it in the catalog entry. When unavailable, default to
`4096` (conservative) with a warning.

Store `run.contextOverflowChunks INTEGER` on the run record (migration).
Surface as an informational banner in RunDetail when `> 0`.

Add `project.maxPromptBatchSize INTEGER` (null = auto) as an operator
override.

**B7-3 — Bot-detection content guard:**
In `crawlBrowser.js` and `stateExplorer.js`, after taking each snapshot,
run `page.evaluate()` checking `document.body.innerText.toLowerCase()` for:
`['are you a robot', 'verify you are human', 'recaptcha', 'cloudflare ray id',
'unusual traffic', 'captcha']`. On match, mark snapshot `_botBlocked: true`,
discard it (do not store in `crawlSnapshotRepo`), and emit
`pipeline.bot_blocked` structured log.

Add `run.botBlockedUrls: string[]` (migration). Surface in RunDetail as an
`"Access Blocked"` section.

**B7-4 — Circuit breaker hardening:**
Ensure `getHealingHint()` always reads `failCount` from the DB directly
(not from a potentially stale cache) when evaluating the circuit breaker
threshold. The write-batching queue from B1-2 must flush healing writes
synchronously when `failCount` reaches `HEALING_HINT_MAX_FAILS` — add
`{ priority: 'high' }` to that specific enqueue call so it bypasses the
batch queue.

Add `circuitBreakerOpenedAt TEXT` to `healing_history` (migration) — set
when `failCount` reaches the threshold; cleared by the operator via the
existing `DELETE /api/v1/projects/:id/healing-history/:key` endpoint.
Add `passCount INTEGER DEFAULT 0` and `lastPassedAt TEXT` (migration) —
updated by `recordHealing()` for healing health dashboards.

**Migrations:**
```sql
-- NNN_healing_confidence.sql
ALTER TABLE healing_history ADD COLUMN confidence REAL DEFAULT 1.0;
ALTER TABLE healing_history ADD COLUMN circuitBreakerOpenedAt TEXT;
ALTER TABLE healing_history ADD COLUMN passCount INTEGER DEFAULT 0;
ALTER TABLE healing_history ADD COLUMN lastPassedAt TEXT;

-- NNN_run_context_overflow.sql
ALTER TABLE runs ADD COLUMN contextOverflowChunks INTEGER DEFAULT 0;
ALTER TABLE runs ADD COLUMN botBlockedUrls TEXT DEFAULT '[]';

-- NNN_project_prompt_batch.sql
ALTER TABLE projects ADD COLUMN maxPromptBatchSize INTEGER;
```

**Files to change:**
- `backend/src/database/migrations/NNN_healing_confidence.sql` (new)
- `backend/src/database/migrations/NNN_run_context_overflow.sql` (new)
- `backend/src/database/migrations/NNN_project_prompt_batch.sql` (new)
- `backend/src/selfHealing.js` — confidence scoring per strategy; Levenshtein
  downgrade; `circuitBreakerOpenedAt` on threshold; `passCount` +
  `lastPassedAt` in `recordHealing()`; direct DB read in `getHealingHint()`
  for circuit-breaker check
- `backend/src/runner/executeTest.js` — confidence < threshold → `'warning'`
  status; `TEST_PASSED_VIA_HEALING` activity log
- `backend/src/database/repositories/healingRepo.js` — persist new columns
- `backend/src/pipeline/journeyGenerator.js` — token estimation; batch
  chunking; merge + dedup across chunks; `run.contextOverflowChunks`
- `backend/src/aiProvider/modelCatalog.js` — Ollama context-window fetch +
  cache; `contextWindow` field used in chunking
- `backend/src/pipeline/crawlBrowser.js` — body-text bot-detection post-
  snapshot; `_botBlocked` flag; `run.botBlockedUrls` accumulation
- `backend/src/pipeline/stateExplorer.js` — same body-text check
- `backend/src/constants/activityTypes.js` — add
  `TEST_PASSED_VIA_HEALING`
- `backend/src/utils/activityLogger.js` — handle new event type
- `backend/src/utils/dbWriteQueue.js` — `priority: 'high'` path (from B1)
  bypasses batch for circuit-breaker writes
- `frontend/src/pages/RunDetail.jsx` — confidence % in healing panel; amber
  `warning` badge; context-overflow informational banner; `"Access Blocked"`
  section
- `backend/.env.example` — `HEALING_CONFIDENCE_WARN_THRESHOLD`,
  `CONTEXT_SAFE_FRACTION`, `VISION_HEAL_MAX_WINDOWS`
- `backend/tests/healing-confidence.test.js` (new)
- `backend/tests/healing-circuit-breaker.test.js` (new)
- `backend/tests/journey-prompt-chunking.test.js` (new)
- `backend/tests/bot-detection-content.test.js` (new)
- `backend/tests/run-tests.js` — register all four
- `docs/guide/self-healing.md` — confidence model section
- `docs/changelog.md` — `## [Unreleased]` § Added + § Fixed

**Acceptance criteria:**
- Text-strategy heal with `Levenshtein("Submit", "Confirm") = 5` → confidence
  0.50; `result.status = 'warning'`.
- ARIA-role-strategy heal → confidence 1.0; `result.status = 'passed'`.
- `HEALING_CONFIDENCE_WARN_THRESHOLD = 0.75`: any heal < 0.75 → `warning`.
- `TEST_PASSED_VIA_HEALING` activity log entry fires for every healed pass
  or warning.
- After `failCount` reaches `HEALING_HINT_MAX_FAILS`, `circuitBreakerOpenedAt`
  is persisted; process restart does NOT reset the breaker.
- A prompt estimated at 120% of the safe context fraction splits into 2 chunks;
  both generated; `run.contextOverflowChunks = 2`.
- A page returning HTTP 200 with body `"Are you a robot"` → `_botBlocked: true`;
  snapshot not stored; URL in `run.botBlockedUrls`.

**Dependencies:** B1 (write-batching queue for high-priority circuit-breaker
flush), MNT-001 ✅ (vision healing confidence from `pixelmatchHeal()`)

---

### Bundle 8 (B8) — Goal-based autonomy + coverage intelligence 🟢 Strategic

**Covers sub-items:** GOL-001 (goal specification layer), SCL-004 (test
coverage matrix), GOL-002 (anomaly detection + AI-driven run insights —
absorbs AUTO-011 ✅ and AUTO-021 from the queue)

**Status:** 🔲 Planned | **Effort:** XL | **Source:** Audit §G.1 · §H.5 ·
NEXT.md Queue items AUTO-011 + AUTO-021

> **Note:** AUTO-011 and AUTO-021 are currently in the NEXT.md queue as
> standalone items. This bundle absorbs them because all three require the
> same `run.goalCoverage` and coverage-matrix data. Ship them together or
> ship AUTO-011 + AUTO-021 first as a smaller B8a, then GOL-001 + SCL-004 as B8b.

**Problem:**

Sentri generates tests from what it can see (DOM elements, crawled pages),
not from what the application is supposed to do (business goals). There is
no mechanism to express *"ensure checkout always works"* and verify that
tests cover it. Without goal-to-test traceability, operators cannot answer
"are we testing what matters?" and cannot prove coverage to auditors or QA
leads. Coverage data (`coverageSummary` from AUTO-009 ✅) measures JS line
coverage — a meaningful metric, but it does not map to business flows.

Separately: the dashboard shows pass/fail trends but provides no contextual
explanation for changes. AUTO-011 (anomaly detection) and AUTO-021 (AI
insights) are queued but unshipped.

**Fix:**

**B8-1 — AUTO-011 — Anomaly detection (from queue):**
Add a rolling-mean + standard-deviation anomaly detector to the dashboard.
Alert when pass rate drops > `project.anomalyThresholdPct` (default 15%)
versus the prior N-run baseline (default 5 runs). New
`backend/src/utils/anomalyDetector.js` — `detectAnomaly(runs, threshold,
baselineN)` pure function. Fire FEA-001 notification with `anomalyAlert`
payload on detection. Surface as a warning banner on the Dashboard and
include in run completion notifications.

**B8-2 — AUTO-021 — AI-generated run insights (from queue):**
After each run, feed `{ qualityAnalytics, failureCategories, healingEvents,
passRateDelta, coverageSummary }` to the LLM via `agentRole: 'triager'`
(already in the AUTO-023 closed tool set) and generate a 3–5 sentence
natural-language insight. Surface as an `"AI Insights"` card on the
Dashboard. Cache per-run; never re-query on refresh.

**B8-3 — SCL-004 — Test coverage matrix:**
New `test_coverage_matrix` table. During `testPersistence.js`, record
`(testId, projectId, url)` per generated test. After each crawl, compare
current crawled URLs against the matrix; URLs with zero tests in the current
run that had tests in prior runs are flagged as `run.coverageGaps[]` (JSON
column on `runs`). Surface in RunDetail as `"Uncovered Pages"` section.
Expose `GET /api/v1/projects/:id/coverage-matrix` for CI consumers.

Fire FEA-001 notification when `coverageGaps.length >= project.coverageGapAlertThreshold`
(default 0 = always alert).

**B8-4 — GOL-001 — Goal specification layer:**
New `project_goals` table: operators define goals in natural language on a
Goals panel in ProjectDetail. Each goal: `title`, `description`, `priority
('critical' | 'high' | 'medium')`, `status ('covered' | 'partial' |
'uncovered')`, `linkedTestIds JSON`.

After each run, a new `pipeline/goalCoverageAgent.js` calls the LLM via
`agentRole: 'oracle'` (already in the AUTO-023 tool registry) with:
(a) operator goals, (b) test suite summaries, (c) run results. The LLM maps
tests to goals and identifies uncovered ones. Store as
`run.goalCoverage JSON`.

Dashboard adds a `"Goal Coverage"` card (progress bar per goal, drill-down
to covering tests). When a goal is `uncovered`, inject its description into
the next crawl's `buildJourneyPrompt()` context: *"This goal is currently
uncovered: [description]. Prioritize generating tests that verify this
workflow."* This closes the feedback loop from coverage gap → targeted
generation.

**Migrations:**
```sql
-- NNN_run_coverage_matrix.sql
ALTER TABLE runs ADD COLUMN coverageGaps TEXT DEFAULT '[]';
ALTER TABLE runs ADD COLUMN goalCoverage TEXT DEFAULT '[]';
ALTER TABLE projects ADD COLUMN coverageGapAlertThreshold INTEGER DEFAULT 0;
ALTER TABLE projects ADD COLUMN anomalyThresholdPct INTEGER DEFAULT 15;

CREATE TABLE project_goals (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'uncovered',
  linkedTestIds TEXT DEFAULT '[]',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE test_coverage_matrix (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  testId TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  UNIQUE(testId, url)
);
CREATE INDEX idx_tcm_project_url ON test_coverage_matrix(projectId, url);
```

**Files to change:**
- `backend/src/database/migrations/NNN_run_coverage_matrix.sql` (new)
- `backend/src/utils/anomalyDetector.js` (new)
- `backend/src/pipeline/goalCoverageAgent.js` (new)
- `backend/src/database/repositories/goalRepo.js` (new) — CRUD
- `backend/src/database/repositories/testCoverageMatrixRepo.js` (new)
- `backend/src/pipeline/testPersistence.js` — call
  `testCoverageMatrixRepo.record()` per persisted test
- `backend/src/crawler.js` — compute `coverageGaps`; call
  `goalCoverageAgent.analyze()` post-run; anomaly detection post-run
- `backend/src/pipeline/prompts/journeyPrompt.js` — inject uncovered goals
  into prompt when present
- `backend/src/testRunner.js` — trigger anomaly detection + AI insights
  after `runFeedbackLoop()`
- `backend/src/routes/projects.js` — goal CRUD (`GET/POST/PATCH/DELETE
  /projects/:id/goals`); `GET /projects/:id/coverage-matrix`
- `backend/src/routes/dashboard.js` — AI insights generation + cache;
  anomaly signal in dashboard response
- `frontend/src/pages/ProjectDetail.jsx` — Goals panel (CRUD + coverage
  status badges)
- `frontend/src/pages/Dashboard.jsx` — Goal Coverage card; AI Insights card;
  anomaly warning banner (AUTO-011 + AUTO-021)
- `frontend/src/pages/RunDetail.jsx` — `"Uncovered Pages"` section;
  `goalCoverage` summary
- `frontend/src/api.js` — goal CRUD helpers; `getCoverageMatrix(projectId)`
- `backend/tests/anomaly-detector.test.js` (new)
- `backend/tests/goal-coverage-agent.test.js` (new)
- `backend/tests/coverage-matrix.test.js` (new)
- `backend/tests/run-tests.js` — register all three
- `docs/guide/goal-based-testing.md` (new)
- `QA.md` — `"Goal coverage (B8)"` manual test plan section
- `docs/changelog.md` — `## [Unreleased]` § Added (closes AUTO-011 +
  AUTO-021 + SCL-004 + GOL-001)

**Acceptance criteria:**
- Pass rate drop of >15% vs 5-run baseline triggers `anomalyAlert: { detected:
  true, delta: -N }` in the dashboard response + FEA-001 notification.
- AI Insights card renders a 3–5 sentence explanation citing specific failure
  categories.
- An operator creates goal "Checkout flow completes" — the system maps
  existing checkout tests to it and marks it `covered`; a goal with no
  matching tests is `uncovered`.
- The next run's journey prompt includes the uncovered goal description.
- `run.coverageGaps = ['/billing', '/admin']` when those URLs had tests in a
  prior run but not in the current crawl.
- `GET /projects/:id/coverage-matrix` returns the URL → test-count matrix
  for CI consumers.

**Dependencies:** B3 (reviewer collapse — goal coverage agent uses
`agentRole: 'oracle'` from the AUTO-023 closed tool set, which must not be
collapsed), AUTO-023 ✅ (oracle agent role + tool registry), AUTO-009 ✅
(coverage infrastructure), FEA-001 ✅

---

## Phase 6 — Full Issue Register

| Bundle | Items | Priority | Effort | Status |
|--------|-------|----------|--------|--------|
| B1 — Run persistence + crash recovery | RLY-001, RLY-008, RLY-005 | 🔴 P0 | L | ✅ Complete (PR #2) |
| B2 — iframe + adaptive timeouts + SPA | RLY-006, RLY-009 | 🔴 P0 | L | ✅ Complete (this PR) |
| B3 — Reviewer independence + escalation | RLY-003, QAL-004 | 🔴 P0 | M | 🔲 Planned |
| B4 — Auth recovery + target-app TOTP | RLY-004, SCL-001 | 🔴 P0 | M | 🔲 Planned |
| B5 — Test dependency ordering | AUTO-014 | 🟡 P1 | M | ✅ Complete |
| B6 — Test quality gates | QAL-001, QAL-005, QAL-002, QAL-010 | 🟡 P1 | XL | 🔲 Planned |
| B7 — Healing safety + context robustness | QAL-006, QAL-007, QAL-008, QAL-009, QAL-011 | 🟡 P1 | L | 🔲 Planned |
| B8 — Goal-based autonomy + coverage | GOL-001, SCL-004, AUTO-011, AUTO-021 | 🟢 Strategic | XL | 🔲 Planned |

**Totals — Phase 6:** ✅ Done: 3 (B1 — 3 sub-items, B2 — 2 sub-items, B5 — 1 sub-item) · 🔲 Pending: 5 bundles (22 sub-items, includes QAL-011 added under B7 by B2)

---

## Execution Order and Wave Plan

```
Wave 1 — P0 Foundation (can parallelise B1 + B2 if B2 stubs loadMs column):
  B1 (run persistence + snapshot streaming)
  B2 (iframe + SPA + adaptive timeout) ← depends on B1 for crawl_snapshots.loadMs

Wave 2 — P0 Auth + Quality (after Wave 1 lands):
  B3 (reviewer independence) ← independent, can run parallel with B4
  B4 (auth recovery + TOTP)  ← independent, can run parallel with B3

Wave 3 — P1 (after Wave 2 lands):
  B5 (AUTO-014 — current PR, already in flight)
  B6 (test quality gates) ← depends on B3 for reviewerCollapsed check
  B7 (healing safety)     ← depends on B1 for write-batching high-priority queue

Wave 4 — Strategic (after all P1 waves):
  B8 (goal-based autonomy) ← absorbs AUTO-011 + AUTO-021 from queue
```

**Estimated total effort (2-engineer team):**
- Wave 1–2 (P0 Bundles 1–4): ~10–14 weeks
- Wave 3 (P1 Bundles 5–7): ~8–10 weeks
- Wave 4 (Strategic Bundle 8): ~6–8 weeks
- **Total: ~24–32 weeks (6–8 months)**

---

## Recommended NEXT.md Queue After B5 (AUTO-014) Ships

```
Current PR: B5 (AUTO-014)

Queue:
  B1 (run persistence + crash recovery)
  B2 (iframe + SPA + adaptive timeout) [parallelise with B1 if possible]
  B3 (reviewer independence + escalation)
  B4 (auth recovery + target-app TOTP)
  B6 (test quality gates)
  B7 (healing safety + context robustness)
  B8 (goal autonomy — absorbs AUTO-011 + AUTO-021 from current queue)
```

**Note on AUTO-011 + AUTO-021 queue items:** These two items are currently
queued in NEXT.md as standalone entries (DIF-008 → SEC-005 → AUTO-011 →
AUTO-021). DIF-008 and SEC-005 are independent of this Phase 6 work and can
remain in their queue positions. AUTO-011 and AUTO-021 should be folded into
B8 when B8 is promoted to Current PR — delete their queue slots at that time
and update their ROADMAP.md entries to `bundled into B8`.

---

## Phase Summary Row (add to ROADMAP.md Phase Summary table)

| Phase 6 — Audit Resolution (May 2026) | Reliability · coverage · agent quality · autonomous intelligence | 🔲 Planned — 4 P0 bundles + 3 P1 bundles + 1 Strategic bundle (27 sub-items) | 24–32 weeks |
