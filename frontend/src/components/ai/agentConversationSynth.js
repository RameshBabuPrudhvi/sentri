/**
 * @module components/ai/agentConversationSynth
 * @description Pure-JS half of the AgentConversation component — turn
 * synthesizer + step → agent-sequence resolver + persona table + templates.
 *
 * Extracted out of `AgentConversation.jsx` so the tests can import them
 * under plain Node (no JSX, no Vite, no bundler). The component file
 * re-exports everything from here so existing imports keep working.
 *
 * Why the split: `frontend/tests/run-tests.js` runs every `*.test.js` with
 * plain `node`, which cannot parse JSX. Co-locating testable logic in a
 * sibling `.js` file matches the established frontend pattern (see
 * `frontend/src/utils/*.js` consumed by `frontend/tests/utils.test.js`).
 *
 * See `AgentConversation.jsx` for the synthesized vs. real-event mode
 * contract and the bug-vs-NarrativeFeed notes.
 */

import { stageStatus } from "../../utils/pipelineState.js";
import { getStageAgentRoles } from "../../config.js";

// ── Agent personas ───────────────────────────────────────────────────────────
//
// Personas are keyed by the canonical `AGENT_ROLES` values from
// `frontend/src/config.js#AGENT_ROLES` (mirrored from backend
// `agentHealthCheck.js#AGENT_ROLES`). Every key here MUST exist in the
// canonical list so a future Task 2 follow-up that swaps the synthesizer
// for real `agent_event` SSE payloads sees only registered agent names.
//
// Explorer covers steps 1-3: pre-LLM site crawl + DOM-element filter
// (steps 1+2, no LLM calls backend-side) AND LLM-driven intent
// classification (step 3, `agentRole: "explorer"` at
// `backend/src/pipeline/intentClassifier.js#aiClassifyPage`). The pre-LLM
// stages don't emit `agent_event` rows today, but conceptually it's the
// same agent doing structural discovery throughout — telling the user
// "Explorer is mapping → filtering → classifying" reads honestly. When
// `agent_event` SSE lands, steps 1+2 stay synthesized client-side and
// step 3 onwards swaps to real events.
export const AGENT_PERSONAS = {
  explorer:   { icon: "🔍", label: "Explorer",   color: "explorer", scope: "I look around your site to see what users can do." },
  planner:    { icon: "🧭", label: "Planner",    color: "planner",  scope: "I connect those actions into complete user journeys." },
  author:     { icon: "✍️", label: "Author",     color: "author",   scope: "I write the tests, one journey at a time." },
  oracle:     { icon: "🎯", label: "Oracle",     color: "oracle",   scope: "I make sure each test checks something meaningful." },
  reviewer:   { icon: "🛡️", label: "Reviewer",   color: "reviewer", scope: "I do the final quality check before anything ships." },
  // AUTO-023 Bundle 2 added envelope emit sites for `supervisor` (chat
  // route — bidirectional pair per request) and `healer` (vision-heal
  // outcomes). Without entries here, `messagesToTurns`'s
  // `AGENT_PERSONAS[m.fromRole]` filter silently dropped every envelope
  // those roles produced and the operator never saw them in the
  // conversation feed. Reuse the explorer / oracle palettes so we don't
  // invent new CSS variables for roles that share the same visual tier
  // (planner-adjacent supervision vs. assertion-tier healing).
  supervisor: { icon: "🧠", label: "Supervisor", color: "planner",  scope: "I decide who speaks next." },
  healer:     { icon: "🩹", label: "Healer",     color: "oracle",   scope: "I patch broken locators when a test can't find an element." },
};

// ── Per-step agent sequence ──────────────────────────────────────────────────

/**
 * Steps 1+2 fold under `explorer` — the pre-LLM crawl + filter are
 * structural-discovery work conceptually owned by the same agent that
 * later runs LLM-driven intent classification at step 3. Using `explorer`
 * here (instead of inventing a frontend-only "scout") keeps every persona
 * key inside the canonical `AGENT_ROLES` list, which matters when Task 2
 * `agent_event` SSE payloads start arriving and the synthesizer is
 * swapped for an event adapter — no foreign agent name will ever appear
 * in a real event stream.
 *
 * Steps 3-7 delegate to `getStageAgentRoles` from `config.js` — the
 * canonical map mirrored from the backend `agentRole:` argument. When
 * AUTO-023 wires Oracle / Reviewer backend-side, updating
 * `PIPELINE_STEP_ROLES` flows through here automatically.
 */
export function getStepAgentSequence(step) {
  if (step === 1 || step === 2) return ["explorer"];
  if (step === 8) return []; // terminal — Author speaks via wrapup
  const roles = getStageAgentRoles(step);
  return roles.length > 0 ? roles : ["author"]; // defensive fallback
}

// ── Turn templates ────────────────────────────────────────────────────────────
// Phase contract: see AgentConversation.jsx docblock.

