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
import { isCompatProvider, getCompatConfig, getKey, getOllamaBaseUrl, getOllamaModel, resolveRoute } from "./registry.js";
import {
  aiProviderLatencySeconds,
  aiProviderTokensTotal,
  aiProviderErrorsTotal,
  aiProviderCostUsdTotal,
  classifyAiError,
} from "../utils/metrics.js";
import { buildProviderMeta } from "./providerInfo.js";
import { getCurrentTraceId, annotateAiCallSpan } from "../utils/observability.js";
import { logRequest } from "./requestLog.js";
// B2.4 — `pricingFor` is the catalog fallback when a route has no
// explicit `pricing` JSON set. Routes own cost at runtime; the catalog
// is consulted ONLY when the route's pricing column is null, and only
// to compute a non-null cost for the metric — never to overwrite an
// operator-set route price. See `computeCostForRoute` JSDoc below.
import { pricingFor } from "./modelCatalog.js";
// B2.5 — Per-workspace request-log policy lookup. Hot-path read; the
// repo's `getAiRequestLogSettings` returns `{ mode: "none", customRules: [] }`
// for unknown workspace ids so callers always get a usable shape.
import * as workspaceRepo from "../database/repositories/workspaceRepo.js";
// B3.7 — pre-call quota gate + post-call drift correction. Runs before
// any provider SDK is touched so a rejected call doesn't burn vendor
// quota. Errors carry typed `.code` strings (`ERR_RATE_LIMIT_LOCAL` /
// `ERR_SPEND_CAP_EXCEEDED`) so the orchestrator can render an actionable
// message to the operator instead of a generic 500.
import { checkAndReserve, reportActual, checkSpendCap } from "./quotaGuard.js";
// B3.8 — exact-match response cache. Pre-call check returns a stored
// response when the route opted in (`cacheEnabled = 1`) and the
// `(routeId, model, messages, params)` quad has been seen before;
// post-call populate stores the freshly-dispatched response for next
// time. Streaming + `skipCache: true` callers bypass the cache entirely.
import {
  computeCacheKey,
  getCached,
  setCached,
  coalesceInFlight,
  registerInFlight,
} from "./responseCache.js";

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
 * Defence-in-depth cap on `agent_configs.systemPromptOverride`.
 *
 * The settings route validator caps user-supplied values at save time
 * (see `backend/src/routes/settings.js`), but the dispatch read path is
 * the last line of defence: a hand-written migration, a future bulk-import
 * endpoint, or a direct DB write could inject an oversized prompt that
 * would then be prepended to every AI call for that role until reverted.
 * Capping here also stops a runaway prompt from blowing the model's
 * context window with no observable failure mode at the call site.
 *
 * 32 KB is generous for any legitimate system prompt (the longest in the
 * codebase is ~6 KB). Truncated prompts are tagged with a trailing
 * `[truncated]` marker so the operator can spot the issue in logs without
 * silently corrupted output.
 */
const SYSTEM_PROMPT_OVERRIDE_MAX_BYTES = 32 * 1024;

/**
 * Resolve the effective prompt: when an agent_configs row carries a
 * `systemPromptOverride` AND the caller passed a plain string, wrap into
 * `{ system, user }`. Otherwise pass the prompt through unchanged.
 *
 * Capping is applied at dispatch read time (see
 * {@link SYSTEM_PROMPT_OVERRIDE_MAX_BYTES}) — see that constant's JSDoc
 * for why we don't trust upstream validators alone.
 */
function buildEffectivePrompt(prompt, config) {
  const override = config?.systemPromptOverride;
  if (!override || typeof prompt !== "string") return prompt;
  const capped = override.length > SYSTEM_PROMPT_OVERRIDE_MAX_BYTES
    ? `${override.slice(0, SYSTEM_PROMPT_OVERRIDE_MAX_BYTES)}\n[truncated]`
    : override;
  return { system: capped, user: prompt };
}

