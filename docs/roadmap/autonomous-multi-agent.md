# Autonomous multi-agent collaboration (AUTO-023)

Sentri today runs a **fixed sequential pipeline** with per-stage LLM calls
(`explorer → planner → author → oracle → reviewer`). Each stage has its own
prompt + routed model, but agents do not address each other, cannot
disagree, cannot iterate, and share no memory beyond the previous stage's
return value. The "conversation" surfaced in the UI is templated narration
(`frontend/src/components/ai/agentConversationSynth.js`), not real
agent-to-agent messaging.

This roadmap evolves Sentri from that **multi-model pipeline** into a real
**multi-agent system**: agents exchange structured envelopes on a shared
thread, reviewers can reject and force revisions, and a supervisor decides
who speaks next. Every phase is independently shippable and
backwards-compatible — multi-agent mode is **off by default** and a
workspace with the flag off behaves identically to today.

Closes the `❌ DAG agent handshake` non-goal carved out of
`docs/roadmap/ai-provider-bundle.md:506`.

---

# Bundle 1 — Foundations (envelope + persistence) ✅ COMPLETED

**Status:** shipped. Substrate is live — `agent_messages` table, envelope
schema + validator, repo + emitter, SSE wiring, and retention janitor are
all in place. See `docs/changelog.md` "AUTO-023 Bundle 1" entry for the
full enumeration.

**Goal:** introduce the wire format and persistence agents will talk
through. No behavioural change yet — the pipeline still drives execution,
but every handoff is also captured as a structured message.

## B1.1 — `agent_messages` schema
- [x] Migration `backend/src/database/migrations/0XX_agent_messages.sql`:
  ```sql
  CREATE TABLE agent_messages (
    id TEXT PRIMARY KEY,
    runId TEXT NOT NULL,
    threadId TEXT NOT NULL,         -- groups a multi-turn debate
    traceId TEXT NOT NULL,          -- correlates with agent_events
    fromRole TEXT NOT NULL,         -- explorer | planner | author | reviewer | oracle | healer | triager | supervisor
    toRole TEXT,                    -- null = broadcast to thread
    replyToId TEXT REFERENCES agent_messages(id),
    intent TEXT NOT NULL,           -- handoff | request_revision | accept | reject | question | answer | final
    artifact JSON,                  -- structured payload (journeys, tests, findings…)
    rationale TEXT,                 -- short human-readable reason
    round INTEGER NOT NULL DEFAULT 0,
    workspaceId TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX idx_agent_messages_thread ON agent_messages(threadId, createdAt);
  CREATE INDEX idx_agent_messages_run    ON agent_messages(runId, createdAt);
  ```
- [x] Workspace-scoped on every read (mirrors `provider_routes` contract)
- [x] Retention janitor parity with `agent_events` (90 days default)

## B1.2 — Envelope schema + validator
- [x] New: `backend/src/aiProvider/agentEnvelope.js`
- [x] Zod schema with closed-set enums for `intent` + `fromRole` / `toRole`
- [x] `validateEnvelope(msg)` — throws `ERR_AGENT_ENVELOPE_INVALID` on
      bad shape; called by every write path
- [x] Frozen `INTENTS` + `ROLES` exports — single source of truth for
      backend + frontend

## B1.3 — Repo + emitter
- [x] New: `backend/src/database/repositories/agentMessageRepo.js`
      with `append`, `listByThread`, `listByRun`, `getById`
- [x] Extend `backend/src/aiProvider/agentEventEmitter.js`:
  - [x] `emitAgentMessage(envelope)` helper — validates, persists,
        broadcasts an `agent_message` SSE event
  - [x] Same best-effort persist contract as `emitAgentEvent` (DB
        failure must NEVER break the LLM call)
- [x] SSE wiring in `backend/src/routes/sse.js`:
  - [x] Snapshot includes `run.agentMessages` for re-attach
  - [x] Live `agent_message` event pushed alongside `agent_event`

## B1.4 — Tests (per REVIEW.md mandatory test requirements)
- [x] `backend/tests/agent-envelope.test.js` — schema validation,
      enum closure, rejection cases
