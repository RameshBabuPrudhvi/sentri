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
 * ### Synthesized vs. real-event modes
 *
 * **Today (synthesized)** — turns are derived client-side from
 * `runData.currentStep` + `runData.pipelineStats` + `getStageAgentRoles`.
 * Wording is templated below. No backend changes required.
 *
 * **Future (Task 2 follow-up)** — once `runData.agentEvents` lands via the
 * SSE `agent_event` stream (already plumbed by Task 2, see migration 057),
 * the synthesizer below will be swapped for a thin adapter that maps SSE
 * events to turns. External API (props, role contract, ARIA contract) is
 * unchanged so the swap is a one-file refactor.
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
} from "./agentConversationSynth.js";

// Re-exports so the test file (and any future consumer) can import these
// directly from `AgentConversation` if it prefers — single canonical
// component entry point.
export { getStepAgentSequence, TURN_TEMPLATES, synthesizeTurns };



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
  const targetTurns = useMemo(
    () => synthesizeTurns(run, ctx),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run?.runId, run?.currentStep, run?.status, run?.pagesFound, run?.testsGenerated, ps, allTests],
  );

  // Displayed turns track render state. New turns enter as `streaming`
  // (renderedText empty); the ticker fills them one char at a time.
  // Handoff turns enter as `done` instantly — the handoff is a beat in
  // the conversation flow, not a thought to type out.
  const [displayed, setDisplayed] = useState([]);
  const streamTimerRef = useRef(null);
  const containerRef = useRef(null);

  // Diff synthesizer output against displayed turns and append new ones.
  // The dependency list intentionally omits `displayed` (stale-closure-safe
  // because we use the functional updater) — otherwise this effect would
  // fire on every renderedText tick and double-append.
  useEffect(() => {
    setDisplayed(prev => {
      const have = new Set(prev.map(t => t.id));
      const additions = targetTurns.filter(t => !have.has(t.id));
      if (additions.length === 0) return prev;
      return [
        ...prev,
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

  // Reset when the run changes (different runId or null → set). Without this,
  // launching a second run would carry the first run's transcript over.
  const runIdRef = useRef(run?.runId);
  useEffect(() => {
    if (runIdRef.current !== run?.runId) {
      runIdRef.current = run?.runId;
      setDisplayed([]);
      lastLenRef.current = 0;
      clearTimeout(streamTimerRef.current);
    }
  }, [run?.runId]);

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
