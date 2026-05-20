/**
 * @module aiProvider
 * @description Multi-AI provider abstraction layer.
 *
 * ### Supported providers
 * | Provider         | Key Env Variable      | Model Env Variable   | Default Model              |
 * |------------------|-----------------------|----------------------|----------------------------|
 * | Anthropic Claude | `ANTHROPIC_API_KEY`   | `ANTHROPIC_MODEL`    | claude-sonnet-4-20250514   |
 * | OpenAI GPT       | `OPENAI_API_KEY`      | `OPENAI_MODEL`       | gpt-4o-mini                |
 * | Google Gemini    | `GOOGLE_API_KEY`      | `GOOGLE_MODEL`       | gemini-2.5-flash           |
 * | OpenRouter       | `OPENROUTER_API_KEY`  | `OPENROUTER_MODEL`   | openrouter/auto            |
 * | Ollama (local)   | `AI_PROVIDER=local`   | `OLLAMA_MODEL`       | mistral:7b                 |
 *
 * **Detection order:** Runtime override (header dropdown) → `AI_PROVIDER` env var → auto-detect (Anthropic → OpenAI → Google → OpenRouter → Ollama).
 *
 * ### Exports
 * - {@link generateText} — Single-shot text generation.
 * - {@link streamText} — Token-streaming text generation (Anthropic/OpenAI; fallback for others).
 * - {@link parseJSON} — Parse AI response text as JSON (strips markdown fences).
 * - {@link getProvider}, {@link hasProvider}, {@link isLocalProvider}, {@link isProviderDegraded}, {@link getProviderName}, {@link getProviderMeta} — Provider detection.
 * - {@link setRuntimeKey}, {@link setRuntimeOllama}, {@link setActiveProvider} — Runtime configuration (Settings page).
 * - {@link getConfiguredKeys} — Masked key status for the Settings UI.
 * - {@link getSupportedProviders} — All provider names/models for the UI (derived from runtime config).
 * - {@link checkOllamaConnection} — Ollama connectivity check.
 * - {@link loadKeysFromDatabase} — Restore all persisted keys from DB into the runtime cache (called at startup).
 */

import { formatLogLine } from "../utils/logFormatter.js";
import * as apiKeyRepo from "../database/repositories/apiKeyRepo.js";
import * as compatConfigCache from "../utils/compatConfigCache.js";
import { validateUrl } from "../utils/ssrfGuard.js";
import * as anthropicAdapter from "./adapters/anthropic.js";
import * as openaiAdapter from "./adapters/openai.js";
import * as googleAdapter from "./adapters/google.js";
import * as ollamaAdapter from "./adapters/ollama.js";
import { withRetry, isRateLimitError, isTransientServerError, isRetryableError, composeSignal, MAX_RETRIES, BASE_DELAY_MS, MAX_BACKOFF_MS, CLOUD_TIMEOUT_MS } from "./retry.js";
// INF-007: AI provider telemetry — latency histograms, token counters, and
// error counters. The single most important metric surface for a SaaS QA
// platform: it drives unit-economics (cost per workspace per day = tokens ×
// vendor price), capacity planning (p99 latency per provider), and the
// circuit-breaker (FEA-003) trip signal. See `utils/metrics.js` for the
// full registration and label cardinality discipline.
import {
  aiProviderLatencySeconds,
  aiProviderTokensTotal,
  aiProviderErrorsTotal,
  aiProviderCostUsdTotal,
  classifyAiError,
} from "../utils/metrics.js";

/**
 * Normalise the provider id used as a metric label. Compat providers
 * (`compat:<slot-id>`) get folded to the literal `"compat"` so per-slot
 * cardinality doesn't explode the time-series database — operators who
 * need per-slot detail get it via OTel spans, not Prometheus labels.
 *
 * @param {string} provider - The detected provider id.
 * @returns {string} A small-enum label value.
 */
function providerMetricLabel(provider) {
  if (!provider) return "unknown";
  if (typeof provider === "string" && provider.startsWith("compat:")) return "compat";
  return provider;
}

/**
 * Build a `fetch` implementation that re-validates the target URL via the
 * SSRF guard on every call before delegating to global `fetch`. Used by the
 * OpenAI SDK for compat (`compat:<id>`) providers so a hostname that
 * resolved to a public IP at config-save time can't be flipped to a
 * private/loopback IP via DNS rebinding between save and call.
 *
 * Streaming + retry semantics are preserved: we forward `init` (including
 * `signal`, `body`, `headers`, `method`) untouched and return the raw
 * `Response` so the SDK still streams chunks and reads `Retry-After`.
 *
 * @returns {Function} A fetch-compatible function `(input, init) => Promise<Response>`.
 */
function createSsrfGuardedFetch() {
  return async (input, init) => {
    const url = typeof input === "string" ? input
      : input instanceof URL ? input.toString()
      : input?.url;
    // AI-001: Honor the ALLOW_PRIVATE_URLS escape hatch for self-hosted /
    // on-prem OpenAI-compatible endpoints. Scoped to compat-provider fetches
    // here — the shared validateUrl() does NOT apply this bypass, so trigger
    // callbacks / preview URLs / webhooks remain protected.
    if (url && process.env.ALLOW_PRIVATE_URLS !== "true") {
      const err = await validateUrl(url);
      if (err) throw new Error(`SSRF guard rejected compat baseUrl: ${err}`);
    }
    // SSRF defense-in-depth: block 3xx redirects so an attacker-controlled
    // compat baseUrl can't redirect to a private/link-local/cloud-metadata
    // address (which would bypass the initial validateUrl() check). Mirrors
    // safeFetch() in utils/ssrfGuard.js.
    return fetch(input, { ...init, redirect: "error" });
  };
}

// ── Runtime key store ────────────────────────────────────────────────────────
// In-memory cache populated at startup from the DB (via loadKeysFromDatabase)
// and updated whenever /api/settings writes a new key. Keys are also persisted
// to the `api_keys` DB table, so they survive server restarts.
const runtimeKeys = {};

// Ollama runtime config (settable via /api/settings for the local provider)
let runtimeOllamaBaseUrl = "";
let runtimeOllamaModel   = "";
// Explicit deactivation flag — when true, Ollama is disabled even if env vars are set.
// Set to true by DELETE /api/settings/local; cleared by POST /api/settings with local provider.
let runtimeOllamaDisabled = false;

// ── Active provider override ──────────────────────────────────────────────────
// When set, this provider is used instead of auto-detection order.
// Allows the header dropdown to switch between already-configured providers
// without re-entering keys. Cleared when the selected provider loses its key.
let runtimeActiveProvider = null;

// ── Sticky fallback override ──────────────────────────────────────────────────
// When a rate-limit fallback succeeds, this is set to the fallback provider so
// all subsequent generateText() calls in the same pipeline skip the rate-limited
// primary and go directly to the working fallback.  Auto-expires after
// STICKY_FALLBACK_TTL_MS so normal provider selection resumes once the rate
// limit window resets.  Cleared by setActiveProvider() (user explicitly picks
// a provider via the dropdown) and by setRuntimeKey() (user enters a new key).
let _stickyFallbackProvider = null;
let _stickyFallbackExpiry   = 0;

