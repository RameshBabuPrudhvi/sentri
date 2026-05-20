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
import { isRateLimitError, isTransientServerError, isRetryableError, MAX_RETRIES } from "./retry.js";
// AI-002: mutable provider state owned by registry.js (state owner per spec).
// Detection / sticky fallback / circuit breakers / boot loader all live there.
import {
  setRuntimeKey,
  setRuntimeOllama,
  setActiveProvider,
  setStickyFallback,
  recordProviderFailure,
  recordProviderSuccess,
  detectProvider,
  resolveProvider,
  getFallbackProviders,
  loadKeysFromDatabase,
  STICKY_FALLBACK_TTL_MS,
} from "./registry.js";
// AI-002: read-only provider introspection (Settings UI, header dropdown,
// crawler) lives in providerInfo.js. Re-exported below.
import {
  getProvider,
  hasProvider,
  isLocalProvider,
  isProviderDegraded,
  getProviderName,
  getProviderMeta,
  getSupportedProviders,
  getConfiguredKeys,
  checkOllamaConnection,
} from "./providerInfo.js";
// AI-002: dispatch + telemetry layer (SSRF-guarded fetch, message
// normalisation, adapter selection, instrumented call wrapper) lives in
// dispatcher.js so this file holds only the public generateText / streamText
// orchestration logic.
import {
  DEFAULT_MAX_TOKENS,
  normaliseMessages,
  adapterFor,
  buildAdapterOpts,
  recordAiTokens,
  callProvider,
} from "./dispatcher.js";

// Re-export the full public API so external callers that import from
// `aiProvider.js` (which re-exports from this file) continue to work after
// the AI-002 refactor that physically moved state to registry.js and the
// read-only introspection surface to providerInfo.js. This file is now
// only the generation orchestrator + the barrel — no provider state, no
// dispatch primitives.
export {
  // Retry helpers (./retry.js)
  isRateLimitError,
  isTransientServerError,
  // State mutators (./registry.js)
  setActiveProvider,
  setRuntimeKey,
  setRuntimeOllama,
  loadKeysFromDatabase,
  // Read-only introspection (./providerInfo.js)
  getProvider,
  hasProvider,
  isLocalProvider,
  isProviderDegraded,
  getProviderName,
  getProviderMeta,
  getSupportedProviders,
  getConfiguredKeys,
  checkOllamaConnection,
};
// Vision provider abstraction (./vision.js) — MNT-001 stage-8 healing.
export { resolveVisionModel, hasVisionProvider, callVisionModel } from "./vision.js";



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
  const agentRole = options?.agentRole || null;
  const workspaceId = options?.workspaceId || null;
  const { provider, config } = resolveProvider({ agentRole, workspaceId });
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
    const effectivePrompt = (config?.systemPromptOverride && typeof prompt === "string")
      ? { system: config.systemPromptOverride, user: prompt }
      : prompt;
    const result = await callProvider(provider, effectivePrompt, config?.maxTokens || options?.maxTokens, options?.signal, options?.responseFormat, { agentRole });
    recordProviderSuccess(provider, agentRole);
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
    if (isRateLimitError(err)) recordProviderFailure(provider, agentRole);
    const fallbacks = getFallbackProviders(provider, agentRole);

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
        const result = await callProvider(fallbackProvider, prompt, options?.maxTokens, options?.signal, options?.responseFormat, { agentRole });
        recordProviderSuccess(fallbackProvider, agentRole);
        // ── Sticky fallback: pin this provider so subsequent calls in the same
        // pipeline skip the failing primary entirely. Expires after
        // STICKY_FALLBACK_TTL_MS so normal selection resumes once the
        // quota/outage window closes.
        setStickyFallback(fallbackProvider, agentRole);
        console.log(formatLogLine("info", null, `[aiProvider] Pinned ${fallbackProvider} as sticky fallback for ${STICKY_FALLBACK_TTL_MS / 1000}s`));
        return result;
      } catch (fallbackErr) {
        if (isRetryableError(fallbackErr)) {
          // Only trip the circuit breaker for rate-limit failures on non-local
          // providers. Transient 5xx errors don't disable the provider — the
          // backend is temporarily overloaded, not permanently broken.
          if (isRateLimitError(fallbackErr) && fallbackProvider !== "local") {
            recordProviderFailure(fallbackProvider, agentRole);
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
  // AI-002: Google + Ollama explicitly return `null` from `.stream()` to mean
  // "no native streaming — fall back to generate()". Errors are THROWN, not
  // returned as null — adapters that return null on a transient error are a
  // contract violation pinned by `aiProvider-adapter-contract.test.js`. The
  // try/catch below routes thrown errors through the FEA-003 fallback chain;
  // the `if (res !== null)` branch handles the no-streaming-support sentinel.
  try {
    const opts = buildAdapterOpts(provider, messages, options.maxTokens ?? DEFAULT_MAX_TOKENS, signal, responseFormat);
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
