/**
 * @module utils/idGenerator
 * @description Short, human-readable ID generators.
 *
 * Produces IDs similar to major test management tools:
 * - Tests: `TC-1`, `TC-2` (like TestRail's C1234)
 * - Runs: `RUN-1`, `RUN-2` (like TestRail's R123)
 * - Projects: `PRJ-1`, `PRJ-2`
 * - Activities: `ACT-1`, `ACT-2`
 *
 * IDs are globally sequential and persisted in `db._counters`.
 *
 * ### Exports
 * - {@link generateTestId}, {@link generateRunId}, {@link generateProjectId}, {@link generateActivityId}
 * - {@link initCountersFromExistingData} — Seed counters from restored DB at startup.
 */

/**
 * Ensure the _counters bucket exists on the DB object.
 * Called lazily on first use — avoids import-order issues with db.js.
 */
function ensureCounters(db) {
  if (!db._counters) {
    db._counters = { test: 0, run: 0, project: 0, activity: 0 };
  }
  return db._counters;
}

/**
 * generateTestId(db) → "TC-1", "TC-2", …
 */
export function generateTestId(db) {
  const c = ensureCounters(db);
  c.test = (c.test || 0) + 1;
  return `TC-${c.test}`;
}

/**
 * generateRunId(db) → "RUN-1", "RUN-2", …
 */
export function generateRunId(db) {
  const c = ensureCounters(db);
  c.run = (c.run || 0) + 1;
  return `RUN-${c.run}`;
}

/**
 * generateProjectId(db) → "PRJ-1", "PRJ-2", …
 */
export function generateProjectId(db) {
  const c = ensureCounters(db);
  c.project = (c.project || 0) + 1;
  return `PRJ-${c.project}`;
}

/**
 * generateActivityId(db) → "ACT-1", "ACT-2", …
 */
export function generateActivityId(db) {
  const c = ensureCounters(db);
  c.activity = (c.activity || 0) + 1;
  return `ACT-${c.activity}`;
}

/**
 * initCountersFromExistingData(db)
 *
 * Called once at startup to seed counters from existing data restored from disk.
 * Scans all existing IDs and sets counters to max(existing) so new IDs don't
 * collide with previously generated ones.
 */
export function initCountersFromExistingData(db) {
  const c = ensureCounters(db);

  function maxNum(obj, prefix) {
    let max = 0;
    for (const key of Object.keys(obj || {})) {
      if (key.startsWith(prefix)) {
        const n = parseInt(key.slice(prefix.length), 10);
        if (n > max) max = n;
      }
    }
    return max;
  }

  c.test     = Math.max(c.test     || 0, maxNum(db.tests,      "TC-"));
  c.run      = Math.max(c.run      || 0, maxNum(db.runs,       "RUN-"));
  c.project  = Math.max(c.project  || 0, maxNum(db.projects,   "PRJ-"));
  c.activity = Math.max(c.activity || 0, maxNum(db.activities,  "ACT-"));
}
