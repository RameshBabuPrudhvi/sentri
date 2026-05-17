CREATE TABLE IF NOT EXISTS crawl_baselines (
  projectId TEXT NOT NULL,
  pageUrl TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  capturedAt TEXT NOT NULL,
  PRIMARY KEY (projectId, pageUrl)
);

CREATE INDEX IF NOT EXISTS idx_crawl_baselines_project ON crawl_baselines(projectId);