export const TURN_TEMPLATES = {
  // ── Explorer (steps 1-3) ──
  // Explorer is a multi-step agent (parallel to Author at 4-7). The
  // `.doing.N` / `.finding.N` keys disambiguate per step so each stage's
  // wording stays specific:
  //   step 1 — crawl pages (no LLM call backend-side)
  //   step 2 — filter interactive elements (no LLM call backend-side)
  //   step 3 — classify user intents per page (LLM call:
  //            `agentRole: "explorer"` at intentClassifier.aiClassifyPage)
  //
  // `resolveTemplate` falls back to the un-suffixed key — used by
  // `explorer.onboard` (Explorer's first turn ever, fires once at step 1)
  // and `explorer.handoff` (one-time handoff to Planner at end of step 3).
  // The synthesizer's same-agent-step guard suppresses redundant `accept`
  // turns on steps 2 + 3 — Explorer is continuing, not formally accepting
  // a handoff from themselves.
  "explorer.onboard":   () => "Explorer here. I'll discover what's on your site.",
  "explorer.doing.1":   (r) => {
    const url = r?.projectUrl || r?.project?.url;
    return url
      ? `Opening ${url} and following every link I can reach…`
      : "Opening your homepage and following every link I can reach…";
  },
  "explorer.finding.1": (r, { ps }) => {
    // `pagesFound` + `pages` have a live top-level mirror (updated per
    // page snapshot at `crawlBrowser.js:338-347`), so prefer them over
    // `pipelineStats.pagesFound` which only materialises at step 8.
    //
    // Step 1 is pre-LLM — the backend emits zero `agent_event` rows
    // during the crawl loop (see comment at top of this file). To get
    // Claude-style per-page narration ("just visited X… 5 pages mapped
    // so far") we read `run.pages[-1]` directly from the snapshot SSE
    // array. Each crawl tick re-renders this template and the streamer
    // diffs the text by turn id (`1-explorer-finding`).
    const pages = r?.pagesFound ?? ps?.pagesFound;
    if (pages == null) return null;
    if (pages <= 0)    return "No reachable pages found on this site.";

    const list = Array.isArray(r?.pages) ? r.pages : [];
    const last = list.length > 0 ? list[list.length - 1] : null;
    const lastLabel = humanPageLabel(last);

    // Verb choice — step 1 is the *crawl* phase (URL discovery only); the
    // broader Explorer arc (steps 1-3) layers on element filtering + intent
    // classification. Narration must reflect crawl semantics, not the full
    // exploration. Constraints:
    //   • Not "Explored" — that's the agent's whole arc, not step 1.
    //   • Not "Visited" — too generic, doesn't convey "found a new URL".
    //   • Not "Reviewed" — collides with step-7 Reviewer agent.
    //   • Not "Crawled" — accurate but reads as technical jargon.
    // "Discovered" fits: professional, conveys URL-finding, no collisions.
    //
    // `humanPageLabel` returns the page title or empty string — never a
    // raw URL path. Title-less pages fall back to "another page" so
    // non-technical users never see `/api/v2/users` in the bubble.
    if (pages === 1) {
      return lastLabel
        ? `Discovered your homepage (${lastLabel}).`
        : "Discovered your homepage.";
    }
    return lastLabel
      ? `Discovered ${lastLabel}. ${pages} pages found so far.`
      : `Discovered another page. ${pages} pages found so far.`;
  },
  "explorer.doing.2":   () => "Looking at each page for buttons, links, and forms — the things a real user can click, type into, or tap. Skipping anything purely decorative.",
  "explorer.finding.2": (r, { ps }) => {
    const kept = ps?.elementsKept;
    if (kept == null) return null;
    if (kept <= 0)    return "Couldn't find anything users can act on across these pages.";
    return `Picked out ${kept} thing${kept !== 1 ? "s" : ""} a user can interact with.`;
  },
  "explorer.doing.3":   () => "Working out what each part of the site is for — signing up, searching, checking out, moving around.",
  "explorer.finding.3": (r, { ps }) => {
    // Suppressed mid-run — `pipelineStats.intentsClassified` is only set at
    // step-3 completion. Returning null keeps the conversation honest
    // instead of fabricating a "0 actions" finding before the stat arrives.
    const intents = ps?.intentsClassified;
    if (intents == null) return null;
    if (intents <= 0)    return "Couldn't work out what users would typically do on these pages.";
    return `Worked out ${intents} different thing${intents !== 1 ? "s" : ""} a user can do here.`;
  },
  "explorer.handoff":   () => "Handing off to Planner.",

  // ── Planner (step 3b) ──
  "planner.onboard": () => "Planner here. I'll connect what users can do into complete journeys — start to finish.",
  "planner.accept":  () => "Thanks Explorer. I'll connect these into complete journeys — start to finish.",
  "planner.doing":   () => "Joining the dots: how someone signs up, fills out a form, gets from the cart to a finished order…",
  "planner.finding": (r, { ps }) => {
    const j = ps?.journeysDetected;
    if (j == null) return null;
    if (j <= 0)    return "Couldn't piece together any clear user journeys from what's here.";
    return `Pieced together ${j} complete user journey${j !== 1 ? "s" : ""}, each with a clear start and finish.`;
  },
  "planner.handoff": () => "Handing off to Author.",

  // ── Author (steps 4-7) ──
  // Author is the only agent that reappears across multiple steps.
  // `.doing.N` / `.finding.N` keys disambiguate per step so each step's
  // wording can be specific (generate vs. dedup vs. enhance vs. validate).
  // `resolveTemplate` falls back to the un-suffixed key — used by
  // `author.accept` (step 4 only — the one step where Author follows a
  // handoff in) and `author.onboard`.
  "author.onboard":    () => "Author here. I'll turn each journey into a test, one at a time.",
  "author.accept":     () => "Thanks Planner. I'll turn each journey into a test, one at a time.",
  "author.doing.4":    () => "Writing each test in plain English — what to click, what to wait for, and what should happen next.",
  "author.finding.4":  (r, { ps, allTests }) => {
    const n = ps?.rawTestsGenerated;
    if (n == null) return null;
    if (n <= 0)    return "Couldn't write any tests — there were no journeys clear enough to turn into one.";
    // Join `run.tests × allTests` to surface real test names. Falls back to
    // a bare count when the tests cache hasn't refreshed yet.
    const ids = Array.isArray(r?.tests) ? r.tests : [];
    const idSet = new Set(ids);
    const names = Array.isArray(allTests)
      ? allTests.filter(t => idSet.has(t.id)).slice(0, 3).map(t => t.name || t.title).filter(Boolean)
      : [];
    const nameFrag = names.length
      ? ` (${names.join(", ")}${ids.length > names.length ? ", …" : ""})`
      : "";
    return `Wrote ${n} test${n !== 1 ? "s" : ""}${nameFrag}.`;
  },
  "author.doing.5":    () => "Looking through the tests for any that cover the same ground.",
  "author.finding.5":  (r, { ps }) => {
    const n = ps?.duplicatesRemoved;
    if (n == null) return null;
    if (n <= 0)    return "No overlap — every test covers something different.";
    return `Removed ${n} test${n !== 1 ? "s" : ""} that covered the same ground as others.`;
  },
  "author.doing.6":    () => "Making each test smarter — checking that something real actually happened, not just that the page loaded.",
  "author.finding.6":  (r, { ps }) => {
    const n = ps?.assertionsEnhanced;
    if (n == null) return null;
    if (n <= 0)    return "Every test was already checking the right things.";
    return `Made ${n} test${n !== 1 ? "s" : ""} check something more meaningful.`;
  },
  "author.doing.7":    () => "One last look — making sure each test reliably finds the right buttons, and that it's checking something worth checking.",
  "author.finding.7":  (r, { ps }) => {
    const n = ps?.validationRejected;
    if (n == null) return null;
    if (n <= 0)    return "Every test passed the final review.";
    return `Set aside ${n} test${n !== 1 ? "s" : ""} that looked unreliable or didn't check enough.`;
  },
  "author.wrapup":     (r) => {
    const total = r?.testsGenerated ?? 0;
    if (total <= 0)  return "All done — nothing came out of this run.";
    if (total === 1) return "All done — 1 test is ready for you to review.";
    return `All done — ${total} tests are ready for you to review.`;
  },
  // AUTO-023 — Author hands off to Oracle at end of step 5 (dedup → assertion
  // strengthening). Pre-AUTO-023 Author owned steps 4-7 contiguously so no
  // handoff template was needed (the synthesizer's `nextAgent !== agent`
  // guard suppressed self-handoffs). Now that step 6 is Oracle, the inter-
  // step handoff fires and `resolveTemplate("author", "handoff", 5)` falls
  // back to this un-suffixed key. The `<Next>` token is substituted by
  // `pushTurn` from `AGENT_PERSONAS[nextAgent].label`, so this template
  // stays correct if a future config swap re-targets Author's handoff to
  // a different downstream agent (e.g. AUTO-023 follow-up wires `triager`
  // between Author and Oracle).
  "author.handoff":    () => "Handing off to <Next>.",

  // ── Oracle (step 6) + Reviewer (step 7) ──
  // Live as of migration 058 — `frontend/src/config.js#PIPELINE_STEP_ROLES`
  // routes step 6 → "oracle" (assertion strengthening) and step 7 →
  // "reviewer" (quality gate). Per-project flags (`oracleEnabled` /
  // `reviewerEnabled`) gate the LLM call backend-side; when disabled, no
  // `agent_event` arrives so the synthesizer's optimistic turn renders
  // but never advances past `doing`. Single-step agents — no `.N`-suffixed
  // variants needed (the un-suffixed key wins via `resolveTemplate`).
  "oracle.onboard":   () => "Oracle here. I'll make sure each test is checking something real, not just that the page opened.",
  "oracle.accept":    () => "Thanks Author. I'll make each of your tests check something more meaningful.",
  "oracle.doing":     () => "Going through every test — looking for things like cart totals, error messages, and the right outcomes.",
  "oracle.finding":   (r, { ps }) => {
    const n = ps?.assertionsEnhanced;
    if (n == null || n <= 0) return null;
    return `Strengthened the checks in ${n} test${n !== 1 ? "s" : ""}.`;
  },
  "oracle.handoff":   () => "Handing off to Reviewer.",
  "reviewer.onboard": () => "Reviewer here. Doing the final quality check before anything ships.",
  "reviewer.accept":  () => "Thanks Oracle. Doing the final quality check now.",
  "reviewer.doing":   () => "Making sure every test will keep working — reliable steps, real checks, nothing flaky.",
  "reviewer.finding": (r, { ps }) => {
    const n = ps?.validationRejected;
    if (n == null) return null;
    if (n <= 0)    return "Every test passed the final check.";
    return `Sending ${n} test${n !== 1 ? "s" : ""} back to Author — they need a bit more work before they're ready.`;
  },
  "reviewer.handoff": () => "Handing off to Author.",
};