const STICKY_FALLBACK_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Override the active provider selection (used by the quick-switch dropdown).
 * The provider must already have a valid key/config — this does not set any key.
 * @param {string|null} provider - Provider ID to pin, or null to resume auto-detect.
 */
export function setActiveProvider(provider) {
  runtimeActiveProvider = provider || null;
  // User explicitly chose a provider — clear any sticky fallback
  _stickyFallbackProvider = null;
  _stickyFallbackExpiry   = 0;
}

// Maps cloud provider IDs to their env-var names (single source of truth)
const CLOUD_KEY_MAP = {
  anthropic:  "ANTHROPIC_API_KEY",
  openai:     "OPENAI_API_KEY",
  google:     "GOOGLE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

// Default models per cloud provider — overridable via env vars
const CLOUD_DEFAULT_MODELS = {
  anthropic:  { envVar: "ANTHROPIC_MODEL",  fallback: "claude-sonnet-4-20250514", name: "Claude Sonnet" },
  openai:     { envVar: "OPENAI_MODEL",     fallback: "gpt-4o-mini",              name: "GPT-4o-mini" },
  google:     { envVar: "GOOGLE_MODEL",     fallback: "gemini-2.5-flash",         name: "Gemini 2.5 Flash" },
  openrouter: { envVar: "OPENROUTER_MODEL", fallback: "openrouter/auto",          name: "OpenRouter" },
};

// OpenRouter base URL — overridable for self-hosted proxies.
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

function getCloudModel(provider) {
  const cfg = CLOUD_DEFAULT_MODELS[provider];
  if (!cfg) return "";
  return process.env[cfg.envVar] || cfg.fallback;
}

function getCloudName(provider) {
  const cfg = CLOUD_DEFAULT_MODELS[provider];
  if (!cfg) return provider;
  // If user overrode the model, show the model id as the name
  const model = getCloudModel(provider);
  return model !== cfg.fallback ? model : cfg.name;
}



function isCompatProvider(provider) {
  // Match apiKeyRepo.isCompatProvider() — require a non-empty slot id after
  // the "compat:" prefix so a malformed `provider: "compat:"` doesn't
  // reach the DB layer (which would 500 on the empty key) or get treated
  // as a usable provider by isProviderUsable() / detectProvider().
  return typeof provider === "string" && provider.startsWith("compat:") && provider.length > "compat:".length;
}

function getCompatConfig(provider) {
  if (!isCompatProvider(provider)) return null;
  // Read through the TTL cache to avoid hitting SQLite (decrypt + JSON.parse)
  // on every AI call.  Cache is write-through invalidated in apiKeyRepo and
  // coherent across processes via Redis pub/sub (utils/compatConfigCache.js).
  //
  // Loader uses `getCompatSlot()` (not the generic `apiKeyRepo.get()`) so the
  // compat-specific type guard runs — protects against a corrupted row
  // returning a non-object (string / null / number) which would otherwise
  // poison the cache and make `compat?.apiKey` lookups crash with a
  // "cannot read properties of string" error far from the actual root cause.
  return compatConfigCache.get(provider, () => apiKeyRepo.getCompatSlot(provider));
}

// Auto-detect order for cloud providers
const CLOUD_DETECT_ORDER = ["anthropic", "openai", "google", "openrouter"];

/**
 * Set an AI provider API key at runtime (via Settings page).
 * Persists the key to the database so it survives server restarts.
 * Pass an empty string to clear the key both in-memory and in the DB.
 *
 * @param {string} provider - `"anthropic"` | `"openai"` | `"google"` | `"openrouter"`.
 * @param {string} key      - The API key string, or `""` to deactivate.
 */
export function setRuntimeKey(provider, key) {
  // Compat providers are managed via apiKeyRepo.setCompatSlot() in settings.js
  // (they need {baseUrl, model, apiKey, displayName}, not just a key string).
  // Reset their circuit breaker so the new config is retried immediately.
  if (isCompatProvider(provider)) {
    if (circuitBreakers[provider]) {
      circuitBreakers[provider].failures = 0;
      circuitBreakers[provider].disabledUntil = 0;
    }
    _stickyFallbackProvider = null;
    _stickyFallbackExpiry   = 0;
    return;
  }
  const envName = CLOUD_KEY_MAP[provider];
  if (!envName) return;
  runtimeKeys[envName] = key;
  // FEA-003: Reset circuit breaker when the key changes so the provider is
  // immediately retried with the new credentials instead of waiting out the
  // cooldown from the old key's rate-limit failures.
  if (circuitBreakers[provider]) {
    circuitBreakers[provider].failures = 0;
    circuitBreakers[provider].disabledUntil = 0;
  }
  // Clear sticky fallback — user is configuring a provider, let detection re-evaluate
  _stickyFallbackProvider = null;
  _stickyFallbackExpiry   = 0;
  try {
    if (key) {
      apiKeyRepo.set(provider, key);
    } else {
      apiKeyRepo.remove(provider);
    }
  } catch (err) {
    // DB unavailable during tests or before init — safe to ignore, in-memory cache still works.
    console.error(formatLogLine("error", null, `[aiProvider] Failed to persist key for ${provider}: ${err.message}`));
  }
}

/**
 * Configure Ollama runtime settings (via Settings page).
 * Persists the config to the database so it survives server restarts.
 *
 * @param {Object}  [opts]
 * @param {string}  [opts.baseUrl]  - Ollama server URL.
 * @param {string}  [opts.model]    - Model name (e.g. `"mistral:7b"`).
 * @param {boolean} [opts.disabled] - Set `true` to deactivate Ollama.
 */
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

function getKey(envName) {
  // Use `in` + explicit check so that setting a runtime key to "" (deactivation)
  // takes precedence over the env var. Previously `||` made "" falsy, falling
  // through to process.env and making runtime deactivation impossible.
  if (envName in runtimeKeys) return runtimeKeys[envName];
  const envVal = process.env[envName] || "";
  if (envVal) return envVal;
  // DEMO-MODE: Fall back to the platform-owned demo key for Google when no
  // user key is configured. This lets users try Sentri without bringing their
  // own API key. The demo key is rate-limited per-user by demoQuota middleware.
  if (envName === "GOOGLE_API_KEY" && process.env.DEMO_GOOGLE_API_KEY) {
    return process.env.DEMO_GOOGLE_API_KEY;
  }
  return "";
}

function getOllamaBaseUrl() {
  return runtimeOllamaBaseUrl
    || process.env.OLLAMA_BASE_URL
    || "http://localhost:11434";
}

function getOllamaModel() {
  return runtimeOllamaModel
    || process.env.OLLAMA_MODEL
    || "mistral:7b";
}

// ── Provider metadata ─────────────────────────────────────────────────────────

function buildProviderMeta() {
  const meta = {
    anthropic:  { name: getCloudName("anthropic"),  model: getCloudModel("anthropic"),  color: "#cd7f32" },
    openai:     { name: getCloudName("openai"),     model: getCloudModel("openai"),     color: "#10a37f" },
    google:     { name: getCloudName("google"),     model: getCloudModel("google"),     color: "#4285f4" },
    openrouter: { name: getCloudName("openrouter"), model: getCloudModel("openrouter"), color: "#6466f1" },
    local:      { name: `Ollama (${getOllamaModel()})`, model: getOllamaModel(), color: "#7c3aed" },
  };
  // AI-001: synthesize entries for every configured compat slot so
  // getProviderName() / getProviderMeta() don't throw when a compat provider
  // is active (called from crawler.js, testPersistence.js, etc).
  //
  // Perf: route through getCompatConfig() so per-slot reads hit the TTL cache
  // instead of SQLite + AES decryption. buildProviderMeta() is called from
  // inside callProvider() for built-in providers (e.g. `buildProviderMeta().anthropic.model`
  // at the Anthropic / OpenAI / Google branches below), so every cloud AI
  // call would otherwise iterate every compat slot against the DB. The
  // `listCompatSlots()` SELECT is still one round-trip, but the per-slot
  // decrypts now hit `compatConfigCache` (60s TTL).
  try {
    for (const provider of apiKeyRepo.listCompatSlots()) {
      const cfg = getCompatConfig(provider) || {};
      const slotId = provider.slice("compat:".length);
      meta[provider] = {
        name: cfg.displayName || slotId,
        model: cfg.model || "",
        color: "#6466f1",
      };
    }
  } catch { /* DB unavailable — cloud entries still work */ }
  return meta;
}

const PROVIDER_DOCS = {
  anthropic:  "https://console.anthropic.com/settings/keys",
  openai:     "https://platform.openai.com/api-keys",
  google:     "https://aistudio.google.com/apikey",
  openrouter: "https://openrouter.ai/keys",
  local:      "https://ollama.ai",
};

/**
 * Returns the list of all supported providers with current names/models.
 * Derives from buildProviderMeta() so model names stay in sync with what's
 * actually used in API calls. Consumed by GET /api/config.
 * @returns {Array<{id: string, name: string, model: string, docsUrl: string}>}
 */
export function getSupportedProviders() {
  const meta = buildProviderMeta();
  return Object.entries(meta).map(([id, m]) => ({
    id,
    name: m.name,
    model: m.model,
    docsUrl: PROVIDER_DOCS[id] || "",
  }));
}

// ── Provider detection ────────────────────────────────────────────────────────

/**
 * Check whether a provider is usable right now (has a key or, for Ollama, is not disabled).
 * Single source of truth — used by detectProvider, the quick-switch override, and the forced-env path.
 * @param {string} provider
 * @returns {boolean}
 */
function isProviderUsable(provider) {
  if (provider === "local") {
    return !runtimeOllamaDisabled;
  }
  if (isCompatProvider(provider)) {
    // Wrap the cache loader / DB read so a transient DB failure during a
    // cache miss (TTL expired) doesn't propagate through detectProvider() →
    // generateText() / streamText(). Mirrors the try/catch around the
    // `listCompatSlots()` sweep below — without it, a sticky-fallback or
    // active-provider pointing at a compat slot would crash hot paths the
    // moment the cache TTL elapses while the DB is briefly unavailable.
    try {
      const compat = getCompatConfig(provider);
      return !!(compat?.apiKey && compat?.baseUrl && compat?.model);
    } catch {
      return false;
    }
  }
  const envName = CLOUD_KEY_MAP[provider];
  if (!envName) return false;
  // Runtime key of "" means explicitly cleared — respect that
  if (envName in runtimeKeys) return runtimeKeys[envName].length > 0;
  if (process.env[envName]) return true;
  // DEMO-MODE: Google is usable when the demo key is set
  if (envName === "GOOGLE_API_KEY" && process.env.DEMO_GOOGLE_API_KEY) return true;
  return false;
}

/** True if Ollama has any config (runtime or env) hinting it should be auto-detected. */
function hasOllamaConfig() {
  return !!(runtimeOllamaBaseUrl || runtimeOllamaModel || process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL);
}

function detectProvider() {
  // ── Sticky fallback from a previous rate-limit event ─────────────────────
  // Checked FIRST — when a rate-limit fallback succeeded, all subsequent
  // calls must use the fallback provider, even if the user explicitly
  // selected the (now rate-limited) primary via the dropdown.  Without this
  // priority, every call would re-try the broken provider for ~3 min before
  // falling back again.  Auto-expires after STICKY_FALLBACK_TTL_MS so normal
  // provider selection resumes once the rate limit window resets.
  if (_stickyFallbackProvider && Date.now() < _stickyFallbackExpiry) {
    if (isProviderUsable(_stickyFallbackProvider)) return _stickyFallbackProvider;
    // Fallback no longer usable — clear and fall through
    _stickyFallbackProvider = null;
    _stickyFallbackExpiry   = 0;
  } else if (_stickyFallbackProvider) {
    // Expired — clear
    _stickyFallbackProvider = null;
    _stickyFallbackExpiry   = 0;
  }

  // ── Quick-switch override from the header dropdown ────────────────────────
  // Checked AFTER the sticky fallback so a rate-limited provider is not
  // retried just because the user had it selected in the dropdown.
  if (runtimeActiveProvider) {
    if (isProviderUsable(runtimeActiveProvider)) return runtimeActiveProvider;
    // Key gone — clear the override and fall through
    runtimeActiveProvider = null;
  }

  // ── AI_PROVIDER env var (explicit static config) ─────────────────────────
  const forced = process.env.AI_PROVIDER?.toLowerCase();
  if (forced) {
    if (forced === "local") return "local";
    if (!CLOUD_KEY_MAP[forced]) throw new Error(`Unknown AI_PROVIDER="${forced}". Valid: anthropic, openai, google, openrouter, local`);
    if (!getKey(CLOUD_KEY_MAP[forced])) throw new Error(`AI_PROVIDER="${forced}" but ${CLOUD_KEY_MAP[forced]} is not set`);
    return forced;
  }

  // ── Auto-detect: first cloud provider with a key, then any configured
  // compat:<id> slot, then Ollama as final fallback. Without the compat
  // sweep, a server restart with ONLY compat slots configured would leave
  // detectProvider() returning null until an admin manually re-selects.
  const detected = CLOUD_DETECT_ORDER.find(id => isProviderUsable(id));
  if (detected) return detected;

  try {
    const compatSlot = apiKeyRepo.listCompatSlots().find(id => isProviderUsable(id));
    if (compatSlot) return compatSlot;
  } catch { /* DB unavailable — fall through to Ollama */ }

  if (isProviderUsable("local") && hasOllamaConfig()) return "local";

  return null;
}

/** @returns {string|null} Current provider ID (`"anthropic"`, `"openai"`, `"google"`, `"openrouter"`, `"local"`), or `null`. */
export function getProvider()     { try { return detectProvider(); } catch { return null; } }
/** @returns {boolean} `true` if any AI provider is configured. */
export function hasProvider()     { return getProvider() !== null; }
/** @returns {boolean} `true` if the active provider is Ollama (local). */
export function isLocalProvider() { return getProvider() === "local"; }
/**
 * `true` when the AI provider is operating in a degraded state — either a
 * sticky fallback is active (primary was rate-limited) or the primary
 * provider's circuit breaker is open.  Used by the feedback loop to skip
 * expensive AI calls that would block run completion.
 * @returns {boolean}
 */
export function isProviderDegraded() {
  if (_stickyFallbackProvider && Date.now() < _stickyFallbackExpiry) return true;
  const primary = getProvider();
  return primary ? isCircuitBreakerOpen(primary) : false;
}
/** @returns {string} Human-readable provider name (e.g. `"Claude Sonnet"`), or `"No provider configured"`. */
export function getProviderName() {
  const p = getProvider();
  if (!p) return "No provider configured";
  // Defense-in-depth: a compat slot deleted between detectProvider() and
  // here would otherwise read .name on undefined and crash hot paths
  // (crawler.js, testPersistence.js).
  return buildProviderMeta()[p]?.name || p;
}
/** @returns {{provider: string, name: string, model: string, color: string}|null} Full provider metadata, or `null`. */
export function getProviderMeta() {
  const p = getProvider();
  if (!p) return null;
  return { provider: p, ...(buildProviderMeta()[p] || { name: p, model: "", color: "#6466f1" }) };
}

/**
 * Returns masked API keys and Ollama config for the Settings UI.
 * Never returns full keys — only masked versions for display.
 *
 * @returns {{anthropic: string, openai: string, google: string, openrouter: string, activeProvider: string|null, ollamaBaseUrl: string, ollamaModel: string}}
 */
export function getConfiguredKeys() {
  const result = { activeProvider: getProvider() };
  // Cloud providers — masked keys via the shared map.
  // Exclude the demo key fallback so the Settings UI (and demoQuota BYOK
  // detection) only reflects keys the user explicitly configured.
  for (const [id, envName] of Object.entries(CLOUD_KEY_MAP)) {
    const userKey = getUserConfiguredKey(envName);
    result[id] = maskKey(userKey);
  }
  // Ollama-specific fields (never sensitive, no masking needed)
  result.ollamaBaseUrl = getOllamaBaseUrl();
  result.ollamaModel   = getOllamaModel();
  // True only when Ollama has explicit config AND is not disabled — prevents
  // the dropdown from showing Ollama as "saved" when it's just the default URL.
  result.ollamaConfigured = !runtimeOllamaDisabled && hasOllamaConfig();
  // Wrap the DB sweep in try/catch to match buildProviderMeta() / detectProvider()
  // / getFallbackProviders() — without it, a transient DB failure would 500
  // the GET /settings endpoint AND crash the demoQuota middleware on every
  // request when demo mode is active (REVIEW.md: error responses must never
  // leak internal details, and this path was leaking DB error messages).
  //
  // Perf: route per-slot reads through getCompatConfig() so they hit the TTL
  // cache (compatConfigCache). demoQuota middleware calls this on every
  // request when demo mode is active — direct apiKeyRepo.get() per slot
  // would decrypt every compat config on every request, defeating the cache.
  try {
    result.compatProviders = apiKeyRepo.listCompatSlots()
      .map((provider) => ({ provider, ...(getCompatConfig(provider) || {}) }))
      .map((p) => ({
        provider: p.provider,
        displayName: p.displayName || p.provider.replace("compat:", ""),
        baseUrl: p.baseUrl || "",
        model: p.model || "",
        apiKey: maskKey(p.apiKey || ""),
      }));
  } catch (err) {
    // DB unavailable — log server-side and degrade to an empty list so the
    // Settings UI still renders cloud + Ollama state correctly.
    console.error(formatLogLine("error", null, `[aiProvider] Failed to list compat providers: ${err.message}`));
    result.compatProviders = [];
  }
  return result;
}

/**
 * Get a user-configured key WITHOUT the demo fallback.
 * Used by getConfiguredKeys() so BYOK detection is accurate.
 * @param {string} envName
 * @returns {string}
 */
function getUserConfiguredKey(envName) {
  if (envName in runtimeKeys) return runtimeKeys[envName];
  return process.env[envName] || "";
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 6) + "••••••••" + key.slice(-4);
}