- [x] `backend/tests/agent-message-repo.test.js` — append + workspace
      scoping + thread ordering + retention
- [x] `backend/tests/agent-message-emitter.test.js` — best-effort
      persist contract, SSE broadcast shape parity with `agent_event`
- [x] All three files registered in `backend/tests/run-tests.js`

## B1.5 — Exit criteria (Bundle 1)
- [x] Can write/read/broadcast an envelope end-to-end
- [x] No production call site reads `agent_messages` yet (Bundle 2 lights
      up the reads behind `SENTRI_AGENT_MODE=envelope`)
- [x] Zero behaviour change on a full Test Lab run

---

# Bundle 2 — Envelope-mediated handoffs (still linear) ✅ COMPLETED

**Status:** shipped in PR #34. `SENTRI_AGENT_MODE` flag is live, every
roadmap-listed LLM call site reads + emits envelopes at stage boundaries,
the dual-write shim in `pipeline` mode builds the audit trail without
changing behaviour, the UI renders `agent_message` rows as conversation
turns, and the test suite includes both the envelope-thread smoke test
and unit coverage of the new helper modules. See `docs/changelog.md`
"AUTO-023 Bundle 2" entry for the full enumeration.

**Goal:** every pipeline stage's input + output flows through the envelope.
DAG is still linear, but the substrate is now message-passing — laying
groundwork for loops + branches in Bundle 3.

