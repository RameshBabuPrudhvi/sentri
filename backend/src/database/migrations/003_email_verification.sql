-- Migration 003: Email verification (SEC-001)
--
-- Adds email verification support to the registration flow.
-- New users are created with emailVerified = 0 (false) and must verify
-- their email address before they can log in.
--
-- The verification_tokens table stores one-time tokens sent via email.
-- Tokens expire after 24 hours and are single-use (usedAt set on verification).

-- ── Add emailVerified column to users ──────────────────────────────────────
-- Existing users are grandfathered in as verified (DEFAULT 1) so this
-- migration is non-breaking for current deployments.
ALTER TABLE users ADD COLUMN emailVerified INTEGER NOT NULL DEFAULT 1;

-- ── verification_tokens table ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS verification_tokens (
  token     TEXT PRIMARY KEY,          -- 32-byte cryptographically random base64url string
  userId    TEXT NOT NULL,             -- references users(id)
  email     TEXT NOT NULL,             -- email address at time of registration
  expiresAt TEXT NOT NULL,             -- ISO 8601; checked on every verification
  usedAt    TEXT,                      -- NULL = unused; set on successful verification
  createdAt TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vt_userId    ON verification_tokens(userId);
CREATE INDEX IF NOT EXISTS idx_vt_expiresAt ON verification_tokens(expiresAt);