// ── Database key persistence ──────────────────────────────────────────────────

/**
 * Restore all persisted API keys and Ollama config from the database into the
 * runtime cache. Called once at server startup after the DB is initialised.
 *
 * Keys stored in the DB take precedence over the default detection logic only
 * when no matching env var is already set — env vars remain the canonical
 * override so Docker / K8s deployments are unaffected.
 *
 * @returns {number} The number of providers successfully loaded from the database.
 */
export function loadKeysFromDatabase() {
  let loaded = 0;
  try {
    const entries = apiKeyRepo.getAll();
    for (const { provider, value } of entries) {
      if (provider === "local") {
        // Restore Ollama config only when env vars are not already set.
        const cfg = value;
        if (cfg && typeof cfg === "object") {
          if (!runtimeOllamaBaseUrl && !process.env.OLLAMA_BASE_URL) {
            runtimeOllamaBaseUrl = cfg.baseUrl || "";
          }
          if (!runtimeOllamaModel && !process.env.OLLAMA_MODEL) {
            runtimeOllamaModel = cfg.model || "";
          }
          runtimeOllamaDisabled = false;
          loaded += 1;
        }
      } else if (isCompatProvider(provider)) {
        // Compat slots store {apiKey, baseUrl, model, displayName} as JSON;
        // they are read on demand via apiKeyRepo.get() inside getCompatConfig(),
        // so no runtime cache restore is required here. Just count it as loaded.
        if (value && typeof value === "object" && value.apiKey && value.baseUrl && value.model) {
          loaded += 1;
        }
      } else {
        const envName = CLOUD_KEY_MAP[provider];
        if (!envName) continue;
        // Only restore from DB when the env var is absent and cache is not already
        // populated — env vars always win.
        if (!process.env[envName] && !(envName in runtimeKeys)) {
          runtimeKeys[envName] = String(value);
          loaded += 1;
        }
      }
    }
    if (loaded > 0) {
      console.log(formatLogLine("info", null, `[aiProvider] Restored ${loaded} provider key(s) from database`));
    }
  } catch (err) {
    // Non-fatal: the server still works with env vars; log and continue.
    console.error(formatLogLine("error", null, `[aiProvider] Failed to load keys from database: ${err.message}`));
  }
  return loaded;
}

