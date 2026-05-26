import React from "react";

/**
 * ONB-002 (audit) — Shared empty-state primitive.
 *
 * The audit calls out that most empty states in Sentri are plain text
 * descriptions ("No runs yet.", "No savings data yet.") without an icon
 * or actionable CTA — defeating the conversion-surface role an empty
 * state plays at first-run. Every page that needs an empty state should
 * use this component so the icon + title + description + CTA shape is
 * consistent across Tests, Projects, Runs, Healing, and future pages.
 *
 * The component uses the existing `.empty-state*` CSS classes already
 * defined in `frontend/src/styles/components.css` — no new CSS is
 * introduced. The Dashboard's onboarding empty state at
 * `frontend/src/pages/Dashboard.jsx:382-387` is the visual reference.
 *
 * Props:
 *   icon       — Optional ReactNode (typically a lucide-react icon or
 *                emoji span). Rendered above the title. Falls back to
 *                rendering nothing when omitted.
 *   title      — Required ReactNode for the heading line.
 *   description — Optional ReactNode for the body copy below the title.
 *   action     — Optional `{ label, onClick, variant? }` for the primary
 *                CTA. `variant` defaults to `"primary"`; pass `"ghost"`
 *                for a secondary-looking call-to-action.
 *   secondaryAction — Optional second CTA with the same shape; renders
 *                to the left of `action` as a ghost button by default.
 *   hint       — Optional ReactNode rendered above the actions row for
 *                contextual coaching (e.g. "You have 3 draft tests
 *                waiting for review."). Use sparingly — the icon + title
 *                are usually enough.
 *   variant    — `"card"` (default — full bordered card, used inside
 *                a page section) or `"bare"` (no card border, used inside
 *                an existing card / table body).
 */
export default function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  hint,
  variant = "card",
}) {
  const className =
    variant === "card"
      ? "card empty-state"
      : "empty-state";

  return (
    <div className={className}>
      {icon ? <div className="empty-state-icon">{icon}</div> : null}
      {title ? <div className="empty-state-title">{title}</div> : null}
      {description ? <div className="empty-state-desc">{description}</div> : null}
      {hint}
      {(action || secondaryAction) && (
        <div className="empty-state-actions">
          {secondaryAction && (
            <button
              className={`btn btn-${secondaryAction.variant || "ghost"} btn-sm`}
              onClick={secondaryAction.onClick}
            >
              {secondaryAction.label}
            </button>
          )}
          {action && (
            <button
              className={`btn btn-${action.variant || "primary"} btn-sm`}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
