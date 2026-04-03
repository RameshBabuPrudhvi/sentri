import React, { useEffect } from "react";

/**
 * Shared modal shell — renders backdrop + centered panel + Escape-key dismiss.
 *
 * Props:
 *   onClose  — called when backdrop is clicked or Escape is pressed
 *   width    — CSS width for the panel (default "min(440px, 95vw)")
 *   style    — extra inline styles merged onto the panel div
 *   children — modal content
 */
export default function ModalShell({ onClose, width = "min(440px, 95vw)", style, children }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-panel" style={{ width, ...style }}>
        {children}
      </div>
    </>
  );
}
