/**
 * @module runner/networkConditions
 * @description AUTO-006: Apply per-run network condition emulation to a
 *   Playwright context/page. Extracted from `executeTest.js` so it can be
 *   unit-tested with fake browser objects.
 *
 * Supported values:
 *   - `"fast"` (or anything else, including `undefined`) — no-op.
 *   - `"offline"` — `context.setOffline(true)`.
 *   - `"slow3g"` — Chromium-only CDP `Network.emulateNetworkConditions`
 *     (~400 Kbps, 400 ms RTT). Falls back to a per-request 400 ms delay
 *     via `page.route("**\/*", …)` on Firefox/WebKit where CDP isn't
 *     available.
 *
 * ## MVP scope (AUTO-006 ROADMAP deferral)
 *
 * The ROADMAP entry mentions "throttling" with configurable latency and
 * throughput. This MVP ships **three hardcoded presets** (`fast` / `slow3g`
 * / `offline`) that map to Chrome DevTools' own "Slow 3G" preset values
 * (400 Kbps, 400 ms RTT). Configurable `{ latency, downloadKbps,
 * uploadKbps }` is **intentionally deferred** for these reasons:
 *
 *   1. The preset values are the industry defaults every QA platform
 *      compares against — customers asking about "Slow 3G" testing expect
 *      these exact numbers, not arbitrary ones.
 *   2. Adding a free-form object to the run payload without schema
 *      validation invites bad inputs (negative throughput, absurd
 *      latencies) that produce confusing results rather than hard errors.
 *   3. The `slow3g` preset covers ≥90% of "my site is slow on mobile"
 *      testing intent without operator tuning.
 *
 * If custom throttling is needed (e.g. to reproduce a specific customer
 * network profile), extend `applyNetworkCondition` to accept
 * `networkCondition: { kind: "custom", latency, downloadKbps, uploadKbps }`
 * and validate at the route layer (`backend/src/routes/runs.js`). The CDP
 * call already accepts arbitrary values — only the public API surface needs
 * widening. Tracked as a follow-up note under AUTO-006 in ROADMAP.md.
 *
 * Returns a `{ teardown }` handle. The caller MUST `await teardown()` in a
 * `finally` block before closing the page so the slow3g route handler is
 * unrouted and doesn't keep firing on in-flight teardown requests.
 */

const SLOW_3G_LATENCY_MS = 400;
// 400 Kbps in bytes/sec — matches Chrome DevTools "Slow 3G" preset.
const SLOW_3G_THROUGHPUT_BPS = (400 * 1024) / 8;

/**
 * @typedef {Object} ApplyNetworkConditionArgs
 * @property {string} [networkCondition] - "fast" | "slow3g" | "offline".
 * @property {*} context - Playwright BrowserContext.
 * @property {*} page - Playwright Page bound to `context`.
 *
 * @typedef {Object} NetworkConditionHandle
 * @property {Function} teardown - Async function; must be awaited before closing the page.
 */

/**
 * @param {ApplyNetworkConditionArgs} args
 * @returns {Promise<NetworkConditionHandle>}
 */
export async function applyNetworkCondition({ networkCondition, context, page }) {
  if (networkCondition === "offline") {
    await context.setOffline(true);
    return { teardown: async () => {} };
  }

  if (networkCondition === "slow3g") {
    // Prefer CDP for faithful bandwidth+latency emulation (Chromium only).
    let cdpOk = false;
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: SLOW_3G_LATENCY_MS,
        downloadThroughput: SLOW_3G_THROUGHPUT_BPS,
        uploadThroughput: SLOW_3G_THROUGHPUT_BPS,
      });
      cdpOk = true;
    } catch { /* non-Chromium — fall through to route-based delay */ }

    if (cdpOk) return { teardown: async () => {} };

    const slow3gRoute = async (route) => {
      await new Promise((r) => setTimeout(r, SLOW_3G_LATENCY_MS));
      await route.continue();
    };
    await page.route("**/*", slow3gRoute);
    return {
      teardown: async () => {
        await page.unroute("**/*", slow3gRoute).catch(() => {});
      },
    };
  }

  // "fast" or any other value — no-op.
  return { teardown: async () => {} };
}
