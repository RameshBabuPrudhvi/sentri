/**
 * @module vision
 * @description Vision (multimodal) provider abstraction — MNT-001 stage-8 healing.
 *
 * Vision-model resolution priority (B2.3):
 *   1. `VISION_MODEL` env override — explicit operator opt-in, no
 *      whitelist check (lets operators try a brand-new vision model
 *      before the catalog is updated).
 *   2. Workspace healer route's `capabilities.vision === true` AND
 *      its `model` — the route-driven canonical path. Set up by an
 *      admin in Settings → Agent Roles → healer with a route whose
 *      capability probe (B2.2) confirmed vision support.
 *   3. `AI_MODEL` env, GUARDED by `VISION_CAPABLE_MODELS` — single-
 *      tenant deployments without per-workspace routes that just want
 *      "the same model the rest of the platform uses, if it's vision-
 *      capable".
 *   4. Active provider's default model, GUARDED by `VISION_CAPABLE_MODELS` —
 *      catch-all when no agent_config and no override exist.
 *   5. `null` — no vision-capable model is available; the caller
 *      degrades to non-LLM healing.
 *
 * Why both `route.capabilities.vision` (route path) AND `VISION_CAPABLE_MODELS`
 * (env path) coexist: routes carry first-hand network probe evidence
 * (B2.2 — what the provider actually accepts). Env paths don't have a
 * route to probe, so they fall back to the static catalog. The env
 * paths are legacy single-tenant compatibility; multi-tenant
 * deployments should configure routes via Settings UI (B3.1) and rely
 * on the route-driven path exclusively. A future bundle can remove
 * the env paths once every deployment has migrated to per-workspace
 * routes.
 */

import { getProvider, getProviderMeta } from "./providerInfo.js";
import { resolveRoute, isProviderUsable, isCompatProvider, getCompatConfig, getKey } from "./registry.js";
import { VISION_CAPABLE_MODELS, CLOUD_KEY_MAP } from "./modelCatalog.js";
import {
  providerMetricLabel,
  recordAiTokens,
} from "./dispatcher.js";
// B4.0.4 — route-driven dispatch. Vision-heal no longer routes through
// the legacy `adapterFor(provider).generateVision()` path; it calls
// `protocolAdapter.generateVision(route, opts)` which resolves the
// decrypted key via `secrets.getDecryptedKey(workspaceId, routeId)` and
// delegates to the route's protocol module (openai / anthropic / gemini
// / ollama). Final caller of the legacy adapter surface — the
// `adapterFor` / `buildAdapterOpts` imports are intentionally gone so
// CI catches any re-introduction.
import * as protocolAdapter from "./adapters/protocolAdapter.js";
// B4.0.4 — same provider→protocol mapping used by `registry.synthesiseTransientRoute`
// for the single-tenant no-workspace fallback. Aliased so the dispatch
// site reads naturally ("protocol for the legacy provider id").
import { protocolForProvider as protocolForLegacyProvider } from "./protocolForProvider.js";
import {
  aiProviderLatencySeconds,
  aiProviderErrorsTotal,
  aiProviderCostUsdTotal,
  classifyAiError,
} from "../utils/metrics.js";
import { annotateAiCallSpan } from "../utils/observability.js";
import { parseJSON } from "./index.js";

// ── Vision model resolution ───────────────────────────────────────────────────

/**
 * Resolve which vision-capable model to use, or `null` when none is
 * configured. Used by stage 8 of the MNT-001 healing waterfall and by
 * `PATCH /projects/:id` to reject `pixelmatch_and_llm` mode with
 * `VISION_PROVIDER_NOT_CONFIGURED` when no usable model exists.
 *
 * See module-level JSDoc for the full resolution priority. In short:
 * `VISION_MODEL` env override → workspace healer route (B1.6 +
 * B2.2 probe) → guarded `AI_MODEL` env → guarded provider default.
 *
 * @param {Object}  [opts]
 * @param {string}  [opts.workspaceId] - B1.6: when present, the healer
 *   agent_config's `routeId` drives selection so a per-role override
 *   (e.g. claude-3-5-sonnet on a different workspace's anthropic
 *   route) actually drives the call. The route's `capabilities.vision`
 *   field (set by B2.2 probe) is the authoritative vision-support
 *   signal — operators no longer have to keep `VISION_CAPABLE_MODELS`
 *   in sync with their actual provider config.
 * @returns {string|null}
 */
