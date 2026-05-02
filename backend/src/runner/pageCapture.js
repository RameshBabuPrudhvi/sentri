/**
 * pageCapture.js — Page-level artifact capture helpers
 *
 * Extracts DOM snapshot, screenshot, and bounding-box capture logic from
 * executeTest so each concern is independently testable and the main
 * execution function stays focused on orchestration.
 *
 * Exports:
 *   waitForStable(page, opts)        — S3-02: MutationObserver DOM stability wait
 *   captureDomSnapshot(page)
 *   captureScreenshot(page, runId, stepIndex, { failed })
 *   captureBoundingBoxes(page)
 *   captureWebVitals(page)
 */

import path from "path";
import fs from "fs";
import { createRequire } from "module";
import { SHOTS_DIR } from "./config.js";
import { writeArtifactBuffer } from "../utils/objectStorage.js";

// AUTO-017: Resolve and cache the locally-installed `web-vitals` IIFE bundle so
// `captureWebVitals` can inject it via `addScriptTag({ content })` without
// hitting an external CDN at test time. Falls back to `null` if the package
// isn't installed (e.g. minimal Docker builds) — `captureWebVitals` then returns
// the empty-metrics shape rather than crashing the test.
let WEB_VITALS_IIFE = null;
try {
  const req = createRequire(import.meta.url);
  const iifePath = req.resolve("web-vitals/dist/web-vitals.iife.js");
  WEB_VITALS_IIFE = fs.readFileSync(iifePath, "utf8");
} catch { /* package not installed — captureWebVitals will no-op */ }


/**
 * waitForStable(page, opts) → Promise<void>
 *
 * S3-02 — DOM stability wait using MutationObserver.
 *
 * Modern SPAs (React, Vue, Angular, Next.js) and apps with streaming AI
 * responses, skeleton screens, or async data fetches settle at variable
 * times. Using a fixed `waitForTimeout` causes tests to assert on
 * partially-rendered pages, producing false failures.
 *
 * This helper installs a MutationObserver on `document.body` that counts
 * every DOM mutation. It polls until `stableSec` consecutive seconds pass
 * with no new mutations (or `timeoutSec` is reached), then disconnects
 * cleanly. The observer and mutation counter are stored on `window` so
 * they survive across evaluate() calls and can be cleaned up reliably.
 *
 * Based on the Assrt `agent.ts` pattern referenced in NEXT_STEPS S3-02.
 *
 * @param {Object} page  - Playwright Page instance
 * @param {object}  [opts]
 * @param {number}  [opts.timeoutSec=30]  - Maximum wait in seconds
 * @param {number}  [opts.stableSec=2]    - Quiet period required to declare stable
 * @returns {Promise<void>}
 */
export async function waitForStable(page, { timeoutSec = 30, stableSec = 2 } = {}) {
  // Install the MutationObserver in the page context. Stored on window so
  // subsequent evaluate() calls can read the counter and clean up.
  await page.evaluate(() => {
    // Guard: if a previous waitForStable call was interrupted, disconnect it
    // first so we don't accumulate multiple observers.
    if (window.__sentri_observer) {
      try { window.__sentri_observer.disconnect(); } catch {}
    }
    window.__sentri_mutations = 0;
    window.__sentri_observer = new MutationObserver(mutations => {
      window.__sentri_mutations += mutations.length;
    });
    window.__sentri_observer.observe(document.body, {
      childList:     true,
      subtree:       true,
      characterData: true,
      attributes:    true,
    });
  }).catch(() => {
    // If evaluate fails (page navigating, closed) — swallow and continue.
    // The caller's own timeout / test runner will handle truly broken pages.
  });

  const start = Date.now();
  let lastCount = -1;
  let stableSince = Date.now();

  while (Date.now() - start < timeoutSec * 1000) {
    await new Promise(r => setTimeout(r, 500));

    let count = lastCount;
    try {
      count = await page.evaluate(() => window.__sentri_mutations ?? -1);
    } catch {
      // Page closed or navigated mid-poll — treat as stable and exit
      break;
    }

    if (count !== lastCount) {
      // DOM is still mutating — reset the stability clock
      lastCount = count;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= stableSec * 1000) {
      // No mutations for stableSec seconds — DOM has settled
      break;
    }
  }

  // Always disconnect and clean up, even on timeout
  await page.evaluate(() => {
    try { window.__sentri_observer?.disconnect(); } catch {}
    delete window.__sentri_observer;
    delete window.__sentri_mutations;
  }).catch(() => {});
}