/**
 * Resolve a template key. Falls back to the un-suffixed key when no
 * step-specific variant is registered (Author has `.doing.N`/`.finding.N`
 * variants across 4-7; other agents share one set across their step).
 */
function resolveTemplate(agent, phase, step) {
  const stepKey = `${agent}.${phase}.${step}`;
  if (TURN_TEMPLATES[stepKey]) return TURN_TEMPLATES[stepKey];
  return TURN_TEMPLATES[`${agent}.${phase}`] || null;
}

// ── Turn synthesizer ──────────────────────────────────────────────────────────
//
// Pure function — derives the canonical turn list for a given `run`.
// No React state, no timers. Returns turns with stable IDs so the
// component's diff-and-append step in `useEffect` is a set comparison,
// not a deep-equality walk.
//
// Turn shape: { id, agent, phase, step, text, ts }
// `id` is `${step}-${agent}-${phase}` so the same logical turn can't be
// appended twice across re-renders, even when stats arrive out of order.

/**
 * @param {Object} run - `runData` from TestLab.
 * @param {Object} ctx - `{ ps, allTests }`.
 * @returns {Array<{id: string, agent: string, phase: string, step: number, text: string, ts: number}>}
 */
export function synthesizeTurns(run, ctx) {
  if (!run) return [];
  const turns = [];
  const status = run.status ?? "running";
  const currentStep = run.currentStep ?? null;

  // Walk steps 1..currentStep (clamped at 7 — step 8 is terminal-only).
  // On failed/aborted runs, `stageStatus` freezes already-reached stages as
  // "done" and everything later as "pending", so the walk below naturally
  // stops at the failure point — no turns for stages we never reached.
  const maxStep = currentStep == null ? 0 : Math.min(currentStep, 7);

  let prevAgent = null;
  const agentsSeen = new Set();

  for (let step = 1; step <= maxStep; step++) {
    const stepState = stageStatus(step, currentStep, status);
    const isActive = stepState === "active";
    const isDone   = stepState === "done";
    const agents = getStepAgentSequence(step);

    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      // Next agent for handoff target — next in this same step's sequence
      // (explorer → planner inside step 3), or first agent of the next
      // step. Null only when this is the final speaker.
      const nextAgent = agents[i + 1]
        || getStepAgentSequence(step + 1)?.[0]
        || null;
      const isFirstTimeForAgent = !agentsSeen.has(agent);
      agentsSeen.add(agent);

      // 1. Opening turn — `onboard` (first ever) or `accept` (handoff in).
      //    Same-agent step transitions (Author 4→5→6→7) skip both — the
      //    conversation reads as one person continuing, not formally
      //    accepting a handoff from themselves.
      const sameAgentAsPrev = prevAgent === agent;
      if (isFirstTimeForAgent) {
        pushTurn(turns, run, ctx, { agent, phase: "onboard", step, prevAgent, nextAgent });
      } else if (!sameAgentAsPrev) {
        pushTurn(turns, run, ctx, { agent, phase: "accept", step, prevAgent, nextAgent });
      }

      // 2. Doing turn — emit when active OR done. Keeping the doing line in
      //    the transcript after a step finishes preserves the "here's what
      //    I did" narrative; suppressing it on done would shrink the
      //    transcript when a stage flips.
      if (isActive || isDone) {
        pushTurn(turns, run, ctx, { agent, phase: "doing", step, prevAgent, nextAgent });
      }

      // 3. Finding turn — emit when active OR done, and only when the
      //    template resolved to a non-null string (the stat actually
      //    landed). Mid-run emission is safe because each template's
      //    honesty guard returns null until its stat materialises — but
      //    step 1 has a live `run.pagesFound` mirror that ticks per page
      //    snapshot (`backend/src/pipeline/crawlBrowser.js:338`), so the
      //    bubble grows from "Mapped 3 pages." → "Mapped 30 pages." as
      //    crawling progresses instead of staying frozen on "Opening…"
      //    until the step flips done.
      if (isActive || isDone) {
        pushTurn(turns, run, ctx, { agent, phase: "finding", step, prevAgent, nextAgent });
      }

      // 4. Handoff — only on done + when there's a different-agent target.
      //    Intra-step handoffs (explorer → planner inside step 3) AND
      //    inter-step handoffs (planner@3 → author@4) both qualify, as long
      //    as `nextAgent !== agent` (suppresses Author@4 → Author@5 noise).
      const nextStepFirstAgent = getStepAgentSequence(step + 1)?.[0];
      const isAgentsLastInStep = i === agents.length - 1;
      const agentChangesNextStep = nextStepFirstAgent && nextStepFirstAgent !== agent;
      const intraStepHandoff = !isAgentsLastInStep;
      const interStepHandoff = isAgentsLastInStep && agentChangesNextStep;
      if (isDone && (intraStepHandoff || interStepHandoff) && nextAgent && nextAgent !== agent) {
        pushTurn(turns, run, ctx, { agent, phase: "handoff", step, prevAgent, nextAgent });
      }

      prevAgent = agent;
    }
  }

  // Step 8 wrapup — only when the run completed cleanly. Failed/aborted
  // runs intentionally don't get a wrapup; the transcript freezes at the
  // last legitimate turn. TestLab renders a separate terminal banner
  // ("Run aborted" / "Run failed") above the conversation, so the user
  // has terminal-state context elsewhere.
  if (status === "completed" || status === "completed_empty") {
    pushTurn(turns, run, ctx, { agent: "author", phase: "wrapup", step: 8, prevAgent, nextAgent: null });
  }

  return turns;
}

