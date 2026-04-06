/**
 * screencast.js — CDP screencast lifecycle for live test streaming
 *
 * Manages the Chrome DevTools Protocol screencast session that streams
 * JPEG frames to SSE clients during test execution.
 *
 * Exports:
 *   startScreencast(page, runId) → cleanup function (or null if no clients)
 */

import { emitRunEvent } from "../utils/runLogger.js";

/**
 * startScreencast(page, runId)
 *
 * Starts a CDP screencast session if at least one SSE client is watching
 * the given run.  Returns an async cleanup function that stops the
 * screencast and detaches the session.  Returns null if no clients are
 * connected (avoids encoding overhead when nobody is watching).
 *
 * @param {Object} page - Playwright Page instance.
 * @param {string} runId
 * @returns {Promise<?function(): Promise<void>>} Resolves to a cleanup function, or `null` if no SSE clients.
 */
export async function startScreencast(page, runId) {
  // Only start if there are active SSE listeners
  const { runListeners } = await import("../routes/sse.js").catch(() => ({}));
  if (!runListeners?.get(runId)?.size) return null;

  let cdpSession;
  try {
    cdpSession = await page.context().newCDPSession(page);
    await cdpSession.send("Page.startScreencast", {
      format: "jpeg",
      quality: 50,
      maxWidth: 1280,
      maxHeight: 720,
      everyNthFrame: 2, // ~15 FPS source → ~7 FPS net
    });
  } catch (cdpErr) {
    console.warn("[screencast] CDP screencast unavailable:", cdpErr.message);
    return null;
  }

  // Buffer the latest frame; requestAnimationFrame-style throttle via
  // a flag so bursting frames don't flood the SSE channel
  let rafScheduled = false;
  let pendingFrame = null;

  cdpSession.on("Page.screencastFrame", async ({ data, sessionId }) => {
    pendingFrame = data;
    if (!rafScheduled) {
      rafScheduled = true;
      setImmediate(() => {
        rafScheduled = false;
        if (pendingFrame) {
          emitRunEvent(runId, "frame", { data: pendingFrame });
          pendingFrame = null;
        }
      });
    }
    // Acknowledge every frame so the browser doesn't stall
    await cdpSession.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });

  // Return an async cleanup function
  return async () => {
    await cdpSession.send("Page.stopScreencast").catch(() => {});
    await cdpSession.detach().catch(() => {});
  };
}
