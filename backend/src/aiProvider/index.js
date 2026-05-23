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
//
// B4.0.4 — `streamText` no longer routes through the legacy
// `adapterFor(provider).stream(buildAdapterOpts(...))` path; it calls
// `protocolAdapter.stream(route, messages, opts)` which resolves the
// decrypted key via the secrets module and delegates to the route's
// protocol module. `adapterFor` / `buildAdapterOpts` are intentionally
// gone from this file's imports so CI catches any re-introduction.
import {
  DEFAULT_MAX_TOKENS,
  normaliseMessages,
  recordAiTokens,
  callProvider,
  resolveAgentCall,
  // B4 — streaming dispatch must run the same B3.7 spend-cap +
  // token-bucket gates as non-streaming dispatch (cross-bundle
  // invariant: "Quota guard never burns provider quota"). Same for
  // the B2.5 per-request log write. These helpers are extracted from
  // `_callProviderUnsafe` so both code paths share one implementation.
  runPreCallGates,
  runPostCallHooks,
  resolveRequestLogConfig,
  routeIdForLog,
  computeCostForRoute,
} from "./dispatcher.js";
import { getCurrentTraceId } from "../utils/observability.js";
import * as protocolAdapter from "./adapters/protocolAdapter.js";
// B4.0.4 — single source of truth for the legacy-provider→protocol
// mapping. Same alias the vision module uses ("protocol for the legacy
// provider id") so the env-default transient-route fallback in
// streamText reads naturally.
import { protocolForProvider as protocolForLegacyProvider } from "./protocolForProvider.js";
// B4.1 follow-up — env-derived API key resolution for transient routes.
// `protocolAdapter.buildOpts` calls `secrets.getDecryptedKey(workspaceId,
// routeId)` which returns null for transient routes (no DB row to
// decrypt), then falls back to `callerOpts.apiKey`. Streaming + vision
// dispatch must mirror `_callProviderUnsafe`'s transient-route key
// resolution (see `dispatcher.js#_callProviderUnsafe` apiKey branch) or
// every native-streaming and vision-heal call on env-default
// deployments fails with a null-key auth error.
import { isCompatProvider, getCompatConfig, getKey } from "./registry.js";
import { CLOUD_KEY_MAP } from "./modelCatalog.js";

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
  // AI-005 — `resolveAgentCall` is the single source of truth for per-role
  // call resolution: it produces the concrete `provider`, the AI-005c
  // `effectiveAgentRole` for breaker / sticky keys (null for single-agent),
  // the `effectivePrompt` with any `systemPromptOverride` applied, the
  // `maxTokens` precedence, and the `callOpts` carrying the original
  // `agentRole` for OTel + metric labels. See `dispatcher.js#resolveAgentCall`.
  const { provider, effectiveAgentRole, effectivePrompt, maxTokens, callOpts } =
    resolveAgentCall(prompt, options);
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
    const result = await callProvider(provider, effectivePrompt, maxTokens, options?.signal, options?.responseFormat, callOpts);
    recordProviderSuccess(provider, effectiveAgentRole);
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
    if (isRateLimitError(err)) recordProviderFailure(provider, effectiveAgentRole);
    const fallbacks = getFallbackProviders(provider, effectiveAgentRole);

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
        const result = await callProvider(fallbackProvider, effectivePrompt, maxTokens, options?.signal, options?.responseFormat, callOpts);
        recordProviderSuccess(fallbackProvider, effectiveAgentRole);
        // ── Sticky fallback: pin this provider so subsequent calls in the same
        // pipeline skip the failing primary entirely. Expires after
        // STICKY_FALLBACK_TTL_MS so normal selection resumes once the
        // quota/outage window closes.
        // AI-005c: keyed by `effectiveAgentRole` so single-agent workspaces
        // pin a SINGLE sticky fallback shared across stages (the pre-PR shape).
        // Multi-agent workspaces (with agent_configs rows) get per-role sticky
        // entries so a planner's rate-limit doesn't divert the author.
        setStickyFallback(fallbackProvider, effectiveAgentRole);
        console.log(formatLogLine("info", null, `[aiProvider] Pinned ${fallbackProvider} as sticky fallback for ${STICKY_FALLBACK_TTL_MS / 1000}s`));
        return result;
      } catch (fallbackErr) {
        if (isRetryableError(fallbackErr)) {
          // Only trip the circuit breaker for rate-limit failures on non-local
          // providers. Transient 5xx errors don't disable the provider — the
          // backend is temporarily overloaded, not permanently broken.
          if (isRateLimitError(fallbackErr) && fallbackProvider !== "local") {
            recordProviderFailure(fallbackProvider, effectiveAgentRole);
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
  // AI-005 — `resolveAgentCall` produces the same shape for the streaming
  // path as for `generateText` so per-role provider configs, sticky-fallback
  // isolation, metric labels, and the AI-005c single-agent collapse rule
  // stay in sync. The fallback path (when streaming fails before any tokens
  // are emitted) delegates to `generateText` which calls `resolveAgentCall`
  // a second time — accepted cost since both calls are pure-functional and
  // identical, and a second resolution catches any agent_configs row that
  // landed between the stream attempt and the fallback retry.
  const agentRole = options?.agentRole || null;
  // AI-005 — destructure `maxTokens` too so the streaming path honours the
  // agent-config precedence (`config.maxTokens` wins over `options.maxTokens`)
  // that `resolveAgentCall` computes. Without this, `streamText` would silently
  // pass the caller-supplied `options.maxTokens` (or `DEFAULT_MAX_TOKENS`) to
  // `buildAdapterOpts` and ignore the role-specific token budget the
  // workspace admin configured, violating the JSDoc contract in
  // `dispatcher.js#resolveAgentCall`.
  //
  // B2.4 — also pull `route` + `callOpts` out so the streaming-path
  // `recordAiTokens` call below can compute cost from `route.pricing`
  // (with `MODEL_PRICING` as catalog fallback) and emit the per-route
  // metric labels. Without `route` + `callOpts.routeName`, every
  // streamed call lands with `costUsd: null` (recordAiTokens's
  // route-less branch) and `route_name: "unknown"` — silently dropping
  // cost data for the entire native-streaming path (Anthropic + OpenAI
  // + OpenRouter). Non-streaming paths already get this via
  // `callProvider`; here we wire the missing dimension.
  const { provider, effectiveAgentRole, effectivePrompt, maxTokens, route, callOpts } =
    resolveAgentCall(promptOrMessages, options);
  if (!provider) throw new Error("No AI provider configured.");
  const { signal, responseFormat } = options;
  const messages = normaliseMessages(effectivePrompt);

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

  // B4.0.4 — route-driven streaming. `protocolAdapter.stream` handles
  // BOTH paths the legacy `adapterFor(provider).stream()` used to fork
  // between: native SDK streaming (anthropic / openai / openrouter /
  // compat all emit incremental tokens via `protocol.stream()`), and
  // the no-native-streaming fallback (gemini / ollama protocols return
  // `null` from `stream()`, the adapter calls `generate()` and emits the
  // full text as a single synthetic `onToken(text)` call). The
  // `if (res !== null)` branch below stays because the adapter still
  // returns `{ text, usage }` — only the `null` sentinel is now
  // collapsed into the synthetic-token fallback inside the adapter.
  //
  // The `dispatchRoute` shape mirrors `vision.js#callVisionModel` — when
  // a real route was resolved we use it as-is; when only an env-default
  // provider exists we synthesise a transient route. `model` from the
  // resolved route OR the env-default's `getProviderMeta().model` (which
  // `resolveAgentCall` doesn't carry on the transient path); we honour
  // either by always falling back to whatever the protocol module pulls
  // off `route.model`.
  const dispatchRoute = route && !route._transient
    ? route
    : {
        id: `provider:${provider}`,
        workspaceId: options?.workspaceId || null,
        name: callOpts?.routeName || `transient:${provider}`,
        family: provider,
        protocol: protocolForLegacyProvider(provider),
        baseUrl: null,
        // route?.model preserves the agent_configs override on the
        // transient path (when `cfg.routeId` was null but the cfg row
        // still carried a model the admin wanted); otherwise the
        // env-default cloud model for the resolved `provider` applies.
        // `getProviderMeta()` returns a map keyed by provider id
        // (`{ anthropic: { name, model, color }, openai: {...}, ... }`),
        // NOT a flat object — bare `.model` always evaluated to
        // `undefined` and silently collapsed to `null`. Mirrors the
        // correct lookup at `dispatcher.js:1068` (`buildProviderMeta()
        // [provider]?.model`).
        model: route?.model || getProviderMeta()?.[provider]?.model || null,
        _transient: true,
        _transientProvider: provider,
      };

  // B4 — pre-call gates BEFORE the SDK is touched. Streaming dispatch
  // historically bypassed these, violating the cross-bundle invariant
  // "Quota guard never burns provider quota" — every streamed AI call
  // landed on the vendor regardless of spend cap or rpm/tpm limits.
  // The shared `runPreCallGates` helper enforces the same B3.7 contract
  // as `_callProviderUnsafe`. Throws `ERR_SPEND_CAP_EXCEEDED` or
  // `ERR_RATE_LIMIT_LOCAL` on rejection — both are typed errors
  // `classifyAiError` buckets into their own Prometheus reason labels.
  const effectiveMaxTokens = maxTokens ?? DEFAULT_MAX_TOKENS;
  await runPreCallGates(callOpts?.workspaceId || null, dispatchRoute.id, dispatchRoute, effectiveMaxTokens);
  // B2.5 — resolve the workspace's request-log policy ONCE per call
  // (same shape `_callProviderUnsafe` uses) and reuse the result on
  // both the success and error paths.
  const logCfg = resolveRequestLogConfig(callOpts || {});
  const promptForLog = typeof promptOrMessages === "string"
    ? promptOrMessages
    : JSON.stringify(promptOrMessages);
  const startedMs = Date.now();
  // B4.1 follow-up — resolve env-derived apiKey for transient routes so
  // native streaming on env-default deployments doesn't fail with a null
  // key. Mirrors the `apiKey` branch in `_callProviderUnsafe`'s
  // `protocolOpts`. Real routes (route._transient !== true) decrypt their
  // key inside `protocolAdapter.buildOpts` via `secrets.getDecryptedKey`
  // and ignore this fallback.
  const transientApiKey = dispatchRoute._transient
    ? (isCompatProvider(provider)
      ? getCompatConfig(provider)?.apiKey
      : getKey(CLOUD_KEY_MAP[provider] || ""))
    : undefined;
  try {
    const res = await protocolAdapter.stream(dispatchRoute, messages, {
      maxTokens: effectiveMaxTokens,
      signal,
      responseFormat,
      onToken: wrappedOnToken,
      apiKey: transientApiKey,
    });
    if (res !== null) {
      // `recordAiTokens`'s signature defaults agentRole to `"default"`, so
      // pass the original `agentRole` directly — null collapses to the
      // signature default at the function boundary, single source of truth.
      //
      // B2.4 — `recordAiTokens(provider, usage, operation, agentRole,
      // routeName, route)`. The two trailing params are required for
      // the per-route cost metric + the `route_name` Prometheus label
      // to fire. Without them, every native-streaming call (Anthropic
      // / OpenAI / OpenRouter) lands with `costUsd: null` and
      // `route_name: "unknown"`. `callOpts.routeName` and `route` are
      // sourced from `resolveAgentCall` above.
      let costResult = { costUsd: null, source: "none" };
      if (res?.usage) {
        costResult = recordAiTokens(
          provider,
          res.usage,
          "generation",
          agentRole,
          callOpts?.routeName || "unknown",
          dispatchRoute || null,
        );
      }
      // B4 — post-call hooks: drift correction on the token bucket +
      // request-log write. The log row carries the same `inputTokens`
      // / `outputTokens` / `costUsd` shape the non-streaming path does,
      // so `checkSpendCap`'s SUM(costUsd) and the replay endpoint both
      // see streaming calls now. `routeIdForLog` strips transient
      // `provider:*` ids to satisfy the FK on `ai_request_log.routeId`.
      const actualTokens = res?.usage
        ? (Number(res.usage.input) || 0) + (Number(res.usage.output) || 0)
        : 0;
      runPostCallHooks({
        routeId: dispatchRoute.id,
        route: dispatchRoute,
        estimatedTokens: effectiveMaxTokens,
        actualTokens,
        costUsd: costResult.costUsd,
        logEntry: {
          workspaceId: callOpts?.workspaceId || null,
          routeId: routeIdForLog(dispatchRoute.id),
          agentRole: callOpts?.agentRole || null,
          userId: callOpts?.userId || null,
          // GAP-005 (migration 056): same runId correlation on the
          // streaming success path.
          runId: callOpts?.runId || null,
          prompt: promptForLog,
          response: res?.text || "",
          inputTokens: Number.isFinite(res?.usage?.input) ? res.usage.input : null,
          outputTokens: Number.isFinite(res?.usage?.output) ? res.usage.output : null,
          costUsd: Number.isFinite(costResult.costUsd) ? costResult.costUsd : null,
          latencyMs: Date.now() - startedMs,
          outcome: "success",
          traceId: getCurrentTraceId(),
          storageMode: logCfg.mode,
          customRedactionRules: logCfg.customRules,
        },
      });
      return res?.text ?? "";
    }
  } catch (err) {
    if (err.name === "AbortError" || signal?.aborted) throw err;
    // B4 — request-log the failure even on the error path. Without
    // this, every streaming auth failure / 429 / SDK error is invisible
    // in `ai_request_log` and operators investigating an outage have
    // to fall back to Prometheus + raw logs.
    try {
      runPostCallHooks({
        routeId: null, // skip drift correction on error
        route: null,
        estimatedTokens: effectiveMaxTokens,
        actualTokens: NaN,
        costUsd: null,
        logEntry: {
          workspaceId: callOpts?.workspaceId || null,
          routeId: routeIdForLog(dispatchRoute.id),
          agentRole: callOpts?.agentRole || null,
          userId: callOpts?.userId || null,
          // GAP-005 (migration 056): same runId correlation on the
          // streaming error path.
          runId: callOpts?.runId || null,
          prompt: promptForLog,
          response: "",
          latencyMs: Date.now() - startedMs,
          outcome: "error",
          errorReason: err?.message?.slice(0, 200) || "unknown",
          traceId: getCurrentTraceId(),
          storageMode: logCfg.mode,
          customRedactionRules: logCfg.customRules,
        },
      });
    } catch {}
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
