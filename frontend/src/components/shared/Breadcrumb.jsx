import React from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";

/**
 * NAV-002 (audit) — Semantic breadcrumb trail for deep pages.
 *
 * Replaces the `navigate(-1)` "Back" arrow + ad-hoc inline breadcrumbs that
 * previously lived on RunDetail and TestDetail. Browser history's `-1` step
 * is unreliable when a user arrives via notification link, bookmark, or
 * deep-link — the back arrow lands wherever they came from instead of the
 * logical parent. This component renders the actual entity chain
 * (Dashboard › Projects › {Project} › Runs › Run #abc) using `<Link to>`
 * for every trail item, so each segment is bookmarkable, middle-clickable
 * for new-tab, and screen-reader-announceable.
 *
 * ### Accessibility
 *
 * Wraps the trail in a `<nav aria-label="Breadcrumb">` and renders items
 * inside an ordered list per the WAI-ARIA APG breadcrumb pattern. The last
 * item carries `aria-current="page"` and is rendered as a non-link `<span>`
 * — it's the current page, you can't navigate to where you are.
 * Separators are decorative-only (`aria-hidden="true"`).
 *
 * ### Props
 *
 * @param {Object}   props
 * @param {Array<{label: string, to?: string|null}>} props.items
 *   Trail items in order. Last item is always rendered as the
 *   current-page text regardless of whether `to` is set — callers can
 *   pass `to` on every item without special-casing the last one.
 */
export default function Breadcrumb({ items }) {
  if (!Array.isArray(items) || items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className="breadcrumb">
      <ol className="breadcrumb__list">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li key={i} className="breadcrumb__item">
              {isLast || !item.to ? (
                <span
                  className="breadcrumb__current"
                  aria-current={isLast ? "page" : undefined}
                >
                  {item.label}
                </span>
              ) : (
                <Link className="breadcrumb__link" to={item.to}>
                  {item.label}
                </Link>
              )}
              {!isLast && (
                <ChevronRight
                  size={12}
                  className="breadcrumb__sep"
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
