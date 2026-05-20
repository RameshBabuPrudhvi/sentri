/**
 * @module aiProvider/registry
 * @description Owns mutable provider state — canonical state owner per AI-002.
 *
 * The orchestrator (`./index.js`) imports from here; the reverse is forbidden.
 * Future AI-005 multi-agent dispatch can extend the breaker keyspace
 * (`breakerKey(provider, role)`) inside this file without touching consumers.
 *
 * State owned here: runtime key store, Ollama runtime config, active-provider
 * override, sticky fallback, per-provider circuit breakers, compat-slot
 * config (TTL-cached), provider detection + usability + key resolution.
 */
import * as apiKeyRepo from "../database/repositories/apiKeyRepo.js";
import * as agentConfigRepo from "../database/repositories/agentConfigRepo.js";
import * as compatConfigCache from "../utils/compatConfigCache.js";
import { formatLogLine } from "../utils/logFormatter.js";
import { CLOUD_KEY_MAP, CLOUD_DETECT_ORDER } from "./modelCatalog.js";

// ── Mutable state ────────────────────────────────────────────────────────────
const runtimeKeys = {};
let runtimeOllamaBaseUrl = "";
let runtimeOllamaModel   = "";
let runtimeOllamaDisabled = false;
let runtimeActiveProvider = null;
const stickyFallbacks = new Map();

export const STICKY_FALLBACK_TTL_MS = 10 * 60 * 1000;
const CIRCUIT_BREAKER_THRESHOLD = 1;
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000;

/** @type {Object<string, {failures: number, disabledUntil: number}>} */
const circuitBreakers = {};
export function breakerKey(provider, agentRole) {
  return agentRole ? `${provider}::${agentRole}` : provider;
}

// ── Compat helpers ───────────────────────────────────────────────────────────
export function isCompatProvider(provider) {
  return typeof provider === "string"
    && provider.startsWith("compat:")
    && provider.length > "compat:".length;
}

export function getCompatConfig(provider) {
  if (!isCompatProvider(provider)) return null;
  // TTL cache avoids hitting SQLite (decrypt + JSON.parse) on every AI call.
  return compatConfigCache.get(provider, () => apiKeyRepo.getCompatSlot(provider));
}

// ── Key resolution ───────────────────────────────────────────────────────────
export function getKey(envName) {
  // `in` semantics so runtimeKeys[envName] = "" (explicit deactivation) takes
  // precedence over the env var. `||` would treat "" as falsy.
  if (envName in runtimeKeys) return runtimeKeys[envName];
  const envVal = process.env[envName] || "";
  if (envVal) return envVal;
  // DEMO-MODE: platform-owned demo key for Google when no user key is set.
  if (envName === "GOOGLE_API_KEY" && process.env.DEMO_GOOGLE_API_KEY) {
    return process.env.DEMO_GOOGLE_API_KEY;
  }
  return "";
}

/** Get a user-configured key WITHOUT the demo fallback (for BYOK detection). */
export function getUserConfiguredKey(envName) {
  if (envName in runtimeKeys) return runtimeKeys[envName];
  return process.env[envName] || "";
}

export function getOllamaBaseUrl() {
  return runtimeOllamaBaseUrl || process.env.OLLAMA_BASE_URL || "http://localhost:11434";
}

export function getOllamaModel() {
  return runtimeOllamaModel || process.env.OLLAMA_MODEL || "mistral:7b";
}

export function hasOllamaConfig() {
  return !!(runtimeOllamaBaseUrl || runtimeOllamaModel
    || process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL);
}

export function isOllamaDisabled() { return runtimeOllamaDisabled; }

// loadKeysFromDatabase seeds caches from DB at startup without clobbering env.
export function setCloudKeyFromDb(envName, value) {
  if (!process.env[envName] && !(envName in runtimeKeys)) {
    runtimeKeys[envName] = String(value);
    return true;
  }
  return false;
}

export function setOllamaCacheFromDb(cfg) {
  if (!runtimeOllamaBaseUrl && !process.env.OLLAMA_BASE_URL) {
    runtimeOllamaBaseUrl = cfg.baseUrl || "";
  }
  if (!runtimeOllamaModel && !process.env.OLLAMA_MODEL) {
    runtimeOllamaModel = cfg.model || "";
  }
  runtimeOllamaDisabled = false;
}

// ── Mutators ─────────────────────────────────────────────────────────────────
export function setRuntimeKey(provider, key) {
  if (isCompatProvider(provider)) {
    // Compat providers persist via apiKeyRepo.setCompatSlot() in settings.js.
    resetCircuitBreaker(provider);
    clearStickyFallback();
    return;
  }
  const envName = CLOUD_KEY_MAP[provider];
  if (!envName) return;
  runtimeKeys[envName] = key;
  // FEA-003: reset breaker so new credentials are retried immediately.
  resetCircuitBreaker(provider);
  clearStickyFallback();
  try {
    if (key) apiKeyRepo.set(provider, key);
    else apiKeyRepo.remove(provider);
  } catch (err) {
    // DB unavailable during tests or before init — safe to ignore.
    console.error(formatLogLine("error", null, `[aiProvider] Failed to persist key for ${provider}: ${err.message}`));
  }
}

