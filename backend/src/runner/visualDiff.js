/**
 * @module runner/visualDiff
 * @description DIF-001 — Visual regression diffing helpers.
 *
 * Wraps `pixelmatch` + `pngjs` to compare a freshly-captured screenshot
 * against a saved baseline, persist a side-by-side diff image, and return
 * a structured result the test runner can attach to a step.
 *
 * A baseline is created lazily on the first run that produces a screenshot
 * for a given `(testId, stepNumber)` pair. Subsequent runs compare against
 * that baseline; if the pixel difference ratio exceeds
 * `VISUAL_DIFF_THRESHOLD` the step is flagged `visualRegression: true`.
 *
 * ### Directory layout
 * ```
 * artifacts/
 *   baselines/<testId>/step-<N>.png
 *   diffs/<runId>-<testId>-step<N>.png
 * ```
 *
 * ### Exports
 * - {@link ensureBaseline} — Create-or-read the baseline image + DB row.
 * - {@link diffScreenshot} — Diff a captured PNG against the saved baseline.
 * - {@link acceptBaseline} — Promote a captured screenshot to the new baseline.
 */

import fs from "fs";
import path from "path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import * as baselineRepo from "../database/repositories/baselineRepo.js";
import {
  BASELINES_DIR,
  DIFFS_DIR,
  VISUAL_DIFF_THRESHOLD,
  VISUAL_DIFF_PIXEL_TOLERANCE,
} from "./config.js";

/**
 * @typedef {Object} VisualDiffResult
 * @property {"baseline_created"|"match"|"regression"|"error"} status
 * @property {number}  [diffPixels]     - Number of differing pixels.
 * @property {number}  [totalPixels]    - Total pixels compared.
 * @property {number}  [diffRatio]      - diffPixels / totalPixels (0..1).
 * @property {number}  [threshold]      - Threshold used (mirrors VISUAL_DIFF_THRESHOLD).
 * @property {string}  [baselinePath]   - Public artifact path of the baseline PNG.
 * @property {string}  [diffPath]       - Public artifact path of the diff PNG.
 * @property {string}  [message]        - Human-readable reason when status = "error".
 */

/**
 * Absolute path to the baseline PNG for a given test + step.
 * @param {string} testId
 * @param {number} stepNumber
 * @returns {string}
 */
function baselineAbsPath(testId, stepNumber) {
  return path.join(BASELINES_DIR, testId, `step-${stepNumber}.png`);
}

/**
 * Public (URL-safe) artifact path for a baseline.
 * @param {string} testId
 * @param {number} stepNumber
 * @returns {string}
 */
function baselinePublicPath(testId, stepNumber) {
  // Raw testId (not encoded): the URL path is URL-decoded by Express before
  // the static-file lookup + HMAC verification in appSetup.js, so %-encoded
  // bytes would break both. Test IDs from `generateTestId()` are already
  // path-safe (uppercase + digits + hyphens).
  return `/artifacts/baselines/${testId}/step-${stepNumber}.png`;
}

/**
 * Load a PNG from disk, returning null on error.
 * @param {string} absPath
 * @returns {Object|null}
 */
function readPng(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    return PNG.sync.read(buf);
  } catch {
    return null;
  }
}

/**
 * Create baseline directory + PNG file and persist a DB row.
 *
 * @param {string} testId
 * @param {number} stepNumber
 * @param {Buffer} pngBuffer
 * @returns {{ absPath: string, publicPath: string, width: number, height: number }}
 */