## B2.1 — Feature flag
- [x] `SENTRI_AGENT_MODE = "pipeline" | "envelope" | "autonomous"`
- [x] Default `pipeline` (today's behaviour)
- [x] `envelope` mode = persist + read envelopes, linear DAG unchanged
- [x] `autonomous` mode reserved for Bundle 3+
- [x] Documented in `docs/guide/env-vars.md`

## B2.2 — Wrap each pipeline call site
- [x] At every `agentRole: "..."` call site
      (per `frontend/src/config.js:13-71`):
  - [x] Before stage runs: read latest envelope addressed to this role
        from `agentMessageRepo.listByThread(threadId, toRole)`
  - [x] After stage runs: emit a `handoff` envelope to the next role
        carrying the structured `artifact`
- [x] Call sites affected:
  - [x] `backend/src/pipeline/intentClassifier.js` (explorer → planner)
  - [x] `backend/src/pipeline/journeyGenerator.js` — covers all four
        public generators (`generateJourneyTest` planner → author;
        `generateFromDescription` / `generateIntentTests` /
        `generateApiTests` author → reviewer)
  - [x] `backend/src/pipeline/feedbackLoop.js` (`regenerateFailingTest`
        author → reviewer) — the post-run quality-fix LLM call.
        `testGenerator.js` / `testRefiner.js` / `testValidator.js` /
        `testCritic.js` from the original roadmap list resolve to
        heuristic-only code paths today (no `generateText` call site to
        wrap); the real author/dedup/oracle/reviewer LLM calls live in
        `journeyGenerator.js` + `feedbackLoop.js` which are wrapped above.
  - [x] `backend/src/selfHealing.js` (`tryVisionHeal` healer → reviewer,
        keyed by `healingThreadId(runId, testId)` for runtime separation)
  - [x] `backend/src/routes/chat.js` (author — conversational editor;
        emits a `supervisor → author → supervisor` bidirectional pair
        per request, keyed by a synthesised `CHAT-${uuid}` runId because
        `agent_messages.runId` has no FK to `runs.id`)

## B2.3 — Thread + trace propagation
- [x] `threadId = ${runId}-main` for pipeline runs (via `mainThreadId(runId)`)
- [x] `threadId = ${runId}-heal-${testId}` for self-healing (via
      `healingThreadId(runId, testId)`)
- [x] `traceId` propagates into the envelope via
      `getCurrentTraceId()` — reuses the existing AI-005 distributed
      trace plumbing that already populates OTel span attributes +
      Prometheus labels at the `dispatcher.js` layer, so no per-call
      label additions were needed at the envelope emit site.

## B2.4 — Shim mode (dual-write)
- [x] When `SENTRI_AGENT_MODE=pipeline`, envelope WRITES still fire as a
      read-only audit trail (validates schema on real runs before flip);
      reads short-circuit via `isEnvelopeReadEnabled()`.
- [x] Read path stays on the legacy stage-return-value flow when mode is
      `pipeline` — `readLatestEnvelope` returns `null` without touching
      the DB.

## B2.5 — UI passthrough
- [x] `frontend/src/components/ai/AgentConversation.jsx`:
  - [x] Renders `agent_message` rows via the new `messagesToTurns(messages)`
        adapter when `run.agentMessages` is non-empty; priority order is
        `agentEvents > agentMessages > synthesizer` so legacy runs that
        pre-date the envelope wiring still render via the template synth.
  - [x] Existing template synth in `agentConversationSynth.js` stays as
        fallback for runs that pre-date the change
- [x] Per-message metadata: `fromRole` + `toRole` + `intent` badge
      surfaced in the turn text via `messagesToTurns`.

## B2.6 — Tests
- [x] `backend/tests/agent-pipeline-envelope.test.js` — drives
      `emitHandoffEnvelope` for a canonical explorer → planner → author
      thread; pins ordered persistence, workspace scoping on
      `listByThread`, the envelope-vs-pipeline read-mode gate, and the
      emitter no-op contract on missing `runId` / `threadId`.
- [x] `backend/tests/agent-handoff-mode.test.js` — unit coverage for
      `agentHandoff.js` thread-id formatters + `agentMode.js` env-driven
      mode switch (case-insensitive parsing, invalid-fallback,
      `isEnvelopeReadEnabled` gating).
- [x] Both files registered in `backend/tests/run-tests.js`.

## B2.7 — Exit criteria (Bundle 2)
- [x] `envelope` mode passes the full backend test suite (CI green on
      PR #34 head; the only pre-existing flake — the timeout test in
      `agent-reviewer-loop.test.js` — was fixed in the same PR by raising
      the reviewer sleep so the deadline check fires before max rounds).
- [x] Identical test artifacts produced in `pipeline` vs `envelope` mode
      — envelope writes are best-effort and never block or mutate the
      stage's return value; the legacy flow drives execution byte-
      identically and the read path is gated off in `pipeline` mode.
- [x] No regression in `route_name` + `agent_role` Prometheus cardinality
      — envelope emit reuses `getCurrentTraceId()` + existing label set,
      no new labels added at the dispatcher layer.

---

# Bundle 3 — Reviewer ↔ Author feedback loop (first real conversation) ✅ COMPLETED

**Status:** shipped in PR #35. Loop substrate + production wiring +
per-workspace `maxReviewRounds` override (migration 059) + real
`quotaGuard.checkSpendCap` integration + AI-005c single-agent-collapse
warning + `app_agent_review_rounds` termination metric + UI round
badge & per-round artifact diff + golden-fixture regression test +
**production wire-up in `feedbackLoop.regenerateFailingTest`** with
a heuristic-only reviewer (`testValidator.validateTest`) so every
post-run regeneration goes through up to 2 author rounds before
shipping. The heuristic reviewer adds zero LLM cost on the happy path
(accept on round 0 is byte-identical to the pre-loop single-call
flow); the second round only fires when the regenerated test still
trips heuristic checks (brittle selectors, unbalanced brackets,
placeholder URLs, secret-scan hits).

See `docs/changelog.md` "AUTO-023 Bundle 3" entry for the full
enumeration.

**Goal:** the smallest possible real multi-agent interaction — `reviewer`
can reject and force `author` to revise. This is where Sentri stops being
an assembly line.

## B3.1 — New intents
- [x] `request_revision` — reviewer → author with
      `{issues: [{testId, problem, suggestion}]}`
- [x] `accept` — reviewer → supervisor "ship it"
- [x] `reject_final` — reviewer → supervisor "unrecoverable"

## B3.2 — Reviewer prompt change
- [x] `backend/src/prompts/reviewerPrompt.js`:
  - [x] Require structured output `{verdict, issues[]}`
  - [x] `verdict ∈ {accept, revise, reject}`
  - [x] `issues[].testId` MUST reference a test from the author's most
        recent `handoff` artifact (else envelope validation fails)

## B3.3 — Loop runner
- [x] New: `backend/src/aiProvider/agentLoop.js`
  - [x] `runReviewerAuthorLoop(initialArtifact, opts)`:
    ```
    round = 0
    while round < MAX_REVIEW_ROUNDS:
      if checkQuota({round, workspaceId}).ok == false:
        return { outcome: "quota_exhausted", artifact: lastAuthorArtifact }
      if Date.now() > deadline:
        return { outcome: "timeout", artifact: lastAuthorArtifact }
      authorMsg   = runAuthor(currentArtifact, prevReviewerFeedback)
      reviewerMsg = runReviewer(authorMsg.artifact)
      if reviewerMsg.intent == accept:       return { outcome: "accept", artifact: authorMsg.artifact }
      if reviewerMsg.intent == reject_final: throw ReviewRejection
      if Date.now() > deadline:
        return { outcome: "timeout", artifact: lastAuthorArtifact }
      prevReviewerFeedback = reviewerMsg.artifact.issues   // validated against author tests
      round += 1
    return { outcome: "max_rounds", artifact: lastAuthorArtifact }
    ```
- [x] `MAX_REVIEW_ROUNDS` defaults to **3** — exposed via
      `agent_configs.maxReviewRounds` per workspace (migration 059)
- [x] Termination metric:
      `app_agent_review_rounds_total{outcome=accept|max_rounds|timeout|quota_exhausted|reject_final}`
      with a 4-bucket histogram on `round` index ([0, 1, 2, 3])

## B3.4 — Per-`(route, role)` quota awareness
- [x] Loop runner integrates with existing `quotaGuard.checkSpendCap`
      — a revision round that would breach the workspace's daily/monthly
      USD spend cap terminates early with `outcome=quota_exhausted` and
      ships the last accepted artifact (`defaultQuotaCheck` in
      `agentLoop.js`)
- [x] AI-005c single-agent collapse rule preserved: when author + reviewer
      share the same `routeId`, loop still runs (both calls happen) and
      a warning surfaces on the run detail page —
      `maybeWarnSingleAgentCollapse` in `agentLoop.js` resolves both
      roles via `resolveRoute`, compares `route.id`, and emits a one-
      shot `agent_event` with `phase: "finding"` + `data.kind =
      "single_agent_collapse"`; `eventsToTurns` renders it as a
      standalone `_warning: true` turn and `AgentConversation.jsx`
      paints it with `.ac-turn--warning` (amber) + `role="alert"`

## B3.5 — UI: round indicator + diff view
- [x] `frontend/src/components/ai/AgentConversation.jsx`:
  - [x] `request_revision` messages render with a "Round N" badge
        (`.ac-round-badge` pill; `_round` surfaced by `messagesToTurns`
        on every loop-vocabulary envelope)
  - [x] Per-round artifact diff: which tests changed between rounds
        (`messagesToTurns` computes `+N added, ~N updated, -N removed`
        from consecutive author-handoff artifacts)
- [x] `Reviewer rejected N issues → Author fixing` becomes a real
      narration line, not a synthesized template string

## B3.6 — Safety: termination guarantees
- [x] `MAX_REVIEW_ROUNDS` ceiling enforced server-side regardless of
      workspace config (hard cap = 10) — `HARD_MAX_REVIEW_ROUNDS` +
      `clampReviewRounds` in `agentLoop.js`; also clamped at the repo
      layer in `agentConfigRepo.upsert`
- [x] Wall-clock budget per loop: `loopTimeoutMs` (default 5 min, hard
      cap 30 min) — checked at top-of-loop AND post-reviewer to catch
      single-long-reviewer-call timeouts
- [x] Cycle protection: reject envelope if `replyToId` chain exceeds
      `MAX_REVIEW_ROUNDS * 2` — `maxReplyChainDepth` + `replyDepth`
      counter in `agentLoop.js` throws `ERR_REVIEW_CYCLE_PROTECTION`

## B3.7 — Tests
- [x] `backend/tests/agent-reviewer-loop.test.js`:
  - [x] Reviewer accepts on round 1 → loop returns immediately
  - [x] Reviewer revises once, accepts on round 2 → 2 author calls,
        2 reviewer calls, artifact carries round-2 changes
  - [x] Reviewer keeps revising → loop terminates at MAX_REVIEW_ROUNDS
        with `outcome=max_rounds`
  - [x] Reviewer `reject_final` → throws `ReviewRejection`, no further
        author calls
  - [x] Quota exhaustion mid-loop → ships last accepted artifact
        (`outcome=quota_exhausted`)
  - [x] Wall-clock timeout mid-loop → ships last accepted artifact
        (`outcome=timeout`)
  - [x] Unrecognized reviewer `intent` values (`handoff`, `question`,
        `answer`, `final`, `tool_call`, `tool_result`) normalise to
        `accept` instead of silently looping with unsanitised feedback
- [x] `backend/tests/agent-config-max-review-rounds.test.js` —
      repo-layer `[1, 10]` clamp on `agent_configs.maxReviewRounds`
      and the loop's resolution order (caller > workspace override >
      `DEFAULT_MAX_REVIEW_ROUNDS`).