export function setRuntimeOllama({ baseUrl, model, disabled } = {}) {
  if (baseUrl  !== undefined) runtimeOllamaBaseUrl  = baseUrl;
  if (model    !== undefined) runtimeOllamaModel    = model;
  if (disabled !== undefined) runtimeOllamaDisabled = disabled;
  try {
    if (disabled) {
      apiKeyRepo.remove("local");
    } else if (runtimeOllamaBaseUrl || runtimeOllamaModel) {
      apiKeyRepo.set("local", { baseUrl: runtimeOllamaBaseUrl, model: runtimeOllamaModel });
    }
  } catch (err) {
    console.error(formatLogLine("error", null, `[aiProvider] Failed to persist Ollama config: ${err.message}`));
  }
}

export function setActiveProvider(provider) {
  runtimeActiveProvider = provider || null;
  // User chose a provider — clear sticky fallback so detection re-evaluates.
  clearStickyFallback();
}

// ── Sticky fallback ──────────────────────────────────────────────────────────
export function setStickyFallback(provider, agentRole = null) {
  stickyFallbacks.set(breakerKey(provider, agentRole), {
    provider,
    expiry: Date.now() + STICKY_FALLBACK_TTL_MS,
  });
}

export function clearStickyFallback(agentRole = null) {
  if (!agentRole) return stickyFallbacks.clear();
  for (const [k] of stickyFallbacks) if (k.endsWith(`::${agentRole}`)) stickyFallbacks.delete(k);
}

export function stickyFallbackActive(agentRole = null) {
  for (const [k, v] of stickyFallbacks) {
    if ((agentRole ? k.endsWith(`::${agentRole}`) : true) && Date.now() < v.expiry) return true;
  }
  return false;
}

// ── Circuit breaker (FEA-003) ────────────────────────────────────────────────
export function recordProviderFailure(provider, agentRole = null) {
  const key = breakerKey(provider, agentRole);
  if (!circuitBreakers[key]) circuitBreakers[key] = { failures: 0, disabledUntil: 0 };
  circuitBreakers[key].failures += 1;
  if (circuitBreakers[key].failures >= CIRCUIT_BREAKER_THRESHOLD) {
    circuitBreakers[key].disabledUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
    console.warn(formatLogLine("warn", null, `[aiProvider] Circuit breaker tripped for ${provider} — disabled for ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s after ${CIRCUIT_BREAKER_THRESHOLD} consecutive rate-limit failures`));
  }
}

export function recordProviderSuccess(provider, agentRole = null) {
  const key = breakerKey(provider, agentRole);
  if (circuitBreakers[key]) circuitBreakers[key].failures = 0;
}

export function isCircuitBreakerOpen(provider, agentRole = null) {
  const cb = circuitBreakers[breakerKey(provider, agentRole)];
  if (!cb) return false;
  if (cb.disabledUntil > Date.now()) return true;
  if (cb.disabledUntil > 0) { cb.disabledUntil = 0; cb.failures = 0; }
  return false;
}

function resetCircuitBreaker(provider) {
  // AI-005: breaker keys are now `provider` OR `provider::agentRole`. A
  // credential reset must clear every role-scoped variant — otherwise a
  // user fixing an API key on a rate-limited Claude planner would still see
  // the per-role breaker stay tripped for 5 minutes.
  for (const key of Object.keys(circuitBreakers)) {
    if (key === provider || key.startsWith(`${provider}::`)) {
      circuitBreakers[key].failures = 0;
      circuitBreakers[key].disabledUntil = 0;
    }
  }
}

// ── Provider detection ───────────────────────────────────────────────────────
export function isProviderUsable(provider) {
  if (provider === "local") return !runtimeOllamaDisabled;
  if (isCompatProvider(provider)) {
    // Wrap so a transient DB failure during cache miss doesn't crash hot paths.
    try {
      const compat = getCompatConfig(provider);
      return !!(compat?.apiKey && compat?.baseUrl && compat?.model);
    } catch { return false; }
  }
  const envName = CLOUD_KEY_MAP[provider];
  if (!envName) return false;
  if (envName in runtimeKeys) return runtimeKeys[envName].length > 0;
  if (process.env[envName]) return true;
  if (envName === "GOOGLE_API_KEY" && process.env.DEMO_GOOGLE_API_KEY) return true;
  return false;
}

