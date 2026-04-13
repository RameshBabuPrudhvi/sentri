/**
 * HealingTimeline
 *
 * Visualises the self-healing selector fallback chain for a test result.
 * Renders strategies in order: css → xpath → text → role
 *
 * Props:
 *   events — array of healing event objects from result.healingEvents[]
 *            Each has: { strategy, durationMs, failed, success, key, strategyIndex }
 */

// The canonical order strategies are tried in
const STRATEGY_ORDER = ["css", "xpath", "text", "role"];

// Human-readable labels
const STRATEGY_LABELS = {
  css:   "CSS",
  xpath: "XPath",
  text:  "Text",
  role:  "Role",
};

export default function HealingTimeline({ events = [] }) {
  if (!events.length) return null;

  // Find the winning strategy — the one that succeeded (not failed)
  const winner = events.find(e => !e.failed);

  // Count total attempts
  const totalAttempts = events.length;
  const healed = !!winner && winner.strategy !== events[0]?.strategy;

  return (
    <div style={{ marginTop: 8, padding: "8px 10px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 7 }}>
        <span style={{ fontSize: "0.65rem", fontWeight: 700, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          🔧 Self-healing trace
        </span>
        {healed && (
          <span style={{ fontSize: "0.63rem", fontWeight: 600, color: "var(--green)", background: "var(--green-bg)", padding: "1px 6px", borderRadius: 99, border: "1px solid var(--green)" }}>
            healed
          </span>
        )}
        <span style={{ marginLeft: "auto", fontSize: "0.63rem", color: "var(--text3)", fontFamily: "var(--font-mono)" }}>
          {totalAttempts} attempt{totalAttempts !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Strategy pills */}
      <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
        {STRATEGY_ORDER.map((strat, idx) => {
          const evt = events.find(e => e.strategy === strat);
          if (!evt) return null;

          const isWinner  = winner?.strategy === strat;
          const isFailed  = !!evt.failed;
          const isSkipped = false;

          const bg     = isWinner ? "var(--green-bg)"  : isFailed ? "var(--red-bg)"  : "var(--bg3)";
          const color  = isWinner ? "var(--green)"     : isFailed ? "var(--red)"     : "var(--text3)";
          const border = isWinner ? "var(--green)"     : isFailed ? "#fca5a5"        : "var(--border)";

          return (
            <div key={strat} style={{ display: "flex", alignItems: "center", gap: 3 }}>
              {/* Arrow connector after first pill */}
              {idx > 0 && events.find(e => e.strategy === STRATEGY_ORDER[idx - 1]) && (
                <span style={{ fontSize: "0.65rem", color: "var(--text3)", flexShrink: 0 }}>→</span>
              )}

              <div
                title={`${STRATEGY_LABELS[strat]}: ${isFailed ? "failed" : "succeeded"}${evt.durationMs ? ` in ${evt.durationMs}ms` : ""}`}
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  padding: "3px 8px", borderRadius: 6,
                  fontSize: "0.68rem", fontFamily: "var(--font-mono)",
                  fontWeight: isWinner ? 700 : 400,
                  background: bg, color, border: `1px solid ${border}`,
                  transition: "all 0.12s",
                }}
              >
                {/* Status dot */}
                <span style={{
                  width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                  background: isWinner ? "var(--green)" : isFailed ? "var(--red)" : "var(--text3)",
                }} />

                {STRATEGY_LABELS[strat]}

                {/* Duration badge */}
                {evt.durationMs != null && (
                  <span style={{ opacity: 0.7, fontSize: "0.6rem" }}>
                    {evt.durationMs}ms
                  </span>
                )}

                {/* Winner crown */}
                {isWinner && <span style={{ fontSize: "0.65rem" }}>✓</span>}
              </div>
            </div>
          );
        })}

        {/* Fallback: show any strategies not in STRATEGY_ORDER */}
        {events
          .filter(e => !STRATEGY_ORDER.includes(e.strategy))
          .map((evt, i) => (
            <div key={`extra-${i}`} style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ fontSize: "0.65rem", color: "var(--text3)" }}>→</span>
              <div style={{
                padding: "3px 8px", borderRadius: 6,
                fontSize: "0.68rem", fontFamily: "var(--font-mono)",
                background: evt.failed ? "var(--red-bg)" : "var(--green-bg)",
                color: evt.failed ? "var(--red)" : "var(--green)",
                border: `1px solid ${evt.failed ? "#fca5a5" : "var(--green)"}`,
              }}>
                {evt.strategy}
              </div>
            </div>
          ))
        }
      </div>
    </div>
  );
}
