# Autonomous QA v2 — live browser, vision, goal-driven (AUTO-024)

> **Status:** roadmap draft. Nothing in this document is implemented.
> Every checkbox starts unchecked and stays that way until the
> corresponding code lands and is verified.

## Honest framing — what AUTO-023 shipped vs what this roadmap addresses

AUTO-023 (`docs/roadmap/autonomous-multi-agent.md`) shipped a real
**multi-agent orchestration substrate**: envelope schema, reviewer↔author
loop, supervisor orchestrator, tool registry, per-workspace mode flag.
That work is sound and the roadmap is faithfully implemented.

**It is not, by itself, an industry-standard autonomous QA platform.**
In AUTO-023's `autonomous` mode the supervisor *routes between roles*
but each role still does the same work as `pipeline` mode:

| Role | What `autonomous` mode does today (verified in this codebase) |
|---|---|
| `explorer` | `intentClassifier.classifyPageWithAI` — static DOM analysis |
| `planner` | `journeyGenerator.generateJourneyTest` — static codegen |
| `author` | `journeyGenerator.generateFromDescription` — static codegen |
| `reviewer` | `generateText({ agentRole: "reviewer" })` — judge prompt |
| `oracle` | `generateText({ agentRole: "oracle" })` — judge prompt |

Source: `backend/src/aiProvider/autonomousDispatch.js:128-210`.

The reviewer's "did this test compile?" check today is a **static**
syntax + selector check via `pipeline/testValidator.js` (called from
`backend/src/aiProvider/agentTools/runtime.js:451-479`). No tool in
the AUTO-023 registry executes browser actions, captures screenshots,
or observes a real Playwright run mid-thread.

