import { useRef, useEffect } from "react";

/**
 * OverlayCanvas
 *
 * Renders a base64 PNG screenshot onto a <canvas> and draws coloured
 * bounding boxes over it to show which DOM elements were targeted.
 *
 * Props:
 *   base64   — base64-encoded PNG string (no data URI prefix needed)
 *   boxes    — array of { x, y, width, height } objects
 *   status   — "passed" | "failed" | anything else → blue
 *   style    — optional extra styles for the wrapper
 */
export default function OverlayCanvas({ base64, boxes = [], status, style }) {
  const canvasRef = useRef(null);

  const color =
    status === "failed"  ? "#E24B4A" :
    status === "passed"  ? "#639922" :
    status === "warning" ? "#d97706" : "#3b82f6";

  useEffect(() => {
    if (!base64 || !canvasRef.current) return;

    const img = new Image();
    img.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);

      if (boxes.length > 0) {
        ctx.strokeStyle = color;
        ctx.lineWidth   = Math.max(2, Math.round(img.naturalWidth / 640)); // scale with resolution
        ctx.fillStyle   = color + "26"; // 15% opacity fill

        for (const { x, y, width, height } of boxes) {
          if (width > 0 && height > 0) {
            ctx.strokeRect(x, y, width, height);
            ctx.fillRect(x, y, width, height);

            // Draw a small label chip above the box when it fits
            const label = status === "failed" ? "✗ failed" : "✓ target";
            const chipH = 16;
            const chipY = y - chipH - 2 < 0 ? y + 2 : y - chipH - 2;
            ctx.fillStyle   = color;
            ctx.fillRect(x, chipY, Math.min(width, 70), chipH);
            ctx.fillStyle   = "#fff";
            ctx.font        = `bold ${chipH - 4}px system-ui, sans-serif`;
            ctx.fillText(label, x + 4, chipY + chipH - 4);
            // Reset fill for next box
            ctx.fillStyle = color + "26";
          }
        }
      }
    };
    img.src = `data:image/png;base64,${base64}`;
  }, [base64, boxes, color]);

  if (!base64) return null;

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", borderRadius: 6, display: "block", ...style }}
    />
  );
}
