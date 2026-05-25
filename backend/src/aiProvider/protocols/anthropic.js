/**
 * @module aiProvider/protocols/anthropic
 * @description B1.5 — Protocol module for the Anthropic Messages API.
 *
 * Route-driven counterpart to `backend/src/aiProvider/adapters/anthropic.js`.
 * See `protocols/openai.js` for the contract docs — same shape:
 *
 *   generate(route, messages, opts) → { text, usage }
 *   stream(route, messages, opts)   → { text, usage }
 *
 * Anthropic-specific notes:
 *   • `route.baseUrl` is rarely set in practice (Anthropic's SDK uses
 *     `https://api.anthropic.com` by default). Honoured here for
 *     completeness so a private gateway / Bedrock-style endpoint can
 *     point a route at a self-hosted proxy.
 *   • The SDK emits `content_block_delta` chunks; `stream()` mirrors the
 *     legacy adapter's behaviour and resolves to `finalMessage()` for
 *     authoritative usage counts.
 */

import Anthropic from "@anthropic-ai/sdk";
import { withRetry, composeSignal, CLOUD_TIMEOUT_MS } from "../retry.js";
import { throwIfAborted } from "../../utils/abortHelper.js";

// B2.4 — protocol modules return raw `{ input, output }` token usage
// only. Cost is computed by the dispatcher's
// `computeCostForRoute(route, usage)` with `route.pricing` as the
// authoritative source and `MODEL_PRICING` as catalog fallback.

function mkClient(route, opts) {
  const config = { apiKey: opts.apiKey };
  if (route.baseUrl) config.baseURL = route.baseUrl;
  return new Anthropic(config);
}

export async function generate(route, messages, opts) {
  const client = mkClient(route, opts);
  const label = `Anthropic-protocol (${route.name || route.id})`;
  // See `protocols/openai.js#generate` for the rationale — capability
  // probes pass smaller per-attempt timeouts + `maxRetries: 0` so a
  // bad-key probe fails fast instead of burning the full retry chain.
  const attemptTimeoutMs = Number.isFinite(opts.attemptTimeoutMs)
    ? opts.attemptTimeoutMs
    : CLOUD_TIMEOUT_MS;
  return withRetry(async () => {
    const { signal: composedSignal, cleanup } = composeSignal(opts.signal, attemptTimeoutMs);
    try {
      const params = {
        model: route.model,
        max_tokens: opts.maxTokens,
        messages: [{ role: "user", content: messages.user }],
      };
      if (messages.system) params.system = messages.system;
      const msg = await client.messages.create(params, { signal: composedSignal });
      return {
        text: msg.content?.[0]?.text || "",
        usage: {
          input: msg?.usage?.input_tokens,
          output: msg?.usage?.output_tokens,
        },
      };
    } finally { cleanup(); }
  }, label, opts.signal, { maxRetries: opts.maxRetries });
}

export async function stream(route, messages, opts) {
  if (typeof opts.onToken !== "function") {
    throw new TypeError("anthropic protocol stream(): opts.onToken is required");
  }
  const client = mkClient(route, opts);
  const params = {
    model: route.model,
    max_tokens: opts.maxTokens,
    messages: [{ role: "user", content: messages.user }],
  };
  if (messages.system) params.system = messages.system;
  const s = client.messages.stream(params, { signal: opts.signal });
  for await (const chunk of s) {
    throwIfAborted(opts.signal);
    if (chunk.type === "content_block_delta" && chunk.delta?.text) {
      opts.onToken(chunk.delta.text);
    }
  }
  const final = await s.finalMessage();
  return {
    text: final?.content?.[0]?.text || "",
    usage: {
      input: final?.usage?.input_tokens,
      output: final?.usage?.output_tokens,
    },
  };
}

/**
 * Route-driven multimodal generate (MNT-001 vision-healing).
 *
 * Mirrors `adapters/anthropic.js#generateVision` — image as a base64
 * source block, 512 max output tokens. Anthropic's vision API uses the
 * native `image` content type (NOT the OpenAI `image_url` shape), so
 * `opts.base64` is the raw base64 string (no `data:` prefix); the
 * media_type is fixed to `image/png` since the screenshot pipeline
 * always emits PNG.
 *
 * Required `opts` fields:
 *   • `apiKey`     — resolved by `protocolAdapter.generateVision`.
 *   • `base64`     — raw base64 PNG (no `data:` URL prefix).
 *   • `userPrompt` — the per-call instruction string.
 *   • `signal`     — optional AbortSignal; honoured by the SDK.
 */
export async function generateVision(route, opts) {
  const client = mkClient(route, opts);
  const msg = await client.messages.create({
    model: route.model,
    max_tokens: 512,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: opts.base64 } },
      { type: "text", text: opts.userPrompt },
    ] }],
  }, { signal: opts.signal });
  return {
    text: msg.content?.[0]?.text || "",
    usage: {
      input: msg?.usage?.input_tokens,
      output: msg?.usage?.output_tokens,
    },
  };
}
