-- SEC-007 Part C: per-workspace SIEM forwarder configuration.
--
-- Stores admin-configured webhook target for forwarding every audit
-- event to a SIEM (Splunk HEC, Datadog Logs Intake, Elastic ingest,
-- syslog-over-HTTPS, etc.). Per-workspace because multi-tenant
-- deployments need different SIEM targets per customer.
--
-- One row per workspace at most (workspaceId is the PRIMARY KEY).
--
-- Columns:
--   targetUrl   — full URL the forwarder POSTs to. Validated via SSRF
--                 guard at write time (same protection as notification
--                 webhooks).
--   hmacSecret  — AES-256-GCM encrypted at rest via credentialEncryption.
--                 Used to compute X-Sentri-Audit-Signature on every
--                 dispatched event. NEVER returned to the client —
--                 GET /siem-config masks all but the last 4 chars.
--   headersJson — optional JSON object of custom headers (e.g. Splunk
--                 HEC Authorization tokens). Stored as TEXT; parsed by
--                 the forwarder. Bounded to 4096 chars at write time.
--   enabled     — INTEGER (0/1) — when 0, forwarder skips dispatch
--                 without raising an error. Lets admins quickly
--                 silence a misbehaving SIEM target without deleting
--                 the config.
CREATE TABLE IF NOT EXISTS workspace_siem_config (
  workspaceId TEXT PRIMARY KEY,
  targetUrl   TEXT NOT NULL,
  hmacSecret  TEXT NOT NULL,        -- encrypted via credentialEncryption
  headersJson TEXT NULL,            -- optional custom headers as JSON
  enabled     INTEGER NOT NULL DEFAULT 1,
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);