/**
 * AI-005 — single source of truth for "how does an agent role resolve into a
 * concrete adapter call?". Both {@link generateText} and {@link streamText}
 * (and any future caller that wants the same per-role semantics) use this so
 * the resolution semantics, `effectivePrompt` assembly, `maxTokens`
 * precedence, and the AI-005c `effectiveAgentRole` collapse rule cannot
 * drift between the two surfaces.
 *
 * B2.6 — The legacy `AI_ROUTES_ENABLED` feature flag was removed; the
 * function unconditionally resolves a `provider_routes` row via
 * {@link resolveRoute}. Real routes (`id = "pr-..."`) come from the DB;
 * transient routes (`id = "provider:<id>"`) are synthesised by
 * `resolveRoute` so the protocol-adapter contract still works for
 * workspaces that haven't migrated past the env-default path.
 * `useRoutes: true` is now a constant in the return shape — kept for
 * call-site compatibility with the B1.7 era; future PRs can remove
 * the field once every caller stops reading it.
 *
 * Inputs are the caller's `prompt` + `options` bag. Outputs everything the
 * caller needs to invoke `callProvider` and bookkeep breakers / sticky /
 * metrics correctly:
 *
 * - `provider` — concrete provider id, or `null` when no provider is configured.
 *   Derived from `route.family` (real route) or `route._transientProvider`
 *   (shim route) so legacy telemetry call sites keep working without changes.
 * - `route` — the resolved `provider_routes` row (real or transient).
 *   Carries `pricing`, `capabilities`, `apiKeyEncrypted` (via secret repo),
 *   and everything `recordAiTokens` / `logRequest` need downstream.
 * - `useRoutes` — always `true` post-B2.6. The dispatcher has one path.
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
  const { route, config, effectiveAgentRole } = resolveRoute({ agentRole, workspaceId });
  const effectivePrompt = buildEffectivePrompt(prompt, config);
  return {
    provider: route?._transientProvider || route?.family || null,
    route,
    config,
    effectiveAgentRole,
    effectivePrompt,
    maxTokens: config?.maxTokens ?? options.maxTokens,
    callOpts: {
      agentRole,
      routeName: route?.name || route?.id || "unknown",
      routeId: route?.id || null,
      workspaceId,
      // B2.4 — pass the resolved route through so `_callProviderUnsafe`
      // → `recordAiTokens` can compute cost from `route.pricing`
      // without re-resolving. The route object includes the `pricing`
      // JSON column (already hydrated by `providerRouteRepo.hydrate`),
      // so no extra DB read on the cost path.
      route,
      // B2.5 — explicit per-call override of the workspace's
      // request-log mode. Lets the replay endpoint force `"full"`
      // logging on its recursive `generateText` call so the replay
      // itself ends up in `ai_request_log` regardless of the
      // workspace's default policy. Resolved by
      // `resolveRequestLogConfig(callOpts)` in callProvider before
      // the LLM call fires.
      requestLogMode: options.requestLogMode || null,
    },
    useRoutes: true,
  };
}

// ── Cost computation (B2.4) ───────────────────────────────────────────────────

/**
 * Compute the USD cost of a single AI call from the resolved route's
 * `pricing` JSON, with `MODEL_PRICING` as a catalog fallback when the
 * route has no explicit pricing.
 *
 * ## Source priority
 *
 *   1. **`route.pricing`** (operator-set, JSON column from B1.1) —
 *      authoritative. An operator who configures a private vLLM proxy
 *      against `claude-3-5-sonnet` at a discounted rate writes their
 *      real rate here. Shape: `{ inputPerMtok, outputPerMtok, currency }`.
 *      Returns `{ costUsd, source: "route" }` when set.
 *
 *   2. **`MODEL_PRICING[route.model]`** (catalog) — fallback when the
 *      route has no `pricing` set yet (e.g. an operator just created
 *      the route and hasn't filled in pricing). Shape:
 *      `{ inputPer1k, outputPer1k }`. Returns
 *      `{ costUsd, source: "catalog_fallback" }`.
 *
 *   3. **`null`** — neither source has data. Returns
 *      `{ costUsd: null, source: "none" }`. The metric increment is
 *      skipped so the cost counter shows "no data" rather than a
 *      fake zero — matches the AI-003 "no fake zeros" contract from
 *      `modelCatalog.js#computeCostUsd`.
 *
 * ## Unit conversion
 *
 * Routes store per-million-token rates (`inputPerMtok`) because that's
 * the convention every cloud vendor's pricing page uses. The catalog
 * stores per-thousand-token rates (`inputPer1k`) — that's a legacy
 * shape from AI-003. Both are normalised to `cost = rate × tokens /
 * <unit>` internally so the metric value is in USD regardless of
 * which source fired.
 *
 * ## Why dispatcher (not adapter)
 *
 * Per B2.4: "MODEL_PRICING no longer read at runtime, only by UI for
 * defaults." Adapters used to call `computeCostUsd(model, usage)` and
 * attach `costUsd` to the returned `usage` block — that path is being
 * retired. Adapters now return raw `{ input, output }`; this helper
 * is the single place cost gets computed, with the route as the
 * single source of truth.
 *
 * @param {Object|null} route - Resolved `provider_routes` row, or null
 *   when the call wasn't route-driven (legacy/env-default path).
 * @param {Object} usage - `{ input, output }` token counts.
 * @returns {{ costUsd: number|null, source: "route"|"catalog_fallback"|"none" }}
 */