// ── Ollama connectivity check ─────────────────────────────────────────────────

/**
 * Check Ollama server connectivity and verify the configured model is available.
 *
 * @returns {Promise<Object>} Resolves to `{ok: boolean, model?: string, baseUrl?: string, availableModels?: string[], error?: string}`.
 */
export async function checkOllamaConnection() {
  const base = getOllamaBaseUrl();
  const model = getOllamaModel();
  try {
    const tagsRes = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!tagsRes.ok) return { ok: false, error: `Ollama /api/tags returned HTTP ${tagsRes.status}` };
    const { models = [] } = await tagsRes.json();
    const names = models.map(m => m.name.split(":")[0]);
    // model name may include a tag (mistral:7b:latest) — strip for comparison
    const modelBase = model.split(":")[0];
    const found = names.some(n => n === modelBase || n === model);
    if (!found) {
      return {
        ok: false,
        error: `Model "${model}" not found. Run: ollama pull ${model}\nAvailable: ${names.join(", ") || "(none)"}`,
        availableModels: models.map(m => m.name),
      };
    }
    return { ok: true, model, baseUrl: base, availableModels: models.map(m => m.name) };
  } catch (err) {
    return {
      ok: false,
      error: `Cannot reach Ollama at ${base}. Is it running? (ollama serve)\nDetail: ${err.message}`,
    };
  }
}

