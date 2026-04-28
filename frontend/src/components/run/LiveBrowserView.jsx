import { useRef, useEffect, useState, useCallback } from "react";

/**
 * LiveBrowserView
 *
 * Renders CDP screencast frames (base64 JPEG) onto a <canvas> element.
 * Uses a requestAnimationFrame-throttled paint loop so burst frames from
 * the SSE channel don't overwhelm the GPU.
 *
 * When `onInput` is provided the canvas becomes interactive: pointer events
 * (click, mousedown, mouseup, mousemove, wheel) and keyboard events are
 * captured, scaled from CSS pixels to the browser viewport coordinate space,
 * and forwarded to the server via `onInput(event)`. This is what makes the
 * recorder actually work — without forwarding, the canvas is read-only.
 *
 * Props:
 *   frames      — array, we only use frames[0] (latest frame).
 *   fallback    — ReactNode to render when no frames have arrived yet.
 *   label       — optional string shown in the corner overlay.
 *   onInput     — optional (event: Object) => void  — when provided the
 *                 canvas captures pointer+keyboard events and calls this
 *                 with CDP-shaped event objects. The parent is responsible
 *                 for forwarding to the server.
 *   viewportW   — server-side browser viewport width (default 1280).
 *   viewportH   — server-side browser viewport height (default 720).
 */
export default function LiveBrowserView({
  frames = [],
  fallback = null,
  label = "",
  onInput = null,
  viewportW = 1280,
  viewportH = 720,
}) {
  const canvasRef = useRef(null);
  const pendingRef = useRef(null); // latest base64 not yet painted
  const rafRef = useRef(null);
  const [hasFrames, setHasFrames] = useState(false);
  // Track pressed keys so we can emit keyUp on blur (prevents stuck keys)
  const pressedKeys = useRef(new Set());

  // ── Paint loop ────────────────────────────────────────────────────────────
  useEffect(() => {
    const frame = frames[0];
    if (!frame) return;

    setHasFrames(true);
    pendingRef.current = frame;

    if (rafRef.current) return;
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

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  // ── Coordinate scaling ────────────────────────────────────────────────────
  // The canvas CSS size differs from the logical viewport size on the server.
  // We must scale pointer coordinates so a click at CSS position (x,y) maps
  // to the correct pixel in the 1280×720 (or configured) headless browser.
  const scaleCoords = useCallback((cssX, cssY) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (cssX - rect.left) * (viewportW / rect.width),
      y: (cssY - rect.top) * (viewportH / rect.height),
    };
  }, [viewportW, viewportH]);

  // ── Modifier bitmask ──────────────────────────────────────────────────────
  // CDP modifiers: Alt=1, Ctrl=2, Meta=4, Shift=8
  const modifiers = useCallback((e) => (
    (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
  ), []);

  // ── Pointer handlers ──────────────────────────────────────────────────────
  const handleMouseDown = useCallback((e) => {
    if (!onInput) return;
    e.preventDefault();
    canvasRef.current?.focus();
    const { x, y } = scaleCoords(e.clientX, e.clientY);
    onInput({ type: "mousePressed", x, y, button: e.button, clickCount: 1, modifiers: modifiers(e) });
  }, [onInput, scaleCoords, modifiers]);

  const handleMouseUp = useCallback((e) => {
    if (!onInput) return;
    e.preventDefault();
    const { x, y } = scaleCoords(e.clientX, e.clientY);
    onInput({ type: "mouseReleased", x, y, button: e.button, clickCount: 1, modifiers: modifiers(e) });
  }, [onInput, scaleCoords, modifiers]);

  const handleMouseMove = useCallback((e) => {
    if (!onInput) return;
    const { x, y } = scaleCoords(e.clientX, e.clientY);
    // Only include `button` when a button is actually held — otherwise the
    // backend must dispatch CDP button "none" so an idle hover isn't
    // interpreted as a held left-click drag.
    const evt = { type: "mouseMoved", x, y, modifiers: modifiers(e) };
    if (e.buttons > 0) evt.button = e.button;
    onInput(evt);
  }, [onInput, scaleCoords, modifiers]);

  const handleWheel = useCallback((e) => {
    if (!onInput) return;
    e.preventDefault();
    const { x, y } = scaleCoords(e.clientX, e.clientY);
    onInput({ type: "scroll", x, y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiers(e) });
  }, [onInput, scaleCoords, modifiers]);

  // ── Keyboard handlers ─────────────────────────────────────────────────────
  const handleKeyDown = useCallback((e) => {
    if (!onInput) return;
    e.preventDefault(); // prevent browser shortcuts (Ctrl+W, etc.)
    pressedKeys.current.add(e.key);
    onInput({ type: "keyDown", key: e.key, code: e.code, text: e.key.length === 1 ? e.key : "", modifiers: modifiers(e) });
    // For printable characters also send a char event so the page receives text input
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      onInput({ type: "char", text: e.key, modifiers: modifiers(e) });
    }
  }, [onInput, modifiers]);

  const handleKeyUp = useCallback((e) => {
    if (!onInput) return;
    e.preventDefault();
    pressedKeys.current.delete(e.key);
    onInput({ type: "keyUp", key: e.key, code: e.code, modifiers: modifiers(e) });
  }, [onInput, modifiers]);

  // Release all held keys when the canvas loses focus so we never get stuck keys
  const handleBlur = useCallback(() => {
    if (!onInput) return;
    for (const key of pressedKeys.current) {
      onInput({ type: "keyUp", key, code: "", modifiers: 0 });
    }
    pressedKeys.current.clear();
  }, [onInput]);

  // ── Render ────────────────────────────────────────────────────────────────
  const isInteractive = Boolean(onInput);

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
        tabIndex={isInteractive ? 0 : undefined}
        style={{
          width: "100%", height: "100%", objectFit: "contain", display: "block",
          cursor: isInteractive ? "crosshair" : "default",
          outline: "none", // hide focus ring on canvas; we show our own indicator
        }}
        // Pointer events
        onMouseDown={isInteractive ? handleMouseDown : undefined}
        onMouseUp={isInteractive ? handleMouseUp : undefined}
        onMouseMove={isInteractive ? handleMouseMove : undefined}
        onWheel={isInteractive ? handleWheel : undefined}
        // Keyboard events — canvas must be focusable (tabIndex=0) to receive these
        onKeyDown={isInteractive ? handleKeyDown : undefined}
        onKeyUp={isInteractive ? handleKeyUp : undefined}
        onBlur={isInteractive ? handleBlur : undefined}
        // Prevent context menu from stealing right-click events
        onContextMenu={isInteractive ? (e) => e.preventDefault() : undefined}
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
      {/* Interactive mode hint — shown briefly when canvas gains focus */}
      {isInteractive && (
        <div style={{
          position: "absolute", bottom: 8, left: "50%", transform: "translateX(-50%)",
          background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
          borderRadius: 6, padding: "3px 10px",
          fontSize: "0.65rem", color: "rgba(255,255,255,0.7)",
          pointerEvents: "none", whiteSpace: "nowrap",
        }}>
          Click inside to interact · scroll to scroll · type to type
        </div>
      )}
    </div>
  );
}
