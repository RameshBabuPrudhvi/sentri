/**
 * @module database/repositories/testFixtureRepo
 * @description Data-driven test fixture CRUD (CAP-001).
 *
 * A fixture is a CSV / JSON row-set bound to a specific test version. The
 * runner replays the test once per row, substituting `{{column}}` placeholders
 * in `playwrightCode` from the row values. Rows are persisted as a JSON blob
 * in the `rows` column (parsed lazily on read via `rowToFixture`); the column
 * is `TEXT` rather than the dialect-specific `JSON` type so the same SQL
 * works on SQLite and Postgres without an adapter shim.
 *
 * Rows are keyed on `(testId, version)` where `version` mirrors
 * `tests.codeVersion` — a new code version (e.g. after an AI fix bumps the
 * test body) starts with a fresh fixture slot. Old fixtures stay around for
 * run-history replay rather than being cascade-deleted on version bump.
 */

import { getDatabase } from "../sqlite.js";

/**
 * Map a raw `test_fixtures` row to its public shape, parsing the JSON `rows`
 * column into an array. Returns `undefined` for missing rows so callers can
 * use the same `if (!fixture) return …` pattern as the sibling repos.
 *
 * @param {Object|undefined} row
 * @returns {Object|undefined}
 */
function rowToFixture(row) {
  if (!row) return undefined;
  return { ...row, rows: row.rows ? JSON.parse(row.rows) : [] };
}

/**
 * Upsert a fixture row. Creates on first call, replaces on subsequent calls
 * at the same `(testId, version)` — re-uploading at the same code version is
 * intentionally a replace rather than an append so the fixture panel's
 * history table never grows unbounded for a single version.
 *
 * @param {Object} entry
 * @param {string} entry.testId
 * @param {number} entry.version
 * @param {"csv"|"json"} entry.format
 * @param {Array<Object>} entry.rows
 * @returns {Object} The freshly persisted fixture row.
 */
export function upsertFixture({ testId, version, format, rows }) {
  const db = getDatabase();
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO test_fixtures (testId, version, format, rows, createdAt)
    VALUES (@testId, @version, @format, @rows, @createdAt)
    ON CONFLICT(testId, version) DO UPDATE SET
      format = excluded.format,
      rows = excluded.rows,
      createdAt = excluded.createdAt
  `).run({
    testId,
    version,
    format,
    rows: JSON.stringify(rows || []),
    createdAt,
  });
  return getFixture(testId, version);
}

/**
 * Get a fixture row for a specific test + version.
 *
 * @param {string} testId
 * @param {number} version
 * @returns {Object|undefined}
 */
export function getFixture(testId, version) {
  const db = getDatabase();
  return rowToFixture(
    db.prepare("SELECT * FROM test_fixtures WHERE testId = ? AND version = ?").get(testId, version),
  );
}

/**
 * List all fixtures for a test, newest version first. Powers the history
 * table in the Test Detail fixture panel.
 *
 * @param {string} testId
 * @returns {Array<Object>}
 */
export function listFixtures(testId) {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM test_fixtures WHERE testId = ? ORDER BY version DESC",
  ).all(testId).map(rowToFixture);
}
