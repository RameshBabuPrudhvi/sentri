# Bundle A — `fix: pipeline + agent correctness sweep`
## Branch
`bundle-a-pipeline-correctness` off `develop`.
## Goal
Land all pure-logic correctness fixes across the agent loop, envelope chain,
deduplicator, validator, and pipeline orchestrator. Zero new features. Zero
new env vars. Each commit ships its own test.
## Commit boundaries
One commit per fix. Each commit:
- One bug, one rationale, one test file (new or amended).
- Commit body cites the file + line range AND the test that pins the fix.
- Changelog entry under `## [Unreleased]` per commit.
## Fix list
### Agent envelope chain
1. **Orchestrator threads `replyToId` across supervisor handoffs**
   - File: `backend/src/aiProvider/agentOrchestrator.js:177-186`
   - Track `lastEmittedMsgId` in `runAutonomousThread`; pass into the next
     `emitAgentMessage`. Match the pattern at `backend/src/aiProvider/agentLoop.js:439`.
   - Test: pin multi-step thread persists connected reply chain.
2. **`emitHandoffEnvelope` fires on failed heals, not only successes**
   - File: `backend/src/selfHealing.js:241-319`
   - Add `kind: "vision_pixelmatch_failed"` / `"vision_llm_failed"` envelope
     emission on declined heals with `healed: false`.
   - Test: pin envelope emission on declined heal path.
3. **`reviewer_verdict_downgraded` Prometheus counter**
   - File: `backend/src/aiProvider/agentLoop.js:407-424`
   - Add `app_reviewer_verdict_downgraded_total{reason}` counter; bump on
     `safeIssues.length === 0` downgrade.
   - Test: stub reviewer with unknown testIds, assert metric increments.
4. **Verify `agentEnvelope.js` Zod schema accepts `supervisor`**
   - File: `backend/src/aiProvider/agentEnvelope.js`
   - Bundle 4 added `supervisor` to backend/frontend role lists. Verify the
     Zod enum was updated. If not, add it.
   - Test: pin `validateEnvelope({ fromRole: "supervisor", toRole: "author", ... })`
     accepts without throwing.
5. **`normalizeVerdict` maps envelope `intent: "revise"` to `request_revision`**
   - File: `backend/src/aiProvider/agentLoop.js:45-69`
   - Mirror the existing `reject → reject_final` remap (line 60). Without
     this, a reviewer returning `{ intent: "revise" }` silently normalises
     to `"accept"`.
   - Test: pin all envelope INTENTS through `normalizeVerdict`, assert
     `"revise"` returns `"request_revision"`.
### Pipeline orchestrator
6. **Reset `run.secretScanBlocked` at orchestrator entry**
   - File: `backend/src/pipeline/pipelineOrchestrator.js:200-202`
   - Add `run.secretScanBlocked = false` at the top of
     `runPostGenerationPipeline` so re-entry doesn't carry stale flag.
   - Test: pin re-entry with a previously-blocked run, second batch clean →
     flag is `false`.
