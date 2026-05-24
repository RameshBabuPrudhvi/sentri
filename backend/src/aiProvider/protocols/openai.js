/**
 * @module aiProvider/protocols/openai
 * @description B1.5 — Protocol module for the OpenAI Chat Completions
 *   wire format (openai / openrouter / openai-compat / any vendor that
 *   speaks `/v1/chat/completions`).
 *
 * This is the **route-driven** entry point for the OpenAI protocol.
 * Distinct from `backend/src/aiProvider/adapters/openai.js` which is the
 * legacy **provider-driven** path (env-derived keys + `buildAdapterOpts`).
 * Both paths converge on the same `OpenAI` SDK underneath.
 *
 * ### Contract
 *
 * Every protocol module in this directory exports the same two functions:
 *
 *   generate(route, messages, opts) → { text, usage }
 *   stream(route, messages, opts)   → { text, usage }
 *
 * Where:
 *   • `route` — a `provider_routes` row hydrated by `providerRouteRepo`.
 *     Carries `model`, `baseUrl`, `family`, etc. The decrypted API key is
 *     **NOT** on the row — it's resolved by the caller via
 *     `secrets.getDecryptedKey(workspaceId, route.id)` and passed in
 *     `opts.apiKey` so this module never touches the secret cache.
 *   • `messages` — output of `dispatcher.normaliseMessages` (`{ system,
 *     user, combined }`). Same shape the legacy adapter consumes.
 *   • `opts` — `{ apiKey, maxTokens, signal, useJson, responseFormat,
 *     defaultHeaders, guardedFetch, onToken? }`. The orchestrator owns
 *     these — protocol modules NEVER read `process.env`.
 *
 * ### Why a separate module from `adapters/openai.js`?
 *
 * The legacy adapter mixes two concerns: SDK marshalling (which we
 * reuse) and runtime-config plumbing (env vars + `buildAdapterOpts`'s
 * provider branching). The new route-driven path bypasses the second
 * concern entirely — there's no `provider` discriminator at all, just
 * a `route.protocol` that already says "OpenAI wire format". Wrapping
 * the legacy adapter would force every call through the env-aware
 * `mkClient` switch on a phantom `provider` value. Cleaner to ship a
 * thin parallel module and let B2 retire the legacy path once routes
 * are universal.
 */

import OpenAI from "openai";
import { withRetry, composeSignal, CLOUD_TIMEOUT_MS } from "../retry.js";
import { throwIfAborted } from "../../utils/abortHelper.js";
import { getOpenRouterBaseUrl } from "../modelCatalog.js";

// B2.4 — protocol modules return raw `{ input, output }` token usage
// only. Cost is computed by the dispatcher's
// `computeCostForRoute(route, usage)` with `route.pricing` as the
// authoritative source and `MODEL_PRICING` as catalog fallback.
// `MODEL_PRICING` is no longer read at runtime; it stays as a
// UI-suggestion catalog for the Settings UI defaults (B3.1).

/**
 * Per-family default `baseURL` for OpenAI-protocol routes whose row
 * has no explicit `baseUrl` set. Without this fallback, a route with
 * `family: "openrouter"` and `baseUrl: null` would fall through to the
 * OpenAI SDK's hardcoded `api.openai.com` default and the OpenRouter
 * API key would be sent to OpenAI's servers (rejected with a 401
 * "Incorrect API key" — TLS protected, but the wire request still
 * happened, which is a leak surface we don't want).
 *
 * Implemented as a function (not a frozen object) so we can read the
 * `OPENROUTER_BASE_URL` env var at call time — deployments using a
 * self-hosted OpenRouter proxy set this var (see `REFERENCE.md` and
 * `docker-compose.yml`), and a static object literal would freeze the
 * default at module-load time before `.env` had a chance to apply.
 *
 * `openai` is intentionally absent — returning `null` lets the SDK use
 * its built-in `api.openai.com` default, which is correct for that
 * family. Compat slots (`family` starting with `compat:`) carry their
 * baseUrl on the slot config and must never reach here with a null
 * baseUrl — `synthesiseTransientRoute` and the route repo both enforce
 * that.
 *
 * @param {string} family - The route's `family` value.
 * @returns {string|null} Canonical endpoint, or null when unknown.
 */
function getFamilyDefaultBaseUrl(family) {
  if (family === "openrouter") return getOpenRouterBaseUrl();
  return null;
}

/**
 * Build an OpenAI SDK client from a route + caller-supplied opts.
 * `baseUrl` is `undefined` for the canonical openai.com endpoint and
 * an explicit URL for openrouter / compat / self-hosted gateways —
 * the SDK treats `undefined` as "use default" so the same builder
 * handles every variant.
 *
 * When `route.baseUrl` is null/empty but the family has a known
 * canonical endpoint (see {@link getFamilyDefaultBaseUrl}), we
 * resolve to that endpoint here rather than letting the SDK silently
 * dispatch to `api.openai.com`. Any unknown family without an explicit
 * baseUrl throws — failing closed is safer than leaking credentials to
 * the wrong endpoint.
 */
