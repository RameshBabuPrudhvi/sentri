CREATE TABLE IF NOT EXISTS test_fixtures (
  testId TEXT NOT NULL,
  version INTEGER NOT NULL,
  format TEXT NOT NULL CHECK (format IN ("csv", "json")),
  rows TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (testId, version)
);

CREATE INDEX IF NOT EXISTS idx_test_fixtures_testId ON test_fixtures(testId);
