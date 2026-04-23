/**
 * @module database/repositories/baselineRepo
 * @description Visual regression baseline CRUD (DIF-001).
 *
 * Baselines are the "golden" screenshots that subsequent runs diff against.
 * Each row references a PNG on disk under `artifacts/baselines/<testId>/`.
 * Rows are identified by `(testId, stepNumber)` — `stepNumber = 0` is the
 * final end-of-test screenshot, `stepNumber >= 1` are per-step captures
 * (DIF-016).
 */

import { getDatabase } from "../sqlite.js";

/**
 * Get a baseline entry for a specific test + step.
 *
 * @param {string} testId
 * @param {number} [stepNumber=0]
 * @returns {Object|undefined}
 */
export function get(testId, stepNumber = 0) {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM baseline_screenshots WHERE testId = ? AND stepNumber = ?"
  ).get(testId, stepNumber) || undefined;
}

/**
 * List all baselines for a test, ordered by stepNumber.
 *
 * @param {string} testId
 * @returns {Array<Object>}
 */
export function getAllByTestId(testId) {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM baseline_screenshots WHERE testId = ? ORDER BY stepNumber ASC"
  ).all(testId);
}

/**
 * Upsert a baseline row. Creates on first call, updates `updatedAt` on
 * subsequent calls (used when the user accepts visual changes).
 *
 * @param {Object} entry
 * @param {string} entry.testId
 * @param {number} entry.stepNumber
 * @param {string} entry.imagePath   - Relative artifact path (e.g. `/artifacts/baselines/TC-1/step-0.png`).
 * @param {number} [entry.width]
 * @param {number} [entry.height]
 * @returns {void}
 */
export function upsert(entry) {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO baseline_screenshots (testId, stepNumber, imagePath, width, height, createdAt, updatedAt)
    VALUES (@testId, @stepNumber, @imagePath, @width, @height, @createdAt, @updatedAt)
    ON CONFLICT(testId, stepNumber) DO UPDATE SET
      imagePath = @imagePath,
      width = @width,
      height = @height,
      updatedAt = @updatedAt
  `).run({
    testId: entry.testId,
    stepNumber: entry.stepNumber ?? 0,
    imagePath: entry.imagePath,
    width: entry.width ?? null,
    height: entry.height ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Delete all baselines for a test (invoked when a test is hard-deleted).
 *
 * @param {string} testId
 * @returns {number} rows deleted
 */
export function deleteByTestId(testId) {
  const db = getDatabase();
  const info = db.prepare("DELETE FROM baseline_screenshots WHERE testId = ?").run(testId);
  return info.changes || 0;
}

/**
 * Delete a single baseline row for a specific test + step.
 *
 * @param {string} testId
 * @param {number} stepNumber
 * @returns {number} rows deleted
 */
export function deleteOne(testId, stepNumber) {
  const db = getDatabase();
  const info = db.prepare(
    "DELETE FROM baseline_screenshots WHERE testId = ? AND stepNumber = ?"
  ).run(testId, stepNumber);
  return info.changes || 0;
}