**Industry-standard autonomous QA** (browser-agent products such as
Skyvern, browser-use, Anthropic computer-use; AI-QA products such as
Magnitude, Momentic, QA Wolf's AI engine) generally exhibit the
following characteristics — this roadmap targets adding them to
Sentri:

1. A **live browser tool surface** the agent can call mid-thread
   (`browser.navigate`, `browser.click`, `browser.type`, etc.).
2. **Vision** — the agent reads page screenshots, not just DOM.
3. **Closed-loop execution** — the agent writes a step, runs it,
   observes pass/fail, corrects.
4. **Goal-driven entry** — input is "verify the checkout flow",
   not "crawl this URL and generate tests".
5. **Persistent learning** — selector aliases / failure patterns
   carry across runs.

> ASSUMPTION: the characteristics above are the consensus pattern
> across the products named, but I have not personally instrumented
> each one. Treat this list as a target architecture, not a vendor
> claim.

## Relationship to AUTO-023

AUTO-023 is the **substrate**. v2 is the **execution surface**. v2
strictly builds on what AUTO-023 already provides:

- Envelope schema + `agent_messages` audit trail → re-used unchanged
- `runAutonomousThread` orchestrator → entry point for v2 sessions
- Per-workspace `agentMode` column → gains a new `'autonomous_v2'` value
- Tool registry + `executeToolCall` runtime → gains new tool families
- `quotaGuard` integration → re-used; v2 tools count under the same caps
- AbortSignal threading → re-used; long browser sessions must remain abortable

v2 does **not** replace v1. A workspace can be on `pipeline`,
`envelope`, `autonomous` (v1 supervisor-routed), or `autonomous_v2`
(this roadmap). v1 stays the default for cost + safety reasons; v2 is
opt-in for workspaces that want goal-driven autonomy and accept the
higher per-run cost.

## Naming honesty (RECOMMENDED, separate proposal)

Before v2 lands, consider renaming v1's `autonomous` to `orchestrated`
(or similar) so users don't conflate supervisor-routed pipeline mode
with v2's true autonomous execution. This is a UX proposal, not a v2
prerequisite — but if v2 ships with both modes called "autonomous",
operator confusion is guaranteed. Tracked separately.

---

# Bundle 6 — Live browser tool surface

**Goal:** give an agent the ability to drive a real browser
mid-thread, not just emit static test code for later execution.

This is the **single largest piece**. Everything in v2 depends on it.

## B6.1 — Sandboxed BrowserContext lifecycle
- [ ] One `BrowserContext` per `threadId`, lazily created on first
      browser tool call, torn down on thread termination
- [ ] Sandbox profile: no persistent storage outside the run's
      artifact dir, no file picker, restricted permissions
- [ ] Per-context resource ceiling (wall-clock, max page count,
      max DOM nodes) so a runaway thread can't exhaust the runner
- [ ] Reuse existing `runner/executor.js` Playwright primitives where
      possible — do NOT introduce a parallel Playwright surface

> ASSUMPTION: Sentri's existing `runner/executeTest.js` already
> manages a sandboxed Playwright context per test run. I have not
> verified its sandbox profile is suitable for an agent-driven session
> (longer-lived, multi-turn, LLM-controlled). A pre-bundle audit is
> required.

## B6.2 — Browser tool family (closed set)
Initial set, intentionally minimal:
- [ ] `browser.navigate({url, waitFor?})` → `{ok, status, finalUrl}`
- [ ] `browser.click({selector|aiHint, timeoutMs?})` → `{ok, error?}`
- [ ] `browser.type({selector|aiHint, text, submit?})` → `{ok, error?}`
- [ ] `browser.snapshot({mode, trim?})` → `{dom?, screenshotRef?}`
- [ ] `browser.assert({hint, mode})` → `{pass, evidence}`
- [ ] `browser.wait({forSelector|forUrl|ms, timeoutMs})` → `{ok}`

Screenshots are stored as ref-IDs in a per-thread blob store; inline
base64 would blow the `agent_messages.artifact` column budget.

## B6.3 — Tool registry integration
- [ ] Extend `backend/src/aiProvider/agentTools/index.js` `TOOL_SCHEMAS`
      with Zod schemas for each browser tool
- [ ] Add `mutate: true` flag in tool metadata (v1 was read-only by
      design — `docs/roadmap/autonomous-multi-agent.md:611-613`); v2
      formalises the mutation surface
- [ ] Extend `TOOL_ROLES` so only `explorer` + `author` get browser
      tools by default; `reviewer` gets read-only `snapshot` + `assert`
- [ ] Per-workspace `agent_configs.allowedTools` allowlist still gates
      visibility (migration 064 contract preserved)

## B6.4 — Per-tool quota + safety
- [ ] Browser actions count under the existing `quotaGuard` USD cap
- [ ] Hard per-thread cap: max N browser actions (default 50, hard
      ceiling 500)
- [ ] Hard wall-clock: per-thread browser-session timeout
      (default 5 min, hard cap 15 min)
- [ ] Existing rate limiter in
      `backend/src/aiProvider/agentTools/runtime.js#checkToolRateLimit`
      applies; per-tool limits need tuning (click cheap, snapshot+
      screenshot expensive)
- [ ] Per-tool circuit breaker — N consecutive `navigate` failures
      collapses to fallback

> ASSUMPTION: a generic `aiProvider/circuitBreaker.js` may not exist
> in the current codebase. If not, B6.4 needs a new minimal breaker.

## B6.5 — Tests
- [ ] `backend/tests/agent-browser-tool-registry.test.js`
- [ ] `backend/tests/agent-browser-context-lifecycle.test.js`
- [ ] `backend/tests/agent-browser-quota-cap.test.js`
- [ ] `backend/tests/agent-browser-abort.test.js` — AbortSignal mid
      `browser.navigate` aborts cleanly without leaking a context

## B6.6 — Exit criteria
- [ ] Agent completes a 5-step browser-driven flow end-to-end on a
      smoke-test fixture
- [ ] BrowserContext reliably torn down on every termination path
      (accept, max_steps, timeout, quota_exhausted, aborted, throw)
- [ ] Zero regression in AUTO-023 v1 modes

---

# Bundle 7 — Vision-enabled roles

**Goal:** let the author + reviewer reason from screenshots, not just
DOM trees. Handles canvas-rendered UIs, dynamic React, and visual
regressions that DOM-only inspection misses.

## B7.1 — Capability flag
- [ ] Add `agent_configs.requiresVision BOOLEAN DEFAULT 0` (migration)
- [ ] `agentHealthCheck.js` probe validates a role flagged
      `requiresVision = true` resolves to a vision-capable model
      (Claude Sonnet/Opus, GPT-4o/4.1, Gemini Pro — closed list)
- [ ] Operator-visible Settings UI error when a `requiresVision` role
      is routed to a non-vision model
- [ ] Settings UI tags vision-capable models in the route dropdown

## B7.2 — Vision-aware prompts
- [ ] Author prompt variant that includes the latest `browser.snapshot`
      screenshot as image content (provider-specific multipart shape)
- [ ] Reviewer prompt variant that observes a test's execution
      screencast frames (final-state screenshot at minimum)
- [ ] Cost guard: vision tokens are more expensive than text tokens —
      surface a per-step cost estimate before the call

> ASSUMPTION: vision-token pricing differs from text-token pricing
> across providers; exact multipliers vary. The cost guard is a
> percentage-of-text-budget cap, not a fixed token count.

## B7.3 — Screenshot blob store
- [ ] Per-thread blob storage (filesystem under run artifact dir;
      Redis-backed for clustered deployments)
- [ ] Ref-ID format: `screenshot-<threadId>-<step>-<uuid>`
- [ ] Retention: collected with the thread on termination + 24h grace
- [ ] Workspace-scoped read enforcement (mirrors `agent_messages`
      contract)

## B7.4 — Tests
- [ ] `backend/tests/agent-vision-capability-probe.test.js`
- [ ] `backend/tests/agent-screenshot-blob-store.test.js`
- [ ] `backend/tests/agent-vision-prompt-shape.test.js` — provider-
      specific multipart format

## B7.5 — Exit criteria
- [ ] Author requires-vision route correctly rejected at health-check
      time when pointed at a non-vision model
- [ ] Reviewer reads a screenshot and rejects a test whose final
      state doesn't match the expected visual outcome
- [ ] Screenshot blob retention enforced; no leakage across workspaces

---

# Bundle 8 — Closed-loop execution

**Goal:** reviewer doesn't just statically lint the author's test —
it runs the test in the sandboxed browser, observes pass/fail, and
feeds the observation back as the next round's author prompt.

This is what turns the AUTO-023 reviewer↔author loop from "static
linter" into "real test-execution feedback".

## B8.1 — `playwright.run` tool (new)
- [ ] New tool: `playwright.run({testCode, timeoutMs?})` →
      `{ok, failedStep?, error?, screencastRef?, finalScreenshotRef?}`
- [ ] Executes inside the same sandboxed BrowserContext from B6
- [ ] Per-call hard timeout, max test length, max steps
- [ ] Captures: per-step success, failure stack trace, screencast,
      final DOM, final screenshot

## B8.2 — Reviewer integration
- [ ] Replace `playwright.dryRun` (static) with `playwright.run`
      (live) in the reviewer's tool allowlist
- [ ] Reviewer prompt updated to consume execution evidence, not
      static-validator diagnostics
- [ ] On failure the reviewer emits `request_revision` with
      `{issues: [{testId, problem: failureReason, suggestion: ...}]}` —
      same envelope contract as AUTO-023 B3.1

## B8.3 — Feedback loop refinement
- [ ] `agentLoop.runReviewerAuthorLoop` (substrate from AUTO-023 B3)
      unchanged — the contract is the same; only the reviewer's
      verdict source changes
- [ ] Author's next-round prompt includes the failed execution
      evidence (screenshot, stack, failing step)
- [ ] Termination guarantees from AUTO-023 B3 preserved verbatim
      (max-rounds, wall-clock, quota, single-agent-collapse warning)

## B8.4 — Cost guard
- [ ] Each `playwright.run` counts as one execution against the
      browser-tool cap from B6.4
- [ ] Per-loop hard cap: max N `playwright.run` invocations regardless
      of revision rounds (default 5, hard ceiling 20) — prevents
      "reviewer keeps rejecting; author keeps regenerating" from
      running real browser sessions until wall-clock fires

## B8.5 — Tests
- [ ] `backend/tests/agent-playwright-run-tool.test.js`
- [ ] `backend/tests/agent-reviewer-execution-feedback.test.js` —
      reviewer rejects a known-failing test; author fixes it next round
- [ ] `backend/tests/agent-execution-cap.test.js` — `playwright.run`
      hard cap fires before max-rounds

## B8.6 — Exit criteria
- [ ] A known-broken test (wrong selector / wrong assertion) gets
      fixed within 1-2 review rounds via execution feedback — pinned
      by a golden-fixture regression test
- [ ] No infinite-execution loops possible — `playwright.run` cap
      enforced server-side regardless of supervisor decisions

---

# Bundle 9 — Goal-driven entry

**Goal:** input contract changes from "URL + description" to "goal".
Agent decomposes goal into steps, executes them, and verifies.

This is the **product-shape change** that turns Sentri into a
goal-driven autonomous tester. v1's `pipeline` and v1's `autonomous`
both stay; v2 adds a new entry point.

## B9.1 — Goal endpoint
- [ ] New: `POST /api/v1/projects/:id/agent-goals` body
      `{goal, startUrl?, dialsPrompt?}`
- [ ] Returns `{runId, threadId}` — the goal-driven session is just
      another `runAutonomousThread` instance with
      `agentMode='autonomous_v2'`
- [ ] Registered in `permissions.json` with appropriate `requireRole()`
- [ ] Frontend consumer: new Test Lab tab "Goal-driven" with a
      large textarea + start button (PROC-001 compliant — no orphan
      route; frontend lands in same PR)

## B9.2 — Goal-decomposition prompt
- [ ] New: `backend/src/prompts/goalDecompositionPrompt.js`
- [ ] Input: goal text + startUrl + workspace policy
- [ ] Output: structured `{subgoals: [{name, acceptance: [string]}], plan: [...]}`
- [ ] Supervisor consumes this as the seed for `runAutonomousThread`
      instead of the existing description-based seed

## B9.3 — Sub-goal threading (OPTIONAL for v2 launch)
- [ ] Each sub-goal can spawn a child thread via a new `thread.spawn`
      tool (supervisor-only, cap 5 children per parent)
- [ ] Children share the parent's quota budget — no nested escalation
- [ ] Termination: parent terminates only when all children terminate
      OR parent-level wall-clock fires
- [ ] Audit log entry on every spawn

> ASSUMPTION: hierarchical patterns are common in CrewAI / AutoGen.
> Whether Sentri needs them at v2 launch vs deferring to v3 is a
> product decision. B9.3 is marked OPTIONAL for the initial release.

## B9.4 — Tests
- [ ] `backend/tests/agent-goal-decomposition-prompt.test.js`
- [ ] `backend/tests/agent-goal-endpoint.test.js` — permissions,
      workspace scoping, registers a v2 thread
- [ ] `backend/tests/agent-goal-e2e.test.js` — `goal="verify the
      checkout flow works"` → ≥1 test produced + executed

## B9.5 — Exit criteria
- [ ] Operator submits a plain-English goal and gets at least one
      executed + passing test back
- [ ] Goal-driven runs surface in the run-history UI alongside
      pipeline runs (no separate run-history surface)

---

# Bundle 10 — Persistent learning

**Goal:** carry knowledge between runs. Selector aliases that worked
previously shortcut DOM lookup on the next run. Common failure
patterns surface as warnings before they fail again.

## B10.1 — Selector alias store
- [ ] New table: `agent_learned_selectors(workspaceId, projectId,
      aiHint, selector, successCount, lastUsedAt)`
- [ ] Populated by `browser.click` / `browser.type` on success when
      the agent used `aiHint` (not a literal selector)
- [ ] Read by future `browser.click({aiHint})` calls as a fast path
      before invoking vision/DOM heuristics
- [ ] Workspace + project scoped — no cross-project leakage

## B10.2 — Failure-pattern memory
- [ ] New table: `agent_failure_patterns(workspaceId, projectId,
      pattern, observedCount, lastObservedAt)`
- [ ] Populated by reviewer findings on rejected tests
- [ ] Surfaced in author prompt: "Common failures on this project:
      ${top 3 patterns}"
- [ ] Retention: 90 days (mirrors `agent_messages` retention)

## B10.3 — Tests
- [ ] `backend/tests/agent-selector-alias-store.test.js`
- [ ] `backend/tests/agent-failure-pattern-store.test.js`
- [ ] `backend/tests/agent-cross-workspace-isolation.test.js` —
      workspace A's aliases never visible to workspace B

## B10.4 — Exit criteria
- [ ] Second run of an identical goal on an unchanged site uses
      cached selector aliases and completes in less than half the
      wall-clock of the first run (pinned by a golden-fixture)
- [ ] Common failure patterns surface in the author prompt as
      "watch out for X" guidance

---

# Cross-bundle invariants (v2)

These must hold across every v2 bundle — verify before merging each PR.

- [ ] `SENTRI_AGENT_MODE=pipeline` (default) and AUTO-023 v1 modes
      behave identically to before AUTO-024 — zero regression for
      workspaces that haven't opted into v2
- [ ] Browser tools and `playwright.run` are sandboxed; no escape to
      host filesystem / network beyond the target site
- [ ] All termination paths bounded — max-rounds, max-steps,
      wall-clock, quota, browser-action cap, `playwright.run` cap
- [ ] BrowserContext lifecycle leak-free: every termination path
      tears down the context (verified by per-bundle tests AND a
      cross-bundle integration test)
- [ ] Workspace scoping enforced on every read of new tables
      (`agent_learned_selectors`, `agent_failure_patterns`,
      `screenshot` blobs)
- [ ] No secrets, full prompts, or PII leaked through screenshots,
      failure patterns, or selector aliases — the persistent stores
      run through the existing CAP-003 `secretScanner` before write
- [ ] `agent_role` and `tool` Prometheus labels remain bounded
      (new tools added to the closed `KNOWN_TOOL_NAMES` set)
- [ ] All new endpoints registered in `permissions.json` with correct
      `requireRole()` gate (PROC-001 compliant — frontend consumer
      lands in same PR)
- [ ] All new tests registered in `backend/tests/run-tests.js`
- [ ] `docs/changelog.md` updated under `## [Unreleased]` per bundle

---

# Risk register

| Risk | Mitigation | Bundle |
|---|---|---|
| Browser tool escape / abuse | Sandboxed BrowserContext, mutate-flag in registry, per-tool quota | B6 |
| Runaway cost from chatty browser session | Hard caps on actions + wall-clock + per-call quota | B6 / B8 |
| Vision-token cost regression | Capability flag + per-step cost estimate + workspace-level toggle | B7 |
| Infinite "fix → fail" loop in closed-loop | Hard `playwright.run` cap independent of revision rounds | B8 |
| Goal endpoint misuse | Permissions gate + per-workspace rate limit + sandboxed execution | B9 |
| Selector alias drift (site changed but cache says it didn't) | Successive-failure decay; aliases auto-evict after N misses | B10 |
| Cross-workspace leakage via persistent stores | Repo-layer workspace scoping; cross-workspace isolation test required | B10 |
| BrowserContext leak | Per-termination-path teardown test; canary metric tracks open contexts | B6 |
| Operator confusion between v1 and v2 "autonomous" | Rename v1 to `orchestrated` BEFORE shipping v2 | pre-v2 |
| Inline screenshots blowing `agent_messages.artifact` budget | Ref-ID indirection; envelope carries only `{screenshotRef}` | B7 |

---

# Out of scope (explicit non-goals)

- ❌ **Replacing v1.** Both `pipeline` and AUTO-023's `autonomous` stay
  shipped; v2 is opt-in per workspace.
- ❌ **Multi-workspace agent dispatch.** Threads stay workspace-scoped.
- ❌ **Cross-run conversation memory** (beyond the structured selector
  alias / failure-pattern tables in B10). Threads are still run-scoped
  for envelope persistence.
- ❌ **External tool integrations (Slack, Jira, GitHub).** Separate
  roadmap.
- ❌ **LLM-driven prompt mutation.** All v2 prompts remain file-
  controlled and reviewable, same as v1.
- ❌ **Custom user-defined tools.** Tool registry stays a closed set in
  v2 — same security posture as v1.
- ❌ **Replacing Playwright as the execution surface.** v2 is built on
  Playwright, not a CDP-only or pure-DOM agent.

---

# Definition of done (v2 whole roadmap)

Operator can:
1. ❓ Submit a plain-English goal and watch an agent drive a real
   browser to verify it
2. ❓ Configure vision-capable roles per workspace
3. ❓ See live screenshots and execution evidence in the agent
   conversation timeline
4. ❓ Trust hard termination guarantees (max-rounds, max-steps,
   wall-clock, quota, browser-action cap, execution cap)
5. ❓ Roll back to AUTO-023 v1 or `pipeline` mode at any time with
   zero data loss
6. ❓ Track v2 collaboration cost via Prometheus + audit log
7. ❓ See selector aliases speed up repeat runs (≥2x measured)

System guarantees:
- ❓ v1 modes behave identically to pre-AUTO-024 Sentri
- ❓ All loops + browser sessions bounded
- ❓ Workspace isolation enforced on every new persistent surface
- ❓ Browser sandbox reuses runner profile + adds session-specific
  hardening; no new execution surface beyond Playwright
- ❓ Single-agent collapse rule (AI-005c) preserved end-to-end
- ❓ Migration rollback works without data loss
- ❓ No secrets, screenshots, or PII leaked through new persistent
  stores

`❓` reflects honest status — none of these can be ticked until the
corresponding code lands and is verified. **No checkbox in this
document gets ticked speculatively.**
