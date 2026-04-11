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
// Lazy migration flag — ensures the strategyVersion column exists before first use.
let _migrated = false;
function ensureStrategyVersionColumn(db) {
  if (_migrated) return;
  try { db.prepare("ALTER TABLE healing_history ADD COLUMN strategyVersion INTEGER").run(); } catch { /* already exists */ }
  _migrated = true;
}

export function set(key, entry) {
  const db = getDatabase();
  ensureStrategyVersionColumn(db);
  db.prepare(`
    INSERT INTO healing_history (key, strategyIndex, succeededAt, failCount, strategyVersion)
    VALUES (@key, @strategyIndex, @succeededAt, @failCount, @strategyVersion)
    ON CONFLICT(key) DO UPDATE SET
      strategyIndex = @strategyIndex,
      succeededAt = @succeededAt,
      failCount = @failCount,
      strategyVersion = @strategyVersion
  `).run({
    key,
    strategyIndex: entry.strategyIndex ?? -1,
    succeededAt: entry.succeededAt || null,
    failCount: entry.failCount || 0,
    strategyVersion: entry.strategyVersion ?? null,
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
 *
 * Accepts both raw test IDs (`"TC-1"`) and versioned scope IDs
 * (`"TC-1@v2"`).  When a versioned scope is passed we also query the
 * legacy (unversioned) prefix so that pre-existing healing entries
 * remain readable after upgrading to versioned scopes.
 *
 * @param {string} testId — raw test ID or versioned scope ID
 * @returns {Object<string, Object>} Map of `"action::label"` → entry.
 */
export function getByTestId(testId) {
  const db = getDatabase();

  // Strip the @vN suffix (if present) to derive the base test ID so we
  // can also query legacy keys stored before versioned scopes existed.
  const baseId = testId.replace(/@v\d+$/, "");

  const patterns = [`${testId}::%`];
  // When testId already contains @v, also query unversioned legacy keys
  if (baseId !== testId) {
    patterns.push(`${baseId}::%`);
  }
  // Also query any other versioned keys for this base ID
  patterns.push(`${baseId}@v%::%`);

  // Build a query with the right number of OR clauses
  const uniquePatterns = [...new Set(patterns)];
  const whereClauses = uniquePatterns.map(() => "key LIKE ?").join(" OR ");
  const rows = db.prepare(
    `SELECT * FROM healing_history WHERE ${whereClauses}`
  ).all(...uniquePatterns);

  const result = {};
  for (const r of rows) {
    const sepIdx = r.key.indexOf("::");
    if (sepIdx < 0) continue;
    result[r.key.slice(sepIdx + 2)] = r;
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
      stmt.run(`${tid}@v%::%`);
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