export function resolveProvider({ agentRole = null, workspaceId = null } = {}) {
  // AI-005 detection priority: sticky-fallback > agentRole > quick-switch > env > auto-detect.
  // An active sticky-fallback for this role MUST win over the configured agent
  // provider — otherwise a rate-limited primary keeps being retried under the
  // agent override and silently collapses the multi-agent dispatch. This is
  // tripwire #1 from the AI-005 spec.
  if (agentRole) {
    for (const [key, entry] of stickyFallbacks) {
      if (!key.endsWith(`::${agentRole}`)) continue;
      if (Date.now() < entry.expiry && isProviderUsable(entry.provider)) {
        return { provider: entry.provider, config: null, effectiveAgentRole: agentRole };
      }
      if (Date.now() >= entry.expiry) stickyFallbacks.delete(key);
    }
  }
  if (agentRole && workspaceId) {
    const cfg = agentConfigRepo.getByRole(workspaceId, agentRole);
    if (cfg?.provider && isProviderUsable(cfg.provider)) {
      return { provider: cfg.provider, config: cfg, effectiveAgentRole: agentRole };
    }
  }
  // AI-005c (single-agent preservation): when no per-role agent_config row
  // exists for this workspace+role, the call falls back to the workspace
  // default provider. In that case it is **not** a multi-agent call — it's
  // a single-agent call that happens to carry an `agentRole` label for
  // future routing. Return `effectiveAgentRole: null` so downstream
  // breakers, sticky-fallback, and metrics all collapse to the bare-provider
  // key path, preserving pre-AI-005 wasted-call counts during 429 incidents.
  // Multi-agent mode lights up automatically the moment a workspace adds an
  // `agent_configs` row for the role.
  const provider = detectProvider({ agentRole });
  if (!provider) return { provider: null, config: null, effectiveAgentRole: null };
  return { provider, config: null, effectiveAgentRole: null };
}

export function detectProvider({ agentRole = null } = {}) {
  // Sticky fallback first — a successful rate-limit fallback pins the working
  // provider until the TTL expires, even if the user has the original
  // (rate-limited) provider selected in the dropdown.
  for (const [key, entry] of stickyFallbacks) {
    if (agentRole && !key.endsWith(`::${agentRole}`)) continue;
    if (Date.now() < entry.expiry && isProviderUsable(entry.provider)) return entry.provider;
    if (Date.now() >= entry.expiry) stickyFallbacks.delete(key);
  }

  if (runtimeActiveProvider) {
    if (isProviderUsable(runtimeActiveProvider)) return runtimeActiveProvider;
    runtimeActiveProvider = null;
  }

  const forced = process.env.AI_PROVIDER?.toLowerCase();
  if (forced) {
    if (forced === "local") return "local";
    if (!CLOUD_KEY_MAP[forced]) throw new Error(`Unknown AI_PROVIDER="${forced}". Valid: anthropic, openai, google, openrouter, local`);
    if (!getKey(CLOUD_KEY_MAP[forced])) throw new Error(`AI_PROVIDER="${forced}" but ${CLOUD_KEY_MAP[forced]} is not set`);
    return forced;
  }

  const detected = CLOUD_DETECT_ORDER.find((id) => isProviderUsable(id));
  if (detected) return detected;

  try {
    const compatSlot = apiKeyRepo.listCompatSlots().find((id) => isProviderUsable(id));
    if (compatSlot) return compatSlot;
  } catch { /* DB unavailable — fall through to Ollama */ }

  if (isProviderUsable("local") && hasOllamaConfig()) return "local";
  return null;
}

export function getFallbackProviders(primaryProvider, agentRole = null) {
  if (primaryProvider === "local") return [];
  // Cloud tier falls back to other cloud providers + compat slots — same wire
  // format, same circuit-breaker accounting per slot. Local is excluded
  // (cross-tier prompt-shape mismatch — see CLOUD_DETECT_ORDER doc).
  let compatSlots = [];
  try { compatSlots = apiKeyRepo.listCompatSlots(); } catch { /* DB unavailable */ }
  const candidates = [...CLOUD_DETECT_ORDER, ...compatSlots];
  return candidates.filter((p) =>
    p !== primaryProvider
    && isProviderUsable(p)
    && !isCircuitBreakerOpen(p, agentRole),
  );
}

// ── Database key persistence ─────────────────────────────────────────────────
/**
 * Restore all persisted API keys and Ollama config from the DB into the
 * runtime cache. Called once at server startup after the DB is initialised.
 * Keys stored in the DB take precedence over default detection only when no
 * matching env var is already set — env vars remain the canonical override.
 *
 * @returns {number} Number of providers successfully loaded from the database.
 */
export function loadKeysFromDatabase() {
  let loaded = 0;
  try {
    const entries = apiKeyRepo.getAll();
    for (const { provider, value } of entries) {
      if (provider === "local") {
        if (value && typeof value === "object") {
          setOllamaCacheFromDb(value);
          loaded += 1;
        }
      } else if (isCompatProvider(provider)) {
        // Compat slots are read on demand via getCompatConfig() — no cache
        // restore needed, just count for the boot log.
        if (value && typeof value === "object" && value.apiKey && value.baseUrl && value.model) {
          loaded += 1;
        }
      } else {
        const envName = CLOUD_KEY_MAP[provider];
        if (!envName) continue;
        if (setCloudKeyFromDb(envName, value)) loaded += 1;
      }
    }
    if (loaded > 0) {
      console.log(formatLogLine("info", null, `[aiProvider] Restored ${loaded} provider key(s) from database`));
    }
  } catch (err) {
    // Non-fatal: server still works with env vars; log and continue.
    console.error(formatLogLine("error", null, `[aiProvider] Failed to load keys from database: ${err.message}`));
  }
  return loaded;
}
