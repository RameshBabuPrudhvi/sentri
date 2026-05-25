/**
 * Anthropic adapter — implements the AI-002 adapter contract:
 *   generate({ messages, maxTokens, signal, useJson, model, apiKey, baseUrl }) → { text, usage }
 *   stream  (same args, plus onToken)                                          → { text, usage }
 *   generateVision({ model, apiKey, base64, userPrompt, signal })              → { text, usage }
 *
 * Adapter is self-contained: it imports its own retry/abort helpers rather
 * than accepting them via a `deps` arg, so future providers can drop in by
 * conforming to this shape without coordinating an injection map.
 */
import Anthropic from "@anthropic-ai/sdk";
import { withRetry, composeSignal, CLOUD_TIMEOUT_MS } from "../retry.js";
import { throwIfAborted } from "../../utils/abortHelper.js";

// B2.4 — adapters return raw `{ input, output }` token usage only. The
// dispatcher's `computeCostForRoute(route, usage)` owns cost calculation
// (see `dispatcher.js#computeCostForRoute`) with `route.pricing` as the
// authoritative source and `MODEL_PRICING` as catalog fallback. Adapters
// no longer attach `usage.costUsd` — `MODEL_PRICING` is now a UI-suggestion
// catalog only, not a runtime cost source.

export async function generate({ messages, maxTokens, signal, model, apiKey }) {
  const client = new Anthropic({ apiKey });
  return withRetry(async () => {
    const { signal: composedSignal, cleanup } = composeSignal(signal, CLOUD_TIMEOUT_MS);
    try {
      const params = { model, max_tokens: maxTokens, messages: [{ role: "user", content: messages.user }] };
      if (messages.system) params.system = messages.system;
      const msg = await client.messages.create(params, { signal: composedSignal });
      return {
        text: msg.content?.[0]?.text || "",
        usage: { input: msg?.usage?.input_tokens, output: msg?.usage?.output_tokens },
      };
    } finally { cleanup(); }
  }, "Anthropic", signal);
}

export async function stream({ messages, maxTokens, signal, model, apiKey }, onToken) {
  const client = new Anthropic({ apiKey });
  const params = { model, max_tokens: maxTokens, messages: [{ role: "user", content: messages.user }] };
  if (messages.system) params.system = messages.system;
  const s = client.messages.stream(params, { signal });
  for await (const chunk of s) {
    throwIfAborted(signal);
    if (chunk.type === "content_block_delta" && chunk.delta?.text) onToken(chunk.delta.text);
  }
  const final = await s.finalMessage();
  return {
    text: final?.content?.[0]?.text || "",
    usage: { input: final?.usage?.input_tokens, output: final?.usage?.output_tokens },
  };
}

export async function generateVision({ model, apiKey, base64, userPrompt, signal }) {
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model,
    max_tokens: 512,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
      { type: "text", text: userPrompt },
    ] }],
  }, { signal });
  return {
    text: msg.content?.[0]?.text || "",
    usage: { input: msg?.usage?.input_tokens, output: msg?.usage?.output_tokens },
  };
}