// ── Retry with exponential backoff ────────────────────────────────────────────

// ── Core constants ────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS, 10) || 16384;

// Per-call timeout for cloud AI providers (GAP-08).
// Prevents a hung API call from blocking the pipeline indefinitely.
// Ollama has its own timeout (OLLAMA_TIMEOUT_MS, default 120s) so this only
// applies to Anthropic, OpenAI, and Google.  Override via LLM_TIMEOUT_MS.
// ─── Structured message helpers ───────────────────────────────────────────────
// Prompt builders can pass either a plain string or { system, user } to
// generateText / streamText. These helpers normalise both shapes into the
// provider-specific message format.

function normaliseMessages(promptOrMessages) {
  if (typeof promptOrMessages === "string") {
    // Legacy: single string → user-only message (backwards compatible)
    return { system: null, user: promptOrMessages, combined: promptOrMessages };
  }
  const { system, user } = promptOrMessages;
  // Combined fallback for providers that don't support system messages (Ollama)
  const combined = system ? `${system}\n\n---\n\n${user}` : user;
  return { system: system || null, user, combined };
}

// ── FEA-003: Circuit breaker per provider ─────────────────────────────────────
// When a provider hits a rate-limit failure that survived all internal retries
// in withRetry(), disable it for 5 min.  Threshold is 1 (not 3) because
// withRetry() already retried MAX_RETRIES times internally — the error that
// reaches generateText() represents a confirmed, durable rate limit, not a
// transient blip.

/** @type {Object<string, {failures: number, disabledUntil: number}>} */
const circuitBreakers = {};

const CIRCUIT_BREAKER_THRESHOLD = 1;
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Record a rate-limit failure for a provider. If the threshold is reached,
 * the provider is disabled for CIRCUIT_BREAKER_COOLDOWN_MS.
 *
 * @param {string} provider
 */
function recordProviderFailure(provider) {
  if (!circuitBreakers[provider]) circuitBreakers[provider] = { failures: 0, disabledUntil: 0 };
  circuitBreakers[provider].failures += 1;
  if (circuitBreakers[provider].failures >= CIRCUIT_BREAKER_THRESHOLD) {
    circuitBreakers[provider].disabledUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
    console.warn(formatLogLine("warn", null, `[aiProvider] Circuit breaker tripped for ${provider} — disabled for ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s after ${CIRCUIT_BREAKER_THRESHOLD} consecutive rate-limit failures`));
  }
}

/**
 * Record a successful call — resets the failure counter.
 *
 * @param {string} provider
 */
function recordProviderSuccess(provider) {
  if (circuitBreakers[provider]) {
    circuitBreakers[provider].failures = 0;
  }
}

/**
 * Check whether a provider's circuit breaker is open (disabled).
 *
 * @param {string} provider
 * @returns {boolean} `true` if the provider is temporarily disabled.
 */
function isCircuitBreakerOpen(provider) {
  const cb = circuitBreakers[provider];
  if (!cb) return false;
  if (cb.disabledUntil > Date.now()) return true;
  // Cooldown expired — reset
  if (cb.disabledUntil > 0) {
    cb.disabledUntil = 0;
    cb.failures = 0;
  }
  return false;
}

/**
 * FEA-003: Get the ordered list of fallback providers to try when the primary
 * provider hits a rate limit or transient error.
 *
 * **Same-tier only** — cloud primary falls back to other cloud providers;
 * local primary has no fallback. This prevents cross-tier mismatches where
 * a prompt built for cloud (~1600 chars, 128K context assumed) gets
 * delivered to Ollama (4K context, needs >120s to process) and hits the
 * chat timeout. Ollama is never a cross-tier rescue — the prompt shape,
 * context window, and response latency are too different.
 *
 * To use Ollama as a primary, set `AI_PROVIDER=local` or pick it from
 * the provider dropdown — detectProvider() will route all calls to Ollama
 * with the correct tier-specific prompt.
 *
 * @param {string} primaryProvider - The provider that failed.
 * @returns {string[]} Ordered list of same-tier fallback provider IDs.
 */
function getFallbackProviders(primaryProvider) {
  // Local tier has only one provider (Ollama) — no fallback possible.
  if (primaryProvider === "local") return [];
  // Cloud tier: try other cloud providers in detection order, then any
  // configured `compat:<id>` slots (AI-001) — they share the OpenAI wire
  // format and participate in the same circuit-breaker accounting per slot.
  // Wrap the DB read so a transient DB failure doesn't break cloud-only
  // fallbacks (which have no DB dependency otherwise).
  let compatSlots = [];
  try { compatSlots = apiKeyRepo.listCompatSlots(); } catch { /* DB unavailable — cloud fallbacks still work */ }
  const candidates = [...CLOUD_DETECT_ORDER, ...compatSlots];
  return candidates.filter(p =>
    p !== primaryProvider &&
    isProviderUsable(p) &&
    !isCircuitBreakerOpen(p),
  );
}

// ── Core API call ─────────────────────────────────────────────────────────────

/**
 * INF-007 — Instrumentation wrapper around the raw `_callProviderUnsafe`.
 * Records latency / outcome / error-reason metrics around every LLM call so
 * SaaS operators get RED dashboards (Rate / Errors / Duration) per provider
 * without ad-hoc logging or invasive try/catch at every call site.
 *
 * - Latency: `app_ai_provider_latency_seconds{provider, outcome}` — histogram.
 *   Outcomes are constrained to `{success, rate_limited, error}` so the
 *   p99-latency-by-outcome panel can detect when slow timeouts are inflating
 *   the error tail.
 * - Errors: `app_ai_provider_errors_total{provider, reason}` — counter with
 *   reason ∈ `{rate_limit, timeout, auth, server_error, network, unknown}`,
 *   classified by `classifyAiError()` to avoid emitting raw error messages as
 *   labels (cardinality bomb).
 *
 * Best-effort: every metric call is wrapped in `try/catch` so a registry
 * hiccup never converts a successful AI call into a failure. The metrics are
 * observability, not load-bearing.
 *
 * Token counts are recorded inside `_callProviderUnsafe` per-branch because
 * each SDK exposes usage in a different response shape (`msg.usage`,
 * `res.usage`, `result.response.usageMetadata`, etc).
 */
async function callProvider(provider, promptOrMessages, maxTokens, signal, responseFormat) {
  // All call sites in this file are test-generation traffic. Vision-heal
  // calls live in `callVisionModel` below and pass `operation: "vision_heal"`
  // to the same metric counters directly.
  const operation = "generation";
  const label = providerMetricLabel(provider);
  const startedAt = process.hrtime.bigint();
  try {
    const result = await _callProviderUnsafe(provider, promptOrMessages, maxTokens, signal, responseFormat);
    try {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      aiProviderLatencySeconds.observe({ provider: label, outcome: "success", operation }, seconds);
    } catch { /* best-effort */ }
    return result;
  } catch (err) {
    try {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const reason = classifyAiError(err);
      const outcome = reason === "rate_limit" ? "rate_limited" : "error";
      aiProviderLatencySeconds.observe({ provider: label, outcome, operation }, seconds);
      aiProviderErrorsTotal.inc({ provider: label, reason, operation });
    } catch { /* best-effort */ }
    throw err;
  }
}

