/**
 * @module aiProvider/protocolForProvider
 * @description Single source of truth for the legacy-`provider` →
 *   `(family, protocol)` mapping shared between runtime route synthesis
 *   (`registry.js#synthesiseTransientRoute`) and the B2.1 backfill
 *   script. A drift between the two would silently route migrated
 *   agents through the wrong wire protocol — e.g. an `openrouter` route
 *   synthesised under the `anthropic` protocol fails with a 400 deep
 *   inside the SDK, with no useful error message.
 *
 * Add new providers in ONE place (this file). Both consumers pick up
 * the change automatically.
 *
 * Kept dependency-light on purpose — the backfill script imports this
 * module and we don't want it to drag in `registry.js` (which owns
 * mutable runtime state, the breaker map, sticky fallbacks, etc.). A
 * one-off CLI script touching offline DB rows shouldn't have to load a
 * stateful module that's designed for the request hot path.
 */

// Wire-protocol family. Compat slots and OpenRouter both speak the
// OpenAI wire format, so they map to `openai`. Local Ollama speaks its
// own protocol.
const PROTOCOL_MAP = Object.freeze({
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openai",
  google: "gemini",
  local: "ollama",
});

/**
 * Detect a compat-slot provider id (`compat:<slot>`).
 * Local copy (rather than importing `isCompatProvider` from
 * `registry.js`) to avoid the import cycle described in the module
 * JSDoc — backfill must not load the runtime registry.
 */
function isCompatProvider(provider) {
  return typeof provider === "string"
    && provider.startsWith("compat:")
    && provider.length > "compat:".length;
}

/**
 * Resolve the wire-level protocol for a legacy `provider` enum value.
 *
 * @param {string} provider - `"anthropic"` | `"openai"` | `"openrouter"`
 *   | `"google"` | `"local"` | `"compat:<slot>"`.
 * @returns {string} One of `"anthropic" | "openai" | "gemini" | "ollama"`.
 * @throws {Error} An Error with `code === "ERR_UNKNOWN_PROTOCOL"` when
 *   the provider isn't mappable. Callers MUST handle this — silently
 *   defaulting to `"openai"` would route the request under the wrong
 *   wire format and surface as a confusing 400 inside the SDK.
 */
export function protocolForProvider(provider) {
  if (isCompatProvider(provider)) return "openai";
  const mapped = PROTOCOL_MAP[provider];
  if (mapped) return mapped;
  const err = new Error(
    `Unknown provider "${provider}" — add it to PROTOCOL_MAP in ` +
    `backend/src/aiProvider/protocolForProvider.js, or assign ` +
    `agent_configs.routeId to a real provider_routes row.`,
  );
  err.code = "ERR_UNKNOWN_PROTOCOL";
  throw err;
}

/**
 * Resolve the `provider_routes.family` enum value for a legacy
 * `provider` enum value. Compat slots collapse to the catch-all
 * `"custom"` family (matches the schema comment in migration
 * `035_provider_routes.sql`).
 *
 * @param {string} provider
 * @returns {"anthropic"|"openai"|"google"|"openrouter"|"local"|"custom"}
 */
export function familyForProvider(provider) {
  if (isCompatProvider(provider)) return "custom";
  return provider;
}
