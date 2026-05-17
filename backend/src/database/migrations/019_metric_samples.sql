CREATE TABLE IF NOT EXISTS metric_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  projectId TEXT NOT NULL,
  metricKey TEXT NOT NULL,
  ts INTEGER NOT NULL,
  value REAL NOT NULL,
  tags TEXT,
  createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_metric_samples_project_key_ts ON metric_samples(projectId, metricKey, ts);