- [x] `backend/tests/reviewer-prompt.test.js` —
      `normalizeReviewerVerdict` filters issues to known testIds and
      downgrades `revise` with zero valid issues to `accept`.
- [x] `frontend/tests/AgentConversation.test.js` —
      `messagesToTurns` Round N badge + per-round artifact diff
      narration; `eventsToTurns` standalone-warning turn for the
      single-agent-collapse advisory; `supervisor` + `healer` envelopes
      survive the persona-table filter.
- [x] All registered in `backend/tests/run-tests.js` /
      `frontend/tests/run-tests.js`

## B3.8 — Exit criteria (Bundle 3)
- [x] Reviewer↔author loop demonstrably improves a known-bad test
      fixture (regression: a test with a brittle selector ships
      strengthened after 1 revision round — pinned by the
      "golden fixture" test in `agent-reviewer-loop.test.js`)
- [x] No infinite loops possible — max-rounds + wall-clock + cycle
      protection all enforced
- [x] Operator can see round count + per-round diff in the UI

---

# Bundle 4 — Supervisor orchestration (`autonomous` mode)

**Goal:** stop encoding the DAG in if/else flow control. A `supervisor`
agent reads the thread and decides who speaks next. This is the
LangGraph / AutoGen / CrewAI pattern, scoped to Sentri's domain.