7. **Re-score quality AFTER healing transforms, not before**
   - File: `backend/src/pipeline/pipelineOrchestrator.js:151-178`
   - Current order: enhance → re-score (Step 6a) → healing transforms →
     validate. Transforms strip `getByRole`/`getByLabel`/`getByText` (the
     `selector.semantic` reward). Move the Step 6a re-score below the
     healing-transforms block.
   - Test: pin a test with `page.click("Submit")` → after pipeline, quality
     score reflects the post-transform `safeClick` shape (no regression vs.
     pre-PR behaviour for tests that didn't need transforming).
8. **`buildImprovementPrompt` byte-size cap on element JSON**
   - File: `backend/src/pipeline/feedbackLoop.js:425`
   - Cap `JSON.stringify(elements.slice(...))` output to 8000 chars; append
     `…[truncated]` marker.
   - Test: pin a 200-element fixture stays under 8KB in the rendered prompt.
9. **`regenerateFailingTest` surfaces non-abort errors**
   - File: `backend/src/pipeline/feedbackLoop.js:771-774`
   - Add `console.warn(formatLogLine(...))` + new metric
     `app_feedback_loop_regeneration_failures_total{reason}` before the
     `return null`.
   - Test: stub `generateText` to throw a non-abort error, assert metric
     bumps and warn log fires.
10. **`detectFlakyTests` scoped to last N runs**
    - File: `backend/src/pipeline/feedbackLoop.js:230-262`
    - Cap to last 50 runs (parameter, defaults to 50). O(runs × results)
      bounded at 50 × tests_per_run instead of all-time.
    - Test: pin 100-run fixture, assert only last 50 considered.
### Deduplicator
11. **Fuzzy/semantic dedup respects `scenario` field**
    - File: `backend/src/pipeline/deduplicator.js:380-413, 469-495`
    - Add `candidate.scenario === kept.scenario` guard alongside the
      existing `sourceUrl` guard. Prevents "Login with valid credentials"
      vs "Login with invalid credentials" being deduplicated.
    - Test: pin positive + negative scenario tests with similar names on
      same URL → both retained.
12. **Per-`sourceUrl` bucketing before O(n²) layer**
    - File: `backend/src/pipeline/deduplicator.js:336-417`
    - Bucket by `sourceUrl` first; run fuzzy/semantic only within each
      bucket. Already gated by URL equality inside the loop, so this is
      pure perf — same correctness, much faster.
    - Test: pin a 1000-test batch across 10 URLs completes in < 2s.
13. **Real IDF over batch in `semanticSimilarity`**
    - File: `backend/src/pipeline/deduplicator.js:99-182`
    - Build a document-frequency map once per batch; use real TF-IDF
      instead of just TF. Reduces false-positives from common domain words.
    - Test: pin "submit user form" vs "submit user search" no longer
      cosine-collide above threshold.
### Test validator + assertion enhancer
14. **`hasNoAssertions` uses `HAS_PAGE_LOAD_ASSERTION_RE`-style regex**
    - File: `backend/src/pipeline/assertionEnhancer.js:38-40`
    - Replace `!playwrightCode.includes("expect(")` with the same
      anchored-after-expect regex used in `hasStrongAssertions`.
    - Test: pin a test with `console.log("expect(loaded)")` and no real
      `expect()` → still flagged as having no assertions.
15. **`enhanceTest` regex anchors use `/m` flag**
    - File: `backend/src/pipeline/assertionEnhancer.js:241, 259, 275`
    - Add `/m` to the `(\}\s*\);\s*$)/` pattern. Currently `$` matches only
      end-of-string; tests with trailing newlines / comments silently skip
      injection.
    - Test: pin a test ending with `});\n// comment` gets assertions
      injected correctly.
16. **`INTENT_TEMPLATES.AUTH` scopes "Invalid" check to error region**
    - File: `backend/src/pipeline/assertionEnhancer.js:75-78`
    - Replace `page.locator('body').not.toContainText('Invalid')` with
      `page.locator('[role="alert"], .error, .field-error').not.toContainText('Invalid').catch(() => {})`.
    - Test: pin a page rendering legitimate "Invalid email format" hint
      text → AUTH assertion doesn't false-positive.
17. **`VALID_PAGE_ACTIONS` expanded for missing Playwright methods**
    - File: `backend/src/pipeline/testValidator.js:36-80`
    - Add at minimum: `boundingBox`, `addScriptTag`, `addStyleTag`,
      `bringToFront`, `pdf`, `exposeFunction`, `exposeBinding`, `setContent`,
      `setOfflineMode`, `coverage`. Audit against current `@playwright/test`.
    - Test: pin a test using each newly-added method → no
      "invalid Playwright method" rejection.
18. **`ASSERTION_RE` non-catastrophic backtracking**
    - File: `backend/src/pipeline/testValidator.js:161`
    - Replace `(.+)` with `([^;]+)` or anchor to line end. Prevents
      catastrophic regex performance on minified single-line test bodies.
    - Test: pin a 5KB single-line test body completes validation in < 200ms.
### Cross-cutting consistency
19. **Extract `botDetectionPatterns` to shared module**
    - Files: `backend/src/pipeline/feedbackLoop.js:89-113`,
      `backend/src/pipeline/stateExplorer.js:50-54`
    - Create `backend/src/utils/botDetection.js`. Both consumers import.
      Fixes the existing drift where `feedbackLoop.js` has the
      `\/blocked(?:[/?#]|$)` boundary fix but `stateExplorer.js` does not.
    - Test: pin both consumers reject `/blocked` and accept `/blocked-users`.
20. **`emitAgentEvent` uses `agent: "system"` for deterministic stages**
    - File: `backend/src/pipeline/pipelineOrchestrator.js:95, 121, 187`
      and other deterministic call sites
    - Steps 5 (dedup), 6 (enhance), 7 (validate) are NOT LLM calls. Label
      them as `agent: "system"` instead of `agent: "author"` so the
      conversation UI doesn't conflate mechanical post-processing with
      actual author LLM runs.
    - Test: pin the agent_event rows for steps 5/6/7 carry `agent: "system"`.
## Acceptance criteria
- [ ] `cd backend && npm test` passes
- [ ] Each commit has matching test changes
- [ ] `docs/changelog.md` updated under `## [Unreleased]` with one bullet per
      commit
- [ ] No new env vars
- [ ] No frontend changes (this bundle is backend-only)
- [ ] PR description lists all 20 fixes with file:line citations
## Rollback
Single PR revert. Each commit is also individually revertable if a fix
turns out to be wrong.
# Bundle B — `fix: browser runtime + self-healing reliability`
## Branch
`bundle-b-runtime-reliability` off `develop`.
## Goal
Land all runtime + browser-process correctness fixes. Higher blast radius
than Bundle A because it touches Playwright lifecycle and the crawl path.
Requires Golden E2E re-run before merge.
## Commit boundaries
One commit per fix. Each commit ships its own test where possible (browser
lifecycle bugs may need integration tests rather than unit tests).
## Fix list
### Browser automation correctness
1. **Network log race on duplicate URLs**
   - File: `backend/src/runner/executeTest.js:348-361`
   - Replace `networkLogs.find((n) => n.url === res.url() && n.status === null)` with a `WeakMap<Request, entry>` keyed by the
     Playwright `Request` object passed to the `request` event handler.
   - Test: pin two concurrent same-URL requests with staggered response
     order land in their correct entries.
2. **Timeout path stops screencast before page.close**
   - File: [backend/src/runner/executeTest.js:589-598](#file-backend%2Fsrc%2Frunner%2FexecuteTest.js%3A589-598)
   - In the timeout-reject handler, call `stopScreencast?.()` before
     `page.close()`. Currently the `finally` block runs after the page is
     already dead.
   - Test: pin a timed-out test does not produce unhandled rejections from
     a dead CDP session.
3. **Sync FS I/O on video cleanup → async**
   - File: [backend/src/runner/executeTest.js:972-1002](#file-backend%2Fsrc%2Frunner%2FexecuteTest.js%3A972-1002)
   - Convert `fs.readdirSync`, `fs.readFileSync`, `fs.unlinkSync`,
     `fs.renameSync`, `fs.rmSync` to `fs/promises` equivalents.
   - Test: pin behaviour unchanged for the existing video tests; benchmark
     parallel-run cleanup shows event-loop unblocked.
4. **Cap `networkLogs` size**
   - File: [backend/src/runner/executeTest.js:329](#file-backend%2Fsrc%2Frunner%2FexecuteTest.js%3A329)
   - Add `MAX_NETWORK_LOG_ENTRIES = 500` ring buffer. When the buffer is
     full, evict the oldest entry on each new push.
   - Test: pin 1000 requests result in 500 entries with the oldest evicted.
5. **Browser-health probe before each test**
   - File: [backend/src/runner/executeTest.js:439-444](#file-backend%2Fsrc%2Frunner%2FexecuteTest.js%3A439-444)
   - Replace the raw throw with a `browser.isConnected()` check; if false,
     surface a structured error the parent runner can act on (restart
     browser + retry the test once).
   - Test: stub `browser.isConnected() === false`, assert structured error
     propagates and parent runner can recover.
6. **Per-run downloads directory**
   - File: [backend/src/runner/executeTest.js:468](#file-backend%2Fsrc%2Frunner%2FexecuteTest.js%3A468)
   - Set `downloadsPath` on `browser.newContext()` to a per-run temp dir;
     wipe in the run-cleanup hook.
   - Test: pin downloads land in the per-run dir and the dir is removed
     after run completion.
### Self-healing reliability
7. **Stage 7 pixelmatch failure recorded via `recordHealingFailure`**
   - File: [backend/src/selfHealing.js:236-260](#file-backend%2Fsrc%2FselfHealing.js%3A236-260)
   - Add `recordHealingFailure(ctx.testId, ctx.action, ctx.label)` on the
     stage-7 decline path before falling through to stage 8.
   - Test: pin a failed pixelmatch heal increments `failCount` on the
     healing repo row.
8. **`STRATEGY_VERSION` mismatch surfaces a metric**
   - File: `backend/src/selfHealing.js:95, 113, 137`
   - Add `app_healing_hints_discarded_total{reason="version_mismatch"}`
     counter; bump in both `getHealingHint` and
     `getHealingHistoryForTest` when the version check rejects a row.
   - Test: pin metric increments when version mismatch occurs.
9. **`buildPierceLocator` honest naming**
   - File: [backend/src/selfHealing.js:384-392](#file-backend%2Fsrc%2FselfHealing.js%3A384-392)
   - Current implementation `page.locator(\`css=\${rawSelector}\`)` is
     plain CSS, not shadow piercing. EITHER fix to use Playwright's `>>`
     chained engines for real shadow piercing, OR rename to
     `buildCssLocator` + drop the misleading comment.
   - Recommended: fix to use `>>>` shadow combinator OR `:light()` /
     pierce-aware selectors. If that's too risky, the rename is acceptable
     as long as docs change too.
   - Test: pin against a shadow-DOM fixture page; assert pierce locator
     actually finds the inner element.
10. **`HEALING_HINT_MAX_FAILS` TTL-based decay**
    - File: [backend/src/selfHealing.js:126](#file-backend%2Fsrc%2FselfHealing.js%3A126)
    - Add `HEALING_HINT_DECAY_DAYS = 7` env var. In `getHealingHint` /
      `getHealingHistoryForTest`, if the row's `succeededAt` is older than
      the decay window AND `failCount` is at the cap, reset `failCount` to
      `0` so the hint gets another chance.
    - Test: pin stale hint with `failCount === 3` and
      `succeededAt = 8 days ago` is re-eligible after decay.
11. **`__valueIntents` keyed by step index**
    - File: [backend/src/selfHealing.js:747](#file-backend%2Fsrc%2FselfHealing.js%3A747)
    - Append step index to the key: `"fill::Name::step3"`. Prevents the
      second `safeFill(page, "Name", "bob")` from overwriting the value
      the first `safeFill(page, "Name", "alice")` recorded.
    - Test: pin two same-label fills with different values both retain
      their value intent for vision heal re-action.
### State explorer reliability
12. **`launchBrowser()` failure wrapped in outer try/catch**
    - File: [backend/src/pipeline/stateExplorer.js:306](#file-backend%2Fsrc%2Fpipeline%2FstateExplorer.js%3A306)
    - Wrap `const browser = await launchBrowser();` in outer try with
      structured log on failure, so the error surfaces with context
      instead of bubbling raw.
    - Test: stub `launchBrowser` to throw, assert structured log fires.
13. **State explorer login switches `networkidle` → `domcontentloaded`**
    - File: `backend/src/pipeline/stateExplorer.js:334, 342`
    - Both `await loginPage.waitForLoadState("networkidle", ...)` calls
      become `domcontentloaded` to match the codebase convention enforced
      by `feedbackLoop.js#TIMEOUT` insight.
    - Test: pin `applyHealingTransforms` of stateExplorer login code path
      doesn't trip the `networkidle` rejection (heuristic test).
14. **`GLOBAL_TIMEOUT_MS` absolute cap**
    - File: [backend/src/pipeline/stateExplorer.js:315](#file-backend%2Fsrc%2Fpipeline%2FstateExplorer.js%3A315)
    - Cap at 15 minutes regardless of `maxStates × actionTimeout × 2`
      multiplication. Surface the effective timeout in the log line so
      operators see the cap when their tuning would exceed it.
    - Test: pin `maxStates=100, actionTimeout=15000` yields a 15-min cap,
      not 50 min.
15. **`restorePage` returns success boolean**
    - File: [backend/src/pipeline/stateExplorer.js:236-243](#file-backend%2Fsrc%2Fpipeline%2FstateExplorer.js%3A236-243)
    - Return `true` on success, `false` when both goto attempts fail. The
      caller breaks out of the inner loop on `false` to prevent the next
      action running against an unknown page state.
    - Test: stub both goto attempts to fail; assert caller breaks out.
16. **`crawlLinks` deduplicates + caps link count per page**
    - File: [backend/src/pipeline/stateExplorer.js:255-287](#file-backend%2Fsrc%2Fpipeline%2FstateExplorer.js%3A255-287)
    - Dedupe extracted links by normalised URL; cap to 50 per page.
      Prioritise same-path-prefix when capping.
    - Test: pin 500-link page processes at most 50 links per
      `crawlLinks` invocation.
17. **`executeAction` for fill uses single `.fill(value)` call**
    - File: [backend/src/pipeline/stateExplorer.js:122](#file-backend%2Fsrc%2Fpipeline%2FstateExplorer.js%3A122)
    - Remove the `await el.fill("")` intermediate call. `.fill(value)`
      already clears.
    - Test: pin SPA form with React Hook Form fires onChange exactly once
      per fill.
18. **`syncRunPages` throttled to one update per 500ms**
    - File: [backend/src/pipeline/stateExplorer.js:227-234](#file-backend%2Fsrc%2Fpipeline%2FstateExplorer.js%3A227-234)
    - Add `lastSyncMs` timestamp; skip the DB write + SSE broadcast when
      called within 500ms of the last call. Force a final flush at end of
      exploration.
    - Test: pin 30 rapid novel-state captures result in ≤ 4 DB writes
      across a 1500ms simulated window.
19. **State explorer metrics**
    - File: [backend/src/pipeline/stateExplorer.js](#file-backend%2Fsrc%2Fpipeline%2FstateExplorer.js)
    - Add at minimum:
      - `app_explorer_states_discovered_total{projectId}`
      - `app_explorer_actions_attempted_total{type}`
      - `app_explorer_bot_block_skips_total`
      - `app_explorer_global_timeout_total`
      - `app_explorer_duration_seconds` histogram
    - Test: pin each metric is registered + bumps on the expected event.
20. **`detectSignupIntent` flow preserves partial-action audit**
    - File: [backend/src/pipeline/stateExplorer.js:503-510](#file-backend%2Fsrc%2Fpipeline%2FstateExplorer.js%3A503-510)
    - Track `mailboxFlowExecutedActions` and `standardFlowExecutedActions`
      separately. On fallback to standard flow, concatenate rather than
      overwrite.
    - Test: pin a signup-flow throw after partial fills retains the
      mailbox-flow fills in the audit trail.
## Acceptance criteria
- [ ] `cd backend && npm test` passes
- [ ] Each commit has matching test changes (or a documented reason why
      integration testing is required — those listed in the PR description
      and the Golden E2E re-run report)
- [ ] **Golden E2E suite re-run before merge** (this bundle touches
      Playwright lifecycle + crawl path)
- [ ] [docs/changelog.md](#file-docs%2Fchangelog.md) updated under `## [Unreleased]` with one bullet
      per commit
- [ ] [QA.md](#file-QA.md) walked for affected flows: Test Lab run, crawl mode, vision
      healing, self-healing strategy waterfall
- [ ] No new features. New env vars allowed only for the documented
      behaviour caps (e.g. `HEALING_HINT_DECAY_DAYS`,
      `MAX_NETWORK_LOG_ENTRIES`). All documented in [docs/guide/env-vars.md](#file-docs%2Fguide%2Fenv-vars.md).
- [ ] PR description lists all 20 fixes with file:line citations
## Rollback
- Per-commit revert preferred when possible.
- Full-bundle revert is safe: every fix preserves pre-PR behaviour as the
  fail-open / fail-closed default.
- If only the state explorer changes regress, that's commits 12–20 (8
  commits) and can be reverted as a block.
## Notes for the implementing agent
- Each commit should follow Conventional Commits: `fix(scope): one-line
  description`. Examples:
  - `fix(runner): network log race on duplicate URLs`
  - `fix(explorer): cap link extraction at 50 per page`
  - `fix(self-healing): record stage-7 pixelmatch failures`
- Don't bundle multiple fixes in one commit even if they touch the same
  file. Commit hygiene > diff convenience.
- When in doubt about whether a fix needs an env-var cap, default to a
  hardcoded constant + comment. Avoid env-var bloat.
- Tests-with-fixes is non-negotiable. Even integration-y bugs (browser
  lifecycle) should pin behaviour via stubs at minimum.
- Run `cd backend && npm test` after each commit, not just at the end.
- Update [docs/changelog.md](#file-docs%2Fchangelog.md) in the SAME commit as the fix, not a
  separate doc commit at the end.
