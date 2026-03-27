// Simple in-memory store. Swap for Postgres/SQLite in production.
let _db = null;

export function getDb() {
  if (!_db) {
    _db = {
      projects: {},
      tests: {},
      runs: {},
    };
  }
  return _db;
}