## B4.1 — Supervisor role
- [ ] Add `supervisor` to canonical `AGENT_ROLES`
      (`frontend/src/config.js:13`) and per-role config
- [ ] New prompt: `backend/src/prompts/supervisorPrompt.js`
  - [ ] Input: thread transcript + last artifact + workspace policy
  - [ ] Output: `{nextRole, instruction, rationale}` OR
        `{terminate: true, finalArtifact}`
- [ ] Recommended model: strong reasoning (catalog floor = Claude Sonnet
      / GPT-4o) — surface a one-time warning if operator routes
      supervisor to a cheap model

## B4.2 — Orchestrator
- [ ] New: `backend/src/aiProvider/agentOrchestrator.js`
  - [ ] `runAutonomousThread(initialMessage, opts)`:
    ```
    while not terminated and steps < MAX_AUTONOMOUS_STEPS:
      decision = runSupervisor(thread)
      if decision.terminate: return decision.finalArtifact
      nextMsg = runAgent(decision.nextRole, decision.instruction, thread)
      append(nextMsg)
      steps += 1
    return last accepted artifact (with `outcome=max_steps`)
    ```
- [ ] `MAX_AUTONOMOUS_STEPS` hard cap = 20 (server-enforced)
- [ ] Wall-clock budget: `autonomousTimeoutMs` (default 10 min)
- [ ] Same `quotaGuard` + circuit breaker integration as B3.4

## B4.3 — Capability gates
- [ ] Supervisor's choice of `nextRole` validated against the role's
      probed capabilities — e.g. cannot pick `oracle` if its route has
      `model: false` in `provider_routes.capabilities`
- [ ] Fall back to the linear DAG (envelope mode) if no eligible role
      for the supervisor's decision — log + emit
      `agent_orchestrator_fallback_total{reason}`

