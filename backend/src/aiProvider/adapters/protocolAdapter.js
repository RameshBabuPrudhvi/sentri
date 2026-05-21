/**
 * @module aiProvider/adapters/protocolAdapter
 * @description B1.5 — Single entry point for route-driven AI calls.
 *
 * Switches on `route.protocol` (the `provider_routes.protocol` column —
 * `"openai" | "anthropic" | "gemini" | "ollama"`) and delegates to the
 * matching {@link module:aiProvider/protocols} module. Resolves the
 * decrypted API key via `secrets.getDecryptedKey(workspaceId, route.id)`
 * before dispatch — adapters never read the secret cache themselves and
 * NEVER read `process.env`.
 *
 * ## Why a separate dispatcher from the legacy provider switch?
 *
 * The pre-B1 codebase keys adapters by `provider` (a small enum:
 * anthropic / openai / google / local / openrouter / `compat:*`). That
 * enum conflates two orthogonal axes:
 *
 *   • **Wire protocol** — what HTTP shape do we speak?
 *     (openai / anthropic / gemini / ollama)
 *   • **Provider identity** — which vendor / cloud account / billing
 *     surface owns this endpoint? (anthropic.com vs. AWS Bedrock vs. a
 *     self-hosted vLLM proxy that all speak OpenAI's wire format.)
 *
 * Routes split these explicitly — one row, two columns — so a workspace
 * can run multiple "openai-protocol" routes against different vendors
 * without conflating their breakers, quotas, or cost dashboards.
 *
 * ## Streaming-parity contract
 *
 * Every protocol module exports both `generate(route, messages, opts)`
 * and `stream(route, messages, opts)`. Modules whose underlying SDK
 * does not support native streaming (Gemini, Ollama in B1.5) return
 * `null` from `stream()`. This dispatcher detects that and falls back
 * to `generate()`, then emits the full response as a single synthetic
 * token via `opts.onToken` so callers always see the same streaming
 * surface regardless of protocol. Mirrors the pre-B1 fallback in
 * `aiProvider/index.js#streamText`.
 */

import * as openaiProtocol from "../protocols/openai.js";
import * as anthropicProtocol from "../protocols/anthropic.js";
import * as geminiProtocol from "../protocols/gemini.js";
import * as ollamaProtocol from "../protocols/ollama.js";
import * as secrets from "../secrets.js";

/**
 * Map a `route.protocol` string to its protocol module. Throwing on an
 * unknown protocol fails closed — a malformed `provider_routes` row
 * (e.g. one written before a B1.x migration) cannot accidentally
 * dispatch to the wrong adapter.
 */
function moduleFor(protocol) {
  switch (protocol) {
    case "openai":    return openaiProtocol;
    case "anthropic": return anthropicProtocol;
    case "gemini":    return geminiProtocol;
    case "ollama":    return ollamaProtocol;
    default: throw new Error(`Unknown route protocol: ${protocol}`);
  }
}

/**
 * Resolve the decrypted API key for a route, going through the 5-min
 * plaintext cache in `aiProvider/secrets.js`. Returns `null` for
 * routes that legitimately have no secret (Ollama, unauthenticated
 * gateways) — protocol modules know how to handle a missing key.
 *
 * @param {Object} route
 * @returns {string|null}
 */
function resolveApiKey(route) {
  if (!route?.workspaceId || !route?.id) return null;
  return secrets.getDecryptedKey(route.workspaceId, route.id);
}

/**
 * Build the opts bag forwarded to a protocol module. Centralises the
 * "what does an adapter receive?" contract so future fields (response
 * format hints, structured-output schemas, observability headers)
 * land in one place.
 *
 * @param {Object} route
 * @param {Object} callerOpts
 * @returns {Object}
 */
function buildOpts(route, callerOpts) {
  // B4.1 — `resolveApiKey` returns `null` for transient routes (no DB row
  // to decrypt). In that case, honour `callerOpts.apiKey` so the dispatcher
  // can pass the env-derived key for legacy single-tenant workspaces that
  // haven't migrated to real routes. Real routes always win via
  // `resolveApiKey` — the caller's key is a fallback, not an override.
  const resolvedKey = resolveApiKey(route);
  return {
    apiKey: resolvedKey ?? callerOpts.apiKey ?? null,
    maxTokens: callerOpts.maxTokens,
    signal: callerOpts.signal,
    useJson: callerOpts.responseFormat !== "text",
    responseFormat: callerOpts.responseFormat,
    defaultHeaders: callerOpts.defaultHeaders,
    guardedFetch: callerOpts.guardedFetch,
    onToken: callerOpts.onToken,
    // Ollama-specific tuning passthrough (no-op for other protocols).
    timeoutMs: callerOpts.timeoutMs,
    maxPredict: callerOpts.maxPredict,
  };
}