function persistBaseline(testId, stepNumber, pngBuffer) {
  const dir = path.join(BASELINES_DIR, testId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const absPath = baselineAbsPath(testId, stepNumber);
  fs.writeFileSync(absPath, pngBuffer);

  // Decode header only to capture dimensions — safe on failure.
  let width = null;
  let height = null;
  try {
    const decoded = PNG.sync.read(pngBuffer);
    width = decoded.width;
    height = decoded.height;
  } catch { /* keep null dimensions */ }

  const publicPath = baselinePublicPath(testId, stepNumber);
  baselineRepo.upsert({ testId, stepNumber, imagePath: publicPath, width, height });
  return { absPath, publicPath, width, height };
}

/**
 * Read the baseline image from disk for a given test + step, if one exists.
 *
 * @param {string} testId
 * @param {number} stepNumber
 * @returns {{ row: Object, abs: string } | null}
 */
export function ensureBaseline(testId, stepNumber = 0) {
  const row = baselineRepo.get(testId, stepNumber);
  if (!row) return null;
  const abs = baselineAbsPath(testId, stepNumber);
  if (!fs.existsSync(abs)) return null;
  return { row, abs };
}

/**
 * Diff a freshly-captured screenshot against the saved baseline.
 *
 * - If no baseline exists yet, the capture is promoted to the baseline and
 *   `status = "baseline_created"` is returned.
 * - If dimensions differ the diff short-circuits with `status = "error"`.
 * - Otherwise pixelmatch runs and `status` is `"match"` or `"regression"`
 *   depending on {@link VISUAL_DIFF_THRESHOLD}.
 *
 * @param {Object} args
 * @param {string} args.runId
 * @param {string} args.testId
 * @param {number} [args.stepNumber=0]
 * @param {Buffer} args.pngBuffer - Raw PNG bytes of the captured screenshot.
 * @returns {VisualDiffResult}
 */
export function diffScreenshot({ runId, testId, stepNumber = 0, pngBuffer }) {
  if (!pngBuffer || !Buffer.isBuffer(pngBuffer) || pngBuffer.length === 0) {
    return { status: "error", message: "empty screenshot buffer" };
  }

  // ── First run for this step — create baseline and bail out early ──
  const existing = ensureBaseline(testId, stepNumber);
  if (!existing) {
    const { publicPath, width, height } = persistBaseline(testId, stepNumber, pngBuffer);
    return {
      status: "baseline_created",
      baselinePath: publicPath,
      totalPixels: (width || 0) * (height || 0),
      threshold: VISUAL_DIFF_THRESHOLD,
    };
  }

  // ── Subsequent runs — actually diff ──
  const baseline = readPng(existing.abs);
  const current = (() => { try { return PNG.sync.read(pngBuffer); } catch { return null; } })();

  if (!baseline || !current) {
    return { status: "error", message: "failed to decode PNG" };
  }

  if (baseline.width !== current.width || baseline.height !== current.height) {
    return {
      status: "error",
      message: `dimensions differ: baseline ${baseline.width}x${baseline.height} vs current ${current.width}x${current.height}`,
      baselinePath: existing.row.imagePath,
      threshold: VISUAL_DIFF_THRESHOLD,
    };
  }

  const { width, height } = baseline;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(
    baseline.data,
    current.data,
    diff.data,
    width,
    height,
    { threshold: VISUAL_DIFF_PIXEL_TOLERANCE, includeAA: false },
  );

  // Do NOT encodeURIComponent(testId) here: the filename is consumed both as
  // a filesystem path (via fs.writeFileSync) and as a URL path segment (via
  // `/artifacts/diffs/…`). Express URL-decodes the path before the filesystem
  // lookup + HMAC verify in appSetup.js, so any %-encoded bytes would cause
  // a 404 / invalid-signature. Test IDs from `generateTestId()` are already
  // path-safe (uppercase + digits + hyphens).
  const diffName = `${runId}-${testId}-step${stepNumber}.png`;
  const diffAbs = path.join(DIFFS_DIR, diffName);
  try {
    fs.writeFileSync(diffAbs, PNG.sync.write(diff));
  } catch {
    return { status: "error", message: "failed to write diff PNG" };
  }

  const totalPixels = width * height;
  const diffRatio = totalPixels > 0 ? diffPixels / totalPixels : 0;
  const status = diffRatio > VISUAL_DIFF_THRESHOLD ? "regression" : "match";

  return {
    status,
    diffPixels,
    totalPixels,
    diffRatio,
    threshold: VISUAL_DIFF_THRESHOLD,
    baselinePath: existing.row.imagePath,
    diffPath: `/artifacts/diffs/${diffName}`,
  };
}

/**
 * Promote a previously-captured screenshot to the new baseline for a test step.
 *
 * Called from the "Accept visual changes" action on the run detail page.
 *
 * @param {Object} args
 * @param {string} args.testId
 * @param {number} [args.stepNumber=0]
 * @param {string} args.sourceAbsPath - Absolute filesystem path to the PNG to promote.
 * @returns {{ baselinePath: string }}
 * @throws {Error} When the source file cannot be read.
 */
export function acceptBaseline({ testId, stepNumber = 0, sourceAbsPath }) {
  const buf = fs.readFileSync(sourceAbsPath);
  const { publicPath } = persistBaseline(testId, stepNumber, buf);
  return { baselinePath: publicPath };
}
