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

## Pre-existing Sentri capabilities v2 builds on

Before adding new bundles, v2 must integrate cleanly with what is
**already shipped**. The following capabilities are present in `main`
(verified against `ROADMAP.md` Completed Work Summary) — v2 does NOT
re-implement them; v2 teaches the autonomous agents to USE them.

| Capability | Shipped as | What v2 reuses |
|---|---|---|
| Visual regression + baselines | `DIF-001` ✅ (PR #94), `DIF-002b` ✅ browser-aware baselines (PR #107, #110) | Reviewer agent reads existing diff results; no new baseline store |
| Cross-browser execution (Chrome / Firefox / WebKit) | `DIF-002` ✅ (PR #94), `DIF-002b` ✅ polish | Goal-driven runs (B9) opt into the existing matrix |
| Mobile viewport / device emulation | `DIF-003` ✅ (PR #94) | Agent passes existing viewport profiles, no new profile system |
| Geolocation / locale / timezone | `AUTO-007` ✅ (PR #94) | Existing per-run config consumed by the agent |
| Network throttling / offline | `AUTO-006` ✅ (PR #3) | Agent toggles existing throttling, no new tool |
| HAR capture (observe-only) | `pipeline/harCapture.js` | v2 extends with `route()` interception (B13) |
| Accessibility scan (axe-core) | `AUTO-016` ✅ (PR #121), `AUTO-016b` ✅ frontend panel | Reviewer agent reads existing findings, no new scan engine |
| Web Vitals budgets (LCP / CLS / INP / TTFB) | `AUTO-017` ✅ (PR #8), `AUTO-017.3` ✅ trend charts (PR #9) | Reviewer consumes existing budget evaluation, no new perf tool |
| Flaky test detection + auto-retry | `DIF-004` ✅ (PR #99), `AUTO-005` ✅ (PR #2) | Agent reads existing flake signals, no new classifier |
| Data-driven test fixtures (CSV / JSON) | `CAP-001` ✅ (PR #1) | Goal-driven runs (B9) accept existing fixture refs |
| Interactive browser recorder | `DIF-015` ✅ (PR #94) + gap completion (PR #8, #11) | v2 adds agent-proposed-change diff on top of existing recorder |
| GitHub Actions / PR checks | `ENH-011` ✅ (PR #86), `INT-002` / `INT-002b` ✅ (PR #15, #17) | Goal-driven results post via existing webhook layer |
| Distributed runner / sharding | `AUTO-008` ✅ (PR #9), `CAP-002` ✅ (PR #3) | v2 threads share the existing BullMQ + Redis fan-out |
| Auth: credential editing + auto-detect login fields | `ENH-036` / `ENH-036b` ✅ (PR #127) | v2 extends with OAuth / 2FA / magic-link kinds (B12) |
| SLA / quality gates | `AUTO-012` ✅ (PR #2) | v2 reviewer rejects when an existing gate fails |
| Trace viewer (embedded) | `DIF-005` ✅ (PR #9) | Reviewer agent links to existing trace UI on failure |
| Self-healing (DOM + vision) | shipped pre-AUTO-023 + `MNT-001` ✅ (PR #17) | Already integrated; v2's `playwright.run` reuses existing healing waterfall |

**Implication for v2 scope:** the bundles below describe **only the
deltas** required to make these capabilities accessible to an
autonomous agent. v2 is not a re-platforming exercise.

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

---

# Bundle 11 — Multi-tab, multi-window, multi-origin flows

**Goal:** real apps trigger OAuth popups, email-verification new tabs,
payment redirects to third-party origins, and Stripe Checkout-style
modals. v2's B6 ships ONE `BrowserContext` per thread — that's not
enough.

## B11.1 — Page graph per thread
- [ ] Track every `Page` opened in the thread's `BrowserContext` —
      including popups (`window.open`), `target="_blank"` clicks,
      and OAuth redirects
- [ ] New tool: `browser.listPages()` → `[{pageId, url, title, openedAt}]`
- [ ] New tool: `browser.switchPage({pageId})` — subsequent
      `browser.click/type/snapshot` calls operate on the active page
- [ ] Auto-close inactive popup pages after N minutes (configurable)

## B11.2 — Cross-origin handling
- [ ] Allowlist policy per project: which third-party origins the
      agent may interact with (Stripe Checkout, OAuth providers, etc.)
- [ ] Anything outside the allowlist → tool call returns
      `{ok: false, reason: "cross_origin_denied", origin}`
- [ ] Settings UI: project-level "Allowed third-party origins" field
- [ ] Default policy: same-origin only (safest), operator opts in

## B11.3 — Frame / iframe traversal
- [ ] `browser.listFrames({pageId?})` → `[{frameId, url, name?}]`
- [ ] `browser.switchFrame({frameId|name})` — operates on a frame
      within the active page
- [ ] Frame switch resets on `browser.navigate` (Playwright contract)

## B11.4 — Tests
- [ ] `backend/tests/agent-multipage-graph.test.js`
- [ ] `backend/tests/agent-cross-origin-allowlist.test.js`
- [ ] `backend/tests/agent-iframe-traversal.test.js`

## B11.5 — Exit criteria
- [ ] Agent completes an OAuth flow end-to-end (login → consent →
      callback → app)
- [ ] Agent completes a Stripe Checkout test redirect → return
- [ ] Cross-origin policy blocks unlisted origins; allowlisted origins
      work transparently

---

# Bundle 12 — Authentication flows

**Goal:** modern apps use OAuth, SSO, 2FA, magic links, captchas.
v2's `project.credentials` is username/password only — not enough.

## B12.1 — Credential vault (extended)

> **Reuse note:** Sentri already ships `ENH-036` / `ENH-036b` ✅
> (credential editing + auto-detect login fields, PR #127) and
> tracks `DIF-010` 🔲 (multi-auth profiles per project) as still-
> planned. B12.1 is the **superset schema** — coordinate with
> `DIF-010` so we don't ship two competing credential models.

- [ ] Extend existing `project.credentials` schema (from `ENH-036`)
      to support:
      `{kind: "userpass" | "oauth" | "magiclink" | "session", ...}`
- [ ] `oauth` kind: stored access token + refresh logic
- [ ] `session` kind: pre-captured `storageState.json` from a manual
      browser login (operator does the hard part once)
- [ ] All new kinds encrypted at rest via existing CAP-003
      `utils/encryption.js` plumbing
- [ ] Named profiles (admin / viewer / guest) are `DIF-010`'s scope,
      not B12 — B12 adds the credential kinds, `DIF-010` adds the
      multi-profile container

## B12.2 — Auth tool family
- [ ] `auth.useStoredSession({kind})` — agent loads the stored
      session into the active `BrowserContext` before any test step
- [ ] `auth.waitForMagicLink({email, timeoutMs})` — polls a mailbox
      inbox (uses existing webhook/IMAP integration or new email
      sandbox) for the magic link, extracts URL, navigates
- [ ] `auth.solve2faTotp({secret})` — generates TOTP from a stored
      secret and types it into the active page
- [ ] NO captcha-solving tool. Captcha-bypass is a non-goal (legal +
      ethical risk); operator must pre-capture sessions that bypass
      captcha walls

> ASSUMPTION: Sentri has no email-sandbox integration today.
> `auth.waitForMagicLink` needs a new B12 sub-bundle to add one
> (mailtrap-style or local SMTP catch-all).

## B12.3 — Tests
- [ ] `backend/tests/agent-auth-stored-session.test.js`
- [ ] `backend/tests/agent-auth-magic-link.test.js`
- [ ] `backend/tests/agent-auth-totp.test.js`
- [ ] `backend/tests/agent-credentials-encryption.test.js` — all new
      credential kinds encrypted at rest

## B12.4 — Exit criteria
- [ ] Agent logs in via stored Google OAuth session
- [ ] Agent completes a magic-link login flow end-to-end
- [ ] Agent completes a 2FA-protected login with stored TOTP secret
- [ ] No plaintext credentials ever land in `agent_messages.artifact`

---

# Bundle 13 — Network interception + mocking

**Goal:** real platforms stub backends to force error states, replay
HAR fixtures, and assert on network contracts. Sentri's existing HAR
capture is observe-only.

## B13.1 — Network observation tool
- [ ] `network.listRequests({pageId?, since?})` → request log
      (URL, method, status, headers, optionally body)
- [ ] Workspace-scoped log retention (per-thread; not cross-thread)

## B13.2 — Network interception tool
- [ ] `network.intercept({urlPattern, response: {status, headers, body}})`
- [ ] Active until thread terminates OR `network.clearIntercept`
- [ ] Pattern syntax: glob + regex (Playwright `route()` compatible)
- [ ] Per-thread limit: max N active intercepts (default 20, hard
      ceiling 100)

## B13.3 — HAR replay tool
- [ ] `network.replayHar({harRef})` — loads a stored HAR file and
      installs route handlers from it
- [ ] HAR storage uses the same blob-store pattern as B7 screenshots
- [ ] Operator can upload HAR via Settings UI; per-project library

## B13.4 — Tests
- [ ] `backend/tests/agent-network-observe.test.js`
- [ ] `backend/tests/agent-network-intercept.test.js`
- [ ] `backend/tests/agent-har-replay.test.js`

## B13.5 — Exit criteria
- [ ] Agent forces a 500 response on an API call and asserts the app's
      error UI shows correctly
- [ ] HAR replay produces deterministic test runs independent of
      backend availability

---

# Bundle 14 — Agent integration with shipped Sentri capabilities

**Goal:** teach the autonomous agents (supervisor / author / reviewer)
to USE the capabilities Sentri already ships. None of these sub-items
re-implements existing functionality — each one is the small agent-
side delta that makes an existing surface accessible to a v2 agent.

This bundle replaces what earlier drafts of this roadmap called
"visual regression", "accessibility + Web Vitals", "cross-browser
matrix", and most of "flakiness / test data / CI/CD" — those features
are already shipped (see the "Pre-existing Sentri capabilities" table
at the top). What's missing is the agent integration.

## B14.1 — Reviewer consumes visual diff results
- [ ] `playwright.run` (B8.1) result extended with `visualDiffs: [...]`
      populated from Sentri's existing `DIF-001` / `DIF-002b` diff
      engine — agent does NOT call the diff engine directly; the
      runner attaches the results
- [ ] Reviewer prompt updated to read `visualDiffs[]` and emit
      `request_revision` when a diff exceeds tolerance, even if the
      test functionally passed
- [ ] `agent_messages.artifact` carries the diff REF-ID, not the
      diff payload (size budget)

## B14.2 — Reviewer consumes a11y findings
- [ ] `playwright.run` result extended with `a11yFindings: [...]`
      populated from `AUTO-016` axe-core scan — runner-attached
- [ ] Reviewer prompt reads findings; per-project WCAG conformance
      level (already shipped via `AUTO-016`) determines the
      `request_revision` threshold
- [ ] No new scan engine; no new persistence

## B14.3 — Reviewer consumes Web Vitals budget evaluation
- [ ] `playwright.run` result extended with `webVitalsResult` from
      `AUTO-017`'s existing evaluator — runner-attached
- [ ] Reviewer reads `webVitalsResult.violations` and emits
      `request_revision` when budgets fail
- [ ] No new perf tool; no new budget config

## B14.4 — Goal-driven runs reuse shipped browser matrix
- [ ] Goal-driven entry (B9.1) accepts existing `browsers: ["chromium",
      "firefox", "webkit"]` (DIF-002 surface) and existing viewport
      profiles (DIF-003 surface) — no new matrix system
- [ ] One supervisor thread per (browser × viewport) cell; results
      aggregated under the parent runId via the existing sharding
      infrastructure (`CAP-002`)
- [ ] Cross-browser divergence detection: reviewer flags a test that
      passes on Chrome but fails on Firefox/WebKit as a real
      cross-browser bug, distinguishing it from generic flake (which
      `DIF-004` already classifies)

## B14.5 — Mobile-gesture tool extensions
- [ ] `browser.tap({selector|aiHint})` — touch-event variant of
      `browser.click` (B6.2). Genuinely new — Sentri's existing
      mobile support is viewport/UA emulation only
- [ ] `browser.swipe({fromHint, toHint})` — gesture support
- [ ] These extend the B6 tool family; not a separate bundle

## B14.6 — Goal-driven runs consume existing fixtures
- [ ] Goal-driven entry (B9.1) accepts an existing `CAP-001` fixture
      ID — agent loads the fixture via the same iteration mechanism
      `executeTestIterations` already uses
- [ ] No new `data.*` tools; no new fixture store
- [ ] Per-thread fixture isolation is inherited from the existing
      iteration cap

## B14.7 — Reviewer consumes flake signals
- [ ] Reviewer prompt reads existing per-test flake score (DIF-004)
      and `AUTO-005` retry status when deciding whether a failure
      is real or transient
- [ ] No new flake classifier; no new auto-retry policy
- [ ] Existing quarantine signals consumed verbatim

## B14.8 — Goal-driven results post via existing CI/CD layer
- [ ] Goal-driven run completions flow through the existing
      `ENH-011` webhook system and `INT-002` / `INT-002b` GitHub
      PR check infrastructure unchanged
- [ ] PR comment format extended to include the goal text + agent
      reasoning summary — purely a template change, not a new
      integration

## B14.9 — Tests
- [ ] `backend/tests/agent-reviewer-visual-diff.test.js` — reviewer
      rejects when an existing diff exceeds tolerance
- [ ] `backend/tests/agent-reviewer-a11y.test.js` — reviewer rejects
      on existing axe-core critical findings
- [ ] `backend/tests/agent-reviewer-webvitals.test.js` — reviewer
      rejects on existing Web Vitals budget violations
- [ ] `backend/tests/agent-goal-browser-matrix.test.js` — goal-driven
      run dispatches one thread per browser cell
- [ ] `backend/tests/agent-goal-fixture-load.test.js` — goal-driven
      run consumes a CAP-001 fixture
- [ ] `backend/tests/agent-mobile-gestures.test.js` — `browser.tap`
      and `browser.swipe` smoke

## B14.10 — Exit criteria
- [ ] A test that passes Playwright but fails visual diff → reviewer
      `request_revision` with diff evidence
- [ ] A test that passes Playwright but fails WCAG-AA → reviewer
      `request_revision` with a11y evidence
- [ ] A test that passes Chrome but fails Firefox → reviewer flags
      cross-browser bug (not flake)
- [ ] Goal-driven run with `fixtureId: "user_premium"` loads the
      existing fixture and runs N iterations per the project's
      existing iteration cap
- [ ] Zero new persistence: no `visual_baselines`, no
      `run_a11y_findings`, no `run_perf_findings`, no
      `test_flake_signals` tables added by v2

---

# Bundle 15 — Non-engineer UX for agent-proposed changes

**Goal:** the one remaining gap that the existing recorder
(`DIF-015` ✅) doesn't cover — letting a non-engineer **review and
accept agent-proposed test changes** without reading code.

## B15.1 — Diff view for agent revisions
- [ ] Existing `ENH-029` ✅ "Diff view for AI-regenerated test code"
      surface extended to handle multi-round reviewer↔author loop
      outputs — each round's author artifact shown as a diff against
      the previous round
- [ ] Operator can accept the final round, reject all, or step back
      to a prior round

## B15.2 — Step-level accept/reject
- [ ] Test editor lets the operator accept agent-proposed changes
      **per step** rather than all-or-nothing
- [ ] Backed by existing test step storage; no new schema

## B15.3 — Role-based simplified view
- [ ] Existing `ACL-002` ✅ RBAC extended with a "Viewer+Editor" UI
      preference toggle: hide raw Playwright code, show a step
      ladder with dropdowns for assertion type / action type
- [ ] Pure frontend; backend already supports the operations

## B15.4 — Tests
- [ ] `frontend/tests/AgentRevisionDiffView.test.js`
- [ ] `frontend/tests/StepLevelAcceptReject.test.js`
- [ ] `frontend/tests/SimplifiedEditorView.test.js`

## B15.5 — Exit criteria
- [ ] Non-engineer operator can review a 3-round reviewer↔author
      revision sequence and accept any intermediate version
- [ ] Non-engineer can edit a test's assertion via dropdown without
      touching Playwright code
- [ ] No backend changes — pure frontend bundle