/**
 * Append a turn to `turns` if its template resolves. Mutates `turns` in
 * place (cheap — synthesizer owns the array). `<Prev>` / `<Next>` token
 * substitution is supported so templates can stay declarative.
 */
function pushTurn(turns, run, ctx, { agent, phase, step, prevAgent, nextAgent }) {
  const template = resolveTemplate(agent, phase, step);
  if (!template) return;
  const raw = template(run, { ...ctx, prevAgent, nextAgent });
  if (raw == null || raw === "") return;
  const text = String(raw)
    .replace(/<Next>/g, AGENT_PERSONAS[nextAgent]?.label || "")
    .replace(/<Prev>/g, AGENT_PERSONAS[prevAgent]?.label || "");
  const id = `${step}-${agent}-${phase}`;
  // Stat chip: finding turns carry a scannable summary chip so the user
  // can glance at "47 pages found" / "12 tests written" without reading
  // the full sentence. Mirrors the old NarrativeFeed's green `.tl-nf-stat`
  // pill. Only populated for `finding` phase — other phases have no stat.
  let _stat = undefined;
  if (phase === "finding") {
    // Keyed by `step` or `step:agent` so multi-agent stages (step 3 =
    // explorer + planner) resolve to the correct stat for each speaker.
    // The `step:agent` key wins over the bare `step` key when present.
    const STAT_MAP = {
      1:            { key: "pagesFound",          label: "pages found" },
      2:            { key: "elementsKept",         label: "elements kept" },
      "3:explorer": { key: "intentsClassified",    label: "intents classified" },
      "3:planner":  { key: "journeysDetected",     label: "journeys mapped" },
      4:            { key: "rawTestsGenerated",    label: "tests written" },
      5:            { key: "duplicatesRemoved",    label: "duplicates removed" },
      6:            { key: "assertionsEnhanced",   label: "assertions upgraded" },
      7:            { key: "validationRejected",   label: "rejected" },
    };
    const spec = STAT_MAP[`${step}:${agent}`] || STAT_MAP[step];
    if (spec) {
      // Step 1 has a live top-level mirror (`run.pagesFound`), prefer it.
      const val = step === 1
        ? (run?.pagesFound ?? ctx.ps?.[spec.key])
        : ctx.ps?.[spec.key];
      if (val != null) _stat = { value: val, label: spec.label };
    }
    if (step === 8) {
      const total = run?.testsGenerated ?? 0;
      if (total > 0) _stat = { value: total, label: "tests ready" };
    }
  }
  turns.push({ id, agent, phase, step, text, ts: Date.now(), _stat });
}

