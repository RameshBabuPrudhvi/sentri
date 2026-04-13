import { useRef, useEffect, useState } from "react";

/**
 * LiveBrowserView
 *
 * Renders CDP screencast frames (base64 JPEG) onto a <canvas> element.
 * Uses a requestAnimationFrame-throttled paint loop so burst frames from
 * the SSE channel don't overwhelm the GPU.
 *
 * Props:
 *   frames      — array, we only use frames[0] (latest frame).
 *                 Keeping it as an array lets the parent just call setFrames([data]).
 *   fallback    — ReactNode to render when no frames have arrived yet
 *   label       — optional string shown in the corner overlay
 */
export default function LiveBrowserView({ frames = [], fallback = null, label = "" }) {
  const canvasRef = useRef(null);
  const pendingRef = useRef(null); // latest base64 not yet painted
  const rafRef = useRef(null);
  const [hasFrames, setHasFrames] = useState(false);

  // Queue the latest frame; paint via rAF so we never paint faster than display refresh
  useEffect(() => {
    const frame = frames[0];
    if (!frame) return;

    setHasFrames(true);
    pendingRef.current = frame;

    if (rafRef.current) return; // paint already scheduled
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const data = pendingRef.current;
      pendingRef.current = null;
      if (!data || !canvasRef.current) return;

      const img = new Image();
      img.onload = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        if (canvas.width !== img.naturalWidth) canvas.width = img.naturalWidth;
        if (canvas.height !== img.naturalHeight) canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
      };
      img.src = `data:image/jpeg;base64,${data}`;
    });
  }, [frames]);

  // Cleanup pending rAF on unmount
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  if (!hasFrames) {
    return fallback ?? (
      <div style={{
        aspectRatio: "16/9", width: "100%", background: "#0a0a0f",
        borderRadius: 8, display: "flex", alignItems: "center",
        justifyContent: "center", flexDirection: "column", gap: 10,
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: "50%",
          border: "3px solid #1e40af", borderTopColor: "transparent",
          animation: "spin 0.9s linear infinite",
        }} />
        <div style={{ fontSize: "0.75rem", color: "#475569" }}>
          Waiting for browser stream…
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", borderRadius: 8, overflow: "hidden", background: "#000", aspectRatio: "16/9", width: "100%" }}>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
      />
      {/* Live indicator badge */}
      <div style={{
        position: "absolute", top: 8, left: 8,
        display: "flex", alignItems: "center", gap: 5,
        background: "rgba(0,0,0,0.65)", backdropFilter: "blur(4px)",
        borderRadius: 99, padding: "3px 9px",
      }}>
        <div style={{
          width: 7, height: 7, borderRadius: "50%", background: "#ef4444",
          animation: "pulse 1.4s ease-in-out infinite",
          boxShadow: "0 0 6px #ef4444",
        }} />
        <span style={{ fontSize: "0.65rem", fontWeight: 700, color: "#fff", letterSpacing: "0.06em" }}>
          LIVE
        </span>
        {label && (
          <span style={{ fontSize: "0.63rem", color: "rgba(255,255,255,0.6)", marginLeft: 2 }}>
            {label}
          </span>
        )}
      </div>
    </div>
  );
}
