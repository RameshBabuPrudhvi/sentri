/**
 * @module dispatcher
 * @description Core dispatch layer: SSRF-guarded fetch, message normalisation,
 * adapter selection, token telemetry, and the instrumented provider call stack.
 */

import { formatLogLine } from "../utils/logFormatter.js";
import { validateUrl } from "../utils/ssrfGuard.js";
import * as anthropicAdapter from "./adapters/anthropic.js";
import * as openaiAdapter from "./adapters/openai.js";
import * as googleAdapter from "./adapters/google.js";
import * as ollamaAdapter from "./adapters/ollama.js";
import { isRateLimitError, isRetryableError, MAX_RETRIES } from "./retry.js";
import { isCompatProvider, getCompatConfig, getKey, getOllamaBaseUrl, getOllamaModel, resolveProvider, resolveRoute } from "./registry.js";
import {
  aiProviderLatencySeconds,
  aiProviderTokensTotal,
  aiProviderErrorsTotal,
  aiProviderCostUsdTotal,
  classifyAiError,
} from "../utils/metrics.js";
import { buildProviderMeta } from "./providerInfo.js";
import { getCurrentTraceId, annotateAiCallSpan } from "../utils/observability.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_MAX_TOKENS = parseInt(process.env.LLM_MAX_TOKENS, 10) || 16384;

// OpenRouter base URL — overridable for self-hosted proxies. Stays in the
// dispatcher (not modelCatalog.js) because it's instance-specific runtime
// config used by buildAdapterOpts(), not catalog metadata.
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

// ── Metric label helper ───────────────────────────────────────────────────────

/**
 * Normalise the provider id used as a metric label. Compat providers
 * (`compat:<slot-id>`) get folded to the literal `"compat"` so per-slot
 * cardinality doesn't explode the time-series database — operators who
 * need per-slot detail get it via OTel spans, not Prometheus labels.
 *
 * @param {string} provider - The detected provider id.
 * @returns {string} A small-enum label value.
 */
export function providerMetricLabel(provider) {
  if (!provider) return "unknown";
  if (typeof provider === "string" && provider.startsWith("compat:")) return "compat";
  return provider;
}