// ── Event-driven adapter (Task 2 follow-up) ───────────────────────────────────
//
// Maps the raw `agent_event[]` SSE history (seeded by the snapshot at
// `backend/src/routes/sse.js#L170-L182` and appended live by
// `frontend/src/pages/TestLab.jsx#handleSSEEvent` on every `agent_event`
// push) into the same turn shape `synthesizeTurns` produces.
//
// Phase contract (mirrors `migration 057` CHECK clause):
//   - `start`    → emit a streaming turn (one per `${step}-${agent}` pair).
//   - `progress` → append `event.message` to the turn's text (rare; emitted
//                  by future incremental progress hooks). Same merge semantics
//                  as `finding`.
//   - `finding`  → append `event.message` (or `event.data`'s scalar form) to
//                  the existing `start` turn. NOT a separate turn — operators
//                  read findings as continuations of "what the agent is doing
//                  right now", not as fresh utterances.
//   - `handoff`  → emit an instant-render handoff turn (matches the
//                  `phase: "handoff"` shape `synthesizeTurns` produces, so
//                  the component's diff layer handles both modes uniformly).
//   - `done`     → no new turn; the component's streamer flips the matching
//                  `start` turn's status to "done" once `renderedText` reaches
//                  the end of `text`. We mark the merged turn as "complete"
//                  via a `_complete` flag so the component knows not to wait
//                  for further finding/progress events.
//
// Stable ID scheme: `evt-${step}-${agent}-${phase}` for non-merged turns
// (`onboard`/`handoff`/`wrapup`-equivalent). Merged turns use
// `evt-${step}-${agent}-doing` so a finding arriving after a start extends
// the same turn instead of creating a sibling — operators see Explorer's
// "Classifying intent…" turn grow with "Identified 8 user intents" appended,
// not two stacked turns.

const HANDOFF_TEMPLATES = {
  explorer: "Handing off to <Next>.",
  planner:  "Handing off to <Next>.",
  author:   "Handing off to <Next>.",
  oracle:   "Handing off to <Next>.",
  reviewer: "Handing off to <Next>.",
};

/**
 * Pure mapper from a chronological `agent_event[]` list to the turn shape
 * the AgentConversation component renders. Returns turns in emission order;
 * stable IDs let the component's diff-and-append step skip already-rendered
 * turns and merge findings into open `start` turns.
 *
 * @param {Array<Object>} events - `runData.agentEvents`. Each row carries
 *   `{ step, agent, phase, message, data, nextAgent, model, createdAt }`.
 * @returns {Array<{id: string, agent: string, phase: string, step: number,
 *   text: string, ts: number, _complete?: boolean}>}
 */
