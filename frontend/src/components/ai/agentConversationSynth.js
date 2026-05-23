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
  explorer: { icon: "🔍", label: "Explorer", color: "explorer", scope: "I find what users can do." },
  planner:  { icon: "🧭", label: "Planner",  color: "planner",  scope: "I group actions into journeys." },
  author:   { icon: "✍️", label: "Author",   color: "author",   scope: "I write the tests." },
  oracle:   { icon: "🎯", label: "Oracle",   color: "oracle",   scope: "I strengthen assertions." },
  reviewer: { icon: "🛡️", label: "Reviewer", color: "reviewer", scope: "I gate quality." },
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
    // `pagesFound` has a live top-level mirror (incremented per page
    // snapshot at `crawlBrowser.js:338`), so prefer it over
    // `pipelineStats.pagesFound` which only materialises at step 8.
    const pages = r?.pagesFound ?? ps?.pagesFound;
    if (pages == null) return null;
    if (pages <= 0)    return "No reachable pages found on this site.";
    return `Mapped ${pages} page${pages !== 1 ? "s" : ""}.`;
  },
  "explorer.doing.2":   () => "Scanning each page for buttons, inputs, forms — anything a user can act on. Skipping decorative content.",
  "explorer.finding.2": (r, { ps }) => {
    const kept = ps?.elementsKept;
    if (kept == null) return null;
    if (kept <= 0)    return "No interactive elements found — the crawled pages have nothing to act on.";
    return `Kept ${kept} interactive element${kept !== 1 ? "s" : ""}.`;
  },
  "explorer.doing.3":   () => "Reading the page structure to classify what each user action does — sign-up, search, checkout, navigation.",
  "explorer.finding.3": (r, { ps }) => {
    // Suppressed mid-run — `pipelineStats.intentsClassified` is only set at
    // step-3 completion. Returning null keeps the conversation honest
    // instead of fabricating a "0 actions" finding before the stat arrives.
    const intents = ps?.intentsClassified;
    if (intents == null) return null;
    if (intents <= 0)    return "Couldn't identify any user intents on the crawled pages.";
    return `Identified ${intents} distinct user intent${intents !== 1 ? "s" : ""}.`;
  },
  "explorer.handoff":   () => "Handing off to Planner.",

  // ── Planner (step 3b) ──
  "planner.onboard": () => "Planner here. Grouping these into end-to-end journeys.",
  "planner.accept":  () => "Thanks Explorer. I'll group these into end-to-end journeys.",
  "planner.doing":   () => "Tracing paths: sign-up flows, form submissions, cart to checkout…",
  "planner.finding": (r, { ps }) => {
    const j = ps?.journeysDetected;
    if (j == null) return null;
    if (j <= 0)    return "No coherent journeys could be mapped from these actions.";
    return `Mapped ${j} distinct user journey${j !== 1 ? "s" : ""} with clear starts and expected outcomes.`;
  },
  "planner.handoff": () => "Handing off to Author.",

  // ── Author (steps 4-7) ──
  // Author is the only agent that reappears across multiple steps.
  // `.doing.N` / `.finding.N` keys disambiguate per step so each step's
  // wording can be specific (generate vs. dedup vs. enhance vs. validate).
  // `resolveTemplate` falls back to the un-suffixed key — used by
  // `author.accept` (step 4 only — the one step where Author follows a
  // handoff in) and `author.onboard`.
  "author.onboard":    () => "Author here. Writing tests, one journey at a time.",
  "author.accept":     () => "Thanks Planner. Writing tests, one journey at a time.",
  "author.doing.4":    () => "Picking stable selectors, adding wait conditions, capturing each step in plain English.",
  "author.finding.4":  (r, { ps, allTests }) => {
    const n = ps?.rawTestsGenerated;
    if (n == null) return null;
    if (n <= 0)    return "No tests were generated — there were no viable journeys to encode.";
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
    return `Generated ${n} test${n !== 1 ? "s" : ""}${nameFrag}.`;
  },
  "author.doing.5":    () => "Comparing all tests for overlapping scenarios.",
  "author.finding.5":  (r, { ps }) => {
    const n = ps?.duplicatesRemoved;
    if (n == null) return null;
    if (n <= 0)    return "No duplicates found — the suite is already lean.";
    return `Removed ${n} duplicate${n !== 1 ? "s" : ""}.`;
  },
  "author.doing.6":    () => "Reviewing assertions — upgrading weak page-load checks to meaningful behavioural ones.",
  "author.finding.6":  (r, { ps }) => {
    const n = ps?.assertionsEnhanced;
    if (n == null) return null;
    if (n <= 0)    return "No assertions needed upgrading.";
    return `Enhanced ${n} test${n !== 1 ? "s" : ""} with stronger assertions.`;
  },
  "author.doing.7":    () => "Final quality check — selector stability and assertion coverage.",
  "author.finding.7":  (r, { ps }) => {
    const n = ps?.validationRejected;
    if (n == null) return null;
    if (n <= 0)    return "All tests passed quality review.";
    return `Rejected ${n} test${n !== 1 ? "s" : ""} with brittle selectors or weak coverage.`;
  },
  "author.wrapup":     (r) => {
    const total = r?.testsGenerated ?? 0;
    if (total <= 0)  return "All done — no tests were generated for this run.";
    if (total === 1) return "All done — 1 test ready for your review.";
    return `All done — ${total} tests ready for your review.`;
  },

  // ── Future: Oracle + Reviewer (AUTO-023) ──
  // Templates declared but unreferenced until `PIPELINE_STEP_ROLES` in
  // config.js flips 6 → ["oracle"] and 7 → ["reviewer"]. Defining them now
  // means the AUTO-023 PR is a one-line config change, not a component
  // rewrite — the synthesizer picks these up automatically.
  "oracle.onboard":   () => "Oracle here. I'll strengthen the assertions Author wrote.",
  "oracle.accept":    () => "Thanks Author. I'll strengthen the assertions you wrote.",
  "oracle.doing":     () => "Reviewing each test for assertion depth — cart counts, form errors, response codes.",
  "oracle.finding":   (r, { ps }) => {
    const n = ps?.assertionsEnhanced;
    if (n == null || n <= 0) return null;
    return `Upgraded ${n} assertion${n !== 1 ? "s" : ""}.`;
  },
  "oracle.handoff":   () => "Handing off to Reviewer.",
  "reviewer.onboard": () => "Reviewer here. Running quality review now.",
  "reviewer.accept":  () => "Thanks Oracle. Running quality review now.",
  "reviewer.doing":   () => "Checking selector stability, coverage, and assertion depth across the suite.",
  "reviewer.finding": (r, { ps }) => {
    const n = ps?.validationRejected;
    if (n == null) return null;
    if (n <= 0)    return "All tests passed review.";
    return `Rejected ${n} test${n !== 1 ? "s" : ""}. Author, please tighten and re-submit.`;
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

      // 3. Finding turn — only when step is done AND the template resolved
      //    to a non-null string (the stat actually landed). The honesty
      //    guard: mid-run we don't fabricate "0 X found" while the stat is
      //    still arriving.
      if (isDone) {
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
  turns.push({ id, agent, phase, step, text, ts: Date.now() });
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
      const persona = AGENT_PERSONAS[evt.agent];
      const text = evt.message || `${persona.label} is working…`;
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

    if (evt.phase === "finding" || evt.phase === "progress") {
      // Merge into the open doing turn for this (step, agent). When no
      // start preceded this event (orphan finding — possible if the SSE
      // snapshot was truncated or events arrived out of order), promote
      // the finding to a standalone turn so the user still sees it.
      const open = openByAgent.get(key);
      const fragment = evt.message || formatScalarData(evt.data);
      if (!fragment) continue;
      if (open) {
        // Append to the existing turn's text. Idempotent on duplicate
        // events (rare but possible on reconnect): the second append no-ops
        // when the fragment is already a suffix.
        if (!open.text.endsWith(fragment)) {
          open.text = open.text ? `${open.text} ${fragment}` : fragment;
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