export function computeCostForRoute(route, usage) {
  const inTokens = Number(usage?.input) || 0;
  const outTokens = Number(usage?.output) || 0;

  // Path 1: route-defined pricing wins.
  const rp = route?.pricing;
  if (rp && (Number.isFinite(rp.inputPerMtok) || Number.isFinite(rp.outputPerMtok))) {
    const inRate = Number.isFinite(rp.inputPerMtok) ? rp.inputPerMtok : 0;
    const outRate = Number.isFinite(rp.outputPerMtok) ? rp.outputPerMtok : 0;
    // Per-million-token convention: cost = rate × (tokens / 1_000_000)
    const costUsd = (inRate * inTokens + outRate * outTokens) / 1_000_000;
    return { costUsd: Number.isFinite(costUsd) ? costUsd : null, source: "route" };
  }

  // Path 2: catalog fallback.
  const catalog = route?.model ? pricingFor(route.model) : null;
  if (catalog && (catalog.inputPer1k != null || catalog.outputPer1k != null)) {
    const inRate = Number.isFinite(catalog.inputPer1k) ? catalog.inputPer1k : 0;
    const outRate = Number.isFinite(catalog.outputPer1k) ? catalog.outputPer1k : 0;
    // Per-thousand-token convention: cost = rate × (tokens / 1_000)
    const costUsd = (inRate * inTokens + outRate * outTokens) / 1_000;
    return { costUsd: Number.isFinite(costUsd) ? costUsd : null, source: "catalog_fallback" };
  }

  // Path 3: no data — null cost, skip the metric. Operator sees "no
  // data" in dashboards rather than a misleading $0.
  return { costUsd: null, source: "none" };
}

// ── Token telemetry ───────────────────────────────────────────────────────────

/**
 * Record token usage + cost for a single AI call.
 *
 * Cost is computed from the resolved route's pricing (B2.4 contract —
 * see `computeCostForRoute` JSDoc). When the route is null, the cost
 * metric is skipped entirely (env-default path has no pricing source).
 *
 * @param {string} provider - Detected provider id (label after normalisation).
 * @param {Object} usage - `{ input?: number, output?: number }`. Missing fields are skipped.
 * @param {"generation"|"vision_heal"} [operation="generation"]
 * @param {string} [agentRole="default"]
 * @param {string} [routeName="unknown"]
 * @param {Object} [route] - Resolved route (for B2.4 cost computation).
 *   When null/undefined, only token metrics fire — no cost metric.
 * @returns {{ costUsd: number|null, source: string }} The cost result so
 *   B2.5 request-log code can persist `costUsd` + `pricingSource` on
 *   each `ai_request_log` row.
 */
export function recordAiTokens(provider, usage, operation = "generation", agentRole = "default", routeName = "unknown", route = null) {
  if (!usage) return { costUsd: null, source: "none" };
  const label = providerMetricLabel(provider);
  let costResult = { costUsd: null, source: "none" };
  try {
    const inTokens = Number(usage.input);
    if (Number.isFinite(inTokens) && inTokens > 0) {
      aiProviderTokensTotal.inc({ provider: label, agent_role: agentRole || "default", kind: "input", operation, route_name: routeName || "unknown" }, inTokens);
    }
    const outTokens = Number(usage.output);
    if (Number.isFinite(outTokens) && outTokens > 0) {
      aiProviderTokensTotal.inc({ provider: label, agent_role: agentRole || "default", kind: "output", operation, route_name: routeName || "unknown" }, outTokens);
    }
    // B2.4 — route is the single source of truth for cost. When the
    // route has explicit `pricing`, use it. Otherwise fall back to the
    // catalog. When neither has data, skip the increment so the
    // counter shows "no data" rather than a fake zero. Roadmap line
    // 144: "Emit `app_ai_cost_usd_total` only when `route.pricing
    // != null` — never error on missing pricing." We extend the
    // contract: the metric also fires for catalog_fallback so
    // pre-B2.4 deployments without route pricing still see cost data.
    // Operators migrating to per-route pricing see source="route" on
    // freshly-configured routes; source="catalog_fallback" on
    // routes whose pricing hasn't been filled in yet.
    costResult = computeCostForRoute(route, usage);
    if (Number.isFinite(costResult.costUsd) && costResult.costUsd > 0) {
      aiProviderCostUsdTotal.inc({ provider: label, agent_role: agentRole || "default", operation, route_name: routeName || "unknown" }, costResult.costUsd);
    }
  } catch { /* best-effort */ }
  return costResult;
}

