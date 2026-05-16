-- SEC-004: per-workspace MFA enforcement policy.
--
-- `mfaRequired = 1` blocks login (password + OAuth) for any member whose
-- account has `mfaEnabled = 0` once they are past the grace window. The
-- grace window starts when the policy is enabled (or at user creation for
-- new members) and lasts `mfaGracePeriodDays` calendar days — so admins can
-- flip the toggle without locking out existing members on day one.
--
-- Defaults match the OWASP / SOC 2 starter posture: off by default, 7-day
-- grace when enabled. Pre-migration workspaces inherit the defaults.
ALTER TABLE workspaces ADD COLUMN mfaRequired INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN mfaGracePeriodDays INTEGER NOT NULL DEFAULT 7;
ALTER TABLE workspaces ADD COLUMN mfaPolicyUpdatedAt TEXT;
