import React, { useState } from "react";

/**
 * Generic hover tooltip.
 *
 * Usage:
 *   <Tooltip text="Some helpful hint">
 *     <Info size={15} />
 *   </Tooltip>
 */
export default function Tooltip({ text, children }) {
  const [show, setShow] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <span style={{
          position: "absolute", bottom: "calc(100% + 6px)", left: "50%", transform: "translateX(-50%)",
          background: "var(--text)", color: "var(--bg)", fontSize: "0.72rem", padding: "5px 9px",
          borderRadius: 6, zIndex: 999, pointerEvents: "none",
          boxShadow: "var(--shadow-sm)", maxWidth: 260, whiteSpace: "normal", lineHeight: 1.4, textAlign: "center",
        }}>
          {text}
        </span>
      )}
    </span>
  );
}
