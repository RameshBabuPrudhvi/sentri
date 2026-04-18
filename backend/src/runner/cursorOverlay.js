/**
 * @module runner/cursorOverlay
 * @description DIF-014 — Cursor overlay for live browser view.
 *
 * Injects an animated cursor dot, click ripple, and keystroke toast into the
 * page via `page.evaluate()`. The overlay is purely visual — it does not
 * interfere with test execution or DOM assertions.
 *
 * Ported from the Assrt `CURSOR_INJECT_SCRIPT` pattern referenced in the
 * roadmap (DIF-014).
 *
 * The script is re-injected after each navigation (via the `page.on("load")`
 * handler in `executeTest.js`) because `page.evaluate()` scripts do not
 * survive cross-document navigations.
 *
 * @example
 * import { injectCursorOverlay } from "./cursorOverlay.js";
 * await injectCursorOverlay(page);
 */

/**
 * Inject the cursor overlay script into a Playwright page.
 *
 * Creates:
 * - A small red dot that follows the mouse cursor (visible in CDP screencast).
 * - A click ripple animation that expands and fades on each click.
 * - A keystroke toast that briefly shows typed characters near the cursor.
 *
 * All overlay elements use `pointer-events: none` and high `z-index` so they
 * never interfere with the page under test.
 *
 * @param {Object} page - Playwright Page instance.
 * @returns {Promise<void>}
 */
export async function injectCursorOverlay(page) {
  await page.evaluate(() => {
    // Guard: don't inject twice on the same document
    if (document.getElementById("__sentri_cursor")) return;

    // ── Cursor dot ──────────────────────────────────────────────────────
    const dot = document.createElement("div");
    dot.id = "__sentri_cursor";
    Object.assign(dot.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "12px",
      height: "12px",
      borderRadius: "50%",
      background: "rgba(239, 68, 68, 0.85)",
      boxShadow: "0 0 4px rgba(239, 68, 68, 0.5)",
      pointerEvents: "none",
      zIndex: "2147483647",
      transform: "translate(-50%, -50%)",
      transition: "top 0.05s linear, left 0.05s linear",
    });
    document.body.appendChild(dot);

    // ── Keystroke toast container ────────────────────────────────────────
    const toast = document.createElement("div");
    toast.id = "__sentri_toast";
    Object.assign(toast.style, {
      position: "fixed",
      top: "0",
      left: "0",
      padding: "2px 6px",
      borderRadius: "4px",
      background: "rgba(0, 0, 0, 0.75)",
      color: "#fff",
      fontSize: "11px",
      fontFamily: "monospace",
      pointerEvents: "none",
      zIndex: "2147483647",
      opacity: "0",
      transition: "opacity 0.15s",
      whiteSpace: "pre",
      maxWidth: "200px",
      overflow: "hidden",
    });
    document.body.appendChild(toast);

    let toastTimer = null;
    let toastText = "";

    // ── CSS keyframes for click ripple ───────────────────────────────────
    const style = document.createElement("style");
    style.textContent = `
      @keyframes __sentri_ripple {
        0%   { transform: translate(-50%, -50%) scale(0); opacity: 0.6; }
        100% { transform: translate(-50%, -50%) scale(1); opacity: 0; }
      }
    `;
    document.head.appendChild(style);

    // ── Mouse move → update dot position ────────────────────────────────
    document.addEventListener("mousemove", (e) => {
      dot.style.top = e.clientY + "px";
      dot.style.left = e.clientX + "px";
    }, true);

    // ── Click → ripple animation ────────────────────────────────────────
    document.addEventListener("click", (e) => {
      const ripple = document.createElement("div");
      Object.assign(ripple.style, {
        position: "fixed",
        top: e.clientY + "px",
        left: e.clientX + "px",
        width: "30px",
        height: "30px",
        borderRadius: "50%",
        border: "2px solid rgba(239, 68, 68, 0.7)",
        pointerEvents: "none",
        zIndex: "2147483646",
        animation: "__sentri_ripple 0.4s ease-out forwards",
      });
      document.body.appendChild(ripple);
      setTimeout(() => ripple.remove(), 450);
    }, true);

    // ── Keypress → toast near cursor ────────────────────────────────────
    document.addEventListener("keydown", (e) => {
      if (e.key.length > 1 && !["Backspace", "Enter", "Tab", "Escape", "Space"].includes(e.key)) return;
      const display = e.key === " " ? "␣" : e.key === "Enter" ? "↵" : e.key === "Tab" ? "⇥" : e.key === "Backspace" ? "⌫" : e.key === "Escape" ? "⎋" : e.key;
      toastText += display;
      if (toastText.length > 20) toastText = toastText.slice(-20);
      toast.textContent = toastText;
      toast.style.opacity = "1";
      toast.style.top = (parseFloat(dot.style.top) + 18) + "px";
      toast.style.left = (parseFloat(dot.style.left) + 12) + "px";

      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.style.opacity = "0";
        toastText = "";
      }, 800);
    }, true);
  }).catch(() => {
    // Page may be navigating or closed — safe to ignore.
  });
}
