import React, { useEffect, useRef, useState } from "react";

/**
 * Shared quality-score primitives (AI-001, audit). Centralises the
 * confidence-score colour ramp + factor-breakdown popover + plain-English
 * tier explainer so every surface that shows `qualityScore` uses the same
 * mental model.
 *
 * Surfaces today:
 *   - `QualityScoreChip` — used in ReviewQueue list rows + detail sidebar
 *     (extracted from `pages/ReviewQueue.jsx`).
 *   - `QualityScoreExplainer` — short tier line ("≥75 safe to auto-approve")
 *     used on TestDetail and anywhere a reviewer needs the mental model
 *     without taking the click hit of opening the popover.
 *   - `qualityColor()` — the colour-ramp helper, exported for callers that
 *     render their own value-driven UI (e.g. the AUTO-003b auto-approval
 *     tray in ReviewQueue).
 *   - `qualityTier()` — returns the tier label + threshold band so callers
 *     can render their own tier-aware UI without reimplementing the
 *     thresholds.
 *
 * Thresholds (matching the audit's recommended copy + the existing
 * `qualityColor` ramp in `pages/ReviewQueue.jsx`):
 *   ≥ 75 → "high"   — green, safe to auto-approve
 *   ≥ 50 → "medium" — amber, review-worthy
 *   <  50 → "low"   — red, missing assertions or unreliable selectors
 */

const TIERS = [
  {
    min: 75,
    key: "high",
    label: "High quality",
    copy: "Scores above 75 are typically safe to auto-approve.",
  },
  {
    min: 50,
    key: "medium",
    label: "Review recommended",
    copy: "Scores 50–74 are review-worthy — check assertions and selectors before approving.",
  },
  {
    min: 0,
    key: "low",
    label: "Likely needs work",
    copy: "Scores below 50 usually indicate missing assertions or unreliable selectors.",
  },
];

/** Modifier class fragment for the score's tier — used by callers that
 *  apply tier-aware colours through CSS instead of inline `style={{}}`.
 *  Returns `"unknown"` for null / undefined / non-numeric so the consuming
 *  CSS can paint a neutral state. */
export function qualityTierKey(score) {
  if (typeof score !== "number" || Number.isNaN(score)) return "unknown";
  return qualityTier(score).key;
}

/**
 * Resolve a score to its tier definition. Useful for callers that want the
 * label + copy together (e.g. `<QualityScoreExplainer>`).
 * Out-of-range values clamp into the appropriate tier — `200` is still
 * "high", `-1` is still "low".
 *
 * @param {number} score
 * @returns {{key: string, label: string, copy: string}}
 */
export function qualityTier(score) {
  const n = typeof score === "number" && !Number.isNaN(score) ? score : 0;
  return TIERS.find((t) => n >= t.min) || TIERS[TIERS.length - 1];
}

/**
 * Click-to-expand chip: circular progress arc + score number + caret. The
 * popover surfaces the factor breakdown (`qualityScoreFactors`) so reviewers
 * can audit *why* the AI assigned this score without reading the test code.
 *
 * Extracted from `pages/ReviewQueue.jsx`. Class names retain the `.rq-*`
 * prefix because the CSS lives in `styles/pages/review-queue.css` and other
 * call sites (TestDetail) don't yet need the popover styles — they can
 * always re-use these classes without importing the page stylesheet
 * because the rules are unconditional (no `.rq-page` parent selector).
 *
 * @param {Object} props
 * @param {number|null} props.score
 * @param {Array<{id: string, kind: "reward"|"penalty", label: string, delta: number}>} [props.factors]
 * @returns {JSX.Element|null}
 */
export function QualityScoreChip({ score, factors }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function h(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  if (score == null) return null;
  const hasFactors = Array.isArray(factors) && factors.length > 0;
  const tierKey = qualityTierKey(score);
  // Continuous arc length — the only value-driven property left on the SVG.
  // Tier colour comes from the `.quality-chip--<tier>` class via
  // `currentColor` (button) and `.quality-chip__ring` (stroke inherits).
  const arcLen = (Math.max(0, Math.min(100, score)) / 100) * (2 * Math.PI * 9);

  return (
    <div className="rq-quality-chip-wrap quality-chip-wrap" ref={wrapRef}>
      <button
        className={`rq-quality-chip quality-chip quality-chip--${tierKey}`}
        onClick={() => hasFactors && setOpen((v) => !v)}
        disabled={!hasFactors}
        title={hasFactors ? "Why this score?" : "No factor breakdown available"}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Quality score ${score} out of 100`}
      >
        {/* Circular progress arc — replaces the "Q:72" prefix with a
            visual ring (Sonar-style). The score sits in the centre as a
            bare number; the ring's filled arc encodes the value. The
            stroke uses `currentColor` so the tier modifier class on the
            button sets both text and arc colour through CSS. */}
        <svg
          className="rq-quality-chip__ring quality-chip__ring"
          width="22"
          height="22"
          viewBox="0 0 22 22"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="9" fill="none" className="quality-chip__ring-track" strokeWidth="2" />
          <circle
            cx="11" cy="11" r="9"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${arcLen} ${2 * Math.PI * 9}`}
            transform="rotate(-90 11 11)"
          />
        </svg>
        <span className="rq-quality-chip__score">{score}</span>
        {hasFactors && <span className="rq-quality-chip__caret" aria-hidden="true">▾</span>}
      </button>
      {open && hasFactors && (
        <div className="rq-quality-popover" role="dialog" aria-label="Quality score breakdown">
          <div className="rq-quality-popover__header">
            Quality {score} / 100 — {qualityTier(score).label}
          </div>
          {/* AI-001 (audit): plain-English tier copy at the top of the
              popover so reviewers see WHY this score matters before
              scanning the factor list. The copy is keyed off the same
              tier thresholds as the colour ramp, so green / amber / red
              always agree on the message. */}
          <div className="rq-quality-popover__tier-copy">
            {qualityTier(score).copy}
          </div>
          <ul className="rq-quality-popover__list">
            {factors.map((f) => (
              <li key={f.id} className={`rq-quality-popover__item rq-quality-popover__item--${f.kind}`}>
                <span className="rq-quality-popover__icon" aria-hidden="true">
                  {f.kind === "reward" ? "✓" : "✗"}
                </span>
                <span className="rq-quality-popover__label">{f.label}</span>
                <span className="rq-quality-popover__delta">
                  {f.delta > 0 ? `+${f.delta}` : f.delta} pts
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Inline one-liner that translates a numeric score into a plain-English
 * tier ("Scores above 75 are typically safe to auto-approve."). Used on
 * surfaces where the click-to-expand chip would be overkill — TestDetail
 * shows this directly under the quality bar in the sidebar.
 *
 * Renders nothing when `score` is null/undefined so callers can drop it
 * in unconditionally next to the bar.
 *
 * @param {Object} props
 * @param {number|null} props.score
 * @returns {JSX.Element|null}
 */
export function QualityScoreExplainer({ score }) {
  if (typeof score !== "number" || Number.isNaN(score)) return null;
  const tier = qualityTier(score);
  return (
    <div
      className={`quality-explainer quality-explainer--${tier.key}`}
      role="note"
    >
      {tier.copy}
    </div>
  );
}

export default QualityScoreChip;