// ── SSRF-guarded fetch ────────────────────────────────────────────────────────

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
export function createSsrfGuardedFetch() {
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

// ── Message normalisation ─────────────────────────────────────────────────────

// Prompt builders can pass either a plain string or { system, user } to
// generateText / streamText. These helpers normalise both shapes into the
// provider-specific message format.
export function normaliseMessages(promptOrMessages) {
  if (typeof promptOrMessages === "string") {
    // Legacy: single string → user-only message (backwards compatible)
    return { system: null, user: promptOrMessages, combined: promptOrMessages };
  }
  const { system, user } = promptOrMessages;
  // Combined fallback for providers that don't support system messages (Ollama)
  const combined = system ? `${system}\n\n---\n\n${user}` : user;
  return { system: system || null, user, combined };
}

// ── Adapter selection ─────────────────────────────────────────────────────────

export function adapterFor(provider) {
  if (provider === "anthropic") return anthropicAdapter;
  if (provider === "google") return googleAdapter;
  if (provider === "local") return ollamaAdapter;
  // openai / openrouter / compat:* all share the OpenAI wire format
  if (provider === "openai" || provider === "openrouter" || isCompatProvider(provider)) return openaiAdapter;
  throw new Error(`Unknown provider: ${provider}`);
}

// ── Adapter options builder ───────────────────────────────────────────────────

/**
 * Build the adapter-call options for a given provider. Returns the
 * spec-standard `{ messages, maxTokens, signal, useJson, responseFormat,
 * model, apiKey, baseUrl, defaultHeaders, guardedFetch, provider }` shape.
 * The orchestrator is the *only* place that knows about runtime keys,
 * OpenRouter referer headers, compat SSRF guards, etc. — adapters consume
 * the flat result.
 *
 * AI-002 lock-in: `responseFormat` is carried end-to-end as a string so
 * future modes (`"json_schema"` for OpenAI structured outputs, AI-005's
 * planner-agent JSON-schema enforcement) land without changing the adapter
 * signature. `useJson` is preserved alongside as a derived boolean for
 * backwards compat — adapters can read either; new callers should prefer
 * `responseFormat`. See AI-008 spec gap 1 in ROADMAP.md for the rationale.
 *
 * @param {string} provider
 * @param {Object} messages - Output of `normaliseMessages()`.
 * @param {number} maxTokens
 * @param {AbortSignal} [signal]
 * @param {string} [responseFormat="json_object"] - One of `"text"` (free
 *   form), `"json_object"` (provider's JSON mode), or `"json_schema"`
 *   (reserved for AI-005). Defaults to `"json_object"` so the legacy
 *   pipeline contract is preserved bit-for-bit when the caller doesn't
 *   specify a format.
 */
export function buildAdapterOpts(provider, messages, maxTokens, signal, responseFormat = "json_object") {
  // AI-002 backwards-compat: derive `useJson` so adapters that haven't yet
  // migrated to reading `responseFormat` keep working. The contract is:
  //   responseFormat === "text"        → useJson === false
  //   responseFormat === "json_object" → useJson === true
  //   responseFormat === "json_schema" → useJson === true (treated as JSON
  //     by adapters that don't yet support schema enforcement; AI-005 will
  //     teach the openai adapter to attach the schema body).
  const useJson = responseFormat !== "text";
  const base = { provider, messages, maxTokens, signal, useJson, responseFormat };
  if (provider === "anthropic") {
    return { ...base, model: buildProviderMeta().anthropic.model, apiKey: getKey("ANTHROPIC_API_KEY") };
  }
  if (provider === "openai") {
    return { ...base, model: buildProviderMeta().openai.model, apiKey: getKey("OPENAI_API_KEY") };
  }
  if (provider === "openrouter") {
    return {
      ...base,
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
    return { ...base, model: buildProviderMeta().google.model, apiKey: getKey("GOOGLE_API_KEY") };
  }
  if (provider === "local") {
    return { ...base, model: getOllamaModel(), baseUrl: getOllamaBaseUrl() };
  }
  if (isCompatProvider(provider)) {
    const compat = getCompatConfig(provider);
    return {
      ...base,
      model: compat?.model,
      apiKey: compat?.apiKey,
      baseUrl: compat?.baseUrl,
      guardedFetch: createSsrfGuardedFetch(),
    };
  }
  throw new Error(`Unknown provider: ${provider}`);
}

// ── Agent-call resolution ─────────────────────────────────────────────────────

/**
 * AI-005 — single source of truth for "how does an agent role resolve into a
 * concrete adapter call?". Both {@link generateText} and {@link streamText}
 * (and any future caller that wants the same per-role semantics) use this so
 * the resolution semantics, `effectivePrompt` assembly, `maxTokens`
 * precedence, and the AI-005c `effectiveAgentRole` collapse rule cannot
 * drift between the two surfaces.
 *
 * B1.7 — When `process.env.AI_ROUTES_ENABLED === "true"`, the function
 * resolves a `provider_routes` row via {@link resolveRoute} (the B1.6
 * route-driven path) and the return shape gains a `route` field plus
 * `useRoutes: true`. When the flag is off (the default), the shape is
 * bit-for-bit identical to the AI-005 pre-routes version (`route: null`,
 * `useRoutes: false`). Call sites that want to opt into routes check
 * `useRoutes` and dispatch via {@link module:aiProvider/adapters/protocolAdapter};
 * call sites that don't keep using the legacy `provider`-keyed path.
 *
 * Inputs are the caller's `prompt` + `options` bag. Outputs everything the
 * caller needs to invoke `callProvider` and bookkeep breakers / sticky /
 * metrics correctly:
 *
 * - `provider` — concrete provider id, or `null` when no provider is configured.
 *   In the routes branch this is derived from `route.family` (or
 *   `route._transientProvider` for shim routes) so legacy telemetry call sites
 *   keep working without changes.
 * - `route` — B1.7 — the resolved `provider_routes` row when `useRoutes` is
 *   true, else `null`. Real routes (`id = "pr-..."`) come from the DB; shim
 *   routes (`id = "provider:<id>"`) are synthesised by `resolveRoute` so the
 *   protocol-adapter contract works for workspaces that haven't migrated yet.
 * - `useRoutes` — B1.7 — `true` when the flag is on, `false` otherwise.
 *   Lets callers gate "dispatch via protocolAdapter" without re-reading
 *   the env var.
 * - `config` — the `agent_configs` row (when one matched), `null` for fallback paths.
 * - `effectiveAgentRole` — AI-005c — `null` when single-agent (no
 *   `agent_configs` row exists), the `agentRole` string otherwise. Use this
 *   for breaker / sticky-fallback / fallback-enumeration keys so single-
 *   agent workspaces collapse to the bare-provider key (1 breaker shared
 *   across stages, pre-PR shape) and multi-agent workspaces get full
 *   per-`(provider, role)` isolation.
 * - `effectivePrompt` — `{ system, user }` when the agent config carries a
 *   `systemPromptOverride` AND the caller passed a plain string, else the
 *   caller's prompt unchanged. Mirrors the pre-existing inline shape so
 *   adapters see exactly what they saw before this refactor.
 * - `maxTokens` — `config?.maxTokens || options.maxTokens` precedence.
 *   Agent-config `maxTokens` wins over caller-supplied. Caller's value
 *   wins when no agent config exists. Adapter-default applies when both
 *   are undefined.
 * - `callOpts` — `{ agentRole }` — the **original** role string (not the
 *   collapsed `effectiveAgentRole`). Forwarded to {@link callProvider} so
 *   OTel span attribution and Prometheus metric labels carry the per-stage
 *   role tag even in single-agent mode where the breaker key collapses.
 *
 * @param {string|{system: string, user: string}} prompt - Caller's prompt.
 * @param {Object} [options] - Caller's options bag.
 * @param {string} [options.agentRole]
 * @param {string} [options.workspaceId]
 * @param {number} [options.maxTokens]
 * @returns {{
 *   provider: string|null,
 *   config: Object|null,
 *   effectiveAgentRole: string|null,
 *   effectivePrompt: string|{system: string, user: string},
 *   maxTokens: number|undefined,
 *   callOpts: { agentRole: string|null }
 * }}
 */
export function resolveAgentCall(prompt, options = {}) {
  const agentRole = options.agentRole || null;
  const workspaceId = options.workspaceId || null;
  // B1.7 — feature-flagged routes branch. Off by default; when on, dispatch
  // resolves a `provider_routes` row via {@link resolveRoute} (which honours
  // the B1.6 priority chain: sticky-fallback → routeId → provider-column
  // shim → env detection). The flag is process-scoped so it can be flipped
  // per-deployment without an env-var reload on every call: cached at import
  // time would prevent test-suite toggling, so we read on each call instead.
  // Cost is one env lookup — negligible against the AI call itself.
  if (process.env.AI_ROUTES_ENABLED === "true") {
    const { route, config, effectiveAgentRole } = resolveRoute({ agentRole, workspaceId });
    const effectivePrompt = (config?.systemPromptOverride && typeof prompt === "string")
      ? { system: config.systemPromptOverride, user: prompt }
      : prompt;
    return {
      // Mirror the legacy shape (`provider` field) by deriving it from the
      // route's family so call sites that still inspect `provider` for
      // telemetry labels or fallback enumeration keep working unchanged.
      // The transient route synthesised by `resolveRoute` carries the
      // legacy provider id in `_transientProvider`; real routes use the
      // `family` column. Either path produces the same value as the
      // legacy `resolveProvider` would have returned.
      provider: route?._transientProvider || route?.family || null,
      route,
      config,
      effectiveAgentRole,
      effectivePrompt,
      maxTokens: config?.maxTokens || options.maxTokens,
      callOpts: { agentRole },
      useRoutes: true,
    };
  }
  // Legacy AI-005 path — unchanged when the flag is off. `route` is `null`
  // and `useRoutes` is `false` so the existing call sites in `index.js`
  // (and `vision.js`, etc.) never see a route object until they opt in.
  const { provider, config, effectiveAgentRole } = resolveProvider({ agentRole, workspaceId });
  const effectivePrompt = (config?.systemPromptOverride && typeof prompt === "string")
    ? { system: config.systemPromptOverride, user: prompt }
    : prompt;
  return {
    provider,
    route: null,
    config,
    effectiveAgentRole,
    effectivePrompt,
    maxTokens: config?.maxTokens || options.maxTokens,
    callOpts: { agentRole },
    useRoutes: false,
  };
}

// ── Token telemetry ───────────────────────────────────────────────────────────

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
export function recordAiTokens(provider, usage, operation = "generation", agentRole = "default") {
  if (!usage) return;
  const label = providerMetricLabel(provider);
  try {
    const inTokens = Number(usage.input);
    if (Number.isFinite(inTokens) && inTokens > 0) {
      aiProviderTokensTotal.inc({ provider: label, agent_role: agentRole || "default", kind: "input", operation }, inTokens);
    }
    const outTokens = Number(usage.output);
    if (Number.isFinite(outTokens) && outTokens > 0) {
      aiProviderTokensTotal.inc({ provider: label, agent_role: agentRole || "default", kind: "output", operation }, outTokens);
    }
    // AI-003 — generalised cost counter. Adapters compute `costUsd` from the
    // catalog (see modelCatalog.js#computeCostUsd) and attach it to the
    // usage block. `null` means the model isn't in the catalog → skip the
    // increment so the counter shows "no data" rather than a fake zero.
    // A literal `0` (catalog-known free model like Ollama) is also skipped
    // because incrementing by 0 is a no-op anyway.
    const costUsd = Number(usage.costUsd);
    if (Number.isFinite(costUsd) && costUsd > 0) {
      aiProviderCostUsdTotal.inc({ provider: label, agent_role: agentRole || "default", operation }, costUsd);
    }
  } catch { /* best-effort */ }
}

// ── Instrumented provider call ────────────────────────────────────────────────

/**
 * INF-007 — Instrumentation wrapper around the raw `_callProviderUnsafe`.
 * Records latency / outcome / error-reason metrics around every LLM call so
 * SaaS operators get RED dashboards (Rate / Errors / Duration) per provider
 * without ad-hoc logging or invasive try/catch at every call site.
 */
export async function callProvider(provider, promptOrMessages, maxTokens, signal, responseFormat, callOptions = {}) {
  // All call sites in this file are test-generation traffic. Vision-heal
  // calls live in `callVisionModel` and pass `operation: "vision_heal"`
  // to the same metric counters directly.
  const operation = "generation";
  const label = providerMetricLabel(provider);
  const agentRole = callOptions.agentRole || "default";
  // AI-005 tripwire #3 — attach `ai.agent_role` + `ai.provider` +
  // `ai.operation` attributes to the active OTel span so distributed traces
  // line up with the Prometheus labels for per-role debugging. No-op when
  // OTel is unconfigured (single helper, single owner: observability.js).
  annotateAiCallSpan({ provider, agentRole, operation });
  // Trace-correlation: emit the per-call traceId at debug level only.
  // Every AI call inside an OTel-instrumented request has a traceId, so an
  // unconditional info-level line would flood logs (~hundreds per crawl).
  // The traceId is already attached to the OTel span by INF-007 +
  // `annotateAiCallSpan` above — this log line is a developer aid for
  // non-OTel deployments, gated by LOG_LEVEL.
  const traceId = getCurrentTraceId();
  if (traceId && process.env.LOG_LEVEL === "debug") {
    console.log(formatLogLine("debug", null, `[aiProvider] traceId=${traceId} provider=${provider} role=${agentRole}`));
  }
  const startedAt = process.hrtime.bigint();
  try {
    const result = await _callProviderUnsafe(provider, promptOrMessages, maxTokens, signal, responseFormat, callOptions);
    try {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      aiProviderLatencySeconds.observe({ provider: label, agent_role: agentRole, outcome: "success", operation }, seconds);
    } catch { /* best-effort */ }
    return result;
  } catch (err) {
    try {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const reason = classifyAiError(err);
      const outcome = reason === "rate_limit" ? "rate_limited" : "error";
      aiProviderLatencySeconds.observe({ provider: label, agent_role: agentRole, outcome, operation }, seconds);
      aiProviderErrorsTotal.inc({ provider: label, agent_role: agentRole, reason, operation });
    } catch { /* best-effort */ }
    throw err;
  }
}

export async function _callProviderUnsafe(provider, promptOrMessages, maxTokens, signal, responseFormat, callOptions = {}) {
  const messages = normaliseMessages(promptOrMessages);
  // AI-002: pass `responseFormat` through verbatim so future modes (e.g.
  // `"json_schema"`) survive the trip to the adapter. `buildAdapterOpts`
  // also derives `useJson` for adapters that haven't migrated yet.
  const opts = buildAdapterOpts(provider, messages, maxTokens || DEFAULT_MAX_TOKENS, signal, responseFormat);
  const { text, usage } = await adapterFor(provider).generate(opts);
  // Token telemetry is the orchestrator's responsibility — adapters return
  // raw usage and don't know about the metrics registry. Keeps adapters
  // self-contained and testable in isolation.
  // `recordAiTokens`'s signature defaults agentRole + the function body
  // OR-defaults `null` → `"default"` for the metric label, so pass the
  // original `callOptions.agentRole` directly without re-applying the OR.
  if (usage) recordAiTokens(provider, usage, "generation", callOptions.agentRole);
  return text;
}
