import React from "react";
import { severityColor } from "../../utils/a11y.js";

const MAX_NODES_PER_VIOLATION = 6;

/**
 * Renders a single axe-core violation as a collapsible row showing the
 * severity badge, rule id, optional WCAG criterion, and the first few
 * offending DOM node selectors.
 */
function ViolationItem({ violation }) {
  const color = severityColor(violation.impact);
  const nodes = Array.isArray(violation.nodes) ? violation.nodes : [];
  return (
    <details style={{ background: "var(--surface)", borderRadius: 6, padding: "6px 8px" }}>
      <summary style={{ cursor: "pointer", display: "flex", gap: 8, alignItems: "center", listStyle: "none" }}>
        <span className="badge" style={{ fontSize: "0.6rem", color, borderColor: color }}>
          {(violation.impact || "unknown").toUpperCase()}
        </span>
        <span style={{ fontSize: "0.68rem", color: "var(--text2)", flex: 1 }}>
          {violation.ruleId || "Unknown rule"}
        </span>
        {violation.wcagCriterion && (
          <span style={{ fontSize: "0.62rem", color: "var(--text3)", fontFamily: "var(--font-mono)" }}>
            WCAG {violation.wcagCriterion}
          </span>
        )}
      </summary>
      <div style={{ marginTop: 6, fontSize: "0.65rem", color: "var(--text3)", display: "flex", flexDirection: "column", gap: 4 }}>
        {nodes.slice(0, MAX_NODES_PER_VIOLATION).map((node, ni) => (
          <div key={`${ni}-${node?.target?.[0] || "node"}`} style={{ fontFamily: "var(--font-mono)", overflowX: "auto", whiteSpace: "nowrap" }}>
            {node?.target?.join(", ") || "Unknown node"}
          </div>
        ))}
      </div>
    </details>
  );
}

/**
 * Per-page accessibility violations panel for the crawl view.
 * Renders nothing when the violation list is empty.
 *
 * @param {{ violations?: Array<Object> }} props
 */
export default function AccessibilityViolationsPanel({ violations }) {
  const list = Array.isArray(violations) ? violations : [];
  if (list.length === 0) return null;

  return (
    <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
      <div style={{ fontSize: "0.68rem", fontWeight: 700, marginBottom: 8 }}>
        Accessibility violations ({list.length})
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {list.map((v, i) => (
          <ViolationItem key={`${v.ruleId || "rule"}-${i}`} violation={v} />
        ))}
      </div>
    </div>
  );
}
