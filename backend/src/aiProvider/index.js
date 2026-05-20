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
import { validateUrl } from "../utils/ssrfGuard.js";
import * as anthropicAdapter from "./adapters/anthropic.js";
import * as openaiAdapter from "./adapters/openai.js";
import * as googleAdapter from "./adapters/google.js";
import * as ollamaAdapter from "./adapters/ollama.js";
import { isRateLimitError, isTransientServerError, isRetryableError, MAX_RETRIES } from "./retry.js";
// AI-002: catalog data + capability flags live in modelCatalog.js.
import {
  CLOUD_KEY_MAP,
  PROVIDER_DOCS,
  VISION_CAPABLE_MODELS,
  getCloudModel,
  getCloudName,
} from "./modelCatalog.js";
// AI-002: mutable provider state owned by registry.js (state owner per spec).
// All runtime keys, sticky fallback, circuit breakers, and detection live there.
import {
  // Compat helpers
  isCompatProvider,
  getCompatConfig,
  // Key resolution
  getKey,
  getUserConfiguredKey,
  getOllamaBaseUrl,
  getOllamaModel,
  hasOllamaConfig,
  isOllamaDisabled,
  // Mutators (re-exported as the public API)
  setRuntimeKey,
  setRuntimeOllama,
  setActiveProvider,
  // Sticky fallback (orchestrator pins after a successful fallback call)
  setStickyFallback,
  stickyFallbackActive,
  // Circuit breaker (FEA-003)
  recordProviderFailure,
  recordProviderSuccess,
  isCircuitBreakerOpen,
  // Detection
  detectProvider,
  getFallbackProviders,
  // Boot
  loadKeysFromDatabase,
  STICKY_FALLBACK_TTL_MS,
} from "./registry.js";
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

// OpenRouter base URL — overridable for self-hosted proxies. Stays in the
// orchestrator (not modelCatalog.js) because it's instance-specific runtime
// config used by buildAdapterOpts(), not catalog metadata.
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

// Re-export retry helpers + state-management API so external callers that
// import these from `aiProvider.js` continue to work after the refactor.
// `setActiveProvider`, `setRuntimeKey`, etc. live in registry.js but are
// re-exported here so consumers don't need to know about the internal layout.
export {
  isRateLimitError,
  isTransientServerError,
  setActiveProvider,
  setRuntimeKey,
  setRuntimeOllama,
  loadKeysFromDatabase,
};

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

// ── Provider detection (delegates to registry.js) ───────────────────────────

/** @returns {string|null} Current provider ID, or `null` when none configured. */
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
  if (stickyFallbackActive()) return true;
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
  result.ollamaConfigured = !isOllamaDisabled() && hasOllamaConfig();
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

function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 6) + "••••••••" + key.slice(-4);
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

// FEA-003 circuit breaker + same-tier fallback list both live in registry.js
// (state owner). The orchestrator below just calls recordProviderFailure /
// recordProviderSuccess / isCircuitBreakerOpen / getFallbackProviders.

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
    // AI-003 — generalised cost counter. Adapters compute `costUsd` from the
    // catalog (see modelCatalog.js#computeCostUsd) and attach it to the
    // usage block. `null` means the model isn't in the catalog → skip the
    // increment so the counter shows "no data" rather than a fake zero.
    // A literal `0` (catalog-known free model like Ollama) is also skipped
    // because incrementing by 0 is a no-op anyway.
    const costUsd = Number(usage.costUsd);
    if (Number.isFinite(costUsd) && costUsd > 0) {
      aiProviderCostUsdTotal.inc({ provider: label, operation }, costUsd);
    }
  } catch { /* best-effort */ }
}

/**
 * Build the adapter-call options for a given provider. Returns the
 * spec-standard `{ messages, maxTokens, signal, useJson, model, apiKey,
 * baseUrl, defaultHeaders, guardedFetch, provider }` shape. The orchestrator
 * is the *only* place that knows about runtime keys, OpenRouter referer
 * headers, compat SSRF guards, etc. — adapters consume the flat result.
 */
