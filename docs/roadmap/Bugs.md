# Bundle B — `fix: browser runtime + self-healing reliability`
## Branch
`bundle-b` off `develop`.
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