function mkClient(route, opts) {
  const config = { apiKey: opts.apiKey };
  let baseUrl = route.baseUrl || null;
  if (!baseUrl && route.family) {
    baseUrl = getFamilyDefaultBaseUrl(route.family);
  }
  // Fail closed: a family that isn't `openai` and has no baseUrl
  // (explicit or default) would otherwise leak the apiKey to
  // `api.openai.com`. Compat / self-hosted routes always require an
  // explicit baseUrl; openrouter is handled by the default map above.
  if (!baseUrl && route.family && route.family !== "openai") {
    const err = new Error(
      `OpenAI-protocol route missing baseUrl for family="${route.family}" (route.id=${route.id || "unknown"})`,
    );
    err.code = "ERR_ROUTE_MISSING_BASE_URL";
    throw err;
  }
  if (baseUrl) config.baseURL = baseUrl;
  if (opts.defaultHeaders) config.defaultHeaders = opts.defaultHeaders;
  if (opts.guardedFetch) config.fetch = opts.guardedFetch;
  return new OpenAI(config);
}

function toOpenAiMessages(messages) {
  const out = [];
  if (messages.system) out.push({ role: "system", content: messages.system });
  out.push({ role: "user", content: messages.user });
  return out;
}

/**
 * Route-driven non-streaming generate. Mirrors
 * `adapters/openai.js#generate` semantics (retry, signal composition,
 * JSON-mode flag, usage extraction) — the only difference is where the
 * inputs came from (resolved route vs. env-derived `buildAdapterOpts`).
 *
 * @param {Object} route - `provider_routes` row.
 * @param {Object} messages - From `normaliseMessages`.
 * @param {Object} opts
 * @param {string} opts.apiKey
 * @param {number} opts.maxTokens
 * @param {AbortSignal} [opts.signal]
 * @param {boolean} [opts.useJson]
 * @param {Object} [opts.defaultHeaders]
 * @param {Function} [opts.guardedFetch]
 * @returns {Promise<{ text: string, usage: Object|null }>}
 */
export async function generate(route, messages, opts) {
  const client = mkClient(route, opts);
  const label = `OpenAI-protocol (${route.family || "openai"}/${route.name || route.id})`;
  // Thread `opts.signal` through `withRetry` so the inter-attempt backoff
  // sleep also aborts when the caller's signal fires. Without this, a
  // probe / dispatch call with a 90s wall-clock budget could stretch
  // past the budget because `await sleep(delay)` ignored aborts —
  // surfaced by Bug 3 (probe ran 117s under a 90s `probeTimeoutMs`).
  return withRetry(async () => {
    const { signal: composedSignal, cleanup } = composeSignal(opts.signal, CLOUD_TIMEOUT_MS);
    try {
      const params = {
        model: route.model,
        max_tokens: opts.maxTokens,
        messages: toOpenAiMessages(messages),
      };
      if (opts.useJson) params.response_format = { type: "json_object" };
      const res = await client.chat.completions.create(params, { signal: composedSignal });
      return {
        text: res.choices?.[0]?.message?.content || "",
        usage: {
          input: res?.usage?.prompt_tokens,
          output: res?.usage?.completion_tokens,
        },
      };
    } finally { cleanup(); }
  }, label, opts.signal);
}

/**
 * Route-driven streaming generate. Token-by-token via the OpenAI SDK's
 * native streaming mode. `opts.onToken` is required.
 */
export async function stream(route, messages, opts) {
  if (typeof opts.onToken !== "function") {
    throw new TypeError("openai protocol stream(): opts.onToken is required");
  }
  const client = mkClient(route, opts);
  const params = {
    model: route.model,
    max_tokens: opts.maxTokens,
    stream: true,
    messages: toOpenAiMessages(messages),
  };
  if (opts.useJson) params.response_format = { type: "json_object" };
  const s = await client.chat.completions.create(params, { signal: opts.signal });
  let full = "";
  let usage = null;
  for await (const chunk of s) {
    throwIfAborted(opts.signal);
    const token = chunk.choices?.[0]?.delta?.content ?? "";
    if (token) { full += token; opts.onToken(token); }
    if (chunk?.usage) {
      usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
    }
  }
  return { text: full, usage };
}

/**
 * Route-driven multimodal generate (MNT-001 vision-healing).
 *
 * Mirrors `adapters/openai.js#generateVision` — image as `image_url` data
 * URL, JSON-mode response, 512 max output tokens. The legacy adapter
 * branched on `provider` to pick the OpenAI / OpenRouter / compat client;
 * here the `route.baseUrl` + `opts.guardedFetch` already encode that
 * choice, so the dispatch shape is uniform.
 *
 * Required `opts` fields:
 *   • `apiKey`       — resolved by `protocolAdapter.generateVision` via
 *                      `secrets.getDecryptedKey(workspaceId, routeId)`.
 *   • `dataUrl`      — `data:image/png;base64,<…>` (what OpenAI / Anthropic
 *                      compat vision endpoints accept).
 *   • `userPrompt`   — the per-call instruction string.
 *   • `signal`       — optional AbortSignal; honoured by the SDK.
 *
 * Returns the same `{ text, usage }` shape every other protocol module
 * produces. Cost is computed downstream by
 * `dispatcher.computeCostForRoute(route, usage)`.
 */
export async function generateVision(route, opts) {
  const client = mkClient(route, opts);
  const res = await client.chat.completions.create({
    model: route.model,
    max_tokens: 512,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: [
      { type: "text", text: opts.userPrompt },
      { type: "image_url", image_url: { url: opts.dataUrl } },
    ] }],
  }, { signal: opts.signal });
  return {
    text: res.choices?.[0]?.message?.content || "",
    usage: {
      input: res?.usage?.prompt_tokens,
      output: res?.usage?.completion_tokens,
    },
  };
}
