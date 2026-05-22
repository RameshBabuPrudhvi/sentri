import React, { useEffect, useRef } from "react";

/**
 * Shared modal shell — renders backdrop + centered panel + Escape-key dismiss
 * + focus trap (A11Y-002, audit) per WAI-ARIA APG dialog guidance.
 *
 * Props:
 *   onClose         — called when backdrop is clicked or Escape is pressed
 *   width           — CSS width for the panel (default "min(440px, 95vw)")
 *   style           — extra inline styles merged onto the panel div
 *   ariaLabel       — accessible name (used for `aria-label` on the dialog)
 *   ariaLabelledBy  — id of an element labelling the dialog (preferred over
 *                     ariaLabel when a heading already exists in `children`)
 *   children        — modal content
 *
 * A11Y-002 (audit): WCAG 2.1.2 — focus moves into the modal on open, Tab /
 * Shift+Tab wrap around the focusable set, and focus returns to the
 * previously-focused element on close. Selector mirrors the trap in
 * `pages/Login.jsx` so the behaviour is consistent across overlays.
 */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function ModalShell({
  onClose,
  width = "min(440px, 95vw)",
  scrollable = false,
  style,
  ariaLabel,
  ariaLabelledBy,
  children,
}) {
  const panelRef = useRef(null);
  const lastFocusedRef = useRef(null);

  // Focus trap + Escape handling. One effect for both so the keydown
  // listener and the focus-restore teardown share a single lifecycle.
  useEffect(() => {
    // Remember whatever the user was focused on before the modal opened so
    // we can return them there on close (WAI-ARIA APG dialog pattern).
    lastFocusedRef.current = document.activeElement;

    // Move focus into the panel on mount. We pick the first focusable
    // element rather than the panel itself so screen readers immediately
    // land on something actionable. Fall back to the panel container
    // (with a synthetic tabindex) when no focusable child exists.
    const panel = panelRef.current;
    if (panel) {
      const focusables = panel.querySelectorAll(FOCUSABLE_SELECTOR);
      if (focusables.length > 0) {
        focusables[0].focus();
      } else {
        panel.setAttribute("tabindex", "-1");
        panel.focus();
      }
    }

    function onKey(e) {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab") return;
      // Re-query on every Tab — focusables can change while the modal is
      // open (e.g. a button becoming enabled after async validation).
      const focusables = panelRef.current?.querySelectorAll(FOCUSABLE_SELECTOR);
      if (!focusables || focusables.length === 0) {
        // No focusables — keep focus inside the panel itself.
        e.preventDefault();
        panelRef.current?.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      // Treat focus outside the panel (e.g. dropped onto <body>) as
      // "before first" so Tab cycles back into the modal cleanly.
      const active = document.activeElement;
      const inPanel = panelRef.current?.contains(active);
      if (!inPanel) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Restore focus on close — wrapped in try/catch since the node may
      // have been unmounted (e.g. modal opened from a now-deleted row).
      try { lastFocusedRef.current?.focus?.(); } catch { /* node gone */ }
    };
  }, [onClose]);

  const cls = scrollable ? "modal-panel modal-panel-scrollable" : "modal-panel";

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div
        ref={panelRef}
        className={cls}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabelledBy ? undefined : (ariaLabel || "Dialog")}
        aria-labelledby={ariaLabelledBy || undefined}
        style={{ width, ...style }}
      >
        {children}
      </div>
    </>
  );
}
