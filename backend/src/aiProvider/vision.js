/**
 * @module vision
 * @description Vision (multimodal) provider abstraction — MNT-001 stage-8 healing.
 *
 * VISION_CAPABLE_MODELS lives in modelCatalog.js — operators add new vision-
 * capable model IDs there, not here. An explicit VISION_MODEL env var
 * bypasses the whitelist for opt-in coverage of new models.
 */

import { getProvider, getProviderMeta } from "./providerInfo.js";
import { resolveProvider, resolveRoute, isProviderUsable } from "./registry.js";
import {
  providerMetricLabel,
  buildAdapterOpts,
  adapterFor,
  recordAiTokens,
} from "./dispatcher.js";
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
 * Resolution order:
 *   1. `VISION_MODEL` env var (explicit override, no whitelist check).
 *   2. `AI_MODEL` env var if it's in `VISION_CAPABLE_MODELS`.
 *   3. AI-005: `agent_configs[healer].model` for the supplied workspaceId,
 *      when it's whitelist-vision-capable.
 *   4. The active provider's default model if vision-capable.
 *   5. `null`.
 *
 * @param {Object}  [opts]
 * @param {string}  [opts.workspaceId] - AI-005: when present, the healer
 *   agent config's `model` is preferred over the workspace default so a
 *   per-role override (e.g. claude-3-5-sonnet) actually drives the call.
 * @returns {string|null}
 */
export function resolveVisionModel({ workspaceId = null } = {}) {
  if (process.env.VISION_MODEL) return process.env.VISION_MODEL;
  if (process.env.AI_MODEL) return process.env.AI_MODEL;
  if (workspaceId) {
    const { route } = resolveRoute({ agentRole: "healer", workspaceId });
    if (route?.capabilities?.vision && route?.model) return route.model;
  }
  const provider = getProvider();
  if (!provider) return null;
  const meta = getProviderMeta();
  if (meta?.model) return meta.model;
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
  // AI-005: prefer the healer agent_config provider when configured;
  // fall back to the workspace default exactly the same way generateText
  // does for unconfigured roles. `resolveProvider` itself enforces the
  // detection priority (sticky-fallback > agentRole > env detection).
  let provider;
  if (workspaceId) {
    const resolved = resolveProvider({ agentRole, workspaceId });
    provider = resolved.provider;
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

  // Local / unknown providers don't have a vision adapter (Ollama returns
  // null from generateVision). Bail before the adapter call to keep the
  // metric label clean.
  if (provider === "local") return null;

  // AI-005 tripwire #3 — annotate the active OTel span with vision-heal
  // attributes so distributed traces split by `ai.operation=vision_heal` AND
  // `ai.agent_role=healer` (or whatever role the caller passed). Matches the
  // Prometheus labels written below so a "spend by role" Grafana query
  // and a "spans by role" Tempo / Jaeger query stay in sync.
  annotateAiCallSpan({ provider, agentRole, operation: "vision_heal" });

  // Build a vision-specific opts bag. We reuse buildAdapterOpts() shape
  // for the auth/baseUrl/SSRF fields, then layer the image fields on top.
  // AI-002: pass the `"json_object"` string (not the legacy `true` boolean)
  // so `buildAdapterOpts` carries `responseFormat` through unchanged. The
  // derived `useJson === true` is preserved for adapters that read either.
  const baseOpts = buildAdapterOpts(provider, { system: null, user: userPrompt, combined: userPrompt }, 512, signal, "json_object");
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
      aiProviderLatencySeconds.observe({ provider: metricLabel, agent_role: agentRole, outcome, operation: "vision_heal" }, seconds);
      aiProviderErrorsTotal.inc({ provider: metricLabel, agent_role: agentRole, reason, operation: "vision_heal" });
    } catch {}
    return null;
  }

  // AI-003 — recordAiTokens() now bumps the cost counter from
  // `usage.costUsd` (catalog-derived) for every adapter call, including
  // vision-heal. We let it run for tokens, but the cost increment here is
  // gated below so we don't double-count when the catalog has pricing.
  if (usage) recordAiTokens(provider, usage, "vision_heal", agentRole);
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
  //
  // BUGFIX: `Number(null) === 0` and `Number.isFinite(0) === true`, so the
  // old `Number(usage?.costUsd)` coerced catalog-miss `costUsd: null` into
  // `0`, took the if-branch with `costUsd = 0`, and never recorded the
  // MNT-001 fallback estimate. Net effect: the per-project monthly USD
  // cap (`visionHealMaxCostUsdPerMonth`) silently never tripped for any
  // vision model that wasn't in the catalog (e.g. operator-set
  // `VISION_MODEL`). Now we null-check FIRST so the fallback path runs
  // whenever the catalog produced `null` (or undefined / NaN).
  const rawCatalogCost = usage?.costUsd;
  const catalogCost = (rawCatalogCost == null) ? NaN : Number(rawCatalogCost);
  let costUsd;
  if (Number.isFinite(catalogCost)) {
    costUsd = catalogCost;
  } else {
    const inK = (Number(usage?.input) || 0) / 1_000_000;
    const outK = (Number(usage?.output) || 0) / 1_000_000;
    costUsd = inK * 5 + outK * 15;
    try {
      if (Number.isFinite(costUsd) && costUsd > 0) {
        aiProviderCostUsdTotal.inc({ provider: metricLabel, agent_role: agentRole, operation: "vision_heal" }, costUsd);
      }
    } catch {}
  }
  try {
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    aiProviderLatencySeconds.observe({ provider: metricLabel, agent_role: agentRole, outcome: "success", operation: "vision_heal" }, seconds);
  } catch {}
  return { confidence: Math.min(1, Math.max(0, confidence)), box, model, costUsd, reasoning: typeof parsed?.reasoning === "string" ? parsed.reasoning.slice(0, 200) : null };
}