## B4.4 — Mode rollout
- [ ] `SENTRI_AGENT_MODE=autonomous` gates this orchestrator
- [ ] Per-workspace opt-in via `workspaces.agentMode` column (new
      migration) — default `envelope`, admin can flip to `autonomous`
- [ ] Settings UI: Agent Roles subtab gains a "Mode" selector with
      tooltip explaining cost + latency trade-off

## B4.5 — Observability
- [ ] New metrics:
  - [ ] `agent_thread_steps_total{outcome}` histogram (bucketed 1..20)
  - [ ] `agent_supervisor_decisions_total{nextRole}` counter
  - [ ] `agent_thread_duration_seconds` histogram
- [ ] OTel span per thread with child spans per agent call (`fromRole`,
      `toRole`, `intent`, `round`, `traceId` as attributes)
- [ ] Audit log entry on every `supervisor.terminate` decision

## B4.6 — Tests
- [ ] `backend/tests/agent-orchestrator.test.js`:
  - [ ] Happy path: supervisor drives explorer → planner → author →
        reviewer → terminate in ≤8 steps
  - [ ] Supervisor loops author when reviewer requests revision
  - [ ] `MAX_AUTONOMOUS_STEPS` enforced
  - [ ] Capability gate rejects ineligible `nextRole`
  - [ ] Quota exhaustion mid-thread ships last accepted artifact
- [ ] `backend/tests/agent-orchestrator-fallback.test.js`:
  - [ ] When supervisor picks unprobed role → fallback to linear DAG
- [ ] Registered in `backend/tests/run-tests.js`

## B4.7 — Exit criteria (Bundle 4)
- [ ] Canonical Test Lab fixture runs end-to-end in `autonomous` mode
      with supervisor making real routing decisions
- [ ] No regression in test quality vs `envelope` mode on golden fixture
- [ ] Operator can flip mode per workspace from Settings UI
- [ ] All termination guarantees (max-steps, wall-clock, quota, cycle)
      enforced + observable in metrics

---

# Bundle 5 — Shared memory + tool calling

**Goal:** give agents read/write access to a thread-scoped blackboard
and a closed set of tools (DB lookup, run code, ask peer). This is what
turns "agents talking" into "agents collaborating to solve problems".

## B5.1 — Thread blackboard
- [ ] New table `agent_thread_state`:
  ```sql
  CREATE TABLE agent_thread_state (
    threadId TEXT PRIMARY KEY,
    workspaceId TEXT NOT NULL,
    state JSON NOT NULL,            -- arbitrary key-value bag
    version INTEGER NOT NULL,       -- optimistic concurrency
    updatedAt TEXT NOT NULL
  );
  ```
- [ ] `agentThreadStateRepo.get/setKey/casUpdate` with optimistic
      concurrency (version mismatch → 409, retry once)
- [ ] Size cap (default 64 KB) — reject writes that breach the budget

## B5.2 — Tool registry
- [ ] New: `backend/src/aiProvider/agentTools/index.js`
- [ ] Closed set of read-only tools shipped in B5:
  - [ ] `db.listExistingTests(projectId)` — for author dedup
  - [ ] `db.getTest(testId)` — for reviewer inspection
  - [ ] `crawl.getPageHtml(url, runId)` — for explorer drill-down
  - [ ] `playwright.dryRun(testCode)` — for author/reviewer sanity check
        (runs in existing sandbox)
  - [ ] `thread.askPeer(role, question)` — emits a `question` envelope,
        blocks on the matching `answer` envelope
- [ ] Each tool declares a JSON schema; supervisor + agents see only
      tools allowed by their role (per `agent_configs.allowedTools`)

## B5.3 — Tool invocation via envelopes
- [ ] New intent: `tool_call` with `{tool, args}` artifact
- [ ] New intent: `tool_result` with `{toolCallId, result}` artifact
- [ ] Tool execution is server-side — the LLM emits a `tool_call`
      envelope, the orchestrator runs the tool, the result lands as a
      `tool_result` envelope the agent can read on next turn