export function eventsToTurns(events) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const turns = [];
  // Map keyed by `${step}-${agent}` so finding/progress/done events know
  // which previously-emitted turn to merge into.
  const openByAgent = new Map();

  for (const evt of events) {
    if (!evt || !evt.agent || !evt.phase) continue;
    if (!AGENT_PERSONAS[evt.agent]) continue; // skip unknown agents (defence)
    const step = Number(evt.step) || 0;
    const ts = evt.createdAt ? Date.parse(evt.createdAt) || Date.now() : Date.now();
    const key = `${step}-${evt.agent}`;

    if (evt.phase === "start") {
      // Open a new doing-style turn. Wording prefers the backend's
      // `message` (operator-controlled at the call site) and falls back
      // to a generic "<Agent> is working" so the turn never renders empty.
      // Backend messages can embed full URLs (e.g. step 4 emits
      // `Writing tests for ${classifiedPage.url}` per journey at
      // `backend/src/pipeline/journeyGenerator.js:273-274`). Run them
      // through `prettifyMessage` so encoded query strings and long paths
      // don't dump into the bubble verbatim.
      const persona = AGENT_PERSONAS[evt.agent];
      const text = prettifyMessage(evt.message) || `${persona.label} is working…`;
      // Bug fix: when the same agent emits multiple start/done cycles for
      // the same step (e.g. Author writes tests per-page at step 4, or
      // Planner plans per-journey at step 3), a previous `done` event
      // deleted the key from `openByAgent` but the turn with id
      // `evt-${key}-doing` is already in `turns`. If we push a new turn
      // with the same id, the component's diff-by-id would silently drop
      // the second cycle. Instead, find the existing completed turn and
      // reopen it by appending the new message — the user sees the turn
      // grow with each cycle's content rather than losing all but the first.
      const existing = openByAgent.get(key);
      if (!existing) {
        // Check if a completed turn for this key is already in the array.
        const prev = turns.find(t => t.id === `evt-${key}-doing`);
        if (prev) {
          // Reopen the completed turn — append the new cycle's message.
          if (text && !prev.text.endsWith(text)) {
            prev.text = prev.text ? `${prev.text} ${text}` : text;
          }
          prev._complete = false;
          prev.ts = ts;
          openByAgent.set(key, prev);
        } else {
          const turn = {
            id: `evt-${key}-doing`,
            agent: evt.agent,
            phase: "doing",
            step,
            text,
            ts,
          };
          openByAgent.set(key, turn);
          turns.push(turn);
        }
      } else {
        // Still open from a previous start (no done arrived yet).
        // Append the new message as a continuation.
        if (text && !existing.text.endsWith(text)) {
          existing.text = existing.text ? `${existing.text} ${text}` : text;
          existing.ts = ts;
        }
      }
      continue;
    }

    if (evt.phase === "handoff") {
      const persona = AGENT_PERSONAS[evt.agent];
      const nextLabel = AGENT_PERSONAS[evt.nextAgent]?.label || "the next agent";
      const tmpl = HANDOFF_TEMPLATES[evt.agent] || "Handing off to <Next>.";
      const text = (evt.message || tmpl).replace(/<Next>/g, nextLabel);
      turns.push({
        id: `evt-${key}-handoff-${turns.length}`, // include index so multiple handoffs from the same agent (e.g. retry) don't collide
        agent: evt.agent,
        phase: "handoff",
        step,
        text,
        ts,
        // Handoffs are atomic — render instantly without streaming.
        _complete: true,
        // Carry persona reference for the component (avoids a second lookup).
        _persona: persona,
      });
      continue;
    }

    // AUTO-023 B3.4 — single-agent-collapse advisory. Backend's
    // `maybeWarnSingleAgentCollapse` emits an `agent_event` with
    // `phase: "finding"` + `data.kind === "single_agent_collapse"` once
    // per run when author + reviewer share the same routeId. Render it
    // as a standalone, instant-display turn flagged `_warning: true` so
    // `AgentConversation.jsx` can apply a distinct (warning-tier) style
    // — without this branch it would silently merge into whichever
    // doing turn was open for the reviewer, which buries the operator
    // signal under regular narration.
    if (evt.phase === "finding" && evt.data?.kind === "single_agent_collapse") {
      const text = prettifyMessage(evt.message)
        || `Single-agent collapse on route ${evt.data.routeId}.`;
      turns.push({
        id: `evt-${key}-collapse-${turns.length}`,
        agent: evt.agent,
        phase: "finding",
        step,
        text,
        ts,
        _complete: true,
        _warning: true,
      });
      continue;
    }
    // AUTO-023 B4.1 — weak-supervisor-model advisory. Backend's
    // `supervisorAgent.maybeWarnWeakSupervisorModel` emits an
    // `agent_event` with `phase: "finding"` + `data.kind ===
    // "supervisor_weak_model"` once per autonomous thread when the
    // supervisor route resolves to a low-reasoning model (Haiku/Mini/
    // Flash/Nano/7b/8b). Same standalone-warning rendering pattern as
    // the single-agent-collapse branch above — without it the operator
    // never sees the "your orchestrator is on a cheap model" signal.
    if (evt.phase === "finding" && evt.data?.kind === "supervisor_weak_model") {
      const text = prettifyMessage(evt.message)
        || `Supervisor running on weak model ${evt.data.model || "(unknown)"}; consider Claude Sonnet / GPT-4o / Gemini Pro.`;
      turns.push({
        id: `evt-${key}-supervisor-weak-${turns.length}`,
        agent: evt.agent,
        phase: "finding",
        step,
        text,
        ts,
        _complete: true,
        _warning: true,
      });
      continue;
    }
    if (evt.phase === "finding" || evt.phase === "progress") {
      // Merge into the open doing turn for this (step, agent). When no
      // start preceded this event (orphan finding — possible if the SSE
      // snapshot was truncated or events arrived out of order), promote
      // the finding to a standalone turn so the user still sees it.
      const open = openByAgent.get(key);
      const fragment = prettifyMessage(evt.message) || formatScalarData(evt.data);
      if (!fragment) continue;
      if (open) {
        // Append to the existing turn's text on a new line so the finding
        // reads as a visually separate paragraph from the doing sentence.
        // `.ac-text { white-space: pre-line }` renders the `\n` as a
        // line break in the browser. Idempotent on duplicate events (rare
        // but possible on reconnect): the second append no-ops when the
        // fragment is already a suffix.
        if (!open.text.endsWith(fragment)) {
          open.text = open.text ? `${open.text}\n${fragment}` : fragment;
          open.ts = ts;
        }
      } else {
        const orphan = {
          id: `evt-${key}-${evt.phase}-${turns.length}`,
          agent: evt.agent,
          phase: "doing",
          step,
          text: fragment,
          ts,
        };
        openByAgent.set(key, orphan);
        turns.push(orphan);
      }
      continue;
    }

    if (evt.phase === "done") {
      // Mark the matching start turn complete so the component's streamer
      // knows the merged text won't grow further. If there's no open turn
      // (done arrived without start — shouldn't happen but defended), this
      // event is a no-op. We don't emit a separate turn for `done`: the
      // streamer flipping the start turn to status="done" is the visible
      // signal.
      const open = openByAgent.get(key);
      if (open) {
        open._complete = true;
        openByAgent.delete(key);
      }
      continue;
    }
  }

  return turns;
}

