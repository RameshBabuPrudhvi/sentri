// Simple in-memory store. Swap for Postgres/SQLite in production.
let _db = null;

export function getDb() {
  if (!_db) {
    _db = {
      projects: {},
      tests: {},
      runs: {},
      // Activity log: captures all user/system actions (generate, regenerate,
      // approve, reject, edit, create, delete, crawl, test_run) so the Work
      // page can show a complete timeline — not just runs.
      // Each entry: { id, type, projectId, projectName, testId?, testName?,
      //              detail?, status, createdAt }
      activities: {},
      // Self-healing history: records which selector strategy succeeded for
      // each element so future runs try the winning strategy first.
      // Key: "<testId>::<action>::<label>" → { strategy, succeededAt, failCount }
      healingHistory: {},
    };
  }
  return _db;
}
