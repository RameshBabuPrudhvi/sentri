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
import { computeCostUsd } from "../modelCatalog.js";

/**
 * Attach catalog-derived `costUsd` to a usage block. Mirrors
 * `adapters/openai.js#withCost` so dispatch's cost telemetry is
 * identical regardless of which path produced the response.
 */
function withCost(model, usage) {
  if (!usage) return usage;
  return { ...usage, costUsd: computeCostUsd(model, usage) };
}

/**
 * Build an OpenAI SDK client from a route + caller-supplied opts.
 * `baseUrl` is `undefined` for the canonical openai.com endpoint and
 * an explicit URL for openrouter / compat / self-hosted gateways —
 * the SDK treats `undefined` as "use default" so the same builder
 * handles every variant.
 */
function mkClient(route, opts) {
  const config = { apiKey: opts.apiKey };
  if (route.baseUrl) config.baseURL = route.baseUrl;
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
        usage: withCost(route.model, {
          input: res?.usage?.prompt_tokens,
          output: res?.usage?.completion_tokens,
        }),
      };
    } finally { cleanup(); }
  }, label);
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
  return { text: full, usage: withCost(route.model, usage) };
}