export function messagesToTurns(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const ordered = messages
    .filter((m) => m && AGENT_PERSONAS[m.fromRole])
    .sort((a, b) => {
      const at = Date.parse(a?.createdAt || "") || 0;
      const bt = Date.parse(b?.createdAt || "") || 0;
      if (at !== bt) return at - bt;
      return String(a?.id || "").localeCompare(String(b?.id || ""));
    });
  const roundAuthorTests = new Map();
  // Cheap content digest for the round-diff `updated` check. The full-string
  // fingerprint (`id|name|playwrightCode`) was correct but allocated a fresh
  // ~2KB string per test per render; at a 50-test suite × ~5 re-renders per
  // SSE tick that's ~500KB/sec of throwaway strings + Map-key comparisons.
  // FNV-1a 32-bit hash over `playwrightCode` is O(n) once per fingerprint
  // computation but produces a tiny integer that hashes in O(1) — net win
  // since `roundAuthorTests` is consulted on every `request_revision` turn.
  // Collision risk is acceptable for a visual diff hint: the worst case is
  // a turn shows "no artifact diff captured" when one test's code happened
  // to collide with the prior version, which downgrades to the same wording
  // the empty-diff branch already uses. Length-prefix keeps collisions in
  // the rare "two strings of different length hash to the same 32-bit value"
  // class instead of the common "same length, same hash" class.
  const fnv1a32 = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  };
  const fingerprint = (t) => {
    const code = t?.playwrightCode || "";
    return `${t?.id || ""}|${t?.name || ""}|${code.length}:${fnv1a32(code).toString(16)}`;
  };
  return ordered
    .map((m, idx) => {
      const toLabel = m.toRole && AGENT_PERSONAS[m.toRole] ? AGENT_PERSONAS[m.toRole].label : "All";
      const intent = m.intent || "handoff";
      const round = Number(m.round) || 0;
      if (m.fromRole === "author" && intent === "handoff") {
        const map = new Map();
        for (const t of (m.artifact?.tests || [])) {
          if (t?.id) map.set(t.id, fingerprint(t));
        }
        roundAuthorTests.set(round, map);
      }
      let detail = m.rationale || formatScalarData(m.artifact) || "";
      if (intent === "request_revision") {
        // Per-round diff is only meaningful when there's a PRIOR round
        // to compare against. On round 0 (the very first revision request)
        // every test is "new" relative to nothing — printing "+N added"
        // reads as "the author created N tests this round" when they were
        // actually the initial submission. Suppress the diff fragment on
        // round 0; on round 1+ compute against the previous round's
        // author handoff. `roundAuthorTests.get(-1)` would otherwise
        // return `undefined` and fall through to the empty-Map default,
        // producing the misleading "+N added".
        let diffFragment = "";
        if (round > 0) {
          const prev = roundAuthorTests.get(round - 1) || new Map();
          const curr = roundAuthorTests.get(round) || new Map();
          const added = [...curr.keys()].filter((id) => !prev.has(id));
          const removed = [...prev.keys()].filter((id) => !curr.has(id));
          const updated = [...curr.keys()].filter((id) => prev.has(id) && prev.get(id) !== curr.get(id));
          const pieces = [];
          if (added.length) pieces.push(`+${added.length} added`);
          if (updated.length) pieces.push(`~${updated.length} updated`);
          if (removed.length) pieces.push(`-${removed.length} removed`);
          const diffLabel = pieces.length ? pieces.join(", ") : "no artifact diff captured";
          diffFragment = ` (${diffLabel})`;
        }
        detail = `Round ${round + 1} — Reviewer rejected ${(m.artifact?.issues || []).length || 0} issues → Author fixing${diffFragment}`;
      }
      const text = `[${intent}] ${AGENT_PERSONAS[m.fromRole].label} → ${toLabel}${detail ? ` — ${detail}` : ""}`;
      // B3.5 — surface the round index on every loop-vocabulary turn so
      // `AgentConversation.jsx` can render the "Round N" badge. We
      // expose `_round` on `request_revision`, `accept`, and `reject_final`
      // (the three Bundle 3 intents from `agentEnvelope.js#INTENTS`) plus
      // any `handoff` whose round > 0, which is what an author revision
      // looks like. Round-0 handoffs (the initial author submission)
      // intentionally don't get a badge — the operator doesn't need
      // "Round 1" noise on the very first turn.
      const isLoopIntent = intent === "request_revision" || intent === "accept" || intent === "reject_final";
      const showRoundBadge = isLoopIntent || (intent === "handoff" && round > 0);
      // AUTO-023 B4 — supervisor handoffs use the `round` field to
      // carry the autonomous-thread STEP index, not a reviewer↔author
      // ROUND index. Flag the turn with `_supervisorStep: true` so
      // `AgentConversation.jsx` labels the badge "Step N / 20" instead
      // of "Round N" — same badge surface, different semantic for
      // operators. `messagesToTurns` is also the only producer of
      // supervisor → next-role envelopes (no `agent_event` channel
      // emits them today), so this flag is the only place the
      // semantic distinction can be set.
      const isSupervisorHandoff = m.fromRole === "supervisor" && intent === "handoff";
      return {
        id: `msg-${m.id || idx}`,
        agent: m.fromRole,
        phase: "handoff",
        step: round,
        text,
        ts: m.createdAt ? Date.parse(m.createdAt) || Date.now() : Date.now(),
        _complete: true,
        _round: showRoundBadge || isSupervisorHandoff ? round : undefined,
        _supervisorStep: isSupervisorHandoff || undefined,
      };
    });
}

