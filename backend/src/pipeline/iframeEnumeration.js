/**
 * @module pipeline/iframeEnumeration
 * @description AUDIT-ROADMAP B2 — shared iframe-enumeration helper used by
 * both `crawlBrowser.js` (linear BFS crawl) and `stateExplorer.js`
 * (state-graph exploration).
 *
 * Extracted so the two crawl modes don't drift on iframe semantics:
 * `shouldEnumerateFrame` decides which frames to walk; `enumerateFrameSnapshots`
 * snapshots them, persists per-frame rows to `crawl_snapshots`, and returns
 * the merged element list for the caller to splice onto the parent snapshot.
 *
 * Industry-standard pattern: treat iframes as *element-scope* (locator
 * wrapping) rather than *state-scope* (new state-graph nodes). The latter
 * would inflate the state graph 5–10× on apps with persistent embedded
 * widgets (Intercom on every page, Stripe Elements on every checkout
 * step, etc.) — that's worse for autonomous QA than the locator-scope
 * approach Cypress / Playwright Codegen / Selenium IDE already use.
 *
 * ### Exports
 * - {@link shouldEnumerateFrame} — pure gate function (unit-testable)
 * - {@link enumerateFrameSnapshots} — async enumerator with persistence
 */

import { takeSnapshot, waitForSpaHydration } from "./pageSnapshot.js";
import * as crawlSnapshotRepo from "../database/repositories/crawlSnapshotRepo.js";
import { log, logWarn } from "../utils/runLogger.js";
import { iframeEnumeratedTotal } from "../utils/metrics.js";

/**
 * Normalise a hostname for origin comparison by stripping the `www.` prefix.
 * Mirrors the helper in `crawlBrowser.js` / `stateExplorer.js`.
 *
 * @param {string} hostname
 * @returns {string}
 */
function normaliseHost(hostname) {
  return hostname.replace(/^www\./i, "").toLowerCase();
}

/**
 * Check if two URLs share the same effective origin (protocol + normalised
 * host + port). Treats `www.example.com` and `example.com` as equivalent —
 * matches the convention used by both `crawlBrowser.js` and `stateExplorer.js`.
 *
 * @param {string} urlA
 * @param {string} urlB
 * @returns {boolean}
 */
function isSameEffectiveOrigin(urlA, urlB) {
  try {
    const a = new URL(urlA);
    const b = new URL(urlB);
    return a.protocol === b.protocol
      && normaliseHost(a.hostname) === normaliseHost(b.hostname)
      && a.port === b.port;
  } catch { return false; }
}

/**
 * AUDIT-ROADMAP B2 — decide whether a frame should be enumerated under the
 * project's `iframeStrategy`. Pure function — exported for unit tests.
 *
 * @param {string} frameUrl
 * @param {string} parentUrl
 * @param {string} strategy   One of `same-origin` | `allowlist` | `all` | `none`.
 * @param {string[]} [allowlist]  URL-prefix array (used only when strategy === 'allowlist').
 * @returns {boolean}
 */
export function shouldEnumerateFrame(frameUrl, parentUrl, strategy, allowlist) {
  if (!frameUrl || frameUrl === "about:blank") return false;
  if (strategy === "none") return false;
  if (strategy === "all") return true;
  if (strategy === "allowlist") {
    if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
    return allowlist.some((prefix) => prefix && frameUrl.startsWith(prefix));
  }
  // Default — same-origin.
  return isSameEffectiveOrigin(frameUrl, parentUrl);
}

