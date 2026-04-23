/**
 * @module aiProvider
 * @description Multi-AI provider abstraction layer.
 *
 * ### Supported providers
 * | Provider         | Key Env Variable    | Model Env Variable   | Default Model              |
 * |------------------|---------------------|----------------------|----------------------------|
 * | Anthropic Claude | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL`    | claude-sonnet-4-20250514   |
 * | OpenAI GPT       | `OPENAI_API_KEY`    | `OPENAI_MODEL`       | gpt-4o-mini                |
 * | Google Gemini    | `GOOGLE_API_KEY`    | `GOOGLE_MODEL`       | gemini-2.5-flash           |
 * | Ollama (local)   | `AI_PROVIDER=local` | `OLLAMA_MODEL`       | mistral:7b                 |
 *
 * **Detection order:** Runtime override (header dropdown) → `AI_PROVIDER` env var → auto-detect (Anthropic → OpenAI → Google → Ollama).
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

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { throwIfAborted } from "./utils/abortHelper.js";
import { formatLogLine } from "./utils/logFormatter.js";
import * as apiKeyRepo from "./database/repositories/apiKeyRepo.js";

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
const CLOUD_KEY_MAP = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GOOGLE_API_KEY" };

// Default models per cloud provider — overridable via env vars
const CLOUD_DEFAULT_MODELS = {
  anthropic: { envVar: "ANTHROPIC_MODEL", fallback: "claude-sonnet-4-20250514", name: "Claude Sonnet" },
  openai:    { envVar: "OPENAI_MODEL",    fallback: "gpt-4o-mini",              name: "GPT-4o-mini" },
  google:    { envVar: "GOOGLE_MODEL",    fallback: "gemini-2.5-flash",         name: "Gemini 2.5 Flash" },
};

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

// Auto-detect order for cloud providers
const CLOUD_DETECT_ORDER = ["anthropic", "openai", "google"];

/**
 * Set an AI provider API key at runtime (via Settings page).
 * Persists the key to the database so it survives server restarts.
 * Pass an empty string to clear the key both in-memory and in the DB.
 *
 * @param {string} provider - `"anthropic"` | `"openai"` | `"google"`.
 * @param {string} key      - The API key string, or `""` to deactivate.
 */
export function setRuntimeKey(provider, key) {
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
  return {
    anthropic: { name: getCloudName("anthropic"), model: getCloudModel("anthropic"), color: "#cd7f32" },
    openai:    { name: getCloudName("openai"),    model: getCloudModel("openai"),    color: "#10a37f" },
    google:    { name: getCloudName("google"),    model: getCloudModel("google"),    color: "#4285f4" },
    local:     { name: `Ollama (${getOllamaModel()})`, model: getOllamaModel(), color: "#7c3aed" },
  };
}

const PROVIDER_DOCS = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai:    "https://platform.openai.com/api-keys",
  google:    "https://aistudio.google.com/apikey",
  local:     "https://ollama.ai",
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
    if (!CLOUD_KEY_MAP[forced]) throw new Error(`Unknown AI_PROVIDER="${forced}". Valid: anthropic, openai, google, local`);
    if (!getKey(CLOUD_KEY_MAP[forced])) throw new Error(`AI_PROVIDER="${forced}" but ${CLOUD_KEY_MAP[forced]} is not set`);
    return forced;
  }

  // ── Auto-detect: first cloud provider with a key, then Ollama as fallback ─
  const detected = CLOUD_DETECT_ORDER.find(id => isProviderUsable(id));
  if (detected) return detected;

  if (isProviderUsable("local") && hasOllamaConfig()) return "local";

  return null;
}

/** @returns {string|null} Current provider ID (`"anthropic"`, `"openai"`, `"google"`, `"local"`), or `null`. */
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
  return p ? buildProviderMeta()[p].name : "No provider configured";
}
/** @returns {{provider: string, name: string, model: string, color: string}|null} Full provider metadata, or `null`. */
export function getProviderMeta() {
  const p = getProvider();
  return p ? { provider: p, ...buildProviderMeta()[p] } : null;
}