/**
 * Build a short human-readable label for a crawled page row from
 * `run.pages` (`{ url, title, status, ... }` — see `crawlBrowser.js:340-345`).
 * Used by `explorer.finding.1` to narrate per-page crawl progress.
 *
 * Preference order: `title` (if non-empty and not a URL fallback) wrapped
 * in quotes, else the URL's path segment in backticks, else null. Trims
 * to ~40 chars to keep the bubble compact.
 */
function humanPageLabel(page) {
  if (!page || typeof page !== "object") return "";
  const url = typeof page.url === "string" ? page.url : "";
  const title = typeof page.title === "string" ? page.title.trim() : "";
  // Prefer the real page title — that's what a non-technical user
  // recognises ("Pricing", "About Us"). `crawlBrowser.js:340-345`
  // falls back to `s.url` when title is empty, so reject titles that
  // are just the URL string — they'd leak raw paths into the bubble.
  if (title && title !== url) {
    return title.length > 40 ? title.slice(0, 37) + "…" : title;
  }
  // No usable title. Industry-standard UX (Linear / Notion / Vercel)
  // hides raw URL paths from end users — they read as a leak, especially
  // for technical paths like `/api/v2/users` or query strings. Return an
  // empty string so the template falls through to its title-less branch
  // ("another page" / generic count) instead of dumping the path.
  return "";
}

// Backend journey-type enum → human-readable label. The Planner emits
// `Planning journey: ${journey.name}` where `journey.name` is generated
// by `backend/src/pipeline/flowGraph.js:193` as `${type} Flow ${idx + 1}`
// — e.g. "NAVIGATION Flow 1", "FORM_SUBMISSION Flow 2". Users don't know
// what these enums mean, so we humanize the type and drop "Flow" (it
// reads as internal jargon — "the navigation flow" → "navigation
// journey"). The trailing index is kept (some users find it disambiguating
// when multiple journeys of the same type exist).
const JOURNEY_TYPE_LABELS = {
  AUTH:             "sign-in",
  FORM_SUBMISSION:  "form submission",
  SEARCH:           "search",
  NAVIGATION:       "navigation",
  CRUD:             "data-entry",
};

/**
 * Prettify a backend `agent_event.message` for display in the conversation
 * bubble. Two transformations:
 *   1. URLs → `host + truncated path` (max 40 chars). Step 4's `Writing
 *      tests for ${classifiedPage.url}` per-journey events at
 *      `backend/src/pipeline/journeyGenerator.js:273-274` embed full
 *      encoded URLs that blow out the bubble.
 *   2. Journey-type enums → readable labels. Step 3's `Planning journey:
 *      NAVIGATION Flow 1` (from `flowGraph.js:193`) reads as internal
 *      jargon — users don't know what `NAVIGATION Flow` means.
 *
 * Non-matching text passes through unchanged so other backend wording
 * (e.g. "Comparing 12 tests…") stays intact.
 */
function prettifyMessage(message) {
  if (!message || typeof message !== "string") return message || "";
  let out = message;

  // 1. URL truncation.
  out = out.replace(/https?:\/\/\S+/g, (match) => {
    try {
      const u = new URL(match);
      let path = decodeURIComponent(u.pathname || "");
      if (u.search) path += u.search;
      if (path.length > 40) path = path.slice(0, 37) + "…";
      const tail = path && path !== "/" ? path : "";
      return `${u.host}${tail}`;
    } catch {
      // Malformed URL — fall back to a hard length cap so the raw string
      // can't blow out the bubble even when URL parsing fails.
      return match.length > 60 ? match.slice(0, 57) + "…" : match;
    }
  });

  // 2. Journey-type enum → readable label. Matches `TYPE Flow N` (the
  // exact pattern `flowGraph.js:193` emits). Conservative: only the
  // five known enum values are humanized; unknown types pass through so
  // a future backend addition doesn't get silently mangled.
  out = out.replace(/\b(AUTH|FORM_SUBMISSION|SEARCH|NAVIGATION|CRUD) Flow (\d+)\b/g,
    (_m, type, idx) => `${JOURNEY_TYPE_LABELS[type] || type.toLowerCase()} journey #${idx}`);

  return out;
}

/**
 * Render an event's `data` payload as a short human-readable fragment when
 * `message` is absent. Conservative: only stringifies primitives + small
 * key/value objects so we don't dump megabyte JSON into the conversation.
 */
function formatScalarData(data) {
  if (data == null) return "";
  if (typeof data === "string" || typeof data === "number" || typeof data === "boolean") {
    return String(data);
  }
  if (typeof data === "object" && !Array.isArray(data)) {
    // Keep first 3 entries to avoid runaway payloads.
    const entries = Object.entries(data).slice(0, 3);
    if (entries.length === 0) return "";
    return entries.map(([k, v]) => `${k}=${typeof v === "object" ? "…" : v}`).join(", ");
  }
  return "";
}
