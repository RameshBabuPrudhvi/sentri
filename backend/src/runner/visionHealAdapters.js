/**
 * @module runner/visionHealAdapters
 * @description MNT-001b — concrete adapter implementations injected into
 * `tryVisionHeal(ctx, deps)` from `executeTest.js`. MNT-001a shipped the
 * orchestrator with `deps = {}`, so vision healing was a no-op. This module
 * supplies:
 *
 *   - `pixelmatchHeal(failureBuffer, baselineBuffer, threshold)` — stage 7
 *     sliding-window CV matcher (free, deterministic).
 *   - `llmVisionHeal({ failure, intent, contextHtml })` — stage 8 thin
 *     proxy to `aiProvider.callVisionModel`.
 *
 * Both functions return `null` on any internal failure so a vision-heal
 * attempt never *causes* a test failure that wouldn't already have happened
 * — same contract the orchestrator's catch blocks rely on.
 */
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { callVisionModel } from "../aiProvider.js";

/**
 * Extract a W×H region from a PNG starting at (x, y) as a flat RGBA buffer
 * compatible with `pixelmatch`'s expected input shape.
 *
 * `png.data` is a single contiguous RGBA buffer of `png.width * png.height
 * * 4` bytes. We copy row-by-row because the source stride (`png.width *
 * 4`) and destination stride (`w * 4`) differ.
 *
 * @param {{data: Buffer, width: number, height: number}} png
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @returns {{data: Buffer, width: number, height: number}}
 */
function extractRegion(png, x, y, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcStart = ((y + row) * png.width + x) * 4;
    const dstStart = row * w * 4;
    png.data.copy(out, dstStart, srcStart, srcStart + w * 4);
  }
  return { data: out, width: w, height: h };
}

/**
 * MNT-001 stage 7 — pixelmatch sliding-window CV matcher.
 *
 * Given a failure-state viewport screenshot and a baseline element crop,
 * slides the baseline over the viewport at a configurable stride and
 * returns the best-matching region's normalised similarity score + bbox.
 *
 * Algorithm:
 *   1. Decode both PNGs to RGBA buffers via pngjs.
 *   2. Slide baseline (W×H) across viewport at stride (default 8px).
 *   3. For each window: `pixelmatch` with threshold=0.1 → diff pixel count.
 *   4. confidence = 1 - (diffPixels / totalPixels) per window.
 *   5. Return best window, OR null if max < threshold.
 *
 * Performance budget: 1280×720 viewport + 80×32 baseline at stride=8 ≈
 * 14k windows × ~2ms each ≈ 28s worst case. We cap iteration count at
 * `VISION_HEAL_MAX_WINDOWS` (default 50,000) and increase the effective
 * stride proportionally when a 4K viewport would otherwise blow past it.
 *
 * Returns null on any error (malformed PNG, baseline larger than viewport,
 * sub-threshold best match) so the caller falls through cleanly.
 *
 * @param {Buffer} failureBuffer  PNG of full failure-state viewport.
 * @param {Buffer} baselineBuffer PNG of element's last green crop.
 * @param {number} [threshold=0.85] Minimum similarity to consider a match (0-1).
 * @returns {Promise<{confidence: number, box: {x: number, y: number, width: number, height: number}} | null>}
 */
export async function pixelmatchHeal(failureBuffer, baselineBuffer, threshold = 0.85) {
  if (!failureBuffer || !baselineBuffer) return null;

  let failure, baseline;
  try {
    failure = PNG.sync.read(failureBuffer);
    baseline = PNG.sync.read(baselineBuffer);
  } catch {
    return null; // Malformed PNG → graceful no-heal.
  }

  // Baseline must fit strictly inside the viewport so the slide window has
  // at least one valid position. `>=` is intentional: a baseline the exact
  // size of the viewport degenerates to a single pixelmatch call which
  // doesn't add CV value over a direct comparison.
  if (baseline.width >= failure.width || baseline.height >= failure.height) {
    return null;
  }

  const stride = parseInt(process.env.VISION_HEAL_PIXEL_STRIDE, 10) || 8;
  const maxWindows = parseInt(process.env.VISION_HEAL_MAX_WINDOWS, 10) || 50_000;

  // Total candidate windows at the requested stride. When this exceeds the
  // budget (e.g. a 4K viewport against a small baseline), scale stride by
  // sqrt(totalWindows / maxWindows) so the 2D window count drops linearly
  // back under the cap.
  const totalWindows = Math.ceil((failure.width - baseline.width) / stride) *
                       Math.ceil((failure.height - baseline.height) / stride);
  const effectiveStride = totalWindows > maxWindows
    ? Math.ceil(stride * Math.sqrt(totalWindows / maxWindows))
    : stride;

  let bestConfidence = 0;
  let bestBox = null;
  const baselinePixels = baseline.width * baseline.height;

  for (let y = 0; y <= failure.height - baseline.height; y += effectiveStride) {
    for (let x = 0; x <= failure.width - baseline.width; x += effectiveStride) {
      const region = extractRegion(failure, x, y, baseline.width, baseline.height);
      // pixelmatch returns the count of differing pixels. We don't need the
      // diff-output buffer (we're not rendering a visual diff), so pass null.
      const diffPixels = pixelmatch(
        region.data,
        baseline.data,
        null,
        baseline.width,
        baseline.height,
        { threshold: 0.1, includeAA: false },
      );
      const confidence = 1 - (diffPixels / baselinePixels);
      if (confidence > bestConfidence) {
        bestConfidence = confidence;
        bestBox = { x, y, width: baseline.width, height: baseline.height };
      }
    }
  }

  if (bestConfidence < threshold) return null;
  return { confidence: bestConfidence, box: bestBox };
}

/**
 * MNT-001 stage 8 adapter — thin proxy to `aiProvider.callVisionModel`.
 *
 * The orchestrator (`tryVisionHeal`) passes `{ failure, intent }` but the
 * provider abstraction expects `{ screenshot, intent, contextHtml, signal }`.
 * This adapter maps between the two shapes and propagates `contextHtml`
 * when the caller supplies it (currently always omitted; MNT-001b territory).
 *
 * Returns `null` on any provider failure (rate limit, malformed JSON,
 * sub-threshold confidence) per `callVisionModel`'s contract.
 *
 * @param {Object} params
 * @param {Buffer} params.failure
 * @param {{action: string, label: string}} params.intent
 * @param {string} [params.contextHtml]
 * @returns {Promise<Object|null>}
 */
export async function llmVisionHeal({ failure, intent, contextHtml } = {}) {
  return callVisionModel({
    screenshot: failure,
    intent,
    contextHtml,
  });
}
