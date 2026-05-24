/**
 * @module aiProvider/modelCatalog
 * @description Static provider metadata + capability flags + AI-003 per-model
 * pricing. No mutable state, no imports from any sibling module — pure leaf
 * data + tiny helpers.
 *
 * Dependency graph (acyclic, modelCatalog is a leaf):
 *   modelCatalog.js  ← (no sibling imports)
 *   registry.js      → modelCatalog.js
 *   providerInfo.js  → modelCatalog.js + registry.js (+ owns getModelCatalog)
 *   dispatcher.js    → modelCatalog.js + registry.js + providerInfo.js
 *   vision.js        → providerInfo.js + dispatcher.js + modelCatalog.js
 *   index.js         → all of the above (barrel + generateText/streamText)
 *
 * `getModelCatalog()` (which combines per-provider runtime metadata with
 * pricing) lives in providerInfo.js so this file stays a leaf — pure-
 * arithmetic tests like `ai-provider-cost-tracking.test.js` import only
 * this module and pull zero SDK / DB / metrics dependencies.
 */

// ── Cloud provider env-var map ───────────────────────────────────────────────
// Single source of truth shared by registry.js and the orchestrator.
export const CLOUD_KEY_MAP = {
  anthropic:  "ANTHROPIC_API_KEY",
  openai:     "OPENAI_API_KEY",
  google:     "GOOGLE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

// Detection order used by `detectProvider()` — cloud first, then compat
// slots (handled by the orchestrator), then Ollama.
export const CLOUD_DETECT_ORDER = ["anthropic", "openai", "google", "openrouter"];

/**
 * Canonical default endpoint for OpenRouter dispatch. Single source of
 * truth shared by:
 *
 *   • `dispatcher.js#OPENROUTER_BASE_URL` (legacy provider-driven path)
 *   • `registry.js#synthesiseTransientRoute` (synthesised env-route baseUrl)
 *   • `protocols/openai.js#getFamilyDefaultBaseUrl` (route-driven safety net)
 *
 * Reading `process.env.OPENROUTER_BASE_URL` at call time honours the
 * documented self-hosted-proxy override (see `REFERENCE.md` +
 * `docker-compose.yml`) without freezing the value at module load.
 * Returning the URL string keeps every consumer's wiring identical.
 *
 * @returns {string} The OpenRouter API base URL.
 */
export function getOpenRouterBaseUrl() {
  return process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";
}

// Per-provider default models — overridable via env vars. B4.1: the
// `color` field is the brand-aligned hex for Settings UI / dropdowns.
// Co-located here so `providerInfo.js#buildProviderMeta` derives the
// full per-family record from a single source of truth instead of
// re-hardcoding the family enum (which used to drift between this
// catalog and the meta builder).
export const CLOUD_DEFAULT_MODELS = {
  anthropic:  { envVar: "ANTHROPIC_MODEL",  fallback: "claude-sonnet-4-20250514", name: "Claude Sonnet",   color: "#cd7f32" },
  openai:     { envVar: "OPENAI_MODEL",     fallback: "gpt-4o-mini",              name: "GPT-4o-mini",     color: "#10a37f" },
  google:     { envVar: "GOOGLE_MODEL",     fallback: "gemini-2.5-flash",         name: "Gemini 2.5 Flash", color: "#4285f4" },
  openrouter: { envVar: "OPENROUTER_MODEL", fallback: "openrouter/auto",          name: "OpenRouter",      color: "#6466f1" },
};

/**
 * B4.1 — Resolve the brand-aligned hex color for a provider family.
 * Used by the Settings UI / header dropdown / Provider Routes badges.
 * Falls back to the generic accent for compat slots and Ollama (which
 * are handled outside `CLOUD_DEFAULT_MODELS`).
 *
 * @param {string} provider
 * @returns {string} hex colour
 */
export function getCloudColor(provider) {
  return CLOUD_DEFAULT_MODELS[provider]?.color || "#6466f1";
}

export const PROVIDER_DOCS = {
  anthropic:  "https://console.anthropic.com/settings/keys",
  openai:     "https://platform.openai.com/api-keys",
  google:     "https://aistudio.google.com/apikey",
  openrouter: "https://openrouter.ai/keys",
  local:      "https://ollama.ai",
};

// MNT-001 vision whitelist. Bypassed by VISION_MODEL env override.
export const VISION_CAPABLE_MODELS = new Set([
  "claude-3-5-sonnet-20241022", "claude-3-5-sonnet-20240620",
  "claude-3-opus-20240229", "claude-sonnet-4-20250514",
  "gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4-vision-preview",
  "gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.5-flash",
]);

// AI-003 — Per-provider capability flags. `supportsVision` requires *both*
// a vision-capable provider family AND a vision-capable model (checked via
// VISION_CAPABLE_MODELS at the call site). `supportsJsonMode` is the
// `response_format: { type: "json_object" }` / `responseMimeType` flag.
// `supportsStreaming` reflects whether the adapter's `stream()` returns a
// real token stream (`true`) or the `null` sentinel that falls back to
// non-streaming generate() (`false`) — Gemini's SDK and Ollama's
// `/api/generate` don't expose incremental streaming from this codebase, so
// the orchestrator and the planner (AI-005) need to know up-front to avoid
// promising the caller a UX they won't get.
// `maxOutputTokens` is the vendor-documented hard cap on a single response;
// `contextWindow` is the prompt+response limit. Compat slots inherit OpenAI
// capability defaults — overridable by future per-slot metadata work.
export const CAPABILITIES = {
  anthropic:  { supportsVision: true,  supportsJsonMode: false, supportsStreaming: true,  contextWindow: 200_000,   maxOutputTokens: 8_192 },
  openai:     { supportsVision: true,  supportsJsonMode: true,  supportsStreaming: true,  contextWindow: 128_000,   maxOutputTokens: 16_384 },
  google:     { supportsVision: true,  supportsJsonMode: true,  supportsStreaming: false, contextWindow: 1_000_000, maxOutputTokens: 8_192 },
  openrouter: { supportsVision: true,  supportsJsonMode: true,  supportsStreaming: true,  contextWindow: null,      maxOutputTokens: null },
  local:      { supportsVision: false, supportsJsonMode: true,  supportsStreaming: false, contextWindow: 4_096,     maxOutputTokens: 4_096 },
  // `compat:*` providers fall through to OpenAI capability defaults — see
  // capabilitiesFor() below.
};

/** Resolve per-provider capabilities, with sane defaults for compat slots. */
export function capabilitiesFor(provider) {
  if (CAPABILITIES[provider]) return CAPABILITIES[provider];
  if (typeof provider === "string" && provider.startsWith("compat:")) {
    // Compat slots speak the OpenAI wire format; they get OpenAI's
    // capability defaults except for `supportsVision` (the operator's
    // chosen endpoint may not be vision-capable — assume false, override
    // via per-slot metadata in a future PR).
    return { supportsVision: false, supportsJsonMode: true, supportsStreaming: true, contextWindow: null, maxOutputTokens: null };
  }
  // Unknown provider — conservative defaults so a typo doesn't promise
  // vision support that doesn't exist.
  return { supportsVision: false, supportsJsonMode: false, supportsStreaming: false, contextWindow: null, maxOutputTokens: null };
}

// ── AI-003 — Per-(provider, model) pricing table ─────────────────────────────
// Maintainer-owned. When a vendor publishes new prices: edit the entry,
// bump `asOf` to today's date. PR title: `chore(pricing): refresh <provider>
// rates`. See docs/guide/ai-cost-tracking.md for the full update workflow.
//
// Pricing is per 1k tokens (NOT per 1M) so a single multiplication against
// the `usage.input` / `usage.output` token counts (divided by 1000) yields
// USD. Per-1k matches the convention used by every cloud LLM vendor's
// public pricing page.
//
// `asOf` is informational — it lets the planner agent (AI-005) and the SaaS
// unit-economics dashboards flag pricing entries that haven't been refreshed
// in N months as stale. The cost counter still emits using the recorded
// values; staleness is a UI / alert concern, not a runtime gate.
//
// Models not in this table emit `costUsd: null` from adapters (no fake
// zeros — see computeCostUsd() below). Ollama models are explicitly priced
// at 0/0 because they ARE free at the call site — distinguishing "free"
// from "unknown" is a dashboard requirement.
export const MODEL_PRICING = {
  // Anthropic — https://www.anthropic.com/pricing#anthropic-api
  "claude-sonnet-4-20250514":     { provider: "anthropic", inputPer1k: 0.003,  outputPer1k: 0.015,  asOf: "2026-04-01" },
  "claude-3-5-sonnet-20241022":   { provider: "anthropic", inputPer1k: 0.003,  outputPer1k: 0.015,  asOf: "2026-04-01" },
  "claude-3-5-sonnet-20240620":   { provider: "anthropic", inputPer1k: 0.003,  outputPer1k: 0.015,  asOf: "2026-04-01" },
  "claude-3-opus-20240229":       { provider: "anthropic", inputPer1k: 0.015,  outputPer1k: 0.075,  asOf: "2026-04-01" },

  // OpenAI — https://openai.com/api/pricing/
  "gpt-4o":                       { provider: "openai",    inputPer1k: 0.0025, outputPer1k: 0.010,  asOf: "2026-04-01" },
  "gpt-4o-mini":                  { provider: "openai",    inputPer1k: 0.00015,outputPer1k: 0.0006, asOf: "2026-04-01" },
  "gpt-4-turbo":                  { provider: "openai",    inputPer1k: 0.010,  outputPer1k: 0.030,  asOf: "2026-04-01" },
  "gpt-4-vision-preview":         { provider: "openai",    inputPer1k: 0.010,  outputPer1k: 0.030,  asOf: "2026-04-01" },

  // Google — https://ai.google.dev/pricing
  "gemini-2.5-flash":             { provider: "google",    inputPer1k: 0.000075,outputPer1k: 0.0003, asOf: "2026-04-01" },
  "gemini-1.5-flash":             { provider: "google",    inputPer1k: 0.000075,outputPer1k: 0.0003, asOf: "2026-04-01" },
  "gemini-1.5-pro":               { provider: "google",    inputPer1k: 0.00125, outputPer1k: 0.005,  asOf: "2026-04-01" },

  // OpenRouter — auto-routing model. Cost is set by the underlying model,
  // which OpenRouter reports per-call via `res.usage.cost`. We don't pin a
  // rate here — adapters that see a vendor-reported cost field should use
  // it directly; otherwise `costUsd: null` (catalog miss is correct).
  "openrouter/auto":              { provider: "openrouter", inputPer1k: null,  outputPer1k: null,   asOf: "2026-04-01" },

  // Ollama — local models, zero per-call cost. Listed explicitly so the
  // dashboard can render "$0.00" instead of "no data" for these models.
  "mistral:7b":                   { provider: "local",     inputPer1k: 0,      outputPer1k: 0,      asOf: "2026-04-01" },
  "llama3:8b":                    { provider: "local",     inputPer1k: 0,      outputPer1k: 0,      asOf: "2026-04-01" },
  "llama3.1:8b":                  { provider: "local",     inputPer1k: 0,      outputPer1k: 0,      asOf: "2026-04-01" },
  "llama3.2:3b":                  { provider: "local",     inputPer1k: 0,      outputPer1k: 0,      asOf: "2026-04-01" },
  "qwen2.5:7b":                   { provider: "local",     inputPer1k: 0,      outputPer1k: 0,      asOf: "2026-04-01" },
  "phi3:mini":                    { provider: "local",     inputPer1k: 0,      outputPer1k: 0,      asOf: "2026-04-01" },
  "gemma2:9b":                    { provider: "local",     inputPer1k: 0,      outputPer1k: 0,      asOf: "2026-04-01" },
};

/**
 * Look up pricing for a model. Returns `null` (NOT a zero-cost entry) when
 * the model is not in the catalog — `null` is the dashboard's signal for
 * "no data", distinct from a known-free model (Ollama) which is `0/0`.
 *
 * @param {string} model
 * @returns {Object|null} `{provider, inputPer1k, outputPer1k, asOf}` or `null`.
 */
export function pricingFor(model) {
  if (!model) return null;
  return MODEL_PRICING[model] || null;
}

/**
 * Brand emoji for each provider family. Used by the Settings UI → AI Providers
 * section and Agent Roles dropdown to give operators instant visual recognition
 * without relying on colour alone (accessibility). Kept here as a pure-data
 * constant so the UI and any future CLI surface share one definition.
 *
 * @type {Record<string, string>}
 */
export const FAMILY_EMOJI = {
  anthropic:  "🔶",
  openai:     "🟢",
  google:     "🔷",
  openrouter: "🧭",
  local:      "🦙",
  custom:     "🔧",
};

/**
 * Produce a human-readable cost-tier string for a model, suitable for
 * compact display in dropdowns and badges (e.g. "$3 / $15 per M tokens").
 * Returns "Free" for Ollama local models, "Variable" for OpenRouter auto,
 * and "Unknown pricing" when the model isn't in the catalog.
 *
 * @param {string} model
 * @returns {string}
 */
export function formatCostTier(model) {
  const p = pricingFor(model);
  if (!p) return "Unknown pricing";
  if (p.inputPer1k === 0 && p.outputPer1k === 0) return "Free (local)";
  if (p.inputPer1k == null || p.outputPer1k == null) return "Variable";
  const fmt = (n) => {
    if (n == null) return "?";
    const perM = n * 1000;
    return perM < 1 ? `$${(perM).toFixed(2)}` : `$${perM % 1 === 0 ? perM.toFixed(0) : perM.toFixed(1)}`;
  };
  return `${fmt(p.inputPer1k)} / ${fmt(p.outputPer1k)} per M`;
}

/**
 * AI-003 — Compute the USD cost for a single LLM call from the catalog. The
 * shared formula sits here so adapters and the orchestrator never disagree
 * on rounding / unit conventions, and the planner (AI-005) plus the budget
 * circuit-breaker (AI-007) read the same number the dashboard does.
 *
 * Returns `null` when:
 *   - `model` isn't in the catalog (catalog miss → "no data", not "$0")
 *   - both `inputPer1k` and `outputPer1k` are `null` (e.g. openrouter/auto
 *     where the underlying model varies per call)
 *   - `usage` is missing or has no usable token counts
 *
 * Returns `0` when the model is in the catalog at `0/0` (Ollama) — known
 * free, distinct from null.
 *
 * @param {string} model - Resolved model id used for the call.
 * @param {Object} usage - `{input?, output?}` token counts from the SDK response.
 * @returns {number|null} USD cost, or `null` for unknown pricing.
 */
export function computeCostUsd(model, usage) {
  const pricing = pricingFor(model);
  if (!pricing) return null;
  if (pricing.inputPer1k == null && pricing.outputPer1k == null) return null;
  if (!usage) return null;
  const inTokens = Number(usage.input) || 0;
  const outTokens = Number(usage.output) || 0;
  if (inTokens <= 0 && outTokens <= 0) return null;
  const inCost = (pricing.inputPer1k || 0) * (inTokens / 1000);
  const outCost = (pricing.outputPer1k || 0) * (outTokens / 1000);
  const total = inCost + outCost;
  return Number.isFinite(total) ? total : null;
}

export function getCloudModel(provider) {
  const cfg = CLOUD_DEFAULT_MODELS[provider];
  if (!cfg) return "";
  return process.env[cfg.envVar] || cfg.fallback;
}

export function getCloudName(provider) {
  const cfg = CLOUD_DEFAULT_MODELS[provider];
  if (!cfg) return provider;
  const model = getCloudModel(provider);
  return model !== cfg.fallback ? model : cfg.name;
}

// `getModelCatalog()` (combines per-provider runtime metadata with this
// catalog's pricing + capabilities) lives in `providerInfo.js` — that file
// already imports from this leaf module, so co-locating the combiner there
// keeps modelCatalog.js a pure-data leaf with zero sibling imports.
