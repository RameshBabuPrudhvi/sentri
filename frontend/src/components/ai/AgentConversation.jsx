/**
 * @module components/ai/AgentConversation
 * @description Multi-agent chat transcript for the Test Lab pipeline view.
 *
 * Replaces NarrativeFeed (a single-narrator stream) with an honest
 * multi-agent conversation: Scout maps the site, hands off to Explorer who
 * identifies actions, hands off to Planner who maps journeys, hands off to
 * Author who writes/dedupes/enhances/validates tests. Each turn carries the
 * agent's avatar, label, model attribution, and a streaming text bubble.
 *
 * ### Real-event mode (preferred) vs. synthesized fallback
 *
 * **Real events (preferred)** — when `runData.agentEvents` carries any rows
 * (seeded from the SSE snapshot at `backend/src/routes/sse.js#L170-L182`,
 * appended live by `frontend/src/pages/TestLab.jsx#handleSSEEvent` on every
 * `agent_event` push), turns come from `eventsToTurns(events)`. Each
 * `phase: "start"` event opens a streaming turn, subsequent `finding` /
 * `progress` events extend that turn's text in place (so a finding lands
 * as continuation, not a new utterance), `phase: "handoff"` produces an
 * instant-render handoff turn, and `phase: "done"` marks the open turn
 * complete. Backend → component is a thin pass-through; the conversation
 * faithfully mirrors what the pipeline actually did.
 *
 * **Synthesized fallback** — when `agentEvents` is empty (run pre-dates
 * Task 2 migration 057 / the run hasn't started emitting events yet / the
 * snapshot was truncated), the legacy `synthesizeTurns` walk over
 * `runData.currentStep` + `runData.pipelineStats` + `getStageAgentRoles`
 * still produces a valid turn list with the templated wording defined
 * below. This preserves the prior UX for historical runs and gives the
 * component something to render before the first `agent_event` lands.
 *
 * Both modes return turns with stable IDs so the diff-and-append step
 * downstream is identical — the mode swap is invisible to the renderer.
 *
 * ### Bug fixes vs. NarrativeFeed
 *
 * - **Streaming cursor + thinking dots overlap** — pre-fix, the Connecting
 *   block in NarrativeFeed rendered the blinking caret AND the 3-dot bouncer
 *   simultaneously for the ~22 ms window when streaming first started
 *   (devin-ai-integration review thread, `TestLab.jsx:887-891`). The dot
 *   indicator here renders ONLY when no turns are displayed yet; once any
 *   turn exists, only the per-turn cursor renders (mutually exclusive by
 *   construction, not by render-time guard).
 * - **Per-character auto-scroll thrash** — pre-fix used `scrollIntoView`
 *   on every char tick. Here `lastLenRef` tracks turn count and we only
 *   scroll when `displayed.length` grows.
 *
 * @param {Object} props
 * @param {Object|null} props.run         - `runData` from TestLab.
 * @param {boolean}     props.isRunActive - True while the run is in flight.
 * @param {Object[]}    props.allTests    - Project's test inventory; used to
 *   resolve Author's filename pills.
 */

import React, { useState, useEffect, useRef, useMemo } from "react";
// Pure-JS half of this component (turn templates + synthesizer + step → role
// resolver) lives in a sibling `.js` file so the test suite can import it
// under plain Node — `frontend/tests/run-tests.js` cannot parse JSX.
// Re-exported below so existing `import { synthesizeTurns } from
// ".../AgentConversation"` paths continue to work.
import {
  AGENT_PERSONAS,
  getStepAgentSequence,
  TURN_TEMPLATES,
  synthesizeTurns,
  eventsToTurns,
} from "./agentConversationSynth.js";

// Re-exports so the test file (and any future consumer) can import these
// directly from `AgentConversation` if it prefers — single canonical
// component entry point.
export { getStepAgentSequence, TURN_TEMPLATES, synthesizeTurns, eventsToTurns };



// (Templates + synthesizer + pushTurn extracted to
// `./agentConversationSynth.js`; re-exported above.)




// ── Component ─────────────────────────────────────────────────────────────────

const CHAR_MS = 22; // ~45 chars/sec — fast enough to feel live, slow enough to read

/**
 * Multi-agent chat transcript. See module docblock for the synthesized vs.
 * real-event mode contract.
 */