/**
 *
 * Serialises a shallow representation of the current DOM (max depth 4)
 * for debugging and AI context.  Returns null on any failure.
 */
export async function captureDomSnapshot(page) {
  return page.evaluate(() => {
    function serialize(node, depth = 0) {
      if (depth > 4 || !node) return null;
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent?.trim();
        return t ? { type: "text", text: t.slice(0, 80) } : null;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return null;
      const el = node;
      const tag = el.tagName.toLowerCase();
      if (["script","style","noscript","svg","path"].includes(tag)) return null;
      const attrs = {};
      for (const a of el.attributes) {
        if (["id","class","href","src","type","role","aria-label","name"].includes(a.name))
          attrs[a.name] = a.value.slice(0, 60);
      }
      const children = [];
      for (const child of el.childNodes) {
        const c = serialize(child, depth + 1);
        if (c) children.push(c);
        if (children.length >= 6) break;
      }
      return { type: "element", tag, attrs, children };
    }
    return serialize(document.body);
  }).catch(() => null);
}

/**
 * captureScreenshot(page, runId, stepIndex, opts) → { base64, artifactPath }
 *
 * Takes a PNG screenshot, writes it to disk, and returns both the base64
 * string (for SSE) and the artifact path (for the DB).
 *
 * @param {Object}  page
 * @param {string}  runId
 * @param {number}  stepIndex    — test index within the run
 * @param {Object}  [opts]
 * @param {boolean} [opts.failed]     — appends "-fail" to the filename
 * @param {number}  [opts.stepNumber] — per-step capture (DIF-016): appends "-s{N}" to the filename
 */
export async function captureScreenshot(page, runId, stepIndex, { failed = false, stepNumber } = {}) {
  const suffix = failed ? "-fail" : stepNumber != null ? `-s${stepNumber}` : "";
  const shotName = `${runId}-step${stepIndex}${suffix}.png`;
  const shotPath = path.join(SHOTS_DIR, shotName);
  const buf = await page.screenshot({ type: "png", fullPage: false });
  await writeArtifactBuffer({
    artifactPath: `/artifacts/screenshots/${shotName}`,
    absolutePath: shotPath,
    buffer: buf,
    contentType: "image/png",
  });
  return {
    base64: buf.toString("base64"),
    artifactPath: `/artifacts/screenshots/${shotName}`,
  };
}

/**
 * captureBoundingBoxes(page) → Array<{ x, y, width, height }>
 *
 * Collects bounding boxes of the last interacted / focused elements so
 * the frontend OverlayCanvas can draw highlights.
 */
export async function captureBoundingBoxes(page) {
  try {
    return await page.evaluate(() => {
      const boxes = [];
      // Prefer the currently-focused element
      const focused = document.activeElement;
      if (focused && focused !== document.body && focused !== document.documentElement) {
        const r = focused.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          boxes.push({ x: r.x, y: r.y, width: r.width, height: r.height });
        }
      }
      // Also collect any elements with aria-selected / data-testid that are visible
      if (boxes.length === 0) {
        const candidates = document.querySelectorAll(
          "button:focus, input:focus, [aria-selected='true'], [data-focused='true']"
        );
        for (const el of candidates) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            boxes.push({ x: r.x, y: r.y, width: r.width, height: r.height });
            if (boxes.length >= 3) break;
          }
        }
      }
      return boxes;
    }).catch(() => []);
  } catch {
    return [];
  }
}


export async function captureWebVitals(page) {
  if (!WEB_VITALS_IIFE) return { lcp: null, cls: null, inp: null, ttfb: null };
  try {
    await page.addScriptTag({ content: WEB_VITALS_IIFE });
    await page.waitForTimeout(50);
    const metrics = await page.evaluate(async () => {
      return await new Promise((resolve) => {
        const out = { lcp: null, cls: null, inp: null, ttfb: null };
        const done = () => resolve(out);
        try {
          if (!window.webVitals) return done();
          window.webVitals.onLCP((m) => { out.lcp = Math.round(m.value); }, { reportAllChanges: true });
          window.webVitals.onCLS((m) => { out.cls = Number(m.value.toFixed(3)); }, { reportAllChanges: true });
          window.webVitals.onINP((m) => { out.inp = Math.round(m.value); }, { reportAllChanges: true });
          window.webVitals.onTTFB((m) => { out.ttfb = Math.round(m.value); }, { reportAllChanges: true });
          setTimeout(done, 1200);
        } catch { done(); }
      });
    });
    return metrics;
  } catch {
    return { lcp: null, cls: null, inp: null, ttfb: null };
  }
}
