/**
 * @module aiProvider/modelCatalog
 * @description Static provider metadata + capability flags. No mutable state,
 * no SDK imports — pure data + tiny helpers. The orchestrator (`index.js`)
 * and the state owner (`registry.js`) both consume this module; this file
 * does NOT import from either, which keeps the dependency graph acyclic.
 *
 * Future AI-003 (capability hardening) extends `CAPABILITIES` with
 * `costPer1kInput` / `costPer1kOutput` / `contextWindow` so a planner agent
 * (AI-005) can pick a model for a given pipeline stage without hard-coding.
 */
import { getSupportedProviders as _getSupportedProviders } from "./index.js";

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

// Per-provider default models — overridable via env vars.
export const CLOUD_DEFAULT_MODELS = {
  anthropic:  { envVar: "ANTHROPIC_MODEL",  fallback: "claude-sonnet-4-20250514", name: "Claude Sonnet" },
  openai:     { envVar: "OPENAI_MODEL",     fallback: "gpt-4o-mini",              name: "GPT-4o-mini" },
  google:     { envVar: "GOOGLE_MODEL",     fallback: "gemini-2.5-flash",         name: "Gemini 2.5 Flash" },
  openrouter: { envVar: "OPENROUTER_MODEL", fallback: "openrouter/auto",          name: "OpenRouter" },
};

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

// Per-provider capability flags. `supportsVision` requires *both* a
// vision-capable provider family AND a vision-capable model (checked via
// VISION_CAPABLE_MODELS at the call site). `supportsJsonMode` is the
// `response_format: { type: "json_object" }` / `responseMimeType` flag.
// Compat slots inherit OpenAI capabilities by default — overridable by
// future AI-003 work via per-slot metadata.
export const CAPABILITIES = {
  anthropic:  { supportsVision: true,  supportsJsonMode: false, contextWindow: 200_000 },
  openai:     { supportsVision: true,  supportsJsonMode: true,  contextWindow: 128_000 },
  google:     { supportsVision: true,  supportsJsonMode: true,  contextWindow: 1_000_000 },
  openrouter: { supportsVision: true,  supportsJsonMode: true,  contextWindow: null },
  local:      { supportsVision: false, supportsJsonMode: true,  contextWindow: 4_096 },
  // `compat:*` providers fall through to OpenAI capability defaults — see
  // capabilitiesFor() below.
};

/** Resolve per-provider capabilities, with sane defaults for compat slots. */
export function capabilitiesFor(provider) {
  if (CAPABILITIES[provider]) return CAPABILITIES[provider];
  if (typeof provider === "string" && provider.startsWith("compat:")) {
    return { supportsVision: false, supportsJsonMode: true, contextWindow: null };
  }
  return { supportsVision: false, supportsJsonMode: false, contextWindow: null };
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

/**
 * Returns a `{ providerId → { model, name, supportsVision, supportsJsonMode,
 * contextWindow } }` map for every supported provider. Built from
 * `getSupportedProviders()` (the orchestrator's authoritative list, which
 * includes runtime compat slots) so it stays in sync with detection.
 */
export function getModelCatalog() {
  const providers = _getSupportedProviders();
  return providers.reduce((acc, p) => {
    const caps = capabilitiesFor(p.id);
    acc[p.id] = {
      model: p.model,
      name: p.name,
      supportsVision: caps.supportsVision && VISION_CAPABLE_MODELS.has(p.model),
      supportsJsonMode: caps.supportsJsonMode,
      contextWindow: caps.contextWindow,
    };
    return acc;
  }, {});
}

export { _getSupportedProviders as getSupportedProviders };
