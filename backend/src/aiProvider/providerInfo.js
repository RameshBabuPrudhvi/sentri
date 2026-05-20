/**
 * @module aiProvider/providerInfo
 * @description Provider metadata + introspection — public read-only API
 * surfaces consumed by the Settings UI, header dropdown, demoQuota
 * middleware, and crawler. Owns no mutable state; reads from `registry.js`
 * and `modelCatalog.js`.
 *
 * Split out of `index.js` per AI-002 acceptance criterion ("each new file
 * ≤450 lines"). Public function signatures are preserved verbatim so
 * existing callers (`aiProvider.js` → `aiProvider/index.js`) keep working.
 */
import * as apiKeyRepo from "../database/repositories/apiKeyRepo.js";
import { formatLogLine } from "../utils/logFormatter.js";
import {
  CLOUD_KEY_MAP,
  PROVIDER_DOCS,
  getCloudModel,
  getCloudName,
} from "./modelCatalog.js";
import {
  getCompatConfig,
  getUserConfiguredKey,
  getOllamaBaseUrl,
  getOllamaModel,
  hasOllamaConfig,
  isOllamaDisabled,
  stickyFallbackActive,
  isCircuitBreakerOpen,
  detectProvider,
} from "./registry.js";

/**
 * Build the full provider-id → metadata dictionary. Synthesizes entries for
 * every configured compat slot so `getProviderName()` / `getProviderMeta()`
 * don't throw when a compat provider is active.
 *
 * Routes per-slot reads through the TTL cache (`getCompatConfig`) so this
 * hot path doesn't hit SQLite + AES decryption on every AI call.
 */
export function buildProviderMeta() {
  const meta = {
    anthropic:  { name: getCloudName("anthropic"),  model: getCloudModel("anthropic"),  color: "#cd7f32" },
    openai:     { name: getCloudName("openai"),     model: getCloudModel("openai"),     color: "#10a37f" },
    google:     { name: getCloudName("google"),     model: getCloudModel("google"),     color: "#4285f4" },
    openrouter: { name: getCloudName("openrouter"), model: getCloudModel("openrouter"), color: "#6466f1" },
    local:      { name: `Ollama (${getOllamaModel()})`, model: getOllamaModel(), color: "#7c3aed" },
  };
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

/**
 * Returns the list of all supported providers with current names/models.
 * Derives from `buildProviderMeta()` so model names stay in sync with what's
 * actually used in API calls. Consumed by `GET /api/config`.
 *
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

/** @returns {string|null} Current provider ID, or `null` when none configured. */
export function getProvider()     { try { return detectProvider(); } catch { return null; } }
/** @returns {boolean} `true` if any AI provider is configured. */
export function hasProvider()     { return getProvider() !== null; }
/** @returns {boolean} `true` if the active provider is Ollama (local). */
export function isLocalProvider() { return getProvider() === "local"; }

/**
 * `true` when the AI provider is operating in a degraded state — either a
 * sticky fallback is active (primary was rate-limited) or the primary
 * provider's circuit breaker is open. Used by the feedback loop to skip
 * expensive AI calls that would block run completion.
 */
export function isProviderDegraded() {
  if (stickyFallbackActive()) return true;
  const primary = getProvider();
  return primary ? isCircuitBreakerOpen(primary) : false;
}

/** @returns {string} Human-readable provider name, or `"No provider configured"`. */
export function getProviderName() {
  const p = getProvider();
  if (!p) return "No provider configured";
  // Defense-in-depth: a compat slot deleted between detectProvider() and
  // here would otherwise read .name on undefined and crash hot paths.
  return buildProviderMeta()[p]?.name || p;
}

/** @returns {{provider: string, name: string, model: string, color: string}|null} */
export function getProviderMeta() {
  const p = getProvider();
  if (!p) return null;
  return { provider: p, ...(buildProviderMeta()[p] || { name: p, model: "", color: "#6466f1" }) };
}

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 6) + "••••••••" + key.slice(-4);
}

/**
 * Returns masked API keys and Ollama config for the Settings UI.
 * Never returns full keys — only masked versions for display.
 */
export function getConfiguredKeys() {
  const result = { activeProvider: getProvider() };
  // Cloud providers — masked keys via the shared map. Exclude the demo key
  // fallback so the Settings UI + demoQuota BYOK detection only reflect keys
  // the user explicitly configured.
  for (const [id, envName] of Object.entries(CLOUD_KEY_MAP)) {
    const userKey = getUserConfiguredKey(envName);
    result[id] = maskKey(userKey);
  }
  result.ollamaBaseUrl = getOllamaBaseUrl();
  result.ollamaModel   = getOllamaModel();
  // True only when Ollama has explicit config AND is not disabled — prevents
  // the dropdown from showing Ollama as "saved" when it's just the default URL.
  result.ollamaConfigured = !isOllamaDisabled() && hasOllamaConfig();
  // Wrap the DB sweep in try/catch — a transient DB failure must not 500
  // GET /settings or crash the demoQuota middleware when demo mode is active.
  // Per-slot reads route through getCompatConfig() so they hit the TTL cache.
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
    console.error(formatLogLine("error", null, `[aiProvider] Failed to list compat providers: ${err.message}`));
    result.compatProviders = [];
  }
  return result;
}

/**
 * Check Ollama server connectivity and verify the configured model is available.
 *
 * @returns {Promise<Object>} `{ok, model?, baseUrl?, availableModels?, error?}`.
 */
export async function checkOllamaConnection() {
  const base = getOllamaBaseUrl();
  const model = getOllamaModel();
  try {
    const tagsRes = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!tagsRes.ok) return { ok: false, error: `Ollama /api/tags returned HTTP ${tagsRes.status}` };
    const { models = [] } = await tagsRes.json();
    const names = models.map((m) => m.name.split(":")[0]);
    // model name may include a tag (mistral:7b:latest) — strip for comparison
    const modelBase = model.split(":")[0];
    const found = names.some((n) => n === modelBase || n === model);
    if (!found) {
      return {
        ok: false,
        error: `Model "${model}" not found. Run: ollama pull ${model}\nAvailable: ${names.join(", ") || "(none)"}`,
        availableModels: models.map((m) => m.name),
      };
    }
    return { ok: true, model, baseUrl: base, availableModels: models.map((m) => m.name) };
  } catch (err) {
    return {
      ok: false,
      error: `Cannot reach Ollama at ${base}. Is it running? (ollama serve)\nDetail: ${err.message}`,
    };
  }
}
