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
import { computeCostUsd } from "../modelCatalog.js";

function withCost(model, usage) {
  if (!usage) return usage;
  return { ...usage, costUsd: computeCostUsd(model, usage) };
}

function mkClient(route, opts) {
  const config = { apiKey: opts.apiKey };
  if (route.baseUrl) config.baseURL = route.baseUrl;
  return new Anthropic(config);
}

export async function generate(route, messages, opts) {
  const client = mkClient(route, opts);
  const label = `Anthropic-protocol (${route.name || route.id})`;
  return withRetry(async () => {
    const { signal: composedSignal, cleanup } = composeSignal(opts.signal, CLOUD_TIMEOUT_MS);
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
        usage: withCost(route.model, {
          input: msg?.usage?.input_tokens,
          output: msg?.usage?.output_tokens,
        }),
      };
    } finally { cleanup(); }
  }, label);
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
    usage: withCost(route.model, {
      input: final?.usage?.input_tokens,
      output: final?.usage?.output_tokens,
    }),
  };
}