function buildAdapterOpts(provider, messages, maxTokens, signal, useJson) {
  if (provider === "anthropic") {
    return {
      provider, messages, maxTokens, signal, useJson,
      model: buildProviderMeta().anthropic.model,
      apiKey: getKey("ANTHROPIC_API_KEY"),
    };
  }
  if (provider === "openai") {
    return {
      provider, messages, maxTokens, signal, useJson,
      model: buildProviderMeta().openai.model,
      apiKey: getKey("OPENAI_API_KEY"),
    };
  }
  if (provider === "openrouter") {
    return {
      provider, messages, maxTokens, signal, useJson,
      model: buildProviderMeta().openrouter.model,
      apiKey: getKey("OPENROUTER_API_KEY"),
      baseUrl: OPENROUTER_BASE_URL,
      defaultHeaders: {
        "HTTP-Referer": process.env.OPENROUTER_REFERER || "https://sentri.dev",
        "X-Title": process.env.OPENROUTER_APP_TITLE || "Sentri",
      },
    };
  }
  if (provider === "google") {
    return {
      provider, messages, maxTokens, signal, useJson,
      model: buildProviderMeta().google.model,
      apiKey: getKey("GOOGLE_API_KEY"),
    };
  }
  if (provider === "local") {
    return {
      provider, messages, maxTokens, signal, useJson,
      model: getOllamaModel(),
      baseUrl: getOllamaBaseUrl(),
    };
  }
  if (isCompatProvider(provider)) {
    const compat = getCompatConfig(provider);
    return {
      provider, messages, maxTokens, signal, useJson,
      model: compat?.model,
      apiKey: compat?.apiKey,
      baseUrl: compat?.baseUrl,
      guardedFetch: createSsrfGuardedFetch(),
    };
  }
  throw new Error(`Unknown provider: ${provider}`);
}

function adapterFor(provider) {
  if (provider === "anthropic") return anthropicAdapter;
  if (provider === "google") return googleAdapter;
  if (provider === "local") return ollamaAdapter;
  // openai / openrouter / compat:* all share the OpenAI wire format
  if (provider === "openai" || provider === "openrouter" || isCompatProvider(provider)) return openaiAdapter;
  throw new Error(`Unknown provider: ${provider}`);
}