/**
 * Record token usage from a provider response, bucketed by `kind` +
 * `operation`. Each provider's SDK exposes usage on a different shape;
 * the caller passes the normalised `{ input, output }` counts plus the
 * surface that made the call:
 *
 *   - `"generation"` — test-generation pipeline (default for every
 *     call site in this file's generateText / streamText paths).
 *   - `"vision_heal"` — MNT-001 stage-8 vision-healing path. Bucketed
 *     separately so SaaS unit-economics dashboards can attribute spend
 *     to the healing surface vs. core test generation.
 *
 * Per-1k token cost varies by provider and model, so the dashboard layer
 * multiplies these counters by a pricing lookup to compute spend.
 *
 * @param {string} provider - Detected provider id (used as label after normalisation).
 * @param {object} usage - `{ input?: number, output?: number }`. Missing fields are skipped.
 * @param {"generation"|"vision_heal"} [operation="generation"] - Which surface initiated the call.
 */
function recordAiTokens(provider, usage, operation = "generation") {
  if (!usage) return;
  const label = providerMetricLabel(provider);
  try {
    const inTokens = Number(usage.input);
    if (Number.isFinite(inTokens) && inTokens > 0) {
      aiProviderTokensTotal.inc({ provider: label, kind: "input", operation }, inTokens);
    }
    const outTokens = Number(usage.output);
    if (Number.isFinite(outTokens) && outTokens > 0) {
      aiProviderTokensTotal.inc({ provider: label, kind: "output", operation }, outTokens);
    }
  } catch { /* best-effort */ }
}

