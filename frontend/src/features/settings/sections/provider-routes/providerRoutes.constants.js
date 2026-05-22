/**
 * Provider Routes section constants (GAP-002). Extracted verbatim from the
 * legacy Settings.jsx. Mirrors migration 035's family / protocol enum values
 * + protocolForProvider.PROTOCOL_MAP — kept inline so the dropdowns don't
 * round-trip to the server every render.
 */

export const PR_FAMILIES  = ["anthropic", "openai", "google", "openrouter", "local", "custom"];
export const PR_PROTOCOLS = ["openai", "anthropic", "gemini", "ollama"];

export const PR_FORM_EMPTY = {
  id: null,
  name: "",
  family: "openai",
  protocol: "openai",
  baseUrl: "",
  model: "",
  apiKey: "",
  enabled: true,
  rpmLimit: "",
  tpmLimit: "",
  cacheEnabled: false,
  cacheTtlSec: "",
  fallbackRouteId: "",
};

/** B3.9 — audit log action enum (matches `provider_route_audit.action` CHECK). */
export const AUDIT_ACTIONS  = ["create", "update", "delete", "rotate_key", "probe", "export", "import"];
export const AUDIT_PAGE_SIZE = 50;

/** B2.5 — AI request-log outcome enum. */
export const AI_REQ_OUTCOMES  = ["success", "error", "rate_limited"];
export const AI_REQ_PAGE_SIZE = 50;