async function _callProviderUnsafe(provider, promptOrMessages, maxTokens, signal, responseFormat) {
  const messages = normaliseMessages(promptOrMessages);
  const useJson = responseFormat !== "text";
  const opts = buildAdapterOpts(provider, messages, maxTokens || DEFAULT_MAX_TOKENS, signal, useJson);
  const { text, usage } = await adapterFor(provider).generate(opts);
  // Token telemetry is the orchestrator's responsibility — adapters return
  // raw usage and don't know about the metrics registry. Keeps adapters
  // self-contained and testable in isolation.
  if (usage) recordAiTokens(provider, usage);
  return text;
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
        // pipeline skip the failing primary entirely. Expires after
        // STICKY_FALLBACK_TTL_MS so normal selection resumes once the
        // quota/outage window closes.
        setStickyFallback(fallbackProvider);
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
// VISION_CAPABLE_MODELS lives in modelCatalog.js — operators add new vision-
// capable model IDs there, not here. An explicit VISION_MODEL env var
// bypasses the whitelist for opt-in coverage of new models.

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

  // Local / unknown providers don't have a vision adapter (Ollama returns
  // null from generateVision). Bail before the adapter call to keep the
  // metric label clean.
  if (provider === "local") return null;

  // Build a vision-specific opts bag. We reuse buildAdapterOpts() shape
  // for the auth/baseUrl/SSRF fields, then layer the image fields on top.
  const baseOpts = buildAdapterOpts(provider, { system: null, user: userPrompt, combined: userPrompt }, 512, signal, true);
  // Override `model` with the vision-resolved model — buildAdapterOpts()
  // returns the provider's default text model, which is wrong for vision
  // (e.g. user picked claude-3-5-sonnet via VISION_MODEL but the active
  // provider's default is the older claude-sonnet-4).
  const visionOpts = { ...baseOpts, model, base64, dataUrl, userPrompt };

  let raw = "";
  let usage = null;
  try {
    const res = await adapterFor(provider).generateVision(visionOpts);
    if (!res) return null;
    raw = res.text || "";
    usage = res.usage;
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

  // AI-003 — recordAiTokens() now bumps the cost counter from
  // `usage.costUsd` (catalog-derived) for every adapter call, including
  // vision-heal. We let it run for tokens, but the cost increment here is
  // gated below so we don't double-count when the catalog has pricing.
  if (usage) recordAiTokens(provider, usage, "vision_heal");
  let parsed;
  try { parsed = parseJSON(raw); } catch { return null; }
  const confidence = Number(parsed?.confidence);
  if (!Number.isFinite(confidence) || confidence <= 0) return null;
  const x = Number(parsed?.x), y = Number(parsed?.y), width = Number(parsed?.width), height = Number(parsed?.height);
  const box = (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height)) ? { x, y, width, height } : null;
  // Prefer the catalog-derived cost when available so vision-heal spend
  // tracks the same per-model pricing as test generation. Fall back to the
  // MNT-001 $5/M input + $15/M output midpoint estimate when the model
  // isn't in the catalog — the budget circuit-breaker still needs *some*
  // signal to enforce caps, and the midpoint estimate is the documented
  // pre-AI-003 behaviour. Already-counted via `recordAiTokens()` when
  // catalog-derived; we increment the counter ourselves only on fallback.
  const catalogCost = Number(usage?.costUsd);
  let costUsd;
  if (Number.isFinite(catalogCost)) {
    costUsd = catalogCost;
  } else {
    const inK = (Number(usage?.input) || 0) / 1_000_000;
    const outK = (Number(usage?.output) || 0) / 1_000_000;
    costUsd = inK * 5 + outK * 15;
    try {
      if (Number.isFinite(costUsd) && costUsd > 0) {
        aiProviderCostUsdTotal.inc({ provider: metricLabel, operation: "vision_heal" }, costUsd);
      }
    } catch {}
  }
  try {
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    aiProviderLatencySeconds.observe({ provider: metricLabel, outcome: "success", operation: "vision_heal" }, seconds);
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

  // Wrap onToken so we can detect whether any tokens were emitted before a
  // mid-stream error. Without this guard, falling back to generateText()
  // after partial tokens would deliver a duplicate full response to the user.
  let tokensEmitted = 0;
  const wrappedOnToken = (t) => { tokensEmitted++; onToken(t); };

  async function fallbackToNonStreaming(err) {
    console.warn(formatLogLine("warn", null, `[aiProvider] streamText ${provider} failed before any tokens (${err.message?.slice(0, 120)}) — retrying via non-streaming path with provider fallback.`));
    const text = await generateText(promptOrMessages, { ...options, responseFormat });
    onToken(text);
    return text;
  }

  const adapter = adapterFor(provider);
  // Google + Ollama return null from .stream() — fall through to the
  // synthetic-token path below which calls generateText() (provider fallback
  // is FEA-003-covered).
  try {
    const opts = buildAdapterOpts(provider, messages, options.maxTokens ?? DEFAULT_MAX_TOKENS, signal, useJson);
    const res = await adapter.stream(opts, wrappedOnToken);
    if (res !== null) {
      if (res?.usage) recordAiTokens(provider, res.usage);
      return res?.text ?? "";
    }
  } catch (err) {
    if (err.name === "AbortError" || signal?.aborted) throw err;
    // Only fall back if no tokens were emitted — otherwise the user would
    // see a partial stream concatenated with the full retry response.
    if (tokensEmitted === 0 && isRetryableError(err)) return fallbackToNonStreaming(err);
    throw err;
  }

  // Adapter returned null (Google / Ollama). generateText() handles retry +
  // fallback internally so these providers get FEA-003 coverage for free.
  const text = await generateText(promptOrMessages, { ...options, responseFormat });
  onToken(text);
  return text;
}
