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
import { formatLogLine } from "../utils/logFormatter.js";

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
 * @returns {Promise<?function(): Promise<void>>} Resolves to a cleanup function, or `null` if CDP is unavailable.
 */
export async function startScreencast(page, runId) {
  // Always start the screencast — SSE clients typically connect *after* the
  // run begins (the user is redirected to /runs/:id after clicking "Run").
  // The previous guard `if (!runListeners.get(runId)?.size) return null`
  // caused the screencast to be skipped for virtually every run because no
  // SSE client was connected yet at this point.  The frame handler below
  // calls emitRunEvent() which already no-ops when there are no listeners,
  // so the only overhead is CDP JPEG encoding (~2-3% CPU).

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
    console.log(formatLogLine("info", null, `[screencast] started for run=${runId}`));
  } catch (cdpErr) {
    console.warn(formatLogLine("warn", null, `[screencast] CDP screencast unavailable: ${cdpErr.message}`));
    return null;
  }

  // Buffer the latest frame; requestAnimationFrame-style throttle via
  // a flag so bursting frames don't flood the SSE channel
  let rafScheduled = false;
  let pendingFrame = null;
  // Diagnostic counter — print a one-liner when the first frame arrives so
  // the operator can confirm the headless browser is actually rendering.
  // Without this, a black canvas + zero logs leaves no way to tell whether
  // frames are being produced or just lost in transit.
  let frameCount = 0;

  cdpSession.on("Page.screencastFrame", async ({ data, sessionId }) => {
    frameCount++;
    if (frameCount === 1) {
      console.log(formatLogLine("info", null, `[screencast] first frame received for run=${runId} (${data.length} bytes)`));
    }
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

  // Return both the cleanup function and the CDP session.
  // Callers that only need cleanup (executeTest) ignore the second value.
  // The recorder uses cdpSession to forward mouse/keyboard events from the
  // browser-in-browser canvas back to the headless Playwright page so that
  // the user's clicks and keystrokes actually reach the recorded page.
  const stop = async () => {
    await cdpSession.send("Page.stopScreencast").catch(() => {});
    await cdpSession.detach().catch(() => {});
  };
  return { stop, cdpSession };
}