async function _callProviderUnsafe(provider, promptOrMessages, maxTokens, signal, responseFormat) {
  const tokens = maxTokens || DEFAULT_MAX_TOKENS;
  const messages = normaliseMessages(promptOrMessages);
  const useJson = responseFormat !== "text";
  const deps = { withRetry, composeSignal, CLOUD_TIMEOUT_MS, recordAiTokens };
  if (provider === "anthropic") return (await anthropicAdapter.generate({ provider, messages, maxTokens: tokens, signal, model: buildProviderMeta().anthropic.model, apiKey: getKey("ANTHROPIC_API_KEY") }, deps)).text;
  if (isCompatProvider(provider)) {
    const compat = getCompatConfig(provider);
    const openAiMessages = [];
    if (messages.system) openAiMessages.push({ role: "system", content: messages.system });
    openAiMessages.push({ role: "user", content: messages.user });
    return (await openaiAdapter.generate({ provider, model: compat?.model, apiKey: compat?.apiKey, baseUrl: compat?.baseUrl, guardedFetch: createSsrfGuardedFetch(), maxTokens: tokens, signal, useJson, openAiMessages }, deps)).text;
  }
  if (provider === "openai" || provider === "openrouter") {
    const openAiMessages = [];
    if (messages.system) openAiMessages.push({ role: "system", content: messages.system });
    openAiMessages.push({ role: "user", content: messages.user });
    return (await openaiAdapter.generate({ provider, model: provider === "openai" ? buildProviderMeta().openai.model : buildProviderMeta().openrouter.model, apiKey: provider === "openai" ? getKey("OPENAI_API_KEY") : getKey("OPENROUTER_API_KEY"), baseUrl: provider === "openrouter" ? OPENROUTER_BASE_URL : undefined, defaultHeaders: provider === "openrouter" ? {"HTTP-Referer": process.env.OPENROUTER_REFERER || "https://sentri.dev", "X-Title": process.env.OPENROUTER_APP_TITLE || "Sentri"} : undefined, maxTokens: tokens, signal, useJson, openAiMessages }, deps)).text;
  }
  if (provider === "google") return (await googleAdapter.generate({ provider, messages, maxTokens: tokens, signal, useJson, model: buildProviderMeta().google.model, apiKey: getKey("GOOGLE_API_KEY") }, deps)).text;
  if (provider === "local") return (await ollamaAdapter.generate({ provider, messages, maxTokens: tokens, signal, useJson, baseUrl: getOllamaBaseUrl(), model: getOllamaModel() })).text;
  throw new Error(`Unknown provider: ${provider}`);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate text from an AI provider (single-shot, non-streaming).
 * Automatically detects the active provider and routes the request.
 *
 * FEA-003: On rate-limit errors, automatically falls back to the next
 * configured provider in CLOUD_DETECT_ORDER before giving up. Each
 * provider has a circuit breaker that disables it for 5 minutes after
 * a rate-limit failure that survived all internal retries.
 *
 * @param {string|{system: string, user: string}} prompt - Plain string or structured `{ system, user }` messages.
 * @param {Object}      [options]
 * @param {number}      [options.maxTokens] - Max output tokens (default 16384).
 * @param {AbortSignal} [options.signal]    - Abort signal for cancellation.
 * @returns {Promise<string>} The generated text response.
 * @throws {Error} If no AI provider is configured or all providers fail.
 */
export async function generateText(prompt, options) {
  const provider = detectProvider();
  if (!provider) {
    throw new Error(
      "No AI provider configured. Options:\n" +
      "  Cloud: set ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY / OPENROUTER_API_KEY in backend/.env\n" +
      "  Local: set AI_PROVIDER=local (requires Ollama running at http://localhost:11434)\n" +
      "         Optionally: OLLAMA_MODEL=mistral:7b  OLLAMA_BASE_URL=http://localhost:11434"
    );
  }

  // ── FEA-003: Try primary provider, then fall back on rate-limit OR transient 5xx errors ──
  try {
    const result = await callProvider(provider, prompt, options?.maxTokens, options?.signal, options?.responseFormat);
    recordProviderSuccess(provider);
    return result;
  } catch (err) {
    // Only fall back on retriable errors (rate limits or transient server errors).
    // Auth errors, invalid prompts, etc. are programmer errors and should propagate.
    if (!isRetryableError(err)) throw err;

    // Ollama (local) doesn't have rate limits — its errors (HTTP 500, context
    // overflow, timeout) can match isRateLimitError() false positives (e.g.
    // "overloaded" in error messages). Don't circuit-break local models;
    // just rethrow so the caller's retry/error handling takes over.
    if (provider === "local") throw err;

    // Primary provider failed with a retriable error — record failure (rate limit only)
    // and try fallbacks. Transient 5xx errors don't trip the circuit breaker because
    // the quota is fine; the provider's backend is just temporarily overloaded.
    const errType = isRateLimitError(err) ? "rate-limited" : "transient server error (5xx)";
    if (isRateLimitError(err)) recordProviderFailure(provider);
    const fallbacks = getFallbackProviders(provider);

    if (fallbacks.length === 0) {
      // No fallbacks available — log why and rethrow so the caller (and user)
      // can tell this was a real "nothing more we can do" situation, not a
      // silent skip.
      console.warn(formatLogLine("warn", null, `[aiProvider] ${provider} ${errType} after ${MAX_RETRIES + 1} attempts — no other provider configured for fallback. Giving up. Configure a second provider in Settings to enable automatic fallback.`));
      throw err;
    }

    for (const fallbackProvider of fallbacks) {
      console.warn(formatLogLine("warn", null, `[aiProvider] ${provider} ${errType} — falling back to ${fallbackProvider}`));
      try {
        const result = await callProvider(fallbackProvider, prompt, options?.maxTokens, options?.signal, options?.responseFormat);
        recordProviderSuccess(fallbackProvider);
        // ── Sticky fallback: pin this provider so subsequent calls in the same
        // pipeline skip the failing primary entirely.  Expires after
        // STICKY_FALLBACK_TTL_MS so normal selection resumes once the
        // quota/outage window closes.
        _stickyFallbackProvider = fallbackProvider;
        _stickyFallbackExpiry   = Date.now() + STICKY_FALLBACK_TTL_MS;
        console.log(formatLogLine("info", null, `[aiProvider] Pinned ${fallbackProvider} as sticky fallback for ${STICKY_FALLBACK_TTL_MS / 1000}s`));
        return result;
      } catch (fallbackErr) {
        if (isRetryableError(fallbackErr)) {
          // Only trip the circuit breaker for rate-limit failures on non-local
          // providers. Transient 5xx errors don't disable the provider — the
          // backend is temporarily overloaded, not permanently broken.
          if (isRateLimitError(fallbackErr) && fallbackProvider !== "local") {
            recordProviderFailure(fallbackProvider);
          }
          const fallbackErrType = isRateLimitError(fallbackErr) ? "rate-limited" : "transient server error (5xx)";
          console.warn(formatLogLine("warn", null, `[aiProvider] Fallback ${fallbackProvider} ${fallbackErrType} — trying next`));
          continue;
        }
        // Non-retriable error from fallback — throw it
        throw fallbackErr;
      }
    }

    // All fallbacks exhausted — throw the original error
    throw err;
  }
}

// ─── MNT-001 — Vision (multimodal) provider abstraction ─────────────────────
// Whitelist of vision-capable model identifiers. An explicit VISION_MODEL
// env var bypasses the whitelist (operator opt-in). Conservative on purpose:
// sending an image payload to a non-vision model silently degrades to
// ignoring the image, which would produce false-positive healing "matches"
// against random page regions.
const VISION_CAPABLE_MODELS = new Set([
  "claude-3-5-sonnet-20241022", "claude-3-5-sonnet-20240620",
  "claude-3-opus-20240229", "claude-sonnet-4-20250514",
  "gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4-vision-preview",
  "gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.5-flash",
]);

/**
 * Resolve which vision-capable model to use, or `null` when none is
 * configured. Used by stage 8 of the MNT-001 healing waterfall and by
 * `PATCH /projects/:id` to reject `pixelmatch_and_llm` mode with
 * `VISION_PROVIDER_NOT_CONFIGURED` when no usable model exists.
 *
 * Resolution order:
 *   1. `VISION_MODEL` env var (explicit override, no whitelist check).
 *   2. `AI_MODEL` env var if it's in `VISION_CAPABLE_MODELS`.
 *   3. The active provider's default model if vision-capable.
 *   4. `null`.
 *
 * @returns {string|null}
 */
export function resolveVisionModel() {
  if (process.env.VISION_MODEL) return process.env.VISION_MODEL;
  if (process.env.AI_MODEL && VISION_CAPABLE_MODELS.has(process.env.AI_MODEL)) return process.env.AI_MODEL;
  const provider = getProvider();
  if (!provider) return null;
  const meta = getProviderMeta();
  if (meta?.model && VISION_CAPABLE_MODELS.has(meta.model)) return meta.model;
  return null;
}

/**
 * Whether a vision-capable provider is configured server-side. Used by
 * the project route validator (MNT-001) to gate `pixelmatch_and_llm`.
 *
 * @returns {boolean}
 */
export function hasVisionProvider() {
  return resolveVisionModel() !== null;
}

/**
 * MNT-001 — multimodal LLM call for vision-based locator healing (stage 8).
 *
 * Sends a screenshot + intent prompt to a vision-capable LLM and expects
 * strict JSON describing where the broken element is now located. On any
 * failure (rate limit, provider error, non-JSON response, sub-threshold
 * confidence) returns `null` so the caller falls through to "no heal".
 *
 * Per-provider multimodal request shapes:
 *   - Anthropic: `content: [{type:"image", source:{...}}, {type:"text"}]`
 *   - OpenAI / OpenRouter / compat: `content: [{type:"text"}, {type:"image_url"}]`
 *   - Google Gemini: `parts: [{text}, {inlineData:{mimeType, data}}]`
 *
 * Cost is a rough estimate (input × $5/M + output × $15/M) — proper
 * per-model pricing is MNT-001b territory. The budget circuit-breaker
 * only needs *some* signal to enforce caps; it does not need accuracy.
 *
 * ### Cancellation (`signal`) caveat
 * The `signal` parameter cancels in-flight Anthropic and OpenAI / OpenRouter /
 * compat calls — both SDKs accept `{ signal }` as the second argument to
 * `messages.create()` / `chat.completions.create()`.
 *
 * **Google Gemini calls are NOT cancellable.** The `@google/generative-ai`
 * SDK's `generateContent()` does not accept an options bag with `signal` —
 * the value passed at the Gemini branch below is silently ignored by the
 * SDK. An aborted vision-heal request against Gemini will still wait for
 * the full LLM response before resolving. The wider codebase has the same
 * limitation on the non-vision Gemini path (`_callProviderUnsafe`'s Google
 * branch) — fixing it consistently is tracked as a follow-up. Operators who
 * need hard cancellation on Gemini should wrap the call site in a
 * `Promise.race` against a signal-driven rejection.
 *
 * @param {Object} params
 * @param {Buffer} params.screenshot     - PNG buffer of the failure viewport.
 * @param {Object} params.intent         - `{ action, label }`.
 * @param {string} [params.contextHtml]  - Last-known DOM context for the broken locator.
 * @param {AbortSignal} [params.signal]  - Honoured on Anthropic + OpenAI shapes;
 *   silently ignored on Google Gemini due to SDK limitation (see § Cancellation caveat).
 * @returns {Promise<{confidence: number, box: ({x,y,width,height}|null), model: string, costUsd: number, reasoning: string|null}|null>}
 */
export async function callVisionModel({ screenshot, intent, contextHtml, signal } = {}) {
  if (!screenshot || !intent?.label) return null;
  const model = resolveVisionModel();
  if (!model) return null;
  const provider = getProvider();
  if (!provider) return null;

  const metricLabel = providerMetricLabel(provider);
  const startedAt = process.hrtime.bigint();
  const userPrompt =
    `A web-test locator has broken. The target action was \`${intent.action}\` on the element ` +
    `labelled "${intent.label}". The attached screenshot is the current page viewport. ` +
    `Locate the element visually and respond with strict JSON only:

` +
    `{"x":number,"y":number,"width":number,"height":number,"confidence":number,"reasoning":string}

` +
    `Coordinates are viewport pixels. \`confidence\` is in [0, 1]. ` +
    `If you cannot locate the element, return {"confidence":0,"reasoning":"<why>"}.` +
    (contextHtml ? `

Last-known DOM context:
${String(contextHtml).slice(0, 800)}` : "");
  const base64 = screenshot.toString("base64");
  const dataUrl = `data:image/png;base64,${base64}`;

  let raw = "";
  let usage = null;
  try {
    if (provider === "anthropic") {
      ({ text: raw, usage } = await anthropicAdapter.generateVision({ provider, model, apiKey: getKey("ANTHROPIC_API_KEY"), base64, userPrompt, signal }));
    } else if (provider === "google") {
      ({ text: raw, usage } = await googleAdapter.generateVision({ provider, model, apiKey: getKey("GOOGLE_API_KEY"), base64, userPrompt }));
    } else if (provider === "openai" || provider === "openrouter" || isCompatProvider(provider)) {
      let apiKey = getKey("OPENAI_API_KEY"), baseUrl, defaultHeaders, guardedFetch;
      if (provider === "openrouter") {
        apiKey = getKey("OPENROUTER_API_KEY");
        baseUrl = OPENROUTER_BASE_URL;
        defaultHeaders = { "HTTP-Referer": process.env.OPENROUTER_REFERER || "https://sentri.dev", "X-Title": process.env.OPENROUTER_APP_TITLE || "Sentri" };
      } else if (isCompatProvider(provider)) {
        const compat = getCompatConfig(provider);
        apiKey = compat?.apiKey;
        baseUrl = compat?.baseUrl;
        guardedFetch = createSsrfGuardedFetch();
      }
      ({ text: raw, usage } = await openaiAdapter.generateVision({ provider, model, apiKey, baseUrl, defaultHeaders, guardedFetch, dataUrl, userPrompt, signal }));
    } else {
      return null;
    }
  } catch (err) {
    try {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const reason = classifyAiError(err);
      const outcome = reason === "rate_limit" ? "rate_limited" : "error";
      aiProviderLatencySeconds.observe({ provider: metricLabel, outcome, operation: "vision_heal" }, seconds);
      aiProviderErrorsTotal.inc({ provider: metricLabel, reason, operation: "vision_heal" });
    } catch {}
    return null;
  }

  if (usage) recordAiTokens(provider, usage, "vision_heal");
  let parsed;
  try { parsed = parseJSON(raw); } catch { return null; }
  const confidence = Number(parsed?.confidence);
  if (!Number.isFinite(confidence) || confidence <= 0) return null;
  const x = Number(parsed?.x), y = Number(parsed?.y), width = Number(parsed?.width), height = Number(parsed?.height);
  const box = (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height)) ? { x, y, width, height } : null;
  const inK = (Number(usage?.input) || 0) / 1_000_000;
  const outK = (Number(usage?.output) || 0) / 1_000_000;
  const costUsd = inK * 5 + outK * 15;
  try {
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    aiProviderLatencySeconds.observe({ provider: metricLabel, outcome: "success", operation: "vision_heal" }, seconds);
    if (Number.isFinite(costUsd) && costUsd > 0) aiProviderCostUsdTotal.inc({ provider: metricLabel, operation: "vision_heal" }, costUsd);
  } catch {}
  return { confidence: Math.min(1, Math.max(0, confidence)), box, model, costUsd, reasoning: typeof parsed?.reasoning === "string" ? parsed.reasoning.slice(0, 200) : null };
}