export function resolveVisionModel({ workspaceId = null } = {}) {
  // 1. Explicit operator override — no whitelist check.
  if (process.env.VISION_MODEL) return process.env.VISION_MODEL;
  // 2. Route-driven path: healer agent_config → routeId → route.
  //    Priority:
  //      a. `route.capabilities.vision === true` (probed evidence —
  //         B2.2's auto-probe wrote this on every Settings-UI save).
  //      b. Fallback to `VISION_CAPABLE_MODELS` catalog when the
  //         route exists but `capabilities` is `null` (backfill-routes
  //         script intentionally skips probing — see its header
  //         JSDoc — so backfilled routes need the catalog floor to
  //         work immediately, before an operator manually probes).
  //    Without the catalog fallback, vision healing silently breaks
  //    for every workspace whose healer was migrated by the backfill
  //    script until someone hits the Settings UI re-probe button.
  if (workspaceId) {
    const { route } = resolveRoute({ agentRole: "healer", workspaceId });
    if (route?.model) {
      if (route.capabilities?.vision === true) return route.model;
      // Catalog fallback for unprobed routes. We only fall through to
      // env paths when the route's model isn't in the catalog either —
      // an unprobed route with a clearly vision-capable model id (e.g.
      // `claude-3-5-sonnet`) should still drive vision healing.
      if (route.capabilities == null && VISION_CAPABLE_MODELS.has(route.model)) {
        return route.model;
      }
    }
  }
  // 3. AI_MODEL env, guarded against accidentally sending image data
  //    to a text-only model (regression Lifeguard flagged when the
  //    guard was removed earlier in this PR).
  if (process.env.AI_MODEL && VISION_CAPABLE_MODELS.has(process.env.AI_MODEL)) {
    return process.env.AI_MODEL;
  }
  // 4. Active provider's default model, same guard.
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

// ── Vision LLM call ───────────────────────────────────────────────────────────

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
 * @param {string} [params.workspaceId]  - AI-005: when supplied, the healer
 *   agent_config row drives provider + model selection so a workspace can
 *   route vision-heal at a different provider than its text-generation
 *   default. Falls back to the workspace default when no healer config exists.
 * @param {string} [params.agentRole="healer"] - AI-005: role used for metric
 *   labels + OTel span attribution. The default reflects the actual surface
 *   ("healer") so per-role spend dashboards bucket vision-heal cost correctly
 *   on workspaces that haven't configured the agent yet.
 * @returns {Promise<{confidence: number, box: ({x,y,width,height}|null), model: string, costUsd: number, reasoning: string|null}|null>}
 */
export async function callVisionModel({ screenshot, intent, contextHtml, signal, workspaceId = null, agentRole = "healer" } = {}) {
  if (!screenshot || !intent?.label) return null;
  const model = resolveVisionModel({ workspaceId });
  if (!model) return null;
  // B4.0.4 — route-driven dispatch. `resolveRoute` produces the
  // healer's `provider_routes` row (real or transient); `protocolAdapter.
  // generateVision` resolves the decrypted key via the secrets module
  // and delegates to the protocol module that owns the wire format.
  //
  // `provider` / `routeName` are still extracted for the `route_name`
  // Prometheus label + the OTel span attribute so vision-heal metrics
  // stay split per-route alongside generation metrics (B2.4 — already
  // added the label dimension to the four AI metric definitions).
  //
  // `routeId` (B2.5 request log linkage) is intentionally NOT captured
  // here — vision-heal doesn't route through `callProvider`'s
  // `logRequest()` post-call hook. When vision-heal request logging
  // lands, the resolved route should be threaded into a dedicated
  // `logRequest` call alongside the cost / outcome metric writes
  // below.
  let provider;
  let routeName = "unknown";
  let resolvedRoute = null;
  if (workspaceId) {
    const { route } = resolveRoute({ agentRole, workspaceId });
    provider = route?._transientProvider || route?.family || null;
    routeName = route?.name || route?.id || "unknown";
    // B2.4 — keep the route in scope so `recordAiTokens` can compute
    // cost from `route.pricing`, and so the MNT-001 fallback estimator
    // below knows whether the cost was already recorded.
    resolvedRoute = route;
  } else {
    provider = getProvider();
  }
  if (!provider || !isProviderUsable(provider)) return null;

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

  // Local / unknown providers don't have a vision adapter (Ollama's
  // protocol module returns null from generateVision). Bail before the
  // adapter call to keep the metric label clean — same behaviour as
  // the legacy `adapterFor("local").generateVision()` no-op, but now
  // explicit at the dispatch site.
  if (provider === "local") return null;

  // AI-005 tripwire #3 — annotate the active OTel span with vision-heal
  // attributes so distributed traces split by `ai.operation=vision_heal` AND
  // `ai.agent_role=healer` (or whatever role the caller passed). Matches the
  // Prometheus labels written below so a "spend by role" Grafana query
  // and a "spans by role" Tempo / Jaeger query stay in sync.
  annotateAiCallSpan({ provider, agentRole, operation: "vision_heal", routeName });

  // B4.0.4 — build the `dispatchRoute` that the protocol adapter calls
  // against. Two layers:
  //   1. `resolvedRoute` (when workspaceId was passed) — already
  //      carries `protocol` / `baseUrl` / `family` / `workspaceId` /
  //      `id` so the secrets module can locate the encrypted key.
  //   2. Otherwise synthesise a transient route from the env-default
  //      `provider` so single-tenant deployments without per-workspace
  //      routes still dispatch. Mirrors `synthesiseTransientRoute` in
  //      `registry.js` but specialised for the no-workspace case
  //      (transient routes from `registry.js` carry a fake workspaceId
  //      that would break the secrets lookup; here we keep
  //      `workspaceId: null` and the secrets module's null-guard
  //      falls back to `null` which `protocolAdapter.generateVision`
  //      treats as "no key — let the protocol module use its own
  //      env-fallback chain"). The legacy `adapterFor(provider)` path
  //      relied on `buildAdapterOpts(provider)` to read `process.env`
  //      directly; with protocol modules we keep env reads out of the
  //      dispatch hot path by routing them through the OpenAI compat
  //      slot's `getCompatConfig()` only on the workspaceId-less
  //      single-tenant fallback (used by `hasVisionProvider()` from
  //      `routes/projects.js`).
  //
  // CRITICAL: `model` always comes from `resolveVisionModel` (which
  // honours `VISION_MODEL` env override → workspace healer route →
  // catalog floor). Without the explicit override `dispatchRoute.model
  // = model`, the protocol module would dispatch against
  // `route.model` (the healer's *text* model) instead of the
  // operator-picked vision model.
  const dispatchRoute = resolvedRoute && !resolvedRoute._transient
    ? { ...resolvedRoute, model }
    : {
        id: `provider:${provider}`,
        workspaceId: workspaceId || null,
        name: routeName,
        family: provider,
        protocol: protocolForLegacyProvider(provider),
        baseUrl: null,
        model,
        _transient: true,
        _transientProvider: provider,
      };

  let raw = "";
  let usage = null;
  try {
    // B4.1 follow-up — resolve env-derived apiKey for transient routes
    // so vision-heal on env-default deployments doesn't fail with a null
    // key. Real routes decrypt via `secrets.getDecryptedKey` inside
    // `protocolAdapter.buildOpts` and ignore this fallback. Mirrors the
    // `apiKey` branch in `_callProviderUnsafe`'s `protocolOpts`.
    const transientApiKey = dispatchRoute._transient
      ? (isCompatProvider(provider)
        ? getCompatConfig(provider)?.apiKey
        : getKey(CLOUD_KEY_MAP[provider] || ""))
      : undefined;
    const res = await protocolAdapter.generateVision(dispatchRoute, {
      base64,
      dataUrl,
      userPrompt,
      signal,
      apiKey: transientApiKey,
    });
    if (!res) return null; // Ollama protocol returns null — no vision support.
    raw = res.text || "";
    usage = res.usage;
  } catch (err) {
    try {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const reason = classifyAiError(err);
      const outcome = reason === "rate_limit" ? "rate_limited" : "error";
      aiProviderLatencySeconds.observe({ provider: metricLabel, agent_role: agentRole, outcome, operation: "vision_heal", route_name: routeName }, seconds);
      aiProviderErrorsTotal.inc({ provider: metricLabel, agent_role: agentRole, reason, operation: "vision_heal", route_name: routeName });
    } catch {}
    return null;
  }

  // B2.4 — `recordAiTokens` now owns cost computation via
  // `computeCostForRoute(route, usage)` and returns `{ costUsd, source }`.
  // Source priority (see dispatcher.js#computeCostForRoute JSDoc):
  //   route.pricing > catalog (MODEL_PRICING[route.model]) > none
  // When source === "none" (no route pricing AND no catalog entry, e.g.
  // operator-set VISION_MODEL on a freshly-created compat route), we
  // fall back to the MNT-001 $5/M input + $15/M output midpoint so the
  // per-project monthly USD cap (`visionHealMaxCostUsdPerMonth`) still
  // has a signal to enforce against. The midpoint is bumped into the
  // metric here because recordAiTokens skipped it (cost source was
  // "none"). On every other path the cost metric is already counted by
  // recordAiTokens — no double-counting.
  const tokenResult = usage
    ? recordAiTokens(provider, usage, "vision_heal", agentRole, routeName, resolvedRoute)
    : { costUsd: null, source: "none" };
  let parsed;
  try { parsed = parseJSON(raw); } catch { return null; }
  const confidence = Number(parsed?.confidence);
  if (!Number.isFinite(confidence) || confidence <= 0) return null;
  const x = Number(parsed?.x), y = Number(parsed?.y), width = Number(parsed?.width), height = Number(parsed?.height);
  const box = (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height)) ? { x, y, width, height } : null;

  let costUsd;
  if (Number.isFinite(tokenResult.costUsd)) {
    // Cost already recorded by recordAiTokens (route or catalog).
    costUsd = tokenResult.costUsd;
  } else {
    // MNT-001 fallback estimator — route has no pricing AND catalog
    // doesn't know this model. Compute a midpoint and emit the metric
    // ourselves (recordAiTokens skipped it under source="none").
    const inK = (Number(usage?.input) || 0) / 1_000_000;
    const outK = (Number(usage?.output) || 0) / 1_000_000;
    costUsd = inK * 5 + outK * 15;
    try {
      if (Number.isFinite(costUsd) && costUsd > 0) {
        aiProviderCostUsdTotal.inc({ provider: metricLabel, agent_role: agentRole, operation: "vision_heal", route_name: routeName }, costUsd);
      }
    } catch {}
  }
  try {
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    aiProviderLatencySeconds.observe({ provider: metricLabel, agent_role: agentRole, outcome: "success", operation: "vision_heal", route_name: routeName }, seconds);
  } catch {}
  return { confidence: Math.min(1, Math.max(0, confidence)), box, model, costUsd, reasoning: typeof parsed?.reasoning === "string" ? parsed.reasoning.slice(0, 200) : null };
}