// ── Request-log policy resolution (B2.5) ──────────────────────────────────────

/**
 * Resolve the AI request-log storage policy for a single dispatch
 * call. Returns the `{ mode, customRules }` shape `requestLog.js#logRequest`
 * expects.
 *
 * ## Resolution order
 *
 *   1. **`callOptions.requestLogMode`** — explicit per-call override
 *      (used by tests + the replay endpoint to force `"full"`).
 *   2. **Workspace setting** (`workspaces.aiRequestLogMode`) when a
 *      `workspaceId` is in `callOptions`. Operator-controlled.
 *   3. **`AI_REQUEST_LOG_STORAGE_MODE`** env var — single-tenant
 *      fallback for deployments that haven't migrated past the env-only
 *      configuration model. Validates against the same enum.
 *   4. **`"none"`** — final fallback. Metadata-only logging.
 *
 * Custom redaction rules merge: workspace-supplied rules from the
 * `aiRequestLogCustomRedactionRules` column AND the in-built regexes
 * (email / phone / SSN / card) from `requestLog.js`. Per-call
 * `callOptions.customRedactionRules` is **not** supported — that would
 * let untrusted call sites bypass workspace policy.
 *
 * Hot-path: one in-memory cache lookup + one indexed SELECT per AI
 * call. Could be cached more aggressively in a future PR if profiling
 * shows it; current cost is negligible against the AI call itself.
 *
 * @param {Object} callOptions - The dispatcher's `callOpts` object.
 * @returns {{ mode: "none"|"redacted"|"full", customRules: Array }}
 */
