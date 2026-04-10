/**
 * @module database/repositories/healingRepo
 * @description Self-healing history CRUD backed by SQLite.
 */

import { getDatabase } from "../sqlite.js";

/**
 * Get a healing entry by key.
 * @param {string} key — "<testId>::<action>::<label>"
 * @returns {Object|undefined}
 */
export function get(key) {
  const db = getDatabase();
  return db.prepare("SELECT * FROM healing_history WHERE key = ?").get(key) || undefined;
}

/**
 * Upsert a healing entry.
 * @param {string} key
 * @param {Object} entry — { strategyIndex, succeededAt, failCount }
 */
export function set(key, entry) {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO healing_history (key, strategyIndex, succeededAt, failCount)
    VALUES (@key, @strategyIndex, @succeededAt, @failCount)
    ON CONFLICT(key) DO UPDATE SET
      strategyIndex = @strategyIndex,
      succeededAt = @succeededAt,
      failCount = @failCount
  `).run({
    key,
    strategyIndex: entry.strategyIndex ?? -1,
    succeededAt: entry.succeededAt || null,
    failCount: entry.failCount || 0,
  });
}

/**
 * Get all healing entries as a dictionary keyed by composite key.
 * @returns {Object<string, Object>}
 */
export function getAllAsDict() {
  const db = getDatabase();
  const rows = db.prepare("SELECT * FROM healing_history").all();
  const dict = {};
  for (const r of rows) dict[r.key] = r;
  return dict;
}

/**
 * Get all healing entries for a specific test (keys starting with "<testId>::").
 * @param {string} testId
 * @returns {Object<string, Object>} Map of `"action::label"` → entry.
 */
export function getByTestId(testId) {
  const db = getDatabase();
  const prefix = `${testId}::`;
  const rows = db.prepare("SELECT * FROM healing_history WHERE key LIKE ?").all(`${prefix}%`);
  const result = {};
  for (const r of rows) {
    result[r.key.slice(prefix.length)] = r;
  }
  return result;
}

/**
 * Delete healing entries for a list of test IDs.
 * @param {string[]} testIds
 */
export function deleteByTestIds(testIds) {
  const db = getDatabase();
  const stmt = db.prepare("DELETE FROM healing_history WHERE key LIKE ?");
  const txn = db.transaction(() => {
    for (const tid of testIds) {
      stmt.run(`${tid}::%`);
    }
  });
  txn();
}

/**
 * Delete all healing entries.
 * @returns {number}
 */
export function clearAll() {
  const db = getDatabase();
  const count = db.prepare("SELECT COUNT(*) as cnt FROM healing_history").get().cnt;
  db.prepare("DELETE FROM healing_history").run();
  return count;
}

/**
 * Count total entries.
 * @returns {number}
 */
export function count() {
  const db = getDatabase();
  return db.prepare("SELECT COUNT(*) as cnt FROM healing_history").get().cnt;
}

/**
 * Count entries where strategyIndex >= 0 and succeededAt is not null.
 * @returns {number}
 */
export function countSuccesses() {
  const db = getDatabase();
  return db.prepare(
    "SELECT COUNT(*) as cnt FROM healing_history WHERE strategyIndex >= 0 AND succeededAt IS NOT NULL"
  ).get().cnt;
}