/**
 * AUDIT-ROADMAP B2 — enumerate iframes on a page, snapshot each eligible
 * frame, persist per-frame snapshots to `crawl_snapshots`, AND collect
 * the frame elements (each tagged with `_fromIframe: true` + `_iframeSrc`)
 * so the caller can merge them into the parent snapshot's element list.
 *
 * The element merge is the critical path: `crawler.js#filterAndClassify`
 * → `elementFilter` → `journeyGenerator` consumes only the in-memory
 * `snapshots[]` array. Without merging frame elements onto the parent
 * snapshot, iframe content is invisible to test generation even though
 * the rows exist in `crawl_snapshots`. The merge mirrors how shadow-DOM
 * elements are handled in `crawlBrowser.js` — `_fromShadow` flag,
 * concatenated into `snapshot.elements`.
 *
 * Strictly best-effort: cross-origin frames produce a `SecurityError` on
 * any DOM access (browser policy); each is logged and skipped without
 * failing the crawl. The parent-page snapshot is unaffected — frame
 * enumeration only ADDS rows + elements, never replaces them.
 *
 * @param {Object} page                  Playwright Page object.
 * @param {string} parentUrl
 * @param {Object} project               Project row (iframeStrategy, iframeAllowlist).
 * @param {Object} run                   Run record (for log).
 * @returns {Promise<{ count: number, skipped: number, frameElements: Object[] }>}
 *   `frameElements` is the flat list of interactive elements gathered from
 *   every captured frame — each carries `_fromIframe: true` + `_iframeSrc`
 *   so downstream consumers (selectorGenerator, journey/intent prompts)
 *   can wrap their locators in `safeSelectFrame(page, '<iframe-src>')…`.
 */
export async function enumerateFrameSnapshots(page, parentUrl, project, run) {
  const strategy = project?.iframeStrategy || "same-origin";
  if (strategy === "none") return { count: 0, skipped: 0, frameElements: [] };

  const allowlist = Array.isArray(project?.iframeAllowlist) ? project.iframeAllowlist : [];
  let count = 0;
  let skipped = 0;
  const frameElements = [];
  let frames;
  try { frames = page.frames(); } catch { return { count: 0, skipped: 0, frameElements: [] }; }

  // Closed-set outcome enum for the `app_iframe_enumerated_total{strategy,
  // outcome}` counter. See the metric's `help` string in `utils/metrics.js`
  // for the semantics of each outcome. Counter increments are wrapped in
  // try/catch so a registry hiccup never blocks the crawl.
  const bumpIframe = (outcome) => {
    try { iframeEnumeratedTotal.inc({ strategy, outcome }); } catch { /* best-effort */ }
  };

  for (const frame of frames) {
    if (frame === page.mainFrame()) continue;
    const frameUrl = frame.url();
    if (!shouldEnumerateFrame(frameUrl, parentUrl, strategy, allowlist)) {
      skipped++;
      bumpIframe("skipped_strategy");
      continue;
    }
    try {
      // SPA-style hydration wait inside the frame mirrors the parent page.
      // Best-effort: cross-origin frames throw on evaluate() and fall to
      // the outer catch.
      await waitForSpaHydration(frame, project);
      const snap = await takeSnapshot(frame);
      snap._fromIframe = true;
      snap.iframeSrc = frameUrl;
      try {
        crawlSnapshotRepo.save(run.id, frameUrl, snap, {
          loadMs: null, // we don't time individual frame navigations
          fromIframe: true,
          iframeSrc: frameUrl,
        });
      } catch (persistErr) {
        logWarn(run, `Failed to persist iframe snapshot for ${frameUrl}: ${persistErr.message}`);
      }
      // Tag each frame element so the parent-snapshot merge keeps the
      // iframe provenance reachable for downstream consumers. `_iframeSrc`
      // matches the field name on the persisted row so the generator +
      // healing helpers can read either source consistently.
      if (Array.isArray(snap.elements)) {
        for (const el of snap.elements) {
          frameElements.push({ ...el, _fromIframe: true, _iframeSrc: frameUrl });
        }
      }
      count++;
      bumpIframe("captured");
    } catch (err) {
      // Cross-origin DOM access throws SecurityError — the common case for
      // payment widgets, Intercom, etc. Surface as structured info rather
      // than warning so logs stay clean.
      const msg = err?.message || String(err);
      if (msg.includes("SecurityError") || msg.includes("cross-origin")) {
        log(run, `⚠ Skipping cross-origin iframe: ${frameUrl}`);
        bumpIframe("skipped_cross_origin");
      } else {
        logWarn(run, `iframe snapshot failed for ${frameUrl}: ${msg}`);
        bumpIframe("error");
      }
      skipped++;
    }
  }
  if (count > 0) log(run, `🪟 iframes: ${count} captured (${frameElements.length} element${frameElements.length !== 1 ? "s" : ""}), ${skipped} skipped (${strategy})`);
  return { count, skipped, frameElements };
}
