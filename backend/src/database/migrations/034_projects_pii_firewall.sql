-- SEC-006 — per-project PII firewall controls
ALTER TABLE projects ADD COLUMN strictPiiFirewall INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN piiAllowlist TEXT;
