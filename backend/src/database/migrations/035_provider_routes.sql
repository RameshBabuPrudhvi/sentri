-- B1.1 — provider_routes
--
-- Per-workspace "route" rows defining a concrete LLM endpoint a workspace can
-- dispatch against. A route bundles together the wire protocol (openai /
-- anthropic / gemini / ollama), the base URL, the model id, an encrypted API
-- key, probed capabilities, pricing, per-route quotas, optional response
-- caching, and a fallback chain. Subsequent bundles fill in the nullable
-- columns (B1.4 encryption, B2 capabilities + pricing, B3 quotas + caching)
-- — every column is created up front so later bundles don't have to run
-- schema migrations against a hot table.
--
-- Naming:
--   UNIQUE(workspaceId, name) — admins reference routes by human name
--   ("anthropic-prod", "ollama-local") rather than the surrogate id.
--
-- Encryption (B1.4):
--   apiKeyEncrypted + apiKeyNonce hold the AES-256-GCM ciphertext + nonce.
--   apiKeyLastFour mirrors the last 4 chars of the plaintext key for UI
--   "••••abcd" display so the Settings page never has to decrypt for render.
--
-- Fallback chain:
--   fallbackRouteId is a self-referential FK with ON DELETE SET NULL so
--   deleting a fallback target unlinks the chain rather than cascading.
--   Cycle detection is enforced at the repo layer (mirrors the agent_configs
--   fallbackRole guard added in AI-005).

CREATE TABLE IF NOT EXISTS provider_routes (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  family TEXT NOT NULL,                 -- anthropic|openai|google|ollama|custom
  protocol TEXT NOT NULL,               -- openai|anthropic|gemini|ollama
  baseUrl TEXT,
  model TEXT NOT NULL,
  -- Encrypted secret (B1.4)
  apiKeyEncrypted BLOB,                 -- AES-256-GCM ciphertext
  apiKeyNonce BLOB,
  apiKeyLastFour TEXT,                  -- for UI display ••••abcd
  -- Capabilities (probed in B2)
  capabilities TEXT,                    -- JSON
  -- Pricing (set in B2)
  pricing TEXT,                         -- JSON: { inputPerMtok, outputPerMtok, currency }
  -- Quotas (enforced in B3)
  rpmLimit INTEGER,                     -- null = unlimited
  tpmLimit INTEGER,
  -- Caching (enabled in B3)
  cacheEnabled INTEGER NOT NULL DEFAULT 0,
  cacheTtlSec INTEGER NOT NULL DEFAULT 3600,
  -- Fallback chain
  fallbackRouteId TEXT REFERENCES provider_routes(id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(workspaceId, name)
);
CREATE INDEX IF NOT EXISTS idx_provider_routes_workspace ON provider_routes(workspaceId);
