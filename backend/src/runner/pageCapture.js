/**
 * pageCapture.js — Page-level artifact capture helpers
 *
 * Extracts DOM snapshot, screenshot, and bounding-box capture logic from
 * executeTest so each concern is independently testable and the main
 * execution function stays focused on orchestration.
 *
 * Exports:
 *   captureDomSnapshot(page)
 *   captureScreenshot(page, runId, stepIndex, { failed })
 *   captureBoundingBoxes(page)
 */

import path from "path";
import fs from "fs";
import { SHOTS_DIR } from "./config.js";

/**
 * captureDomSnapshot(page) → object | null
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
 * captureScreenshot(page, runId, stepIndex, { failed }) → { base64, artifactPath }
 *
 * Takes a PNG screenshot, writes it to disk, and returns both the base64
 * string (for SSE) and the artifact path (for the DB).
 *
 * @param {boolean} failed — appends "-fail" to the filename when true
 */
export async function captureScreenshot(page, runId, stepIndex, { failed = false } = {}) {
  const suffix = failed ? "-fail" : "";
  const shotName = `${runId}-step${stepIndex}${suffix}.png`;
  const shotPath = path.join(SHOTS_DIR, shotName);
  const buf = await page.screenshot({ type: "png", fullPage: false });
  fs.writeFileSync(shotPath, buf);
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
