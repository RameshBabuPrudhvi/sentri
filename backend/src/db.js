// Simple in-memory store. Swap for Postgres/SQLite in production.
let _db = null;

export function getDb() {
  if (!_db) {
    _db = {
      projects: {},
      tests: {},
      runs: {},
      // Activity log: captures all user/system actions so the Work page can
      // show a complete timeline — not just runs.
      // Type convention — dot-separated: <resource>.<action>
      //   project.create
      //   crawl.start / crawl.complete / crawl.fail
      //   test_run.start / test_run.complete / test_run.fail
      //   test.create / test.generate / test.regenerate / test.edit / test.delete
      //   test.approve / test.reject / test.restore
      //   test.bulk_approve / test.bulk_reject / test.bulk_restore
      //   settings.update
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