function resolveRequestLogConfig(callOptions = {}) {
  const VALID_MODES = ["none", "redacted", "full"];
  // 1. Explicit per-call override (tests, replay endpoint).
  if (callOptions.requestLogMode && VALID_MODES.includes(callOptions.requestLogMode)) {
    return { mode: callOptions.requestLogMode, customRules: [] };
  }
  // 2. Workspace setting.
  if (callOptions.workspaceId) {
    try {
      const settings = workspaceRepo.getAiRequestLogSettings(callOptions.workspaceId);
      // Workspace rows always exist with a `'none'` default after
      // migration 049 — but a workspace created BEFORE the migration
      // applies has a row that lacks the column entirely (older
      // SQLite ALTER semantics). The repo defends with `|| "none"`,
      // so we only override here when the workspace explicitly opted
      // in to redacted/full.
      if (settings.mode && settings.mode !== "none" && VALID_MODES.includes(settings.mode)) {
        return { mode: settings.mode, customRules: settings.customRules || [] };
      }
      // Workspace mode is "none" — fall through to env-default check.
      // We still carry the workspace's customRules forward so admins
      // can preview rule effects without flipping the mode bit.
      const envMode = (process.env.AI_REQUEST_LOG_STORAGE_MODE || "").toLowerCase();
      if (VALID_MODES.includes(envMode) && envMode !== "none") {
        return { mode: envMode, customRules: settings.customRules || [] };
      }
      return { mode: "none", customRules: settings.customRules || [] };
    } catch {
      // DB unavailable — fall through to env-default. Best-effort
      // logging mirrors the rest of this file's defensive try/catch
      // pattern around DB reads.
    }
  }
  // 3. Env-var fallback (single-tenant deployments).
  const envMode = (process.env.AI_REQUEST_LOG_STORAGE_MODE || "").toLowerCase();
  if (VALID_MODES.includes(envMode)) {
    return { mode: envMode, customRules: [] };
  }
  // 4. Final default.
  return { mode: "none", customRules: [] };
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
  const startedMs = Date.now();
  const label = providerMetricLabel(provider);
  const agentRole = callOptions.agentRole || "default";
  // AI-005 tripwire #3 — attach `ai.agent_role` + `ai.provider` +
  // `ai.operation` attributes to the active OTel span so distributed traces
  // line up with the Prometheus labels for per-role debugging. No-op when
  // OTel is unconfigured (single helper, single owner: observability.js).
  annotateAiCallSpan({ provider, agentRole, operation, routeName: callOptions.routeName || "unknown" });
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
  // B2.5 — resolve the workspace's request-log policy ONCE per call
  // and reuse the result on both the success and failure paths. Avoids
  // a second DB read in the catch block (which would also fail when
  // the original error WAS the DB going down). `cfg.mode` drives both
  // the storage mode and which custom redaction rules apply.
  const logCfg = resolveRequestLogConfig(callOptions);
  try {
    const { text, usage, costResult } = await _callProviderUnsafe(
      provider, promptOrMessages, maxTokens, signal, responseFormat, callOptions,
    );
    try {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      aiProviderLatencySeconds.observe({ provider: label, agent_role: agentRole, outcome: "success", operation, route_name: callOptions.routeName || "unknown" }, seconds);
    } catch { /* best-effort */ }
    try {
      logRequest({
        workspaceId: callOptions.workspaceId || null,
        routeId: callOptions.routeId || null,
        agentRole: callOptions.agentRole || null,
        userId: callOptions.userId || null,
        prompt: typeof promptOrMessages === "string" ? promptOrMessages : JSON.stringify(promptOrMessages),
        response: typeof text === "string" ? text : "",
        // B2.5 — populate token + cost fields so per-request log rows
        // carry the same data as the Prometheus metric. Operators can
        // now reconcile dashboard spend against per-call records and
        // run "show me my $20+ calls" queries against `ai_request_log`.
        inputTokens: Number.isFinite(usage?.input) ? usage.input : null,
        outputTokens: Number.isFinite(usage?.output) ? usage.output : null,
        costUsd: Number.isFinite(costResult?.costUsd) ? costResult.costUsd : null,
        latencyMs: Date.now() - startedMs,
        outcome: "success",
        traceId: getCurrentTraceId(),
        storageMode: logCfg.mode,
        customRedactionRules: logCfg.customRules,
      });
    } catch {}
    // Preserve the legacy public contract — callers expect a string.
    return text;
  } catch (err) {
    const reason = classifyAiError(err);
    const outcome = reason === "rate_limit" ? "rate_limited" : "error";
    try {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      aiProviderLatencySeconds.observe({ provider: label, agent_role: agentRole, outcome, operation, route_name: callOptions.routeName || "unknown" }, seconds);
      aiProviderErrorsTotal.inc({ provider: label, agent_role: agentRole, reason, operation, route_name: callOptions.routeName || "unknown" });
    } catch { /* best-effort */ }
    try {
      logRequest({
        workspaceId: callOptions.workspaceId || null,
        routeId: callOptions.routeId || null,
        agentRole: callOptions.agentRole || null,
        userId: callOptions.userId || null,
        prompt: typeof promptOrMessages === "string" ? promptOrMessages : JSON.stringify(promptOrMessages),
        response: "",
        // No usage on the error path — token + cost fields stay null.
        // Failed calls still cost something on rate-limited paths
        // (depending on provider), but the SDK doesn't expose tokens
        // when the call rejected — the `outcome: "error"` field is
        // the only signal the operator gets.
        latencyMs: Date.now() - startedMs,
        outcome: outcome,
        errorReason: reason,
        traceId: getCurrentTraceId(),
        storageMode: logCfg.mode,
        customRedactionRules: logCfg.customRules,
      });
    } catch {}
    throw err;
  }
}

/**
 * Raw provider call — adapter dispatch + token telemetry. Wrapped by
 * {@link callProvider} which adds latency / outcome metrics and the
 * post-call request-log hook.
 *
 * Returns the full `{ text, usage, costResult }` triple so `callProvider`
 * can populate the AI request log's `inputTokens` / `outputTokens` /
 * `costUsd` columns without re-computing or re-decoding the usage block.
 * The legacy contract (callers expect a `string`) is preserved by
 * `callProvider` extracting `.text` before returning to its callers.
 *
 * @returns {Promise<{ text: string, usage: Object|null, costResult: { costUsd: number|null, source: string } }>}
 */
