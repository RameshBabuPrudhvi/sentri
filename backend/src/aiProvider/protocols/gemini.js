/**
 * @module aiProvider/protocols/gemini
 * @description B1.5 — Protocol module for the Google Gemini API.
 *
 * Route-driven counterpart to `backend/src/aiProvider/adapters/google.js`.
 * See `protocols/openai.js` for the contract docs.
 *
 * Gemini-specific notes:
 *   • The `@google/generative-ai` SDK does NOT honour an external
 *     `AbortSignal` on `generateContent()`. We still pass it for forward
 *     compat and retry-side timeout pressure but operators who need
 *     hard cancellation must wrap the call site in a `Promise.race`.
 *   • Native incremental streaming is not exposed by this SDK either —
 *     the `stream()` export returns `null` so {@link protocolAdapter}
 *     can fall back to non-streaming `generate()` and emit the full
 *     response as a single synthetic token. This matches the legacy
 *     adapter's behaviour and lets callers pretend Gemini streams.
 *   • `route.baseUrl` is currently ignored — the SDK doesn't expose a
 *     baseURL config option. A future migration to the REST-direct
 *     transport would honour it; for now we document the gap rather
 *     than silently pretending to support it.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { withRetry, composeSignal, CLOUD_TIMEOUT_MS } from "../retry.js";
import { computeCostUsd } from "../modelCatalog.js";

function withCost(model, usage) {
  if (!usage) return usage;
  return { ...usage, costUsd: computeCostUsd(model, usage) };
}

export async function generate(route, messages, opts) {
  const genAI = new GoogleGenerativeAI(opts.apiKey);
  const label = `Gemini-protocol (${route.name || route.id})`;
  return withRetry(async () => {
    const { signal: composedSignal, cleanup } = composeSignal(opts.signal, CLOUD_TIMEOUT_MS);
    try {
      const generationConfig = { maxOutputTokens: opts.maxTokens };
      if (opts.useJson) generationConfig.responseMimeType = "application/json";
      const cfg = { model: route.model, generationConfig };
      if (messages.system) cfg.systemInstruction = { parts: [{ text: messages.system }] };
      const m = genAI.getGenerativeModel(cfg);
      const result = await m.generateContent(
        { contents: [{ role: "user", parts: [{ text: messages.user }] }] },
        { signal: composedSignal },
      );
      const um = result?.response?.usageMetadata;
      return {
        text: result.response.text(),
        usage: withCost(route.model, {
          input: um?.promptTokenCount,
          output: um?.candidatesTokenCount,
        }),
      };
    } finally { cleanup(); }
  }, label);
}

/**
 * Gemini does not expose token-by-token streaming via this SDK.
 * Returning `null` signals {@link protocolAdapter#stream} to fall back
 * to non-streaming `generate()` and emit the full text as a single
 * synthetic token, preserving the streaming-API contract for callers.
 */
export async function stream() { return null; }