/**
 * Non-streaming generate. Resolves the protocol module + decrypted
 * key, then delegates.
 *
 * @param {Object} route - `provider_routes` row.
 * @param {Object} messages - From `dispatcher.normaliseMessages`.
 * @param {Object} [callerOpts]
 * @param {number} [callerOpts.maxTokens]
 * @param {AbortSignal} [callerOpts.signal]
 * @param {string} [callerOpts.responseFormat] - "text" | "json_object" | "json_schema"
 * @param {Object} [callerOpts.defaultHeaders]
 * @param {Function} [callerOpts.guardedFetch]
 * @returns {Promise<{ text: string, usage: Object|null }>}
 */
export async function generate(route, messages, callerOpts = {}) {
  if (!route?.protocol) throw new Error("protocolAdapter.generate: route.protocol is required");
  const mod = moduleFor(route.protocol);
  const opts = buildOpts(route, callerOpts);
  return mod.generate(route, messages, opts);
}

/**
 * Streaming generate with non-streaming fallback. If the protocol
 * module's `stream()` returns `null` (Gemini / Ollama in B1.5), we
 * fall back to `generate()` and synthesise a single `onToken(text)`
 * call so callers can pretend every protocol streams.
 *
 * @param {Object} route
 * @param {Object} messages
 * @param {Object} callerOpts - Same shape as {@link generate} plus:
 * @param {Function} callerOpts.onToken - Required.
 * @returns {Promise<{ text: string, usage: Object|null }>}
 */
export async function stream(route, messages, callerOpts = {}) {
  if (!route?.protocol) throw new Error("protocolAdapter.stream: route.protocol is required");
  if (typeof callerOpts.onToken !== "function") {
    throw new TypeError("protocolAdapter.stream: callerOpts.onToken is required");
  }
  const mod = moduleFor(route.protocol);
  const opts = buildOpts(route, callerOpts);

  // Try native streaming first. The protocol module returns `null` (not
  // throws) when streaming isn't supported on its SDK — that's the
  // documented signal to fall back to non-streaming generate + synthetic
  // single-token emission. Real failures (auth, network, schema) DO
  // throw and propagate normally.
  const streamed = await mod.stream(route, messages, opts);
  if (streamed !== null && streamed !== undefined) return streamed;

  // Fallback path — match `aiProvider/index.js#streamText`'s contract:
  // emit the full text as one onToken call so consumers (chat SSE, etc.)
  // see exactly the same token sequence shape they would for a real
  // stream of length 1.
  const result = await mod.generate(route, messages, opts);
  if (result?.text) callerOpts.onToken(result.text);
  return result;
}

/**
 * Route-driven multimodal generate (MNT-001 vision-healing).
 *
 * Resolves the protocol module + decrypted key, then delegates. Each
 * protocol module marshals the image into its own multimodal shape
 * (OpenAI `image_url` data URL, Anthropic `image source` base64 block,
 * Gemini `inlineData` part) — callers pass both `base64` and `dataUrl`
 * so the protocol module picks whichever its SDK wants without forcing
 * the caller to know.
 *
 * Returns `null` when the route's protocol module returns `null`
 * (Ollama in B2.4 — no built-in vision support; vision-heal degrades to
 * non-LLM healing). Real failures (auth, network, schema) DO throw and
 * propagate normally — only the explicit `null` sentinel triggers the
 * "no vision" branch.
 *
 * @param {Object} route - `provider_routes` row.
 * @param {Object} callerOpts
 * @param {string} callerOpts.base64    - Raw base64 PNG (no `data:` prefix).
 * @param {string} callerOpts.dataUrl   - `data:image/png;base64,<…>`.
 * @param {string} callerOpts.userPrompt
 * @param {AbortSignal} [callerOpts.signal]
 * @returns {Promise<{ text: string, usage: Object|null }|null>}
 */
export async function generateVision(route, callerOpts = {}) {
  if (!route?.protocol) throw new Error("protocolAdapter.generateVision: route.protocol is required");
  const mod = moduleFor(route.protocol);
  // `generateVision` is the only adapter method whose surface diverges
  // from text dispatch — image fields aren't on `buildOpts`'s contract,
  // so we layer them in explicitly here rather than polluting the
  // shared opts builder.
  const opts = {
    ...buildOpts(route, callerOpts),
    base64: callerOpts.base64,
    dataUrl: callerOpts.dataUrl,
    userPrompt: callerOpts.userPrompt,
  };
  return mod.generateVision(route, opts);
}
