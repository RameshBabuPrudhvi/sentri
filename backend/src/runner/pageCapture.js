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
 *   registerWebVitalsInitScript(context)  — AUTO-017.1: install vitals observers before navigation
 *   captureWebVitals(page)                — AUTO-017.1: read accumulated vitals at test end
 */

import path from "path";
import fs from "fs";
import { createRequire } from "module";
import { SHOTS_DIR } from "./config.js";
import { writeArtifactBuffer } from "../utils/objectStorage.js";

// AUTO-017: Resolve and cache the locally-installed `web-vitals` IIFE bundle so
// we can install it via `context.addInitScript({ content })` without hitting an
// external CDN at test time. Falls back to `null` if the package isn't installed
// (e.g. minimal Docker builds) — the init-script registration and capture both
// no-op in that case, returning the empty-metrics shape rather than crashing.
//
// NOTE: we can't `req.resolve("web-vitals/dist/web-vitals.iife.js")` directly
// because `web-vitals@4.x`'s `package.json` declares an `exports` field that
// only exposes `.` and `./attribution` — Node 20 strictly enforces this and
// throws ERR_PACKAGE_PATH_NOT_EXPORTED. Instead we resolve the package's
// `package.json` (which `exports` always exposes by convention) and derive the
// IIFE path from the package root. This layout is stable across web-vitals
// v3 / v4 / v5 — `dist/web-vitals.iife.js` is the canonical IIFE bundle.
// We resolve the package's *main entry* (which `exports` always exposes as `.`)
// and walk up to the package root, then derive the IIFE path. Resolving
// `web-vitals/package.json` directly throws ERR_PACKAGE_PATH_NOT_EXPORTED on
// Node 20 because `web-vitals@4.x`'s `exports` field only declares `.` and
// `./attribution`. The IIFE bundle layout (`dist/web-vitals.iife.js`) is
// stable across v3 / v4 / v5.
let WEB_VITALS_IIFE = null;
try {
  const req = createRequire(import.meta.url);
  const mainPath = req.resolve("web-vitals");
  // The main entry lives at `<pkgRoot>/dist/web-vitals.js` (or similar inside
  // dist/). Walk up until we find the package root (directory containing
  // `package.json`), then join `dist/web-vitals.iife.js`.
  let pkgRoot = path.dirname(mainPath);
  while (pkgRoot !== path.dirname(pkgRoot) && !fs.existsSync(path.join(pkgRoot, "package.json"))) {
    pkgRoot = path.dirname(pkgRoot);
  }
  const iifePath = path.join(pkgRoot, "dist", "web-vitals.iife.js");
  WEB_VITALS_IIFE = fs.readFileSync(iifePath, "utf8");
} catch { /* package not installed or layout changed — web-vitals helpers will no-op */ }

// AUTO-017.1: Bootstrap that runs *after* the IIFE in the same init-script so
// `window.webVitals` is already defined. Registers observers on every new
// document (addInitScript fires on every frame navigation) so LCP / CLS / TTFB
// are captured during the real page lifecycle instead of being injected
// post-test (when buffered entries are unreliable and the cumulative CLS
// observer has missed earlier shifts). Results accumulate on
// `window.__sentriVitals` for `captureWebVitals()` to read at test end.
const WEB_VITALS_BOOTSTRAP = `
(function () {
  try {
    if (window.__sentriVitalsInstalled) return;
    window.__sentriVitalsInstalled = true;
    window.__sentriVitals = { lcp: null, cls: null, inp: null, ttfb: null };
    if (!window.webVitals) return;
    window.webVitals.onLCP(function (m) { window.__sentriVitals.lcp = Math.round(m.value); }, { reportAllChanges: true });
    window.webVitals.onCLS(function (m) { window.__sentriVitals.cls = Number(m.value.toFixed(3)); }, { reportAllChanges: true });
    window.webVitals.onINP(function (m) { window.__sentriVitals.inp = Math.round(m.value); }, { reportAllChanges: true });
    window.webVitals.onTTFB(function (m) { window.__sentriVitals.ttfb = Math.round(m.value); }, { reportAllChanges: true });
  } catch (e) { /* best-effort — never break the page */ }
})();
`;

/**
 * registerWebVitalsInitScript(context) — AUTO-017.1
 *
 * Installs the web-vitals IIFE + observer bootstrap on the browser context
 * via `addInitScript`, so observers are active from the first byte of every
 * navigation. Must be called once per context immediately after creation and
 * before the first `page.goto()`.
 *
 * No-ops when the web-vitals package isn't installed — callers should still
 * invoke `captureWebVitals(page)`, which returns the empty-metrics shape in
 * that case.
 */
export async function registerWebVitalsInitScript(context) {
  if (!WEB_VITALS_IIFE) return;
  try {
    await context.addInitScript({ content: WEB_VITALS_IIFE + "\n" + WEB_VITALS_BOOTSTRAP });
  } catch { /* context may be closing — capture will fall back to nulls */ }
}


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


/**
 * captureWebVitals(page) — AUTO-017.1
 *
 * Reads the metrics accumulated on `window.__sentriVitals` by the observers
 * installed via `registerWebVitalsInitScript` at context creation. Because the
 * observers have been running during the entire page lifecycle, LCP / CLS /
 * TTFB reflect actual measurements rather than post-hoc buffered replays.
 *
 * Waits up to 800ms (early-exiting as soon as LCP + TTFB + CLS are populated)
 * to let any final `reportAllChanges` callbacks flush. INP is reported only
 * after a user interaction — it stays `null` for non-interactive tests, which
 * the evaluator treats as "not measured" rather than a failure.
 *
 * Falls back to the empty-metrics shape if the init script was never
 * registered (e.g. web-vitals not installed, or context is an older run
 * started before AUTO-017.1 landed).
 */
export async function captureWebVitals(page) {
  if (!WEB_VITALS_IIFE) return { lcp: null, cls: null, inp: null, ttfb: null };
  try {
    const metrics = await page.evaluate(async () => {
      return await new Promise((resolve) => {
        const read = () => window.__sentriVitals || { lcp: null, cls: null, inp: null, ttfb: null };
        // If the init script never ran (pre-AUTO-017.1 context, or navigation
        // blocked before onload), bail immediately rather than waiting 800ms
        // for metrics that will never arrive.
        if (!window.__sentriVitalsInstalled) return resolve(read());
        const started = Date.now();
        const tick = () => {
          const m = read();
          const allCore = m.lcp != null && m.ttfb != null && m.cls != null;
          if (allCore || Date.now() - started >= 800) return resolve(m);
          setTimeout(tick, 100);
        };
        tick();
      });
    });
    return metrics || { lcp: null, cls: null, inp: null, ttfb: null };
  } catch {
    return { lcp: null, cls: null, inp: null, ttfb: null };
  }
}