export default function AgentConversation({ run, isRunActive, allTests }) {
  const ps = run?.pipelineStats || {};
  // Re-derive on every render but cheap (one walk over 1..currentStep with
  // stable string-keyed lookups). The stable IDs in `synthesizeTurns` make
  // the downstream diff a set comparison, not a deep-equality walk.
  // Memo keyed on the few fields the synthesizer actually reads so a sibling
  // SSE update that doesn't touch them (e.g. `logs.length` changing) doesn't
  // invalidate the memo unnecessarily.
  const ctx = useMemo(() => ({ ps, allTests }), [ps, allTests]);
  // Real-event mode wins when the run has any `agent_event` rows. Falls
  // back to the synthesizer for runs that pre-date Task 2 / haven't
  // started emitting events yet — same turn shape, same diff semantics
  // downstream, so the renderer is mode-agnostic. Memo keyed on the
  // `agentEvents` array reference (re-built by `handleSSEEvent` on every
  // append, so identity changes correctly track new events).
  const agentEvents = run?.agentEvents;
  const targetTurns = useMemo(
    () => {
      const haveEvents = Array.isArray(agentEvents) && agentEvents.length > 0;
      return haveEvents ? eventsToTurns(agentEvents) : synthesizeTurns(run, ctx);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run?.id, run?.currentStep, run?.status, run?.pagesFound, run?.testsGenerated, ps, allTests, agentEvents],
  );

  // Displayed turns track render state. New turns enter as `streaming`
  // (renderedText empty); the ticker fills them one char at a time.
  // Handoff turns enter as `done` instantly — the handoff is a beat in
  // the conversation flow, not a thought to type out.
  const [displayed, setDisplayed] = useState([]);
  const streamTimerRef = useRef(null);
  const containerRef = useRef(null);

  // Diff target turns against displayed and (a) append new turns, (b) extend
  // text on already-displayed turns whose target text grew. (b) is the path
  // event-mode takes when a `finding`/`progress` event extends an open
  // `start` turn: same stable ID, longer `text`. Without (b), a finding
  // arriving after the start turn finished streaming would never reach
  // the screen. Synthesizer-mode turns never grow (their text is fixed at
  // synthesis time) so (b) is a no-op for that path.
  //
  // The dependency list intentionally omits `displayed` (stale-closure-safe
  // via the functional updater) — otherwise this effect would fire on every
  // renderedText tick and double-append.
  useEffect(() => {
    setDisplayed(prev => {
      const byId = new Map(prev.map(t => [t.id, t]));
      let mutated = false;
      const next = prev.map(t => {
        const target = targetTurns.find(tt => tt.id === t.id);
        if (!target || target.text === t.text) return t;
        // Target grew. Extend the streaming target while preserving the
        // current `renderedText` cursor position — the streamer effect will
        // catch up to the new length on its next tick. If the turn had
        // already flipped to "done" (its old text fully rendered), revive
        // it back to "streaming" so the new tail types out instead of
        // appearing instantly. Handoff turns don't stream so their text
        // can't grow incrementally; they update in place.
        mutated = true;
        if (t.phase === "handoff") {
          return { ...t, text: target.text, renderedText: target.text };
        }
        const stillStreaming = t.renderedText.length < target.text.length;
        return {
          ...t,
          text: target.text,
          status: stillStreaming ? "streaming" : t.status,
        };
      });
      const additions = targetTurns.filter(t => !byId.has(t.id));
      if (additions.length === 0) return mutated ? next : prev;
      return [
        ...next,
        ...additions.map(t => ({
          ...t,
          status: t.phase === "handoff" ? "done" : "streaming",
          renderedText: t.phase === "handoff" ? t.text : "",
        })),
      ];
    });
  }, [targetTurns]);

  // Streamer — tick the earliest `streaming` turn one character at a time.
  // Only one turn streams at a time; subsequent ones wait their turn. When
  // it reaches the end of the text, flip status to `done` so the cursor
  // hides and the next streaming turn can start ticking.
  useEffect(() => {
    const idx = displayed.findIndex(t => t.status === "streaming");
    if (idx === -1) {
      clearTimeout(streamTimerRef.current);
      return;
    }
    const turn = displayed[idx];
    if (turn.renderedText.length >= turn.text.length) {
      // Stream complete — flip to done. Using a microtask-equivalent setState
      // here (not a setTimeout) so the cursor disappears synchronously with
      // the last character landing — no stale-frame flicker.
      setDisplayed(prev => {
        const next = [...prev];
        if (next[idx]?.status === "streaming") {
          next[idx] = { ...next[idx], status: "done" };
        }
        return next;
      });
      return;
    }
    streamTimerRef.current = setTimeout(() => {
      setDisplayed(prev => {
        const next = [...prev];
        const t = next[idx];
        if (!t || t.status !== "streaming") return prev;
        next[idx] = { ...t, renderedText: t.text.slice(0, t.renderedText.length + 1) };
        return next;
      });
    }, CHAR_MS);
    return () => clearTimeout(streamTimerRef.current);
  }, [displayed]);

  // Auto-scroll on turn append only (not per character). Tracks the displayed
  // length, NOT the streamed text — depending on text would fire scrollTo
  // ~45×/sec during streaming, which is the per-char scroll thrash the old
  // NarrativeFeed had (`TestLab.jsx:776`) and which the spec called out as
  // a bug to avoid here.
  const lastLenRef = useRef(0);
  useEffect(() => {
    if (displayed.length > lastLenRef.current) {
      containerRef.current?.scrollTo({
        top: containerRef.current.scrollHeight,
        behavior: "smooth",
      });
      lastLenRef.current = displayed.length;
    }
  }, [displayed.length]);

  // Reset when the run changes (different run id or null → set). Without this,
  // launching a second run would carry the first run's transcript over.
  // NOTE: `runData` from TestLab has `id` (the DB primary key), NOT `runId`.
  // `runId` only exists on the separate `activeRun` state object. Pre-fix
  // this ref compared `run?.runId` which was always `undefined`, so the
  // transcript never cleared between runs.
  const runIdRef = useRef(run?.id);
  useEffect(() => {
    if (runIdRef.current !== run?.id) {
      runIdRef.current = run?.id;
      setDisplayed([]);
      lastLenRef.current = 0;
      clearTimeout(streamTimerRef.current);
    }
  }, [run?.id]);

  // ── Render ──
  // ARIA contract (per task spec):
  //   - Container: role="log" aria-live="polite" aria-atomic="false"
  //   - Each turn: role="article" with aria-label="{Agent} — {phase}"
  // role="log" is the WAI-ARIA primitive for chronological message streams;
  // aria-live="polite" lets screen readers announce new turns without
  // interrupting the current utterance; aria-atomic="false" so only the
  // delta (the new turn) is announced, not the whole transcript every time.
  return (
    <div
      ref={containerRef}
      className="ac-feed"
      role="log"
      aria-live="polite"
      aria-atomic="false"
      aria-label="AI agent conversation"
    >
      {/* Thinking indicator — shown ONLY when no turns exist yet AND the run
          is still active. Mutually exclusive with per-turn cursors by
          construction: once `displayed.length > 0`, this whole block is
          unreachable, so the bug at the old `TestLab.jsx:884-891` (cursor +
          dots rendering simultaneously on the same frame) cannot recur. */}
      {displayed.length === 0 && isRunActive && (
        <div className="ac-thinking" aria-label="agents initialising">
          <span className="ac-dots" aria-hidden="true"><span /><span /><span /></span>
          <span className="ac-thinking-text">Agents are coming online…</span>
        </div>
      )}

      {displayed.map((turn) => {
        const persona = AGENT_PERSONAS[turn.agent];
        if (!persona) return null;
        const isHandoff = turn.phase === "handoff";
        const isStreaming = turn.status === "streaming";
        const model = run?.modelUsed;

        return (
          <article
            key={turn.id}
            className={`ac-turn ac-turn--${persona.color} ac-turn--${turn.phase}${
              isHandoff ? " ac-turn--handoff" : ""
            }`}
            aria-label={`${persona.label} — ${turn.phase}`}
          >
            <div
              className={`ac-avatar ac-avatar--${persona.color}`}
              aria-hidden="true"
              title={persona.label}
            >
              {persona.icon}
            </div>
            <div className="ac-bubble">
              {!isHandoff && (
                <div className="ac-meta">
                  <span className="ac-agent-label">{persona.label}</span>
                  {model && turn.phase !== "onboard" && (
                    <span className="ac-model">· {model}</span>
                  )}
                </div>
              )}
              <div className="ac-text">
                {isHandoff ? turn.text : turn.renderedText}
                {/* Per-turn streaming cursor. Renders ONLY while this turn
                    is still streaming. Note: thinking dots above are
                    suppressed once any turn exists, so cursor + dots can
                    never overlap (the bug the spec calls out at
                    `TestLab.jsx:884-891`). */}
                {isStreaming && <span className="ac-cursor" aria-hidden="true" />}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
