-- Migration 003: Persistent password reset tokens
-- Replaces the in-memory Map (lost on server restart) with a durable
-- DB-backed table so reset links survive deployments and work correctly
-- in multi-instance deployments.
--
-- TTL enforcement: tokens older than 30 minutes are invalid; the application
-- checks expiresAt and a periodic cleanup job deletes expired rows.
-- The usedAt column provides one-time-use enforcement without immediately
-- deleting the row (keeps an audit trail of token consumption).

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token     TEXT PRIMARY KEY,          -- 32-byte cryptographically random base64url string
  userId    TEXT NOT NULL,             -- references users(id)
  expiresAt TEXT NOT NULL,             -- ISO 8601; checked on every verification
  usedAt    TEXT,                      -- NULL = unused; set on successful password reset
  createdAt TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);

-- Index for efficient lookup by userId (invalidating all tokens for a user)
CREATE INDEX IF NOT EXISTS idx_prt_userId    ON password_reset_tokens(userId);
-- Index for efficient expired-token pruning
CREATE INDEX IF NOT EXISTS idx_prt_expiresAt ON password_reset_tokens(expiresAt);