/**
 * Returns masked API keys and Ollama config for the Settings UI.
 * Never returns full keys — only masked versions for display.
 *
 * @returns {{anthropic: string, openai: string, google: string, activeProvider: string|null, ollamaBaseUrl: string, ollamaModel: string}}
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

const RATE_LIMIT_CODES = [429, 529];
const RETRY_ERRORS     = ["rate_limit_error", "overloaded_error", "Too Many Requests"];
const MAX_RETRIES      = parseInt(process.env.LLM_MAX_RETRIES, 10)  || 3;
const BASE_DELAY_MS    = parseInt(process.env.LLM_BASE_DELAY_MS, 10) || 2000;
const MAX_BACKOFF_MS   = parseInt(process.env.LLM_MAX_BACKOFF_MS, 10) || 30000;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Detect whether an error is a rate limit / quota exhaustion from any AI provider.
 * Used internally for retry decisions and exported for the pipeline to detect
 * rate limits that survived all retries.
 *
 * @param {Error} err
 * @returns {boolean}
 */
export function isRateLimitError(err) {
  const msg = (err?.message || "").toLowerCase();
  const status = err?.status || err?.statusCode || 0;
  if (RATE_LIMIT_CODES.includes(status)) return true;
  // Use word-boundary-aware patterns to avoid false positives on port
  // numbers (e.g. "localhost:4290"), disk quota errors, etc.
  return /\brate.?limit/i.test(msg)
    || /\brate_limit/i.test(msg)
    || /\b429\b/.test(msg)
    || /\bquota\s*(exceeded|exhausted|limit)/i.test(msg)
    || /\btoo many requests\b/i.test(msg)
    || /\bresource.?exhausted\b/i.test(msg)
    || /\boverloaded/i.test(msg);
}

function extractRetryAfter(err) {
  const match = (err?.message || "").match(/retry in (\d+(?:\.\d+)?)(s|ms)/i);
  if (match) {
    const val = parseFloat(match[1]);
    return match[2].toLowerCase() === "ms" ? val : val * 1000;
  }
  return null;
}

async function withRetry(fn, label = "") {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      if (!isRateLimitError(err)) throw err;
      const retryAfter = extractRetryAfter(err);
      // Honor server-requested Retry-After delays (cap at 2× MAX_BACKOFF_MS to
      // prevent absurd waits). Only cap computed exponential backoff at MAX_BACKOFF_MS.
      const delay = retryAfter
        ? Math.min(retryAfter, MAX_BACKOFF_MS * 2)
        : Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
      console.warn(formatLogLine("warn", null, `Rate limit hit${label ? " for " + label : ""}. Retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`));
      await sleep(delay);
    }
  }
}

// ── Core constants ────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS, 10) || 16384;

// Per-call timeout for cloud AI providers (GAP-08).
// Prevents a hung API call from blocking the pipeline indefinitely.
// Ollama has its own timeout (OLLAMA_TIMEOUT_MS, default 120s) so this only
// applies to Anthropic, OpenAI, and Google.  Override via LLM_TIMEOUT_MS.
const CLOUD_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS, 10) || 120_000;

/**
 * Compose an AbortSignal that fires on EITHER the external signal (user abort)
 * OR a per-call timeout — whichever comes first.  Returns the composite signal
 * and a cleanup function that MUST be called in a finally block to prevent the
 * timeout from leaking if the call completes before the deadline.
 *
 * @param {AbortSignal|undefined} external - Signal from runWithAbort (user abort).
 * @param {number}                timeoutMs - Per-call deadline.
 * @returns {Object} `{ signal: AbortSignal, cleanup: Function }`
 */
function composeSignal(external, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("AI call timed out")), timeoutMs);

  // Forward external abort
  let onExternal = null;
  if (external) {
    if (external.aborted) {
      clearTimeout(timer);
      controller.abort(external.reason);
    } else {
      onExternal = () => { clearTimeout(timer); controller.abort(external.reason); };
      external.addEventListener("abort", onExternal, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (onExternal && external) external.removeEventListener("abort", onExternal);
    },
  };
}

