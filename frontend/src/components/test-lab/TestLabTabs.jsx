/**
 * @module components/test-lab/TestLabTabs
 * @description Test Lab topbar tablist — Crawl & Generate / Generate from
 * Requirement / Queue.
 *
 * Extracted from `frontend/src/pages/TestLab.jsx` (the ~60-line inline IIFE
 * at the old `:1408-1463`) so the WAI-ARIA APG tablist wiring lives in one
 * place instead of bloating the already 2500-line TestLab page. AGENTS.md §40
 * forbids defining helpers mid-component file; the inline IIFE was the
 * functional equivalent of that anti-pattern.
 *
 * ### ARIA contract (WAI-ARIA APG tablist pattern)
 *
 *   - Each `<button>` is `role="tab"` + `aria-selected={active}` +
 *     `aria-controls="tl-tab-panel-<name>"`.
 *   - Roving `tabIndex` (0 on the active tab, -1 elsewhere) so Tab moves
 *     focus past the tablist as one stop.
 *   - ←/→ cycle through the three tabs with `preventDefault` so the browser
 *     doesn't scroll. End/Home are intentionally NOT bound here — keeping
 *     the keymap minimal until a real user request lands.
 *
 * The parent `.tl-topbar` already serves as the tablist surface (it holds
 * the brand cluster + tabs + Record button as flex peers), so this
 * component renders the three tabs as a fragment rather than wrapping them
 * in a `<div role="tablist">`. Promoting the topbar itself to `role="tablist"`
 * would misrepresent the non-tab children (brand cluster, Record button)
 * to AT — see the long comment block at the old extraction site.
 */

import React from "react";
import { Link2, Zap } from "lucide-react";

const TABS = ["crawl", "requirement", "queue"];

/**
 * @param {Object} props
 * @param {"crawl"|"requirement"|"queue"} props.tab
 * @param {(t: string) => void} props.onChange
 * @param {number} [props.activeQueueCount=0] - Count rendered as a badge on
 *   the Queue tab; suppressed when 0.
 */
export default function TestLabTabs({ tab, onChange, activeQueueCount = 0 }) {
  function onKeyDown(e) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = TABS.indexOf(tab);
    const next = e.key === "ArrowRight"
      ? TABS[(i + 1) % TABS.length]
      : TABS[(i - 1 + TABS.length) % TABS.length];
    onChange(next);
  }

  return (
    <>
      <button
        role="tab"
        aria-selected={tab === "crawl"}
        aria-controls="tl-tab-panel-crawl"
        tabIndex={tab === "crawl" ? 0 : -1}
        className={`tl-tab-btn${tab === "crawl" ? " tl-tab-btn--active" : ""}`}
        onClick={() => onChange("crawl")}
        onKeyDown={onKeyDown}
      >
        <Link2 size={14} />
        Crawl &amp; Generate
      </button>
      <button
        role="tab"
        aria-selected={tab === "requirement"}
        aria-controls="tl-tab-panel-requirement"
        tabIndex={tab === "requirement" ? 0 : -1}
        className={`tl-tab-btn${tab === "requirement" ? " tl-tab-btn--active" : ""}`}
        onClick={() => onChange("requirement")}
        onKeyDown={onKeyDown}
      >
        <Zap size={14} />
        Generate from Requirement
      </button>
      <button
        role="tab"
        aria-selected={tab === "queue"}
        aria-controls="tl-tab-panel-queue"
        tabIndex={tab === "queue" ? 0 : -1}
        className={`tl-tab-btn${tab === "queue" ? " tl-tab-btn--active" : ""}`}
        onClick={() => onChange("queue")}
        onKeyDown={onKeyDown}
      >
        Queue
        {activeQueueCount > 0 && (
          <span className="tl-tab-badge" aria-label={`${activeQueueCount} active`}>
            {activeQueueCount}
          </span>
        )}
      </button>
    </>
  );
}
