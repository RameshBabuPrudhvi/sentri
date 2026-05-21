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

// B2.4 — protocol modules return raw `{ input, output }` token usage
// only. Cost is computed by the dispatcher's
// `computeCostForRoute(route, usage)` with `route.pricing` as the
// authoritative source and `MODEL_PRICING` as catalog fallback.

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
        usage: {
          input: um?.promptTokenCount,
          output: um?.candidatesTokenCount,
        },
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

/**
 * Route-driven multimodal generate (MNT-001 vision-healing).
 *
 * Mirrors `adapters/google.js#generateVision` — image as `inlineData`
 * with base64 payload, 512 max output tokens, JSON-mode response. The
 * Gemini SDK uses its own multimodal shape distinct from OpenAI's
 * `image_url` and Anthropic's `image source`; abstracting them behind
 * the same dispatcher entry point is exactly why protocol modules
 * exist.
 *
 * Required `opts` fields:
 *   • `apiKey`     — resolved by `protocolAdapter.generateVision`.
 *   • `base64`     — raw base64 PNG (no `data:` URL prefix).
 *   • `userPrompt` — the per-call instruction string.
 *
 * `signal` is intentionally omitted: the @google/generative-ai SDK's
 * `generateContent()` does not honour `AbortSignal`, so passing it
 * would be theatre. Same caveat as `generate()` above.
 */
export async function generateVision(route, opts) {
  const genAI = new GoogleGenerativeAI(opts.apiKey);
  const m = genAI.getGenerativeModel({
    model: route.model,
    generationConfig: { maxOutputTokens: 512, responseMimeType: "application/json" },
  });
  const result = await m.generateContent({
    contents: [{ role: "user", parts: [
      { text: opts.userPrompt },
      { inlineData: { mimeType: "image/png", data: opts.base64 } },
    ] }],
  });
  const um = result?.response?.usageMetadata;
  return {
    text: result.response.text(),
    usage: {
      input: um?.promptTokenCount,
      output: um?.candidatesTokenCount,
    },
  };
}
