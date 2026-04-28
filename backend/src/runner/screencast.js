/**
 * screencast.js — CDP screencast lifecycle for live test streaming
 *
 * Manages the Chrome DevTools Protocol screencast session that streams
 * JPEG frames to SSE clients during test execution. The interactive
 * recorder (DIF-015 / PR #115) additionally reuses the returned CDP
 * session to forward pointer / keyboard / wheel events from the
 * browser-in-browser canvas back into the headless page via
 * `Input.dispatch*` calls — see `forwardInput()` in `recorder.js`.
 *
 * Exports:
 *   startScreencast(page, runId) → { stop, cdpSession } | null
 */

import { emitRunEvent } from "../utils/runLogger.js";
import { formatLogLine } from "../utils/logFormatter.js";

/**
 * startScreencast(page, runId)
 *
 * Starts a CDP screencast session and begins streaming JPEG frames to any
 * SSE clients watching the given run. Frames are throttled via setImmediate
 * so bursts don't flood the SSE channel; `emitRunEvent()` no-ops when no
 * clients are connected so the only overhead is CDP JPEG encoding (~2-3% CPU).
 *
 * Returns an object with both a `stop` cleanup function (used by
 * `executeTest.js` and the recorder during teardown) and the underlying
 * `cdpSession` (used by the recorder to dispatch input events back into
 * the page). Returns `null` if CDP is unavailable on the current
 * browser engine — Firefox / WebKit have no equivalent of Chrome's
 * `Page.startScreencast`, so cross-browser test runs gracefully degrade
 * to a no-screencast / no-input-forwarding mode.
 *
 * @param {Object} page - Playwright Page instance.
 * @param {string} runId
 * @returns {Promise<{stop: function(): Promise<void>, cdpSession: Object}|null>}
 *   `{ stop, cdpSession }` on success, or `null` if CDP is unavailable.
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
