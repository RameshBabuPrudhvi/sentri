-- Migration 005: Persist AI provider API keys encrypted in the database
-- Replaces the process-level runtimeKeys object (lost on every server restart)
-- with a durable DB-backed table so configured keys survive deployments and
-- are available immediately after startup without user re-entry.
--
-- Security: key values are encrypted with AES-256-GCM using the same
-- credentialEncryption utility already used for project credentials.
-- The plaintext key is never persisted — only the encrypted blob.
--
-- Scope: cloud providers only (anthropic, openai, google).
-- Ollama config (baseUrl, model, disabled) uses its own row with
-- provider = 'local' and a JSON-encoded value field.

CREATE TABLE IF NOT EXISTS api_keys (
  provider    TEXT PRIMARY KEY,   -- 'anthropic' | 'openai' | 'google' | 'local'
  value       TEXT NOT NULL,      -- AES-256-GCM encrypted key (cloud) or JSON config (local)
  updatedAt   TEXT NOT NULL       -- ISO 8601 timestamp of last write
);
