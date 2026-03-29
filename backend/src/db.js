// Simple in-memory store. Swap for Postgres/SQLite in production.
let _db = null;

export function getDb() {
  if (!_db) {
    _db = {
      projects: {},
      tests: {},
      runs: {},
      // Self-healing history: records which selector strategy succeeded for
      // each element so future runs try the winning strategy first.
      // Key: "<testId>::<action>::<label>" → { strategy, succeededAt, failCount }
      healingHistory: {},
    };
  }
  return _db;
}