/**
 * Parse AI response text as JSON. Strips markdown code fences if present.
 *
 * @param {string} text - Raw AI response text.
 * @returns {Object} Parsed JSON object.
 * @throws {SyntaxError} If the text is not valid JSON after cleanup.
 */
export function parseJSON(text) {
  const clean = text.trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");
  return JSON.parse(clean);
}

/**
 * Token-streaming variant of {@link generateText}.
 * Calls `onToken(string)` for each token as it arrives.
 * Returns the full accumulated text when the stream completes.
 * Anthropic, OpenAI, and OpenRouter stream natively; Google and Ollama
 * deliver the whole response as a single synthetic token.
 *
 * ### Error handling
 * If the streaming call fails with a retryable error (rate limit or
 * transient 5xx) BEFORE any tokens are emitted, we transparently retry
 * via `generateText()` — which applies the full FEA-003 retry + fallback
 * chain and emits the full response as a single synthetic "token". Once
 * tokens have started flowing we can't safely fall back (the user would
 * see two partial responses), so mid-stream failures propagate as-is.
 *
 * Google and Ollama providers never start a real stream — they always
 * delegate to `generateText()` (their SDKs don't support incremental
 * streaming from this codebase), so they get fallback for free.
 *
 * @param {string|{system: string, user: string}} promptOrMessages - Plain string or structured messages.
 * @param {function(string): void} onToken - Callback invoked for each token.
 * @param {Object}      [options]
 * @param {number}      [options.maxTokens] - Max output tokens.
 * @param {AbortSignal} [options.signal]    - Abort signal for cancellation.
 * @returns {Promise<string>} The full accumulated response text.
 * @throws {Error} If no AI provider is configured.
 */
export async function streamText(promptOrMessages, onToken, options = {}) {
  const provider = detectProvider();
  if (!provider) throw new Error("No AI provider configured.");
  const { signal, responseFormat } = options;
  const messages = normaliseMessages(promptOrMessages);
  const useJson = responseFormat !== "text";

  async function fallbackToNonStreaming(err) {
    console.warn(formatLogLine("warn", null, `[aiProvider] streamText ${provider} failed before any tokens (${err.message?.slice(0, 120)}) — retrying via non-streaming path with provider fallback.`));
    const text = await generateText(promptOrMessages, { ...options, responseFormat });
    onToken(text);
    return text;
  }

  try {
    if (provider === "anthropic") {
      const res = await anthropicAdapter.stream({ provider, model: buildProviderMeta().anthropic.model, apiKey: getKey("ANTHROPIC_API_KEY"), maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS, signal, messages }, onToken);
      return res?.text ?? "";
    }
    if (provider === "openai" || provider === "openrouter" || isCompatProvider(provider)) {
      let apiKey = getKey("OPENAI_API_KEY"), baseUrl, defaultHeaders, guardedFetch, model = buildProviderMeta().openai.model;
      if (provider === "openrouter") { apiKey = getKey("OPENROUTER_API_KEY"); baseUrl = OPENROUTER_BASE_URL; model = buildProviderMeta().openrouter.model; defaultHeaders = { "HTTP-Referer": process.env.OPENROUTER_REFERER || "https://sentri.dev", "X-Title": process.env.OPENROUTER_APP_TITLE || "Sentri" }; }
      if (isCompatProvider(provider)) { const compat = getCompatConfig(provider); apiKey = compat?.apiKey; baseUrl = compat?.baseUrl; model = compat?.model; guardedFetch = createSsrfGuardedFetch(); }
      const openAiMessages = [];
      if (messages.system) openAiMessages.push({ role: "system", content: messages.system });
      openAiMessages.push({ role: "user", content: messages.user });
      const res = await openaiAdapter.stream({ provider, apiKey, baseUrl, defaultHeaders, guardedFetch, model, maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS, signal, useJson, openAiMessages }, onToken);
      return res?.text ?? "";
    }
  } catch (err) {
    if (err.name === "AbortError" || signal?.aborted) throw err;
    if (isRetryableError(err)) return fallbackToNonStreaming(err);
    throw err;
  }

  const text = await generateText(promptOrMessages, { ...options, responseFormat });
  onToken(text);
  return text;
}
