/**
 * Google Gemini adapter — implements the AI-002 adapter contract:
 *   generate({ messages, maxTokens, signal, useJson, model, apiKey, baseUrl }) → { text, usage }
 *   stream  (not natively supported — returns null so caller falls back to generate)
 *   generateVision({ model, apiKey, base64, userPrompt })                       → { text, usage }
 *
 * Cancellation caveat: the @google/generative-ai SDK's generateContent() does
 * not honour an external AbortSignal — we still pass it to the SDK options
 * bag for forward compatibility, but operators who need hard cancellation on
 * Gemini must wrap the call site in a Promise.race against a signal-driven
 * rejection.
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { withRetry, composeSignal, CLOUD_TIMEOUT_MS } from "../retry.js";
import { computeCostUsd } from "../modelCatalog.js";

// AI-003 — attach `costUsd` from the catalog. Gemini usage is normalised to
// the same `{ input, output }` shape as the OpenAI family before lookup.
function withCost(model, usage) {
  if (!usage) return usage;
  return { ...usage, costUsd: computeCostUsd(model, usage) };
}

export async function generate({ messages, maxTokens, signal, useJson, model, apiKey }) {
  const genAI = new GoogleGenerativeAI(apiKey);
  return withRetry(async () => {
    const { signal: composedSignal, cleanup } = composeSignal(signal, CLOUD_TIMEOUT_MS);
    try {
      const generationConfig = { maxOutputTokens: maxTokens };
      if (useJson) generationConfig.responseMimeType = "application/json";
      const cfg = { model, generationConfig };
      if (messages.system) cfg.systemInstruction = { parts: [{ text: messages.system }] };
      const m = genAI.getGenerativeModel(cfg);
      const result = await m.generateContent(
        { contents: [{ role: "user", parts: [{ text: messages.user }] }] },
        { signal: composedSignal },
      );
      const um = result?.response?.usageMetadata;
      return {
        text: result.response.text(),
        usage: withCost(model, { input: um?.promptTokenCount, output: um?.candidatesTokenCount }),
      };
    } finally { cleanup(); }
  }, "Google Gemini");
}

// Gemini does not expose incremental streaming via this SDK. Returning null
// signals the orchestrator to fall back to non-streaming generate() and emit
// the full response as a single synthetic token.
export async function stream() { return null; }

export async function generateVision({ model, apiKey, base64, userPrompt }) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const m = genAI.getGenerativeModel({
    model,
    generationConfig: { maxOutputTokens: 512, responseMimeType: "application/json" },
  });
  const result = await m.generateContent({
    contents: [{ role: "user", parts: [
      { text: userPrompt },
      { inlineData: { mimeType: "image/png", data: base64 } },
    ] }],
  });
  const um = result?.response?.usageMetadata;
  return {
    text: result.response.text(),
    usage: withCost(model, { input: um?.promptTokenCount, output: um?.candidatesTokenCount }),
  };
}