export async function _callProviderUnsafe(provider, promptOrMessages, maxTokens, signal, responseFormat, callOptions = {}) {
  const messages = normaliseMessages(promptOrMessages);
  const effectiveMaxTokens = maxTokens || DEFAULT_MAX_TOKENS;

  const route = callOptions.route || null;
  const routeId = route?.id || callOptions.routeId || null;
  const workspaceId = callOptions.workspaceId || null;

  // B3.8 — exact-match response cache. Runs FIRST, before quota gates,
  // because a cache hit shouldn't consume rate-limit budget or spend-
  // cap allowance — the response was already paid for on the original
  // dispatch. Skip when:
  //   • No route (env-default dispatch path).
  //   • Route opted out (`cacheEnabled = 0`).
  //   • Caller passed `skipCache: true` (self-healing path where stale
  //     answers are dangerous).
  // The `routeModel` is `route.model` (real route) or
  // `buildAdapterOpts(provider).model` for shim routes — we use the
  // route's model directly because it's already resolved by the time
  // we reach this function.
  const cacheEligible = route
    && (route.cacheEnabled === 1 || route.cacheEnabled === true)
    && Number.isFinite(route.cacheTtlSec) && route.cacheTtlSec > 0
    && callOptions.skipCache !== true;
  let cacheKey = null;
  if (cacheEligible && routeId && route.model) {
    cacheKey = computeCacheKey(routeId, route.model, {
      messages,
      maxTokens: effectiveMaxTokens,
      // `temperature` is read from `callOptions` because the dispatcher
      // doesn't otherwise track it — the adapters honour it via the
      // OpenAI / Anthropic SDK options. Operators who want max hit rate
      // standardise on T=0 dispatch; the cache key reflects whatever
      // value was actually sent.
      temperature: callOptions.temperature ?? null,
      responseFormat: responseFormat ?? null,
    });
    const cached = getCached(routeId, route.model, {
      messages,
      maxTokens: effectiveMaxTokens,
      temperature: callOptions.temperature ?? null,
      responseFormat: responseFormat ?? null,
    }, {
      routeName: callOptions.routeName,
      agentRole: callOptions.agentRole,
    });
    if (cached) {
      // Cache hit — skip gates, skip dispatch, skip token telemetry
      // (the original dispatch already counted those). Return the
      // stored payload directly. `costResult.source = "cache"` lets
      // `callProvider`'s logRequest hook record the hit shape so
      // the request log shows cache hits as zero-cost rows.
      return {
        text: cached.response,
        usage: cached.usage,
        costResult: { costUsd: 0, source: "cache" },
      };
    }
    // Miss — coalesce with any in-flight identical dispatch so
    // thundering-herd traffic doesn't fan out N vendor calls.
    const inflight = coalesceInFlight(cacheKey);
    if (inflight) return inflight;
  }

  // B3.7 — pre-call gates. Run BEFORE the SDK so a rejected call never
  // touches vendor quota. Order matters:
  //   1. Spend cap (cheap DB read, no I/O round-trip in the no-cap path).
  //   2. Token-bucket reserve (Redis round-trip when configured).
  // Both gates are skipped when their input data is missing — the env-
  // default dispatch path (no route, no workspace) gets the legacy
  // unconditional dispatch behaviour so operators not opted into B3.7
  // see no semantic change.
  if (workspaceId) {
    const spend = checkSpendCap(workspaceId);
    if (!spend.ok) {
      const err = new Error(
        `Spend cap exceeded (${spend.exceeded}). ` +
        `Dispatch blocked until next ${spend.exceeded === "day" ? "24h window" : "month boundary"}.`,
      );
      err.code = "ERR_SPEND_CAP_EXCEEDED";
      err.exceeded = spend.exceeded;
      err.remainingUsd = spend.remainingUsd;
      throw err;
    }
    // B3.7 — alert path. Fire-and-forget: spend alerts never block the
    // dispatch call, even when the alert sink (Slack/webhook) is down.
    if (spend.alertTriggered) {
      try {
        // Minimal stub — log + activity entry. Slack/webhook integration
        // lands in a follow-up commit alongside the workspace
        // `notifications.spendWebhookUrl` column. Logging here so the
        // alert is at least visible in the operator's log feed today.
        console.warn(formatLogLine("warn", null,
          `[quotaGuard] spend alert: workspace=${workspaceId} ` +
          `daily=${spend.dailySpent}/${spend.dailyCap} ` +
          `monthly=${spend.monthlySpent}/${spend.monthlyCap} ` +
          `threshold=${spend.thresholdPct}%`));
      } catch { /* alert path is best-effort */ }
    }
  }
  // Token-bucket reserve. `estimatedTokens` is the caller's `maxTokens`
  // — a generous upper bound; the post-call `reportActual` corrects
  // drift with the real count from `usage.input + usage.output`.
  if (routeId && route) {
    const reserved = await checkAndReserve(routeId, effectiveMaxTokens, {
      rpmLimit: route.rpmLimit,
      tpmLimit: route.tpmLimit,
    });
    if (!reserved.ok) {
      const err = new Error(
        `Local rate limit reached on route ${callOptions.routeName || routeId}. ` +
        `Retry after ${reserved.retryAfterMs}ms.`,
      );
      err.code = "ERR_RATE_LIMIT_LOCAL";
      err.retryAfterMs = reserved.retryAfterMs;
      err.reason = reserved.reason;
      throw err;
    }
  }

  // AI-002: pass `responseFormat` through verbatim so future modes (e.g.
  // `"json_schema"`) survive the trip to the adapter. `buildAdapterOpts`
  // also derives `useJson` for adapters that haven't migrated yet.
  const opts = buildAdapterOpts(provider, messages, effectiveMaxTokens, signal, responseFormat);

  // B3.8 — wrap the dispatch + telemetry in an inner async function so
  // we can register the resulting Promise for in-flight coalescing.
  // Concurrent identical misses past the cache lookup above will share
  // this Promise via `coalesceInFlight` instead of fanning out to the
  // vendor. The closure captures `cacheKey` (computed pre-quota above)
  // so the post-call populate goes to the right row.
  const dispatchPromise = (async () => {
    const { text, usage } = await adapterFor(provider).generate(opts);
    // Token telemetry is the orchestrator's responsibility — adapters return
    // raw usage and don't know about the metrics registry. Keeps adapters
    // self-contained and testable in isolation.
    // B2.4 — pass `route` through so cost is computed from `route.pricing`
    // (operator-set) when available, with `MODEL_PRICING` as catalog
    // fallback. Adapters no longer compute `usage.costUsd` themselves;
    // the dispatcher owns cost via `computeCostForRoute`.
    let costResult = { costUsd: null, source: "none" };
    if (usage) {
      costResult = recordAiTokens(
        provider, usage, "generation",
        callOptions.agentRole, callOptions.routeName || "unknown",
        callOptions.route || null,
      );
    }
    // B3.7 — drift correction. Post-call so the bucket converges to the
    // real token count after the SDK returns, regardless of how generous
    // or stingy the pre-call estimate was. Fire-and-forget — failures are
    // logged inside `reportActual` and never propagate.
    if (routeId && route && usage) {
      const actualTokens = (Number(usage.input) || 0) + (Number(usage.output) || 0);
      reportActual(routeId, effectiveMaxTokens, actualTokens, costResult.costUsd).catch(() => {});
    }
    // B3.8 — populate the cache with the freshly-dispatched response.
    // We persist `usage` with the costUsd embedded so subsequent hits
    // can attribute the savings via the `aiCacheSavingsUsdTotal` metric.
    // `setCached` no-ops when the route opted out, so the eligibility
    // check at the top is the only gate; the post-call write is
    // unconditional and cheap.
    if (cacheEligible && cacheKey && routeId && route.model && text) {
      const usageWithCost = usage
        ? { ...usage, costUsd: costResult.costUsd }
        : { input: 0, output: 0, costUsd: costResult.costUsd };
      setCached(
        routeId,
        route.model,
        {
          messages,
          maxTokens: effectiveMaxTokens,
          temperature: callOptions.temperature ?? null,
          responseFormat: responseFormat ?? null,
        },
        text,
        usageWithCost,
        route.cacheTtlSec,
      );
    }
    return { text, usage: usage || null, costResult };
  })();

  // Register the dispatch promise for in-flight coalescing — concurrent
  // identical calls past the initial cache miss will share this promise
  // and skip the duplicate vendor call. `registerInFlight` auto-clears
  // the entry on settle so a long-running call can't pin memory.
  if (cacheEligible && cacheKey) {
    registerInFlight(cacheKey, dispatchPromise);
  }
  return dispatchPromise;
}