- [ ] Per-tool quota: `agent_tool_calls_total{tool,outcome}` counter
- [ ] Per-call timeout (default 30s)

## B5.4 — Peer Q&A
- [ ] `thread.askPeer` blocks the asking agent until the peer answers
      OR `peerQuestionTimeoutMs` (default 60s) elapses
- [ ] Cycle protection: an agent cannot ask itself; max 3 nested
      questions per thread

## B5.5 — Sandbox + safety
- [ ] `playwright.dryRun` reuses existing test runner sandbox — no new
      execution surface
- [ ] `db.*` tools enforce workspace scoping at the repo layer (same
      contract as every other repo in the codebase)
- [ ] No tool can mutate state outside `agent_thread_state` in B5 —
      write tools deferred to a future bundle

## B5.6 — Tests
- [ ] `backend/tests/agent-blackboard.test.js` — get/set/CAS + size cap
- [ ] `backend/tests/agent-tools-registry.test.js` — schema validation,
      `allowedTools` enforcement, timeout, quota counter increments
- [ ] `backend/tests/agent-tool-call-envelope.test.js` — `tool_call` →
      orchestrator runs tool → `tool_result` envelope appears in thread
- [ ] `backend/tests/agent-peer-qa.test.js` — askPeer round-trip,
      timeout, cycle protection
- [ ] All registered in `backend/tests/run-tests.js`

## B5.7 — Exit criteria (Bundle 5)
- [ ] Author can call `db.listExistingTests` mid-generation to
      genuinely deduplicate (replaces the LLM-blind dedup pass)
- [ ] Reviewer can call `playwright.dryRun` and reject tests that
      don't compile — eliminates a whole class of broken-output bugs
- [ ] Operator can see per-thread tool-call timeline in the UI

---

# Cross-bundle invariants
These must hold across every bundle — verify before merging each PR.
- [ ] `SENTRI_AGENT_MODE=pipeline` (default) behaves identically to
      today — zero regression for workspaces that haven't opted in
- [ ] Envelope writes are best-effort: DB failure must NEVER break the
      originating LLM call (mirrors `agentEventEmitter` contract)
- [ ] All termination paths bounded: max-rounds, max-steps, wall-clock,
      and cycle protection enforced server-side
- [ ] AI-005c single-agent collapse rule preserved across all loops
- [ ] Per-`(route, role)` circuit breaker + `quotaGuard` integration
      maintained through loop runner and orchestrator
- [ ] Workspace scoping enforced on every read of `agent_messages`,
      `agent_thread_state`, and tool registry calls
- [ ] `agent_role` Prometheus label remains bounded (canonical 7 roles
      + `supervisor` + `default`)
- [ ] All new endpoints registered in `permissions.json` with correct
      `requireRole()` gate
- [ ] All new tests registered in `backend/tests/run-tests.js`
- [ ] `docs/changelog.md` updated under `## [Unreleased]` for each bundle

---

# Risk register
| Risk | Mitigation | Bundle |
|---|---|---|
| Envelope schema drift between backend + frontend | Shared `agentEnvelope.js` exports; snapshot test on canonical run | B1.2 / B2.6 |
| Reviewer loop ships worse tests than single pass | Golden fixture regression test in B3.7; ship metric `accept_round_1_ratio` | B3.8 |
| Infinite loops / runaway cost in `autonomous` mode | Hard cap `MAX_AUTONOMOUS_STEPS=20` + `autonomousTimeoutMs` + quota integration | B4.2 |
| Supervisor picks ineligible role mid-thread | B4.3 capability gate + fallback to linear DAG | B4.3 |
| Per-workspace flag confusion (`pipeline` vs `envelope` vs `autonomous`) | Single env-var + per-workspace column + Settings UI selector; documented decision matrix | B4.4 |
| Tool calls leak data across workspaces | Repo-level workspace scoping; integration test asserts cross-workspace reads return empty | B5.5 |
| Tool sandbox escape via `playwright.dryRun` | Reuses existing runner sandbox (no new execution surface); no new tools mutate state in B5 | B5.5 |
| Quota burn from chatty supervisor | Per-thread step counter + alert at 80% of `MAX_AUTONOMOUS_STEPS` | B4.5 |
| `agent_messages` table growth unbounded | B1.1 retention janitor (90-day default, mirrors `agent_events`) | B1.1 |
| Peer Q&A deadlock | `peerQuestionTimeoutMs` + cycle protection + max-nesting | B5.4 |
| UI confusion ("which round is this?") | B3.5 round badges + per-round diff; B4 thread-step indicator | B3.5 / B4 |