// ── Ollama caller ─────────────────────────────────────────────────────────────

async function callOllama(prompt, maxTokens, externalSignal, useJson = true) {
  const base  = getOllamaBaseUrl();
  const model = getOllamaModel();

  // Local models (especially 7B) have much smaller effective context windows.
  // Cap num_predict so the prompt + output don't exceed the model's limits.
  // Ollama returns HTTP 500 when the combined size overflows.
  const OLLAMA_MAX_PREDICT = parseInt(process.env.OLLAMA_MAX_PREDICT, 10) || 4096;
  const effectiveTokens = Math.min(maxTokens || DEFAULT_MAX_TOKENS, OLLAMA_MAX_PREDICT);

  const body = {
    model,
    prompt,
    stream: false,
    options: {
      // Ollama uses num_predict for max tokens
      num_predict: effectiveTokens,
      temperature: 0.2,
    },
  };
  // Only ask for JSON format when the caller needs structured output (pipeline).
  // Chat needs free-form text.
  if (useJson) body.format = "json";

  const controller = new AbortController();
  // Ollama can be slow for large prompts — give it generous time
  const timeoutMs = parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 120_000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // If an external abort signal is provided (e.g. user clicked "Stop Task"),
  // forward it to our internal controller so the fetch is cancelled immediately.
  // We keep a reference to the handler so we can remove it in `finally` —
  // without cleanup, 60+ sequential AI calls sharing one signal would trigger
  // a MaxListenersExceededWarning.
  let onExternalAbort = null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timeoutId);
      throw new DOMException("Aborted", "AbortError");
    } else {
      onExternalAbort = () => controller.abort();
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  try {
    const res = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    // Ollama with stream:false should return a single JSON object, but some
    // versions return NDJSON (one JSON object per line). We read as text and
    // handle both formats.
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // NDJSON fallback — each line is a JSON object with a partial "response"
      // field (one token per line). Concatenate all response fields to
      // reconstruct the full output, since the final done:true line typically
      // has an empty response.
      const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
      let fullResponse = "";
      let foundAny = false;
      for (const line of lines) {
        try {
          const candidate = JSON.parse(line);
          if (candidate.response !== undefined) {
            fullResponse += candidate.response;
            foundAny = true;
          }
        } catch { /* skip unparseable lines */ }
      }
      if (!foundAny) throw new Error(`Ollama returned unparseable response: ${raw.slice(0, 300)}`);
      data = { response: fullResponse };
    }

    // Ollama returns { response: "..." } for non-streaming generate
    if (!data.response) throw new Error(`Unexpected Ollama response shape: ${JSON.stringify(data).slice(0, 200)}`);
    return data.response;
  } catch (err) {
    if (err.name === "AbortError") {
      // Distinguish user-initiated abort from internal timeout
      if (externalSignal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      throw new Error(`Ollama request timed out after ${timeoutMs / 1000}s. Try a smaller/faster model or increase OLLAMA_TIMEOUT_MS.`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    if (onExternalAbort && externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

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
 * provider hits a rate limit. Returns all configured providers except the
 * primary, in CLOUD_DETECT_ORDER, filtering out circuit-broken ones.
 *
 * @param {string} primaryProvider - The provider that failed.
 * @returns {string[]} Ordered list of fallback provider IDs.
 */
function getFallbackProviders(primaryProvider) {
  const allProviders = [...CLOUD_DETECT_ORDER, "local"];
  return allProviders.filter(p =>
    p !== primaryProvider &&
    isProviderUsable(p) &&
    !isCircuitBreakerOpen(p) &&
    (p !== "local" || hasOllamaConfig()),
  );
}

// ── Core API call ─────────────────────────────────────────────────────────────

async function callProvider(provider, promptOrMessages, maxTokens, signal, responseFormat) {
  const tokens = maxTokens || DEFAULT_MAX_TOKENS;
  const { system, user, combined } = normaliseMessages(promptOrMessages);
  // Default to JSON for backward compatibility (pipeline needs structured output).
  // Chat endpoint passes responseFormat: "text" for free-form conversation.
  const useJson = responseFormat !== "text";

  if (provider === "anthropic") {
    const client = new Anthropic({ apiKey: getKey("ANTHROPIC_API_KEY") });
    // composeSignal is created inside each retry attempt so that a per-call
    // timeout on attempt N does not leave the signal permanently aborted for
    // subsequent attempts.  The external (user-abort) signal is still checked
    // across all attempts — only the timeout is per-attempt.
    return await withRetry(async () => {
      const { signal: composedSignal, cleanup } = composeSignal(signal, CLOUD_TIMEOUT_MS);
      try {
        const params = {
          model: buildProviderMeta().anthropic.model,
          max_tokens: tokens,
          messages: [{ role: "user", content: user }],
        };
        // Anthropic natively supports a top-level "system" field
        if (system) params.system = system;
        const msg = await client.messages.create(params, { signal: composedSignal });
        return msg.content[0].text;
      } finally { cleanup(); }
    }, "Anthropic");
  }

  if (provider === "openai") {
    const client = new OpenAI({ apiKey: getKey("OPENAI_API_KEY") });
    return await withRetry(async () => {
      const { signal: composedSignal, cleanup } = composeSignal(signal, CLOUD_TIMEOUT_MS);
      try {
        const messages = [];
        if (system) messages.push({ role: "system", content: system });
        messages.push({ role: "user", content: user });
        const params = {
          model: buildProviderMeta().openai.model,
          max_tokens: tokens,
          messages,
        };
        if (useJson) params.response_format = { type: "json_object" };
        const res = await client.chat.completions.create(params, { signal: composedSignal });
        return res.choices[0].message.content;
      } finally { cleanup(); }
    }, "OpenAI");
  }

  if (provider === "google") {
    const genAI = new GoogleGenerativeAI(getKey("GOOGLE_API_KEY"));
    return await withRetry(async () => {
      const { signal: composedSignal, cleanup } = composeSignal(signal, CLOUD_TIMEOUT_MS);
      try {
        const generationConfig = { maxOutputTokens: tokens };
        if (useJson) generationConfig.responseMimeType = "application/json";
        const modelConfig = {
          model: buildProviderMeta().google.model,
          generationConfig,
        };
        // Gemini supports systemInstruction for system-level context
        if (system) modelConfig.systemInstruction = { parts: [{ text: system }] };
        const model = genAI.getGenerativeModel(modelConfig);
        const result = await model.generateContent({ contents: [{ role: "user", parts: [{ text: user }] }] }, { signal: composedSignal });
        return result.response.text();
      } finally { cleanup(); }
    }, "Google Gemini");
  }

  if (provider === "local") {
    // Ollama doesn't support system messages in /api/generate — use combined prompt
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await callOllama(combined, tokens, signal, useJson);
      } catch (err) {
        // Don't retry if the user aborted
        if (err.name === "AbortError" || signal?.aborted) throw err;
        const isRetryable =
          err.message.includes("ECONNREFUSED") ||
          err.message.includes("fetch failed") ||
          err.message.includes("Ollama HTTP 500");
        if (attempt === MAX_RETRIES || !isRetryable) throw err;
        const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
        console.warn(formatLogLine("warn", null, `[Ollama] ${err.message.slice(0, 80)}. Retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`));
        await sleep(delay);
      }
    }
  }

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
      "  Cloud: set ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY in backend/.env\n" +
      "  Local: set AI_PROVIDER=local (requires Ollama running at http://localhost:11434)\n" +
      "         Optionally: OLLAMA_MODEL=mistral:7b  OLLAMA_BASE_URL=http://localhost:11434"
    );
  }

  // ── FEA-003: Try primary provider, then fall back on rate-limit errors ──
  try {
    const result = await callProvider(provider, prompt, options?.maxTokens, options?.signal, options?.responseFormat);
    recordProviderSuccess(provider);
    return result;
  } catch (err) {
    if (!isRateLimitError(err)) throw err;

    // Ollama (local) doesn't have rate limits — its errors (HTTP 500, context
    // overflow, timeout) can match isRateLimitError() false positives (e.g.
    // "overloaded" in error messages). Don't circuit-break local models;
    // just rethrow so the caller's retry/error handling takes over.
    if (provider === "local") throw err;

    // Primary provider hit rate limit — record failure and try fallbacks
    recordProviderFailure(provider);
    const fallbacks = getFallbackProviders(provider);

    if (fallbacks.length === 0) {
      // No fallbacks available — rethrow the original error
      throw err;
    }

    for (const fallbackProvider of fallbacks) {
      console.warn(formatLogLine("warn", null, `[aiProvider] Rate limit on ${provider} — falling back to ${fallbackProvider}`));
      try {
        const result = await callProvider(fallbackProvider, prompt, options?.maxTokens, options?.signal, options?.responseFormat);
        recordProviderSuccess(fallbackProvider);
        // ── Sticky fallback: pin this provider so subsequent calls in the same
        // pipeline skip the rate-limited primary entirely.  Expires after
        // STICKY_FALLBACK_TTL_MS so normal selection resumes once the quota resets.
        _stickyFallbackProvider = fallbackProvider;
        _stickyFallbackExpiry   = Date.now() + STICKY_FALLBACK_TTL_MS;
        console.log(formatLogLine("info", null, `[aiProvider] Pinned ${fallbackProvider} as sticky fallback for ${STICKY_FALLBACK_TTL_MS / 1000}s`));
        return result;
      } catch (fallbackErr) {
        if (isRateLimitError(fallbackErr)) {
          // Don't circuit-break Ollama as a fallback either — local models
          // don't have rate limits; their errors are transient infrastructure
          // issues that shouldn't disable the provider for 5 minutes.
          if (fallbackProvider !== "local") {
            recordProviderFailure(fallbackProvider);
          }
          console.warn(formatLogLine("warn", null, `[aiProvider] Fallback ${fallbackProvider} also rate-limited — trying next`));
          continue;
        }
        // Non-rate-limit error from fallback — throw it
        throw fallbackErr;
      }
    }

    // All fallbacks exhausted — throw the original error
    throw err;
  }
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
 *
 * Falls back to a single blocking call (Google / Ollama) that delivers
 * the entire response as one synthetic "token".
 *
 * NOTE: Unlike {@link generateText}, this function does NOT implement the
 * FEA-003 provider fallback chain. If the primary provider is rate-limited,
 * the error propagates directly. Google and Ollama paths delegate to
 * `generateText()` which does have fallback, but Anthropic/OpenAI streaming
 * paths do not. This is intentional — streaming callers (chat) need a
 * consistent provider for multi-turn context.
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
  const { system, user, combined } = normaliseMessages(promptOrMessages);
  const useJson = responseFormat !== "text";

  if (provider === "anthropic") {
    const client = new Anthropic({ apiKey: getKey("ANTHROPIC_API_KEY") });
    const params = {
      model: buildProviderMeta().anthropic.model,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: "user", content: user }],
    };
    if (system) params.system = system;
    const stream = client.messages.stream(params, { signal });
    for await (const chunk of stream) {
      throwIfAborted(signal);
      if (chunk.type === "content_block_delta" && chunk.delta?.text) {
        onToken(chunk.delta.text);
      }
    }
    return (await stream.finalMessage()).content[0].text;
  }

  if (provider === "openai") {
    const client = new OpenAI({ apiKey: getKey("OPENAI_API_KEY") });
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: user });
    const params = {
      model: buildProviderMeta().openai.model,
      max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      messages,
    };
    if (useJson) params.response_format = { type: "json_object" };
    const stream = await client.chat.completions.create(params, { signal });
    let full = "";
    for await (const chunk of stream) {
      throwIfAborted(signal);
      const token = chunk.choices[0]?.delta?.content ?? "";
      if (token) { full += token; onToken(token); }
    }
    return full;
  }

  // Google / Ollama — no streaming SDK; deliver whole response as one token
  const text = await generateText(promptOrMessages, { ...options, responseFormat });
  onToken(text);
  return text;
}