---

# Bundle ordering rationale
| Bundle | Why it ships when it does |
|---|---|
| **1** | Pure additive. Schema + envelope + emitter land together because they share the SSE wiring and audit-trail contract. Feature flag means zero blast radius. |
| **2** | Same schema, new readers. Linear DAG preserved so we can A/B against `pipeline` mode on identical fixtures and prove zero-regression before adding loops. |
| **3** | First real conversation. Scoped to a single agent pair (reviewer↔author) so termination guarantees and quota integration can be exercised in isolation before generalising. |
| **4** | Generalises the loop pattern to an orchestrator. Requires Bundle 3's termination + observability primitives — can't safely ship without them. |
| **5** | Capability bundle. Pure additive on top of the autonomous substrate. Skippable: workspaces can use the orchestrator without tools. |

---

# Estimated effort (rough)
| Bundle | Tasks | Est. agent-days | Critical path |
|---|---|---|---|
| 1 | 5 task groups, ~10 files | 3–4 | Envelope schema + emitter + SSE wiring |
| 2 | 7 task groups, ~15 files | 4–6 | Wrapping 8 pipeline call sites without regression |
| 3 | 8 task groups, ~10 files | 4–5 | Loop runner + termination guarantees + golden-fixture regression |
| 4 | 7 task groups, ~12 files | 6–8 | Supervisor prompt + orchestrator + capability gates |
| 5 | 7 task groups, ~15 files | 5–7 (skip if not requested) | Tool registry + sandbox integration + peer Q&A |
| **Total** | **34 task groups, ~62 files** | **22–30 agent-days** | — |

> Effort assumes single agent working linearly. Bundles 1 → 2 → 3 → 4
> serialise on schema + termination primitives. Bundle 5 parallelisable
> after Bundle 4 lands.

---

# Definition of done (whole roadmap)
Operator can:
1. ✅ Watch agents genuinely converse in the UI (not templated narration)
2. ✅ See reviewer reject author's output and force a revision round
3. ✅ Configure max review rounds + agent mode per workspace
4. ✅ Enable `autonomous` mode where a supervisor picks the next agent
5. ✅ See per-thread tool-call timeline + per-round artifact diffs
6. ✅ Trust hard termination guarantees (max-rounds, max-steps,
      wall-clock, quota, cycle protection)
7. ✅ Roll back to `pipeline` mode at any time with zero data loss
8. ✅ Track agent collaboration cost via Prometheus + audit log

System guarantees:
- ✅ `pipeline` mode behaves identically to pre-AUTO-023 Sentri
- ✅ Envelope schema is closed-set, validated, and versioned
- ✅ All loops bounded; no infinite-call paths possible
- ✅ Workspace isolation enforced on every read + write
- ✅ Tool sandbox reuses existing runner — no new execution surface
- ✅ Single-agent collapse rule (AI-005c) preserved end-to-end
- ✅ Migration rollback works without data loss
- ✅ No secrets, full prompts, or PII leaked through envelopes/metrics

---

# Out of scope (explicit non-goals)
- ❌ **Multi-agent dispatch across workspaces** — single-workspace threads only
- ❌ **Write-tools beyond `agent_thread_state`** — defer until B5 sandbox is battle-tested
- ❌ **Embeddings / vector memory for agents** — start with structured blackboard
- ❌ **Cross-run agent memory** — threads are run-scoped only
- ❌ **External tool integrations (Slack, Jira, GitHub)** — separate roadmap item
- ❌ **LLM-driven prompt mutation** — agent prompts stay file-controlled and reviewable
- ❌ **Replacing the existing pipeline as default** — `autonomous` mode is opt-in per workspace for the foreseeable future
